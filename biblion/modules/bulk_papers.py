"""
bulk_papers — stream the S2 papers dataset and fill metadata holes.

Pushes title / year / venue / authors / pub_type / cit_count / ref_count
plus the DOI from externalIds. The merge writer COALESCEs each column,
so already-populated fields aren't overwritten unless v3's policy says so.

Run AFTER bulk_paper_ids (needs the corpusid → pid scratch map).
"""
from __future__ import annotations

import json

from ..cache.records import PaperRecord
from ..clients.semanticscholar import _normalise_doi
from ..framework import Module, ModuleResult, ValidationResult
from ._bulk_common import (
    CacheThrottle, StreamProgress, bulk_cache_dir, filename_for_url,
    load_pid_to_s2id, resolve_release_id,
)
from .bulk_paper_ids import load_corpusid_map


_SOURCE = 's2_bulk_papers'


def _parse_authors(record: dict) -> str | None:
    """Same author-list normalisation as enrich_metadata_s2: just names."""
    names = [a.get('name') for a in (record.get('authors') or []) if a.get('name')]
    return json.dumps(names) if names else None


def _parse_pub_type(record: dict) -> str | None:
    pub_types = record.get('publicationtypes') or []
    return pub_types[0].lower() if pub_types else None


class BulkPapers(Module):
    name        = 'bulk_papers'
    description = 'Fill paper metadata from the S2 bulk papers dataset'

    requires    = {'scratch:corpusid_map'}
    produces    = {'cache:papers'}
    eventually  = {'papers.title', 'papers.year', 'papers.venue',
                   'papers.authors', 'papers.pub_type',
                   'citation_counts.s2'}
    resources   = {'s2_datasets_api'}

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        from ..clients.s2_bulk import _get_api_key
        if not _get_api_key():
            return ValidationResult(ok=False, missing=['s2_api_key'])
        _, m = load_corpusid_map(ctx.work_dir)
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
        print(f"  bulk_papers: loaded {len(corpusid_to_pid):,} corpusid → pid pairs "
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

        descriptor = client.dataset_files(release_id, 'papers')
        if not descriptor:
            return ModuleResult(status='failed',
                                message=f"Could not fetch papers descriptor for {release_id}")
        files = descriptor.get('files') or []
        print(f"  papers: {len(files)} files")

        cache_dir = bulk_cache_dir(release_id, 'papers')
        print(f"  cache: {cache_dir}")

        progress = StreamProgress('papers')
        throttle = CacheThrottle(ctx.cache)
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
                s2_id = pid_to_s2id.get(pid)
                if not s2_id:
                    continue

                ext = record.get('externalids') or {}
                doi = _normalise_doi(ext.get('DOI') or '')
                title    = record.get('title')
                year     = record.get('year')
                # Venue fallback: S2's `venue` is only populated on ~38%
                # of records; `journal.name` covers ~88%. Use whichever
                # the record has, preferring the explicit `venue`.
                venue = record.get('venue') or None
                if not venue:
                    journal = record.get('journal') or {}
                    venue = (journal.get('name') or '').strip() or None
                authors  = _parse_authors(record)
                pub_type = _parse_pub_type(record)
                pub_date = record.get('publicationdate') or None
                cit_cnt  = record.get('citationcount')
                ref_cnt  = record.get('referencecount')
                infl_cnt = record.get('influentialcitationcount')
                is_oa    = record.get('isopenaccess')

                # S2 fields of study — store the structured form so the
                # `category`/`source` distinction isn't lost.
                s2fos = record.get('s2fieldsofstudy') or None
                s2fos_json = json.dumps(s2fos) if s2fos else None

                # PubMed identifiers from externalIds.
                pmid     = ext.get('PubMed') or None
                pmcid    = ext.get('PubMedCentral') or None

                # Skip the push if there's literally nothing useful — saves
                # cache work and merge-side conflict checks.
                if not any([title, year, venue, authors, pub_type, pub_date,
                            doi, cit_cnt, ref_cnt, infl_cnt, is_oa is not None,
                            s2fos_json, pmid, pmcid]):
                    progress.tick_skip()
                    continue

                ctx.cache.push_paper(PaperRecord(
                    source                = _SOURCE,
                    s2_id                 = s2_id,
                    doi                   = doi,
                    title                 = title,
                    year                  = year,
                    venue                 = venue,
                    authors_json          = authors,
                    pub_type              = pub_type,
                    publication_date      = pub_date,
                    is_open_access        = (bool(is_oa) if is_oa is not None
                                             else None),
                    influential_cit_count = infl_cnt,
                    s2_fields_of_study    = s2fos_json,
                    pubmed_id             = pmid,
                    pubmed_central_id     = pmcid,
                    cit_count             = cit_cnt,
                    ref_count             = ref_cnt,
                ))
                progress.tick_push()
                throttle.maybe_wait(ctx.shutdown)
                progress.maybe_print()
            progress.maybe_print(force=True)

        stats = progress.summary_stats()
        stats['throttle_waits']   = throttle.wait_events
        stats['throttle_total_s'] = round(throttle.total_wait_s, 1)
        stats['release_id']       = release_id
        stats['bytes_downloaded'] = n_bytes_downloaded

        return ModuleResult(
            status='success' if stats['pushed'] else 'noop',
            message=(f"{stats['pushed']:,} paper-metadata records pushed from "
                     f"{stats['records_scanned']:,} S2 records "
                     f"({stats['matched']:,} matched corpus, "
                     f"{stats['skipped_no_field']:,} matched but empty)"),
            stats=stats,
        )
