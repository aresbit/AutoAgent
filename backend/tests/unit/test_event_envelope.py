"""Event envelope versioning and the essential/non-essential queue gate."""

from __future__ import annotations

import json

from autoagent_backend.api.sse import stream_bus_sse
from autoagent_backend.application.event_bus import (
    EVENT_ENVELOPE_VERSION,
    EventBusSubscription,
    is_essential,
)


class Clock:
    def __init__(self) -> None:
        self.value = 1000

    def now_ms(self) -> int:
        self.value += 1
        return self.value


def _parse(chunk: str) -> tuple[str, dict[str, object]]:
    lines = chunk.strip().splitlines()
    name = lines[0].removeprefix("event: ")
    data = json.loads(lines[1].removeprefix("data: "))
    return name, data


def test_envelope_wraps_payload_with_version_sequence_and_time() -> None:
    payloads = [
        {"type": "artifacts.changed", "id": "a1"},
        {"type": "mcp.log", "server": "s"},
    ]

    def next_payload(_timeout: float) -> dict[str, object] | None:
        return payloads.pop(0) if payloads else None

    stream = stream_bus_sse(next_payload, clock=Clock())
    name, first = _parse(next(stream))
    assert name == "artifacts.changed"
    assert first["v"] == EVENT_ENVELOPE_VERSION
    assert first["seq"] == 1
    assert first["essential"] is True
    assert first["data"] == {"id": "a1"}

    name, second = _parse(next(stream))
    assert name == "mcp.log"
    assert second["seq"] == 2
    assert second["essential"] is False
    assert second["data"] == {"server": "s"}


def test_heartbeat_has_no_envelope() -> None:
    stream = stream_bus_sse(lambda _timeout: None, clock=Clock())
    chunk = next(stream)
    assert chunk.startswith("event: heartbeat")


def test_unknown_events_are_essential_and_noisy_ones_are_not() -> None:
    assert is_essential({"type": "sessions.changed"}) is True
    assert is_essential({"type": "anything.new"}) is True
    assert is_essential({"type": "mcp.status"}) is False
    assert is_essential({"type": "mcp.log", "essential": True}) is True
    assert is_essential({"type": "sessions.changed", "essential": False}) is False


def test_non_essential_events_are_dropped_when_full() -> None:
    subscription = EventBusSubscription(maxsize=2)
    subscription.publish({"type": "artifacts.changed"}, essential=True)
    subscription.publish({"type": "sessions.changed"}, essential=True)
    subscription.publish({"type": "mcp.log"}, essential=False)

    first = subscription.next(0.01)
    second = subscription.next(0.01)
    assert first is not None and first["type"] == "artifacts.changed"
    assert second is not None and second["type"] == "sessions.changed"
    assert subscription.next(0.01) is None


def test_essential_events_evict_the_oldest_when_full() -> None:
    subscription = EventBusSubscription(maxsize=2)
    subscription.publish({"type": "artifacts.changed"}, essential=True)
    subscription.publish({"type": "sessions.changed"}, essential=True)
    subscription.publish({"type": "mcp.approval_required"}, essential=True)

    first = subscription.next(0.01)
    second = subscription.next(0.01)
    assert first is not None and first["type"] == "sessions.changed"
    assert second is not None and second["type"] == "mcp.approval_required"
