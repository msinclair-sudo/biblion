"""
expand_seeds — PLACEHOLDER.

Future work: for every seed paper, walk one level out in the citation
graph and add the referenced + citing papers to the corpus.

API choice notes:
  - S2 returns BOTH references and citations per paper in one call (best
    bang-per-request) but the metadata endpoint currently returns 403
    with our key. The references/citations endpoints may still work —
    needs testing.
  - OpenAlex returns referenced_works in the same call as metadata. To
    get the *inbound* citations (papers that cite the seed) requires a
    separate query `/works?filter=cites:W123`. Two calls per seed.
  - A hybrid (S2 if it works, OA fallback) keeps API budget low.

Output contract:
  - PaperRecord pushed for each discovered reference / citation (the
    merge writer dedupes against existing seeds).
  - CitationRecord pushed for every edge discovered.

Why this is deferred:
  Same as acquire_seeds — the v3 DB currently inherits state from v2,
  which has already done one round of expansion via v2 phase 3. A
  re-expansion would need to dedupe against that existing state and
  decide what to do about edges already in the v2 citations table.
"""
from ..framework import Module, ModuleResult, ValidationResult


class ExpandSeeds(Module):
    name        = 'expand_seeds'
    description = '[PLACEHOLDER] Walk one citation hop out from every seed'

    requires    = {'papers.is_seed'}
    produces    = {'cache:papers', 'cache:citations'}
    eventually  = {'papers.id', 'citations.citing_id', 'citations.cited_id'}
    resources   = {'s2_api', 'openalex_api'}

    def validate(self, ctx):
        return ValidationResult(
            ok=False,
            missing=['NOT_YET_IMPLEMENTED'],
            message='expand_seeds is a placeholder. v3 DB is populated by migrate_from_v2.',
        )

    def run(self, ctx):
        raise NotImplementedError(
            "expand_seeds is a placeholder. See module docstring for design notes."
        )
