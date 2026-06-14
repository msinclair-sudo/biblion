"""Shared Playwright fixtures for the browser test tier.

The browser tier no longer recomputes the real-data pipeline. Instead it
**rehydrates** committed fixture zips under `tests/fixtures/` via the
`deserialiseFile` load path (the same mechanism `test_persistence.py`
exercises and `topbar.js loadProject` runs in the app). Loading a zip
restores the full computed state — genResult, embedding, dim-red,
clustering — in ~1-2 s with **zero** UMAP/HDBSCAN compute, versus the
~60-90 s in-browser pipeline the old `bfs5000_page` session paid once and
the `dev_subset_bfs_5000` dataset it depended on (now unneeded).

Three rehydrated session pages, each booted once and reset per test:

    dev_server          (session) — http.server on the test port
    playwright_browser  (session) — Chromium headless
    _clean_session      (session) — empty workflow, no data
    _data_only_session  (session) — genResult + embedding + citations,
                                     no dim-red / clustering
    _baseline_session   (session) — full fallworm pipeline
                                     (data → dim-red → clustering)

    clean_page          (function) — _clean_session reset per test
    data_only_page      (function) — _data_only_session reset per test
    page                (function) — _baseline_session reset per test
                                     (the default fixture; was bfs5000)

Tests select the lightest variant they need. Each per-test wrapper resets
the lightweight slots (`state.workflow`, `state.validationRuns`,
`state.jobs`) and restores the pristine geometry slots so one shared page
stays safe across tests — that discipline is what lets a single booted
page serve a whole module.

Console-error guard: every page tracks errors; the fixture asserts no
relevant errors occurred during the test. (The 3d-force-graph teardown
error is suppressed — known harmless.)

Parallelism: per-fixture setup is now ~1-2 s, so the tier runs under
`pytest-xdist` (`-n auto`, see pytest.ini). Each xdist worker boots its
own browser + rehydrates its own pages from the committed zips; workers
share the read-only static dev server (or bind per-worker ports via
`NETWORK_TOY_TEST_PORT`).
"""

import os
import socket
import subprocess
import time

import pytest
from playwright.sync_api import sync_playwright

# Port is overridable so a session can keep :8000 for a live browser and run
# the suite elsewhere (e.g. NETWORK_TOY_TEST_PORT=8002). Defaults to 8000.
#
# Under pytest-xdist each worker gets its OWN port (base + worker index) so it
# owns its own dev-server lifecycle. Sharing one server across workers races:
# the worker that started it tears it down on its session end while sibling
# workers are still fetching fixtures ("Failed to fetch"). Per-worker ports
# sidestep that entirely. An explicit NETWORK_TOY_TEST_PORT pins the base.
_BASE_PORT = int(os.environ.get("NETWORK_TOY_TEST_PORT", "8000"))


def _resolve_port():
    worker = os.environ.get("PYTEST_XDIST_WORKER")  # e.g. "gw0", "gw3", or None
    if worker and worker.startswith("gw"):
        try:
            return _BASE_PORT + int(worker[2:])
        except ValueError:
            pass
    return _BASE_PORT


TEST_PORT = _resolve_port()
URL = f"http://localhost:{TEST_PORT}/app/"
KNOWN_FG_TEARDOWN = "Cannot read properties of undefined (reading 'tick')"

# Fixture zips, served over the dev server at /tests/fixtures/<name>.zip
# (the dev server roots at the repo, so tests/ is reachable).
FIXTURE_BASELINE  = "/tests/fixtures/fallworm_baseline.zip"
FIXTURE_DATA_ONLY = "/tests/fixtures/data_only.zip"
FIXTURE_CLEAN     = "/tests/fixtures/clean.zip"

