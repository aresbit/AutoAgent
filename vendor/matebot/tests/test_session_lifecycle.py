#!/usr/bin/env python3
"""Live regression tests for the OpenCC long-lived session.

These spawn the real CLI and cost real tokens — they are not unit tests. Run
them after touching opencc_backend.py, session_store.py, or the registry:

    python3 tests/test_session_lifecycle.py

What they guard, and why each one exists:

  A. One chat spawns ONE process, reused across turns.
     Regression: the configured CLI path did not exist, so every spawn died
     instantly and every message quietly started a new session. The bot still
     answered, so nothing looked broken — it had just silently lost its memory
     between every single message.

  B. The conversation survives process death via a persisted session_id.
     Regression: session_id lived only in memory, so a bridge restart began a
     blank conversation.

  C. The workspace identity actually reaches the model.

  D. A session_id whose transcript is gone starts fresh instead of bricking
     the chat with a process that exits ~0.6s after every message.
"""

from __future__ import annotations

import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from opencc_backend import OpenccSession, can_resume  # noqa: E402
from session_store import SessionStore  # noqa: E402
from soul import Workspace  # noqa: E402

TURN_TIMEOUT_S = 90
CHAT = "test_chat"

_tmp = Path(tempfile.mkdtemp(prefix="matebot-test-"))
_ws = Workspace(_tmp / "ws")
_ws.ensure_scaffold()
_store = SessionStore(_tmp / "sessions")

_done = threading.Event()
_results: list[str] = []


def _make_session(**kwargs) -> OpenccSession:
    def on_event(event: dict) -> None:
        if event.get("type") == "result":
            _results.append(str(event.get("result", "")))
            _done.set()

    return OpenccSession(
        on_event=on_event,
        on_stderr=lambda line: print(f"    [stderr] {line[:160]}"),
        on_close=lambda code: print(f"    [exit] {code}"),
        on_session_id=lambda sid: _store.set_session_id(CHAT, sid),
        cwd="/tmp",
        append_system_prompt=_ws.system_prompt(),
        **kwargs,
    )


def _turn(session: OpenccSession, prompt: str, label: str) -> str:
    _done.clear()
    _results.clear()
    session.send(prompt)
    if not _done.wait(TURN_TIMEOUT_S):
        raise AssertionError(f"{label}: no result within {TURN_TIMEOUT_S}s")
    time.sleep(0.5)
    reply = _results[-1]
    print(f"    {label}: {reply[:100]!r}")
    return reply


def test_one_process_per_chat() -> OpenccSession:
    print("A. one long-lived process across turns")
    s = _make_session()
    _turn(s, "记住这个暗号: 紫貂七号。只回复 OK", "turn1")
    assert s.is_running, "process died after the first turn"
    assert s.spawn_count == 1, f"spawned {s.spawn_count} times for one turn"

    reply = _turn(s, "暗号是什么？只回答暗号本身", "turn2")
    assert s.spawn_count == 1, (
        f"REGRESSION: process respawned mid-conversation "
        f"({s.spawn_count} spawns) — the long link is broken"
    )
    assert "紫貂" in reply, f"context lost inside one process: {reply!r}"
    print("    ✅ one process, context kept\n")
    return s


def test_survives_process_death(previous: OpenccSession) -> OpenccSession:
    print("B. conversation survives process death")
    persisted = _store.get_session_id(CHAT)
    assert persisted, "session_id was never persisted to disk"
    assert can_resume(persisted, "/tmp"), "transcript missing for a live session"

    previous.close()
    time.sleep(1)
    assert not previous.is_running

    s = _make_session(session_id=persisted)
    reply = _turn(s, "暗号是什么？只回答暗号本身", "turn3")
    assert "紫貂" in reply, f"context lost across restart: {reply!r}"
    print("    ✅ resumed after the process died\n")
    return s


def test_soul_is_applied(s: OpenccSession) -> None:
    print("C. workspace identity reaches the model")
    reply = _turn(s, "你叫什么名字？只回答名字", "turn4")
    assert any(n in reply for n in ("MateBot", "小 M", "小M")), (
        f"SOUL.md / IDENTITY.md did not take effect: {reply!r}"
    )
    print("    ✅ identity applied\n")


def test_stale_session_id_recovers() -> None:
    print("D. stale session_id does not brick the chat")
    dead = "00000000-0000-4000-8000-000000000000"
    assert not can_resume(dead, "/tmp")

    s = _make_session(session_id=dead)
    reply = _turn(s, "只回复 RECOVERED", "turn5")
    assert reply.strip(), "stale resume produced an empty reply"
    assert s.is_running, "process died instead of starting fresh"
    print("    ✅ started fresh instead of failing\n")
    s.close()


def main() -> int:
    print(f"workspace: {_ws.root}\nsessions:  {_store.dir}\n")
    live = test_one_process_per_chat()
    live = test_survives_process_death(live)
    test_soul_is_applied(live)
    live.close()
    test_stale_session_id_recovers()
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
