"""
Named project registry — map short names to database paths and track a
"current" project, so you can switch between databases git-style instead of
passing --db every time.

Resolution precedence (see __main__.main): an explicit --db flag wins, then
$BIBLION_DB, then the registry's current project. The registry is therefore a
pure convenience layer — it never overrides an explicit choice, so existing
scripts and other sessions that set --db / BIBLION_DB are unaffected.

Config file: $BIBLION_CONFIG, else $XDG_CONFIG_HOME/biblion/projects.json,
else ~/.config/biblion/projects.json. JSON (not TOML) because the stdlib can
both read and write it with no extra dependency.

Shape:
    {
      "current": "algae",
      "projects": {
        "algae":      "/abs/path/algae.db",
        "microbiome": "/abs/path/mb.db"
      }
    }
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional


class ProjectError(Exception):
    """Registry operation failed (unknown name, duplicate, bad path)."""


def config_path() -> Path:
    """Location of the registry file (honours $BIBLION_CONFIG / XDG)."""
    override = os.environ.get('BIBLION_CONFIG')
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get('XDG_CONFIG_HOME')
    base = Path(xdg).expanduser() if xdg else Path.home() / '.config'
    return base / 'biblion' / 'projects.json'


def _load() -> dict:
    p = config_path()
    if not p.exists():
        return {'current': None, 'projects': {}}
    try:
        data = json.loads(p.read_text())
    except (ValueError, OSError):
        # A corrupt registry should not brick the CLI; treat as empty but keep
        # the file (don't clobber) so the user can inspect/fix it.
        return {'current': None, 'projects': {}}
    data.setdefault('current', None)
    data.setdefault('projects', {})
    return data


def _save(data: dict) -> None:
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename for atomicity (no half-written registry on crash).
    tmp = p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')
    tmp.replace(p)


def _derive_name(db_path: Path) -> str:
    """Default project name from a db path: the filename stem, minus a
    trailing _claims (so a sidecar can't collide with its main)."""
    stem = Path(db_path).stem
    if stem.endswith('_claims'):
        stem = stem[: -len('_claims')]
    return stem or 'default'


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def list_projects() -> tuple[dict, Optional[str]]:
    """Return ({name: path}, current_name)."""
    data = _load()
    return dict(data['projects']), data['current']


def current_path() -> Optional[Path]:
    """Absolute path of the current project's DB, or None if unset/unknown.

    Used by the CLI as the lowest-priority DB source. Never raises — a missing
    or dangling current just yields None so the caller falls through to its
    own 'no database configured' handling.
    """
    data = _load()
    name = data.get('current')
    if not name:
        return None
    raw = data['projects'].get(name)
    if not raw:
        return None
    return Path(raw)


def add(name: str, db_path, *, set_current: bool = False,
        overwrite: bool = False) -> Path:
    """Register `name` -> absolute(db_path). Returns the resolved path.

    Raises ProjectError if the name already maps to a different path and
    overwrite is False.
    """
    name = name.strip()
    if not name:
        raise ProjectError('project name must be non-empty')
    resolved = Path(db_path).expanduser().resolve()
    data = _load()
    existing = data['projects'].get(name)
    if existing and existing != str(resolved) and not overwrite:
        raise ProjectError(
            f"project {name!r} already points at {existing}; "
            f"pass overwrite=True (or `--force`) to repoint it"
        )
    data['projects'][name] = str(resolved)
    if set_current or data.get('current') is None:
        data['current'] = name
    _save(data)
    return resolved


def use(name: str) -> Path:
    """Set the current project. Returns its path. Raises if unknown."""
    name = name.strip()
    data = _load()
    if name not in data['projects']:
        raise ProjectError(
            f"unknown project {name!r}; known: "
            f"{', '.join(sorted(data['projects'])) or '(none)'}"
        )
    data['current'] = name
    _save(data)
    return Path(data['projects'][name])


def remove(name: str) -> None:
    """Unregister a project. Clears `current` if it pointed here. Raises if
    unknown. Does NOT delete the database file."""
    name = name.strip()
    data = _load()
    if name not in data['projects']:
        raise ProjectError(f"unknown project {name!r}")
    del data['projects'][name]
    if data.get('current') == name:
        data['current'] = None
    _save(data)


def auto_register_on_init(db_path, name: Optional[str] = None) -> str:
    """Register a freshly-init'd DB and make it current. Returns the name used.

    Name defaults to the db filename stem. Re-pointing an existing name to the
    same path is a no-op; to a different path it overwrites (init is an
    explicit user action, so the new path is intended)."""
    chosen = (name or _derive_name(db_path)).strip()
    add(chosen, db_path, set_current=True, overwrite=True)
    return chosen
