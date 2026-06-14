// JSON-file citation-edge importer.
//
// Loads the carved `citation_edges.json` artifact that sits next to
// the embedding subset under `literture-network/artifacts/<subset>/`.
// File shape is documented in citation_edges.json's `meta` block and
// produced by `literture-network/scripts/make_subset_citation_edges.py`.
//
// Returns the raw edge list exactly as stored — direction matches
// citgraphv2's "source is cited by target" convention. The
// imported-edges algorithm flips direction at materialisation time
// to match the toy's "newer cites older" CitationResult contract.
//
// Path resolution is currently hard-coded to the `dev_subset` directory
// because that's the only carved subset that exists. When more
// subsets get carved (a future connectivity-aware subset, or larger
// random subsets), we map dataSourceParams.subset id → directory
// name here. Keeping the mapping local keeps the data-source registry
// and the importer registry independently evolvable.

export const ID = "json-file";

// Map subset ids (as registered in datasource/real.js) → directory
// names under literture-network/artifacts/. The id namespace and
// the directory namespace are kept distinct because the registry
// id is user-facing UI vocabulary and the directory name is a
// disk artifact.
const SUBSET_DIRS = {
  "dev_subset_1000":     "dev_subset",
  "dev_subset_bfs_5000": "dev_subset_bfs",
};

export async function fetch({ dataSourceParams = {} } = {}) {
  const subsetId = dataSourceParams.subset || "dev_subset_1000";
  const dir = SUBSET_DIRS[subsetId];
  if (!dir) {
    throw new Error(
      `[importer:json-file] unknown subset id "${subsetId}". ` +
      `Add a SUBSET_DIRS entry mapping this id to a directory under literture-network/artifacts/.`
    );
  }

  const url = `/literture-network/artifacts/${dir}/citation_edges.json`;
  const r = await window.fetch(url);
  if (!r.ok) {
    if (r.status === 404) {
      throw new Error(
        `[importer:json-file] citation_edges.json not found at ${url}. ` +
        `Carve it first: \`python literture-network/scripts/make_subset_citation_edges.py --subset ${dir}\``
      );
    }
    throw new Error(`[importer:json-file] failed to load ${url}: HTTP ${r.status}`);
  }
  const doc = await r.json();
  if (!doc || !Array.isArray(doc.edges)) {
    throw new Error(`[importer:json-file] malformed citation_edges.json: missing "edges" array`);
  }

  // Returned shape is the algorithm's contract — pure pairs, no
  // metadata. The doc.meta block is informational only; if a future
  // algorithm wants to consult it, expose a separate `fetchMeta()`
  // entry-point rather than overloading this one.
  return doc.edges;
}
