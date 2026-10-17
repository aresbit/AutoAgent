"""Bootstrap aggregate endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...composition import Container
from ..deps import get_container
from ..schemas import BootstrapView, to_bootstrap_view

router = APIRouter()


@router.get("/api/bootstrap", response_model=BootstrapView)
def bootstrap(container: Container = Depends(get_container)) -> BootstrapView:
    data = container.bootstrap_service.read()
    return to_bootstrap_view(
        data,
        engine_version=data.engine.version,
        cli_path=container.cli_path,
    )
