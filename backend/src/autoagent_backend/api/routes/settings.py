"""Settings and provider endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...application.settings_service import SettingsService
from ...composition import Container
from ..deps import get_container, get_settings_service
from ..schemas import (
    ProviderCatalogView,
    ProviderView,
    SettingsPatchInput,
    SettingsView,
    to_domain_patch,
    to_provider_catalog,
    to_provider_view,
    to_settings_view,
)

router = APIRouter()


@router.get("/api/settings", response_model=SettingsView)
def read_settings(container: Container = Depends(get_container)) -> SettingsView:
    settings = container.settings_service.read()
    return to_settings_view(
        settings,
        engine_version=container.engine.status().version,
        model_resolution=container.settings_service.model_resolution(settings),
        cli_path=container.cli_path,
    )


@router.put("/api/settings", response_model=SettingsView)
def update_settings(
    patch: SettingsPatchInput,
    container: Container = Depends(get_container),
) -> SettingsView:
    settings = container.settings_service.update(to_domain_patch(patch))
    return to_settings_view(
        settings,
        engine_version=container.engine.status().version,
        model_resolution=container.settings_service.model_resolution(settings),
        cli_path=container.cli_path,
    )


@router.get("/api/providers", response_model=ProviderCatalogView)
def list_providers(
    service: SettingsService = Depends(get_settings_service),
) -> ProviderCatalogView:
    return to_provider_catalog(service.providers())


@router.get("/api/providers/{provider_id}", response_model=ProviderView)
def get_provider(
    provider_id: str,
    service: SettingsService = Depends(get_settings_service),
) -> ProviderView:
    return to_provider_view(service.provider(provider_id))
