"""
bulk_paper_ids — stream the S2 paper-ids dataset to build a corpusid → pid map.

The S2 bulk `abstracts` and `papers` datasets are keyed by `corpusid`, but
our v3 DB only stores S2's `sha` (paperId). The paper-ids dataset is the
join table mapping the two, plus DOI/MAG/ArXiv external IDs.

This module is a one-shot (not a producer-loop): stream once, persist the
resulting map, downstream bulk_* modules read it back. It does NOT push
anything into the merge cache — its output is the scratch map file.

Output: <work_dir>/bulk/corpusid_to_pid.tsv
        First line:  release_id\\tnum_records
        Subsequent:  corpusid\\tpid
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Optional

from ..framework import Module, ModuleResult, ValidationResult


def _scratch_dir(ctx) -> Path:
    d = Path(ctx.work_dir) / 'bulk'
    d.mkdir(parents=True, exist_ok=True)
    return d


def corpusid_map_path(work_dir: Path) -> Path:
    """Stable location of the corpusid → pid map. Used by bulk_abstracts / bulk_papers."""
    return Path(work_dir) / 'bulk' / 'corpusid_to_pid.tsv'


def load_corpusid_map(work_dir: Path) -> tuple[Optional[str], dict[int, int]]:
    """
    Read the persisted corpusid → pid map.

    Returns (release_id, {corpusid: pid}). release_id is None if the file
    is missing or malformed; the dict will be empty in that case.
    """
    path = corpusid_map_path(work_dir)
    if not path.exists():
        return None, {}
    out: dict[int, int] = {}
    release_id: Optional[str] = None
    with open(path) as f:
        header = f.readline().strip().split('\t')
        if len(header) >= 1 and header[0]:
            release_id = header[0]
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) != 2:
                continue
            try:
                out[int(parts[0])] = int(parts[1])
            except ValueError:
                continue
    return release_id, out


def _load_s2id_to_pid(ctx) -> dict[str, int]:
    """Read every (s2_id, pid) pair from the v3 DB."""
    conn = ctx.connect(readonly=True)
    try:
        # ~1.8M rows × ~80 bytes per entry ≈ 150 MB RAM. Fits.
        rows = conn.execute(
            "SELECT id, s2_id FROM papers WHERE s2_id IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()
    return {r['s2_id']: r['id'] for r in rows}


class BulkPaperIds(Module):
    name        = 'bulk_paper_ids'
    description = 'Stream S2 paper-ids dataset to build corpusid → paper_id scratch map'

    requires    = {'papers.s2_id'}
    # Nothing into the cache — output is the scratch file consumed by
    # bulk_abstracts / bulk_papers. Declared as a special pseudo-output so
    # downstream modules can express the dependency in their `requires`.
    produces    = {'scratch:corpusid_map'}
    eventually  = set()
    # Bulk runs claim the named S2 datasets resource so it can't run in
    # parallel with the live S2 producer.
    resources   = {'s2_datasets_api'}

    def validate(self, ctx):
        # Need an S2 API key for the datasets endpoint
        from ..clients.s2_bulk import _get_api_key
        if not _get_api_key():
            return ValidationResult(ok=False, missing=['s2_api_key'],
                                    message='semantic_scholar_key not set')
        # Need at least some s2_id rows to make the map useful
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute(
                "SELECT 1 FROM papers WHERE s2_id IS NOT NULL LIMIT 1"
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['papers.s2_id'],
                                    message='No papers with S2 IDs to map')
        return ValidationResult(ok=True)

    def run(self, ctx) -> ModuleResult:
        from ..clients.s2_bulk import S2BulkClient, iter_jsonl_gz_file
        from ._bulk_common import bulk_cache_dir, filename_for_url

        release_id = ctx.config.get('bulk_release_id')
        verbose    = ctx.config.get('verbose', False)

        client = S2BulkClient()
        if not release_id:
            release_id = client.latest_release()
            if not release_id:
                return ModuleResult(status='failed',
                                    message='Could not fetch release list from S2')
        print(f"  bulk_paper_ids: release={release_id}")

        s2id_to_pid = _load_s2id_to_pid(ctx)
        print(f"  Loaded {len(s2id_to_pid):,} s2_id → pid pairs from v3 DB")

        descriptor = client.dataset_files(release_id, 'paper-ids')
        if not descriptor:
            return ModuleResult(status='failed',
                                message=f"Could not fetch paper-ids descriptor for {release_id}")
        files = descriptor.get('files') or []
        if not files:
            return ModuleResult(status='failed',
                                message='paper-ids descriptor returned no files')
        print(f"  paper-ids: {len(files)} files")

        cache_dir = bulk_cache_dir(release_id, 'paper-ids')
        print(f"  cache: {cache_dir}")

        corpusid_to_pid: dict[int, int] = {}
        n_records = 0
        n_matched = 0
        n_alias_skipped = 0
        n_bytes_downloaded = 0
        t_start = time.time()

        for i, file_url in enumerate(files, 1):
            if ctx.shutdown.requested:
                print(f"  [shutdown] aborting at file {i}/{len(files)}")
                break
            local_name = filename_for_url(file_url, i)
            local_path = cache_dir / local_name
            print(f"  [file {i:>2}/{len(files)}] {local_name}")

            t_dl = time.time()
            written = client.download_file(file_url, local_path)
            if written:
                dt_dl = time.time() - t_dl
                mb = written / (1024 * 1024)
                rate = mb / max(dt_dl, 0.001)
                print(f"    downloaded {mb:.1f} MB in {dt_dl:.1f}s "
                      f"({rate:.1f} MB/s)")
                n_bytes_downloaded += written
            else:
                print(f"    cached {local_path.stat().st_size / (1024*1024):.1f} MB")

            t_proc = time.time()
            n_file = 0
            for record in iter_jsonl_gz_file(local_path):
                n_records += 1
                n_file += 1
                if not record.get('primary', True):
                    n_alias_skipped += 1
                    continue
                sha = record.get('sha')
                if not sha:
                    continue
                pid = s2id_to_pid.get(sha)
                if pid is None:
                    continue
                cid = record.get('corpusid')
                if cid is None:
                    continue
                corpusid_to_pid[cid] = pid
                n_matched += 1
                if verbose and n_matched % 100_000 == 0:
                    rate = n_records / max(time.time() - t_start, 0.001)
                    print(f"    [{n_records:>12,} rec  {n_matched:>10,} match  "
                          f"{rate:>8,.0f} rec/s]")
            dt = time.time() - t_proc
            print(f"    file done: {n_file:,} rec in {dt:.1f}s "
                  f"({n_file / max(dt, 0.001):.0f}/s)")

        out_path = corpusid_map_path(ctx.work_dir)
        _scratch_dir(ctx)
        tmp = out_path.with_suffix('.tsv.tmp')
        with open(tmp, 'w') as f:
            f.write(f"{release_id}\t{len(corpusid_to_pid)}\n")
            for cid, pid in corpusid_to_pid.items():
                f.write(f"{cid}\t{pid}\n")
        os.replace(tmp, out_path)

        elapsed = time.time() - t_start
        print(f"  Done. {n_matched:,} matches from {n_records:,} records "
              f"in {elapsed:.0f}s")
        print(f"  Wrote {out_path}")

        return ModuleResult(
            status='success' if n_matched else 'noop',
            message=(f"{n_matched:,} corpusid → pid pairs written to "
                     f"{out_path.name} (release {release_id})"),
            stats={
                'release_id':         release_id,
                'records_scanned':    n_records,
                'matched':            n_matched,
                'alias_skipped':      n_alias_skipped,
                'files_processed':    len(files),
                'bytes_downloaded':   n_bytes_downloaded,
                'elapsed_s':          round(elapsed, 1),
            },
        )
