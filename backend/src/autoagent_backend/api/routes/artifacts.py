"""Artifact lifecycle endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse

from ...application.artifact_service import ArtifactService
from ...application.artifact_tool_service import ArtifactToolService
from ..deps import get_artifact_service, get_artifact_tool_service
from ..schemas import (
    ArtifactCapabilitiesRequest,
    ArtifactCreateRequest,
    ArtifactDiffView,
    ArtifactExportRequest,
    ArtifactImportRequest,
    ArtifactListView,
    ArtifactPathView,
    ArtifactToolCallRequest,
    ArtifactToolCallView,
    ArtifactVerifyView,
    ArtifactVersionsView,
    ArtifactView,
    to_artifact_create,
    to_artifact_diff_view,
    to_artifact_tool_call_view,
    to_artifact_verify_view,
    to_artifact_version_view,
    to_artifact_view,
)

router = APIRouter()


@router.get("/api/artifacts", response_model=ArtifactListView)
def list_artifacts(
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactListView:
    return ArtifactListView(
        artifacts=[to_artifact_view(item) for item in service.list()]
    )


@router.post("/api/artifacts", response_model=ArtifactView)
def create_artifact(
    body: ArtifactCreateRequest,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactView:
    return to_artifact_view(service.create(to_artifact_create(body)))


@router.post("/api/artifacts/import", response_model=ArtifactView)
def import_artifact(
    body: ArtifactImportRequest,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactView:
    return to_artifact_view(service.import_archive(body.zipPath))


@router.get("/api/artifacts/{artifact_id}", response_model=ArtifactView)
def get_artifact(
    artifact_id: str,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactView:
    return to_artifact_view(service.get(artifact_id))


@router.put(
    "/api/artifacts/{artifact_id}/capabilities",
    response_model=ArtifactView,
)
def update_artifact_capabilities(
    artifact_id: str,
    body: ArtifactCapabilitiesRequest,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactView:
    return to_artifact_view(
        service.set_capabilities(
            artifact_id,
            body.mcpTools,
            allow_external=body.allowExternal,
        )
    )


@router.post(
    "/api/artifacts/{artifact_id}/tools/call",
    response_model=ArtifactToolCallView,
)
def call_artifact_tool(
    artifact_id: str,
    body: ArtifactToolCallRequest,
    service: ArtifactToolService = Depends(get_artifact_tool_service),
) -> ArtifactToolCallView:
    return to_artifact_tool_call_view(
        service.call(
            artifact_id,
            name=body.name,
            arguments=body.arguments,
            consent=body.consent,
            request_id=body.requestId,
        )
    )


@router.get(
    "/api/artifacts/{artifact_id}/diff",
    response_model=ArtifactDiffView,
)
def diff_artifact_versions(
    artifact_id: str,
    from_version: str = Query(alias="from"),
    to_version: str = Query(alias="to"),
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactDiffView:
    return to_artifact_diff_view(
        service.diff(artifact_id, from_version, to_version)
    )


@router.get(
    "/api/artifacts/{artifact_id}/content",
    response_class=PlainTextResponse,
)
def get_artifact_content(
    artifact_id: str,
    service: ArtifactService = Depends(get_artifact_service),
) -> PlainTextResponse:
    return PlainTextResponse(
        service.content(artifact_id), media_type="text/html; charset=utf-8"
    )


@router.get("/api/artifacts/{artifact_id}/versions", response_model=ArtifactVersionsView)
def list_artifact_versions(
    artifact_id: str,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactVersionsView:
    return ArtifactVersionsView(
        versions=[
            to_artifact_version_view(item) for item in service.versions(artifact_id)
        ]
    )


@router.get(
    "/api/artifacts/{artifact_id}/versions/{version_id}/content",
    response_class=PlainTextResponse,
)
def get_artifact_version_content(
    artifact_id: str,
    version_id: str,
    service: ArtifactService = Depends(get_artifact_service),
) -> PlainTextResponse:
    return PlainTextResponse(
        service.version_content(artifact_id, version_id),
        media_type="text/html; charset=utf-8",
    )


@router.post(
    "/api/artifacts/{artifact_id}/versions/{version_id}/restore",
    response_model=ArtifactView,
)
def restore_artifact_version(
    artifact_id: str,
    version_id: str,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactView:
    return to_artifact_view(service.restore(artifact_id, version_id))


@router.post(
    "/api/artifacts/{artifact_id}/verify",
    response_model=ArtifactVerifyView,
)
def verify_artifact(
    artifact_id: str,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactVerifyView:
    return to_artifact_verify_view(service.verify(artifact_id))


@router.post("/api/artifacts/{artifact_id}/open", response_model=ArtifactView)
def open_artifact(
    artifact_id: str,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactView:
    return to_artifact_view(service.mark_opened(artifact_id))


@router.post("/api/artifacts/{artifact_id}/export", response_model=ArtifactPathView)
def export_artifact(
    artifact_id: str,
    body: ArtifactExportRequest,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactPathView:
    return ArtifactPathView(
        path=service.export(artifact_id, body.targetPath)
    )
