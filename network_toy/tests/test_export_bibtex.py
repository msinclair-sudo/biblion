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


def test_tags_drive_colour_mode_and_bib_keywords(page):
    """Tagging a paper (via setTagsFromDb, no network) exposes the 'tag' colour
    mode, colours tagged vs untagged nodes distinctly, and surfaces in the .bib
    keywords field. Uses the live fallworm corpus for node→paperId mapping."""
    out = page.evaluate(r'''async () => {
        const sq    = await import("/app/src/datasource/sqlite.js");
        const state = await import("/app/src/ui/state.js");
        const cm    = await import("/app/src/ui/viewer-shared/colour-modes.js");
        const bib   = await import("/app/src/export/bibtex.js");
        const nodes = (state.getState().genResult || {}).nodes || [];
        const ok = await sq.reconnectSqliteCorpus("fallworm", nodes);
        try {
            if (!ok || !sq.hasSqliteText()) return { sqliteLoaded: false };
            const pid = sq.getIdByRow(0);          // tag node 0's paper
            state.setTagsFromDb({ [pid]: ["to-read"] });
            const s = state.getState();

            const opts = cm.getColourModeOptions(s).map(o => o.value);
            const taggedColour   = cm.baseColourFor({ id: 0 }, s, "tag");
            // find an untagged node (some index whose paperId isn't tagged)
            let untaggedColour = null;
            for (let i = 1; i < nodes.length; i++) {
                if (sq.getIdByRow(i) !== pid) { untaggedColour = cm.baseColourFor({ id: i }, s, "tag"); break; }
            }

            // .bib keywords from the tag
            const rec = sq.getNodeFullRecord(0);
            rec.keywords = s.tags[pid].slice();
            const text = bib.formatBibtex([rec], [null]);

            return {
                sqliteLoaded: true,
                hasTagOption: opts.includes("tag"),
                taggedIsPalette: taggedColour !== cm.DIMMED_COLOUR && taggedColour !== cm.UNKNOWN_COLOUR,
                untaggedIsDimmed: untaggedColour === cm.DIMMED_COLOUR,
                tagsSig: cm.tagsSignature(s),
                hasKeywords: /keywords\s+= \{to-read\}/.test(text),
            };
        } finally {
            state.setTagsFromDb({});      // reset shared session state
            sq.clearSqliteCorpus();
        }
    }''')
    assert out["sqliteLoaded"] is True
    assert out["hasTagOption"] is True
    assert out["taggedIsPalette"] is True
    assert out["untaggedIsDimmed"] is True
    assert out["tagsSig"] == "1:1"
    assert out["hasKeywords"] is True
