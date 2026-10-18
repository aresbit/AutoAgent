"""Normalized domain events produced by the engine adapter.

The wire format is a projection of these values (see ``api/sse.py``), never the
opencc stream-json representation. Every event carries the turn id; session-level
correlation is carried by ``TurnStarted`` and the terminal events and is repeated
optionally on deltas so a runner can correlate without extra bookkeeping.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import Artifact


@dataclass(frozen=True, slots=True)
class TurnStarted:
    turn_id: str
    session_id: str
    model: str | None


@dataclass(frozen=True, slots=True)
class TextDelta:
    turn_id: str
    text: str
    session_id: str | None = None


@dataclass(frozen=True, slots=True)
class ThinkingDelta:
    turn_id: str
    text: str
    session_id: str | None = None


@dataclass(frozen=True, slots=True)
class ToolStarted:
    turn_id: str
    call_ref: str
    name: str | None
    input: dict[str, object] | None
    session_id: str | None = None


@dataclass(frozen=True, slots=True)
class ToolFinished:
    turn_id: str
    call_ref: str
    name: str | None
    ok: bool
    text: str | None
    session_id: str | None = None


@dataclass(frozen=True, slots=True)
class UsageReported:
    turn_id: str
    input_tokens: int | None
    output_tokens: int | None
    session_id: str | None = None


@dataclass(frozen=True, slots=True)
class ArtifactCreated:
    turn_id: str
    session_id: str
    artifact: Artifact


@dataclass(frozen=True, slots=True)
class ArtifactUpdated:
    turn_id: str
    session_id: str
    artifact_id: str
    revision: str
    artifact: Artifact


@dataclass(frozen=True, slots=True)
class TurnCompleted:
    turn_id: str
    session_id: str
    stop_reason: str
    text: str
    # Populated by TurnService after the assistant message is persisted. It is
    # used by the SSE projection and is not a transport/engine representation.
    message_id: str | None = None
    # Materialized artifact events. They are nested in the terminal event so the
    # projection can guarantee message.completed -> artifact.* -> turn.completed.
    artifacts: tuple[ArtifactCreated | ArtifactUpdated, ...] = ()


@dataclass(frozen=True, slots=True)
class TurnFailed:
    turn_id: str
    session_id: str
    code: str
    message: str
    retryable: bool


type DomainEvent = (
    TurnStarted
    | TextDelta
    | ThinkingDelta
    | ToolStarted
    | ToolFinished
    | UsageReported
    | ArtifactCreated
    | ArtifactUpdated
    | TurnCompleted
    | TurnFailed
)

TERMINAL_EVENTS: tuple[type[DomainEvent], ...] = (TurnCompleted, TurnFailed)


def is_terminal(event: DomainEvent) -> bool:
    """Return True when ``event`` is the single terminal event of a turn."""

    return isinstance(event, TERMINAL_EVENTS)
