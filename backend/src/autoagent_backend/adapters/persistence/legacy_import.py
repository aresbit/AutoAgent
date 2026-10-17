"""Read-only, idempotent first-run import of legacy AutoAgent data.

Sources are never modified. A ``kv('legacy_migrated_at')`` marker makes the
operation a no-op after the first successful pass.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ...domain.models import SettingsPatch
from ...domain.ports import ClockPort, SettingsPort
from .session_store import SqliteSessionStore
from .sqlite import SqliteDatabase

_LOG = logging.getLogger("autoagent.legacy_import")
MARKER_KEY = "legacy_migrated_at"
_LEGACY_SETTINGS_KEYS = frozenset(
    {
        "providerId",
        "fallbackModel",
        "permissionMode",
        "thinkingMode",
        "effort",
        "maxThinkingTokens",
        "maxTurns",
        "maxBudgetUsd",
        "taskBudget",
        "allowedTools",
        "disallowedTools",
        "addDirs",
        "appendSystemPrompt",
        "layout",
    }
)


@dataclass(frozen=True, slots=True)
class ImportSummary:
    skipped: bool
    sessions: int = 0
    messages: int = 0
    settings: bool = False


class LegacyImporter:
    """Imports legacy JSON state into the v2 database exactly once."""

    def __init__(
        self,
        *,
        db: SqliteDatabase,
        sessions: SqliteSessionStore,
        settings: SettingsPort,
        clock: ClockPort,
        data_dir: Path,
        log_path: Path,
    ) -> None:
        self._db = db
        self._sessions = sessions
        self._settings = settings
        self._clock = clock
        self._data_dir = data_dir
        self._log_path = log_path

    def run(self) -> ImportSummary:
        marker = self._db.query_one("SELECT value FROM kv WHERE key = ?", (MARKER_KEY,))
        if marker is not None:
            return ImportSummary(skipped=True)

        sessions_imported = 0
        messages_imported = 0
        settings_imported = self._import_settings()

        legacy_sessions_dir = self._data_dir / "sessions"
        if legacy_sessions_dir.is_dir():
            for path in sorted(legacy_sessions_dir.glob("*.json")):
                count = self._import_session_file(path)
                if count is not None:
                    sessions_imported += 1
                    messages_imported += count

        with self._db.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)",
                (MARKER_KEY, str(self._clock.now_ms())),
            )

        summary = ImportSummary(
            skipped=False,
            sessions=sessions_imported,
            messages=messages_imported,
            settings=settings_imported,
        )
        self._write_log(summary)
        return summary

    def _import_settings(self) -> bool:
        path = self._data_dir / "settings.json"
        if not path.is_file():
            return False
        raw = self._read_json_object(path)
        if raw is None:
            return False
        # `<data>/settings.json` is now also the frontend-editable AutoAgent
        # config (model/baseURL/apiKey/apiKeyHelper). Only treat it as legacy
        # when it contains at least one legacy-only field, so a fresh AutoAgent
        # config is never imported as a desktop override.
        if not any(key in raw for key in _LEGACY_SETTINGS_KEYS):
            return False
        patch = _settings_patch_from_legacy(raw)
        try:
            if patch is not None:
                self._settings.update(patch)
        except Exception:
            _LOG.warning("legacy settings import failed", exc_info=True)
            return False
        return True

    def _import_session_file(self, path: Path) -> int | None:
        raw = self._read_json_object(path)
        if raw is None:
            return None
        session_id = raw.get("id")
        if not isinstance(session_id, str) or not session_id:
            return None
        messages_raw = raw.get("messages")
        messages: list[dict[str, Any]] = []
        if isinstance(messages_raw, list):
            for item in messages_raw:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    messages.append(item)
        created = _int_or(raw.get("createdAt"), self._clock.now_ms())
        updated = _int_or(raw.get("updatedAt"), created)
        engine_ref = raw.get("claudeSessionId")
        self._sessions.import_legacy_session(
            session_id=session_id,
            title=str(raw.get("title") or "New chat"),
            created_at=created,
            updated_at=updated,
            messages=messages,
            engine_ref=engine_ref if isinstance(engine_ref, str) else None,
        )
        return len(messages)

    def _read_json_object(self, path: Path) -> dict[str, Any] | None:
        try:
            decoded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _LOG.warning("skipping unreadable legacy file %s", path.name)
            return None
        return decoded if isinstance(decoded, dict) else None

    def _write_log(self, summary: ImportSummary) -> None:
        try:
            self._log_path.parent.mkdir(parents=True, exist_ok=True)
            with self._log_path.open("a", encoding="utf-8") as handle:
                handle.write(
                    "legacy import: "
                    f"sessions={summary.sessions} messages={summary.messages} "
                    f"settings={summary.settings}\n"
                )
        except OSError:
            _LOG.warning("could not write migration log")


def _int_or(value: object, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def _settings_patch_from_legacy(raw: dict[str, Any]) -> SettingsPatch | None:
    mapping = {
        "providerId": "provider_id",
        "model": "model",
        "fallbackModel": "fallback_model",
        "baseURL": "base_url",
        "cwd": "cwd",
        "permissionMode": "permission_mode",
        "thinkingMode": "thinking_mode",
        "effort": "effort",
        "maxThinkingTokens": "max_thinking_tokens",
        "maxTurns": "max_turns",
        "maxBudgetUsd": "max_budget_usd",
        "taskBudget": "task_budget",
        "appendSystemPrompt": "append_system_prompt",
    }
    values: dict[str, object] = {}
    for legacy_key, field_name in mapping.items():
        if legacy_key in raw and raw[legacy_key] is not None:
            values[field_name] = raw[legacy_key]
    for legacy_key, field_name in (
        ("allowedTools", "allowed_tools"),
        ("disallowedTools", "disallowed_tools"),
        ("addDirs", "add_dirs"),
    ):
        value = raw.get(legacy_key)
        if isinstance(value, list):
            values[field_name] = tuple(str(item) for item in value)
    if not values:
        return None
    if values.get("permission_mode") not in (None, "bypassPermissions"):
        # The modern backend supports full access only; keep the import safe.
        values.pop("permission_mode", None)
    return SettingsPatch(**values)  # type: ignore[arg-type]
