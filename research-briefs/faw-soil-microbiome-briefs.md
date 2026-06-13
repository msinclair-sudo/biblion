# Research briefs: FAW, microbiomes, parasitoids, soil health

Each brief is two parts. Dispatch **only** the AGENT BRIEF block to the research agent. The ROUTING block is for the human dispatcher and holds all project framing; never paste it into an agent prompt.

Ten briefs, grouped:

- Soil and methods: B1 (soil-health definition), B2 (eDNA targets), B3 (diversity-function), B4 (before/after monitoring)
- Insects and soil: B5 (insect fauna effects on soil)
- FAW and its microbes: B6 (gut microbiome), B7 (microbe-host interactions)
- Biocontrol parasitoids: B8 (natural enemy complex), B9 (parasitoid microbiomes), B10 (rearing hosts)

---

#### B1 soil health, microbiological definition and indicators

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Find how the scientific literature defines soil health from a microbiological standpoint and which microbial properties are used as measurable indicators of it. Collect empirical facts. Do not evaluate or endorse any research design.
>
> **Question:** In soil science and soil microbiology, what is meant by "soil health" (and the related term "soil quality"), and which microbial parameters are used as indicators of it? For each indicator, how well validated is it as a predictor of soil function rather than just a descriptor of the community?
>
> **Facts to return** (draw on soil science, microbial ecology, agronomy, and any monitoring framework, in any biome or cropping system):
> - Working definitions of soil health and soil quality from reviews and standards bodies, and whether the two terms are distinguished.
> - The microbial indicators in use: microbial biomass carbon, basal and substrate-induced respiration, metabolic and microbial quotients, extracellular enzyme activities, taxonomic diversity, functional gene diversity, community composition, and specific functional guilds (nitrogen cyclers, mycorrhizae, disease-suppressive taxa).
> - For each indicator, evidence on how reliably it tracks a soil function (productivity, nutrient supply, disease suppression, structure), its known confounders, and its dependence on a reference or baseline.
> - Bounding and negative facts: reviews stating that no single microbial parameter is a universal proxy for soil health; documented cases where microbial diversity did not correlate with function; published critiques of "soil health" as an operational concept.
>
> **Refuse / out of scope:** do not assess whether any particular microbial metric is suitable for any specific intervention, pest system, or monitoring program. Report the field's indicators and their validation status neutrally, with limits.
>
> **Deliverable: a literature review.** Write a synthesis (not a bare list): how the field defines the concept, which microbial indicators carry the strongest validation as function predictors, which are descriptive only, and where the concept is contested. Close with one verdict: **microbial diversity is an established standalone indicator of soil health**, **diversity is one of several indicators and not standalone**, or **no consensus microbial indicator of soil health exists**, justified by the reviewed evidence. Every source needs a complete reference (all authors, full title, venue, year, volume/issue/pages where applicable, and DOI or stable URL). No bare keys or partial entries. Provide a reference list and in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Establishes the definitional ground for the FAW biocontrol-and-soil PhD: whether "soil health" can be operationalised microbially at all before any FAW-specific claim is built on it. Feeds the soil-health framing note and constrains B3 and B4. If the verdict is "no standalone microbial indicator", then any project claim that a microbiome shift demonstrates improved soil health is an inference, not a measurement, and must be flagged as such downstream. Origin: the user's question "what is soil health in the context of microbiology".

---

