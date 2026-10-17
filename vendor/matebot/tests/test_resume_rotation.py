#!/usr/bin/env python3
"""Unit tests for the `--resume` rotation ceilings in opencc_backend.

Unlike test_session_lifecycle.py these spawn nothing and cost no tokens:

    python3 tests/test_resume_rotation.py

What they guard, and why:

  A. A small, recent transcript still resumes. The whole point of SessionStore
     is conversational continuity across restarts; a ceiling that rotates too
     eagerly would silently undo it.

  B. A missing transcript still reports "gone" rather than a rotation reason,
     because that is a different failure and the caller logs the reason.

  C. An oversized transcript refuses to resume. Regression: one chat pinned one
     session id for 33 days, the append-only transcript reached 100MB, and
     `--resume` deserializing it drove RSS past 1GB into GC thrash — the CLI
     hung on startup instead of answering.

  D. An old transcript refuses to resume even while small.

  E. A transcript whose first record has no usable timestamp falls back to the
     size check instead of rotating on a guess.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from opencc_backend import resume_blocker, transcript_path  # noqa: E402

SESSION_ID = "0117ba83-58d7-4972-8868-fc4d3caf3053"
CWD = "/tmp/matebot-rotation-test"


def write_transcript(days_old: float, size: int = 0, timestamp: bool = True) -> Path:
    """Lay down a transcript whose first record is `days_old` days in the past."""
    path = transcript_path(SESSION_ID, CWD)
    path.parent.mkdir(parents=True, exist_ok=True)
    first: dict[str, object] = {"type": "queue-operation"}
    if timestamp:
        started = time.time() - days_old * 86400
        first["timestamp"] = (
            time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(started)) + ".000Z"
        )
    with path.open("w", encoding="utf-8") as fh:
        fh.write(json.dumps(first) + "\n")
        # Pad with whole records so the file stays valid JSONL at any size.
        filler = json.dumps({"type": "user", "pad": "x" * 512}) + "\n"
        while fh.tell() < size:
            fh.write(filler)
    return path


def main() -> int:
    tmp_home = tempfile.mkdtemp(prefix="matebot-home-")
    os.environ["HOME"] = tmp_home  # transcript_path resolves against Path.home()
    Path(CWD).mkdir(parents=True, exist_ok=True)
    failures = 0

    def check(label: str, actual: object, want) -> None:
        nonlocal failures
        ok = want(actual) if callable(want) else actual == want
        print(f"  {'PASS' if ok else 'FAIL'}  {label}: {actual!r}")
        if not ok:
            failures += 1

    print("A. small + recent -> resumes")
    write_transcript(days_old=1, size=4096)
    check("blocker", resume_blocker(SESSION_ID, CWD), None)

    print("B. missing transcript -> gone")
    transcript_path(SESSION_ID, CWD).unlink()
    check("blocker", resume_blocker(SESSION_ID, CWD), "transcript is gone")

    print("C. oversized -> refuses")
    write_transcript(days_old=1, size=8192)
    check(
        "blocker",
        resume_blocker(SESSION_ID, CWD, max_bytes=4096),
        lambda r: r is not None and "limit" in r,
    )
    check(
        "under a higher ceiling it still resumes",
        resume_blocker(SESSION_ID, CWD, max_bytes=1 << 20),
        None,
    )

    print("D. old but small -> refuses")
    write_transcript(days_old=33, size=4096)
    check(
        "blocker",
        resume_blocker(SESSION_ID, CWD, max_age_days=14),
        lambda r: r is not None and "days old" in r,
    )

    print("E. no timestamp -> size check only, no guessing")
    write_transcript(days_old=33, size=4096, timestamp=False)
    check("blocker", resume_blocker(SESSION_ID, CWD, max_age_days=14), None)

    print("F. no session id -> refuses")
    check("blocker", resume_blocker(None, CWD), "no session id")

    print(f"\n{'FAILED' if failures else 'ALL PASSED'} ({failures} failure(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
