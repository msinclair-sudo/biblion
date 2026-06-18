// Methods recipe — export the "method" of an analysis (the card sequence and
// their params) as a portable JSON, and replay it against a freshly-loaded
// dataset to pre-queue the long-running compute.
//
// A recipe captures the FULL workflow tree (all branches) but STOPS at cluster
// picking: it includes the long-running compute (dim-reduction, the multi-level
// sweep, …) and prunes the picker + everything downstream (labelling, scoring,
// comparisons), which are user-driven. On apply we attach the recipe's compute
// steps onto the already-loaded data card and run each in order; the picker
// auto-spawns (pending) so the user takes over exactly where the method ends.
//
// The split that makes this cheap: a Step stores `params` (pure JSON — the
// method) apart from `result` (heavy TypedArrays — the computed output). The
// recipe is the tree with `params` kept and result/status/timestamps stripped.
// Replay reuses the existing per-type descriptors (mirroring rerunStep's
// param→applyChange dispatch), so we don't duplicate any engine logic.

import { getState } from "../ui/state.js";
import {
  getRootStep, getStep, getStepChildren, selectStep,
} from "../ui/workflow.js";
import { getLayerDescriptor } from "../ui/modals/layer-descriptors.js";
import { downloadText } from "../export/cluster-export.js";

const RECIPE_SCHEMA  = "network_toy.recipe";
export const RECIPE_VERSION = 1;

// Long-running compute that defines the "method". Everything else is pruned.
const INCLUDE_TYPES = new Set([
  "data", "dimred", "fusionBranch", "nodeDisplacement",
  "clustering", "dimSweep", "multiLevel", "citationLayout",
]);

// Steps the user drives explicitly — replay calls their descriptor's
// applyChange with the recipe params (parent resolved from the selection).
const USER_INITIATED = new Set([
  "dimred", "clustering", "dimSweep", "multiLevel", "citationLayout",
]);

// Steps a producer auto-spawns (the dimred fork's branches + node-displacement).
// Replay must NOT recreate these — it locates the spawned card and maps its id.
const AUTO_SPAWNED = new Set(["fusionBranch", "nodeDisplacement"]);

/* ── export ──────────────────────────────────────────────────────────── */

/**
 * Build the recipe object from the live workflow. Pure (no I/O) and testable.
 * Walks the tree BFS from the root (root-first = topological: every parent
 * precedes its children), pruning any step whose type isn't in INCLUDE_TYPES —
 * crucially, a pruned node's whole subtree is skipped, so the `multiLevelPicker`
 * boundary drops the picker and the labelling/scoring/export below it.
 * @returns {object} recipe
 */
export function buildRecipe() {
  const root = getRootStep();
  if (!root) throw new Error("[buildRecipe] no workflow to export");

  // BFS, pruning at the first excluded type (don't traverse its children).
  const idMap = new Map();   // runtime step id → recipe-local id
  const collected = [];
  const queue = [root];
  while (queue.length) {
    const step = queue.shift();
    if (!INCLUDE_TYPES.has(step.type)) continue;   // prune node + its subtree
    idMap.set(step.id, "r" + collected.length);
    collected.push(step);
    for (const child of getStepChildren(step.id)) queue.push(child);
  }

  const steps = collected.map((step) => ({
    recipeId:       idMap.get(step.id),
    type:           step.type,
    label:          step.label,
    params:         structuredClone(step.params || {}),
    parentRecipeId: step.parentId ? (idMap.get(step.parentId) ?? null) : null,
    refRecipeIds:   (step.refIds || []).map((r) => idMap.get(r)).filter(Boolean),
    endpoint:       (step.params && step.params.endpoint) || null,
  }));

  // Reference only (shown on apply) — NOT re-applied; replay attaches to the
  // already-loaded data card whatever it is.
  const rp = root.params || {};
  const dataBinding = { mode: rp.mode || null, dataset: rp.dataset || null };

  return {
    schema:    RECIPE_SCHEMA,
    version:   RECIPE_VERSION,
    createdAt: new Date().toISOString(),
    dataBinding,
    steps,
  };
}

/** Build the recipe and trigger a browser download of the `.json`. */
export function exportRecipe() {
  const recipe = buildRecipe();
  const base = (getState().projectName)
    || (recipe.dataBinding && recipe.dataBinding.dataset)
    || "recipe";
  const name = `${String(base).replace(/[\\/:*?"<>|]/g, "_")}.recipe.json`;
  downloadText(JSON.stringify(recipe, null, 2), name, "application/json");
}

/* ── apply (replay) ──────────────────────────────────────────────────── */

// Let pending `.then`-scheduled spawns (multiLevelPicker, nodeDisplacement)
// run before we look for the auto-spawned cards.
const settle = () => new Promise((r) => setTimeout(r, 0));

