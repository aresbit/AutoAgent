"""Support bundle assembly (MVP).

Produces a deterministic, redacted zip from explicit inputs: health, effective
settings (no secrets), aggregate counts, MCP server metadata, and log tails.
No conversation text, message bodies, environment variables or headers are
included. The caller (API layer) supplies the already-read values.
"""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from ..domain.models import (
    McpServer,
    McpServerStatus,
    ModelResolution,
    Settings,
)
from ..logging_setup import redact

_MAX_LOG_BYTES = 1_000_000
_MAX_LOG_LINES = 4000


@dataclass(frozen=True, slots=True)
class SupportBundleInputs:
    app_name: str
    version: str
    api_version: str
    boot_id: str
    generated_at_ms: int
    lifecycle_state: str
    db_state: str
    engine_state: str
    engine_mode: str
    engine_version: str | None
    engine_last_error: str | None
    settings: Settings
    model: ModelResolution
    counts: tuple[int, int, int]
    mcp_servers: Sequence[McpServer]
    mcp_statuses: Sequence[McpServerStatus]
    data_dir: Path
    state_dir: Path
    log_dir: Path
    db_path: Path
    backend_log: Path
    desktop_log: Path | None
    secrets: tuple[str, ...] = ()


class SupportBundleService:
    """Build a redacted support zip."""

    def build(self, inputs: SupportBundleInputs) -> bytes:
        payloads: dict[str, str] = {
            "manifest.json": _json(
                {
                    "app": inputs.app_name,
                    "version": inputs.version,
                    "apiVersion": inputs.api_version,
                    "bootId": inputs.boot_id,
                    "generatedAt": inputs.generated_at_ms,
                    "redacted": True,
                    "contains": [
                        "health",
                        "settings",
                        "counts",
                        "mcp",
                        "logs",
                    ],
                    "excludes": [
                        "message bodies",
                        "api keys",
                        "environment values",
                        "mcp env/headers",
                    ],
                }
            ),
            "health.json": _json(
                {
                    "state": inputs.lifecycle_state,
                    "db": inputs.db_state,
                    "engine": inputs.engine_state,
                    "engineMode": inputs.engine_mode,
                    "engineVersion": inputs.engine_version,
                    "engineLastError": inputs.engine_last_error,
                }
            ),
            "settings.json": _json(
                {
                    "providerId": inputs.settings.provider_id,
                    "model": inputs.settings.model,
                    "fallbackModel": inputs.settings.fallback_model,
                    "baseURL": inputs.settings.base_url,
                    "apiKeyConfigured": bool(inputs.settings.api_key),
                    "cwdConfigured": bool(inputs.settings.cwd),
                    "permissionMode": inputs.settings.permission_mode,
                    "engineHarness": inputs.settings.engine_harness,
                    "apiCredentialSource": inputs.settings.api_credential_source,
                    "effectiveModel": inputs.model.model,
                    "modelSource": inputs.model.source,
                    "credentialSource": inputs.model.credential_source,
                    "baseURLSource": inputs.model.base_url_source,
                }
            ),
            "sessions.json": _json(
                {
                    "sessions": inputs.counts[0],
                    "messages": inputs.counts[1],
                    "turns": inputs.counts[2],
                }
            ),
            "mcp.json": _json(
                {
                    "servers": [
                        {
                            "name": server.name,
                            "transport": server.spec.transport,
                            "enabled": server.enabled,
                        }
                        for server in inputs.mcp_servers
                    ],
                    "statuses": [
                        {
                            "name": status.name,
                            "state": status.state,
                            "connected": status.connected,
                            "toolCount": status.tool_count,
                            "resourceCount": status.resource_count,
                            "promptCount": status.prompt_count,
                            "lastError": status.last_error,
                            "reconnectAttempts": status.reconnect_attempts,
                        }
                        for status in inputs.mcp_statuses
                    ],
                }
            ),
            "diagnostics.json": _json(
                {
                    "dataDir": str(inputs.data_dir),
                    "stateDir": str(inputs.state_dir),
                    "logDir": str(inputs.log_dir),
                    "dbBytes": _size(inputs.db_path),
                    "backendLogBytes": _size(inputs.backend_log),
                    "desktopLogBytes": (
                        _size(inputs.desktop_log) if inputs.desktop_log else None
                    ),
                }
            ),
        }

        backend_log = _tail(inputs.backend_log)
        if backend_log:
            payloads["logs/backend.log"] = backend_log
        if inputs.desktop_log is not None:
            desktop_log = _tail(inputs.desktop_log)
            if desktop_log:
                payloads["logs/desktop.log"] = desktop_log

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, text in payloads.items():
                archive.writestr(name, redact(text, inputs.secrets))
        return buffer.getvalue()


def _json(value: object) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def _size(path: Path | None) -> int | None:
    if path is None:
        return None
    try:
        return path.stat().st_size
    except OSError:
        return None


def _tail(path: Path) -> str:
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            if size > _MAX_LOG_BYTES:
                handle.seek(size - _MAX_LOG_BYTES)
            data = handle.read()
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines()[-_MAX_LOG_LINES:]
    return "\n".join(lines) + ("\n" if lines else "")


__all__ = ["SupportBundleInputs", "SupportBundleService"]
