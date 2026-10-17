"""SSE framing and the domain-event -> wire-schema projection.

The wire schema is a projection of domain events, never of stream-json. ``seq``
is monotonic per response starting at 1; ``ts`` is epoch milliseconds.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import Any

from ..application.journal import TurnSubscription
from ..domain.events import (
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
from ..domain.ports import ClockPort

LOG = logging.getLogger("autoagent.api.sse")

HEARTBEAT_SECONDS = 15.0

SSE_HEADERS: dict[str, str] = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def project_event(
    event: DomainEvent, *, session_id: str, seq: int, ts: int
) -> list[tuple[str, dict[str, Any]]]:
    """Project one domain event to zero or more wire events.

    Post: no raw frame, argv, path, PID or engine ``session_id`` appears.
    """

    common: dict[str, Any] = {
        "turnId": event.turn_id,
        "sessionId": _session_of(event, session_id),
        "seq": seq,
        "ts": ts,
    }

    if isinstance(event, TurnStarted):
        payload = dict(common)
        if event.model is not None:
            payload["model"] = event.model
        return [("turn.started", payload)]

    if isinstance(event, TextDelta):
        return [
            (
                "message.delta",
                {**common, "channel": "text", "text": event.text},
            )
        ]

    if isinstance(event, ThinkingDelta):
        return [
            (
                "message.delta",
                {**common, "channel": "thinking", "text": event.text},
            )
        ]

    if isinstance(event, ToolStarted):
        tool: dict[str, Any] = {"ref": event.call_ref}
        if event.name is not None:
            tool["name"] = event.name
        if event.input is not None:
            tool["input"] = event.input
        return [("tool.start", {**common, "tool": tool})]

    if isinstance(event, ToolFinished):
        tool = {"ref": event.call_ref, "ok": event.ok}
        if event.name is not None:
            tool["name"] = event.name
        payload = {**common, "tool": tool}
        if event.text is not None:
            payload["text"] = event.text
        return [("tool.result", payload)]

    if isinstance(event, UsageReported):
        usage: dict[str, Any] = {}
        if event.input_tokens is not None:
            usage["inputTokens"] = event.input_tokens
        if event.output_tokens is not None:
            usage["outputTokens"] = event.output_tokens
        return [("usage", {**common, "usage": usage})]

    if isinstance(event, TurnCompleted):
        wire: list[tuple[str, dict[str, Any]]] = []
        if event.stop_reason != "cancelled" and event.message_id is not None:
            wire.append(
                (
                    "message.completed",
                    {
                        **common,
                        "messageId": event.message_id,
                        "text": event.text,
                    },
                )
            )
        wire.append(
            ("turn.completed", {**common, "stopReason": event.stop_reason})
        )
        return wire

    if isinstance(event, TurnFailed):
        return [
            (
                "error",
                {
                    **common,
                    "code": event.code,
                    "message": event.message,
                    "retryable": event.retryable,
                },
            )
        ]

    return []


def format_event(name: str, data: dict[str, Any], *, seq: int) -> str:
    encoded = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"id: {seq}\nevent: {name}\ndata: {encoded}\n\n"


def format_heartbeat(*, ts: int) -> str:
    return f"event: heartbeat\ndata: {{\"ts\":{ts}}}\n\n"


def stream_turn_sse(
    subscription: TurnSubscription,
    *,
    session_id: str,
    clock: ClockPort,
    heartbeat_s: float = HEARTBEAT_SECONDS,
) -> Iterator[str]:
    """Yield SSE frames until the turn's single terminal event.

    Client disconnect closes this generator without cancelling the turn; the
    runner keeps draining and persisting.
    """

    seq = 0
    while True:
        event, ended = subscription.next_event(heartbeat_s)
        if event is None:
            if ended:
                return
            yield format_heartbeat(ts=clock.now_ms())
            continue

        for name, data in project_event(
            event, session_id=session_id, seq=seq + 1, ts=clock.now_ms()
        ):
            seq += 1
            data["seq"] = seq
            yield format_event(name, data, seq=seq)

        if is_terminal(event):
            return
        if ended:
            return


def stream_bus_sse(
    next_payload: Any,
    *,
    clock: ClockPort,
    heartbeat_s: float = HEARTBEAT_SECONDS,
) -> Iterator[str]:
    """Yield cross-cutting invalidation events plus heartbeats.

    ``next_payload`` is a zero-argument callable returning a mapping or ``None``
    on timeout, keeping this module independent of the event bus class.
    """

    while True:
        payload = next_payload(heartbeat_s)
        if payload is None:
            yield format_heartbeat(ts=clock.now_ms())
            continue
        event_name = str(payload.get("type", "event"))
        encoded = json.dumps(
            {key: value for key, value in payload.items() if key != "type"},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        yield f"event: {event_name}\ndata: {encoded}\n\n"


def _session_of(event: DomainEvent, fallback: str) -> str:
    session_id = getattr(event, "session_id", None)
    return session_id if isinstance(session_id, str) and session_id else fallback
