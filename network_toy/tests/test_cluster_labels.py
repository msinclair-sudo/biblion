"""MLC-4 — multi-method cluster labelling module.

Embedding-based methods (representative paper, year span) work on real data
today; the text methods (c-TF-IDF / TF-IDF) are implemented + tested via an
injected text accessor and gate cleanly with a reason when no titles are
materialised (the toy's real subsets carry paperId + embedding only).
"""

import pytest


def test_label_methods_synthetic(clean_page):
    """c-TF-IDF distinguishes clusters by their characteristic terms,
    representative picks the centroid-nearest paper, year reports the span,
    and `combined` prefers the text label."""
    out = clean_page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        const d = 2;
        const data = Float32Array.from([1,0, 0.9,0.1,  0,1, 0.1,0.9]);
        const cr = { nodeCluster: Int32Array.from([0,0,1,1]), clusters: [{id:0},{id:1}] };
        const texts = {
            0: "graph neural networks for molecules",
            1: "graph neural networks chemistry",
            2: "transformer language models nlp",
            3: "transformer attention language",
        };
        const ctx = {
            embedding: { d, data },
            nodes: [
                {id:0,paperId:"P0",year:2019},{id:1,paperId:"P1",year:2020},
                {id:2,paperId:"P2",year:2021},{id:3,paperId:"P3",year:2022},
            ],
            getText: (id) => texts[id],
        };
        const res = labelClusters(cr, ctx);
        const c0 = res.perCluster[0], c1 = res.perCluster[1];
        return {
            methodsAvail: res.methods.map(m => `${m.id}:${m.available}`),
            c0Terms: c0.byMethod.cTfidf.terms,
            c1Terms: c1.byMethod.cTfidf.terms,
            c0Rep: c0.byMethod.representative.paperId,
            c1Rep: c1.byMethod.representative.paperId,
            c0Combined: c0.combined,
        };
    }''')
    assert out["methodsAvail"] == [
        "representative:true", "year:true", "cTfidf:true", "tfidf:true", "keybert:true",
        "cTfidfStratified:true", "tfidfStratified:true", "keybertStratified:true",
    ]
    assert "graph" in out["c0Terms"] and "transformer" not in out["c0Terms"]
    assert "transformer" in out["c1Terms"]
    assert out["c0Rep"] == "P0"
    assert out["c1Rep"] == "P2"
    # combine() prefers KeyBERT now; both KeyBERT and cTfidf surface "graph".
    assert "graph" in out["c0Combined"]


def test_keybert_diverse_keyphrases(clean_page):
    """KeyBERT-style labels: cluster-distinctive 1–2-gram keyphrases, MMR-
    diversified (no near-duplicate phrases dominating), and available only
    with text. Repeats the discriminating bigram heavily so it ranks."""
    out = clean_page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        const cr = { nodeCluster: Int32Array.from([0,0,0,1,1,1]), clusters: [{id:0},{id:1}] };
        const texts = {
            0: "soil microbial community structure under tillage management practices",
            1: "soil microbial community diversity nitrogen fertilizer treatment effects",
            2: "soil microbial community biomass carbon sequestration cropland soils",
            3: "arbuscular mycorrhizal fungi root colonization phosphorus uptake plants",
            4: "arbuscular mycorrhizal fungi spore density host plant symbiosis",
            5: "arbuscular mycorrhizal fungi hyphal network nutrient transfer roots",
        };
        const ctx = {
            embedding: { d: 1, data: Float32Array.from([0,0,0,1,1,1]) },
            nodes: [0,1,2,3,4,5].map(id => ({ id, paperId: "P"+id })),
            getText: (id) => texts[id],
        };
        const res = labelClusters(cr, ctx, { methods: ["keybert"] });
        const c0 = res.perCluster[0].byMethod.keybert;
        const c1 = res.perCluster[1].byMethod.keybert;
        // unique tokens across picked phrases (diversity check)
        const uniqTokens = (terms) => new Set(terms.join(" ").split(" ")).size;
        return {
            available: res.methods[0].available,
            c0Terms: c0.terms, c1Terms: c1.terms,
            c0HasBigram: c0.terms.some(t => t.includes(" ")),
            c1Distinctive: c1.terms.some(t => t.includes("mycorrhizal")),
            c0NotC1: !c0.terms.some(t => t.includes("mycorrhizal")),
            c0Diverse: uniqTokens(c0.terms) >= c0.terms.length,   // ≥1 unique tok per phrase
        };
    }''')
    assert out["available"] is True
    assert len(out["c0Terms"]) >= 1 and len(out["c1Terms"]) >= 1
    assert out["c0HasBigram"] is True            # bigrams generated
    assert out["c1Distinctive"] is True          # cluster-1 keyphrase is its own topic
    assert out["c0NotC1"] is True                # distinctive, not shared
    assert out["c0Diverse"] is True              # MMR avoided near-duplicate phrases


