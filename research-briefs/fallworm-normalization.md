# Fall armyworm normalization brief

Corpus: `data/fallworm/nodes.jsonl` (1405 papers, title+abstract).
All frequencies below are **document frequency** (number of papers whose
title+abstract contain the token, case-insensitive, whole-token match)
measured directly against that file. The existing soil dictionary lives in
`biblion/text_normalization.py`; no test imports that module (grep-confirmed),
so changing its internals is test-safe as long as the soil defaults are
preserved.

## 1. Discovered abbreviations (always-fire candidates)

These are unambiguous in an entomology / pest-management / molecular-toxicology
corpus and can fire whenever they appear.

| token | expansion | df | example phrase |
|---|---|---:|---|
| faw | fall armyworm | 300 | "...microbiome of the fall armyworm (FAW), Spodoptera frugiperda..." |
| bt* | bacillus thuringiensis | 221 | "...Bacillus thuringiensis (Bt) toxin impairs the midgut..." (*context-gated, see §3) |
| instar / instars | larval instar(s) | 139 / 56 | "...third instar S. frugiperda larvae..." |
| lc50 | median lethal concentration | 102 | "...a calculated LC50 of 0.006 µg/ml..." |
| cry | crystal toxin | 69 | "...Cry toxins that kill insect pests..." |
| p450 | cytochrome p450 | 62 | "...cytochrome P-450 (CYP-450)..." |
| ipm | integrated pest management | 56 | "...integrated pest management (IPM) program for FAW..." |
| rnai | rna interference | 37 | "...RNA interference (RNAi) showed that Cry1AbS587A toxicity..." |
| gst | glutathione s-transferase | 33 | "...glutathione-s-transferase (GST) were also determined..." |
| crispr | clustered regularly interspaced short palindromic repeats | 29 | "...CRISPR-Cas9 KO in S. frugiperda..." |
| kegg | kyoto encyclopedia of genes and genomes | 26 | "...The KEGG function prediction results..." |
| care | carboxylesterase | 22 | "...carboxylesterase (CarE)... in CYP-450, CarE, or AChE" |
| abc | atp binding cassette transporter | 22 | "...ATP-binding cassette (ABC) transporter proteins..." |
| coi | cytochrome oxidase subunit i | 21 | "...mitochondrial cytochrome oxidase subunit I (COI)..." |
| ache | acetylcholinesterase | 21 | "...mutations in the AChE linked to organophosphate resistance..." |
| dsrna | double stranded rna | 18 | "...RNAi delivery... dsRNA..." |
| baculovirus/sfmnpv | spodoptera frugiperda multiple nucleopolyhedrovirus | 16 | "...SfMNPV..." |
| npv | nucleopolyhedrovirus | 8 | "...nucleopolyhedrovirus- (NPV) and the fungus Metarhizium rileyi..." |
| vip | vegetative insecticidal protein | 14 | "...expresses the cry and/or vip genes..." |
| lt50 | median lethal time | 13 | "...The LT50.90 values..." |
| irm | insecticide resistance management | 13 | "...insect resistance management (IRM) programs..." |
| epf | entomopathogenic fungi | 13 | "...entomopathogenic fungi (EPF)..." |
| ld50 | median lethal dose | 12 | "...LD50..." |
| ugt | udp glucuronosyltransferase | 11 | "...UGT..." |
| epn | entomopathogenic nematodes | 10 | "...Entomopathogenic nematodes (EPN)..." |
| ros | reactive oxygen species | 9 | "...reactive oxygen species (ROS) immune response..." |
| cas9 | crispr associated protein 9 | 20 | "...CRISPR-Cas9 KO..." |
| cyp | cytochrome p450 | 8 | "...cytochrome P-450 (CYP-450)..." |
| pbo | piperonyl butoxide | 7 | "...the P450 inhibitor piperonyl butoxide (PBO)..." |
| ec50 | median effective concentration | 6 | "...effective concentration (EC50)..." |
| mfo | mixed function oxidase | 4 | "...Mixed Function Oxidase (MFO)..." |
| lc90 / lc99 | 90 / 99 percent lethal concentration | 7 / 4 | "...estimated as ca. twice the LC99..." |
| duox | dual oxidase | 2 | "...DUOX-mediated reactive oxygen species..." |

