"""Engine configuration application service."""

from __future__ import annotations

from ..domain.models import AutoAgentConfig, AutoAgentConfigPatch, ModelResolution, Settings
from ..domain.ports import AutoAgentConfigPort, EngineConfigPort


class EngineConfigService:
    """Frontend-editable config plus effective resolution."""

    def __init__(
        self, store: AutoAgentConfigPort, resolver: EngineConfigPort
    ) -> None:
        self._store = store
        self._resolver = resolver

    @property
    def config_path(self) -> str:
        return self._store.config_path

    def read(self) -> AutoAgentConfig:
        return self._store.read()

    def update(self, patch: AutoAgentConfigPatch) -> AutoAgentConfig:
        config = self._store.update(patch)
        # Re-export AutoAgent-sourced values so the next engine child sees them.
        self._resolver.apply_environment()
        return config

    def resolution(self, settings: Settings) -> ModelResolution:
        return self._resolver.resolve(settings.model)
