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

# Structural mode (--include-structural, spec §3): drop the is_stub=0 AND
# abstract-NOT-NULL requirement so externally-cited "ghost" endpoints become
# nodes too. A node is `structural` (no SPECTER2 row) when it is a stub or
# lacks an abstract -- exactly the rows the default filter excludes. We emit
# embedded nodes (those that pass NODE_SET_WHERE) first and structural nodes
# last so embeddings.npy stays a contiguous m*d block (rows >= m are ghosts).
STRUCTURAL_SET_WHERE = "is_rejected = 0 AND title IS NOT NULL"
STRUCTURAL_FLAG_EXPR = "(is_stub = 1 OR abstract IS NULL)"

NODE_SET_QUERY = f"""
SELECT id, title, abstract, year, authors, venue
FROM papers
WHERE {NODE_SET_WHERE}
ORDER BY id
"""

# Embedded-first, structural-last ordering. The CASE key keeps the two blocks
# contiguous; id is the canonical tiebreak within each block.
STRUCTURAL_SET_QUERY = f"""
SELECT id, title, abstract, year, authors, venue, {STRUCTURAL_FLAG_EXPR} AS structural
FROM papers
WHERE {STRUCTURAL_SET_WHERE}
ORDER BY {STRUCTURAL_FLAG_EXPR}, id
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
    # one self-contained file. NB: a sqlite3 connection used as a context manager
    # commits the transaction but does NOT close the connection — close it
    # explicitly or it leaks (a GC-time ResourceWarning, fatal under -W error).
    d = sqlite3.connect(str(dst))
    try:
        d.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        d.execute("PRAGMA journal_mode=DELETE")
    finally:
        d.close()


def _edge_survival(conn: sqlite3.Connection, where: str = NODE_SET_WHERE) -> dict:
    """How many citation edges have BOTH endpoints in the node set."""
    conn.execute("DROP TABLE IF EXISTS _nset")
    conn.execute(f"CREATE TEMP TABLE _nset AS SELECT id FROM papers WHERE {where}")
    total = conn.execute("SELECT COUNT(*) FROM citations").fetchone()[0]
    surviving = conn.execute(
        "SELECT COUNT(*) FROM citations "
        "WHERE citing_id IN (SELECT id FROM _nset) "
        "AND cited_id IN (SELECT id FROM _nset)"
    ).fetchone()[0]
    return {"edges_total": total, "edges_surviving": surviving}


def run_snapshot(db_path: Path, dataset: str | None = None,
                 out_dir: Path | None = None,
                 include_structural: bool = False) -> dict:
    """Build the snapshot bundle from a live biblion DB.

    db_path : the live DB to snapshot.
    dataset : logical name (default: DB filename stem); recorded in the manifest.
    out_dir : where the bundle is written (default: the DB's parent dir, i.e.
              right next to it).
    include_structural : spec §3. When True the node set is widened to
              `is_rejected=0 AND title IS NOT NULL` (stubs / abstract-less rows
              included). Embedded nodes are emitted first (rows 0..m-1) and
              structural nodes last (m..n-1) so embeddings.npy stays a
              contiguous m*d block; every node row carries a `structural` flag.
              When False, behaviour is byte-for-byte identical to before.

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
    node_where = STRUCTURAL_SET_WHERE if include_structural else NODE_SET_WHERE
    node_query = STRUCTURAL_SET_QUERY if include_structural else NODE_SET_QUERY
    node_order = ("ORDER BY (is_stub=1 OR abstract IS NULL), id"
                  if include_structural else "ORDER BY id")

    conn = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(node_query).fetchall()
        n = len(rows)
        if n == 0:
            raise ValueError("node set is empty -- check the filter / db")

        n_structural = 0
        paper_index = {}
        with open(jsonl_path, "w", encoding="utf-8") as jf:
            for i, r in enumerate(rows):
                paper_index[str(i)] = r["id"]
                node = {
                    "row": i,
                    "id": r["id"],
                    "title": r["title"] or "",
                    "abstract": r["abstract"] or "",
                    "year": r["year"],
                }
                if include_structural:
                    structural = bool(r["structural"])
                    n_structural += structural
                    node["structural"] = structural
                jf.write(json.dumps(node, ensure_ascii=False) + "\n")
        with open(index_path, "w", encoding="utf-8") as f:
            # In structural mode the index carries the per-row flag so the embed
            # step / toy can tell which rows have no embedding (rows >= m).
            if include_structural:
                json.dump({k: {"id": v, "structural": bool(rows[int(k)]["structural"])}
                           for k, v in paper_index.items()}, f)
            else:
                json.dump(paper_index, f)

        edges = _edge_survival(conn, node_where)
        years = conn.execute(
            f"SELECT COUNT(*) n, SUM(year IS NULL) ynull, MIN(year) mn, MAX(year) mx "
            f"FROM papers WHERE {node_where}"
        ).fetchone()
    finally:
        conn.close()

    n_embedded = n - n_structural

    manifest = {
        "dataset": dataset,
        "source_db": src.name,
        "snapshot_db": snapshot.name,
        "n_nodes": n,
        "node_set_where": node_where,
        "node_order": node_order,
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
    if include_structural:
        manifest["include_structural"] = True
        manifest["n_structural"] = n_structural
        manifest["n_embedded"] = n_embedded
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    surv = manifest["edge_survival_pct"]
    print(f"[snapshot] nodes={n}  edges {edges['edges_surviving']}/{edges['edges_total']} "
          f"({surv}% survive node filter)  years {years['mn']}..{years['mx']}")
    if include_structural:
        print(f"[snapshot] structural mode: {n_embedded} embedded + "
              f"{n_structural} structural (ghost) nodes")
    print(f"[snapshot] wrote:\n  {snapshot}\n  {index_path}\n  {jsonl_path}\n  {manifest_path}")
    print(f"[snapshot] next: biblion advanced embedding --dataset {dataset}")
    return manifest


# ---------------------------------------------------------------------------
# Named subsets — a slim, embeddable-only slice of a project, sharing the
# project's snapshot DB. Layout: <project_dir>/subsets/<name>/{paper_index.json,
# nodes.jsonl, manifest.json, embeddings.npy (after `embedding --subset`)}.
# The toy reads the shared <project>_snapshot.db for metadata + edges and the
# subset's paper_index/embeddings for the node set + vectors.
# ---------------------------------------------------------------------------

def build_subset(snapshot_db: Path, name: str, where: str, params: tuple,
                 project_dir: Path, dataset: str, label: str | None = None) -> dict:
    """Carve a named subset from a project's snapshot DB.

    snapshot_db : the project's `<project>_snapshot.db` (must already exist).
    name        : subset name (becomes subsets/<name>/).
    where, params : the selector, ANDed with the embeddable node-set filter.
    project_dir : where subsets/ lives (the snapshot DB's parent).
    Returns the subset manifest. Raises if the snapshot is missing / subset empty.
    """
    snap = Path(snapshot_db)
    if not snap.exists():
        raise FileNotFoundError(
            f"project snapshot not found: {snap} (run `biblion advanced snapshot` first)")

    out = Path(project_dir) / "subsets" / name
    out.mkdir(parents=True, exist_ok=True)
    index_path = out / "paper_index.json"
    jsonl_path = out / "nodes.jsonl"
    manifest_path = out / "manifest.json"

    query = (f"SELECT id, title, abstract, year FROM papers "
             f"WHERE {NODE_SET_WHERE} AND ({where}) ORDER BY id")
    conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()
    n = len(rows)
    if n == 0:
        raise ValueError(f"subset {name!r} is empty -- check the selector")

    # If the project has a master embedding, carve the subset's vectors straight
    # out of it (SPECTER2 is set-independent, so the rows are byte-identical to a
    # re-embed -- no GPU). `present` keep their master order-by-id; `absent` ids
    # (not in the master) drop to structural rows with no embedding, mirroring the
    # `snapshot --include-structural` layout the toy already understands.
    pdir = Path(project_dir)
    sliced = _slice_master_for_subset(pdir, rows, out / "embeddings.npy")

    if sliced is not None:
        present, absent, d, embed_meta = sliced
        ordered = present + absent
        n_embedded = len(present)
    else:
        ordered = rows
        absent = []
        d = None
        embed_meta = {}
        n_embedded = n
    structural_mode = bool(absent)

    paper_index = {}
    with open(jsonl_path, "w", encoding="utf-8") as jf:
        for i, r in enumerate(ordered):
            paper_index[str(i)] = r["id"]
            node = {
                "row": i, "id": r["id"],
                "title": r["title"] or "", "abstract": r["abstract"] or "",
                "year": r["year"],
            }
            if structural_mode:
                node["structural"] = i >= n_embedded
            jf.write(json.dumps(node, ensure_ascii=False) + "\n")
    with open(index_path, "w", encoding="utf-8") as f:
        if structural_mode:
            json.dump({k: {"id": v, "structural": int(k) >= n_embedded}
                       for k, v in paper_index.items()}, f)
        else:
            json.dump(paper_index, f)

    manifest = {
        "subset": name,
        "label": label or name,
        "dataset": dataset,
        "snapshot_db": snap.name,          # shared project DB, sibling of subsets/
        "n_nodes": n,
        "selector": where,
        "selector_params": list(params),
        # filled from the master when we sliced, else by a later embed step:
        "embedding_model": embed_meta.get("embedding_model"),
        "embedding_adapter": embed_meta.get("embedding_adapter"),
        "embedding_dim": d,
    }
    for k in ("embedding_normalized", "embedding_domain"):
        if k in embed_meta:
            manifest[k] = embed_meta[k]
    if structural_mode:
        manifest["include_structural"] = True
        manifest["n_embedded"] = n_embedded
        manifest["n_structural"] = len(absent)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    write_subset_index(project_dir)
    print(f"[subset] {name}: {n} nodes  ->  {out}")
    if sliced is not None:
        if absent:
            print(f"[subset] sliced master: {n_embedded} embedded + {len(absent)} "
                  f"structural (ids absent from master)")
        else:
            print(f"[subset] sliced {n_embedded} rows from project master (no re-embed)")
    else:
        print(f"[subset] next: biblion advanced embedding --subset {name}")
    return manifest


def _slice_master_for_subset(project_dir: Path, rows, dst):
    """Carve `dst` (subset embeddings.npy) from the project master if present.

    Returns (present_rows, absent_rows, dim, embed_meta) where present_rows are the
    subset rows found in the master (their vectors written to `dst`, in this order)
    and absent_rows are subset ids not embedded in the master. Returns None when no
    master embedding exists (caller falls back to a node-set-only subset)."""
    master_npy = project_dir / "embeddings.npy"
    master_index = project_dir / "paper_index.json"
    if not (master_npy.exists() and master_index.exists()):
        return None
    from . import npy_slice

    id_to_row = {}
    for k, v in json.loads(master_index.read_text()).items():
        if isinstance(v, dict):
            if v.get("structural"):
                continue          # structural master rows have no embedding
            pid = v.get("id")
        else:
            pid = v
        id_to_row[pid] = int(k)

    m, d, _dtype, _off = npy_slice.read_npy_header(master_npy)
    present, present_master_rows, absent = [], [], []
    for r in rows:
        mr = id_to_row.get(r["id"])
        if mr is not None and mr < m:
            present.append(r)
            present_master_rows.append(mr)
        else:
            absent.append(r)
    npy_slice.slice_npy_rows(master_npy, present_master_rows, dst)

    embed_meta = {}
    master_manifest = project_dir / "manifest.json"
    if master_manifest.exists():
        mm = json.loads(master_manifest.read_text())
        for k in ("embedding_model", "embedding_adapter", "embedding_normalized",
                  "embedding_domain"):
            if mm.get(k) is not None:
                embed_meta[k] = mm[k]
    return present, absent, d, embed_meta


def write_subset_index(project_dir: Path) -> None:
    """Rebuild <project_dir>/subsets/index.json from each subset's manifest.
    The toy fetches this to list the subsets available for a project."""
    subsets_dir = Path(project_dir) / "subsets"
    if not subsets_dir.is_dir():
        return
    entries = []
    for man in sorted(subsets_dir.glob("*/manifest.json")):
        try:
            m = json.loads(man.read_text())
        except (OSError, ValueError):
            continue
        entries.append({
            "name": m.get("subset", man.parent.name),
            "label": m.get("label", man.parent.name),
            "n_nodes": m.get("n_nodes"),
            "selector": m.get("selector"),
            "embedded": (man.parent / "embeddings.npy").exists(),
        })
    with open(subsets_dir / "index.json", "w", encoding="utf-8") as f:
        json.dump({"subsets": entries}, f, indent=2)
