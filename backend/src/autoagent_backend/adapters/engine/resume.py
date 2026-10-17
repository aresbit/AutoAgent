"""Resume gates: 25 MiB transcript ceiling and 14 day session age ceiling.

A refused ref is cleared by the caller and the turn proceeds with a fresh
transcript rather than failing.
"""

from __future__ import annotations

import json
import re
import stat
import time
from datetime import UTC, datetime
from pathlib import Path

MAX_RESUME_BYTES = 25 * 1024 * 1024
MAX_RESUME_AGE_DAYS = 14
_FIRST_LINE_LIMIT = 64 * 1024


def transcript_path(config_dir: Path, cwd: str | Path, session_id: str) -> Path:
    """Return the CLI's transcript path.

    Layout: ``<config>/projects/<cwd with '/' and '.' as '-'>/<uuid>.jsonl``.
    """

    slug = re.sub(r"[/.]", "-", str(Path(cwd).resolve()))
    return config_dir / "projects" / slug / f"{session_id}.jsonl"


def session_started_at(path: Path) -> float | None:
    """Read the first record's ISO timestamp; ``None`` when undeterminable."""

    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            first = handle.readline(_FIRST_LINE_LIMIT)
    except OSError:
        return None
    try:
        stamp = json.loads(first).get("timestamp")
    except (ValueError, AttributeError):
        return None
    if not isinstance(stamp, str):
        return None
    try:
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp()


def resume_blocker(
    session_id: str | None,
    cwd: str | Path,
    *,
    config_dir: Path,
    max_bytes: int = MAX_RESUME_BYTES,
    max_age_days: float = MAX_RESUME_AGE_DAYS,
    now_s: float | None = None,
) -> str | None:
    """Return why ``--resume`` must not be attempted, or ``None`` if allowed.

    Pre: ``config_dir`` is the same CLAUDE_CONFIG_DIR the child receives.
    Post: the check performs only a bounded read of the first transcript line.
    """

    if not session_id:
        return "no session id"
    try:
        path = transcript_path(config_dir, cwd, session_id)
    except OSError:
        return None
    try:
        info = path.stat()
    except FileNotFoundError:
        return "transcript is gone"
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return "transcript is not a regular file"
    if max_bytes and info.st_size >= max_bytes:
        return f"transcript is {info.st_size} bytes (limit {max_bytes})"
    if max_age_days:
        started = session_started_at(path)
        if started is not None:
            current = time.time() if now_s is None else now_s
            age_days = (current - started) / 86400
            if age_days >= max_age_days:
                return f"session is {age_days:.0f} days old (limit {max_age_days:g})"
    return None


def can_resume(
    session_id: str | None,
    cwd: str | Path,
    *,
    config_dir: Path,
    max_bytes: int = MAX_RESUME_BYTES,
    max_age_days: float = MAX_RESUME_AGE_DAYS,
    now_s: float | None = None,
) -> bool:
    return (
        resume_blocker(
            session_id,
            cwd,
            config_dir=config_dir,
            max_bytes=max_bytes,
            max_age_days=max_age_days,
            now_s=now_s,
        )
        is None
    )
