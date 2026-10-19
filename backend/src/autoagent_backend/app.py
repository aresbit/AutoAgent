"""FastAPI application factory and lifespan."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import Response

from . import __version__
from .api import static as static_api
from .api.deps import authorize_request
from .api.routes import (
    artifact_frame,
    artifacts,
    auth,
    bootstrap,
    engine_config,
    events,
    file_router,
    health,
    mcp,
    sessions,
    settings,
    skills,
    terminals,
    turns,
    workspace,
)
from .composition import Container, LifecycleSnapshot, build_container
from .config import BootConfig, config_from_env
from .errors import install_error_handlers
from .watchdog import ParentWatchdog, watchdog_from_config

LOG = logging.getLogger("autoagent.app")


def create_app(
    config: BootConfig | None = None,
    *,
    container: Container | None = None,
) -> FastAPI:
    """Build the ASGI app.

    Pre: ``container``, when supplied, is already initialized (tests).
    Post: returns a FastAPI app whose ``/api/health`` works before/without any
          adapter call.
    """

    resolved = config or config_from_env()
    lifecycle = LifecycleSnapshot()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        watchdog: ParentWatchdog = watchdog_from_config(resolved)
        app.state.watchdog = watchdog
        watchdog.start()
        try:
            current = app.state.container
            if current is None:
                current = build_container(resolved, app.state.lifecycle)
                app.state.container = current
            else:
                app.state.lifecycle = current.lifecycle
            yield
        finally:
            watchdog.stop()
            active = app.state.container
            if active is not None:
                active.close()

    app = FastAPI(
        title="AutoAgent backend",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.config = resolved
    app.state.lifecycle = lifecycle
    app.state.started_monotonic = time.monotonic()
    app.state.container = container

    @app.middleware("http")
    async def security_middleware(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        rejection = authorize_request(request, resolved)
        if rejection is not None:
            return rejection
        return await call_next(request)

    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(bootstrap.router)
    app.include_router(sessions.router)
    app.include_router(turns.router)
    app.include_router(settings.router)
    app.include_router(engine_config.router)
    app.include_router(skills.router)
    app.include_router(mcp.router)
    app.include_router(workspace.router)
    if resolved.files_enabled:
        app.include_router(file_router.router)
    app.include_router(artifacts.router)
    app.include_router(artifact_frame.router)
    app.include_router(events.router)
    app.include_router(terminals.router)
    # Last: the SPA catch-all must never shadow /api/*.
    app.include_router(static_api.router)
    return app
