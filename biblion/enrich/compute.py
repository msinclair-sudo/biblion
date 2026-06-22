"""
Compute stage (Phase 6) — moves the writer's expensive identifier lookup off the
write path. It pops the raw staged records, runs the same _batch_lookup the
legacy writer used, classifies each (new / single-hit / multi-hit / edge /
pending-edge), and emits pre-resolved write-jobs for the pure writer to apply.

Field resolution itself stays in the writer's reused _insert_new /
_apply_single_hit (cheap, indexed by paper_id) — only the cross-identifier probe
(the bottleneck SELECT) moves here, where it can run read-only and in parallel.

Same-batch / brand-new endpoints can't be given an id yet, so an edge naming one
goes to pending_citations exactly as the legacy writer would (the pending_resolver
promotes it once the endpoint lands) — that's the one intentional ordering
difference, and it converges to the same graph.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from dataclasses import asdict

from ..cache import CacheClient, PaperRecord
from ..cache.records import WritePaperJob, WriteEdgeJob, WritePendingEdgeJob
from ..db import get_connection
from ..merge.aliasmap import AliasMap
from ..merge.writer import _batch_lookup, DEFAULT_BATCH_SIZE
from .dedup import plan_merge, _FIELDS as _MERGE_FIELDS

_log = logging.getLogger(__name__)


class Compute:
    def __init__(self, cache: CacheClient, db_path: Path,
                 batch_size: int = DEFAULT_BATCH_SIZE):
        self.cache = cache
        self.batch_size = batch_size
        self._conn = get_connection(db_path)          # read-only usage
        self._aliases = AliasMap.load(self._conn)
        self._alias_count = self._conn.execute(
            "SELECT COUNT(*) FROM aliases").fetchone()[0]
        self.stats = {'passes': 0, 'paper_jobs': 0, 'edge_jobs': 0,
                      'pending_jobs': 0, 'merge_jobs': 0}

    def close(self) -> None:
        c = getattr(self, '_conn', None)
        if c is not None:
            try:
                c.close()
            except Exception:
                pass
            self._conn = None

    def __del__(self):
        self.close()

    def _refresh_aliases(self) -> None:
        n = self._conn.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
        if n != self._alias_count:
            self._aliases = AliasMap.load(self._conn)
            self._alias_count = n

    def _load_rows(self, ids: list[int]) -> list:
        cols = 'id, ' + ', '.join(_MERGE_FIELDS)
        ph = ', '.join('?' for _ in ids)
        return self._conn.execute(
            f"SELECT {cols} FROM papers WHERE id IN ({ph})", ids).fetchall()

    # -- one pass ----------------------------------------------------------
    def run_pass(self) -> int:
        self.stats['passes'] += 1
        self._refresh_aliases()
        processed = 0
        papers = self.cache.pop_papers_batch(self.batch_size)
        if papers:
            processed += self._compute_papers(papers)
        citations = self.cache.pop_citations_batch(self.batch_size)
        if citations:
            processed += self._compute_citations(citations)
        return processed

    def _compute_papers(self, records: list) -> int:
        hits = _batch_lookup(self._conn, records)
        jobs = []
        for rec, rec_hits in zip(records, hits):
            ids = sorted({self._aliases.find(h.paper_id) for h in rec_hits})
            if not ids:
                jobs.append(WritePaperJob(target_id=None, record=rec.to_json()))
            elif len(ids) == 1:
                jobs.append(WritePaperJob(target_id=ids[0], record=rec.to_json()))
            else:
                plan = plan_merge(self._load_rows(ids))
                jobs.append(WritePaperJob(target_id=plan.winner_id,
                                          record=rec.to_json(), plan=asdict(plan)))
                self.stats['merge_jobs'] += 1
        self.cache.push_write_jobs(jobs)
        self.stats['paper_jobs'] += len(jobs)
        return len(records)

    def _compute_citations(self, records: list) -> int:
        probes = []
        for rec in records:
            probes.append((rec.citing_doi, rec.citing_s2_id, rec.citing_oa_id))
            probes.append((rec.cited_doi, rec.cited_s2_id, rec.cited_oa_id))
        faux = [PaperRecord(source='_cit', doi=d, s2_id=s, oa_id=o)
                for d, s, o in probes]
        hits = _batch_lookup(self._conn, faux)
        jobs = []
        for i, rec in enumerate(records):
            ch, dh = hits[2 * i], hits[2 * i + 1]
            citing = self._aliases.find(ch[0].paper_id) if len(ch) == 1 else None
            cited = self._aliases.find(dh[0].paper_id) if len(dh) == 1 else None
            if citing and cited and citing != cited:
                jobs.append(WriteEdgeJob(citing, cited, rec.source))
                self.stats['edge_jobs'] += 1
            else:
                jobs.append(WritePendingEdgeJob(
                    rec.citing_doi, rec.citing_s2_id, rec.citing_oa_id,
                    rec.cited_doi, rec.cited_s2_id, rec.cited_oa_id, rec.source))
                self.stats['pending_jobs'] += 1
        self.cache.push_write_jobs(jobs)
        return len(records)

    def run(self, idle_sleep: float = 1.0, shutdown=None) -> None:
        import time as _time
        while shutdown is None or not shutdown.requested:
            n = self.run_pass()
            self.cache.beat('compute', self.stats)    # live-dashboard heartbeat
            if n == 0:
                _time.sleep(idle_sleep)


def main():
    import argparse
    from ..db import get_db_path
    from ..runtime import ShutdownFlag

    p = argparse.ArgumentParser(description='Run the enrich compute stage.')
    p.add_argument('--db', type=Path, default=None)
    p.add_argument('--redis-url', default='redis://localhost:6379/0')
    p.add_argument('--batch-size', type=int, default=DEFAULT_BATCH_SIZE)
    p.add_argument('--idle-sleep', type=float, default=1.0)
    args = p.parse_args()
    db_path = args.db or get_db_path()
    cache = CacheClient(url=args.redis_url)
    comp = Compute(cache, db_path, batch_size=args.batch_size)
    flag = ShutdownFlag.install(name='enrich-compute')
    print(f"[compute] db={db_path} redis={args.redis_url}")
    try:
        comp.run(idle_sleep=args.idle_sleep, shutdown=flag)
    finally:
        comp.close()
        print(f"[compute] shutdown. stats={comp.stats}")


if __name__ == '__main__':
    main()
