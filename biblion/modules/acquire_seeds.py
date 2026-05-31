"""
acquire_seeds — PLACEHOLDER.

Future work: build the seed corpus from scratch.

Sources to design for:
  - Keyword search against Google Scholar (via scholarly or a self-hosted
    SerpAPI replacement)
  - Keyword search against Semantic Scholar (s2_query.py style)
  - Keyword search against OpenAlex (`/works?search=<query>`)
  - Manual RIS import (the v1 starting point — kept for reproducibility)

Output contract is straightforward — every discovered seed becomes a
PaperRecord pushed to the cache with is_seed implied by the source label.
The merge writer takes it from there.

Why this is deferred:
  The current v3 DB is populated by migration from v2 (which itself came
  from a manually-curated RIS import). Re-acquiring seeds requires the
  keyword search API surfaces, query design, dedup-against-existing logic,
  and a way to verify the new seed set matches the user's intent. Out of
  scope for the framework bring-up.
"""
from ..framework import Module, ModuleResult, ValidationResult


class AcquireSeeds(Module):
    name        = 'acquire_seeds'
    description = '[PLACEHOLDER] Acquire seed papers from keyword search (GS / S2 / OA)'

    requires    = set()                       # entry point; reads from external APIs
    produces    = {'cache:papers'}            # pushes PaperRecord with is_seed source
    eventually  = {'papers.id', 'papers.is_seed'}
    resources   = {'google_scholar_api', 'openalex_api', 's2_api'}

    def validate(self, ctx):
        return ValidationResult(
            ok=False,
            missing=['NOT_YET_IMPLEMENTED'],
            message='acquire_seeds is a placeholder. Use migrate_from_v2 for now.',
        )

    def run(self, ctx):
        raise NotImplementedError(
            "acquire_seeds is a placeholder. See module docstring for design notes."
        )
