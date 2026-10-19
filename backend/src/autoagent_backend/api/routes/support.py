"""Support bundle download (redacted zip)."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ...application.support_bundle import (
    SupportBundleInputs,
    SupportBundleService,
)
from ...composition import Container
from ..deps import get_container

router = APIRouter()


def _desktop_log() -> Path | None:
    raw = os.environ.get("AUTOAGENT_DESKTOP_LOG_FILE", "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_file() else None


@router.get("/api/support/bundle")
def support_bundle(container: Container = Depends(get_container)) -> Response:
    """Build a redacted diagnostic zip.

    The endpoint is authenticated by the normal launch token/cookie gate.
    Secrets, message bodies and MCP env/header values never enter the bundle.
    """

    settings = container.settings_store.read()
    engine = container.engine.status()
    inputs = SupportBundleInputs(
        app_name=container.config.app_name,
        version=container.config.version,
        api_version=container.config.api_version,
        boot_id=container.config.boot_id,
        generated_at_ms=container.clock.now_ms(),
        lifecycle_state=container.lifecycle.state,
        db_state=container.lifecycle.db,
        engine_state=container.lifecycle.engine,
        engine_mode=container.config.engine_mode,
        engine_version=engine.version,
        engine_last_error=engine.last_error,
        settings=settings,
        model=container.settings_service.model_resolution(settings),
        counts=container.sessions.counts(),
        mcp_servers=container.mcp_registry.list(),
        mcp_statuses=container.mcp_registry.status(),
        data_dir=container.paths.data_dir,
        state_dir=container.paths.state_dir,
        log_dir=container.paths.log_dir,
        db_path=container.paths.db_path,
        backend_log=container.paths.backend_log_path,
        desktop_log=_desktop_log(),
        secrets=(container.config.api_token,),
    )
    payload = SupportBundleService().build(inputs)
    filename = f"autoagent-support-{container.config.boot_id[:8]}.zip"
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
