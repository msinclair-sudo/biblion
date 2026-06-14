"""Part C Step-1 ghost instrumentation harness (spec §5) — headless smoke.

The harness itself is a pure node ESM script (eval/ghost_instrumentation.mjs)
that reuses the toy's pure pipeline modules (pca.js, graph-diffusion.js,
clustering-hdbscan.js) directly in node — no browser, no Playwright. This test
just shells out to the smoke runner on the small synthetic graph and asserts the
three metric blocks are present and finite, so the harness can't silently rot.

Skips (rather than fails) if `node` is unavailable, since the rest of the suite
is Playwright/python and node is not otherwise a hard dependency.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SMOKE = ROOT / "eval" / "smoke_ghost_instrumentation.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_smoke_runs_and_emits_finite_metrics():
    assert SMOKE.exists(), "smoke runner missing"
    proc = subprocess.run(
        ["node", str(SMOKE), "--json"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, f"harness failed:\n{proc.stderr}"
    r = json.loads(proc.stdout.strip().splitlines()[-1])

    # config shape: 12 real + 2 ghosts, ghosts-last, UMAP flagged skipped.
    assert r["config"]["m"] == 12
    assert r["config"]["nGhost"] == 2
    assert "SKIPPED" in r["config"]["umapSpace"]

    # (a) low-variance-collapse detector.
    a = r["lowVarianceCollapse"]
    assert a["meanVarReal"] > 0
    assert a["meanVarGhost"] >= 0
    # ghost variance is below real here but not collapsed to zero — the detector
    # is reporting a live ratio, not a degenerate one.
    assert 0 < a["varianceRatioGhostOverReal"] < 1
    # the bridge ghost connects the two clusters → real-ghost edges span the gap
    # → real-ghost Dirichlet energy/edge strictly exceeds the intra-cluster
    # real-real energy (proves the bridge edges are doing geometric work).
    assert a["dirichletEnergyPerEdge"]["realGhost"] > a["dirichletEnergyPerEdge"]["realReal"]

    # (b) bridge proximity + co-cluster vs null. One bridged pair (0,6).
    b = r["bridgeSignal"]
    assert b["nBridgedPairs"] >= 1
    assert b["real"]["meanDist"] > 0
    # bridge pulls A,B closer than a random-shared-ghost null.
    assert b["distanceRatioRealOverNull"] < 1.0
    # co-cluster rate + lift are finite numbers (may be 0 at this separation).
    assert b["real"]["coClusterRate"] is not None
    assert isinstance(b["coClusterLift"], (int, float))

    # (c) contamination: real geometry largely preserved vs ghost-free ref.
    c = r["contamination"]
    assert c["meanRealNodeDisplacement"] >= 0
    assert c["realRealDistanceRankCorrelation"] > 0.5
