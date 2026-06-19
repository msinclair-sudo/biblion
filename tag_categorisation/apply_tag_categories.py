#!/usr/bin/env python3
"""One-off backfill: write tag categories from tag_categories.tsv into each
dataset's live paper_tags.category column.

Read the reviewed TSV (tag<TAB>category<TAB>datasets<TAB>note), then for every
live dataset DB: back it up, ensure the `category` column exists, and UPDATE the
category of each categorised tag. Rows with a blank category are skipped (they
stay NULL = uncategorised). Idempotent — safe to edit the TSV and re-run.

Run from the repo root:  python tag_categorisation/apply_tag_categories.py
Stop any running network_toy serve.py first (it shares the live DB's WAL lock;
the busy_timeout below tolerates a brief wait but not a long-held write).
"""
import csv
import shutil
import sqlite3
import sys
from collections import Counter
from pathlib import Path

from biblion.db import _migrate_paper_tags_columns

ROOT = Path(__file__).resolve().parents[1]
TSV = Path(__file__).resolve().parent / "tag_categories.tsv"
DATASETS = ["fallworm", "microalgae", "PhD_proposal"]
VALID = {"species", "gene", "method", "theme"}


def load_mapping():
    """{tag: category} for rows with a non-empty, valid category."""
    mapping = {}
    with TSV.open(encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        header = next(reader, None)
        for row in reader:
            if len(row) < 2:
                continue
            tag, cat = row[0], row[1].strip()
            if not cat:
                continue
            if cat not in VALID:
                sys.exit(f"invalid category {cat!r} for tag {tag!r} "
                         f"(allowed: {sorted(VALID)})")
            mapping[tag] = cat
    return mapping


def apply_to_db(path: Path, mapping: dict) -> Counter:
    """Back up, migrate the column if needed, UPDATE each tag. Returns the
    post-apply distinct-tag count per category (incl. '(none)')."""
    backup = path.with_suffix(path.suffix + ".bak")
    shutil.copy2(path, backup)
    conn = sqlite3.connect(str(path), timeout=30)
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        _migrate_paper_tags_columns(conn)   # adds `category` to pre-feature DBs
        with conn:
            for tag, cat in mapping.items():
                conn.execute(
                    "UPDATE paper_tags SET category = ? WHERE tag = ?",
                    (cat, tag))
        counts = Counter()
        for cat, n in conn.execute(
            "SELECT COALESCE(NULLIF(category,''),'(none)') AS c, "
            "COUNT(DISTINCT tag) FROM paper_tags GROUP BY c"):
            counts[cat] = n
        return counts
    finally:
        conn.close()


def main():
    if not TSV.exists():
        sys.exit(f"missing {TSV}")
    mapping = load_mapping()
    print(f"loaded {len(mapping)} categorised tags from {TSV.name}\n")
    for ds in DATASETS:
        path = ROOT / "data" / ds / f"{ds}.db"
        if not path.exists():
            print(f"{ds:14} SKIP (no live DB at {path})")
            continue
        counts = apply_to_db(path, mapping)
        summary = ", ".join(f"{k}={counts[k]}" for k in
                            ["species", "gene", "method", "theme", "(none)"]
                            if counts.get(k))
        print(f"{ds:14} {summary}   (backup: {path.name}.bak)")


if __name__ == "__main__":
    main()
