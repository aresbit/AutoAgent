"""Artifact lifecycle application service."""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence

from ..domain.models import (
    Artifact,
    ArtifactCreate,
    ArtifactVerification,
    ArtifactVersion,
)
from ..domain.ports import ArtifactStorePort, ClockPort
from .artifact_capabilities import normalize_tool_names
from .artifact_diff import ArtifactDiff, build_artifact_diff
from .event_bus import EventBus

AUDIT = logging.getLogger("autoagent.artifacts.audit")


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

    def set_capabilities(
        self,
        artifact_id: str,
        mcp_tools: Iterable[str],
        *,
        allow_external: bool | None = None,
    ) -> Artifact:
        tools = normalize_tool_names(mcp_tools)
        artifact = self._store.set_capabilities(
            artifact_id, tools, allow_external=allow_external
        )
        AUDIT.info(
            "capabilities artifact=%s outcome=ok tools=%d allow_external=%s",
            artifact.id,
            len(tools),
            artifact.allow_external,
        )
        self._publish(artifact, "capabilities")
        return artifact

    def diff(
        self, artifact_id: str, from_version: str, to_version: str
    ) -> ArtifactDiff:
        from_text = self._store.version_content(artifact_id, from_version)
        if from_version == to_version:
            return ArtifactDiff(from_version, to_version, "")
        to_text = self._store.version_content(artifact_id, to_version)
        return build_artifact_diff(
            from_version, from_text, to_version, to_text
        )

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
