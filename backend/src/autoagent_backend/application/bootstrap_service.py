"""Startup aggregate read model."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from ..domain.models import (
    Artifact,
    EngineStatus,
    McpServer,
    ModelResolution,
    ProviderCatalog,
    Session,
    Settings,
    Skill,
    WorkspaceStatus,
)
from ..domain.ports import (
    ArtifactStorePort,
    EngineConfigPort,
    EnginePort,
    McpRegistryPort,
    SessionStorePort,
    SettingsPort,
    SkillCatalogPort,
    WorkspacePort,
)

LOG = logging.getLogger("autoagent.bootstrap")


@dataclass(frozen=True, slots=True)
class BootstrapData:
    settings: Settings
    providers: ProviderCatalog
    sessions: tuple[Session, ...]
    engine: EngineStatus
    workspace: WorkspaceStatus
    skills: tuple[Skill, ...] = ()
    mcp_servers: tuple[McpServer, ...] = ()
    artifacts: tuple[Artifact, ...] = ()
    model_resolution: ModelResolution = field(default_factory=ModelResolution)


class BootstrapService:
    """Assembles the single startup response; hides parallel loading."""

    def __init__(
        self,
        *,
        settings: SettingsPort,
        sessions: SessionStorePort,
        engine: EnginePort,
        workspace: WorkspacePort,
        skills: SkillCatalogPort | None = None,
        mcp: McpRegistryPort | None = None,
        artifacts: ArtifactStorePort | None = None,
        engine_config: EngineConfigPort | None = None,
        session_limit: int = 50,
    ) -> None:
        self._settings = settings
        self._sessions = sessions
        self._engine = engine
        self._workspace = workspace
        self._skills = skills
        self._mcp = mcp
        self._artifacts = artifacts
        self._engine_config = engine_config
        self._session_limit = session_limit

    def read(self) -> BootstrapData:
        settings = self._settings.read()
        try:
            workspace = self._workspace.status(settings.cwd or None)
        except Exception:
            LOG.warning("workspace status failed during bootstrap", exc_info=True)
            workspace = WorkspaceStatus(
                work_dir=settings.cwd,
                is_git_repo=False,
                warnings=("workspace status unavailable",),
            )
        return BootstrapData(
            settings=settings,
            providers=self._settings.providers(),
            sessions=tuple(self._sessions.list(self._session_limit)),
            engine=self._engine.status(),
            workspace=workspace,
            skills=self._skills_list(settings.cwd or None),
            mcp_servers=self._mcp_list(),
            artifacts=self._artifact_list(),
            model_resolution=(
                self._engine_config.resolve(
                    settings.model,
                    preference=settings.api_credential_source,
                )
                if self._engine_config is not None
                else ModelResolution()
            ),
        )

    def _skills_list(self, cwd: str | None) -> tuple[Skill, ...]:
        if self._skills is None:
            return ()
        try:
            return self._skills.catalog(cwd).skills
        except Exception:
            LOG.warning("skill scan failed during bootstrap", exc_info=True)
            return ()

    def _mcp_list(self) -> tuple[McpServer, ...]:
        if self._mcp is None:
            return ()
        try:
            return tuple(self._mcp.list())
        except Exception:
            LOG.warning("MCP registry read failed during bootstrap", exc_info=True)
            return ()

    def _artifact_list(self) -> tuple[Artifact, ...]:
        if self._artifacts is None:
            return ()
        try:
            return tuple(self._artifacts.list())
        except Exception:
            LOG.warning("artifact list failed during bootstrap", exc_info=True)
            return ()
