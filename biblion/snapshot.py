"""
biblion -> network-toy snapshot (step 1 of 2).

Snapshots a live biblion DB into a read-only bundle the network-toy viewer
consumes, then derives the canonical node set from that snapshot. Produced
alongside the source DB (default out dir = the DB's parent), so a project at
`data/<name>/<name>.db` gets its snapshot at `data/<name>/<name>_snapshot.db`:

  <out>/
    <stem>_snapshot.db   clean read-snapshot (WAL flushed). The toy queries
                         THIS at runtime via sql.js. Only the DB carries the
                         `_snapshot` suffix the toy guards on, so the live
                         <stem>.db / <stem>_claims.db can never be attached.
    paper_index.json     {"0": <papers.id>, ...} -- the canonical row->id map.
    nodes.jsonl          {"row","id","title","abstract","year"} per node, in
                         order -- the input to embed_specter2 (step 2).
    manifest.json        dataset metadata + node-set SQL + counts (the embed
                         step fills in model/dim).

Why snapshot first: the snapshot DB, embeddings.npy and paper_index.json must
all be derived from identical bytes so `ORDER BY id` lines up across them. We
copy the live DB via the online-backup API, then query the COPY -- never the
live (possibly mid-write) DB.

The node-set query below is the one hard invariant of the whole ingest and
lives here only -- the toy's datasource/sqlite.js re-runs the same filter and
FAILS LOUD if the DB has drifted from the embedding.
"""
import json
import sqlite3
from pathlib import Path

# Canonical node-set definition. This single query defines BOTH which papers
# become nodes (the filter) and the canonical 0..n-1 order (ORDER BY id).
#   is_rejected = 0  -> drop filtered-out works
#   is_stub     = 0  -> only enriched rows (a stub has no usable metadata)
#   title/abstract NOT NULL -> every node has full text for SPECTER2
#       (title [SEP] abstract) and labelling. Requiring the abstract is a
#       deliberate quality choice; it costs citation edges whose endpoint
#       lacks an abstract.
NODE_SET_WHERE = (
    "is_rejected = 0 AND is_stub = 0 "
    "AND title IS NOT NULL AND abstract IS NOT NULL"
)

NODE_SET_QUERY = f"""
SELECT id, title, abstract, year, authors, venue
FROM papers
WHERE {NODE_SET_WHERE}
ORDER BY id
"""

NODE_IDS_QUERY = f"SELECT id FROM papers WHERE {NODE_SET_WHERE} ORDER BY id"


def _snapshot_db(src: Path, dst: Path) -> None:
    """Copy src -> dst via the SQLite online-backup API (flushes WAL into a
    single self-contained file; safe to run while the writer is active)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        dst_conn = sqlite3.connect(str(dst))
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()
    # Fold any -wal/-shm a fresh connection might leave behind, so the toy gets
    # one self-contained file.
    with sqlite3.connect(str(dst)) as d:
        d.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        d.execute("PRAGMA journal_mode=DELETE")


def _edge_survival(conn: sqlite3.Connection) -> dict:
    """How many citation edges have BOTH endpoints in the node set."""
    conn.execute("DROP TABLE IF EXISTS _nset")
    conn.execute(f"CREATE TEMP TABLE _nset AS SELECT id FROM papers WHERE {NODE_SET_WHERE}")
    total = conn.execute("SELECT COUNT(*) FROM citations").fetchone()[0]
    surviving = conn.execute(
        "SELECT COUNT(*) FROM citations "
        "WHERE citing_id IN (SELECT id FROM _nset) "
        "AND cited_id IN (SELECT id FROM _nset)"
    ).fetchone()[0]
    return {"edges_total": total, "edges_surviving": surviving}


def run_snapshot(db_path: Path, dataset: str | None = None,
                 out_dir: Path | None = None) -> dict:
    """Build the snapshot bundle from a live biblion DB.

    db_path : the live DB to snapshot.
    dataset : logical name (default: DB filename stem); recorded in the manifest.
    out_dir : where the bundle is written (default: the DB's parent dir, i.e.
              right next to it).

    Returns the manifest dict. Raises ValueError if the node set is empty.
    """
    src = Path(db_path).expanduser().resolve()
    if not src.exists():
        raise FileNotFoundError(f"db not found: {src}")

    dataset = dataset or src.stem
    out = Path(out_dir).expanduser().resolve() if out_dir else src.parent
    out.mkdir(parents=True, exist_ok=True)

    snapshot = out / f"{src.stem}_snapshot.db"
    index_path = out / "paper_index.json"
    jsonl_path = out / "nodes.jsonl"
    manifest_path = out / "manifest.json"

    print(f"[snapshot] {src}\n        -> {snapshot}")
    _snapshot_db(src, snapshot)

    # Everything below queries the SNAPSHOT, not the live DB.
    conn = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(NODE_SET_QUERY).fetchall()
        n = len(rows)
        if n == 0:
            raise ValueError("node set is empty -- check the filter / db")

        paper_index = {}
        with open(jsonl_path, "w", encoding="utf-8") as jf:
            for i, r in enumerate(rows):
                paper_index[str(i)] = r["id"]
                jf.write(json.dumps({
                    "row": i,
                    "id": r["id"],
                    "title": r["title"] or "",
                    "abstract": r["abstract"] or "",
                    "year": r["year"],
                }, ensure_ascii=False) + "\n")
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(paper_index, f)

        edges = _edge_survival(conn)
        years = conn.execute(
            f"SELECT COUNT(*) n, SUM(year IS NULL) ynull, MIN(year) mn, MAX(year) mx "
            f"FROM papers WHERE {NODE_SET_WHERE}"
        ).fetchone()
    finally:
        conn.close()

    manifest = {
        "dataset": dataset,
        "source_db": src.name,
        "snapshot_db": snapshot.name,
        "n_nodes": n,
        "node_set_where": NODE_SET_WHERE,
        "node_order": "ORDER BY id",
        "edges_total": edges["edges_total"],
        "edges_surviving": edges["edges_surviving"],
        "edge_survival_pct": round(100 * edges["edges_surviving"] / edges["edges_total"], 1)
        if edges["edges_total"] else None,
        "year_range": [years["mn"], years["mx"]],
        "year_null": years["ynull"],
        # the embed step fills these in:
        "embedding_model": None,
        "embedding_adapter": None,
        "embedding_dim": None,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    surv = manifest["edge_survival_pct"]
    print(f"[snapshot] nodes={n}  edges {edges['edges_surviving']}/{edges['edges_total']} "
          f"({surv}% survive node filter)  years {years['mn']}..{years['mx']}")
    print(f"[snapshot] wrote:\n  {snapshot}\n  {index_path}\n  {jsonl_path}\n  {manifest_path}")
    print(f"[snapshot] next: biblion advanced embedding --dataset {dataset}")
    return manifest
