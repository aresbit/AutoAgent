"""Skill catalog application service.

The service owns only workspace resolution; scanning, precedence and directory
moves stay in ``SkillCatalogPort``.
"""

from __future__ import annotations

from ..domain.models import SkillCatalogData, SkillMatch
from ..domain.ports import SettingsPort, SkillCatalogPort


class SkillService:
    def __init__(self, catalog: SkillCatalogPort, settings: SettingsPort) -> None:
        self._catalog = catalog
        self._settings = settings

    def catalog(self, cwd: str | None = None) -> SkillCatalogData:
        return self._catalog.catalog(self._workspace(cwd))

    def enable(
        self, name: str, path: str | None = None, cwd: str | None = None
    ) -> SkillCatalogData:
        return self._catalog.enable(name, path, self._workspace(cwd))

    def disable(self, name: str, cwd: str | None = None) -> SkillCatalogData:
        return self._catalog.disable(name, self._workspace(cwd))

    def discover(
        self, cwd: str | None, query: str | None = None
    ) -> tuple[SkillMatch, ...]:
        return tuple(self._catalog.discover(self._workspace(cwd), query))

    def _workspace(self, cwd: str | None) -> str | None:
        if cwd is not None and cwd.strip():
            return cwd
        return self._settings.read().cwd or None
