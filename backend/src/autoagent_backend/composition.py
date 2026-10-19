"""Composition root.

Only this module constructs concrete adapters. Services receive ports; the API
receives a ready container. Initialization failures are recorded in the
in-memory lifecycle snapshot so health remains side-effect free and available.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .adapters.artifacts.fs_store import FilesystemArtifactStore
from .adapters.autoagent_config import AutoAgentConfigStore
from .adapters.claude_settings import ClaudeSettingsReader
from .adapters.engine.argv import resolve_bun, resolve_cli
from .adapters.engine.failing_engine import FailingEngine
from .adapters.engine.fake_engine import FakeEngine
from .adapters.engine.matebot_engine import (
    MateBotEngine,
    build_matebot_session_factory,
)
from .adapters.engine.subprocess_engine import build_subprocess_engine
from .adapters.engine_config import EngineConfigResolver
from .adapters.mcp.client import McpConnectionFactory
from .adapters.mcp.mcp_store import SqliteMcpRegistry
from .adapters.persistence.legacy_import import LegacyImporter
from .adapters.persistence.migrations import migrate
from .adapters.persistence.session_store import SqliteSessionStore
from .adapters.persistence.settings_store import SqliteSettingsStore
from .adapters.persistence.sqlite import SqliteDatabase
from .adapters.skills.fs_catalog import FilesystemSkillCatalog
from .adapters.terminal.manager import TerminalManager
from .adapters.workspace.git_cli import GitCliWorkspace
from .application.artifact_service import ArtifactService
from .application.artifact_tool_service import ArtifactToolService
from .application.bootstrap_service import BootstrapService
from .application.clock import SystemClock
from .application.engine_config_service import EngineConfigService
from .application.event_bus import EventBus
from .application.mcp_service import McpService
from .application.session_service import SessionService
from .application.settings_service import SettingsService
from .application.skill_service import SkillService
from .application.turn_service import TurnService
from .application.workspace_service import WorkspaceService
from .config import BootConfig
from .domain.errors import DomainError
from .domain.ports import (
    AutoAgentConfigPort,
    EngineConfigPort,
    EnginePort,
    WorkspacePort,
)
from .logging_setup import configure_logging
from .paths import BootPaths, ensure_directories

LOG = logging.getLogger("autoagent.composition")


class LifecycleSnapshot:
    """In-memory only; health reads this and never touches adapters."""

    started_monotonic: float = field(default_factory=time.monotonic)
    db: str = "initializing"
    engine: str = "idle"

    @property
    def state(self) -> str:
        if self.db == "initializing" or self.engine == "starting":
            return "initializing"
        if self.db == "ok" and self.engine != "error":
            return "ok"
        return "degraded"


@dataclass(slots=True)
class Container:
    config: BootConfig
    paths: BootPaths
    lifecycle: LifecycleSnapshot
    db: SqliteDatabase
    clock: SystemClock
    sessions: SqliteSessionStore
    settings_store: SqliteSettingsStore
    autoagent_config: AutoAgentConfigPort
    engine_config: EngineConfigPort
    engine_config_service: EngineConfigService
    cli_path: str | None
    engine: EnginePort
    workspace: WorkspacePort
    event_bus: EventBus
    skill_catalog: FilesystemSkillCatalog
    mcp_registry: SqliteMcpRegistry
    artifact_store: FilesystemArtifactStore
    session_service: SessionService
    settings_service: SettingsService
    turn_service: TurnService
    skill_service: SkillService
    mcp_service: McpService
    workspace_service: WorkspaceService
    artifact_service: ArtifactService
    artifact_tool_service: ArtifactToolService
    bootstrap_service: BootstrapService
    terminal_manager: TerminalManager
    closers: list[Callable[[], None]] = field(default_factory=list)

    def close(self) -> None:
        try:
            self.turn_service.shutdown()
        except Exception:
            LOG.exception("turn service shutdown failed")
        close_all = getattr(self.engine, "close_all", None)
        if callable(close_all):
            try:
                close_all()
            except Exception:
                LOG.exception("engine shutdown failed")
        for closer in self.closers:
            try:
                closer()
            except Exception:
                LOG.exception("adapter close failed")


def build_container(
    config: BootConfig,
    lifecycle: LifecycleSnapshot | None = None,
    *,
    home_dir: Path | None = None,
    mcp_connections: McpConnectionFactory | None = None,
) -> Container:
    """Construct adapters and initialize persistent state.

    Post: returns a usable container even when DB migration or engine resolution
          fails; the failure is visible through ``lifecycle`` and turned into a
          domain error on use.
    """

    snapshot = lifecycle or LifecycleSnapshot()
    configure_logging(
        config.paths.log_dir,
        secrets=[config.api_token],
    )

    try:
        ensure_directories(config.paths)
    except OSError:
        LOG.exception("could not create runtime directories")

    clock = SystemClock()
    db = SqliteDatabase(config.paths.db_path)
    sessions = SqliteSessionStore(db, clock)
    settings_store = SqliteSettingsStore(
        db, clock, default_cwd=str(config.default_cwd)
    )
    terminal_manager = TerminalManager(
        is_cwd_allowed=_terminal_cwd_guard(config, settings_store),
        max_sessions=config.max_terminals,
        default_cwd=str(config.default_cwd),
    )
    autoagent_config = AutoAgentConfigStore(config.paths.autoagent_config_path)
    claude_settings = ClaudeSettingsReader()
    engine_config = EngineConfigResolver(
        claude=claude_settings, autoagent=autoagent_config
    )
    # Export AutoAgent-sourced credentials/base URL before any child spawns.
    engine_config.apply_environment()

    engine: EnginePort
    if config.engine_mode == "fake":
        engine = FakeEngine()
    elif config.engine_mode == "subprocess":
        try:
            engine = build_subprocess_engine(
                bun_path=config.bun_path,
                cli_path=config.cli_path,
                claude_config_dir=config.paths.claude_config_dir,
                engine_log_dir=config.paths.engine_log_dir,
                max_engines=config.max_engines,
                cancel_grace_s=config.cancel_grace_s,
                debug_frames=config.debug_engine,
            )
        except DomainError as exc:
            LOG.error("engine unavailable at boot: %s", exc.message)
            engine = FailingEngine(exc.message)
    else:
        try:
            factory = build_matebot_session_factory(
                vendor_path=config.matebot_vendor,
                cli_path=resolve_cli(config.cli_path),
                bun_path=resolve_bun(config.bun_path),
            )
            engine = MateBotEngine(
                session_factory=factory,
                refs=sessions,
                max_sessions=config.max_engines,
                cancel_grace_s=config.cancel_grace_s,
                engine_log_dir=config.paths.engine_log_dir,
            )
        except DomainError as exc:
            LOG.error("MateBot engine unavailable at boot: %s", exc.message)
            engine = FailingEngine(exc.message)

    workspace: WorkspacePort = GitCliWorkspace(
        default_work_dir=str(config.default_cwd)
    )
    skill_catalog = FilesystemSkillCatalog(
        home_dir=home_dir or Path.home(),
        default_cwd=str(config.default_cwd),
    )
    mcp_registry = SqliteMcpRegistry(
        db, clock, connections=mcp_connections
    )
    artifact_store = FilesystemArtifactStore(
        config.paths.data_dir / "artifacts", clock
    )
    event_bus = EventBus()
    try:
        cli_path: str | None = str(resolve_cli(config.cli_path))
    except DomainError:
        cli_path = None
    session_service = SessionService(sessions)
    settings_service = SettingsService(
        settings_store, engine_config=engine_config
    )
    engine_config_service = EngineConfigService(autoagent_config, engine_config)
    skill_service = SkillService(skill_catalog, settings_store)
    mcp_service = McpService(mcp_registry)
    workspace_service = WorkspaceService(workspace, settings_store)
    artifact_service = ArtifactService(
        artifact_store, events=event_bus, clock=clock
    )
    artifact_tool_service = ArtifactToolService(
        artifact_store, mcp_service, clock=clock
    )
    turn_service = TurnService(
        sessions=sessions,
        turns=sessions,
        refs=sessions,
        engine=engine,
        settings=settings_store,
        clock=clock,
        events=event_bus,
        artifacts=artifact_store,
        cancel_wait_s=config.cancel_grace_s * 2.0 + 1.0,
    )
    bootstrap_service = BootstrapService(
        settings=settings_store,
        sessions=sessions,
        engine=engine,
        workspace=workspace,
        skills=skill_catalog,
        mcp=mcp_registry,
        artifacts=artifact_store,
        engine_config=engine_config,
    )

    container = Container(
        config=config,
        paths=config.paths,
        lifecycle=snapshot,
        db=db,
        clock=clock,
        sessions=sessions,
        settings_store=settings_store,
        autoagent_config=autoagent_config,
        engine_config=engine_config,
        engine_config_service=engine_config_service,
        cli_path=cli_path,
        engine=engine,
        workspace=workspace,
        event_bus=event_bus,
        skill_catalog=skill_catalog,
        mcp_registry=mcp_registry,
        artifact_store=artifact_store,
        session_service=session_service,
        settings_service=settings_service,
        turn_service=turn_service,
        skill_service=skill_service,
        mcp_service=mcp_service,
        workspace_service=workspace_service,
        artifact_service=artifact_service,
        artifact_tool_service=artifact_tool_service,
        bootstrap_service=bootstrap_service,
        terminal_manager=terminal_manager,
    )

    container.closers.append(terminal_manager.shutdown_now)

    _initialize(config, container)
    return container


def _terminal_cwd_guard(
    config: BootConfig, settings: SqliteSettingsStore
) -> Callable[[str], bool]:
    """Accept only the configured workspace, the default cwd and the data dir."""

    roots = [config.default_cwd.resolve(), config.paths.data_dir.resolve()]
    try:
        configured = settings.read().cwd
    except Exception:
        configured = None
    if configured:
        roots.append(Path(configured).expanduser().resolve())

    def allowed(candidate: str) -> bool:
        try:
            path = Path(candidate).resolve()
        except OSError:
            return False
        return any(path == root or path.is_relative_to(root) for root in roots)

    return allowed


def _initialize(config: BootConfig, container: Container) -> None:
    try:
        migrate(container.db, now_ms=container.clock.now_ms())
        container.sessions.fail_orphaned_turns(
            container.clock.now_ms(), code="ENGINE_EXITED"
        )
        container.lifecycle.db = "ok"
    except Exception:
        LOG.exception("database initialization failed")
        container.lifecycle.db = "error"

    if container.lifecycle.db == "ok":
        try:
            LegacyImporter(
                db=container.db,
                sessions=container.sessions,
                settings=container.settings_store,
                clock=container.clock,
                data_dir=config.paths.data_dir,
                log_path=config.paths.migration_log_path,
            ).run()
        except Exception:
            LOG.exception("legacy import failed")

    try:
        container.lifecycle.engine = container.engine.status().state.value
    except Exception:
        container.lifecycle.engine = "error"
