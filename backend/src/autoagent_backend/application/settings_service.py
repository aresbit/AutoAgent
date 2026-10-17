"""Settings application service and per-turn patch merging."""

from __future__ import annotations

import dataclasses

from ..domain.errors import PermissionModeUnsupported
from ..domain.models import (
    Layout,
    ModelResolution,
    PermissionPolicy,
    Provider,
    ProviderCatalog,
    Settings,
    SettingsPatch,
)
from ..domain.ports import EngineConfigPort, SettingsPort


def merge_settings(base: Settings, patch: SettingsPatch | None) -> Settings:
    """Apply a partial patch without persisting it.

    Post: returns a new ``Settings``; ``api_key=""`` clears the key.
    Raises: ``PermissionModeUnsupported`` when the patch selects a mode other
            than ``bypassPermissions``.
    """

    if patch is None:
        return base
    if patch.permission_mode not in (None, PermissionPolicy.FULL_ACCESS.value):
        raise PermissionModeUnsupported(
            "v1 supports permissionMode='bypassPermissions' only"
        )
    changes: dict[str, object] = {}
    for field in dataclasses.fields(patch):
        value = getattr(patch, field.name)
        if value is None:
            continue
        if field.name == "api_key" and value == "":
            changes["api_key"] = None
        elif field.name == "layout":
            assert isinstance(value, Layout)
            changes["layout"] = value
        else:
            changes[field.name] = value
    if not changes:
        return base
    return dataclasses.replace(base, **changes)  # type: ignore[arg-type]


class SettingsService:
    """Thin application service over ``SettingsPort``."""

    def __init__(
        self,
        settings: SettingsPort,
        *,
        engine_config: EngineConfigPort | None = None,
    ) -> None:
        self._settings = settings
        self._engine_config = engine_config

    def read(self) -> Settings:
        return self._settings.read()

    def update(self, patch: SettingsPatch) -> Settings:
        return self._settings.update(patch)

    def model_resolution(
        self, settings: Settings | None = None
    ) -> ModelResolution:
        """Resolve the effective model; the desktop override is optional."""

        chosen = settings if settings is not None else self._settings.read()
        if self._engine_config is None:
            return ModelResolution(model=None, source="default")
        return self._engine_config.resolve(chosen.model)

    def providers(self) -> ProviderCatalog:
        return self._settings.providers()

    def provider(self, provider_id: str) -> Provider:
        return self._settings.provider(provider_id)
