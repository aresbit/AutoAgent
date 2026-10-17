"""Workspace status, diff and git mutation endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from ...application.workspace_service import WorkspaceService
from ..deps import get_workspace_service
from ..schemas import (
    BranchSwitchRequest,
    FileDiffView,
    WorkspaceInitRequest,
    WorkspaceStatusView,
    to_file_diff_view,
    to_workspace_view,
)

router = APIRouter()


@router.get("/api/workspace", response_model=WorkspaceStatusView)
def get_workspace(
    work_dir: str | None = Query(default=None, alias="workDir"),
    base: str | None = Query(default=None),
    service: WorkspaceService = Depends(get_workspace_service),
) -> WorkspaceStatusView:
    return to_workspace_view(service.status(work_dir, base))


@router.get("/api/workspace/diff", response_model=FileDiffView)
def get_workspace_diff(
    path: str = Query(min_length=1),
    work_dir: str | None = Query(default=None, alias="workDir"),
    service: WorkspaceService = Depends(get_workspace_service),
) -> FileDiffView:
    return to_file_diff_view(service.diff(path, work_dir))


@router.post(
    "/api/workspace/branches/switch", response_model=WorkspaceStatusView
)
def switch_branch(
    body: BranchSwitchRequest,
    service: WorkspaceService = Depends(get_workspace_service),
) -> WorkspaceStatusView:
    return to_workspace_view(service.switch_branch(body.branch, body.workDir))


@router.post("/api/workspace/init", response_model=WorkspaceStatusView)
def init_workspace(
    body: WorkspaceInitRequest | None = Body(default=None),
    service: WorkspaceService = Depends(get_workspace_service),
) -> WorkspaceStatusView:
    work_dir = body.workDir if body is not None else None
    return to_workspace_view(service.init(work_dir))
