"""MateBotEngine with an injected fake session factory (no subprocess)."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, ClassVar

import pytest

from autoagent_backend.adapters.engine.matebot_engine import (
    MateBotEngine,
    SessionLike,
    build_matebot_session_factory,
    load_vendored_matebot_module,
)
from autoagent_backend.domain.errors import EngineUnavailable
from autoagent_backend.domain.events import (
    DomainEvent,
    TextDelta,
    TurnCompleted,
    TurnFailed,
    TurnStarted,
    UsageReported,
    is_terminal,
)
from autoagent_backend.domain.models import EngineState, Settings
from autoagent_backend.domain.ports import StartTurnRequest
from autoagent_backend.domain.values import EngineSessionRef

REF = "77777777-7777-4777-8777-777777777777"
VENDOR = Path(__file__).resolve().parents[3] / "vendor" / "matebot" / "opencc_backend.py"
FAKE_CLI = Path(__file__).resolve().parents[1] / "fixtures" / "fake_cli.js"


class FakeRefs:
    def __init__(self) -> None:
        self.refs: dict[str, EngineSessionRef | None] = {}

    def get_ref(self, session_id: str) -> EngineSessionRef | None:
        return self.refs.get(session_id)

    def set_ref(self, session_id: str, ref: EngineSessionRef | None) -> None:
        self.refs[session_id] = ref


class FakeSession:
    instances: ClassVar[list[FakeSession]] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.on_event = kwargs["on_event"]
        self.on_stderr = kwargs["on_stderr"]
        self.on_close = kwargs["on_close"]
        self.on_session_id = kwargs["on_session_id"]
        self.sent: list[str] = []
        self.interrupted = False
        self.closed = False
        self.running = True
        self.mode = "normal"
        FakeSession.instances.append(self)

    @property
    def is_running(self) -> bool:
        return self.running

    def send(self, text: str) -> None:
        self.sent.append(text)
        session_id = self.kwargs.get("session_id") or REF
        self.on_event(
            {
                "type": "system",
                "subtype": "init",
                "session_id": session_id,
                "model": "fake-session-model",
                "claude_code_version": "2.1.888",
            }
        )
        if self.mode == "death":
            self.running = False
            self.on_close(1)
            return
        if self.mode == "hang":
            return
        self.on_event(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "echo:"},
                },
                "session_id": session_id,
            }
        )
        self.on_event(
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "echo:" + text}],
                },
                "session_id": session_id,
            }
        )
        self.on_session_id(session_id)
        self.on_event(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "echo:" + text,
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 2, "output_tokens": 3},
                "session_id": session_id,
            }
        )

    def send_interrupt(self) -> None:
        self.interrupted = True

    def close(self) -> None:
        self.closed = True
        self.running = False


def _factory(modes: list[str] | None = None) -> Callable[..., SessionLike]:
    queue = list(modes or ["normal"])

    def factory(**kwargs: Any) -> SessionLike:
        session = FakeSession(**kwargs)
        if queue:
            session.mode = queue.pop(0)
        return session

    return factory


def _engine(
    tmp_path: Path,
    *,
    modes: list[str] | None = None,
    max_sessions: int = 4,
    cancel_grace_s: float = 0.05,
    refs: FakeRefs | None = None,
) -> tuple[MateBotEngine, FakeRefs]:
    store = refs or FakeRefs()
    engine = MateBotEngine(
        session_factory=_factory(modes),
        refs=store,
        max_sessions=max_sessions,
        cancel_grace_s=cancel_grace_s,
    )
    return engine, store


def _request(
    tmp_path: Path,
    session_id: str,
    text: str = "hello",
    ref: EngineSessionRef | None = None,
) -> StartTurnRequest:
    return StartTurnRequest(
        turn_id=str(uuid.uuid4()),
        session_id=session_id,
        text=text,
        settings=Settings(cwd=str(tmp_path)),
        engine_session_ref=ref,
    )


def _drain(engine: MateBotEngine, handle: object) -> list[DomainEvent]:
    return list(engine.stream(handle))  # type: ignore[arg-type]


def test_start_stream_and_ref_persistence(tmp_path: Path) -> None:
    FakeSession.instances.clear()
    engine, refs = _engine(tmp_path)
    session_id = str(uuid.uuid4())
    try:
        events = _drain(engine, engine.start_turn(_request(tmp_path, session_id)))
        assert [type(event) for event in events] == [
            TurnStarted,
            TextDelta,
            UsageReported,
            TurnCompleted,
        ]
        assert events[-1].text == "echo:hello"
        assert refs.refs[session_id] == EngineSessionRef(REF)
        assert engine.session_ref(session_id) == EngineSessionRef(REF)
        assert engine.status().state is EngineState.IDLE
        assert engine.status().version == "2.1.888"
        assert FakeSession.instances[0].sent == ["hello"]
    finally:
        engine.close_all()


def test_resume_ref_is_passed_to_new_session(tmp_path: Path) -> None:
    FakeSession.instances.clear()
    stored = EngineSessionRef("88888888-8888-4888-8888-888888888888")
    refs = FakeRefs()
    session_id = str(uuid.uuid4())
    refs.refs[session_id] = stored
    engine, _ = _engine(tmp_path, refs=refs)
    try:
        _drain(engine, engine.start_turn(_request(tmp_path, session_id)))
        assert FakeSession.instances[0].kwargs["session_id"] == str(stored)
    finally:
        engine.close_all()


def test_cancel_synthesizes_cancelled_and_closes(tmp_path: Path) -> None:
    FakeSession.instances.clear()
    engine, _ = _engine(tmp_path, modes=["hang"], cancel_grace_s=0.05)
    session_id = str(uuid.uuid4())
    handle = engine.start_turn(_request(tmp_path, session_id))
    try:
        engine.cancel(handle)
        events = _drain(engine, handle)
        terminals = [event for event in events if is_terminal(event)]
        assert len(terminals) == 1
        assert isinstance(terminals[0], TurnCompleted)
        assert terminals[0].stop_reason == "cancelled"
        session = FakeSession.instances[0]
        assert session.interrupted is True
        assert session.closed is True
        # A subsequent start recreates the session.
        assert engine.status().state is EngineState.IDLE
    finally:
        engine.close_all()


def test_lru_evicts_idle_session(tmp_path: Path) -> None:
    FakeSession.instances.clear()
    engine, _ = _engine(tmp_path, max_sessions=1)
    first_session = str(uuid.uuid4())
    second_session = str(uuid.uuid4())
    try:
        _drain(engine, engine.start_turn(_request(tmp_path, first_session)))
        assert FakeSession.instances[0].closed is False
        _drain(engine, engine.start_turn(_request(tmp_path, second_session)))
        assert FakeSession.instances[0].closed is True
        assert len(FakeSession.instances) == 2
    finally:
        engine.close_all()


def test_capacity_error_when_all_sessions_busy(tmp_path: Path) -> None:
    FakeSession.instances.clear()
    engine, _ = _engine(tmp_path, modes=["hang"], max_sessions=1)
    first = engine.start_turn(_request(tmp_path, str(uuid.uuid4())))
    try:
        with pytest.raises(EngineUnavailable):
            engine.start_turn(_request(tmp_path, str(uuid.uuid4())))
        engine.cancel(first)
        _drain(engine, first)
    finally:
        engine.close_all()


def test_session_death_fails_turn_and_next_turn_recreates(tmp_path: Path) -> None:
    FakeSession.instances.clear()
    engine, _ = _engine(tmp_path, modes=["death", "normal"])
    session_id = str(uuid.uuid4())
    try:
        events = _drain(
            engine, engine.start_turn(_request(tmp_path, session_id, "dies"))
        )
        failure = events[-1]
        assert isinstance(failure, TurnFailed)
        assert failure.code == "ENGINE_EXITED"
        assert failure.retryable is True

        again = _drain(
            engine, engine.start_turn(_request(tmp_path, session_id, "revives"))
        )
        assert isinstance(again[-1], TurnCompleted)
        assert again[-1].text == "echo:revives"
        assert len(FakeSession.instances) == 2
    finally:
        engine.close_all()


def test_vendored_module_loads_by_path() -> None:
    module = load_vendored_matebot_module(VENDOR)
    assert hasattr(module, "OpenccSession")
    factory = build_matebot_session_factory(
        vendor_path=VENDOR,
        cli_path=FAKE_CLI,
        bun_path=Path("/usr/bin/bun"),
    )
    session = factory(
        session_id=None,
        cwd=None,
        model=None,
        append_system_prompt=None,
        on_event=lambda frame: None,
        on_stderr=lambda line: None,
        on_close=lambda code: None,
        on_session_id=lambda value: None,
    )
    assert session.cli_path == FAKE_CLI
    session.close()
