"""Frozen domain value objects.

All values returned by ports are immutable: adapters may keep rows, dicts and
paths internally, but those representations never cross this boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal


class TurnState(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class EngineState(StrEnum):
    IDLE = "idle"
    STARTING = "starting"
    BUSY = "busy"
    ERROR = "error"


class PermissionPolicy(StrEnum):
    """The only permission policy supported by v1."""

    FULL_ACCESS = "bypassPermissions"


@dataclass(frozen=True, slots=True)
class Layout:
    left_open: bool = True
    left_width: int = 280
    right_open: bool = True
    right_width: int = 360


@dataclass(frozen=True, slots=True)
class Settings:
    provider_id: str = "matebot"
    model: str = ""
    fallback_model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    cwd: str = ""
    permission_mode: str = PermissionPolicy.FULL_ACCESS.value
    thinking_mode: str = ""
    effort: str = ""
    max_thinking_tokens: int | None = None
    max_turns: int = 100
    max_budget_usd: float | None = None
    task_budget: float | None = None
    allowed_tools: tuple[str, ...] = ()
    disallowed_tools: tuple[str, ...] = ()
    add_dirs: tuple[str, ...] = ()
    append_system_prompt: str = ""
    layout: Layout = field(default_factory=Layout)

    def __post_init__(self) -> None:
        if self.permission_mode != PermissionPolicy.FULL_ACCESS.value:
            # Defensive: the settings adapter rejects other values first.
            raise ValueError("v1 supports bypassPermissions only")


@dataclass(frozen=True, slots=True)
class SettingsPatch:
    """Partial settings update. ``None`` means "leave unchanged"."""

    provider_id: str | None = None
    model: str | None = None
    fallback_model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    cwd: str | None = None
    permission_mode: str | None = None
    thinking_mode: str | None = None
    effort: str | None = None
    max_thinking_tokens: int | None = None
    max_turns: int | None = None
    max_budget_usd: float | None = None
    task_budget: float | None = None
    allowed_tools: tuple[str, ...] | None = None
    disallowed_tools: tuple[str, ...] | None = None
    add_dirs: tuple[str, ...] | None = None
    append_system_prompt: str | None = None
    layout: Layout | None = None


@dataclass(frozen=True, slots=True)
class Provider:
    id: str
    name: str
    api_type: str | None = None
    base_url: str | None = None
    models: tuple[str, ...] = ()
    allow_custom_models: bool = False


@dataclass(frozen=True, slots=True)
class ProviderCatalog:
    builtin: tuple[Provider, ...] = ()
    custom: tuple[Provider, ...] = ()


@dataclass(frozen=True, slots=True)
class Message:
    id: str
    session_id: str
    role: str
    text: str
    created_at: int
    turn_id: str | None = None
    meta: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class NewMessage:
    role: str
    text: str
    turn_id: str | None = None
    meta: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class Session:
    id: str
    title: str
    created_at: int
    updated_at: int
    message_count: int = 0
    last_message_preview: str | None = None
    messages: tuple[Message, ...] = ()


@dataclass(frozen=True, slots=True)
class TurnStatus:
    turn_id: str
    session_id: str
    state: TurnState
    stop_reason: str | None = None
    assistant_message_id: str | None = None
    error: str | None = None
    started_at: int = 0
    finished_at: int | None = None


@dataclass(frozen=True, slots=True)
class TurnResult:
    text: str
    stop_reason: str
    turn_id: str | None = None


@dataclass(frozen=True, slots=True)
class ModelResolution:
    """Effective engine configuration and where each value came from.

    ``config_path`` is the file that supplied the model (Claude settings.json or
    the AutoAgent config). ``autoagent_config_path`` is always the AutoAgent
    config location. No credential value is carried here; only its source and a
    configured boolean.
    """

    model: str | None = None
    source: str = "default"
    config_path: str = ""
    credentials_configured: bool = False
    autoagent_config_path: str = ""
    credential_source: str = "none"
    base_url: str | None = None
    base_url_source: str = "none"


@dataclass(frozen=True, slots=True)
class AutoAgentConfig:
    """The frontend-editable AutoAgent config.

    ``api_key`` is excluded from ``repr`` and is never serialized to a DTO.
    """

    model: str | None = None
    base_url: str | None = None
    api_key: str | None = field(default=None, repr=False)
    api_key_helper: str | None = None

    @property
    def api_key_configured(self) -> bool:
        return bool(self.api_key)

    @property
    def api_key_helper_configured(self) -> bool:
        return bool(self.api_key_helper)


@dataclass(frozen=True, slots=True)
class AutoAgentConfigPatch:
    """Partial update; ``None`` means unchanged, ``""`` clears a value."""

    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    api_key_helper: str | None = None


@dataclass(frozen=True, slots=True)
class EngineStatus:
    state: EngineState = EngineState.IDLE
    mode: str = "local"
    active_turns: int = 0
    version: str | None = None
    last_error: str | None = None


@dataclass(frozen=True, slots=True)
class ChangedFile:
    path: str
    status: str
    additions: int = 0
    deletions: int = 0


@dataclass(frozen=True, slots=True)
class Branch:
    name: str
    is_remote: bool


@dataclass(frozen=True, slots=True)
class WorkspaceStatus:
    work_dir: str
    is_git_repo: bool
    additions: int = 0
    deletions: int = 0
    changed_files: int = 0
    branches: tuple[Branch, ...] = ()
    files: tuple[ChangedFile, ...] = ()
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class FileDiff:
    """One changed file's patch plus its before/after content.

    ``original``/``current`` are ``None`` when the file is absent on that side.
    """

    path: str
    patch: str
    original: str | None = None
    current: str | None = None


# -- skills ----------------------------------------------------------------

SkillSource = Literal["system", "project"]


@dataclass(frozen=True, slots=True)
class Skill:
    name: str
    description: str
    source: SkillSource
    enabled: bool


@dataclass(frozen=True, slots=True)
class SkillDirectory:
    """A directory the catalog scans; ``path`` is configuration, not internal state."""

    path: str
    source: SkillSource
    exists: bool


@dataclass(frozen=True, slots=True)
class SkillCatalogData:
    skills: tuple[Skill, ...] = ()
    dirs: tuple[SkillDirectory, ...] = ()


@dataclass(frozen=True, slots=True)
class SkillMatch:
    """One candidate skill discovered on disk."""

    id: str
    name: str
    path: str


# -- MCP -------------------------------------------------------------------

McpTransport = Literal["stdio", "http", "sse"]


@dataclass(frozen=True, slots=True)
class McpServerSpec:
    """The user's server definition; secrets remain values, never DTO output."""

    transport: McpTransport = "stdio"
    command: str | None = None
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.transport == "stdio" and not (self.command or "").strip():
            raise ValueError("stdio MCP servers require a command")
        if self.transport in {"http", "sse"} and not (self.url or "").strip():
            raise ValueError("http/sse MCP servers require a url")


