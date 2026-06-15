"""Fast freshness guard for the committed fixture zips.

Each fixture under tests/fixtures/ carries a manifest.json whose
schemaVersion must equal the app's current SCHEMA_VERSION
(app/src/persistence/manifest.js). When J01 (round-trip → v4) or J02
(toy-removal defaults) — or any future change — bumps the schema, the
committed fixtures go stale and the loader would refuse them
(deserialise.js validateManifest throws). This test catches that before
it surfaces as an opaque load failure, pointing the dev at the fix.

No browser, no Redis, no data — pure file inspection (~ms). Runs in the
default `pytest -m "not slow"` tier.

When a fixture file is absent the test SKIPS (not fails): the zips are
generated on a dev machine that has data/fallworm/ via
`npm run make:fixtures` and committed afterwards. A fresh checkout
before that regen run has the tooling but not yet the binaries; skipping
keeps the default tier green there while still failing loudly the moment
a present fixture drifts from the schema.
"""

import json
import re
import zipfile
from pathlib import Path

import pytest

_HERE = Path(__file__).parent
_FIXTURE_DIR = _HERE / "fixtures"
_MANIFEST_JS = _HERE.parent / "app" / "src" / "persistence" / "manifest.js"
_MAKE_FIXTURES_JS = _HERE.parent / "scripts" / "make-fixtures.mjs"

FIXTURES = ["clean", "data_only", "fallworm_baseline"]

REGEN_HINT = "run `npm run make:fixtures` (on a machine with data/fallworm/)"


def _current_schema_version():
    """Read SCHEMA_VERSION out of manifest.js (single source of truth)."""
    src = _MANIFEST_JS.read_text()
    m = re.search(r"export\s+const\s+SCHEMA_VERSION\s*=\s*(\d+)", src)
    assert m, f"could not find SCHEMA_VERSION in {_MANIFEST_JS}"
    return int(m.group(1))


def _current_generator_version():
    """Read GENERATOR_VERSION out of make-fixtures.mjs (single source of
    truth for the generator's content version)."""
    src = _MAKE_FIXTURES_JS.read_text()
    m = re.search(r"export\s+const\s+GENERATOR_VERSION\s*=\s*(\d+)", src)
    assert m, f"could not find GENERATOR_VERSION in {_MAKE_FIXTURES_JS}"
    return int(m.group(1))


def _fixture_manifest(name):
    """Return the parsed manifest.json from a committed fixture zip."""
    path = _FIXTURE_DIR / f"{name}.zip"
    if not path.exists():
        pytest.skip(f"fixture {path.name} not generated yet — {REGEN_HINT}")
    with zipfile.ZipFile(path) as zf:
        with zf.open("manifest.json") as fh:
            return json.load(fh)


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture_schema_version_is_current(name):
    current = _current_schema_version()
    manifest = _fixture_manifest(name)
    got = manifest.get("schemaVersion")
    assert got == current, (
        f"fixture {name}.zip is schemaVersion {got!r} but the app expects "
        f"v{current} — fixture is stale, {REGEN_HINT}"
    )


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture_is_a_network_toy_file(name):
    """A sanity floor: the committed zip is actually one of our saves."""
    manifest = _fixture_manifest(name)
    assert manifest.get("appName") == "network-toy", (
        f"fixture {name}.zip is not a network-toy save — {REGEN_HINT}"
    )


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture_stamp_matches_current_generator(name):
    """The fixture's provenance stamp must match the current generator.

    This catches the drift the schema version alone misses: someone edits
    scripts/make-fixtures.mjs (pipeline params, dataset, logic), bumps
    GENERATOR_VERSION, but forgets to regenerate + commit the zips. The
    committed fixture then carries an older generatorVersion than the
    source, and this fast (file-only) test fails loudly.

    A fixture with NO stamp predates the provenance feature; treat that as
    "needs regen" and skip (not fail) so a checkout with pre-stamp zips
    keeps the default tier green until the next regen adds the stamp.
    """
    manifest = _fixture_manifest(name)
    stamp = manifest.get("fixtureStamp")
    if not stamp:
        pytest.skip(
            f"fixture {name}.zip predates the provenance stamp — {REGEN_HINT} "
            "to add it"
        )
    current = _current_generator_version()
    assert stamp.get("generatorVersion") == current, (
        f"fixture {name}.zip was built by generator v{stamp.get('generatorVersion')} "
        f"but make-fixtures.mjs is now v{current} — fixture is stale, {REGEN_HINT}"
    )
    # The baseline must additionally carry the pipeline that produced it
    # (the determinism guard reads it back from here).
    if name == "fallworm_baseline":
        pipeline = stamp.get("pipeline")
        assert pipeline and "dimred" in pipeline and "hdbscan" in pipeline, (
            f"baseline fixture stamp is missing its pipeline params — {REGEN_HINT}"
        )
