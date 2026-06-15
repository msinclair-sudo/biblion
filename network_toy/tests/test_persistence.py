"""Tests for state persistence — validationRuns save/load round-trip.

Unique to this file (not covered elsewhere):
  - saveValidationRun / deleteValidationRun / clearValidationRuns
    action validation (bad inputs, auto-stamp, idempotent delete).
  - TypedArray round-trip through serialiseState → deserialiseFile
    (Int32Array stays Int32Array; bytes preserved).
  - Legacy save format (no validationRuns key) loads with the default
    empty array (additive schema compat).

Uses clean_page so the round-trip serialises only toy state — small
zip, fast. Sharing the BFS-5000 session would force a ~30MB
serialisation per test which adds nothing to the assertions.

Migrated from scratch/validation_runs_persistence_smoke.py.
"""


def test_validation_runs_default_empty(clean_page):
    out = clean_page.evaluate(
        '''async () => {
            const s = (await import("/app/src/ui/state.js")).getState();
            return {
                isArray: Array.isArray(s.validationRuns),
                length:  s.validationRuns ? s.validationRuns.length : -1,
            };
        }'''
    )
    assert out["isArray"] is True
    assert out["length"] == 0


def test_validation_run_actions(clean_page):
    """saveValidationRun appends with auto-stamped id + timestamp;
    bad inputs throw; deleteValidationRun is idempotent;
    clearValidationRuns empties."""
    out = clean_page.evaluate(
        '''async () => {
            const m = await import("/app/src/ui/state.js");

            // ── save: auto-stamp + distinct ids. ──
            const id1 = m.saveValidationRun({
                type: "dimSweep", label: "A",
                results: { ariMatrix: [[1, 0.8], [0.8, 1]] },
            });
            const id2 = m.saveValidationRun({
                type: "optimise",
                results: { ranked: [{ algoId: "mutualKNN", primary: 0.7 }] },
            });
            const afterSave = m.getState().validationRuns;

            // ── bad inputs throw. ──
            const badInputs = [];
            try { m.saveValidationRun(null); } catch (e) { badInputs.push("null"); }
            try { m.saveValidationRun("nope"); } catch (e) { badInputs.push("string"); }
            try { m.saveValidationRun({ results: {} }); } catch (e) { badInputs.push("no-type"); }

            // ── delete: by id; idempotent on unknown. ──
            m.deleteValidationRun(id1);
            m.deleteValidationRun("nonexistent-id");
            const afterDelete = m.getState().validationRuns;

            // ── clear empties. ──
            m.clearValidationRuns();
            const afterClear = m.getState().validationRuns;

            return {
                distinctIds:        id1 !== id2,
                allTimestamps:      afterSave.every(r => typeof r.timestamp === "string"),
                afterSaveTypes:     afterSave.map(r => r.type),
                badInputErrors:     badInputs.length,
                remainingAfterDel:  afterDelete.length,
                deletedIdGone:      afterDelete.every(r => r.id !== id1),
                afterClearLength:   afterClear.length,
            };
        }'''
    )
    assert out["distinctIds"] is True
    assert out["allTimestamps"] is True
    assert out["afterSaveTypes"] == ["dimSweep", "optimise"]
    assert out["badInputErrors"] == 3
    assert out["remainingAfterDel"] == 1
    assert out["deletedIdGone"] is True
    assert out["afterClearLength"] == 0


