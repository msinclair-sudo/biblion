"""
enrich — the read-once / compute / dumb-write pipeline (enrich redesign).

Components land here phase by phase:
  reader.py      one read-once scan over the dirty set -> WorkItems (bitmap +
                 attempted matrix + needs) and cross-identifier dedup clusters.
  shadow.py      shadow-mode comparators that assert the new path matches the
                 old (needs vs CANDIDATE_QUERIES, routing vs current modules).

Later phases add catalogue / solver / dispatcher / handlers / dedup / compaction.
Until cutover everything here runs read-only and in shadow.
"""
