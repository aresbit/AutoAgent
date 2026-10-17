"""Artifact lifecycle application service."""

from __future__ import annotations

from collections.abc import Sequence

from ..domain.models import Artifact, ArtifactCreate
from ..domain.ports import ArtifactStorePort


class ArtifactService:
    def __init__(self, store: ArtifactStorePort) -> None:
        self._store = store

    def list(self) -> Sequence[Artifact]:
        return self._store.list()

    def get(self, artifact_id: str) -> Artifact:
        return self._store.get(artifact_id)

    def create(self, request: ArtifactCreate) -> Artifact:
        return self._store.create(request)

    def content(self, artifact_id: str) -> str:
        return self._store.content(artifact_id)

    def mark_opened(self, artifact_id: str) -> Artifact:
        return self._store.mark_opened(artifact_id)

    def export(self, artifact_id: str, target_path: str) -> str:
        return self._store.export(artifact_id, target_path)

    def import_archive(self, zip_path: str) -> Artifact:
        return self._store.import_archive(zip_path)
