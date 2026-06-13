"""
materialize_ghost_stubs — turn frequent pending-citation endpoints into stub
papers so their edges become real.

`pending_citations` parks every edge whose endpoint isn't a papers row yet. Most
of those endpoints are external papers (no metadata) that several in-corpus
papers cite or are cited by — real, shared reference points whose only lack is
metadata. This module finds the external endpoints referenced by at least
`min_degree` distinct in-corpus nodes and pushes an identifier-only PaperRecord
for each. The merge writer then creates them as is_stub=1 rows, the Resolver
dedups identifiers like any paper, and the PendingResolver promotes the now-
resolvable pending edges to real citations — no merge-side code needed here.

It makes NO network calls: it reads the DB read-only and pushes stubs to the
cache like any other producer. A degree-1 endpoint (cited by exactly one
in-corpus paper) is a pendant that adds no inter-paper structure, so the default
threshold is 2; pass min_degree=1 to materialize everything.
"""
from ..cache.records import PaperRecord
from ..framework import Module, ModuleResult, ValidationResult

_SOURCE = 'ghost_stub'
_PUSH_BATCH = 1000

# In-corpus = a paper that passes the snapshot node-set filter (has full text).
# Mirrors biblion/snapshot.py NODE_SET_WHERE.
_NODE_SET_WHERE = ("is_rejected = 0 AND is_stub = 0 "
                   "AND title IS NOT NULL AND abstract IS NOT NULL")


class MaterializeGhostStubs(Module):
    name        = 'materialize_ghost_stubs'
    description = 'Promote frequent pending-citation endpoints to stub papers'

    requires    = {'pending_citations.discovered_at'}
    produces    = {'cache:papers'}
    eventually  = {'papers.is_stub', 'citations.citing_id', 'citations.cited_id'}
    resources   = set()   # no API; reads DB read-only, pushes to cache

    DEFAULT_MIN_DEGREE = 2

    def validate(self, ctx):
        if ctx.cache is None or not ctx.cache.ping():
            return ValidationResult(ok=False, missing=['redis:cache'])
        conn = ctx.connect(readonly=True)
        try:
            row = conn.execute("SELECT 1 FROM pending_citations LIMIT 1").fetchone()
        finally:
            conn.close()
        if not row:
            return ValidationResult(ok=False, missing=['pending_citations'],
                                    message='No pending citations to materialize')
        return ValidationResult(ok=True)

    def run(self, ctx):
        min_degree = ctx.config.get('ghost_min_degree')
        min_degree = max(1, int(min_degree if min_degree is not None
                                else self.DEFAULT_MIN_DEGREE))

        conn = ctx.connect(readonly=True)
        try:
            # identifier -> paper_id for ALL papers (existence test), plus the
            # set of in-corpus node ids. An endpoint is a "ghost" only when none
            # of its identifiers resolve to ANY papers row.
            id_to_pid = {}
            for pid, doi, s2, oa in conn.execute(
                    "SELECT id, doi, s2_id, oa_id FROM papers"):
                if doi: id_to_pid[('doi', doi)] = pid
                if s2:  id_to_pid[('s2', s2)]   = pid
                if oa:  id_to_pid[('oa', oa)]   = pid
            node_ids = {r[0] for r in conn.execute(
                f"SELECT id FROM papers WHERE {_NODE_SET_WHERE}")}

            def resolve(doi, s2, oa):
                """Return (existing_paper_id_or_None, ghost_key_or_None).
                ghost_key is set only when the endpoint resolves to NO paper."""
                for key in (('doi', doi), ('s2', s2), ('oa', oa)):
                    if key[1] and key in id_to_pid:
                        return id_to_pid[key], None
                gk = (('doi', doi) if doi else ('s2', s2) if s2
                      else ('oa', oa) if oa else None)
                return None, gk

            # ghost_key -> {'nb': set(node_id), 'doi', 's2', 'oa'}
            ghosts = {}
            scanned = 0
            for row in conn.execute(
                    "SELECT citing_doi, citing_s2_id, citing_oa_id, "
                    "cited_doi, cited_s2_id, cited_oa_id FROM pending_citations"):
                scanned += 1
                c_pid, c_ghost = resolve(row[0], row[1], row[2])
                d_pid, d_ghost = resolve(row[3], row[4], row[5])
                # Keep only edges with exactly one in-corpus node and the other
                # endpoint a true ghost. (Both-ghost, both-in-corpus, and
                # exists-but-not-a-node cases are out of scope.)
                if c_pid in node_ids and d_ghost is not None:
                    node, gk, ids = c_pid, d_ghost, (row[3], row[4], row[5])
                elif d_pid in node_ids and c_ghost is not None:
                    node, gk, ids = d_pid, c_ghost, (row[0], row[1], row[2])
                else:
                    continue
                g = ghosts.get(gk)
                if g is None:
                    g = ghosts[gk] = {'nb': set(), 'doi': None, 's2': None, 'oa': None}
                g['nb'].add(node)
                if ids[0]: g['doi'] = ids[0]
                if ids[1]: g['s2'] = ids[1]
                if ids[2]: g['oa'] = ids[2]
        finally:
            conn.close()

        kept = [g for g in ghosts.values() if len(g['nb']) >= min_degree]
        dropped = len(ghosts) - len(kept)

        pushed = 0
        batch = []
        for g in kept:
            if ctx.shutdown.requested:
                break
            batch.append(PaperRecord(source=_SOURCE, doi=g['doi'],
                                     s2_id=g['s2'], oa_id=g['oa']))
            if len(batch) >= _PUSH_BATCH:
                pushed += ctx.cache.push_papers(batch)
                batch = []
        if batch:
            pushed += ctx.cache.push_papers(batch)

        stats = {
            'pending_scanned': scanned,
            'ghosts_found':    len(ghosts),
            'ghosts_kept':     len(kept),
            'ghosts_dropped_below_min_degree': dropped,
            'stubs_pushed':    pushed,
            'min_degree':      min_degree,
        }
        msg = (f"{pushed:,} ghost stubs pushed (degree>={min_degree}); "
               f"{dropped:,} ghosts dropped below threshold; "
               f"{scanned:,} pending rows scanned")
        print(f"  materialize_ghost_stubs: {msg}")
        return ModuleResult(status='success' if pushed else 'noop',
                            message=msg, stats=stats)
