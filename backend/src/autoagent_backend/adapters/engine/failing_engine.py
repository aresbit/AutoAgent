"""Engine adapter used when the real child cannot be resolved.

Boot must still succeed so ``/api/health`` can report the failure; turns fail
with a sanitized ``ENGINE_UNAVAILABLE`` error.
"""

from __future__ import annotations

from collections.abc import Iterator

from ...domain.errors import EngineUnavailable
from ...domain.events import DomainEvent, TurnFailed
from ...domain.models import EngineState, EngineStatus
from ...domain.ports import StartTurnRequest, TurnHandle
from ...domain.values import EngineSessionRef


class FailingEngine:
    """Implements ``EnginePort`` by refusing every turn."""

    def __init__(self, message: str) -> None:
        self._message = message

    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        raise EngineUnavailable(self._message)

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        yield TurnFailed(
            turn_id=handle.turn_id,
            session_id=handle.session_id,
            code="ENGINE_UNAVAILABLE",
            message=self._message,
            retryable=True,
        )

    def cancel(self, handle: TurnHandle) -> None:
        return

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=EngineState.ERROR,
            mode="matebot",
            active_turns=0,
            version=None,
            last_error=self._message,
        )

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        return None

    def close(self, session_id: str) -> None:
        return

    def close_all(self) -> None:
        return
