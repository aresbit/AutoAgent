"""HarnessEngine routing between the opencc and claude-code adapters."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from autoagent_backend.adapters.engine.harness import HarnessEngine
from autoagent_backend.domain.errors import EngineUnavailable
from autoagent_backend.domain.events import DomainEvent, TurnCompleted
from autoagent_backend.domain.models import EngineState, EngineStatus, Settings
from autoagent_backend.domain.ports import StartTurnRequest, TurnHandle


class StubEngine:
    def __init__(self, name: str) -> None:
        self.name = name
        self.started: list[StartTurnRequest] = []
        self.closed: list[str] = []
        self.cancelled: list[str] = []
        self.closed_all = 0

    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        self.started.append(request)
        return TurnHandle(turn_id=request.turn_id, session_id=request.session_id)

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        yield TurnCompleted(
            turn_id=handle.turn_id,
            session_id=handle.session_id,
            stop_reason="end_turn",
            text=self.name,
        )

    def cancel(self, handle: TurnHandle) -> None:
        self.cancelled.append(handle.turn_id)

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=EngineState.BUSY if self.started else EngineState.IDLE,
            mode=self.name,
            active_turns=len(self.started),
        )

    def session_ref(self, session_id: str) -> None:
        del session_id
        return None

    def close(self, session_id: str) -> None:
        self.closed.append(session_id)

    def close_all(self) -> None:
        self.closed_all += 1


def _request(turn_id: str, session_id: str = "session-1") -> StartTurnRequest:
    return StartTurnRequest(
        turn_id=turn_id,
        session_id=session_id,
        text="hello",
        settings=Settings(),
    )


def test_routes_to_the_selected_harness() -> None:
    selected = {"value": "opencc"}
    opencc = StubEngine("opencc")
    claude = StubEngine("claude-code")
    engine = HarnessEngine(
        harness=lambda: selected["value"],
        engines={"opencc": opencc, "claude-code": claude},
    )

    handle = engine.start_turn(_request("turn-1"))
    assert [request.turn_id for request in opencc.started] == ["turn-1"]
    assert claude.started == []
    assert [event.text for event in engine.stream(handle)] == ["opencc"]

    selected["value"] = "claude-code"
    handle = engine.start_turn(_request("turn-2"))
    assert [request.turn_id for request in claude.started] == ["turn-2"]
    # Switching closed the previous harness's process for this conversation.
    assert opencc.closed == ["session-1"]
    assert engine.status().mode == "claude-code"


def test_a_running_turn_keeps_its_original_engine() -> None:
    selected = {"value": "opencc"}
    opencc = StubEngine("opencc")
    claude = StubEngine("claude-code")
    engine = HarnessEngine(
        harness=lambda: selected["value"],
        engines={"opencc": opencc, "claude-code": claude},
    )
    handle = engine.start_turn(_request("turn-1"))
    selected["value"] = "claude-code"

    assert [event.text for event in engine.stream(handle)] == ["opencc"]
    engine.cancel(handle)
    assert opencc.cancelled == ["turn-1"]
    assert claude.cancelled == []


def test_invalid_or_failing_preference_falls_back() -> None:
    opencc = StubEngine("opencc")
    claude = StubEngine("claude-code")
    engine = HarnessEngine(
        harness=lambda: "not-a-harness",
        engines={"opencc": opencc, "claude-code": claude},
    )
    engine.start_turn(_request("turn-1"))
    assert len(opencc.started) == 1

    def broken() -> str:
        raise RuntimeError("settings unavailable")

    engine = HarnessEngine(
        harness=broken,
        engines={"opencc": opencc, "claude-code": claude},
    )
    engine.start_turn(_request("turn-2"))
    assert len(opencc.started) == 2


def test_close_and_close_all_cover_every_engine() -> None:
    opencc = StubEngine("opencc")
    claude = StubEngine("claude-code")
    engine = HarnessEngine(
        harness=lambda: "opencc",
        engines={"opencc": opencc, "claude-code": claude},
    )
    engine.close("session-1")
    assert opencc.closed == ["session-1"]
    assert claude.closed == ["session-1"]

    engine.close_all()
    assert opencc.closed_all == 1
    assert claude.closed_all == 1
    with pytest.raises(EngineUnavailable):
        engine.start_turn(_request("turn-3"))


def test_requires_a_configured_default() -> None:
    with pytest.raises(ValueError):
        HarnessEngine(harness=lambda: "opencc", engines={})
    with pytest.raises(ValueError):
        HarnessEngine(
            harness=lambda: "opencc",
            engines={"claude-code": StubEngine("claude-code")},
        )