#### B2 eDNA targets and the metabarcoding versus metagenomics trade-off

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Characterise the genetic targets used for environmental DNA profiling and the documented trade-offs between amplicon metabarcoding and shotgun metagenomics. Collect empirical facts. Do not evaluate or endorse any research design.
>
> **Question:** For environmental DNA characterisation of microbial and small-eukaryote communities (soil, gut, and other substrates), what genetic targets are used (marker genes versus whole-genome shotgun), and what are the documented trade-offs between metabarcoding and metagenomics across taxonomic resolution, functional inference, rare-taxon detection, input biomass and DNA requirements, primer and amplification bias, host-DNA contamination, quantitation, sequencing cost, and bioinformatic demand?
>
> **Facts to return** (any substrate, any target taxa):
> - Standard marker genes by target group: 16S rRNA for bacteria and archaea, ITS for fungi, 18S rRNA for broad eukaryotes, COI for metazoa; which variable regions resolve which ranks.
> - What shotgun metagenomics provides that amplicons cannot (strain-level taxonomy, functional and pathway genes, assembled genomes) and its costs.
> - Quantified or benchmarked trade-offs: taxonomic resolution ceilings (for example 16S rarely resolving species or strain), non-quantitative nature of amplicon relative abundance absent spike-ins, metagenomic underperformance at low biomass or high host-DNA fraction, primer and database coverage gaps, depth and cost differences, reproducibility.
> - Bounding and negative facts: head-to-head studies comparing both methods on the same samples; documented failure modes of each; statements on where each method should not be used.
>
> **Refuse / out of scope:** do not recommend a method for any specific study, organism, or sampling design. Report the general method properties and trade-offs only.
>
> **Deliverable: a literature review.** Synthesise the target choices by taxon, the trade-off axes with quantified ranges where the literature gives them, and the failure modes of each method. Close with one verdict: **one method generally dominates**, **no method dominates and choice is goal-dependent with quantified trade-offs**, or **the comparison is unresolved in the literature**, justified by the reviewed evidence, with head-to-head benchmarks distinguished from single-method reports. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Method-selection input for the PhD's eDNA work across soil, FAW gut, and parasitoid samples. The decision this feeds: which target(s) and which platform to budget for, given that the project spans bacteria, fungi, and the insects themselves (so COI and ITS matter alongside 16S). Keep the verdict neutral; the human maps it onto the project's biomass and host-contamination realities (insect gut and soil differ sharply on host-DNA load). Origin: "what are eDNA targets? trade-offs between metabarcoding and metagenomics".

---

#### B3 soil microbial diversity and function: benefit versus mere change

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Find what the evidence shows about whether higher soil microbial diversity causally improves soil functioning, versus diversity being neutral, saturating, or context-dependent. Collect empirical facts. Do not evaluate or endorse any research design, and do not assume that a measured increase in diversity is inherently beneficial.
>
> **Question:** In soil ecology, what is the empirical relationship between soil microbial diversity (taxonomic and functional) and soil functions such as nutrient cycling, primary productivity, disease suppression, decomposition, and stability? Is greater diversity demonstrated to improve function, and under what conditions does the relationship saturate, disappear, or reverse?
>
> **Facts to return** (any soil, any biome, experimental or observational):
> - Manipulative evidence (dilution-to-extinction, diversity gradients, removal or addition experiments) linking microbial diversity to specific functions, with direction and effect size.
> - The role of functional redundancy, saturation of single functions at low diversity, and the finding that multifunctionality may require higher diversity than any single function.
> - Whether richness, evenness, community composition, or functional-gene diversity is the better predictor of function.
> - Bounding and negative facts: studies where diversity did not predict function; cases where composition mattered more than richness; published critiques of the "more diversity is better" framing; instances where increased diversity was neutral or unfavourable.
>
> **Refuse / out of scope:** do not apply this to any specific intervention, additive, or pest system. Do not treat an observed rise in diversity as evidence of improvement. Report the diversity-function evidence neutrally, with its bounds.
>
> **Deliverable: a literature review.** Synthesise where diversity demonstrably drives function, where it saturates or fails to, and whether richness or composition carries the signal. Close with one verdict: **higher microbial diversity generally benefits soil multifunctionality**, **the benefit is context-dependent and often saturates, with composition outweighing raw richness**, or **no consistent evidence that diversity per se benefits function**, justified by the reviewed evidence. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> This is the guard against the project's central feedback-loop trap. The project may want to read "biocontrol increased soil microbial diversity" as "biocontrol improved the soil". B3 forces the question of whether diversity-increase even means benefit, in general, before that inference can be made about FAW biocontrol. A "context-dependent / composition over richness" or null verdict means the project cannot treat a measured diversity bump as a health gain without a function endpoint. Feeds the same decision as B1 and B4. Origin: the user's "is this increase beneficial, or just an increase".

---

