"""CSP-independent artifact frame endpoint.

Artifacts are normally rendered in a ``srcdoc`` iframe, which inherits the
parent document's Content-Security-Policy and therefore blocks their inline
scripts.  This module serves one artifact version from a dedicated endpoint
with a policy that permits inline scripts but no network access.  Access is
delegated to a short-lived HMAC token so the bearer token never appears in a
URL (and thus never in history, logs or the iframe ``src``).
"""

from __future__ import annotations

import hashlib
import hmac
import time
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse

from ...application.artifact_service import ArtifactService
from ...config import BootConfig
from ...domain.errors import Unauthorized
from ..deps import get_artifact_service
from ..schemas import ArtifactFrameTokenRequest, ArtifactFrameTokenView

router = APIRouter()

FRAME_TOKEN_TTL_S = 300

FRAME_CSP = (
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; "
    "script-src 'unsafe-inline'; font-src data:; connect-src 'none'; "
    "form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
)

# The reporter posts the rendered document height to the embedding panel so a
# long artifact is not clipped.  It must run in the frame itself (``parent``
# is the AutoAgent UI).
RESIZE_REPORTER = (
    "<script>(function(){function s(){parent.postMessage({type:"
    '"autoagent:artifact-resize",height:Math.ceil(document.documentElement.'
    'scrollHeight)},"*")}window.addEventListener("load",s);'
    "if(window.ResizeObserver)new ResizeObserver(s).observe("
    "document.documentElement)})();</script>"
)


def _config(request: Request) -> BootConfig:
    config: BootConfig = request.app.state.config
    return config


def _signature(secret: str, artifact_id: str, version: str, exp: int) -> str:
    message = f"{artifact_id}:{version}:{exp}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def _inject_resize_reporter(document: str) -> str:
    if RESIZE_REPORTER in document:
        return document
    lowered = document.lower()
    index = lowered.rfind("</body>")
    if index == -1:
        return document + RESIZE_REPORTER
    return document[:index] + RESIZE_REPORTER + document[index:]


@router.post(
    "/api/artifacts/{artifact_id}/frame-token",
    response_model=ArtifactFrameTokenView,
)
def issue_frame_token(
    artifact_id: str,
    body: ArtifactFrameTokenRequest,
    request: Request,
    service: ArtifactService = Depends(get_artifact_service),
) -> ArtifactFrameTokenView:
    config = _config(request)
    artifact = service.get(artifact_id)
    version = body.version or artifact.revision
    # Raises ArtifactNotFound for an unknown version and InvalidInput for a
    # syntactically invalid one.
    service.version_content(artifact_id, version)

    exp = int(time.time()) + FRAME_TOKEN_TTL_S
    signature = _signature(config.api_token, artifact_id, version, exp)
    url = (
        f"/api/artifacts/{quote(artifact_id, safe='')}/frame"
        f"?version={quote(version, safe='')}&exp={exp}&sig={signature}"
    )
    return ArtifactFrameTokenView(url=url, expiresAt=exp)


@router.api_route(
    "/api/artifacts/{artifact_id}/frame",
    methods=["GET", "HEAD"],
    response_class=HTMLResponse,
)
def get_artifact_frame(
    artifact_id: str,
    version: str,
    exp: int,
    sig: str,
    request: Request,
    service: ArtifactService = Depends(get_artifact_service),
) -> HTMLResponse:
    secret = _config(request).api_token
    if not secret:
        raise Unauthorized("artifact frames are unavailable")
    if exp < int(time.time()):
        raise Unauthorized("artifact frame token has expired")
    expected = _signature(secret, artifact_id, version, exp)
    if not hmac.compare_digest(sig, expected):
        raise Unauthorized("invalid artifact frame token")

    content = service.version_content(artifact_id, version)
    return HTMLResponse(
        _inject_resize_reporter(content),
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Security-Policy": FRAME_CSP,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
        },
    )
