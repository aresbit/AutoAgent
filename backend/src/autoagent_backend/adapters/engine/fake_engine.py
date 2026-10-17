"""Deterministic in-process engine used by ``AUTOAGENT_ENGINE=fake`` and tests.

No subprocess, no network, no model call. The event sequence mirrors what the
real adapter produces so the SSE projection can be exercised end to end.
"""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable, Iterator, Sequence

from ...domain.errors import EngineUnavailable
from ...domain.events import (
    DomainEvent,
    TextDelta,
    ThinkingDelta,
    ToolFinished,
    ToolStarted,
    TurnCompleted,
    TurnFailed,
    TurnStarted,
    UsageReported,
    is_terminal,
)
from ...domain.models import EngineState, EngineStatus
from ...domain.ports import StartTurnRequest, TurnHandle
from ...domain.values import EngineSessionRef

ScriptFactory = Callable[[str, str], Sequence[DomainEvent]]


def default_script(turn_id: str, session_id: str) -> Sequence[DomainEvent]:
    return (
        TurnStarted(turn_id=turn_id, session_id=session_id, model="fake-model"),
        TextDelta(turn_id=turn_id, text="Hello ", session_id=session_id),
        ThinkingDelta(
            turn_id=turn_id, text="planning the reply", session_id=session_id
        ),
        TextDelta(turn_id=turn_id, text="from FakeEngine.", session_id=session_id),
        ToolStarted(
            turn_id=turn_id,
            call_ref="call_1",
            name="Bash",
            input={"command": "echo hi"},
            session_id=session_id,
        ),
        ToolFinished(
            turn_id=turn_id,
            call_ref="call_1",
            name="Bash",
            ok=True,
            text="hi",
            session_id=session_id,
        ),
        UsageReported(
            turn_id=turn_id,
            input_tokens=120,
            output_tokens=24,
            session_id=session_id,
        ),
        TurnCompleted(
            turn_id=turn_id,
            session_id=session_id,
            stop_reason="end_turn",
            text="Hello from FakeEngine.",
        ),
    )


class _FakeTurn:
    def __init__(self, handle: TurnHandle) -> None:
        self.handle = handle
        self.cancelled = threading.Event()
        self.terminal = False


class FakeEngine:
    """Implements ``EnginePort`` with scripted, in-memory turns."""

    def __init__(
        self,
        *,
        script_factory: ScriptFactory = default_script,
        delay_s: float = 0.0,
        auto_ready_s: float = 0.0,
    ) -> None:
        self._script_factory = script_factory
        self._delay_s = max(0.0, delay_s)
        self._auto_ready_s = max(0.0, auto_ready_s)
        self._lock = threading.Lock()
        self._turns: dict[str, _FakeTurn] = {}
        self._active: set[str] = set()
        self._closed = False

    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        with self._lock:
            if self._closed:
                raise EngineUnavailable("engine is shutting down")
            handle = TurnHandle(
                turn_id=request.turn_id,
                session_id=request.session_id,
                engine_session_ref=self.session_ref(request.session_id),
            )
            self._turns[request.turn_id] = _FakeTurn(handle)
            self._active.add(request.turn_id)
            return handle

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        with self._lock:
            turn = self._turns.get(handle.turn_id)
        if turn is None:
            raise EngineUnavailable("turn handle is no longer active")

        if self._auto_ready_s:
            time.sleep(self._auto_ready_s)

        if turn.cancelled.is_set():
            yield self._cancel_event(turn)
            return

        for event in self._script_factory(handle.turn_id, handle.session_id):
            if turn.cancelled.is_set():
                yield self._cancel_event(turn)
                return
            if self._delay_s:
                time.sleep(self._delay_s)
            with self._lock:
                if turn.terminal:
                    return
                if is_terminal(event):
                    turn.terminal = True
                    self._active.discard(handle.turn_id)
            yield event
            if is_terminal(event):
                return

        with self._lock:
            if turn.terminal:
                return
            turn.terminal = True
            self._active.discard(handle.turn_id)
        if turn.cancelled.is_set():
            yield TurnCompleted(
                turn_id=handle.turn_id,
                session_id=handle.session_id,
                stop_reason="cancelled",
                text="",
            )
        else:
            yield TurnFailed(
                turn_id=handle.turn_id,
                session_id=handle.session_id,
                code="ENGINE_EXITED",
                message="fake engine script ended without a terminal event",
                retryable=True,
            )

    def cancel(self, handle: TurnHandle) -> None:
        with self._lock:
            turn = self._turns.get(handle.turn_id)
        if turn is not None:
            turn.cancelled.set()

    def status(self) -> EngineStatus:
        with self._lock:
            active = len(self._active)
            return EngineStatus(
                state=EngineState.BUSY if active else EngineState.IDLE,
                mode="matebot",
                active_turns=active,
                version="fake",
                last_error=None,
            )

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        return EngineSessionRef(str(uuid.uuid5(uuid.NAMESPACE_DNS, session_id)))

    def close(self, session_id: str) -> None:
        with self._lock:
            for turn in list(self._turns.values()):
                if turn.handle.session_id == session_id:
                    turn.cancelled.set()

    def close_all(self) -> None:
        with self._lock:
            self._closed = True
            for turn in self._turns.values():
                turn.cancelled.set()
            self._active.clear()

    def _cancel_event(self, turn: _FakeTurn) -> TurnCompleted:
        with self._lock:
            turn.terminal = True
            self._active.discard(turn.handle.turn_id)
        return TurnCompleted(
            turn_id=turn.handle.turn_id,
            session_id=turn.handle.session_id,
            stop_reason="cancelled",
            text="",
        )
