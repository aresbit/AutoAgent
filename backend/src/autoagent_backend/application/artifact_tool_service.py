"""Artifact tool bridge.

An iframe never receives the launch token and never talks to an MCP transport
directly.  The parent host calls this service, which enforces the artifact's
allowlist, explicit user consent, a per-artifact rate limit and an argument size
cap before delegating to ``McpService``.

Every decision is audited.  Arguments are deliberately not logged; only their
encoded size is recorded.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass

from ..domain.errors import (
    ArtifactToolRateLimited,
    ConsentRequired,
    DomainError,
    PayloadTooLarge,
    ToolNotAllowed,
)
from ..domain.models import Artifact
from ..domain.ports import ArtifactStorePort, ClockPort
from .mcp_service import McpService

AUDIT = logging.getLogger("autoagent.artifacts.audit")

MAX_ARGUMENT_BYTES = 64 * 1024
RATE_LIMIT_CALLS = 30
RATE_LIMIT_WINDOW_MS = 60_000


@dataclass(frozen=True, slots=True)
class ArtifactToolResult:
    """The only tool-result shape exposed by the bridge."""

    content: list[object]
    structured_content: object | None = None
    is_error: bool = False


class ArtifactToolService:
    """Host-mediated tool calls for one artifact."""

    def __init__(
        self,
        artifacts: ArtifactStorePort,
        mcp: McpService,
        *,
        clock: ClockPort,
        rate_limit_calls: int = RATE_LIMIT_CALLS,
        rate_limit_window_ms: int = RATE_LIMIT_WINDOW_MS,
        max_argument_bytes: int = MAX_ARGUMENT_BYTES,
    ) -> None:
        self._artifacts = artifacts
        self._mcp = mcp
        self._clock = clock
        self._rate_limit_calls = rate_limit_calls
        self._rate_limit_window_ms = rate_limit_window_ms
        self._max_argument_bytes = max_argument_bytes
        self._lock = threading.Lock()
        self._calls: dict[str, deque[int]] = {}

    def call(
        self,
        artifact_id: str,
        *,
        name: str,
        arguments: dict[str, object],
        consent: bool,
        request_id: str | None = None,
    ) -> ArtifactToolResult:
        """Enforce policy and invoke one tool.

        Raises: ``ArtifactNotFound``, ``ToolNotAllowed``, ``ConsentRequired``,
                ``PayloadTooLarge``, ``ArtifactToolRateLimited`` and MCP domain
                errors.
        """

        started = time.monotonic()
        tool = name.strip()
        try:
            artifact = self._artifacts.get(artifact_id)
        except DomainError as exc:
            self._audit(artifact_id, tool, "denied", exc.code, started, request_id)
            raise

        args_bytes = _json_size(arguments)
        try:
            self._authorize(artifact, tool, consent, args_bytes)
            rate_now = self._clock.now_ms()
            self._check_rate(artifact.id, rate_now)
            result = self._mcp.invoke(None, tool, dict(arguments)).result
            normalized = _normalize_result(result)
        except DomainError as exc:
            self._audit(
                artifact.id,
                tool,
                "denied",
                exc.code,
                started,
                request_id,
                args_bytes,
            )
            raise
        except Exception as exc:  # pragma: no cover - unexpected transport shape
            AUDIT.info(
                "tool_call artifact=%s tool=%s outcome=error reason=%s "
                "duration_ms=%d request_id=%s args_bytes=%d",
                artifact.id,
                tool,
                type(exc).__name__,
                _elapsed_ms(started),
                request_id or "",
                args_bytes,
            )
            raise

        self._audit(
            artifact.id,
            tool,
            "ok",
            "invoked",
            started,
            request_id,
            args_bytes,
        )
        return normalized

    # -- policy ------------------------------------------------------------

    def _authorize(
        self, artifact: Artifact, tool: str, consent: bool, args_bytes: int
    ) -> None:
        if tool not in artifact.mcp_tools:
            raise ToolNotAllowed("tool is not allowed for this artifact")
        if not consent:
            raise ConsentRequired("user consent is required for tool calls")
        if args_bytes > self._max_argument_bytes:
            raise PayloadTooLarge(
                f"tool arguments exceed {self._max_argument_bytes} bytes"
            )

    def _check_rate(self, artifact_id: str, now: int) -> None:
        cutoff = now - self._rate_limit_window_ms
        with self._lock:
            bucket = self._calls.setdefault(artifact_id, deque())
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= self._rate_limit_calls:
                raise ArtifactToolRateLimited(
                    "artifact tool call rate limit exceeded"
                )
            bucket.append(now)

    # -- audit -------------------------------------------------------------

    def _audit(
        self,
        artifact_id: str,
        tool: str,
        outcome: str,
        reason: str,
        started: float,
        request_id: str | None,
        args_bytes: int = 0,
    ) -> None:
        AUDIT.info(
            "tool_call artifact=%s tool=%s outcome=%s reason=%s "
            "duration_ms=%d request_id=%s args_bytes=%d",
            _log_value(artifact_id),
            _log_value(tool),
            outcome,
            reason,
            _elapsed_ms(started),
            _log_value(request_id or ""),
            args_bytes,
        )


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _log_value(value: str) -> str:
    """Keep audit fields on one line and bounded (no log injection)."""

    printable = "".join(char if char.isprintable() else " " for char in value)
    return printable[:200]


def _json_size(value: object) -> int:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        )
    except (TypeError, ValueError):
        return MAX_ARGUMENT_BYTES + 1
    return len(encoded.encode("utf-8"))


def _json_safe(value: object) -> object:
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


def _normalize_result(result: object) -> ArtifactToolResult:
    """Coerce an MCP result into ``{content, structuredContent, isError}``.

    ``content`` is always a list and every value is JSON-safe, so transports
    can never leak an arbitrary Python object across the boundary.
    """

    content: list[object] = []
    structured: object | None = None
    is_error = False
    if isinstance(result, dict):
        raw_content = result.get("content")
        if isinstance(raw_content, list):
            content = [_json_safe(item) for item in raw_content]
        elif raw_content is not None:
            content = [_json_safe(raw_content)]
        structured = _json_safe(result.get("structuredContent"))
        is_error = result.get("isError") is True
    elif isinstance(result, list):
        content = [_json_safe(item) for item in result]
    elif result is not None:
        content = [_json_safe(result)]
    return ArtifactToolResult(
        content=content,
        structured_content=structured,
        is_error=is_error,
    )
