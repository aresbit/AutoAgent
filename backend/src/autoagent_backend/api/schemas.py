"""Boundary DTOs. Domain values are converted explicitly; nothing is leaked.

Request models forbid unknown fields. Response models expose only the public
value space from ``api-contract-v1.md``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..application.artifact_diff import ArtifactDiff
from ..application.artifact_tool_service import ArtifactToolResult
from ..application.bootstrap_service import BootstrapData
from ..domain.errors import InvalidInput
from ..domain.models import (
    Artifact,
    ArtifactCreate,
    ArtifactVerification,
    ArtifactVersion,
    AutoAgentConfig,
    AutoAgentConfigPatch,
    ChangedFile,
    EngineStatus,
    FileDiff,
    Layout,
    McpDiscovery,
    McpServer,
    McpServerSpec,
    McpTool,
    Message,
    ModelResolution,
    Provider,
    ProviderCatalog,
    Session,
    Settings,
    SettingsPatch,
    Skill,
    SkillCatalogData,
    SkillMatch,
    TurnState,
    TurnStatus,
    WorkspaceStatus,
)

PermissionMode = Literal["default", "acceptEdits", "auto", "bypassPermissions"]
ThinkingMode = Literal["", "adaptive", "enabled", "disabled"]
Effort = Literal["", "low", "medium", "high", "max"]


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StrictModel(ApiModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# -- requests --------------------------------------------------------------


class LayoutInput(StrictModel):
    leftOpen: bool
    leftWidth: int = Field(ge=160, le=800)
    rightOpen: bool
    rightWidth: int = Field(ge=200, le=800)


class SettingsPatchInput(StrictModel):
    providerId: str | None = None
    model: str | None = None
    fallbackModel: str | None = None
    baseURL: str | None = None
    apiKey: str | None = None
    cwd: str | None = None
    permissionMode: PermissionMode | None = None
    thinkingMode: ThinkingMode | None = None
    effort: Effort | None = None
    maxThinkingTokens: int | None = Field(default=None, ge=0)
    maxTurns: int | None = Field(default=None, ge=1)
    maxBudgetUsd: float | None = Field(default=None, ge=0)
    taskBudget: float | None = Field(default=None, ge=0)
    allowedTools: list[str] | None = None
    disallowedTools: list[str] | None = None
    addDirs: list[str] | None = None
    appendSystemPrompt: str | None = None
    layout: LayoutInput | None = None


class EngineConfigPatch(StrictModel):
    """Partial AutoAgent config update; ``""`` clears a field."""

    model: str | None = None
    baseURL: str | None = None
    apiKey: str | None = None
    apiKeyHelper: str | None = None


class TurnRequest(StrictModel):
    sessionId: str
    text: str = Field(min_length=1, max_length=100_000)
    overrides: SettingsPatchInput | None = None


class CreateSessionRequest(StrictModel):
    title: str | None = Field(default=None, max_length=200)


class RenameSessionRequest(StrictModel):
    title: str = Field(min_length=1, max_length=200)


class BranchSessionRequest(StrictModel):
    title: str | None = Field(default=None, max_length=200)


class SkillEnableRequest(StrictModel):
    path: str | None = None


class SkillDiscoverRequest(StrictModel):
    cwd: str = Field(min_length=1)
    query: str | None = Field(default=None, max_length=500)


class McpServerInput(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    transport: Literal["stdio", "http", "sse"] = "stdio"
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    autoRun: bool = False


class McpDiscoverRequest(StrictModel):
    name: str | None = None
    enabledOnly: bool = True


class ToolInvokeRequest(StrictModel):
    server: str | None = None
    tool: str = Field(min_length=1, max_length=500)
    args: dict[str, Any] = Field(default_factory=dict)


class BranchSwitchRequest(StrictModel):
    branch: str = Field(min_length=1, max_length=500)
    workDir: str | None = None


class WorkspaceInitRequest(StrictModel):
    workDir: str | None = None


class ArtifactCreateRequest(StrictModel):
    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    html: str = Field(max_length=1_000_000)


class ArtifactExportRequest(StrictModel):
    targetPath: str = Field(min_length=1, max_length=4096)


class ArtifactImportRequest(StrictModel):
    zipPath: str = Field(min_length=1, max_length=4096)


class ArtifactCapabilitiesRequest(StrictModel):
    mcpTools: list[str] = Field(max_length=256)
    allowExternal: bool | None = None


class ArtifactToolCallRequest(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)
    consent: bool
    requestId: str | None = Field(default=None, max_length=200)


# -- responses -------------------------------------------------------------


class LayoutView(ApiModel):
    leftOpen: bool
    leftWidth: int
    rightOpen: bool
    rightWidth: int


class EngineProfileView(ApiModel):
    preset: Literal["matebot", "bundled", "custom"] = "matebot"
    mode: Literal["matebot"] = "matebot"
    version: str | None = None
    model: str | None = None
    modelSource: Literal[
        "override", "claude-settings", "autoagent", "env", "default"
    ] = "default"
    configPath: str = ""
    autoagentConfigPath: str = ""
    credentialSource: Literal[
        "claude-settings", "autoagent", "env", "none"
    ] = "none"
    credentialConfigured: bool = False
    cli: str | None = None


class EngineConfigView(ApiModel):
    """Frontend-editable AutoAgent config; secret/helper values are booleans."""

    configPath: str
    model: str | None
    baseURL: str | None
    apiKeyConfigured: bool
    apiKeyHelperConfigured: bool
    engine: EngineProfileView


class SettingsView(ApiModel):
    providerId: str
    model: str
    fallbackModel: str | None
    baseURL: str | None
    apiKeyConfigured: bool
    cwd: str
    permissionMode: PermissionMode
    thinkingMode: ThinkingMode
    effort: Effort
    maxThinkingTokens: int | None
    maxTurns: int
    maxBudgetUsd: float | None
    taskBudget: float | None
    allowedTools: list[str]
    disallowedTools: list[str]
    addDirs: list[str]
    appendSystemPrompt: str
    layout: LayoutView
    engine: EngineProfileView


class ProviderView(ApiModel):
    id: str
    name: str
    apiType: Literal["anthropic-messages", "codex-completions"] | None = None
    baseURL: str | None = None
    models: list[str] = Field(default_factory=list)
    allowCustomModels: bool = False


class ProviderCatalogView(ApiModel):
    builtin: list[ProviderView]
    custom: list[ProviderView]


class MessageView(ApiModel):
    id: str
    role: Literal["user", "assistant", "system", "tool"]
    text: str
    createdAt: int
    meta: dict[str, Any] | None = None


class SessionSummary(ApiModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int
    messageCount: int
    lastMessagePreview: str | None


class SessionView(ApiModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int
    messages: list[MessageView]


class EngineStatusView(ApiModel):
    state: Literal["idle", "starting", "busy", "error"]
    mode: Literal["local", "matebot"]
    activeTurns: int
    version: str | None
    lastError: str | None


class BranchView(ApiModel):
    name: str
    isRemote: bool


class ChangedFileView(ApiModel):
    path: str
    status: Literal[
        "added", "deleted", "modified", "renamed", "copied", "type_changed", "unknown"
    ]
    additions: int
    deletions: int


class WorkspaceStatusView(ApiModel):
    workDir: str
    isGitRepo: bool
    additions: int
    deletions: int
    changedFiles: int
    branches: list[BranchView]
    files: list[ChangedFileView]
    warnings: list[str]


class BootstrapView(ApiModel):
    apiVersion: Literal["1"]
    settings: SettingsView
    providers: ProviderCatalogView
    sessions: list[SessionSummary]
    mcpServers: list[McpServerView]
    skills: list[SkillView]
    artifacts: list[ArtifactView]
    workspace: WorkspaceStatusView
    engine: EngineStatusView


class TurnStatusView(ApiModel):
    turnId: str
    sessionId: str
    state: Literal["running", "completed", "cancelled", "failed"]
    stopReason: Literal["end_turn", "max_turns", "cancelled"] | None
    assistantMessageId: str | None
    error: str | None


class DeleteResponse(ApiModel):
    deleted: bool


class CancelResponse(ApiModel):
    cancelling: bool


class AuthResponse(ApiModel):
    ok: bool
    apiVersion: Literal["1"]


class HealthView(ApiModel):
    ok: bool
    app: str
    apiVersion: str
    version: str
    bootId: str
    uptimeMs: int
    db: str
    engine: str
    state: str


class SessionListView(ApiModel):
    sessions: list[SessionSummary]


class ProviderListView(ApiModel):
    providers: list[ProviderView]


# -- skills ----------------------------------------------------------------


class SkillView(ApiModel):
    name: str
    description: str
    source: Literal["system", "project"]
    enabled: bool


class SkillDirectoryView(ApiModel):
    path: str
    source: Literal["system", "project"]
    exists: bool


class SkillListView(ApiModel):
    skills: list[SkillView]
    dirs: list[SkillDirectoryView]


class SkillMutationView(ApiModel):
    skills: list[SkillView]


class SkillDiscoveryItemView(ApiModel):
    id: str
    name: str
    path: str


class SkillDiscoverView(ApiModel):
    items: list[SkillDiscoveryItemView]


# -- MCP -------------------------------------------------------------------


class McpServerView(ApiModel):
    id: str
    name: str
    transport: Literal["stdio", "http", "sse"]
    target: str
    enabled: bool
    autoRun: bool
    toolCount: int | None = None


class McpServerListView(ApiModel):
    servers: list[McpServerView]


class McpToolView(ApiModel):
    name: str
    description: str
    inputSchema: dict[str, Any] | None = None


class McpDiscoveryResultView(ApiModel):
    id: str
    name: str
    status: Literal["connected", "error"]
    durationMs: int
    tools: list[McpToolView]
    error: str | None = None


class McpDiscoverView(ApiModel):
    results: list[McpDiscoveryResultView]


class ToolInvokeView(ApiModel):
    result: Any


# -- workspace -------------------------------------------------------------


class FileDiffView(ApiModel):
    path: str
    patch: str
    original: str | None
    current: str | None


# -- artifacts -------------------------------------------------------------


class ArtifactVersionView(ApiModel):
    versionId: str
    createdAt: int
    source: str
    sessionId: str | None
    turnId: str | None
    messageId: str | None
    sizeBytes: int
    sha256: str
    immutable: bool
    uri: str
    mimeType: str
    entry: str


class ArtifactView(ApiModel):
    id: str
    title: str
    description: str
    createdAt: int
    updatedAt: int
    lastOpenedAt: int | None
    versions: list[int]
    contentUrl: str
    thumbnailUrl: str | None
    kind: str
    sessionId: str | None
    turnId: str | None
    messageId: str | None
    revision: str
    versionCount: int
    sizeBytes: int
    versionRefs: list[ArtifactVersionView]
    mcpTools: list[str]
    allowExternal: bool


class ArtifactListView(ApiModel):
    artifacts: list[ArtifactView]


class ArtifactVersionsView(ApiModel):
    versions: list[ArtifactVersionView]


class ArtifactVerifyView(ApiModel):
    artifactId: str
    version: str
    ok: bool
    sha256: str
    expectedSha256: str
    sizeBytes: int


class ArtifactPathView(ApiModel):
    path: str


class ArtifactDiffView(ApiModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    patch: str
    truncated: bool


class ArtifactToolCallView(ApiModel):
    content: list[Any]
    structuredContent: Any | None = None
    isError: bool = False


class ArtifactFrameTokenRequest(StrictModel):
    version: str | None = None


class ArtifactFrameTokenView(ApiModel):
    url: str
    expiresAt: int


# -- conversion ------------------------------------------------------------


def to_layout_view(layout: Layout) -> LayoutView:
    return LayoutView(
        leftOpen=layout.left_open,
        leftWidth=layout.left_width,
        rightOpen=layout.right_open,
        rightWidth=layout.right_width,
    )


def to_settings_view(
    settings: Settings,
    *,
    engine_version: str | None = None,
    model_resolution: ModelResolution | None = None,
    cli_path: str | None = None,
) -> SettingsView:
    resolution = model_resolution or ModelResolution()
    permission: PermissionMode = (
        settings.permission_mode  # type: ignore[assignment]
        if settings.permission_mode == "bypassPermissions"
        else "bypassPermissions"
    )
    thinking: ThinkingMode = (
        settings.thinking_mode  # type: ignore[assignment]
        if settings.thinking_mode in {"", "adaptive", "enabled", "disabled"}
        else ""
    )
    effort: Effort = (
        settings.effort  # type: ignore[assignment]
        if settings.effort in {"", "low", "medium", "high", "max"}
        else ""
    )
    return SettingsView(
        providerId=settings.provider_id,
        model=settings.model,
        fallbackModel=settings.fallback_model,
        baseURL=settings.base_url,
        apiKeyConfigured=bool(settings.api_key),
        cwd=settings.cwd,
        permissionMode=permission,
        thinkingMode=thinking,
        effort=effort,
        maxThinkingTokens=settings.max_thinking_tokens,
        maxTurns=settings.max_turns,
        maxBudgetUsd=settings.max_budget_usd,
        taskBudget=settings.task_budget,
        allowedTools=list(settings.allowed_tools),
        disallowedTools=list(settings.disallowed_tools),
        addDirs=list(settings.add_dirs),
        appendSystemPrompt=settings.append_system_prompt,
        layout=to_layout_view(settings.layout),
        engine=to_engine_profile_view(
            resolution, engine_version=engine_version, cli_path=cli_path
        ),
    )


def to_engine_profile_view(
    resolution: ModelResolution,
    *,
    engine_version: str | None = None,
    cli_path: str | None = None,
) -> EngineProfileView:
    return EngineProfileView(
        preset="matebot",
        mode="matebot",
        version=engine_version,
        model=resolution.model,
        modelSource=_model_source(resolution.source),
        configPath=resolution.config_path,
        autoagentConfigPath=resolution.autoagent_config_path,
        credentialSource=_credential_source(resolution.credential_source),
        credentialConfigured=resolution.credentials_configured,
        cli=cli_path,
    )


def to_engine_config_view(
    config: AutoAgentConfig,
    resolution: ModelResolution,
    *,
    engine_version: str | None = None,
    cli_path: str | None = None,
) -> EngineConfigView:
    return EngineConfigView(
        configPath=resolution.autoagent_config_path,
        model=config.model,
        baseURL=config.base_url,
        apiKeyConfigured=config.api_key_configured,
        apiKeyHelperConfigured=config.api_key_helper_configured,
        engine=to_engine_profile_view(
            resolution, engine_version=engine_version, cli_path=cli_path
        ),
    )


def to_provider_view(provider: Provider) -> ProviderView:
    api_type: Literal["anthropic-messages", "codex-completions"] | None
    if provider.api_type in {"anthropic-messages", "codex-completions"}:
        api_type = provider.api_type  # type: ignore[assignment]
    else:
        api_type = None
    return ProviderView(
        id=provider.id,
        name=provider.name,
        apiType=api_type,
        baseURL=provider.base_url,
        models=list(provider.models),
        allowCustomModels=provider.allow_custom_models,
    )


def to_provider_catalog(catalog: ProviderCatalog) -> ProviderCatalogView:
    return ProviderCatalogView(
        builtin=[to_provider_view(item) for item in catalog.builtin],
        custom=[to_provider_view(item) for item in catalog.custom],
    )


def to_message_view(message: Message) -> MessageView:
    role: Literal["user", "assistant", "system", "tool"] = (
        message.role  # type: ignore[assignment]
        if message.role in {"user", "assistant", "system", "tool"}
        else "system"
    )
    return MessageView(
        id=message.id,
        role=role,
        text=message.text,
        createdAt=message.created_at,
        meta=message.meta,
    )


def to_session_summary(session: Session) -> SessionSummary:
    return SessionSummary(
        id=session.id,
        title=session.title,
        createdAt=session.created_at,
        updatedAt=session.updated_at,
        messageCount=session.message_count,
        lastMessagePreview=session.last_message_preview,
    )


def to_session_view(session: Session) -> SessionView:
    return SessionView(
        id=session.id,
        title=session.title,
        createdAt=session.created_at,
        updatedAt=session.updated_at,
        messages=[to_message_view(message) for message in session.messages],
    )


def to_engine_status_view(status: EngineStatus) -> EngineStatusView:
    state: Literal["idle", "starting", "busy", "error"]
    if status.state.value in {"idle", "starting", "busy", "error"}:
        state = status.state.value
    else:
        state = "error"
    mode: Literal["local", "matebot"] = (
        "matebot" if status.mode == "matebot" else "local"
    )
    return EngineStatusView(
        state=state,
        mode=mode,
        activeTurns=status.active_turns,
        version=status.version,
        lastError=status.last_error,
    )


def to_workspace_view(workspace: WorkspaceStatus) -> WorkspaceStatusView:
    return WorkspaceStatusView(
        workDir=workspace.work_dir,
        isGitRepo=workspace.is_git_repo,
        additions=workspace.additions,
        deletions=workspace.deletions,
        changedFiles=workspace.changed_files,
        branches=[
            BranchView(name=branch.name, isRemote=branch.is_remote)
            for branch in workspace.branches
        ],
        files=[
            ChangedFileView(
                path=file.path,
                status=_changed_status(file),
                additions=file.additions,
                deletions=file.deletions,
            )
            for file in workspace.files
        ],
        warnings=list(workspace.warnings),
    )


def to_bootstrap_view(
    data: BootstrapData,
    *,
    engine_version: str | None = None,
    cli_path: str | None = None,
) -> BootstrapView:
    return BootstrapView(
        apiVersion="1",
        settings=to_settings_view(
            data.settings,
            engine_version=engine_version,
            model_resolution=data.model_resolution,
            cli_path=cli_path,
        ),
        providers=to_provider_catalog(data.providers),
        sessions=[to_session_summary(session) for session in data.sessions],
        mcpServers=[to_mcp_server_view(server) for server in data.mcp_servers],
        skills=[to_skill_view(skill) for skill in data.skills],
        artifacts=[to_artifact_view(artifact) for artifact in data.artifacts],
        workspace=to_workspace_view(data.workspace),
        engine=to_engine_status_view(data.engine),
    )


def to_turn_status_view(status: TurnStatus) -> TurnStatusView:
    state: Literal["running", "completed", "cancelled", "failed"]
    if status.state is TurnState.RUNNING:
        state = "running"
    elif status.state is TurnState.COMPLETED:
        state = "completed"
    elif status.state is TurnState.CANCELLED:
        state = "cancelled"
    else:
        state = "failed"
    stop: Literal["end_turn", "max_turns", "cancelled"] | None
    if status.stop_reason in {"end_turn", "max_turns", "cancelled"}:
        stop = status.stop_reason  # type: ignore[assignment]
    else:
        stop = None
    return TurnStatusView(
        turnId=status.turn_id,
        sessionId=status.session_id,
        state=state,
        stopReason=stop,
        assistantMessageId=status.assistant_message_id,
        error=status.error,
    )


def to_domain_patch(patch: SettingsPatchInput) -> SettingsPatch:
    layouts = patch.layout
    return SettingsPatch(
        provider_id=patch.providerId,
        model=patch.model,
        fallback_model=patch.fallbackModel,
        base_url=patch.baseURL,
        api_key=patch.apiKey,
        cwd=patch.cwd,
        permission_mode=patch.permissionMode,
        thinking_mode=patch.thinkingMode,
        effort=patch.effort,
        max_thinking_tokens=patch.maxThinkingTokens,
        max_turns=patch.maxTurns,
        max_budget_usd=patch.maxBudgetUsd,
        task_budget=patch.taskBudget,
        allowed_tools=None if patch.allowedTools is None else tuple(patch.allowedTools),
        disallowed_tools=(
            None if patch.disallowedTools is None else tuple(patch.disallowedTools)
        ),
        add_dirs=None if patch.addDirs is None else tuple(patch.addDirs),
        append_system_prompt=patch.appendSystemPrompt,
        layout=(
            None
            if layouts is None
            else Layout(
                left_open=layouts.leftOpen,
                left_width=layouts.leftWidth,
                right_open=layouts.rightOpen,
                right_width=layouts.rightWidth,
            )
        ),
    )


def _model_source(
    source: str,
) -> Literal["override", "claude-settings", "autoagent", "env", "default"]:
    if source in {"override", "claude-settings", "autoagent", "env"}:
        return source  # type: ignore[return-value]
    return "default"


def _credential_source(
    source: str,
) -> Literal["claude-settings", "autoagent", "env", "none"]:
    if source in {"claude-settings", "autoagent", "env"}:
        return source  # type: ignore[return-value]
    return "none"


def to_domain_autoagent_patch(patch: EngineConfigPatch) -> AutoAgentConfigPatch:
    return AutoAgentConfigPatch(
        model=patch.model,
        base_url=patch.baseURL,
        api_key=patch.apiKey,
        api_key_helper=patch.apiKeyHelper,
    )


def _changed_status(
    file: ChangedFile,
) -> Literal["added", "deleted", "modified", "renamed", "copied", "type_changed", "unknown"]:
    if file.status in {
        "added",
        "deleted",
        "modified",
        "renamed",
        "copied",
        "type_changed",
    }:
        return file.status  # type: ignore[return-value]
    return "unknown"


# -- panel conversions -----------------------------------------------------


def to_skill_view(skill: Skill) -> SkillView:
    source: Literal["system", "project"] = (
        "project" if skill.source == "project" else "system"
    )
    return SkillView(
        name=skill.name,
        description=skill.description,
        source=source,
        enabled=skill.enabled,
    )


def to_skill_list(catalog: SkillCatalogData) -> SkillListView:
    return SkillListView(
        skills=[to_skill_view(skill) for skill in catalog.skills],
        dirs=[
            SkillDirectoryView(
                path=directory.path,
                source="project" if directory.source == "project" else "system",
                exists=directory.exists,
            )
            for directory in catalog.dirs
        ],
    )


def to_skill_mutation(catalog: SkillCatalogData) -> SkillMutationView:
    return SkillMutationView(
        skills=[to_skill_view(skill) for skill in catalog.skills]
    )


def to_skill_discovery(match: SkillMatch) -> SkillDiscoveryItemView:
    return SkillDiscoveryItemView(id=match.id, name=match.name, path=match.path)


def to_mcp_server_view(server: McpServer) -> McpServerView:
    spec = server.spec
    if spec.transport == "stdio":
        target = " ".join(
            part for part in (spec.command or "", *spec.args) if part
        )
    else:
        target = spec.url or ""
    return McpServerView(
        id=server.name,
        name=server.name,
        transport=spec.transport,
        target=target,
        enabled=server.enabled,
        autoRun=server.auto_run,
        toolCount=None,
    )


def to_mcp_tool_view(tool: McpTool) -> McpToolView:
    return McpToolView(
        name=tool.name,
        description=tool.description,
        inputSchema=tool.input_schema,
    )


def to_mcp_discovery_view(result: McpDiscovery) -> McpDiscoveryResultView:
    status: Literal["connected", "error"] = (
        "connected" if result.status == "connected" else "error"
    )
    return McpDiscoveryResultView(
        id=result.name,
        name=result.name,
        status=status,
        durationMs=result.duration_ms,
        tools=[to_mcp_tool_view(tool) for tool in result.tools],
        error=result.error,
    )


def to_file_diff_view(diff: FileDiff) -> FileDiffView:
    return FileDiffView(
        path=diff.path,
        patch=diff.patch,
        original=diff.original,
        current=diff.current,
    )


def to_artifact_version_view(version: ArtifactVersion) -> ArtifactVersionView:
    return ArtifactVersionView(
        versionId=version.version_id,
        createdAt=version.created_at,
        source=version.source,
        sessionId=version.session_id,
        turnId=version.turn_id,
        messageId=version.message_id,
        sizeBytes=version.size_bytes,
        sha256=version.sha256,
        immutable=version.immutable,
        uri=version.uri,
        mimeType=version.mime_type,
        entry=version.entry,
    )


def to_artifact_view(artifact: Artifact) -> ArtifactView:
    return ArtifactView(
        id=artifact.id,
        title=artifact.title,
        description=artifact.description,
        createdAt=artifact.created_at,
        updatedAt=artifact.updated_at,
        lastOpenedAt=artifact.last_opened_at,
        versions=list(artifact.versions),
        contentUrl=artifact.content_url,
        thumbnailUrl=artifact.thumbnail_url,
        kind=artifact.kind,
        sessionId=artifact.session_id,
        turnId=artifact.turn_id,
        messageId=artifact.message_id,
        revision=artifact.revision,
        versionCount=len(artifact.version_refs),
        sizeBytes=artifact.size_bytes,
        versionRefs=[
            to_artifact_version_view(version)
            for version in artifact.version_refs
        ],
        mcpTools=list(artifact.mcp_tools),
        allowExternal=artifact.allow_external,
    )


def to_artifact_diff_view(diff: ArtifactDiff) -> ArtifactDiffView:
    return ArtifactDiffView.model_validate(
        {
            "from": diff.from_version,
            "to": diff.to_version,
            "patch": diff.patch,
            "truncated": diff.truncated,
        }
    )


def to_artifact_tool_call_view(
    result: ArtifactToolResult,
) -> ArtifactToolCallView:
    return ArtifactToolCallView(
        content=list(result.content),
        structuredContent=result.structured_content,
        isError=result.is_error,
    )


def to_artifact_verify_view(
    verification: ArtifactVerification,
) -> ArtifactVerifyView:
    return ArtifactVerifyView(
        artifactId=verification.artifact_id,
        version=verification.version_id,
        ok=verification.ok,
        sha256=verification.sha256,
        expectedSha256=verification.expected_sha256,
        sizeBytes=verification.size_bytes,
    )


def to_domain_mcp_spec(payload: McpServerInput) -> McpServerSpec:
    transport = payload.transport
    command = (payload.command or "").strip()
    url = (payload.url or "").strip()
    if transport == "stdio" and not command:
        raise InvalidInput("stdio MCP servers require a command")
    if transport in {"http", "sse"} and not url:
        raise InvalidInput("http/sse MCP servers require a url")
    return McpServerSpec(
        transport=transport,
        command=command or None,
        args=tuple(payload.args),
        env=dict(payload.env),
        url=url or None,
        headers=dict(payload.headers),
    )


def to_artifact_create(payload: ArtifactCreateRequest) -> ArtifactCreate:
    return ArtifactCreate(
        html=payload.html,
        title=payload.title,
        description=payload.description or "",
    )
