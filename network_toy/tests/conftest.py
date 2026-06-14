"""Shared Playwright fixtures for the test suite.

Per the 2026-05-26 directive, tests run against the BFS-5000 real-data
fixture by default (5000 papers, BFS-carved from 5 high-degree seeds —
see doc/plan.md §6.4d). Loading the fixture is expensive (~30 s data
fetch + ~30 s UMAP + ~10 s HDBSCAN), so we boot once per session,
apply the locked-default analysis pipeline, then share that page
across tests. Each test resets the lightweight slots
(`state.workflow`, `state.validationRuns`, `state.jobs`) at the start
so tree CRUD / queue / panel work runs against a clean slate without
re-paying the data + UMAP cost.

Fixtures:

    dev_server          (session) — http.server on :8000
    playwright_browser  (session) — Chromium headless
    bfs5000_page        (session) — page loaded with BFS-5000 data +
                                    default dim-reduction + default
                                    HDBSCAN clustering. Used by `page`.
    page                (function) — yields bfs5000_page after
                                     resetting workflow / validationRuns
                                     / jobs. The default fixture.
    clean_page          (function) — separate page with NO data load;
                                     for pure-module tests (queue.js,
                                     workflow.js CRUD) that don't
                                     need ingest.

Console-error guard: every page tracks errors; the fixture asserts
no relevant errors occurred during the test. (The 3d-force-graph
teardown error is suppressed — known harmless.)
"""

import os
import socket
import subprocess
import time

import pytest
from playwright.sync_api import sync_playwright

# Port is overridable so a session can keep :8000 for a live browser and run
# the suite elsewhere (e.g. NETWORK_TOY_TEST_PORT=8002). Defaults to 8000.
TEST_PORT = int(os.environ.get("NETWORK_TOY_TEST_PORT", "8000"))
URL = f"http://localhost:{TEST_PORT}/app/"
KNOWN_FG_TEARDOWN = "Cannot read properties of undefined (reading 'tick')"

# Best-effort optional resources the app deliberately probes and gracefully
# skips on 404 (e.g. a project's subsets/index.json — "no subsets" is a valid
# state; see datasource/sqlite.js discoverSubsets). Their 404s are expected and
# must NOT fail the boot guard. The browser also logs a generic, URL-less
# console error for every failed fetch; we drop those and instead record real
# failures at the response level (which carry the URL, so we can allowlist).
OPTIONAL_RESOURCE_MARKERS = ("/subsets/index.json", "favicon.ico")
_RESOURCE_LOAD_CONSOLE_ERR = "Failed to load resource"

# Session-level analysis params — TUNED FOR TEST SPEED, not production
# realism. The locked production defaults (PCA-100 noise → UMAP-100
# compression → UMAP-3/2 viz, HDBSCAN minClusterSize=100) take ~60-90s
# of session setup at n=5000. We trade fidelity for wall-clock:
#
#   Compression: UMAP-50 (was 100). ARI(50, 100) = 0.806 per the §6.9
#     dim-sweep — partition shape is broadly similar.
#   HDBSCAN: minClusterSize=15 produces 50-60 clusters at this dim,
#     making the cluster signal useful for tests. (Production
#     min_cluster_size=100 degenerates to 2-cluster partitions at
#     n=5000 and is useless for the shape sanity tests need.)
#
# Tests that specifically depend on the production config should
# override layerParams themselves.
HDBSCAN_PARAMS_5000 = {
    "minSamples":        5,
    "minClusterSize":    15,
    "selectionMethod":   "eom",
    "selectionEpsilon":  0,
    "noiseMode":         "absorb",
}
UMAP_COMPRESSION_5000_TEST = {
    "n_components":  50,
    "n_neighbors":   30,
    "min_dist":      0.0,
    "metric":        "cosine",
    "random_state":  42,
}


def _port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


@pytest.fixture(scope="session")
def dev_server():
    """Start http.server on :8000 for the session, kill on teardown.

    Skips spawning if something's already serving :8000 (e.g. the user
    is running a dev server alongside the tests) — but in that case
    DOES NOT terminate the foreign process.
    """
    if _port_in_use(TEST_PORT):
        # Already serving; trust it. Don't tear down on session end.
        yield URL
        return

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen(
        ["python", "-m", "http.server", str(TEST_PORT)],
        cwd=repo_root,
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
    """Open a fresh context+page, navigate, wait for boot."""
    ctx = playwright_browser.new_context(viewport={"width": 1400, "height": 900})
    ctx.set_default_timeout(180_000)
    page = ctx.new_page()
    _attach_error_tracker(page)
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)
    boot_errs = relevant_errors(page)
    assert not boot_errs, f"boot errors: {boot_errs}"
    return ctx, page


