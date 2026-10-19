"""Session endpoints; handlers only parse, delegate and serialize."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from ...application.session_service import SessionService
from ...composition import Container
from ..deps import get_container, get_session_service
from ..schemas import (
    BranchSessionRequest,
    CreateSessionRequest,
    DeleteResponse,
    RenameSessionRequest,
    SessionListView,
    SessionView,
    to_session_summary,
    to_session_view,
)

router = APIRouter()


@router.get("/api/sessions", response_model=SessionListView)
def list_sessions(
    limit: int | None = Query(default=None, ge=1, le=1000),
    service: SessionService = Depends(get_session_service),
) -> SessionListView:
    return SessionListView(
        sessions=[to_session_summary(session) for session in service.list(limit)]
    )


@router.post("/api/sessions", response_model=SessionView)
def create_session(
    body: CreateSessionRequest | None = Body(default=None),
    service: SessionService = Depends(get_session_service),
) -> SessionView:
    title = body.title if body is not None else None
    return to_session_view(service.create(title))


@router.get("/api/sessions/{session_id}", response_model=SessionView)
def get_session(
    session_id: str,
    service: SessionService = Depends(get_session_service),
) -> SessionView:
    return to_session_view(service.get(session_id))


@router.patch("/api/sessions/{session_id}", response_model=SessionView)
def rename_session(
    session_id: str,
    body: RenameSessionRequest,
    service: SessionService = Depends(get_session_service),
) -> SessionView:
    return to_session_view(service.rename(session_id, body.title))


@router.delete("/api/sessions/{session_id}", response_model=DeleteResponse)
async def delete_session(
    session_id: str,
    service: SessionService = Depends(get_session_service),
    container: Container = Depends(get_container),
) -> DeleteResponse:
    service.delete(session_id)
    await container.terminal_manager.destroy_owner(session_id)
    return DeleteResponse(deleted=True)


@router.post("/api/sessions/{session_id}/branch", response_model=SessionView)
def branch_session(
    session_id: str,
    body: BranchSessionRequest | None = Body(default=None),
    service: SessionService = Depends(get_session_service),
) -> SessionView:
    title = body.title if body is not None else None
    return to_session_view(service.branch(session_id, title))