#### B4 microbial community profiling as a before-and-after monitoring endpoint

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Find whether soil microbial community profiling (diversity and composition via DNA sequencing) is a validated outcome metric for detecting and interpreting the effects of agricultural management or biological interventions in before-and-after or controlled designs. Collect empirical facts. Note where the metric is used but not validated, and do not assume detected change equals improvement.
>
> **Question:** Across agroecology and soil microbiology, is soil microbial community composition or diversity used as a response variable to evaluate management or biological interventions (organic amendments, inoculants, agent releases, tillage, crop or input changes)? How sensitive, reproducible, and interpretable is it as a before-and-after monitoring endpoint, and what study designs and controls are required to attribute a change to the intervention?
>
> **Facts to return** (any intervention type, any cropping or natural system):
> - Studies using microbial community metrics as endpoints for interventions, and the designs they use (before-after-control-impact, paired controls, time series), with detectable effect sizes.
> - Sources of background variability that confound before-and-after contrasts: season, moisture, temperature, depth, sampling and extraction method, sequencing batch.
> - Recommended replication, controls, and confounders to remove before a shift can be attributed to the intervention.
> - Bounding and negative facts: interventions that produced no detectable microbial change; changes with no demonstrated functional meaning; explicit warnings that a microbiome shift alone does not indicate improved soil health; documented reproducibility limits of DNA-based soil monitoring.
>
> **Refuse / out of scope:** do not evaluate any specific intervention, additive, or biological control program. Do not equate a detected community shift with an improvement in soil condition. Report the field's use and validation of the metric, with limits.
>
> **Deliverable: a literature review.** Synthesise how the field uses microbial profiling as an intervention endpoint, the design and confounder controls it requires, and whether a detected shift is interpretable as a health change or only as a change. Close with one verdict: **microbial community profiling is a validated and interpretable before-and-after endpoint**, **it is widely used but interpretation as a health gain is not validated, since change does not equal improvement**, or **insufficient evidence that it works as a standalone monitoring endpoint**, justified by the reviewed evidence. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Directly answers "could this be a general health measurement of before and after biocontrol additives". The project wants to use eDNA soil profiling as a pre/post readout around FAW biocontrol deployment. B4 tells the human what design (BACI, replication, confounder control) the field demands and whether a shift can be read as a health gain at all. Pairs with B1 (is the metric meaningful) and B3 (does diversity mean benefit). If the verdict is "change does not equal improvement", the project needs a paired function endpoint, not microbiome shift alone. Origin: the user's final bullet.

---

#### B5 effects of soil-dwelling insects and soil macrofauna on soil structure and microbial communities

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Find what is known about how soil-dwelling and soil-pupating insects and comparable soil macrofauna alter soil physical properties and soil microbial communities, including whether the animals' own microbiomes are transferred into soil. Collect empirical facts. Flag evidence that is indirect or extrapolated from a different animal group, and do not assume that any change in microbial diversity is beneficial.
>
> **Question:** How does the presence and activity of soil-dwelling or soil-pupating insects (larvae and pupae) and comparable soil macrofauna alter (a) soil physical structure through bioturbation, porosity, aeration, and water infiltration, and (b) soil microbial community diversity, composition, and activity, including any role of the animals' gut or body microbiota, frass, or cadavers as inoculum into the surrounding soil?
>
> **Facts to return** (any soil fauna: earthworms, beetles, ants, termites, dung beetles, fly and lepidopteran larvae, pupae, in any soil):
> - Measured bioturbation effects on porosity, aeration, infiltration, and organic matter redistribution, by taxon.
> - Measured changes in soil microbial diversity, composition, or activity attributable to faunal presence or activity, with direction and magnitude.
> - Evidence on transfer and persistence of animal-associated microbiota into soil via frass, exuviae, cadavers, or pupal chambers.
> - Bounding and negative facts: cases where fauna had no effect or reduced microbial diversity; strong context dependence; reviews noting that data specific to lepidopteran or other holometabolous larvae are sparse relative to earthworms. Explicitly flag earthworm-derived findings as not automatically generalising to insect larvae.
>
> **Refuse / out of scope:** do not draw conclusions about parasitoids, biological control agents, or any pest program. Do not treat increased microbial diversity as a benefit (that is a separate question). Report measured effects, and label indirect or cross-taxon evidence as such.
>
> **Deliverable: a literature review.** Synthesise the physical and microbial effects of soil fauna by taxon, separating direct measurements on insect larvae from earthworm or macrofauna analogues, and assess the microbiome-to-soil transfer evidence. Close with one verdict: **direct evidence that soil-dwelling or soil-pupating insect larvae modify soil structure and microbiota exists**, **only indirect or earthworm-analogue evidence exists**, or **no evidence exists**, justified by the reviewed evidence, with indirect support labelled. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Generalises the user's "do the parasitoid hosts benefit the soil: do they aerate the soil, do we see increased microbial diversity, do they host diversity that benefits soil". The project's FAW larvae and pupae are soil-pupating; the question is whether their presence (and that of their microbiomes) physically and microbially changes soil. Kept organism-free so the agent does not retrieve only FAW-shaped sources. The "is the increase beneficial" judgement is deliberately split out to B3, and "is it a valid monitoring readout" to B4, so this brief reports mechanism and magnitude only. A "only earthworm-analogue evidence" verdict marks the larvae-to-soil claim as an inference the project's own sampling must test. Origin: the parasitoid-host-and-soil bullet tree.

