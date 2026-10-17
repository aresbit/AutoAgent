"""Health endpoint: liveness only, no DB/engine/network I/O."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from ..schemas import HealthView

router = APIRouter()


@router.get("/api/health", response_model=HealthView)
def health(request: Request) -> HealthView:
    config = request.app.state.config
    lifecycle = request.app.state.lifecycle
    started = float(request.app.state.started_monotonic)
    uptime_ms = max(0, int((time.monotonic() - started) * 1000))
    return HealthView(
        ok=True,
        app=config.app_name,
        apiVersion=config.api_version,
        version=config.version,
        bootId=config.boot_id,
        uptimeMs=uptime_ms,
        db=lifecycle.db,
        engine=lifecycle.engine,
        state=lifecycle.state,
    )
