"""Turn endpoints. Thin: start/stream, cancel, terminal snapshot."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from fastapi.responses import StreamingResponse

from ...application.turn_service import TurnService
from ...composition import Container
from ..deps import get_container, get_turn_service
from ..schemas import (
    CancelResponse,
    TurnRequest,
    TurnStatusView,
    to_domain_patch,
    to_turn_status_view,
)
from ..sse import SSE_HEADERS, stream_turn_sse

router = APIRouter()


@router.post("/api/turns/{turn_id}/stream")
def start_turn_stream(
    turn_id: str,
    body: TurnRequest,
    container: Container = Depends(get_container),
    service: TurnService = Depends(get_turn_service),
) -> StreamingResponse:
    overrides = to_domain_patch(body.overrides) if body.overrides is not None else None
    subscription = service.start(
        turn_id,
        body.sessionId,
        body.text,
        overrides,
    )
    return StreamingResponse(
        stream_turn_sse(
            subscription,
            session_id=body.sessionId,
            clock=container.clock,
        ),
        media_type="text/event-stream; charset=utf-8",
        headers=SSE_HEADERS,
    )


@router.post(
    "/api/turns/{turn_id}/cancel",
    response_model=CancelResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def cancel_turn(
    turn_id: str,
    service: TurnService = Depends(get_turn_service),
) -> CancelResponse:
    service.cancel(turn_id)
    return CancelResponse(cancelling=True)


@router.get("/api/turns/{turn_id}", response_model=TurnStatusView)
def get_turn(
    turn_id: str,
    service: TurnService = Depends(get_turn_service),
) -> TurnStatusView:
    return to_turn_status_view(service.status(turn_id))
