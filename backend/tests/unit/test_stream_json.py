"""M2 golden tests: recorded stream-json -> exact domain events -> SSE wire."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from autoagent_backend.adapters.engine.stream_json import (
    StreamJsonTranslator,
    cap_utf8,
    parse_frame,
    redact_value,
)
from autoagent_backend.api.sse import project_event
from autoagent_backend.domain.events import (
    TextDelta,
    ThinkingDelta,
    ToolFinished,
    ToolStarted,
    TurnCompleted,
    TurnFailed,
    TurnStarted,
    UsageReported,
)

FIXTURES = Path(__file__).resolve().parents[1] / "golden" / "fixtures"


def translate(name: str, turn_id: str = "turn-1", session_id: str = "session-1"):
    translator = StreamJsonTranslator(
        turn_id=turn_id,
        session_id=session_id,
        call_ref_factory=lambda raw: f"ref-{raw}",
    )
    events = []
    for line in (FIXTURES / name).read_text(encoding="utf-8").splitlines():
        frame = parse_frame(line)
        assert frame is not None
        events.extend(translator.feed(frame))
    return translator, events


def test_normal_stream_maps_to_exact_events() -> None:
    translator, events = translate("normal.jsonl")
    assert [type(event) for event in events] == [
        TurnStarted,
        TextDelta,
        ThinkingDelta,
        ToolStarted,
        ToolFinished,
        UsageReported,
        TurnCompleted,
    ]

    started, text, thinking, tool_start, tool_finish, usage, completed = events
    assert isinstance(started, TurnStarted)
    assert started.model == "claude-sonnet-4-6"
    assert isinstance(text, TextDelta)
    assert text.text == "Hello "
    assert isinstance(thinking, ThinkingDelta)
    assert thinking.text == "checking"
    assert isinstance(tool_start, ToolStarted)
    assert tool_start.call_ref == "ref-toolu_1"
    assert tool_start.name == "Bash"
    assert tool_start.input == {
        "command": "echo hi",
        "api_key": "[REDACTED]",
    }
    assert isinstance(tool_finish, ToolFinished)
    assert tool_finish.call_ref == "ref-toolu_1"
    assert tool_finish.ok is True
    assert tool_finish.text == "hi"
    assert isinstance(usage, UsageReported)
    assert (usage.input_tokens, usage.output_tokens) == (11, 7)
    assert isinstance(completed, TurnCompleted)
    assert completed.stop_reason == "end_turn"
    assert completed.text == "Hello world"
    assert translator.engine_session_id == "11111111-1111-4111-8111-111111111111"


def test_translator_emits_exactly_one_terminal_event() -> None:
    translator, events = translate("normal.jsonl")
    terminals = [
        event for event in events if isinstance(event, (TurnCompleted, TurnFailed))
    ]
    assert len(terminals) == 1
    extra = translator.feed(
        {"type": "result", "subtype": "success", "result": "again"}
    )
    assert extra == []


def test_error_result_maps_to_turn_failed() -> None:
    _, events = translate("error.jsonl")
    assert [type(event) for event in events] == [
        TurnStarted,
        UsageReported,
        TurnFailed,
    ]
    failure = events[-1]
    assert isinstance(failure, TurnFailed)
    assert failure.code == "ENGINE_RESULT_ERROR"
    assert failure.message == "model call failed"
    assert failure.retryable is False


def test_unexpected_permission_request_fails_the_turn() -> None:
    _, events = translate("permission.jsonl")
    assert isinstance(events[0], TurnStarted)
    failure = events[-1]
    assert isinstance(failure, TurnFailed)
    assert failure.code == "PERMISSION_UNEXPECTED"


def test_unknown_tool_result_is_not_emitted_out_of_order() -> None:
    translator = StreamJsonTranslator(turn_id="t", session_id="s")
    events = translator.feed(
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "missing", "content": "x"}
                ],
            },
        }
    )
    assert events == []


def test_sse_projection_has_no_raw_representation() -> None:
    _, events = translate("normal.jsonl")
    wire: list[tuple[str, dict[str, object]]] = []
    seq = 0
    for event in events:
        if isinstance(event, TurnCompleted):
            event = replace(event, message_id="msg-1")
        for item in project_event(event, session_id="session-1", seq=seq + 1, ts=1000):
            seq += 1
            item[1]["seq"] = seq
            wire.append(item)

    names = [name for name, _ in wire]
    assert names == [
        "turn.started",
        "message.delta",
        "message.delta",
        "tool.start",
        "tool.result",
        "usage",
        "message.completed",
        "turn.completed",
    ]
    payload = json.dumps([data for _, data in wire])
    for forbidden in (
        "content_block",
        "tool_use",
        "partial_json",
        "\"raw\"",
        "\"session_id\"",
        "claude_code_version",
    ):
        assert forbidden not in payload
    assert [data["seq"] for _, data in wire] == list(range(1, len(wire) + 1))


def test_parse_frame_ignores_invalid_and_blank_lines() -> None:
    assert parse_frame("") is None
    assert parse_frame("not json") is None
    assert parse_frame("[1,2]") is None
    assert parse_frame('{"type":"x"}') == {"type": "x"}


def test_payload_limits_and_redaction() -> None:
    assert len(cap_utf8("a" * 100, 10)) < 100
    redacted = redact_value({"password": "p", "nested": {"token": "t"}})
    assert redacted == {"password": "[REDACTED]", "nested": {"token": "[REDACTED]"}}
