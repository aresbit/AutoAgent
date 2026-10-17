"""Filesystem path policy.

There is exactly one rule for resolving each path; every adapter receives the
resolved ``BootPaths`` value instead of composing paths on its own.

Stable data layout (platform conventions):
  Linux   ``$AUTOAGENT_DATA_DIR`` or ``${XDG_CONFIG_HOME:-~/.config}/autoagent``
  macOS   ``$AUTOAGENT_DATA_DIR`` or ``~/Library/Application Support/autoagent``
  Win32   ``$AUTOAGENT_DATA_DIR`` or ``%LOCALAPPDATA%\\AutoAgent``

Other paths:
  state dir:  ``$AUTOAGENT_STATE_DIR`` or (XDG state) ``<state>/autoagent``
  log dir:    ``$AUTOAGENT_LOG_DIR`` or ``<state>/logs``
  database:   ``<data>/autoagent-v2.db``
  engine cfg: ``$AUTOAGENT_CONFIG_DIR/settings.json`` or
              ``~/.autoagent/settings.json`` (independent of the data dir)
  CLI config: ``$CLAUDE_CONFIG_DIR`` or ``~/.claude``
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class BootPaths:
    data_dir: Path
    state_dir: Path
    log_dir: Path
    db_path: Path
    runtime_dir: Path
    claude_config_dir: Path
    engine_log_dir: Path
    migration_log_path: Path
    heartbeat_path: Path
    legacy_settings_path: Path
    legacy_sessions_dir: Path
    frontend_dist: Path
    autoagent_config_path: Path

    @property
    def backend_log_path(self) -> Path:
        return self.log_dir / "backend.log"


def repo_root() -> Path:
    """Return the repository root (backend/src/autoagent_backend/paths.py)."""

    return Path(__file__).resolve().parents[3]


def default_frontend_dist() -> Path:
    override = os.environ.get("AUTOAGENT_FRONTEND_DIST", "").strip()
    if override:
        return Path(override).expanduser()
    return repo_root() / "frontend" / "dist"


def default_matebot_vendor_path() -> Path:
    """Path to the vendored MateBot module (``opencc_backend.py``)."""

    override = os.environ.get("AUTOAGENT_MATEBOT_VENDOR_DIR", "").strip()
    if override:
        candidate = Path(override).expanduser()
        if candidate.is_dir():
            return candidate / "opencc_backend.py"
        return candidate
    return repo_root() / "vendor" / "matebot" / "opencc_backend.py"


def default_autoagent_config_dir() -> Path:
    """Frontend-editable engine config directory.

    Defaults to ``~/.autoagent`` and is intentionally independent of the XDG
    application data dir. ``AUTOAGENT_CONFIG_DIR`` overrides it.
    """

    override = os.environ.get("AUTOAGENT_CONFIG_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return _home() / ".autoagent"


def _home() -> Path:
    return Path.home()


def default_data_dir() -> Path:
    """Return the stable application data directory (no I/O).

    Platform conventions:
      Linux/other POSIX: ``${XDG_CONFIG_HOME:-~/.config}/autoagent``
      macOS: ``~/Library/Application Support/autoagent``
      Windows: ``%LOCALAPPDATA%\\AutoAgent``
    ``AUTOAGENT_DATA_DIR`` always wins.
    """

    override = os.environ.get("AUTOAGENT_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        base = (
            Path(local_app_data)
            if local_app_data
            else _home() / "AppData" / "Local"
        )
        return base / "AutoAgent"
    if sys.platform == "darwin":
        return _home() / "Library" / "Application Support" / "autoagent"
    xdg_config = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg_config).expanduser() if xdg_config else _home() / ".config"
    return base / "autoagent"


def default_state_dir() -> Path:
    override = os.environ.get("AUTOAGENT_STATE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    xdg_state = os.environ.get("XDG_STATE_HOME", "").strip()
    if xdg_state:
        return Path(xdg_state).expanduser() / "autoagent"
    return _home() / ".local" / "state" / "autoagent"


def resolve_paths(
    data_dir: str | Path | None = None,
    log_dir: str | Path | None = None,
    frontend_dist: str | Path | None = None,
) -> BootPaths:
    """Resolve all backend paths.

    Pre: explicit arguments, when given, are non-empty strings or paths.
    Post: the returned paths are absolute and deterministic for the same inputs;
          calling this function performs no filesystem I/O.
    """

    resolved_data = (
        Path(data_dir).expanduser()
        if data_dir is not None
        else default_data_dir()
    ).resolve()
    resolved_state = default_state_dir().resolve()
    env_log = os.environ.get("AUTOAGENT_LOG_DIR", "").strip()
    if log_dir is not None:
        resolved_log = Path(log_dir).expanduser().resolve()
    elif env_log:
        resolved_log = Path(env_log).expanduser().resolve()
    else:
        resolved_log = resolved_state / "logs"

    resolved_dist = (
        Path(frontend_dist).expanduser().resolve()
        if frontend_dist is not None
        else default_frontend_dist().resolve()
    )

    return BootPaths(
        data_dir=resolved_data,
        state_dir=resolved_state,
        log_dir=resolved_log,
        db_path=resolved_data / "autoagent-v2.db",
        runtime_dir=resolved_state / "runtime",
        claude_config_dir=resolved_data / ".claude",
        engine_log_dir=resolved_log / "engine",
        migration_log_path=resolved_log / "migration.log",
        heartbeat_path=resolved_state / "runtime" / "backend.heartbeat",
        legacy_settings_path=resolved_data / "settings.json",
        legacy_sessions_dir=resolved_data / "sessions",
        frontend_dist=resolved_dist,
        autoagent_config_path=default_autoagent_config_dir() / "settings.json",
    )


def ensure_directories(paths: BootPaths) -> None:
    """Create the directories the backend writes to.

    Post: directories exist; raises ``OSError`` when the filesystem refuses.
    """

    for directory in (
        paths.data_dir,
        paths.state_dir,
        paths.log_dir,
        paths.runtime_dir,
        paths.claude_config_dir,
        paths.engine_log_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