---

#### B6 gut microbiome of herbivorous lepidopteran larvae, including the fall armyworm

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Characterise the gut microbiome of herbivorous lepidopteran larvae, with the fall armyworm Spodoptera frugiperda as a focal case where data exist. Collect empirical facts. Do not evaluate or endorse any research design. Where the literature reports that lepidopteran larvae carry a sparse, transient, or diet-derived gut community rather than a resident one, report that plainly.
>
> **Question:** What is the composition of the gut microbiome of herbivorous caterpillars (lepidopteran larvae), what drives it (diet, host plant, developmental stage, geography, laboratory versus field rearing), and how stable or resident is it? Where does Spodoptera frugiperda specifically fall within this picture?
>
> **Facts to return** (any caterpillar species; broaden to other herbivorous insects where it bounds the caterpillar case):
> - Dominant bacterial (and where reported fungal) taxa recovered from caterpillar guts, by method (culture, 16S, metagenomics).
> - Drivers of community composition: host plant and diet chemistry, instar and life stage, gut pH and morphology, geography, wild versus reared.
> - Evidence on whether caterpillars host a resident, co-adapted microbiome versus a transient, diet- and environment-loaded one, including the influential argument that many caterpillars lack a specialised resident gut microbiota.
> - Specific reported findings for Spodoptera frugiperda gut communities where available.
> - Bounding and negative facts: studies reporting low microbial load, high inter-individual variability, or no stable core; method and contamination caveats for low-biomass insect-gut sequencing.
>
> **Refuse / out of scope:** do not argue that the gut microbiome has any particular functional importance (that is a separate question), and do not scope the answer to validate any specific study or program. Report composition and its drivers, with the resident-versus-transient debate represented fairly.
>
> **Deliverable: a literature review.** Synthesise the typical composition, its drivers, and the resident-versus-transient question, then place S. frugiperda within it. Close with one verdict: **caterpillars including S. frugiperda generally host a resident, structured gut microbiome**, **the gut community is largely transient and diet-driven with no consistent core**, or **the evidence is mixed and method-dependent**, justified by the reviewed evidence. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Angle 1 of the project (the FAW gut microbiome and its role). Naming S. frugiperda is acceptable here: a review of caterpillar gut microbiota exists independent of this PhD, so this is a textbook-style question, not project validation. The resident-versus-transient framing is built in deliberately, because the project's premise that the FAW gut community "plays a role" depends on it being more than diet contamination. A "largely transient" verdict reshapes angles 1 and 2. Feeds the FAW-microbiome framing note. Origin: project angle 1.

---