@dataclass(frozen=True, slots=True)
class McpServer:
    name: str
    spec: McpServerSpec
    enabled: bool = True
    auto_run: bool = False
    created_at: int = 0
    updated_at: int = 0


@dataclass(frozen=True, slots=True)
class McpTool:
    name: str
    description: str = ""
    input_schema: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class McpDiscovery:
    name: str
    status: str
    duration_ms: int
    tools: tuple[McpTool, ...] = ()
    error: str | None = None


@dataclass(frozen=True, slots=True)
class McpInvocationResult:
    """Sanitized, JSON-serializable tool result."""

    result: object


# -- artifacts -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ArtifactVersion:
    """One immutable artifact snapshot.

    ``version_id`` is the monotonic public identifier (``v1``, ``v2``...);
    ``sha256`` and ``size_bytes`` describe the exact stored document.
    """

    version_id: str
    created_at: int
    sha256: str
    size_bytes: int
    source: str = "manual"
    session_id: str | None = None
    turn_id: str | None = None
    message_id: str | None = None
    immutable: bool = True
    uri: str = ""
    mime_type: str = "text/html;profile=mcp-app"
    entry: str = "index.html"


@dataclass(frozen=True, slots=True)
class Artifact:
    id: str
    title: str
    description: str
    created_at: int
    updated_at: int
    last_opened_at: int | None = None
    versions: tuple[int, ...] = ()
    content_url: str = ""
    thumbnail_url: str | None = None
    kind: str = "html"
    session_id: str | None = None
    turn_id: str | None = None
    message_id: str | None = None
    revision: str = "v1"
    version_refs: tuple[ArtifactVersion, ...] = ()
    size_bytes: int = 0
    mcp_tools: tuple[str, ...] = ()
    allow_external: bool = False


@dataclass(frozen=True, slots=True)
class ArtifactCreate:
    html: str
    title: str | None = None
    description: str = ""
    session_id: str | None = None
    turn_id: str | None = None
    message_id: str | None = None
    source: str = "manual"
    mcp_tools: tuple[str, ...] = ()
    allow_external: bool = False


@dataclass(frozen=True, slots=True)
class ArtifactDraft:
    """A validated, canonical artifact document ready for persistence."""

    html: str
    title: str
    description: str
    sha256: str
    size_bytes: int
    mcp_tools: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ArtifactMutation:
    """Result of materializing one artifact for a turn.

    ``created`` distinguishes ``artifact.created`` from ``artifact.updated``;
    ``changed`` is ``False`` when the content hash matched the current version
    (the caller then emits no event).
    """

    artifact: Artifact
    created: bool
    changed: bool


@dataclass(frozen=True, slots=True)
class ArtifactVerification:
    artifact_id: str
    version_id: str
    ok: bool
    sha256: str
    expected_sha256: str
    size_bytes: int
