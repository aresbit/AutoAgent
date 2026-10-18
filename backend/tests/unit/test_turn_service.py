"""M2: turn state machine with fakes (no DB, no subprocess)."""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Iterator, Sequence
from pathlib import Path

import pytest

from autoagent_backend.adapters.artifacts.fs_store import FilesystemArtifactStore
from autoagent_backend.adapters.engine.fake_engine import FakeEngine
from autoagent_backend.api.sse import project_event
from autoagent_backend.application.turn_service import TurnService
from autoagent_backend.domain.errors import (
    EngineUnavailable,
    TurnAlreadyFinished,
    TurnInProgress,
)
from autoagent_backend.domain.events import (
    DomainEvent,
    TextDelta,
    TurnCompleted,
    TurnFailed,
    TurnStarted,
    is_terminal,
)
from autoagent_backend.domain.models import EngineStatus, Settings, TurnState
from autoagent_backend.domain.ports import StartTurnRequest, TurnHandle
from autoagent_backend.domain.values import EngineSessionRef

from ..fixtures.memory import FakeClock, InMemorySettings, InMemoryStore


def make_service(
    tmp_path: Path,
    engine: object,
    *,
    cancel_wait_s: float = 0.2,
    artifacts: object | None = None,
) -> tuple[TurnService, InMemoryStore]:
    clock = FakeClock()
    store = InMemoryStore(clock)
    settings = InMemorySettings(Settings(cwd=str(tmp_path)))
    service = TurnService(
        sessions=store,
        turns=store,
        refs=store,
        engine=engine,  # type: ignore[arg-type]
        settings=settings,
        clock=clock,
        artifacts=artifacts,  # type: ignore[arg-type]
        cancel_wait_s=cancel_wait_s,
    )
    return service, store


def drain(subscription: object, limit: int = 200) -> list[DomainEvent]:
    events: list[DomainEvent] = []
    for _ in range(limit):
        event, ended = subscription.next_event(2.0)  # type: ignore[attr-defined]
        if event is None:
            if ended:
                break
            continue
        events.append(event)
        if is_terminal(event):
            break
    return events


def wait_terminal(service: TurnService, turn_id: str) -> None:
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if service.status(turn_id).state is not TurnState.RUNNING:
            return
        time.sleep(0.01)


def test_completed_turn_streams_and_persists(tmp_path: Path) -> None:
    service, store = make_service(tmp_path, FakeEngine())
    session = store.create("test")
    turn_id = str(uuid.uuid4())

    subscription = service.start(turn_id, session.id, "hello")
    events = drain(subscription)

    assert events[0].__class__.__name__ == "TurnStarted"
    terminals = [event for event in events if is_terminal(event)]
    assert len(terminals) == 1
    terminal = terminals[0]
    assert isinstance(terminal, TurnCompleted)
    assert terminal.stop_reason == "end_turn"
    assert terminal.message_id is not None

    status = service.status(turn_id)
    assert status.state is TurnState.COMPLETED
    assert status.assistant_message_id == terminal.message_id
    stored = store.get(session.id)
    assert [message.role for message in stored.messages] == ["user", "assistant"]
    assert store.get_ref(session.id) is not None


def test_duplicate_terminal_turn_id_is_rejected(tmp_path: Path) -> None:
    service, store = make_service(tmp_path, FakeEngine())
    session = store.create()
    turn_id = str(uuid.uuid4())
    drain(service.start(turn_id, session.id, "hello"))

    with pytest.raises(TurnAlreadyFinished):
        service.start(turn_id, session.id, "again")


def test_second_turn_for_one_session_is_rejected(tmp_path: Path) -> None:
    engine = FakeEngine(delay_s=0.2)
    service, store = make_service(tmp_path, engine)
    session = store.create()
    first = str(uuid.uuid4())

    subscription = service.start(first, session.id, "one")
    with pytest.raises(TurnInProgress):
        service.start(str(uuid.uuid4()), session.id, "two")

    service.cancel(first)
    drain(subscription)
    status = service.status(first)
    assert status.state is TurnState.CANCELLED