def test_typed_array_round_trip_via_save_load(clean_page):
    """Plant a run with an Int32Array buried inside results.partition;
    serialise to a zip; deserialise; verify the partition comes back as
    Int32Array with the same values. Also verifies inputs / settings /
    scoreVersion / runtimeSec all survive."""
    out = clean_page.evaluate(
        '''async () => {
            const m = await import("/app/src/ui/state.js");
            const { serialiseState } = await import("/app/src/persistence/serialise.js");
            const { deserialiseFile } = await import("/app/src/persistence/deserialise.js");

            const partition = new Int32Array([0, 0, 1, 1, 2, 2, -1, -1]);
            const id = m.saveValidationRun({
                type:   "dimSweep",
                label:  "Round-trip test",
                inputs: {
                    dataSourceId:        "toy",
                    dataSourceConfig:    { seed: 42 },
                    layerParamsSnapshot: { dimred: { compression: { method: "umap", params: { n_components: 100 } } } },
                },
                settings:     { dims: [30, 50, 100, 200], seeds: [42, 43, 44] },
                results:      { partition, nClusters: 3 },
                scoreVersion: 3,
                runtimeSec:   42.0,
            });

            const blob = serialiseState(m.getState());
            const file = new File([blob], "test.zip", { type: "application/zip" });
            const { patch } = await deserialiseFile(file);

            const r = patch.validationRuns.find(x => x.id === id);
            const p = r && r.results.partition;
            return {
                found:             !!r,
                label:             r && r.label,
                type:              r && r.type,
                settingsDims:      r && r.settings.dims,
                inputsDataSource:  r && r.inputs && r.inputs.dataSourceId,
                scoreVersion:      r && r.scoreVersion,
                runtimeSec:        r && r.runtimeSec,
                partitionIsInt32:  p instanceof Int32Array,
                partitionValues:   p ? Array.from(p) : null,
            };
        }'''
    )
    assert out["found"] is True
    assert out["label"]            == "Round-trip test"
    assert out["type"]             == "dimSweep"
    assert out["settingsDims"]     == [30, 50, 100, 200]
    assert out["inputsDataSource"] == "toy"
    assert out["scoreVersion"]     == 3
    assert out["runtimeSec"]       == 42.0
    assert out["partitionIsInt32"] is True
    assert out["partitionValues"]  == [0, 0, 1, 1, 2, 2, -1, -1]


def test_legacy_save_without_validation_runs_key(clean_page):
    """Older save formats predate state.validationRuns. Simulate by
    saving, unzipping, deleting the validationRuns key from state.json,
    re-zipping, and re-loading. The deserialiser's patch should omit
    the key entirely (state default kicks in)."""
    out = clean_page.evaluate(
        '''async () => {
            const m = await import("/app/src/ui/state.js");
            m.clearValidationRuns();
            const { serialiseState } = await import("/app/src/persistence/serialise.js");
            const { deserialiseFile } = await import("/app/src/persistence/deserialise.js");
            const { unzipSync, zipSync, strFromU8, strToU8 } = await import("https://esm.sh/fflate@0.8.2");

            const blob = serialiseState(m.getState());
            const ab   = await blob.arrayBuffer();
            const entries = unzipSync(new Uint8Array(ab));
            const stateJson = JSON.parse(strFromU8(entries["state.json"]));
            delete stateJson.validationRuns;
            entries["state.json"] = strToU8(JSON.stringify(stateJson));
            const repackaged = zipSync(entries);

            const file = new File([repackaged], "legacy.zip", { type: "application/zip" });
            const { patch } = await deserialiseFile(file);
            return {
                hasKey: "validationRuns" in patch,
                value:  patch.validationRuns,
            };
        }'''
    )
    # Absent in old save → absent in patch → state default ([]) takes over.
    assert out["hasKey"] is False
    assert out["value"] is None


def test_embedding_m_and_rowof_round_trip(clean_page):
    """embedding.m (embedded-node count) and rowOf (node index → embedding row,
    -1 for ghosts) must survive save/load. pickStage0Input sizes the noise stage
    to embedding.m, so dropping it makes a reloaded project re-run dim-reduction
    on the wrong row count for ghost corpora (NaN → umap-js overflow)."""
    out = clean_page.evaluate(
        '''async () => {
            const m = await import("/app/src/ui/state.js");
            const { serialiseState } = await import("/app/src/persistence/serialise.js");
            const { deserialiseFile } = await import("/app/src/persistence/deserialise.js");
            m.update({ embedding: {
                d: 2,
                data:  new Float32Array([1, 2, 3, 4, 5, 6]),   // m=3 rows × d=2
                m:     3,
                rowOf: new Int32Array([0, 1, 2, -1]),          // n=4, last is a ghost
            } });
            const blob = serialiseState(m.getState());
            const file = new File([blob], "t.zip", { type: "application/zip" });
            const { patch } = await deserialiseFile(file);
            const e = patch.embedding || {};
            return {
                m:          e.m,
                rowOfIsI32: e.rowOf instanceof Int32Array,
                rowOf:      e.rowOf ? Array.from(e.rowOf) : null,
                dataIsF32:  e.data instanceof Float32Array,
                dataLen:    e.data ? e.data.length : 0,
            };
        }'''
    )
    assert out["m"] == 3
    assert out["rowOfIsI32"] is True
    assert out["rowOf"] == [0, 1, 2, -1]
    assert out["dataIsF32"] is True
    assert out["dataLen"] == 6
