// check-node-portable.mjs — mechanical Tier-0 boundary check.
//
// For every app/src/**/*.js, try to `import()` it under plain Node. A module
// that imports cleanly is part of the Tier-0 universe: it has no DOM and no
// CDN-only dependency (three / fflate / umap-js / 3d-force-graph pulled from
// esm.sh / unpkg), so it can be unit-tested directly with `node --test`,
// offline, with no browser. A module that throws on import stays Tier-1
// (browser-only / Playwright).
//
// IMPORTANT for porters: import the LEAF logic module directly, not a UI
// wrapper. Many wrappers (panels, runners, node-table, layer-descriptors,
// next-steps-rules) transitively pull the engine and therefore the CDN UMAP
// dep, so they land in the Tier-1 set even though the logic they wrap is pure.
// See tests/unit/colour-modes.test.mjs for the trick.
//
//   node scripts/check-node-portable.mjs            # human report
//   node scripts/check-node-portable.mjs --json     # machine-readable
//   node scripts/check-node-portable.mjs --quiet    # only the portable list
//
// Exit code is always 0 — this is a survey, not a gate.

import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "app", "src");

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile() && ent.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function relSrc(abs) {
  return path.relative(SRC_ROOT, abs).split(path.sep).join("/");
}

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const quiet = args.has("--quiet");

const files = (await walk(SRC_ROOT)).sort();
const portable = [];
const blocked = [];

for (const abs of files) {
  const rel = relSrc(abs);
  try {
    await import(pathToFileURL(abs).href);
    portable.push(rel);
  } catch (err) {
    // First line of the failure is enough to classify (DOM vs CDN fetch vs syntax).
    const reason = String(err && err.message ? err.message : err).split("\n")[0];
    blocked.push({ file: rel, reason });
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify({ portable, blocked }, null, 2) + "\n");
} else if (quiet) {
  for (const f of portable) process.stdout.write(f + "\n");
} else {
  process.stdout.write(`Tier-0 portable (${portable.length}/${files.length}) — importable under plain Node:\n`);
  for (const f of portable) process.stdout.write(`  ok   ${f}\n`);
  process.stdout.write(`\nTier-1 blocked (${blocked.length}/${files.length}) — DOM or CDN-only dep, stays browser/Playwright:\n`);
  for (const b of blocked) process.stdout.write(`  no   ${b.file}  (${b.reason})\n`);
}
