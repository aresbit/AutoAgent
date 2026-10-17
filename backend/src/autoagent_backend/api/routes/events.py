"""Cross-cutting invalidation stream and engine status."""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ...composition import Container
from ..deps import get_container
from ..schemas import EngineStatusView, to_engine_status_view
from ..sse import SSE_HEADERS, stream_bus_sse

router = APIRouter()


@router.get("/api/engine/status", response_model=EngineStatusView)
def engine_status(container: Container = Depends(get_container)) -> EngineStatusView:
    return to_engine_status_view(container.engine.status())


@router.get("/api/events")
def events(container: Container = Depends(get_container)) -> StreamingResponse:
    def stream() -> Iterator[str]:
        subscription = container.event_bus.subscribe()
        try:
            yield from stream_bus_sse(
                subscription.next,
                clock=container.clock,
            )
        finally:
            container.event_bus.unsubscribe(subscription)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream; charset=utf-8",
        headers=SSE_HEADERS,
    )