#### B7 microbe-host interactions in lepidopteran pests: symbionts, pathogens, and microbe-mediated effects

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Find what is known about how microbes interact with herbivorous lepidopteran pests and affect the insect, across mutualists, pathogens, and microbe-mediated traits. Collect empirical facts. Do not evaluate or endorse any research design. Where a proposed microbial role is asserted but not experimentally demonstrated, report it as untested.
>
> **Question:** How do microbes interact with caterpillar pests and alter the insect's biology? Specifically, what is the evidence for microbe-mediated effects on nutrition, detoxification of plant defences and insecticides, resistance to Bacillus thuringiensis and other pesticides, immune function, development, and susceptibility to entomopathogens, across symbionts and pathogens?
>
> **Facts to return** (any caterpillar or herbivorous insect; use other insects to bound the caterpillar case):
> - Documented mutualistic or facilitative microbe-host effects: provisioning, detoxification of host-plant secondary metabolites, pesticide or xenobiotic degradation, modulation of insecticide and Bt susceptibility, with the experimental basis (antibiotic clearing, gnotobiotic reconstitution, isolate challenge) stated.
> - Entomopathogens of caterpillars (bacterial, fungal, viral, microsporidian) and how the resident microbiota modulates infection outcome.
> - Microbe-mediated effects on immunity, development, and behaviour where demonstrated.
> - Bounding and negative facts: claims of microbial function that rest only on correlation or sequence presence without manipulation; studies failing to find a fitness effect after microbiome disruption; the standard of evidence reviews demand before crediting a microbe with a host effect.
>
> **Refuse / out of scope:** do not conclude anything about the design of any particular pest-management or biological control program. Do not upgrade a correlational or sequence-only association to a demonstrated function. Report what has and has not been experimentally shown, with the level of evidence marked.
>
> **Deliverable: a literature review.** Synthesise the demonstrated microbe-host effects, separating manipulation-backed findings from correlational claims, and cover both mutualist and pathogen sides. Close with one verdict: **microbe-mediated effects on caterpillar biology are experimentally established for several traits**, **most proposed effects remain correlational and untested**, or **the evidence is trait-specific and mixed**, justified by the reviewed evidence, with correlation-only support labelled. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Angle 2 of the project (how microbes interact with FAW). The insecticide and Bt-resistance subthread matters for the project's applied framing, and the entomopathogen subthread connects to biocontrol. The built-in correlation-versus-manipulation guard exists because insect-microbiome literature is heavy with sequence-presence claims of function; the project should cite only manipulation-backed effects as facts. Feeds the FAW-microbiome framing note alongside B6. Origin: project angle 2.

---

#### B8 natural parasitoid and parasite complex of the fall armyworm

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Compile what the literature documents about the natural parasitoids and parasites that attack the fall armyworm Spodoptera frugiperda in the field, and their record as biological control agents. Collect empirical facts. Do not evaluate or endorse any research design or control program.
>
> **Question:** Which parasitoid and parasite species attack Spodoptera frugiperda in its native and invaded ranges, what is the guild structure (egg, larval, pupal parasitoids; tachinid flies; hymenopteran families), what host stages and ranges do they have, and what is documented about their field parasitism rates and their establishment or use in biological control?
>
> **Facts to return:**
> - Inventories of recorded parasitoid and parasite species of S. frugiperda by region, with taxonomic family and attacked host stage.
> - Reported field parasitism rates and their variability across region, season, and crop.
> - Host specificity and host range of the principal agents, and any non-target concerns.
> - Documented biological control outcomes: introductions, augmentative releases, establishment success or failure.
> - Bounding and negative facts: agents with poor establishment or low field impact; gaps where the natural-enemy complex is poorly characterised, especially in invaded ranges; reviews flagging taxonomic uncertainty.
>
> **Refuse / out of scope:** do not recommend a control strategy or agent for any program. Report the documented natural-enemy complex and its biocontrol record neutrally.
>
> **Deliverable: a literature review.** Synthesise the parasitoid and parasite complex by guild and region, the parasitism-rate evidence, host specificity, and the biocontrol track record. Close with one verdict: **the natural-enemy complex is well characterised with established effective agents**, **the complex is documented but agent effectiveness or establishment is inconsistent**, or **the complex is poorly characterised in key ranges**, justified by the reviewed evidence. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Angle 3, first subthread (natural parasitoids/parasites of FAW). This is descriptive natural history, so naming S. frugiperda carries no project framing and no feedback-loop risk; the inventory exists independent of the PhD. Gives the project its candidate-agent list and the baseline parasitism context. Feeds the biocontrol-agents note and selects which species become subjects for B9 (their microbiomes) and B10 (their rearing). Origin: project angle 3, natural enemies subthread.

---

