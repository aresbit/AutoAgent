"""Skill catalog endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from ...application.skill_service import SkillService
from ..deps import get_skill_service
from ..schemas import (
    SkillDiscoverRequest,
    SkillDiscoverView,
    SkillEnableRequest,
    SkillListView,
    SkillMutationView,
    to_skill_discovery,
    to_skill_list,
    to_skill_mutation,
)

router = APIRouter()


@router.get("/api/skills", response_model=SkillListView)
def list_skills(
    cwd: str | None = Query(default=None),
    service: SkillService = Depends(get_skill_service),
) -> SkillListView:
    return to_skill_list(service.catalog(cwd))


@router.post("/api/skills/{name}/enable", response_model=SkillMutationView)
def enable_skill(
    name: str,
    body: SkillEnableRequest | None = Body(default=None),
    service: SkillService = Depends(get_skill_service),
) -> SkillMutationView:
    path = body.path if body is not None else None
    return to_skill_mutation(service.enable(name, path))


@router.post("/api/skills/{name}/disable", response_model=SkillMutationView)
def disable_skill(
    name: str,
    service: SkillService = Depends(get_skill_service),
) -> SkillMutationView:
    return to_skill_mutation(service.disable(name))


@router.post("/api/skills/discover", response_model=SkillDiscoverView)
def discover_skills(
    body: SkillDiscoverRequest,
    service: SkillService = Depends(get_skill_service),
) -> SkillDiscoverView:
    return SkillDiscoverView(
        items=[
            to_skill_discovery(match)
            for match in service.discover(body.cwd, body.query)
        ]
    )
