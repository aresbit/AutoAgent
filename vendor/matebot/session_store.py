"""Durable chat_id → claude session_id mapping.

Without this, every bridge restart starts a blank conversation: the CLI's
session_id was only ever held in memory. Persisting it lets a respawn (crash,
deploy, reboot) resume the same transcript with `--resume`, so "记忆持久化"
survives process death rather than just process lifetime.

Stored as one small JSON file per chat under `~/.matecode/sessions/`, written
atomically so a crash mid-write can't leave a truncated file behind.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

DEFAULT_DIR = Path.home() / ".matecode" / "sessions"

# claude session ids are UUIDs; refuse anything else so a malformed value can't
# be spliced into the CLI argv.
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def is_valid_session_id(value: Optional[str]) -> bool:
    return bool(value) and bool(_UUID_RE.match(value or ""))


class SessionStore:
    """Persists the last known session id (and a little context) per chat."""

    def __init__(self, directory: Optional[Path] = None):
        self.dir = Path(directory) if directory else DEFAULT_DIR
        self._lock = threading.Lock()

    def _path(self, chat_id: str) -> Path:
        # chat ids are opaque strings from Feishu/Telegram; keep them filesystem-safe.
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(chat_id))[:120] or "default"
        return self.dir / f"{safe}.json"

    def load(self, chat_id: str) -> dict:
        path = self._path(chat_id)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def get_session_id(self, chat_id: str) -> Optional[str]:
        sid = self.load(chat_id).get("session_id")
        return sid if is_valid_session_id(sid) else None

    def save(self, chat_id: str, **fields) -> None:
        """Merge `fields` into the stored record for `chat_id`."""
        with self._lock:
            record = self.load(chat_id)
            record.update(fields)
            record["updated_at"] = int(time.time())
            path = self._path(chat_id)
            tmp = path.with_suffix(".json.tmp")
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp.write_text(
                    json.dumps(record, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                os.replace(tmp, path)
            except OSError as e:
                print(f"[session-store] write failed for {chat_id}: {e}")

    def set_session_id(self, chat_id: str, session_id: str, **extra) -> None:
        if not is_valid_session_id(session_id):
            return
        self.save(chat_id, session_id=session_id, **extra)

    def clear(self, chat_id: str) -> None:
        with self._lock:
            try:
                self._path(chat_id).unlink()
            except OSError:
                pass


__all__ = ["SessionStore", "DEFAULT_DIR", "is_valid_session_id"]
