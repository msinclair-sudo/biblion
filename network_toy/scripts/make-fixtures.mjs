// Fixture generator — boots ONE Chromium page against the dev server,
// runs the real fallworm pipeline once at a fixed seed + documented
// params, and serialises three rehydratable fixture zips under
// tests/fixtures/.
//
//   clean              — empty workflow, no data loaded.
//   data_only          — genResult + embedding + rawCitationEdges, no
//                        dim-red / clustering (engine.ingestDataOnly()).
//   fallworm_baseline  — full pipeline: data -> dim-red -> clustering
//                        (engine.reingest()).
//
// WHY a separate Node generator (not a pytest fixture): regeneration is a
// rare, dev-machine-only operation that needs the gitignored
// data/fallworm/ bundle + a real Chromium + ~minutes of compute. The
// committed zips are self-contained, so CI rehydrates them in ~1-2 s with
// neither the raw data nor any compute. Keeping generation out of the
// default test path is the whole point of the rehydrate-not-recompute
// design (plans/test-suite-plan.md).
//
// Requires the `playwright` Node package (a devDependency for fixture
// regen only — NOT needed by CI, which consumes the committed zips). On a
// machine without it, install with:  npm i -D playwright && npx playwright install chromium
//
// Usage:  npm run make:fixtures
// The script starts its own static server, generates, then tears it down.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");          // network_toy/
const FIXTURE_DIR = resolve(REPO_ROOT, "tests/fixtures");

const PORT = Number(process.env.NETWORK_TOY_TEST_PORT || 8000);
const URL = `http://localhost:${PORT}/app/`;

// The fixture dataset — fallworm, the 1405-node real corpus (decision #1,
// plans/test-suite-plan.md). Selected via the sqlite datasource (see
// app/src/datasource/sqlite.js DATASETS.fallworm).
const DATASET = "fallworm";

// Fixed seed + documented params. These are the production-shaped locked
// defaults run at the fallworm node count (n=1405) — small enough that the
// full PCA->UMAP->UMAP-viz->HDBSCAN cascade completes in reasonable time
// without the n=5000 test-speed compromises conftest.py makes. random_state
// values are pinned so the baseline is deterministic and the @slow
// determinism guard can re-derive it.
const PIPELINE = {
  dimred: {
    noise:       { method: "pca",      params: { n_components: 100 } },
    fusion:      { method: "identity", params: {} },
    compression: { method: "umap",     params: { n_components: 50, n_neighbors: 30, min_dist: 0.0, metric: "cosine", random_state: 42 } },
    viz:         { method: "umap",     params: { n_components: 3, n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 43 } },
    viz2d:       { method: "umap",     params: { n_components: 2, n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 44 } },
  },
  hdbscan: {
    minSamples:       5,
    minClusterSize:   15,
    selectionMethod:  "eom",
    selectionEpsilon: 0,
    noiseMode:        "absorb",
  },
};

function portInUse(port) {
  return new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    sock.on("connect", () => { sock.destroy(); res(true); });
    sock.on("error", () => res(false));
  });
}

async function startDevServer() {
  if (await portInUse(PORT)) {
    // Something already serving (e.g. a live dev session) — trust it and
    // don't tear it down on exit.
    return { url: URL, stop: async () => {} };
  }
  const proc = spawn("python", ["-m", "http.server", String(PORT)], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    if (await portInUse(PORT)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await portInUse(PORT))) {
    proc.kill();
    throw new Error(`dev server failed to start on :${PORT}`);
  }
  return {
    url: URL,
    stop: async () => { proc.kill(); },
  };
}

// Boot a page, navigate, wait for the no-data app to settle.
async function bootPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  ctx.setDefaultTimeout(300_000);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(URL);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  return { ctx, page };
}

// Select the fallworm sqlite source on the page's state (mirrors the
// data-source modal's effect without driving the UI).
async function selectFallworm(page, pipeline) {
  await page.evaluate(async ({ dataset, dimred, hdbscan }) => {
    const state = await import("/app/src/ui/state.js");
    const cur = state.getState();
    state.update({
      activeAlgorithm: { ...cur.activeAlgorithm, dataSource: "sqlite" },
      dataSource: {
        ...cur.dataSource,
        mode: "sqlite",
        configs: { ...cur.dataSource.configs, sqlite: { dataset } },
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
  }, { dataset: DATASET, dimred: pipeline.dimred, hdbscan: pipeline.hdbscan });
}

// Serialise the current page state to a zip and write it out.
async function writeFixture(page, name) {
  const b64 = await page.evaluate(async () => {
    const state = await import("/app/src/ui/state.js");
    const { serialiseState } = await import("/app/src/persistence/serialise.js");
    const blob = serialiseState(state.getState());
    const buf = new Uint8Array(await blob.arrayBuffer());
    // Base64 over the bridge — Playwright can't return a Blob/Buffer.
    let s = "";
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  });
  const out = resolve(FIXTURE_DIR, `${name}.zip`);
  await writeFile(out, Buffer.from(b64, "base64"));
  console.log(`wrote ${out}`);
}

async function main() {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const server = await startDevServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await bootPage(browser);

    // 1. clean — pristine no-data state.
    await page.evaluate(async () => {
      const state = await import("/app/src/ui/state.js");
      const wf = await import("/app/src/ui/workflow.js");
      wf.clearWorkflow();
      state.clearValidationRuns();
    });
    await writeFixture(page, "clean");

    // 2. data_only — fallworm ingested, no dim-red / clustering.
    await selectFallworm(page, PIPELINE);
    await page.evaluate(async () => {
      const engine = await import("/app/src/ui/engine.js");
      await engine.ingestDataOnly();
    });
    await writeFixture(page, "data_only");

    // 3. fallworm_baseline — full cascade from the same selection.
    await page.evaluate(async () => {
      const engine = await import("/app/src/ui/engine.js");
      await engine.reingest();
    });
    // Sanity: a real baseline must have nodes, dim-red, and clusters.
    const stats = await page.evaluate(async () => {
      const s = (await import("/app/src/ui/state.js")).getState();
      return {
        nNodes:    s.genResult ? s.genResult.nodes.length : 0,
        dimredDim: s.dimredResult ? s.dimredResult.d : 0,
        nClusters: s.clusterLevels && s.clusterLevels[0]
          ? s.clusterLevels[0].clusterResult.clusters.length : 0,
      };
    });
    if (stats.nNodes < 1 || stats.dimredDim < 1 || stats.nClusters < 1) {
      throw new Error(`baseline pipeline produced an empty result: ${JSON.stringify(stats)}`);
    }
    console.log(`baseline: ${JSON.stringify(stats)}`);
    await writeFixture(page, "fallworm_baseline");
  } finally {
    await browser.close();
    await server.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
