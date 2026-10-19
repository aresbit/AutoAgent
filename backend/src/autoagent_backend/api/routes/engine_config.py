"""Frontend-editable AutoAgent engine config (model/baseURL/apiKey/apiKeyHelper)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...composition import Container
from ..deps import get_container
from ..schemas import (
    EngineConfigPatch,
    EngineConfigView,
    to_domain_autoagent_patch,
    to_engine_config_view,
)

router = APIRouter()


def _view(container: Container, config: object) -> EngineConfigView:
    settings = container.settings_service.read()
    resolution = container.engine_config_service.resolution(settings)
    return to_engine_config_view(
        config,  # type: ignore[arg-type]
        resolution,
        engine_version=container.engine.status().version,
        cli_path=container.cli_path,
        harness=settings.engine_harness,
    )


@router.get("/api/engine/config", response_model=EngineConfigView)
def read_engine_config(
    container: Container = Depends(get_container),
) -> EngineConfigView:
    return _view(container, container.engine_config_service.read())


@router.put("/api/engine/config", response_model=EngineConfigView)
def update_engine_config(
    patch: EngineConfigPatch,
    container: Container = Depends(get_container),
) -> EngineConfigView:
    config = container.engine_config_service.update(
        to_domain_autoagent_patch(patch)
    )
    return _view(container, config)
