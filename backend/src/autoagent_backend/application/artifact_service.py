"""Artifact lifecycle application service."""

from __future__ import annotations

from collections.abc import Sequence

from ..domain.models import (
    Artifact,
    ArtifactCreate,
    ArtifactVerification,
    ArtifactVersion,
)
from ..domain.ports import ArtifactStorePort, ClockPort
from .event_bus import EventBus


class ArtifactService:
    def __init__(
        self,
        store: ArtifactStorePort,
        *,
        events: EventBus | None = None,
        clock: ClockPort | None = None,
    ) -> None:
        self._store = store
        self._events = events
        self._clock = clock

    def list(self) -> Sequence[Artifact]:
        return self._store.list()

    def get(self, artifact_id: str) -> Artifact:
        return self._store.get(artifact_id)

    def create(self, request: ArtifactCreate) -> Artifact:
        artifact = self._store.create(request)
        self._publish(artifact, _reason_for(artifact))
        return artifact

    def content(self, artifact_id: str) -> str:
        return self._store.content(artifact_id)

    def mark_opened(self, artifact_id: str) -> Artifact:
        return self._store.mark_opened(artifact_id)

    def export(self, artifact_id: str, target_path: str) -> str:
        return self._store.export(artifact_id, target_path)

    def import_archive(self, zip_path: str) -> Artifact:
        artifact = self._store.import_archive(zip_path)
        self._publish(artifact, _reason_for(artifact))
        return artifact

    def versions(self, artifact_id: str) -> Sequence[ArtifactVersion]:
        return self._store.versions(artifact_id)

    def version_content(self, artifact_id: str, version_id: str) -> str:
        return self._store.version_content(artifact_id, version_id)

    def restore(self, artifact_id: str, version_id: str) -> Artifact:
        artifact = self._store.restore(artifact_id, version_id)
        self._publish(artifact, "restored")
        return artifact

    def verify(self, artifact_id: str) -> ArtifactVerification:
        return self._store.verify(artifact_id)

    def _publish(self, artifact: Artifact, reason: str) -> None:
        if self._events is None:
            return
        payload: dict[str, object] = {
            "type": "artifacts.changed",
            "reason": reason,
            "artifactIds": [artifact.id],
        }
        if self._clock is not None:
            payload["ts"] = self._clock.now_ms()
        self._events.publish(payload)


def _reason_for(artifact: Artifact) -> str:
    return "created" if artifact.created_at == artifact.updated_at else "updated"
