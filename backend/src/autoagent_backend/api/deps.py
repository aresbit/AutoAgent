"""FastAPI dependencies and the token/origin security gate."""

from __future__ import annotations

import hmac
import re
from typing import TYPE_CHECKING

from fastapi import Request
from fastapi.responses import JSONResponse

from ..config import BootConfig
from ..domain.errors import Unauthorized

if TYPE_CHECKING:
    from ..application.artifact_service import ArtifactService
    from ..application.mcp_service import McpService
    from ..application.session_service import SessionService
    from ..application.settings_service import SettingsService
    from ..application.skill_service import SkillService
    from ..application.turn_service import TurnService
    from ..application.workspace_service import WorkspaceService
    from ..composition import Container

TOKEN_COOKIE = "autoagent_token"
HEALTH_PATH = "/api/health"
MAX_BODY_BYTES = 1024 * 1024

# Frame GETs authenticate with their own scoped HMAC token in the query string;
# the bearer token must never be copied into an iframe URL.  Only the exact
# GET frame path is exempt -- frame-token issuance stays bearer-protected.
_FRAME_PATH = re.compile(r"^/api/artifacts/[^/]+/frame$")


def get_container(request: Request) -> Container:
    container = getattr(request.app.state, "container", None)
    if container is None:  # pragma: no cover - lifespan invariant
        raise Unauthorized("backend is not initialized")
    return container  # type: ignore[no-any-return]


def get_session_service(request: Request) -> SessionService:
    return get_container(request).session_service


def get_settings_service(request: Request) -> SettingsService:
    return get_container(request).settings_service


def get_turn_service(request: Request) -> TurnService:
    return get_container(request).turn_service


def get_skill_service(request: Request) -> SkillService:
    return get_container(request).skill_service


def get_mcp_service(request: Request) -> McpService:
    return get_container(request).mcp_service


def get_workspace_service(request: Request) -> WorkspaceService:
    return get_container(request).workspace_service


def get_artifact_service(request: Request) -> ArtifactService:
    return get_container(request).artifact_service


def extract_token(request: Request) -> str | None:
    """Return the Bearer token or launch cookie value, if present."""

    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    cookie = request.cookies.get(TOKEN_COOKIE)
    return cookie.strip() if cookie else None


def authorize_request(
    request: Request, config: BootConfig
) -> JSONResponse | None:
    """Enforce origin and launch-token checks.

    Post: returns ``None`` when the request may proceed; otherwise a JSON error
          response. ``/api/health`` is token-exempt but not origin-exempt.
    """

    path = request.url.path

    origin = request.headers.get("origin")
    if origin is not None and origin != config.origin:
        return JSONResponse(
            status_code=403,
            content={
                "ok": False,
                "code": "FORBIDDEN",
                "error": "origin is not allowed",
            },
        )

    if not path.startswith("/api/"):
        return None

    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > MAX_BODY_BYTES:
                return JSONResponse(
                    status_code=413,
                    content={
                        "ok": False,
                        "code": "PAYLOAD_TOO_LARGE",
                        "error": "request body exceeds 1 MiB",
                    },
                )
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "code": "BAD_REQUEST",
                    "error": "invalid Content-Length",
                },
            )

    if path == HEALTH_PATH:
        return None

    if request.method in {"GET", "HEAD"} and _FRAME_PATH.match(path):
        return None

    expected = config.api_token
    provided = extract_token(request)
    if not expected or provided is None or not hmac.compare_digest(provided, expected):
        return JSONResponse(
            status_code=401,
            content={
                "ok": False,
                "code": "UNAUTHORIZED",
                "error": "a valid launch token is required",
            },
            headers={"WWW-Authenticate": "Bearer"},
        )
    return None
