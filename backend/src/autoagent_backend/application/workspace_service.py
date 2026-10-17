"""Workspace application service.

The configured settings workspace is the default; callers may override it
per request.
"""

from __future__ import annotations

from ..domain.models import FileDiff, WorkspaceStatus
from ..domain.ports import SettingsPort, WorkspacePort


class WorkspaceService:
    def __init__(self, workspace: WorkspacePort, settings: SettingsPort) -> None:
        self._workspace = workspace
        self._settings = settings

    def status(
        self, work_dir: str | None = None, base: str | None = None
    ) -> WorkspaceStatus:
        return self._workspace.status(self._root(work_dir), base)

    def diff(self, path: str, work_dir: str | None = None) -> FileDiff:
        return self._workspace.diff(path, self._root(work_dir))

    def switch_branch(
        self, branch: str, work_dir: str | None = None
    ) -> WorkspaceStatus:
        root = self._root(work_dir)
        self._workspace.switch_branch(branch, root)
        return self._workspace.status(root)

    def init(self, work_dir: str | None = None) -> WorkspaceStatus:
        root = self._root(work_dir)
        self._workspace.init(root)
        return self._workspace.status(root)

    def _root(self, work_dir: str | None) -> str | None:
        if work_dir is not None and work_dir.strip():
            return work_dir
        return self._settings.read().cwd or None
