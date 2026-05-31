"""
bulk_abstracts — stream the S2 abstracts dataset and push matching abstracts
through the merge cache.

For each record whose corpusid matches a paper in our corpus, push a
PaperRecord with `abstract` set (and DOI from externalids if S2 has one we
don't). The merge writer COALESCEs into papers.abstract.

This is a one-shot, not a producer-loop. Run order:
    1. bulk_paper_ids   (builds the corpusid → pid scratch map)
    2. bulk_abstracts   (this module)
    3. bulk_papers      (fills remaining metadata holes)
"""
from __future__ import annotations

import time

from ..cache.records import PaperRecord
from ..clients.semanticscholar import _normalise_doi
from ..framework import Module, ModuleResult, ValidationResult
from ._bulk_common import (
    CacheThrottle, StreamProgress, bulk_cache_dir, filename_for_url,
    load_pid_to_s2id, resolve_release_id,
)
from .bulk_paper_ids import load_corpusid_map


_SOURCE = 's2_bulk_abstracts'


class BulkAbstracts(Module):
    name        = 'bulk_abstracts'
    description = 'Fill papers.abstract from the S2 bulk abstracts dataset'

    requires    = {'scratch:corpusid_map'}
    produces    = {'cache:papers'}
    eventually  = {'papers.abstract'}
    resources   = {'s2_datasets_api'}

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        from ..clients.s2_bulk import _get_api_key
        if not _get_api_key():
            return ValidationResult(ok=False, missing=['s2_api_key'])
        # The scratch map must exist
        release_id, m = load_corpusid_map(ctx.work_dir)
        if not m:
            return ValidationResult(
                ok=False, missing=['scratch:corpusid_map'],
                message='Run bulk_paper_ids first to build the corpusid map',
            )
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        import time as _time
        from ..clients.s2_bulk import S2BulkClient, iter_jsonl_gz_file

        scratch_release_id, corpusid_to_pid = load_corpusid_map(ctx.work_dir)
        if not corpusid_to_pid:
            return ModuleResult(status='failed',
                                message='corpusid → pid map empty; run bulk_paper_ids first')
        print(f"  bulk_abstracts: loaded {len(corpusid_to_pid):,} corpusid → pid pairs "
              f"(scratch release {scratch_release_id})")

        pid_to_s2id = load_pid_to_s2id(ctx)
        print(f"  loaded {len(pid_to_s2id):,} pid → s2_id reverse map")

        client = S2BulkClient()
        release_id = resolve_release_id(ctx, client, scratch_release_id)
        if not release_id:
            return ModuleResult(status='failed',
                                message='Could not resolve a release id')
        if release_id != scratch_release_id:
            print(f"  [WARN] scratch map was built from {scratch_release_id} but "
                  f"processing {release_id}; new corpusids will be missed. "
                  f"Re-run bulk_paper_ids for consistency.")

        descriptor = client.dataset_files(release_id, 'abstracts')
        if not descriptor:
            return ModuleResult(status='failed',
                                message=f"Could not fetch abstracts descriptor for {release_id}")
        files = descriptor.get('files') or []
        print(f"  abstracts: {len(files)} files")

        cache_dir = bulk_cache_dir(release_id, 'abstracts')
        print(f"  cache: {cache_dir}")

        progress  = StreamProgress('abstracts')
        throttle  = CacheThrottle(ctx.cache)
        n_bytes_downloaded = 0

        for i, file_url in enumerate(files, 1):
            if ctx.shutdown.requested:
                print(f"  [shutdown] aborting at file {i}/{len(files)}")
                break
            local_name = filename_for_url(file_url, i)
            local_path = cache_dir / local_name
            print(f"  [file {i:>2}/{len(files)}] {local_name}")

            t_dl = _time.time()
            written = client.download_file(file_url, local_path)
            if written:
                dt_dl = _time.time() - t_dl
                mb = written / (1024 * 1024)
                print(f"    downloaded {mb:.1f} MB in {dt_dl:.1f}s "
                      f"({mb / max(dt_dl, 0.001):.1f} MB/s)")
                n_bytes_downloaded += written
            else:
                print(f"    cached {local_path.stat().st_size / (1024*1024):.1f} MB")

            for record in iter_jsonl_gz_file(local_path):
                progress.tick_record()
                cid = record.get('corpusid')
                if cid is None:
                    continue
                pid = corpusid_to_pid.get(cid)
                if pid is None:
                    continue
                progress.tick_match()
                # Strict abstract guard: S2 occasionally has '' or whitespace
                # under the `abstract` key for records where no real abstract
                # exists. Treat those like None.
                abstract = (record.get('abstract') or '').strip() or None
                # Even if there's no abstract, we may still want to push
                # PubMed identifiers from openaccessinfo.externalids.
                # NB: the abstracts dataset stores PubMed IDs under the
                # `Medline` key (the `papers` dataset uses `PubMed` — go
                # figure). Accept either to be safe.
                ext = (record.get('openaccessinfo') or {}).get('externalids') or {}
                doi   = _normalise_doi(ext.get('DOI') or '')
                pmid  = ext.get('Medline') or ext.get('PubMed') or None
                pmcid = ext.get('PubMedCentral') or None

                if not (abstract or pmid or pmcid):
                    progress.tick_skip()
                    continue

                s2_id = pid_to_s2id.get(pid)
                if not s2_id:
                    continue
                ctx.cache.push_paper(PaperRecord(
                    source            = _SOURCE,
                    s2_id             = s2_id,
                    doi               = doi,
                    abstract          = abstract,
                    pubmed_id         = pmid,
                    pubmed_central_id = pmcid,
                ))
                progress.tick_push()
                throttle.maybe_wait(ctx.shutdown)
                progress.maybe_print()
            progress.maybe_print(force=True)

        stats = progress.summary_stats()
        stats['throttle_waits']    = throttle.wait_events
        stats['throttle_total_s']  = round(throttle.total_wait_s, 1)
        stats['release_id']        = release_id
        stats['bytes_downloaded']  = n_bytes_downloaded

        return ModuleResult(
            status='success' if stats['pushed'] else 'noop',
            message=(f"{stats['pushed']:,} abstracts pushed from "
                     f"{stats['records_scanned']:,} S2 records "
                     f"({stats['matched']:,} matched corpus, "
                     f"{stats['skipped_no_field']:,} matched but no abstract)"),
            stats=stats,
        )