// Mirror rerunStep's per-type param→applyChange unpacking, but feeding recipe
// params instead of an existing step. Returns the descriptor's awaitable job
// promise. citationLayout maps to the "layout" descriptor key.
function dispatchApply(rstep) {
  const p = rstep.params || {};
  switch (rstep.type) {
    case "dimred":
      return getLayerDescriptor("dimred").applyChange({
        noise: p.noise, fusion: p.fusion, compression: p.compression,
        viz: p.viz, viz2d: p.viz2d,
      });
    case "clustering":
      return getLayerDescriptor("clustering").applyChange(
        p.method, p.levels || [], { bootstrap: p.bootstrap });
    case "citationLayout":
      return getLayerDescriptor("layout").applyChange(p.method, p.params || {});
    case "dimSweep":
      return getLayerDescriptor("dimSweep").applyChange({
        dims: p.dims, seeds: p.seeds, verdictThreshold: p.verdictThreshold,
      });
    case "multiLevel":
      return getLayerDescriptor("multiLevel").applyChange({
        minSamples: p.minSamples, floor: p.floor, B: p.B,
      });
    default:
      throw new Error(`[applyRecipe] type "${rstep.type}" is not replayable`);
  }
}

// The newest child of `parentId` of the given type whose id isn't already
// mapped — robust to the descriptor moving the selection after applyChange
// (e.g. dimred re-selecting the post branch).
function newestUnmappedChild(parentId, type, mappedIds) {
  const kids = getStepChildren(parentId).filter(
    (c) => c.type === type && !mappedIds.has(c.id));
  return kids.length ? kids[kids.length - 1].id : null;
}

/**
 * Replay a recipe onto the currently-loaded dataset. Requires a `data` root to
 * already exist (load a dataset first); the recipe's data step maps to it and
 * is NOT re-applied. Each compute step runs in turn — the descriptors enqueue
 * their own FIFO jobs and we await them, so compute serialises. Stops the loop
 * (leaving the partial tree) and re-throws if a step's job fails.
 * @param {object} recipe
 */
export async function applyRecipe(recipe) {
  if (!recipe || recipe.schema !== RECIPE_SCHEMA) {
    throw new Error("[applyRecipe] not a network_toy recipe");
  }
  if (recipe.version !== RECIPE_VERSION) {
    throw new Error(`[applyRecipe] recipe version ${recipe.version} unsupported `
      + `(this build expects ${RECIPE_VERSION})`);
  }
  const steps = recipe.steps || [];
  if (!steps.length || steps[0].type !== "data") {
    throw new Error("[applyRecipe] recipe must start with a data step");
  }
  const dataCard = getRootStep();
  if (!dataCard || dataCard.type !== "data") {
    throw new Error("[applyRecipe] load a dataset before applying a recipe");
  }

  const idMap = new Map();        // recipeId → new runtime step id
  const mappedIds = new Set();    // new runtime ids already mapped (for lookup)
  idMap.set(steps[0].recipeId, dataCard.id);
  mappedIds.add(dataCard.id);

  for (const rstep of steps.slice(1)) {
    const parentId = idMap.get(rstep.parentRecipeId);

    if (USER_INITIATED.has(rstep.type)) {
      if (!parentId) {
        throw new Error(`[applyRecipe] step ${rstep.recipeId} (${rstep.type}) `
          + "has no resolved parent");
      }
      // Selection drives parent resolution for multiLevel/clustering/dimSweep;
      // harmless for dimred (resolves to the latest data card regardless).
      selectStep(parentId);
      await dispatchApply(rstep);
      const newId = newestUnmappedChild(parentId, rstep.type, mappedIds);
      if (!newId) {
        throw new Error(`[applyRecipe] could not locate the new ${rstep.type} card`);
      }
      idMap.set(rstep.recipeId, newId);
      mappedIds.add(newId);
      continue;
    }

    if (AUTO_SPAWNED.has(rstep.type)) {
      await settle();
      if (rstep.type === "fusionBranch") {
        // Spawned eagerly by the dimred descriptor; match on endpoint.
        const dimredId = parentId;
        const branch = dimredId
          ? getStepChildren(dimredId).find(
              (c) => c.type === "fusionBranch"
                  && c.params && c.params.endpoint === rstep.endpoint)
          : null;
        if (branch) {
          idMap.set(rstep.recipeId, branch.id);
          mappedIds.add(branch.id);
        } else if (dimredId) {
          // Identity-fusion at replay time (no fork): map the branch onto the
          // dimred itself so its multiLevel/clustering children attach there
          // (multiLevel's resolveParent falls back fusionBranch→dimred).
          idMap.set(rstep.recipeId, dimredId);
        }
      } else {
        // nodeDisplacement: auto-spawned under the post branch after dimred
        // lands. Map it if present; nothing downstream depends on it, so a
        // miss (identity fusion) is fine to skip.
        const nd = parentId
          ? getStepChildren(parentId).find((c) => c.type === "nodeDisplacement")
          : null;
        if (nd) { idMap.set(rstep.recipeId, nd.id); mappedIds.add(nd.id); }
      }
      continue;
    }

    // Defensive: an unexpected type slipped through the prune.
    throw new Error(`[applyRecipe] unexpected recipe step type "${rstep.type}"`);
  }
}
