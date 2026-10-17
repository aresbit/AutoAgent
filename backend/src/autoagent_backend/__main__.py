"""CLI entry point with side-effect-free fast paths.

``--version``, ``--runtime-check`` and ``--health-check`` do not import FastAPI
or start the server.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import sys
import urllib.error
import urllib.request
from collections.abc import Sequence
from pathlib import Path

from . import APP_NAME, __version__
from .config import BootConfig, config_from_env
from .domain.errors import DomainError
from .paths import ensure_directories


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="autoagent-backend",
        description="AutoAgent local backend",
    )
    parser.add_argument("--host", default=None, help="bind address (loopback only)")
    parser.add_argument("--port", type=int, default=None, help="bind port")
    parser.add_argument("--data-dir", default=None, help="application data directory")
    parser.add_argument("--log-dir", default=None, help="log directory")
    parser.add_argument("--version", action="store_true", help="print version and exit")
    parser.add_argument(
        "--runtime-check",
        action="store_true",
        help="print resolved runtime paths and exit",
    )
    parser.add_argument(
        "--health-check",
        nargs="?",
        const="",
        default=None,
        metavar="URL",
        help="probe /api/health and exit",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)

    if args.version:
        print(f"autoagent-backend {__version__}")
        return 0

    try:
        config = config_from_env(
            host=args.host,
            port=args.port,
            data_dir=args.data_dir,
            log_dir=args.log_dir,
        )
    except ValueError as exc:
        print(f"autoagent-backend: {exc}", file=sys.stderr)
        return 2

    if args.runtime_check:
        return _runtime_check(config)

    if args.health_check is not None:
        return _health_check(config, args.health_check)

    return _serve(config)


def _runtime_check(config: BootConfig) -> int:
    from .adapters.engine.argv import resolve_bun, resolve_cli

    boot = config
    result: dict[str, object] = {
        "ok": True,
        "app": APP_NAME,
        "version": __version__,
        "dataDir": str(boot.paths.data_dir),
        "stateDir": str(boot.paths.state_dir),
        "logDir": str(boot.paths.log_dir),
        "dbPath": str(boot.paths.db_path),
        "engineMode": boot.engine_mode,
    }
    engine: dict[str, object] = {"mode": boot.engine_mode}
    engine["matebotVendor"] = str(boot.matebot_vendor)
    engine["matebotVendorExists"] = boot.matebot_vendor.is_file()
    if boot.engine_mode == "matebot" and not boot.matebot_vendor.is_file():
        engine["matebotVendorError"] = "vendored MateBot module was not found"
        result["ok"] = False
    try:
        engine["bun"] = str(resolve_bun(boot.bun_path))
    except DomainError as exc:
        engine["bun"] = None
        engine["bunError"] = exc.message
        result["ok"] = False
    try:
        engine["cli"] = str(resolve_cli(boot.cli_path))
    except DomainError as exc:
        engine["cli"] = None
        engine["cliError"] = exc.message
        result["ok"] = False
    result["engine"] = engine
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


def _health_check(config: BootConfig, url: str) -> int:
    target = url or f"http://{config.host}:{config.port}/api/health"
    try:
        with urllib.request.urlopen(target, timeout=3.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(
            f"autoagent-backend: health check failed for {target}: {type(exc).__name__}",
            file=sys.stderr,
        )
        return 1

    expected_boot = os.environ.get("AUTOAGENT_BOOT_ID", "").strip()
    ok = (
        isinstance(payload, dict)
        and payload.get("ok") is True
        and payload.get("app") == APP_NAME
        and (not expected_boot or payload.get("bootId") == expected_boot)
    )
    print(json.dumps(payload, indent=2))
    return 0 if ok else 1


def _serve(config: BootConfig) -> int:
    import uvicorn

    from .app import create_app

    paths = config.paths
    try:
        ensure_directories(paths)
    except OSError as exc:
        print(f"autoagent-backend: cannot create data directories: {exc}", file=sys.stderr)
        return 1

    pid_path: Path = paths.runtime_dir / "backend.pid"
    try:
        pid_path.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pid_path = Path()

    def cleanup() -> None:
        if not pid_path.name:
            return
        try:
            if pid_path.read_text(encoding="utf-8").strip() == str(os.getpid()):
                pid_path.unlink(missing_ok=True)
        except OSError:
            pass

    atexit.register(cleanup)

    app = create_app(config)
    uvicorn.run(
        app,
        host=config.host,
        port=config.port,
        log_config=None,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