def test_text_methods_gate_without_titles(clean_page):
    """With no getText accessor the text methods report unavailable with a
    reason, and combined falls back to the representative paper + year."""
    out = clean_page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        const data = Float32Array.from([1,0, 0,1]);
        const cr = { nodeCluster: Int32Array.from([0,1]), clusters: [{id:0},{id:1}] };
        const ctx = { embedding: { d: 2, data }, nodes: [{id:0,paperId:"P0",year:2019},{id:1,paperId:"P1",year:2020}] };
        const res = labelClusters(cr, ctx);
        const byId = Object.fromEntries(res.methods.map(m => [m.id, m]));
        return {
            cTfidfAvail: byId.cTfidf.available,
            cTfidfReason: byId.cTfidf.reason,
            repAvail: byId.representative.available,
            combined0: res.perCluster[0].combined,
        };
    }''')
    assert out["cTfidfAvail"] is False
    assert "title" in out["cTfidfReason"].lower()
    assert out["repAvail"] is True
    assert "P0" in out["combined0"]


def test_stratified_bands(clean_page):
    """Banded labels describe each cluster across PAPER-df bands: a term in many
    papers lands in a more-general band than a term in few papers, the band edges
    adapt to the paper-df distribution, and the signature (paper-df==1) tail is
    cleaned of pure-numeric / foreign-stopword junk. Banding is on paper-df now,
    not cluster-df. Stratification is an option on each text scorer (here
    c-TF-IDF banded)."""
    out = clean_page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        // 6 clusters × 2 nodes = 12 papers. "alga" is in every paper (general →
        // anchor); "soil" in four papers (broad); "zeta" in cluster 0's two
        // papers (specific). Each cluster-0 paper carries its OWN df==1 word
        // (gax/gbx) so the signature band is populated. Paper 0 also carries a
        // numeric token and a Portuguese stopword that must be filtered out.
        const common = "alga";
        const mk = (uniq, extra="") => `${common} ${extra} ${uniq} ${uniq}`;
        const texts = {
            0: mk("zeta", "soil gax 12345 para"), 1: mk("zeta", "soil gbx"),
            2: mk("eta",  "soil"),                3: mk("eta",  "soil"),
            4: mk("theta"),                       5: mk("theta"),
            6: mk("iota"),                        7: mk("iota"),
            8: mk("kappa"),                       9: mk("kappa"),
            10: mk("mu"),                         11: mk("mu"),
        };
        const nodeCluster = Int32Array.from([0,0,1,1,2,2,3,3,4,4,5,5]);
        const cr = { nodeCluster, clusters: [0,1,2,3,4,5].map(id => ({ id })) };
        const ctx = {
            embedding: null,
            nodes: Object.keys(texts).map(id => ({ id: +id })),
            getText: (id) => texts[id],
        };
        const res = labelClusters(cr, ctx, { methods: ["cTfidfStratified"] });
        const c0 = res.perCluster[0].byMethod.cTfidfStratified;
        const ORDER = ["anchor","broad","mid","specific","signature"];
        const bandOfTerm = (cl, term) => {
            for (const b of ORDER) if ((cl.bands[b]||[]).some(t => t.term === term)) return ORDER.indexOf(b);
            return -1;
        };
        const sigTerms = c0.bands.signature.map(t => t.term);
        return {
            available: res.methods[0].available,
            hasBands: !!c0.bands && ORDER.every(b => Array.isArray(c0.bands[b])),
            hasFlatTerms: Array.isArray(c0.terms) && c0.terms.length > 0,
            algaBand: bandOfTerm(c0, "alga"),       // in every paper → general
            zetaBand: bandOfTerm(c0, "zeta"),       // in two papers → more specific
            sigTerms,
            edges: c0.edges,
        };
    }''')
    assert out["available"] is True
    assert out["hasBands"] is True
    assert out["hasFlatTerms"] is True
    # a corpus-common term sits in a lower band index (more general) than a rare one
    assert out["algaBand"] != -1 and out["zetaBand"] != -1
    assert out["algaBand"] < out["zetaBand"]
    # a paper-df==1 word is a signature; junk is filtered out of it
    assert "gax" in out["sigTerms"] or "gbx" in out["sigTerms"]
    assert "12345" not in out["sigTerms"]
    assert "para" not in out["sigTerms"]
    assert len(out["edges"]) == 3


@pytest.mark.slow
def test_representative_labels_real(page):
    """On real BFS-5000 the representative method labels every cluster with
    a real paperId; the text methods gate (no titles materialised)."""
    out = page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        const st = await import("/app/src/ui/state.js");
        const s = st.getState();
        const cr = s.clusterResult;
        const ctx = { embedding: s.embedding, nodes: s.genResult.nodes };
        const res = labelClusters(cr, ctx);
        const byId = Object.fromEntries(res.methods.map(m => [m.id, m]));
        const allHavePaper = res.perCluster.every(p =>
            p.byMethod.representative && typeof p.byMethod.representative.paperId === "string");
        return {
            repAvail: byId.representative.available,
            cTfidfAvail: byId.cTfidf.available,
            nClusters: res.perCluster.length,
            allHavePaper,
        };
    }''')
    assert out["repAvail"] is True
    assert out["cTfidfAvail"] is False        # no titles materialised
    assert out["nClusters"] >= 1
    assert out["allHavePaper"] is True