# Best-effort optional resources the app deliberately probes and gracefully
# skips on 404 (e.g. a project's subsets/index.json — "no subsets" is a valid
# state; see datasource/sqlite.js discoverSubsets). Their 404s are expected and
# must NOT fail the boot guard. The browser also logs a generic, URL-less
# console error for every failed fetch; we drop those and instead record real
# failures at the response level (which carry the URL, so we can allowlist).
OPTIONAL_RESOURCE_MARKERS = ("/subsets/index.json", "favicon.ico")
_RESOURCE_LOAD_CONSOLE_ERR = "Failed to load resource"


def _port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


@pytest.fixture(scope="session")
def dev_server():
    """Start http.server on the test port for the session, kill on teardown.

    Skips spawning if something's already serving the port (e.g. the user
    is running a dev server alongside the tests, or another xdist worker
    started it) — but in that case DOES NOT terminate the foreign process.
    """
    if _port_in_use(TEST_PORT):
        # Already serving; trust it. Don't tear down on session end.
        yield URL
        return

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    # serve.py (not plain http.server): the app fetches /api/datasets on boot,
    # which only serve.py answers. It roots at network_toy/ and reads the port
    # from NETWORK_TOY_PORT.
    proc = subprocess.Popen(
        ["python", "serve.py"],
        cwd=repo_root,
        env={**os.environ, "NETWORK_TOY_PORT": str(TEST_PORT)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    # Wait for the server to actually be ready.
    for _ in range(50):
        if _port_in_use(TEST_PORT):
            break
        time.sleep(0.1)
    else:
        proc.terminate()
        proc.wait()
        raise RuntimeError(f"dev server failed to start on :{TEST_PORT}")

    yield URL
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def playwright_browser(dev_server):
    """One Chromium instance per session."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        yield browser
        browser.close()


def _attach_error_tracker(page):
    """Hook page.errors as a list capturing console + pageerror + failed-response
    events. Resource-load failures are tracked via the response hook (which has
    the URL) so the URL-less console duplicate is dropped, and expected best-
    effort probes (OPTIONAL_RESOURCE_MARKERS) are allowlisted."""
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on(
        "console",
        lambda m: errors.append(f"[{m.type}] {m.text}")
        if m.type == "error" and _RESOURCE_LOAD_CONSOLE_ERR not in m.text else None,
    )
    page.on(
        "response",
        lambda r: errors.append(f"[http {r.status}] {r.url}")
        if r.status >= 400 and not any(k in r.url for k in OPTIONAL_RESOURCE_MARKERS)
        else None,
    )
    page.errors = errors


def relevant_errors(page):
    """Filter known-harmless errors out of page.errors."""
    return [e for e in getattr(page, "errors", []) if KNOWN_FG_TEARDOWN not in e]


def _boot_page(playwright_browser):
    """Open a fresh context+page, navigate, wait for the app module to load.

    Readiness is polled (state.js becomes importable and getState() works)
    rather than a blanket sleep — boot is now the only place a page loads,
    and rehydration follows immediately, so a deterministic wait keeps the
    session honest without a fixed 2 s tax per page.
    """
    ctx = playwright_browser.new_context(viewport={"width": 1400, "height": 900})
    ctx.set_default_timeout(180_000)
    page = ctx.new_page()
    _attach_error_tracker(page)
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_function(
        '''async () => {
            try {
                const s = await import("/app/src/ui/state.js");
                return !!(s && s.getState && s.getState());
            } catch (e) { return false; }
        }'''
    )
    boot_errs = relevant_errors(page)
    assert not boot_errs, f"boot errors: {boot_errs}"
    return ctx, page


def _rehydrate(page, fixture_url):
    """Load a committed fixture zip into the page via the deserialiseFile
    path — the exact mechanism topbar.js loadProject runs, minus the file
    picker. Fetches the zip over the dev server, wraps it as a File,
    deserialises, applies the patch wholesale (engine cascade deliberately
    skipped — the results are already in the zip), reinstalls the workflow
    tree, and reconciles the flat projection slots. Returns nothing; the
    page's state is now the saved state.
    """
    page.evaluate(
        '''async (fixtureUrl) => {
            const { deserialiseFile } = await import("/app/src/persistence/deserialise.js");
            const state = await import("/app/src/ui/state.js");
            const wf    = await import("/app/src/ui/workflow.js");
            const proj  = await import("/app/src/ui/workflow-projection.js");

            const r = await fetch(fixtureUrl);
            if (!r.ok) throw new Error(`fixture fetch ${r.status} for ${fixtureUrl}`);
            const blob = await r.blob();
            const name = fixtureUrl.split("/").pop();
            const file = new File([blob], name, { type: "application/zip" });
            const { patch } = await deserialiseFile(file);

            // Apply the patch wholesale (mirrors topbar.js loadProject): the
            // cascade is skipped because the zip already carries every result.
            const cur = state.getState();
            state.update({
                ...patch,
                clusterResult: patch.clusterLevels && patch.clusterLevels.length
                    ? patch.clusterLevels[patch.clusterLevels.length - 1].clusterResult
                    : null,
            });

            // Reinstall the tree through workflow.js so its serial counter
            // advances past the restored ids.
            wf.importWorkflow(patch.workflow ?? { steps: {}, rootId: null, selected: null });

            // Reconcile flat slots with the restored tree / force a repaint.
            const selected = state.getState().workflow.selected;
            if (selected) {
                proj.projectStepIntoLegacyState(selected, { bumpRevision: true });
            } else {
                state.update({ engineRevision: cur.engineRevision + 1 });
            }
        }''',
        fixture_url,
    )


def _snapshot_pristine_slots(page):
    """Snapshot the pristine real-data geometry slots so the per-test reset
    can restore them. References only — the arrays are never mutated in
    place, only the slot is reassigned — so a test that clobbers
    clusterLevels / dimredResult / _basePos (e.g. the projection tests,
    which project synthetic length-2 cards into the legacy slots) can't
    corrupt the shared session for tests that run after it.
    """
    page.evaluate(
        '''async () => {
            const s = (await import("/app/src/ui/state.js")).getState();
            window.__pristineSlots = {
                dimredResult:           s.dimredResult,
                dimredResultPreFusion:  s.dimredResultPreFusion,
                _basePos:               s._basePos,
                _basePos2d:             s._basePos2d,
                _basePosPreFusion:      s._basePosPreFusion,
                clusterLevels:          s.clusterLevels,
                clusterResult:          s.clusterResult,
            };
        }'''
    )


def _reset_page(page):
    """Per-test reset shared by every booted page: clears workflow /
    validationRuns / jobs and restores the pristine geometry slots so each
    test starts from the freshly-rehydrated state without re-paying the
    load. Mirrors the discipline the old `page` fixture enforced.
    """
    page.errors.clear()
    page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const wf    = await import("/app/src/ui/workflow.js");
            wf.clearWorkflow();
            state.clearValidationRuns();
            // Restore the pristine real-data geometry slots in case a prior
            // test clobbered them (see _snapshot_pristine_slots).
            if (window.__pristineSlots) state.update({ ...window.__pristineSlots });
            // Clear in-flight jobs cleanly: cancel runnings, drop all.
            const cur = state.getState();
            const q = await import("/app/src/ui/queue.js");
            for (const id of cur.jobs.order || []) {
                const j = cur.jobs.byId[id];
                if (j && (j.status === "pending" || j.status === "running")) {
                    q.cancelJob(id);
                }
            }
            // Wait a tick so cancellations settle, then wipe the slot.
            await new Promise(r => setTimeout(r, 50));
            state.update({ jobs: { byId: {}, order: [], runningId: null } });
        }'''
    )


def _make_session_page(playwright_browser, fixture_url):
    """Boot one page, rehydrate it from `fixture_url`, guard the boot +
    rehydrate for console errors, snapshot the pristine slots, and yield.
    Shared body for the three session-scoped page fixtures.
    """
    ctx, page = _boot_page(playwright_browser)
    _rehydrate(page, fixture_url)

    setup_errs = relevant_errors(page)
    assert not setup_errs, f"setup errors after rehydrate ({fixture_url}): {setup_errs}"

    _snapshot_pristine_slots(page)
    page.errors.clear()                                  # tests start with a clean slate
    try:
        yield page
    finally:
        ctx.close()


@pytest.fixture(scope="session")
def _clean_session(playwright_browser):
    """Session page rehydrated from clean.zip — empty workflow, no data."""
    yield from _make_session_page(playwright_browser, FIXTURE_CLEAN)


@pytest.fixture(scope="session")
def _data_only_session(playwright_browser):
    """Session page rehydrated from data_only.zip — genResult + embedding +
    rawCitationEdges, no dim-red / clustering."""
    yield from _make_session_page(playwright_browser, FIXTURE_DATA_ONLY)


@pytest.fixture(scope="session")
def _baseline_session(playwright_browser):
    """Session page rehydrated from fallworm_baseline.zip — the full
    pipeline (data → dim-red → clustering)."""
    yield from _make_session_page(playwright_browser, FIXTURE_BASELINE)


@pytest.fixture
def page(_baseline_session):
    """Default per-test page: the rehydrated fallworm baseline, reset before
    each test (workflow / validationRuns / jobs cleared, pristine geometry
    restored). Replaces the recompute-heavy bfs5000_page session.

    Asserts no console errors occurred during the test.
    """
    _reset_page(_baseline_session)
    yield _baseline_session
    errs = relevant_errors(_baseline_session)
    assert not errs, f"console errors during test: {errs}"


@pytest.fixture
def data_only_page(_data_only_session):
    """Per-test page for tests that need ingested data (genResult, embedding,
    citations) but NOT dim-red / clustering. Reset per test."""
    _reset_page(_data_only_session)
    yield _data_only_session
    errs = relevant_errors(_data_only_session)
    assert not errs, f"console errors during data_only_page test: {errs}"


def _wipe_data_slots(page):
    """Restore the clean session's data-free contract. Some clean_page tests
    deliberately run a real ingest (granular build-out: data/dimred cards),
    which leaves genResult / embedding / dimredResult / clusterLevels (and a
    materialised-text source that flips c-TF-IDF availability) on the shared
    _clean_session. Without this, a later clean_page test inherits that data
    and mis-reports (e.g. labelling's availCTfidf). Mirrors a fresh clean.zip
    rehydrate without re-paying the load."""
    page.evaluate(
        '''async () => {
            const st = await import("/app/src/ui/state.js");
            const sq = await import("/app/src/datasource/sqlite.js");
            // The loaded sqlite corpus lives in a module-global handle that a
            // state reset can't touch; drop it so hasSqliteText() reads false
            // (else c-TF-IDF labelling / RIS export stay "available").
            sq.clearSqliteCorpus();
            st.update({
                genResult: null, embedding: null, rawCitationEdges: null,
                dimredResult: null, dimredResultPreFusion: null,
                _basePos: null, _basePos2d: null, _basePosPreFusion: null,
                clusterLevels: null, clusterResult: null,
                bridgeAnalysis: null, crossClusterCitations: null,
                nodeDisplacement: null, fusionActive: false,
                dataSource: { mode: "sqlite", configs: { sqlite: { dataset: "fallworm" } } },
            });
        }'''
    )


@pytest.fixture
def clean_page(_clean_session):
    """Per-test page with NO data loaded. For pure-module tests (queue.js,
    workflow.js CRUD) that don't need genResult / dimredResult / etc.
    Reset per test off the shared rehydrated clean session — no per-test
    boot, no ingest."""
    _reset_page(_clean_session)
    _wipe_data_slots(_clean_session)
    yield _clean_session
    errs = relevant_errors(_clean_session)
    assert not errs, f"console errors during clean_page test: {errs}"
