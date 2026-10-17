"""Translate opencc stream-json frames into normalized domain events.

Raw frames never leave this module. The translator is stateful per turn,
correlates tool calls through an internal map, and emits exactly one terminal
event.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from typing import Any

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
)

TOOL_INPUT_LIMIT_BYTES = 16 * 1024
TOOL_RESULT_LIMIT_BYTES = 64 * 1024
_SECRET_KEY = re.compile(r"token|key|secret|password|authorization", re.IGNORECASE)
REDACTED = "[REDACTED]"


def parse_frame(line: str) -> dict[str, Any] | None:
    """Parse one NDJSON line; blank/invalid lines yield ``None``."""

    stripped = line.strip().lstrip("\ufeff")
    if not stripped:
        return None
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def cap_utf8(text: str, limit: int) -> str:
    """Truncate ``text`` to at most ``limit`` UTF-8 bytes."""

    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode("utf-8", errors="ignore") + "…[truncated]"


def redact_value(value: Any, *, limit: int = TOOL_INPUT_LIMIT_BYTES) -> Any:
    """Recursively redact secret-looking keys and cap string size."""

    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            text_key = str(key)
            if _SECRET_KEY.search(text_key):
                redacted[text_key] = REDACTED
            else:
                redacted[text_key] = redact_value(item, limit=limit)
        return redacted
    if isinstance(value, list):
        return [redact_value(item, limit=limit) for item in value]
    if isinstance(value, str):
        return cap_utf8(value, limit)
    return value


def _as_dict(value: object) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _text_from_content(content: object, *, limit: int) -> str:
    if isinstance(content, str):
        return cap_utf8(content, limit)
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            block_dict = _as_dict(block)
            if block_dict is None:
                continue
            text = block_dict.get("text")
            if isinstance(text, str):
                parts.append(text)
        return cap_utf8("\n".join(parts), limit)
    return ""


def _default_call_ref(_raw_id: str) -> str:
    return f"call_{uuid.uuid4().hex[:16]}"


class StreamJsonTranslator:
    """Stateful frame -> domain-event translator for one turn.

    Post: ``feed`` emits events in order; after the first terminal event every
          subsequent call returns an empty tuple.
    """

    def __init__(
        self,
        *,
        turn_id: str,
        session_id: str,
        call_ref_factory: Callable[[str], str] = _default_call_ref,
    ) -> None:
        self.turn_id = turn_id
        self.session_id = session_id
        self._call_ref_factory = call_ref_factory
        self._call_refs: dict[str, str] = {}
        self._tool_names: dict[str, str] = {}
        self._seen_starts: set[str] = set()
        self._terminal = False
        self._usage_emitted = False
        self.engine_session_id: str | None = None
        self.assistant_text = ""
        self.saw_assistant_output = False

    @property
    def terminal(self) -> bool:
        return self._terminal

    def feed(self, frame: dict[str, Any]) -> list[DomainEvent]:
        if self._terminal:
            return []

        session_id = frame.get("session_id")
        if isinstance(session_id, str) and session_id:
            self.engine_session_id = session_id

        frame_type = frame.get("type")
        if frame_type == "system":
            return self._system(frame)
        if frame_type == "stream_event":
            return self._stream_event(frame)
        if frame_type == "assistant":
            return self._assistant(frame)
        if frame_type == "user":
            return self._user(frame)
        if frame_type == "result":
            return self._result(frame)
        if frame_type == "control_request":
            request = _as_dict(frame.get("request")) or {}
            if request.get("subtype") == "can_use_tool":
                return self._fail(
                    "PERMISSION_UNEXPECTED",
                    "the engine requested an interactive permission decision",
                    retryable=False,
                )
        return []

    # -- frame handlers ----------------------------------------------------

    def _system(self, frame: dict[str, Any]) -> list[DomainEvent]:
        if frame.get("subtype") != "init":
            return []
        model = frame.get("model")
        return [
            TurnStarted(
                turn_id=self.turn_id,
                session_id=self.session_id,
                model=model if isinstance(model, str) else None,
            )
        ]

    def _stream_event(self, frame: dict[str, Any]) -> list[DomainEvent]:
        event = _as_dict(frame.get("event"))
        if event is None:
            return []
        event_type = event.get("type")
        if event_type == "content_block_start":
            block = _as_dict(event.get("content_block")) or {}
            if block.get("type") == "tool_use":
                return self._tool_start(
                    raw_id=block.get("id"),
                    name=block.get("name"),
                    tool_input=block.get("input"),
                )
            return []
        if event_type == "content_block_delta":
            delta = _as_dict(event.get("delta")) or {}
            delta_type = delta.get("type")
            if delta_type == "text_delta":
                text = delta.get("text")
                if isinstance(text, str) and text:
                    self.saw_assistant_output = True
                    return [
                        TextDelta(
                            turn_id=self.turn_id,
                            text=text,
                            session_id=self.session_id,
                        )
                    ]
            elif delta_type == "thinking_delta":
                text = delta.get("thinking")
                if isinstance(text, str) and text:
                    self.saw_assistant_output = True
                    return [
                        ThinkingDelta(
                            turn_id=self.turn_id,
                            text=text,
                            session_id=self.session_id,
                        )
                    ]
        return []

    def _assistant(self, frame: dict[str, Any]) -> list[DomainEvent]:
        message = _as_dict(frame.get("message")) or {}
        content = _as_list(message.get("content"))
        events: list[DomainEvent] = []
        parts: list[str] = []
        for block in content:
            block_dict = _as_dict(block)
            if block_dict is None:
                continue
            block_type = block_dict.get("type")
            if block_type == "text" and isinstance(block_dict.get("text"), str):
                parts.append(str(block_dict["text"]))
                self.saw_assistant_output = True
            elif block_type == "tool_use":
                raw_id = block_dict.get("id")
                if isinstance(raw_id, str) and raw_id not in self._seen_starts:
                    events.extend(
                        self._tool_start(
                            raw_id=raw_id,
                            name=block_dict.get("name"),
                            tool_input=block_dict.get("input"),
                        )
                    )
        if parts:
            # The assistant frame is the authoritative snapshot for its message.
            self.assistant_text = "".join(parts)
        return events

    def _user(self, frame: dict[str, Any]) -> list[DomainEvent]:
        message = _as_dict(frame.get("message")) or {}
        content = _as_list(message.get("content"))
        events: list[DomainEvent] = []
        for block in content:
            block_dict = _as_dict(block)
            if block_dict is None or block_dict.get("type") != "tool_result":
                continue
            raw_id = block_dict.get("tool_use_id")
            if not isinstance(raw_id, str):
                continue
            call_ref = self._call_refs.get(raw_id)
            if call_ref is None:
                # No preceding start: emitting a finish would violate the ADT.
                continue
            content_value = block_dict.get("content")
            text = _text_from_content(
                content_value, limit=TOOL_RESULT_LIMIT_BYTES
            )
            events.append(
                ToolFinished(
                    turn_id=self.turn_id,
                    call_ref=call_ref,
                    name=self._tool_names.get(raw_id),
                    ok=not bool(block_dict.get("is_error")),
                    text=text or None,
                    session_id=self.session_id,
                )
            )
        return events

    def _result(self, frame: dict[str, Any]) -> list[DomainEvent]:
        events: list[DomainEvent] = []
        usage = _as_dict(frame.get("usage"))
        if usage is not None and not self._usage_emitted:
            self._usage_emitted = True
            events.append(
                UsageReported(
                    turn_id=self.turn_id,
                    input_tokens=_optional_int(usage.get("input_tokens")),
                    output_tokens=_optional_int(usage.get("output_tokens")),
                    session_id=self.session_id,
                )
            )

        subtype = str(frame.get("subtype") or "")
        is_error = bool(frame.get("is_error")) or subtype.startswith("error")
        if is_error:
            errors = frame.get("errors")
            if isinstance(errors, list) and errors:
                message = " ".join(str(item) for item in errors)
            else:
                message = subtype or "engine reported an error result"
            events.extend(
                self._fail("ENGINE_RESULT_ERROR", message, retryable=False)
            )
            return events

        stop_reason = frame.get("stop_reason")
        if stop_reason not in {"end_turn", "max_turns", "cancelled"}:
            stop_reason = "end_turn"
        result_text = frame.get("result")
        text = result_text if isinstance(result_text, str) else self.assistant_text
        self._terminal = True
        events.append(
            TurnCompleted(
                turn_id=self.turn_id,
                session_id=self.session_id,
                stop_reason=str(stop_reason),
                text=text,
                message_id=None,
            )
        )
        return events

    # -- helpers -----------------------------------------------------------

    def _tool_start(
        self,
        *,
        raw_id: object,
        name: object,
        tool_input: object,
    ) -> list[DomainEvent]:
        if not isinstance(raw_id, str) or not raw_id or raw_id in self._seen_starts:
            return []
        self._seen_starts.add(raw_id)
        call_ref = self._call_ref_factory(raw_id)
        self._call_refs[raw_id] = call_ref
        tool_name = name if isinstance(name, str) else None
        if tool_name is not None:
            self._tool_names[raw_id] = tool_name
        sanitized = redact_value(tool_input) if tool_input is not None else None
        return [
            ToolStarted(
                turn_id=self.turn_id,
                call_ref=call_ref,
                name=tool_name,
                input=sanitized if isinstance(sanitized, dict) else None,
                session_id=self.session_id,
            )
        ]

    def _fail(self, code: str, message: str, *, retryable: bool) -> list[DomainEvent]:
        self._terminal = True
        return [
            TurnFailed(
                turn_id=self.turn_id,
                session_id=self.session_id,
                code=code,
                message=cap_utf8(message, 2048),
                retryable=retryable,
            )
        ]


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None