def test_cancel_is_idempotent_and_terminal_is_cancelled(tmp_path: Path) -> None:
    service, store = make_service(tmp_path, FakeEngine(delay_s=0.1))
    session = store.create()
    turn_id = str(uuid.uuid4())

    subscription = service.start(turn_id, session.id, "hello")
    service.cancel(turn_id)
    service.cancel(turn_id)
    events = drain(subscription)

    terminals = [event for event in events if is_terminal(event)]
    assert len(terminals) == 1
    terminal = terminals[0]
    assert isinstance(terminal, TurnCompleted)
    assert terminal.stop_reason == "cancelled"
    assert service.status(turn_id).state is TurnState.CANCELLED


def test_cancel_is_guaranteed_even_if_adapter_ignores_it(tmp_path: Path) -> None:
    engine = _IgnoringCancelEngine()
    service, store = make_service(tmp_path, engine, cancel_wait_s=0.1)
    session = store.create()
    turn_id = str(uuid.uuid4())

    subscription = service.start(turn_id, session.id, "hello")
    service.cancel(turn_id)
    events = drain(subscription)
    terminals = [event for event in events if is_terminal(event)]
    assert len(terminals) == 1
    terminal = terminals[0]
    assert isinstance(terminal, TurnCompleted)
    assert terminal.stop_reason == "cancelled"
    assert service.status(turn_id).state is TurnState.CANCELLED


def test_engine_start_failure_yields_exactly_one_terminal(tmp_path: Path) -> None:
    service, store = make_service(tmp_path, _FailingEngine())
    session = store.create()
    turn_id = str(uuid.uuid4())

    events = drain(service.start(turn_id, session.id, "hello"))
    terminals = [event for event in events if is_terminal(event)]
    assert len(terminals) == 1
    assert isinstance(terminals[0], TurnFailed)
    assert terminals[0].code == "ENGINE_UNAVAILABLE"
    assert service.status(turn_id).state is TurnState.FAILED


def test_process_death_event_is_forwarded_verbatim(tmp_path: Path) -> None:
    service, store = make_service(tmp_path, _DeathEngine())
    session = store.create()
    turn_id = str(uuid.uuid4())

    events = drain(service.start(turn_id, session.id, "hello"))
    assert isinstance(events[0], TurnStarted)
    assert isinstance(events[-1], TurnFailed)
    assert events[-1].code == "ENGINE_EXITED"
    assert events[-1].retryable is True


def test_runner_continues_after_subscriber_disconnect(tmp_path: Path) -> None:
    service, store = make_service(tmp_path, FakeEngine())
    session = store.create()
    turn_id = str(uuid.uuid4())

    service.start(turn_id, session.id, "hello")
    # Simulate an SSE client that disconnects without reading the stream.
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if service.status(turn_id).state is not TurnState.RUNNING:
            break
        time.sleep(0.02)
    assert service.status(turn_id).state is TurnState.COMPLETED
    stored = store.get(session.id)
    assert any(message.role == "assistant" for message in stored.messages)


def _artifact_script(text: str):
    def factory(turn_id: str, session_id: str) -> tuple[DomainEvent, ...]:
        return (
            TurnStarted(turn_id=turn_id, session_id=session_id, model="fake"),
            TextDelta(turn_id=turn_id, session_id=session_id, text=text),
            TurnCompleted(
                turn_id=turn_id,
                session_id=session_id,
                stop_reason="end_turn",
                text=text,
            ),
        )

    return factory


ARTIFACT_TEXT = (
    "Here is your artifact.\n\n"
    "```artifact-html\n"
    "---\n"
    "title: Demo\n"
    "description: A demo\n"
    "---\n"
    "<h1>Hello</h1>\n"
    "```\n"
)


def test_completed_turn_materializes_artifacts(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FakeClock())
    service, sessions = make_service(
        tmp_path,
        FakeEngine(script_factory=_artifact_script(ARTIFACT_TEXT)),
        artifacts=store,
    )
    session = sessions.create("test")
    turn_id = str(uuid.uuid4())

    terminal = next(
        event
        for event in drain(service.start(turn_id, session.id, "hello"))
        if is_terminal(event)
    )
    assert isinstance(terminal, TurnCompleted)
    assert terminal.message_id is not None
    assert len(terminal.artifacts) == 1
    created = terminal.artifacts[0]
    assert created.__class__.__name__ == "ArtifactCreated"
    assert created.artifact.id == "demo"
    assert created.artifact.message_id == terminal.message_id
    assert created.artifact.session_id == session.id
    assert created.artifact.revision == "v1"

    names = [
        name
        for name, _ in project_event(
            terminal, session_id=session.id, seq=1, ts=1
        )
    ]
    assert names == ["message.completed", "artifact.created", "turn.completed"]


