"""M2: resume gates (25 MiB, 14 days, missing/non-regular transcripts)."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from pathlib import Path

from autoagent_backend.adapters.engine.resume import (
    MAX_RESUME_AGE_DAYS,
    MAX_RESUME_BYTES,
    can_resume,
    resume_blocker,
    session_started_at,
    transcript_path,
)

SESSION = "11111111-1111-4111-8111-111111111111"


def _write_transcript(
    config_dir: Path, cwd: Path, *, timestamp: str | None = None, size: int = 0
) -> Path:
    path = transcript_path(config_dir, cwd, SESSION)
    path.parent.mkdir(parents=True, exist_ok=True)
    record: dict[str, object] = {"type": "user"}
    if timestamp is not None:
        record["timestamp"] = timestamp
    payload = json.dumps(record) + "\n"
    if size > len(payload):
        payload += "x" * (size - len(payload) - 1) + "\n"
    path.write_text(payload, encoding="utf-8")
    return path


def test_transcript_path_slug(tmp_path: Path) -> None:
    path = transcript_path(tmp_path / "cfg", "/work/project.v2", SESSION)
    assert path == tmp_path / "cfg" / "projects" / "-work-project-v2" / f"{SESSION}.jsonl"


def test_missing_transcript_is_refused(tmp_path: Path) -> None:
    assert resume_blocker(SESSION, tmp_path, config_dir=tmp_path / "cfg") == (
        "transcript is gone"
    )


def test_regular_fresh_transcript_is_allowed(tmp_path: Path) -> None:
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(now))
    _write_transcript(tmp_path / "cfg", tmp_path, timestamp=stamp)
    assert resume_blocker(SESSION, tmp_path, config_dir=tmp_path / "cfg") is None
    assert can_resume(SESSION, tmp_path, config_dir=tmp_path / "cfg") is True


def test_oversized_transcript_is_refused(tmp_path: Path) -> None:
    _write_transcript(tmp_path / "cfg", tmp_path, size=1024)
    blocker = resume_blocker(
        SESSION, tmp_path, config_dir=tmp_path / "cfg", max_bytes=1024
    )
    assert blocker is not None
    assert "limit" in blocker


def test_25_mib_constant() -> None:
    assert MAX_RESUME_BYTES == 25 * 1024 * 1024
    assert MAX_RESUME_AGE_DAYS == 14


def test_old_transcript_is_refused(tmp_path: Path) -> None:
    stamp = "2020-01-01T00:00:00+00:00"
    _write_transcript(tmp_path / "cfg", tmp_path, timestamp=stamp)
    blocker = resume_blocker(SESSION, tmp_path, config_dir=tmp_path / "cfg")
    assert blocker is not None
    assert "days old" in blocker


def test_non_regular_transcript_is_refused(tmp_path: Path) -> None:
    path = transcript_path(tmp_path / "cfg", tmp_path, SESSION)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir()
    assert resume_blocker(SESSION, tmp_path, config_dir=tmp_path / "cfg") == (
        "transcript is not a regular file"
    )


def test_missing_session_id_is_refused(tmp_path: Path) -> None:
    assert resume_blocker(None, tmp_path, config_dir=tmp_path / "cfg") == (
        "no session id"
    )


def test_session_started_at_parses_first_record(tmp_path: Path) -> None:
    path = _write_transcript(
        tmp_path / "cfg", tmp_path, timestamp="2026-01-02T03:04:05Z"
    )
    started = session_started_at(path)
    assert started is not None
    assert int(started) == int(
        datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC).timestamp()
    )