Note: the `cry*` / `vip3*` toxin sub-names (Cry1Ac df 41, Cry1F df 52,
Cry1Ab df 45, Vip3Aa df 31, Cry2Ab df 18, etc.) are already meaningful
multi-character protein names to SPECTER2 and need no expansion; expanding the
bare family tokens `cry`/`vip` is enough.

## 2. Context-dependent candidates

Genuinely ambiguous tokens that should only fire when domain context co-occurs:

| token | sense | context keywords | example |
|---|---|---|---|
| bt | bacillus thuringiensis | bacillus, thuringiensis, toxin, cry, vip, maize, corn, transgenic, resistance | "...Bacillus thuringiensis (Bt) toxin..." |
| gm | genetically modified | crop(s), maize, corn, transgenic, genetically, modified, bt, trait | "...Genetically modified (GM) crops, expressing Bacillus thuringiensis..." |
| rr | homozygous resistant | resistant, resistance, strain, susceptible, rs, ss, fold, vip3aa, cry | "...resistant strain (TX-RR)... (RR = 5.75-fold)" |
| rs | heterozygous resistant/susceptible | resistant, susceptible, heterozygous, rr, ss, genotype, strain | "...susceptible (SS), heterozygous (RS) and resistant (RR)..." |
| ss | homozygous susceptible | susceptible, resistant, rr, rs, strain, population | "...susceptible population (SS)..." |
| ai | active ingredient | active, ingredient, insecticide, formulation, dose, rate | "...a.i...." |

`rr/rs/ss` are resistance genotype codes here but also appear in unrelated
medical abstracts that leak into the corpus, hence the context gate. `bt` is
listed context-gated rather than always-fire only because "bt" could in
principle be a stray token; in practice every occurrence in this corpus is
*Bacillus thuringiensis*, so an always-fire entry would also be acceptable.

## 3. Conflict analysis vs the existing soil map

The soil `ABBREVIATION_MAP` / `CONTEXT_DISAMBIG` contains several short tokens
that **misfire badly** on armyworm text. This is the core reason a merged map
is unsafe.

| soil token | soil meaning | armyworm df | what it actually is here | verdict |
|---|---|---:|---|---|
| **as** | arsenic | **858** | the English word "as" ("such as", "as well as"); arsenic never occurs | **catastrophic misfire — must be disabled** |
| ca | calcium | 10 | "ca." / "ca" = circa / approximately | misfire |
| na | not applicable / sodium | 18 | "NA medium" (nutrient agar); Portuguese "na" | misfire |
| nd | not detected | 6 | "ND-1" mitochondrial NADH-dehydrogenase gene | misfire |
| ck | cytokinin | 3 | "CK" = control check group | misfire |
| pi | inorganic phosphate | 5 | "trypsin PI" (proteinase inhibitor) / "primary insomnia" | misfire |
| cr | chromium / crop residue | 2 | "-Ib-cr" resistance gene suffix; "PI-Cr" population code | misfire |
| ag | silver / agricultural | 2 | "AG 1051" hybrid; "AA/AG" genotype | misfire (incl. soil context branch) |
| bc | biochar / bacterial community | 1 | "ANCOM-BC" (bias correction) | misfire |
| ar | arid / aromatic | 2 | "SfNPV-Ar" baculovirus strain code | misfire |
| cd | cadmium | 7 | genuinely cadmium (hyperaccumulator papers) but off-topic | drop (irrelevant) |
| n | nitrogen (context) | 80 | sample size "n", "non-", Portuguese "no/na" | misfire (drop soil 'n' rule) |
| c | carbon (context) | 112 | genus abbrev "C. ruficrus", English | drop soil 'c' rule |
| nt | no-tillage / N-treatment | 3 | neither sense present | drop |
| ja | jasmonic acid | 7 | **also jasmonic acid** (plant-defense signalling) | safe overlap (optional keep) |
| ha | hectare | 30 | **genuinely hectare** ("USD/ha", "ha of corn") | safe overlap (optional keep) |
| co2 | carbon dioxide | 2 | **genuinely CO2** (elevated-CO2 papers) | safe overlap (low value) |

