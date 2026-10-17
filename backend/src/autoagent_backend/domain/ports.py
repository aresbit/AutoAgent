"""Ports (dependency-inversion seams).

Each protocol is a *specification*: preconditions, postconditions and the domain
errors it may raise. Implementations hide their representation (CLI argv, rows,
paths, PIDs, frames) completely.

Core rule: ``domain`` and ``application`` modules must never import FastAPI,
Starlette, Pydantic, sqlite3, subprocess or HTTP clients. This is enforced by
``tests/test_import_boundaries.py`` and the ``lint-imports`` contracts.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Protocol

from .events import DomainEvent
from .models import (
    Artifact,
    ArtifactCreate,
    AutoAgentConfig,
    AutoAgentConfigPatch,
    EngineStatus,
    FileDiff,
    McpDiscovery,
    McpInvocationResult,
    McpServer,
    McpServerSpec,
    Message,
    ModelResolution,
    NewMessage,
    Provider,
    ProviderCatalog,
    Session,
    Settings,
    SettingsPatch,
    SkillCatalogData,
    SkillMatch,
    TurnResult,
    TurnState,
    TurnStatus,
    WorkspaceStatus,
)
from .values import EngineSessionRef


@dataclass(frozen=True, slots=True)
class StartTurnRequest:
    """Application -> engine request.

    Pre: ``turn_id`` and ``session_id`` are non-empty; ``text`` is non-empty and
         already length-limited by the boundary.
    Post: no CLI/transport detail is present; ``engine_session_ref`` is opaque
          and must never be serialized.
    """

    turn_id: str
    session_id: str
    text: str
    settings: Settings
    engine_session_ref: EngineSessionRef | None = None


@dataclass(frozen=True, slots=True)
class TurnHandle:
    """Opaque in-process handle for one started turn."""

    turn_id: str
    session_id: str
    engine_session_ref: EngineSessionRef | None = None


class ClockPort(Protocol):
    """Wall clock seam, so resume-age and turn-timing tests are deterministic."""

    def now_ms(self) -> int:
        """Post: returns milliseconds since the Unix epoch."""


class EnginePort(Protocol):
    """Start, stream, cancel and inspect agent turns.

    The implementation owns CLI resolution, argv construction, spawn, stdin and
    stdout handling, readiness gating, retries, resume gates, process revival and
    kill escalation.

    Post: ``start_turn`` returns a handle with the same ``turn_id`` or raises
          ``EngineUnavailable``; it never partially starts a turn.
    Post: ``stream`` yields domain events and terminates with exactly one
          ``TurnCompleted`` or ``TurnFailed``.
    Post: ``cancel`` is idempotent. After it returns, ``stream`` terminates with
          ``TurnCompleted(stop_reason="cancelled")`` within the cancel deadline.
    Raises: ``EngineUnavailable`` when a child cannot be spawned.
    """

    def start_turn(self, request: StartTurnRequest) -> TurnHandle: ...

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]: ...

    def cancel(self, handle: TurnHandle) -> None: ...

    def status(self) -> EngineStatus: ...

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        """Return the last *published* resume ref for ``session_id``.

        Post: returns a ref only after a clean, non-error result; never from a
              failed or interrupted spawn.
        """
        ...

    def close(self, session_id: str) -> None:
        """Close the persistent child for ``session_id``, if any."""
        ...


class SessionStorePort(Protocol):
    """Persistent conversation sessions and their messages.

    All methods return immutable domain values, never rows or mutable lists.
    Raises: ``SessionNotFound`` when a session id does not exist.
    """

    def list(self, limit: int | None = None) -> Sequence[Session]: ...

    def get(self, session_id: str) -> Session: ...

    def create(self, title: str | None = None) -> Session: ...

    def rename(self, session_id: str, title: str) -> Session: ...

    def delete(self, session_id: str) -> None: ...

    def branch(self, session_id: str, title: str | None = None) -> Session: ...

    def append_message(self, session_id: str, message: NewMessage) -> Message: ...

    def record_turn(self, session_id: str, result: TurnResult) -> Message: ...


class TurnStorePort(Protocol):
    """Turn lifecycle persistence used for idempotency and terminal recovery.

    Pre: ``begin_turn`` is called once per client-generated turn id.
    Post: at most one row per turn id and at most one running turn per session.
    Raises: ``TurnAlreadyFinished``/``TurnInProgress`` as applicable.
    """

    def begin_turn(self, turn_id: str, session_id: str, started_at: int) -> None: ...

    def finish_turn(
        self,
        turn_id: str,
        state: TurnState,
        *,
        stop_reason: str | None,
        error_code: str | None,
        error_message: str | None,
        assistant_message_id: str | None,
        finished_at: int,
    ) -> None: ...

    def get_turn(self, turn_id: str) -> TurnStatus | None: ...

    def running_turn_for_session(self, session_id: str) -> str | None: ...

    def fail_orphaned_turns(self, finished_at: int, code: str) -> int:
        """Mark ``running`` turns from a previous process as failed."""


class EngineRefStorePort(Protocol):
    """The only read/write seam for the opaque engine resume reference.

    Post: ``get_ref`` returns a UUID-shaped ref or ``None``.
    Raises: ``InvalidInput`` when ``set_ref`` receives a non-UUID string.
    """

    def get_ref(self, session_id: str) -> EngineSessionRef | None: ...

    def set_ref(self, session_id: str, ref: EngineSessionRef | None) -> None: ...


class SettingsPort(Protocol):
    """Read/update the user-visible settings aggregate.

    The port owns defaults, provider resolution, credential storage, unknown
    field preservation and validation.

    Post: ``read`` returns a fully normalized ``Settings``.
    Raises: ``InvalidSettings`` or ``PermissionModeUnsupported``.
    """

    def read(self) -> Settings: ...

    def update(self, patch: SettingsPatch) -> Settings: ...

    def provider(self, provider_id: str) -> Provider: ...

    def providers(self) -> ProviderCatalog: ...


class WorkspacePort(Protocol):
    """Workspace inspection and git operations.

    ``work_dir=None`` means the configured workspace. ``base=None`` means the
    working tree diff. Only ``switch_branch`` and ``init`` mutate the workspace.

    Raises: ``WorkspaceUnavailable`` when git cannot be executed;
            ``InvalidInput`` for unsafe paths or branch names.
    """

    def status(
        self, work_dir: str | None = None, base: str | None = None
    ) -> WorkspaceStatus: ...

    def diff(self, path: str, work_dir: str | None = None) -> FileDiff: ...

    def switch_branch(self, branch: str, work_dir: str | None = None) -> None: ...

    def init(self, work_dir: str | None = None) -> None: ...


class AutoAgentConfigPort(Protocol):
    """Read/update ``<data_dir>/settings.json`` (frontend-editable config).

    Post: ``read`` returns normalized values; a missing file is empty config.
    Post: ``update`` merges a patch and writes atomically with mode 0600.
    Raises: ``InvalidSettings`` for unreadable/invalid JSON or write failures.
    """

    @property
    def config_path(self) -> str: ...

    def read(self) -> AutoAgentConfig: ...

    def update(self, patch: AutoAgentConfigPatch) -> AutoAgentConfig: ...


class EngineConfigPort(Protocol):
    """Resolve effective model/credential/base-URL sources.

    The adapter reads the Claude config, the AutoAgent config and the process
    environment, never writes the Claude config, and never returns credential
    values (only sources and a configured boolean).

    Pre: ``override`` is the desktop model override or ``None``.
    Post: returns a ``ModelResolution``; ``config_path`` names the file that
          supplied the model and ``autoagent_config_path`` the AutoAgent file.
    """

    def resolve(self, override: str | None = None) -> ModelResolution: ...

    def apply_environment(self) -> None:
        """Export AutoAgent-sourced credentials/base URL for engine children.

        Post: sets ``ANTHROPIC_AUTH_TOKEN`` / ``ANTHROPIC_BASE_URL`` only when
              the effective source is the AutoAgent config, so Claude-settings
              values always win. Never logs the values.
        """
        ...


class SkillCatalogPort(Protocol):
    """Every skill directory the user can see, plus enable/disable commands.

    ``cwd=None`` means the configured workspace.

    Post: ``catalog`` returns one entry per skill name, with project skills
          taking precedence over system/user skills.
    Post: ``enable``/``disable`` return the catalog after the operation.
    Raises: ``SkillNotFound``; ``InvalidInput`` for unsafe names/paths;
            ``WorkspaceUnavailable`` when a directory cannot be moved.
    """

    def catalog(self, cwd: str | None = None) -> SkillCatalogData: ...

    def enable(
        self, name: str, path: str | None = None, cwd: str | None = None
    ) -> SkillCatalogData: ...

    def disable(self, name: str, cwd: str | None = None) -> SkillCatalogData: ...

    def discover(
        self, cwd: str | None = None, query: str | None = None
    ) -> Sequence[SkillMatch]: ...


class McpRegistryPort(Protocol):
    """Persisted MCP server definitions plus connection-scoped discovery/invoke.

    The implementation owns transport selection, process lifetime, timeouts and
    JSON-RPC framing. ``env``/``headers`` values are accepted as input but are
    never serialized by the HTTP boundary; only the spec's target is public.

    Raises: ``McpServerNotFound``, ``McpToolNotFound``, ``McpUnavailable``.
    """

    def list(self) -> Sequence[McpServer]: ...

    def upsert(
        self,
        name: str,
        spec: McpServerSpec,
        *,
        enabled: bool = True,
        auto_run: bool = False,
    ) -> McpServer: ...

    def remove(self, name: str) -> None: ...

    def set_enabled(self, name: str, enabled: bool) -> McpServer: ...

    def discover(
        self, name: str | None = None, enabled_only: bool = True
    ) -> Sequence[McpDiscovery]: ...

    def invoke(
        self, server: str | None, tool: str, args: dict[str, object]
    ) -> McpInvocationResult: ...


class ArtifactStorePort(Protocol):
    """Filesystem-authoritative artifacts addressed by opaque id.

    The implementation owns ``manifest.json``, directory layout, version files
    and zip handling. Paths are never part of returned values.

    Raises: ``ArtifactNotFound``; ``InvalidInput`` for invalid ids, exports or
            archives; ``WorkspaceUnavailable`` for filesystem failures.
    """

    def list(self) -> Sequence[Artifact]: ...

    def get(self, artifact_id: str) -> Artifact: ...

    def create(self, request: ArtifactCreate) -> Artifact: ...

    def content(self, artifact_id: str) -> str: ...

    def mark_opened(self, artifact_id: str) -> Artifact: ...

    def export(self, artifact_id: str, target_path: str) -> str: ...

    def import_archive(self, zip_path: str) -> Artifact: ...
