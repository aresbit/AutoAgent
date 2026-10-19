"""Boot configuration parsed from CLI arguments and environment variables.

The backend binds loopback only. Configuration is immutable after startup; the
launch token is excluded from ``repr`` so accidental logging cannot leak it.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import API_VERSION, APP_NAME, __version__
from .paths import (
    BootPaths,
    default_frontend_dist,
    default_matebot_vendor_path,
    resolve_paths,
)

LOOPBACK_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_ENGINE_MODE = "matebot"
MIN_PORT = 1
MAX_PORT = 65535


def _parse_bool(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _parse_int(value: str | None, default: int) -> int:
    if value is None or not value.strip():
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"expected an integer, got {value!r}") from exc


def _parse_float(value: str | None, default: float) -> float:
    if value is None or not value.strip():
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"expected a number, got {value!r}") from exc


@dataclass(frozen=True, slots=True)
class BootConfig:
    host: str
    port: int
    paths: BootPaths
    api_token: str = field(repr=False)
    boot_id: str
    version: str = __version__
    app_name: str = APP_NAME
    api_version: str = API_VERSION
    engine_mode: str = DEFAULT_ENGINE_MODE
    bun_path: str | None = None
    cli_path: str | None = None
    debug_engine: bool = False
    max_engines: int = 4
    cancel_grace_s: float = 3.0
    desktop_pid: int | None = None
    desktop_heartbeat: str | None = None
    frontend_dist: Path = field(default_factory=default_frontend_dist)
    default_cwd: Path = field(default_factory=lambda: Path.home().resolve())
    matebot_vendor: Path = field(default_factory=default_matebot_vendor_path)
    terminals_enabled: bool = True
    max_terminals: int = 12

    @property
    def origin(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def token_configured(self) -> bool:
        return bool(self.api_token)


def config_from_env(
    *,
    host: str | None = None,
    port: int | None = None,
    data_dir: str | Path | None = None,
    log_dir: str | Path | None = None,
    frontend_dist: str | Path | None = None,
) -> BootConfig:
    """Build a ``BootConfig`` from arguments and environment.

    Pre: ``host`` is loopback; ``port`` is in 1..65535.
    Post: environment overrides are applied; the result is immutable.
    Raises: ``ValueError`` for a non-loopback host, invalid port, or invalid
            numeric environment value.
    """

    env = os.environ
    resolved_host = (host or env.get("AUTOAGENT_BIND") or LOOPBACK_HOST).strip()
    if resolved_host not in {LOOPBACK_HOST, "localhost"}:
        raise ValueError(
            f"refusing to bind {resolved_host!r}: the backend is loopback-only "
            f"({LOOPBACK_HOST})"
        )
    # Normalize the alias so Origin comparison is exact.
    resolved_host = LOOPBACK_HOST

    if port is None:
        port = _parse_int(env.get("AUTOAGENT_PORT"), DEFAULT_PORT)
    if not MIN_PORT <= port <= MAX_PORT:
        raise ValueError(f"port must be in {MIN_PORT}..{MAX_PORT}, got {port}")

    env_data = env.get("AUTOAGENT_DATA_DIR", "").strip()
    if data_dir is not None:
        resolved_data: Path | None = Path(data_dir).expanduser()
    elif env_data:
        resolved_data = Path(env_data).expanduser()
    else:
        resolved_data = None
    paths = resolve_paths(resolved_data, log_dir, frontend_dist)

    api_token = env.get("AUTOAGENT_API_TOKEN", "")
    boot_id = env.get("AUTOAGENT_BOOT_ID", "").strip() or str(uuid.uuid4())
    engine_mode = (
        env.get("AUTOAGENT_ENGINE", DEFAULT_ENGINE_MODE).strip().lower()
        or DEFAULT_ENGINE_MODE
    )
    if engine_mode not in {"matebot", "subprocess", "fake"}:
        raise ValueError(
            "AUTOAGENT_ENGINE must be 'matebot', 'subprocess' or 'fake'"
        )
    if engine_mode == "fake" and _parse_bool(env.get("AUTOAGENT_PACKAGED")):
        raise ValueError("AUTOAGENT_ENGINE=fake is refused in packaged mode")

    vendor_raw = env.get("AUTOAGENT_MATEBOT_VENDOR_DIR", "").strip()
    if vendor_raw:
        vendor_candidate = Path(vendor_raw).expanduser()
        if vendor_candidate.is_dir():
            vendor_candidate = vendor_candidate / "opencc_backend.py"
    else:
        vendor_candidate = default_matebot_vendor_path()
    matebot_vendor = vendor_candidate.resolve()

    desktop_pid_raw = env.get("AUTOAGENT_DESKTOP_PID", "").strip()
    desktop_pid = _parse_int(desktop_pid_raw, 0) if desktop_pid_raw else None

    env_cwd = env.get("AUTOAGENT_DEFAULT_CWD", "").strip()
    default_cwd = (
        Path(env_cwd).expanduser().resolve()
        if env_cwd
        else Path.home().resolve()
    )

    return BootConfig(
        host=resolved_host,
        port=port,
        paths=paths,
        api_token=api_token,
        boot_id=boot_id,
        engine_mode=engine_mode,
        bun_path=env.get("AUTOAGENT_BUN_PATH", "").strip() or None,
        cli_path=env.get("AUTOAGENT_OPENCC_CLI_PATH", "").strip() or None,
        debug_engine=_parse_bool(env.get("AUTOAGENT_DEBUG_ENGINE")),
        max_engines=_parse_int(env.get("AUTOAGENT_MAX_ENGINES"), 4),
        cancel_grace_s=_parse_float(env.get("AUTOAGENT_CANCEL_GRACE_S"), 3.0),
        desktop_pid=desktop_pid,
        desktop_heartbeat=env.get("AUTOAGENT_DESKTOP_HEARTBEAT", "").strip() or None,
        frontend_dist=paths.frontend_dist,
        default_cwd=default_cwd,
        matebot_vendor=matebot_vendor,
        terminals_enabled=_parse_bool(env.get("AUTOAGENT_TERMINALS", "1")),
        max_terminals=_parse_int(env.get("AUTOAGENT_MAX_TERMINALS"), 12),
    )
