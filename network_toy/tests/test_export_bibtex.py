"""Browser test for the cart's BibTeX export against the LIVE snapshot DB.

The pure formatter (bibtex.js) is covered by tests/unit/export-bibtex.test.mjs.
What needs a browser is the data path: getNodeFullRecord reading the connected
sql.js corpus and feeding formatBibtex. The rehydrated `page` fixture skips the
DB reconnect (conftest._rehydrate), so we reconnect the fallworm snapshot
ourselves, exercise the export, then drop the corpus to leave the shared session
page as we found it.
"""


def test_full_record_and_bibtex_from_live_corpus(page):
    """getNodeFullRecord pulls enriched fields from the connected DB, and
    formatBibtex turns them into a valid .bib (one @entry per record, with the
    cart provenance carried in `note`)."""
    out = page.evaluate(r'''async () => {
        const sq    = await import("/app/src/datasource/sqlite.js");
        const state = await import("/app/src/ui/state.js");
        const bib   = await import("/app/src/export/bibtex.js");
        const nodes = (state.getState().genResult || {}).nodes || [];
        const ok = await sq.reconnectSqliteCorpus("fallworm", nodes);
        try {
            if (!ok || !sq.hasSqliteText()) return { sqliteLoaded: false };
            const recs = [];
            for (let i = 0; i < 4; i++) {
                const r = sq.getNodeFullRecord(i);
                if (r) recs.push(r);
            }
            const notes = recs.map((_, i) => "cart-row-" + i);
            const text = bib.formatBibtex(recs, notes);
            const first = recs[0] || {};
            return {
                sqliteLoaded: true,
                n: recs.length,
                hasTitle: !!first.title,
                authorsIsArray: Array.isArray(first.authors),
                identifiersIsObject: !!first.identifiers && typeof first.identifiers === "object",
                startsWithEntry: /^@\w+\{/.test(text),
                entryCount: (text.match(/^@\w+\{/gm) || []).length,
                hasNote: /^\s*note\s+= \{cart-row-0\}/m.test(text),
            };
        } finally {
            sq.clearSqliteCorpus();   // leave the session page corpus-free
        }
    }''')
    assert out["sqliteLoaded"] is True
    assert out["n"] >= 1
    assert out["hasTitle"] is True
    assert out["authorsIsArray"] is True
    assert out["identifiersIsObject"] is True
    assert out["startsWithEntry"] is True
    assert out["entryCount"] == out["n"]
    assert out["hasNote"] is True