Also rejected as too polysemous to expand in either direction: `se`
(Portuguese "se" / selenium / *Spodoptera exigua*), `its` (English "its" AND
ITS rRNA region, df 439), `sc` (suspension concentrate vs sea cucumber), `sg`
(soluble granule vs sleeve gastrectomy), `wp` (wettable powder vs winter pea),
`go` (Gene Ontology vs English "go"), `ec` (emulsifiable concentrate vs EC50 vs
European Commission).

## 4. Recommended integration: per-domain maps

A single merged map is rejected: identical tokens carry opposite meanings
(`as` = arsenic vs the word "as"; `nd` = not-detected vs the ND-1 gene; `na`
= sodium vs nutrient agar; `ck` = cytokinin vs control check). Merging would
either corrupt one corpus or require an unmaintainable thicket of context
rules. The corpus evidence makes the domains genuinely disjoint, so the clean
fix is **named per-domain dictionaries selected by an explicit `domain`
argument**, defaulting to `soil` so nothing existing changes.

### Concrete code changes

1. **`biblion/text_normalization.py`**
   - Rename the current dicts to `SOIL_ABBREVIATION_MAP` /
     `SOIL_CONTEXT_DISAMBIG`. Keep `ABBREVIATION_MAP = SOIL_ABBREVIATION_MAP`
     and `CONTEXT_DISAMBIG = SOIL_CONTEXT_DISAMBIG` as backward-compatible
     module-level aliases.
   - Add `ARMYWORM_ABBREVIATION_MAP` / `ARMYWORM_CONTEXT_DISAMBIG` from
     `fallworm-normalization.json`.
   - Add a registry: `DOMAIN_MAPS = {'soil': (SOIL_ABBREVIATION_MAP, SOIL_CONTEXT_DISAMBIG), 'armyworm': (ARMYWORM_ABBREVIATION_MAP, ARMYWORM_CONTEXT_DISAMBIG)}`.
   - `expand_abbreviation_in_context(word, context_terms, abbrev_map=ABBREVIATION_MAP, context_disambig=CONTEXT_DISAMBIG)` — take the two maps as params (defaulting to the soil aliases so existing callers are unaffected).
   - `normalize_text(text, preserve_case=False, track_expansions=False, domain='soil')` — resolve `abbrev_map, ctx = DOMAIN_MAPS[domain]` (raise a clear `ValueError` on unknown domain) and pass them into `expand_abbreviation_in_context`. `normalize_paper_text`/corpus helpers similarly grow an optional `domain` pass-through.

2. **`biblion/embed.py`**
   - Add `domain: str = 'soil'` to `_embed(...)` and `run_embed(...)`; pass it
     into both `normalize_text(...)` calls (~line 90). Add `'embedding_domain': domain` to the manifest stamp. Update the module docstring's soil-tuning note.

3. **`biblion/__main__.py`**
   - In `cmd_embedding`, pass `domain=args.domain` into `run_embed(...)`.
   - Add the CLI flag next to `--no-normalize`:
     `sem.add_argument('--domain', default='soil', choices=['soil','armyworm'], help='Abbreviation dictionary domain (default: soil)')`.
   - `--no-normalize` still short-circuits expansion entirely.

4. **Tests** — none import `text_normalization`, so soil defaults keep all
   current tests green. Optionally add `tests/unit/test_text_normalization.py`
   asserting: `domain='armyworm'` expands `faw`→`fall armyworm` and leaves
   `as` untouched; `domain='soil'` still expands `cd`→`cadmium`; unknown domain
   raises.

This keeps the soil pipeline byte-for-byte identical (same default path), adds
the armyworm dictionary behind an explicit opt-in, and records the domain in
the manifest for provenance.
