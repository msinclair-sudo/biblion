"""@slow determinism guard for the fallworm baseline fixture.

The freshness guard (test_fixture_freshness.py) only checks the schema
header; it can't see whether the *contents* still match what the live
pipeline produces. This test does: it rehydrates the committed
fallworm_baseline.zip, recomputes the baseline live from the raw
fallworm source at the same fixed seed + params, and asserts the two
agree on the coarse shape (node count exact, dim-red dimensionality
exact, cluster count within tolerance). It catches a fixture that has
drifted from the live pipeline — e.g. an algorithm change that wasn't
followed by a fixture regen.

This is the ONLY fixture test that runs the engine for real, so it lives
under @pytest.mark.slow and needs both a browser and the gitignored
data/fallworm/ bundle.

The pipeline params are NOT duplicated here: they are read back from the
fixture's own manifest.fixtureStamp.pipeline (written by
scripts/make-fixtures.mjs, the single source of truth). Recomputing with
the exact params the fixture was built with is what makes this a true
drift check, and it can't silently disagree with a second hand-kept copy.

Skip policy: by default this skips cleanly when the fixture zip or the
raw data is absent (most checkouts). On a machine that is SUPPOSED to
have the data — the fixture-regeneration / CI-with-data box — export
NETWORK_TOY_HAVE_FALLWORM=1 and a missing fixture or unreachable data
becomes a hard FAILURE instead of a silent skip, so a misconfiguration
can't quietly let drift through.
"""

import json
import os
import socket
import zipfile
from pathlib import Path

import pytest

_HERE = Path(__file__).parent
_FIXTURE = _HERE / "fixtures" / "fallworm_baseline.zip"

# Set on a machine that genuinely has data/fallworm/ (regen / CI-with-data).
# Flips "skip because absent" into "fail because absent" — the operator has
# asserted the data is there, so absence means misconfiguration, not nothing.
_HAVE_DATA = bool(os.environ.get("NETWORK_TOY_HAVE_FALLWORM"))

# Coarse-shape tolerance. Node count + dim-red dimensionality are exact
# (they're structural, not stochastic). Cluster count can wobble a little
# across UMAP/HDBSCAN runs even at a fixed seed (BLAS thread nondeterminism,
# library version drift), so it is checked within an absolute band.
CLUSTER_COUNT_TOLERANCE = 3


def _skip_or_fail(msg):
    """Skip by default; FAIL when NETWORK_TOY_HAVE_FALLWORM asserts the data
    should be present (so absence is loud, not silent)."""
    if _HAVE_DATA:
        pytest.fail(f"{msg} — but NETWORK_TOY_HAVE_FALLWORM is set (data expected)")
    pytest.skip(msg)


def _fixture_pipeline():
    """Read the pipeline params back from the fixture's own provenance stamp
    (single source of truth — make-fixtures.mjs wrote it)."""
    with zipfile.ZipFile(_FIXTURE) as zf:
        with zf.open("manifest.json") as fh:
            manifest = json.load(fh)
    stamp = manifest.get("fixtureStamp") or {}
    return stamp.get("pipeline")


def _fallworm_data_present(base_url):
    """Best-effort probe: does the dev server serve the fallworm snapshot?
    The raw data/fallworm/ bundle is gitignored, so on most checkouts it's
    absent and this @slow guard simply skips."""
    import urllib.request
    import urllib.error

    url = base_url.rstrip("/").rsplit("/app", 1)[0] + "/data/fallworm/paper_index.json"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, OSError):
        return False


@pytest.mark.slow
def test_baseline_fixture_matches_live_pipeline(clean_page, dev_server):
    """Rehydrate the committed baseline, recompute it live, compare shape."""
    if not _FIXTURE.exists():
        _skip_or_fail("fallworm_baseline.zip not generated yet — run `npm run make:fixtures`")
    pipeline = _fixture_pipeline()
    if not pipeline:
        _skip_or_fail(
            "baseline fixture has no pipeline stamp — regenerate with "
            "`npm run make:fixtures` to record its provenance"
        )
    if not _fallworm_data_present(dev_server):
        _skip_or_fail("data/fallworm/ not present — cannot recompute baseline live")

    # 1. Rehydrate the committed fixture (fetched over the dev server, wrapped
    #    as a File, deserialised — the test_persistence.py mechanism).
    fixture = clean_page.evaluate(
        '''async () => {
            const { deserialiseFile } = await import("/app/src/persistence/deserialise.js");
            const r = await fetch("/tests/fixtures/fallworm_baseline.zip");
            const blob = await r.blob();
            const file = new File([blob], "fallworm_baseline.zip", { type: "application/zip" });
            const { patch } = await deserialiseFile(file);
            return {
                nNodes:    patch.genResult ? patch.genResult.nodes.length : 0,
                dimredDim: patch.dimredResult ? patch.dimredResult.d : 0,
                nClusters: patch.clusterLevels && patch.clusterLevels[0]
                    ? patch.clusterLevels[0].clusterResult.clusters.length : 0,
            };
        }'''
    )

    # 2. Recompute live from the raw fallworm source at the same params.
    live = clean_page.evaluate(
        '''async ({ dimred, hdbscan }) => {
            const state  = await import("/app/src/ui/state.js");
            const engine = await import("/app/src/ui/engine.js");
            const cur = state.getState();
            state.update({
                activeAlgorithm: { ...cur.activeAlgorithm, dataSource: "sqlite" },
                dataSource: {
                    ...cur.dataSource,
                    mode: "sqlite",
                    configs: { ...cur.dataSource.configs, sqlite: { dataset: "fallworm" } },
                },
                layerParams: {
                    ...cur.layerParams,
                    dimred,
                    clustering: {
                        method: "hdbscan",
                        levels: [{
                            uid: Math.random().toString(36).slice(2, 10),
                            params: hdbscan,
                            scope: "global",
                        }],
                    },
                },
            });
            await engine.reingest();
            const s = state.getState();
            return {
                nNodes:    s.genResult ? s.genResult.nodes.length : 0,
                dimredDim: s.dimredResult ? s.dimredResult.d : 0,
                nClusters: s.clusterLevels && s.clusterLevels[0]
                    ? s.clusterLevels[0].clusterResult.clusters.length : 0,
            };
        }''',
        {"dimred": pipeline["dimred"], "hdbscan": pipeline["hdbscan"]},
    )

    assert fixture["nNodes"] == live["nNodes"], (
        f"node count drift: fixture {fixture['nNodes']} vs live {live['nNodes']} "
        f"— regenerate with `npm run make:fixtures`"
    )
    assert fixture["dimredDim"] == live["dimredDim"], (
        f"dim-red shape drift: fixture {fixture['dimredDim']} vs live {live['dimredDim']} "
        f"— regenerate with `npm run make:fixtures`"
    )
    assert abs(fixture["nClusters"] - live["nClusters"]) <= CLUSTER_COUNT_TOLERANCE, (
        f"cluster count drift beyond tolerance: fixture {fixture['nClusters']} vs "
        f"live {live['nClusters']} (tol {CLUSTER_COUNT_TOLERANCE}) "
        f"— regenerate with `npm run make:fixtures`"
    )