def test_second_turn_emits_artifact_updated(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FakeClock())
    first_text = ARTIFACT_TEXT
    second_text = ARTIFACT_TEXT.replace("<h1>Hello</h1>", "<h1>Changed</h1>")
    scripts = [_artifact_script(first_text), _artifact_script(second_text)]

    def script_factory(
        turn_id: str, session_id: str
    ) -> Sequence[DomainEvent]:
        return scripts.pop(0)(turn_id, session_id)

    engine = FakeEngine(script_factory=script_factory)
    service, sessions = make_service(tmp_path, engine, artifacts=store)
    session = sessions.create("test")

    first = next(
        event
        for event in drain(service.start(str(uuid.uuid4()), session.id, "one"))
        if is_terminal(event)
    )
    assert first.artifacts[0].__class__.__name__ == "ArtifactCreated"
    wait_terminal(service, first.turn_id)

    second = next(
        event
        for event in drain(service.start(str(uuid.uuid4()), session.id, "two"))
        if is_terminal(event)
    )
    assert isinstance(second, TurnCompleted)
    assert second.artifacts[0].__class__.__name__ == "ArtifactUpdated"
    assert second.artifacts[0].revision == "v2"

    names = [
        name
        for name, _ in project_event(
            second, session_id=session.id, seq=1, ts=1
        )
    ]
    assert names == ["message.completed", "artifact.updated", "turn.completed"]
    assert store.get("demo").revision == "v2"


def test_materialization_failure_does_not_fail_turn(tmp_path: Path) -> None:
    class BrokenStore:
        def save_materialized(self, *args: object, **kwargs: object) -> object:
            raise RuntimeError("disk exploded")

    service, sessions = make_service(
        tmp_path,
        FakeEngine(script_factory=_artifact_script(ARTIFACT_TEXT)),
        artifacts=BrokenStore(),
    )
    session = sessions.create("test")
    turn_id = str(uuid.uuid4())

    events = drain(service.start(turn_id, session.id, "hello"))
    terminal = [event for event in events if is_terminal(event)]
    assert len(terminal) == 1
    assert isinstance(terminal[0], TurnCompleted)
    assert terminal[0].artifacts == ()
    assert service.status(turn_id).state is TurnState.COMPLETED


class _FailingEngine:
    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        raise EngineUnavailable("no engine")

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        return
        yield  # pragma: no cover

    def cancel(self, handle: TurnHandle) -> None:
        return

    def status(self) -> EngineStatus:
        return EngineStatus()

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        return None

    def close(self, session_id: str) -> None:
        return


class _DeathEngine:
    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        return TurnHandle(turn_id=request.turn_id, session_id=request.session_id)

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        yield TurnStarted(
            turn_id=handle.turn_id,
            session_id=handle.session_id,
            model="m",
        )
        yield TurnFailed(
            turn_id=handle.turn_id,
            session_id=handle.session_id,
            code="ENGINE_EXITED",
            message="engine exited",
            retryable=True,
        )

    def cancel(self, handle: TurnHandle) -> None:
        return

    def status(self) -> EngineStatus:
        return EngineStatus()

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        return None

    def close(self, session_id: str) -> None:
        return


class _IgnoringCancelEngine:
    """Ignores cancel and emits its terminal only after a delay."""

    def __init__(self) -> None:
        self._release = threading.Event()

    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        return TurnHandle(turn_id=request.turn_id, session_id=request.session_id)

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        yield TurnStarted(
            turn_id=handle.turn_id,
            session_id=handle.session_id,
            model="m",
        )
        self._release.wait(timeout=0.5)
        yield TurnCompleted(
            turn_id=handle.turn_id,
            session_id=handle.session_id,
            stop_reason="end_turn",
            text="late",
        )

    def cancel(self, handle: TurnHandle) -> None:
        # Deliberately does not unblock the stream.
        return

    def status(self) -> EngineStatus:
        return EngineStatus()

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        return None

    def close(self, session_id: str) -> None:
        return