@pytest.fixture(scope="session")
def bfs5000_page(playwright_browser):
    """Session-shared page loaded with BFS-5000 real-data fixture +
    default dim-reduction + default HDBSCAN clustering applied.

    Setup is ~60-90 s one-shot.
    """
    ctx, page = _boot_page(playwright_browser)

    page.evaluate(
        '''async ({ hdbscanParams, compressionParams }) => {
            const state  = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const cur = state.getState();
            state.update({
                activeAlgorithm: { ...cur.activeAlgorithm, dataSource: "real" },
                dataSource: {
                    ...cur.dataSource,
                    mode: "real",
                    configs: {
                        ...cur.dataSource.configs,
                        real: { subset: "dev_subset_bfs_5000" },
                    },
                },
                layerParams: {
                    ...cur.layerParams,
                    dimred: {
                        noise:       { method: "pca",      params: { n_components: 100 } },
                        fusion:      { method: "identity", params: {} },
                        compression: { method: "umap",     params: compressionParams },
                        viz:         { method: "umap",     params: { n_components: 3, n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 43 } },
                        viz2d:       { method: "umap",     params: { n_components: 2, n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 44 } },
                    },
                    clustering: {
                        method: "hdbscan",
                        levels: [{
                            uid: Math.random().toString(36).slice(2, 10),
                            params: hdbscanParams,
                            scope: "global",
                        }],
                    },
                },
            });
            await engine.reingest();
        }''',
        { "hdbscanParams": HDBSCAN_PARAMS_5000, "compressionParams": UMAP_COMPRESSION_5000_TEST }
    )

    n = page.evaluate(
        '''async () => {
            const s = (await import("/app/src/ui/state.js")).getState();
            return {
                nNodes:        s.genResult ? s.genResult.nodes.length : 0,
                nClusters:     s.clusterLevels && s.clusterLevels[0] ? s.clusterLevels[0].clusterResult.clusters.length : 0,
                dimredDim:     s.dimredResult ? s.dimredResult.d : 0,
                citationCount: s.rawCitationEdges ? s.rawCitationEdges.length / 2 : 0,
            };
        }'''
    )
    assert n["nNodes"] == 5000, f"expected 5000 papers, got {n['nNodes']}"
    assert n["dimredDim"] >= 50, f"expected dimred d>=50 (UMAP-50 compression), got {n['dimredDim']}"
    assert n["nClusters"] > 5, f"expected >5 clusters (HDBSCAN at minClusterSize=15), got {n['nClusters']}"

    # Re-check errors after the long ingest+cascade.
    setup_errs = relevant_errors(page)
    assert not setup_errs, f"setup errors after bfs5000 cascade: {setup_errs}"

    # Snapshot the pristine real-data geometry slots (references — the
    # arrays themselves are never mutated in place, only the slot is
    # reassigned). The per-test `page` reset restores them so a test
    # that clobbers state.clusterLevels / dimredResult / _basePos (e.g.
    # the projection tests, which project synthetic length-2 cards into
    # the legacy slots) can't corrupt the shared session for tests that
    # run after it.
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
    page.errors.clear()                                  # tests start with a clean slate

    yield page

    ctx.close()


@pytest.fixture
def page(bfs5000_page):
    """Default per-test page. Resets workflow / validationRuns / jobs
    before yielding so each test runs on a clean slate; the heavy
    data + dim-reduction + clustering stays loaded.

    Asserts no console errors occurred during the test.
    """
    bfs5000_page.errors.clear()
    bfs5000_page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const wf    = await import("/app/src/ui/workflow.js");
            wf.clearWorkflow();
            state.clearValidationRuns();
            // Restore the pristine real-data geometry slots in case a
            // prior test clobbered them (see bfs5000_page snapshot).
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
    yield bfs5000_page
    errs = relevant_errors(bfs5000_page)
    assert not errs, f"console errors during test: {errs}"


@pytest.fixture
def clean_page(playwright_browser):
    """Page with NO data loaded. For pure-module tests (queue.js,
    workflow.js CRUD) that don't need genResult / dimredResult / etc.

    Boots fresh per test (cheap — no ingest; the app boots with no data
    and tests using this fixture explicitly clear state.workflow + don't
    depend on the legacy slots).
    """
    ctx, page = _boot_page(playwright_browser)
    page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const wf    = await import("/app/src/ui/workflow.js");
            wf.clearWorkflow();
            state.clearValidationRuns();
            state.update({ jobs: { byId: {}, order: [], runningId: null } });
        }'''
    )
    yield page
    errs = relevant_errors(page)
    assert not errs, f"console errors during clean_page test: {errs}"
    ctx.close()
