"""M2 integration: SubprocessEngine against a scripted Bun CLI.

The fake CLI is real child process speaking NDJSON; no model call occurs.
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from autoagent_backend.adapters.engine.subprocess_engine import (
    EngineOptions,
    SubprocessEngine,
)
from autoagent_backend.domain.events import (
    DomainEvent,
    TextDelta,
    TurnCompleted,
    TurnFailed,
    TurnStarted,
    is_terminal,
)
from autoagent_backend.domain.models import Settings
from autoagent_backend.domain.ports import StartTurnRequest
from autoagent_backend.domain.values import EngineSessionRef

pytestmark = pytest.mark.integration

FAKE_CLI = Path(__file__).resolve().parents[1] / "fixtures" / "fake_cli.js"


def _bun() -> str:
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun is not installed")
    return bun


def _options(tmp_path: Path, *, max_engines: int = 4, cancel_grace_s: float = 0.5) -> EngineOptions:
    return EngineOptions(
        bun_path=Path(_bun()),
        cli_path=FAKE_CLI,
        claude_config_dir=tmp_path / "claude",
        engine_log_dir=tmp_path / "engine-logs",
        max_engines=max_engines,
        cancel_grace_s=cancel_grace_s,
        init_timeout_s=10.0,
    )


def _settings(tmp_path: Path) -> Settings:
    return Settings(cwd=str(tmp_path))


def _collect(
    engine: SubprocessEngine,
    session_id: str,
    text: str = "hello",
    *,
    cwd: Path = Path("/tmp"),
) -> list[DomainEvent]:
    handle = engine.start_turn(
        StartTurnRequest(
            turn_id=str(uuid.uuid4()),
            session_id=session_id,
            text=text,
            settings=Settings(cwd=str(cwd)),
        )
    )
    return list(engine.stream(handle))


def test_engine_round_trip_and_persistent_child(tmp_path: Path) -> None:
    engine = SubprocessEngine(_options(tmp_path))
    session_id = str(uuid.uuid4())
    try:
        first = _collect(engine, session_id, cwd=tmp_path)
        assert isinstance(first[0], TurnStarted)
        assert any(isinstance(event, TextDelta) and event.text == "echo:" for event in first)
        terminal = first[-1]
        assert isinstance(terminal, TurnCompleted)
        assert terminal.text == "echo:hello"
        assert terminal.stop_reason == "end_turn"

        runtime = engine._sessions[session_id]
        assert runtime.child is not None
        first_pid = runtime.child.pid

        second = _collect(engine, session_id, "again", cwd=tmp_path)
        assert isinstance(second[-1], TurnCompleted)
        assert second[-1].text == "echo:again"
        runtime = engine._sessions[session_id]
        assert runtime.child is not None
        assert runtime.child.pid == first_pid
    finally:
        engine.close_all()


def test_child_argv_contains_matebot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("FAKE_CLI_ARGV_FILE", str(argv_file))
    engine = SubprocessEngine(_options(tmp_path))
    try:
        _collect(engine, str(uuid.uuid4()), cwd=tmp_path)
        recorded = json.loads(argv_file.read_text(encoding="utf-8"))
        assert "--matebot" in recorded
        assert "--print" in recorded
        assert "--input-format" in recorded
        assert "stream-json" in recorded
        assert "--dangerously-skip-permissions" in recorded
        assert "--permission-mode" not in recorded
    finally:
        engine.close_all()


def test_process_death_mid_turn_yields_engine_exited(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLI_SCENARIO", "die")
    engine = SubprocessEngine(_options(tmp_path))
    session_id = str(uuid.uuid4())
    try:
        events = _collect(engine, session_id, cwd=tmp_path)
        terminals = [event for event in events if is_terminal(event)]
        assert len(terminals) == 1
        assert isinstance(terminals[0], TurnFailed)
        assert terminals[0].code == "ENGINE_EXITED"
        assert terminals[0].retryable is True

        # The next turn spawns a fresh child and succeeds.
        monkeypatch.delenv("FAKE_CLI_SCENARIO", raising=False)
        restarted = _collect(engine, session_id, "after death", cwd=tmp_path)
        assert isinstance(restarted[-1], TurnCompleted)
        assert restarted[-1].text == "echo:after death"
    finally:
        engine.close_all()


def test_cancel_hanging_child_yields_cancelled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLI_SCENARIO", "hang")
    engine = SubprocessEngine(_options(tmp_path, cancel_grace_s=0.3))
    session_id = str(uuid.uuid4())
    handle = engine.start_turn(
        StartTurnRequest(
            turn_id=str(uuid.uuid4()),
            session_id=session_id,
            text="hang",
            settings=_settings(tmp_path),
        )
    )
    started = time.monotonic()
    engine.cancel(handle)
    assert time.monotonic() - started < 5.0
    events = list(engine.stream(handle))
    assert isinstance(events[-1], TurnCompleted)
    assert events[-1].stop_reason == "cancelled"
    engine.close_all()


def test_doomed_resume_retries_clean_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLI_SCENARIO", "die_once")
    die_file = tmp_path / "die-once"
    die_file.write_text("1", encoding="utf-8")
    monkeypatch.setenv("FAKE_CLI_DIE_FILE", str(die_file))

    engine = SubprocessEngine(_options(tmp_path))
    session_id = str(uuid.uuid4())
    ref = EngineSessionRef("55555555-5555-4555-8555-555555555555")
    # Create a valid transcript so the resume gate allows --resume.
    from autoagent_backend.adapters.engine.resume import transcript_path

    path = transcript_path(tmp_path / "claude", tmp_path, str(ref))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "type": "user",
                "timestamp": datetime.now(UTC).isoformat(),
            }
        )
        + "\n",
        encoding="utf-8",
    )
    try:
        handle = engine.start_turn(
            StartTurnRequest(
                turn_id=str(uuid.uuid4()),
                session_id=session_id,
                text="resume me",
                settings=_settings(tmp_path),
                engine_session_ref=ref,
            )
        )
        events = list(engine.stream(handle))
        assert isinstance(events[-1], TurnCompleted)
        assert events[-1].text == "echo:resume me"
        assert not any(isinstance(event, TurnFailed) for event in events)
        assert sum(isinstance(event, TurnStarted) for event in events) == 1
    finally:
        engine.close_all()


def test_lru_eviction_closes_idle_child(tmp_path: Path) -> None:
    engine = SubprocessEngine(_options(tmp_path, max_engines=1))
    first_session = str(uuid.uuid4())
    second_session = str(uuid.uuid4())
    try:
        assert isinstance(_collect(engine, first_session, cwd=tmp_path)[-1], TurnCompleted)
        first_runtime = engine._sessions[first_session]
        first_child = first_runtime.child
        assert first_child is not None

        assert isinstance(_collect(engine, second_session, cwd=tmp_path)[-1], TurnCompleted)
        assert first_child.alive is False
        assert first_runtime.child is None
    finally:
        engine.close_all()


def test_capacity_error_when_all_children_are_busy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_CLI_SCENARIO", "hang")
    engine = SubprocessEngine(_options(tmp_path, max_engines=1, cancel_grace_s=0.2))
    session_one = str(uuid.uuid4())
    try:
        handle = engine.start_turn(
            StartTurnRequest(
                turn_id=str(uuid.uuid4()),
                session_id=session_one,
                text="hang",
                settings=_settings(tmp_path),
            )
        )
        from autoagent_backend.domain.errors import EngineUnavailable

        with pytest.raises(EngineUnavailable):
            engine.start_turn(
                StartTurnRequest(
                    turn_id=str(uuid.uuid4()),
                    session_id=str(uuid.uuid4()),
                    text="second",
                    settings=_settings(tmp_path),
                )
            )
        engine.cancel(handle)
        list(engine.stream(handle))
    finally:
        engine.close_all()