#### B9 microbiomes of parasitoid wasps and flies

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Find what is known about the microbial communities and symbionts of parasitoid wasps and parasitoid flies, their composition, and their functional roles. Collect empirical facts. Do not evaluate or endorse any research design, and where a microbial role is proposed but not experimentally demonstrated, report it as untested.
>
> **Question:** What microbes and symbionts are associated with parasitoid Hymenoptera and parasitoid Diptera (for example tachinids), what is their composition and where do they reside (gut, reproductive tissue, venom, associated viruses), and what functional roles have been demonstrated, including effects on host manipulation, parasitoid fitness, and reproductive biology?
>
> **Facts to return** (any parasitoid species):
> - Reported microbial taxa and heritable symbionts of parasitoids (for example Wolbachia and other reproductive manipulators), and their prevalence.
> - Polydnaviruses and other parasitoid-associated viral elements and their documented role in suppressing host immunity.
> - Functional effects shown for parasitoid-associated microbes: host immune suppression, host physiological manipulation, parasitoid development, fecundity, sex ratio, and venom or teratocyte interactions.
> - Whether parasitoids carry a defined gut microbiome and how diet (host haemolymph, nectar, honeydew) shapes it.
> - Bounding and negative facts: parasitoid species with sparse or undefined microbiota; functional claims resting on correlation or sequence presence only; reviews noting how little is known about parasitoid gut microbiomes relative to their hosts.
>
> **Refuse / out of scope:** do not connect any of this to soil, to a control program, or to any specific pest. Do not upgrade correlational associations to demonstrated functions. Report composition and demonstrated roles, with evidence level marked.
>
> **Deliverable: a literature review.** Synthesise parasitoid-associated microbes by residence and function, separating heritable symbionts and polydnaviruses (well studied) from gut-community work (sparser), and mark correlational versus manipulation-backed claims. Close with one verdict: **parasitoid microbiomes and symbionts have demonstrated functional roles**, **roles are demonstrated for symbionts and viruses but the gut microbiome is largely uncharacterised**, or **functional evidence is mostly correlational**, justified by the reviewed evidence, with correlation-only support labelled. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Angle 3, second subthread (gut microbiomes of the natural enemies, not just the pest), and it also supplies the parasitoid side of the "do the parasitoids themselves host diversity that benefits the soil" question. Kept deliberately free of any soil or FAW framing so the agent reports parasitoid microbiology on its own terms; the soil-transfer and benefit judgements are routed to B5 and B3. The species of interest come from B8. Feeds the parasitoid-microbiome note. Origin: project angle 3, parasitoid-microbiome subthread, plus the parasitoid branch of the soil bullet tree.

---

#### B10 rearing and factitious hosts for parasitoid mass-production

> [!abstract] AGENT BRIEF (give this verbatim to the research agent)
> **Task:** Find what is known about the host insects used to mass-rear parasitoids for biological control production, and how the choice of rearing host affects parasitoid quality. Collect empirical facts. Do not evaluate or endorse any research design or production program.
>
> **Question:** In parasitoid mass-rearing for biological control, what natural and factitious (substitute) host insects are used, how is the choice made, and what is the documented effect of rearing host on parasitoid performance traits, host acceptance, fitness, and the parasitoid's own microbiota?
>
> **Facts to return** (any parasitoid and any rearing system):
> - Common factitious hosts used in commercial and research rearing (for example grain moth and flour moth species such as Sitotroga and Ephestia, and other standard laboratory hosts) and the rationale (cost, ease, year-round supply).
> - Documented effects of rearing on a factitious or alternative host on parasitoid quality: body size, fecundity, longevity, sex ratio, host-searching, and host acceptance, including any preference shift toward the rearing host.
> - Evidence that the rearing host or diet alters the parasitoid's associated microbiota.
> - Bounding and negative facts: cases of rearing-induced deterioration, loss of field performance, or laboratory adaptation; trade-offs between rearing convenience and agent quality.
>
> **Refuse / out of scope:** do not recommend a rearing host or protocol for any specific program. Report the host options and their documented effects on parasitoid quality neutrally.
>
> **Deliverable: a literature review.** Synthesise the host options, the basis for choosing them, and the measured consequences of rearing host on parasitoid quality and microbiota. Close with one verdict: **rearing host strongly and predictably affects parasitoid quality**, **effects are documented but trait- and species-specific**, or **the evidence is limited or mixed**, justified by the reviewed evidence. Complete references for every source (all authors, title, venue, year, volume/issue/pages, DOI or stable ID). Reference list plus in-text markers.

> [!note] ROUTING (human dispatcher only; do NOT give to the agent)
> Angle 3, third subthread (rearing hosts for parasitoid production). Relevant because the project's parasitoid microbiome work (B9) is confounded if rearing-host diet imprints the parasitoid's microbiota: this brief surfaces that confounder from the production-biology side. Feeds the rearing and parasitoid-microbiome notes jointly. Origin: project angle 3, rearing-hosts subthread.
