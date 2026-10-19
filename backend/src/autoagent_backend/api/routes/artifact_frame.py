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

# Host-mediated MCP bridge.  The iframe is untrusted: it never receives the
# launch token and cannot reach the backend directly.  It only asks the parent
# (the AutoAgent UI) to perform a JSON-RPC 2.0 ``tools/call``; the parent
# validates ``event.source``, applies consent/allowlist policy and answers the
# matching id.  A response that never arrives rejects after 30 seconds.
TOOL_BRIDGE_SCRIPT = """<script>(function(){
  var pending = {};
  var nextId = 1;
  window.addEventListener("message", function(event){
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    clearTimeout(entry.timer);
    if (data.error) { entry.reject(data.error); return; }
    entry.resolve(data.result);
  });
  window.autoagent = {
    callTool: function(name, args){
      var id = nextId++;
      return new Promise(function(resolve, reject){
        var timer = setTimeout(function(){
          delete pending[id];
          reject(new Error("tool call timed out"));
        }, 30000);
        pending[id] = {resolve: resolve, reject: reject, timer: timer};
        window.parent.postMessage({
          jsonrpc: "2.0",
          id: id,
          method: "tools/call",
          params: {name: name, arguments: args || {}}
        }, "*");
      });
    }
  };
})();</script>"""

_INJECTED_SCRIPTS = (RESIZE_REPORTER, TOOL_BRIDGE_SCRIPT)


def _config(request: Request) -> BootConfig:
    config: BootConfig = request.app.state.config
    return config


def _signature(secret: str, artifact_id: str, version: str, exp: int) -> str:
    message = f"{artifact_id}:{version}:{exp}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def _inject_scripts(document: str) -> str:
    """Inject each host bridge script at most once, just before ``</body>``."""

    missing = [script for script in _INJECTED_SCRIPTS if script not in document]
    if not missing:
        return document
    injection = "".join(missing)
    lowered = document.lower()
    index = lowered.rfind("</body>")
    if index == -1:
        return document + injection
    return document[:index] + injection + document[index:]


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
        _inject_scripts(content),
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Security-Policy": FRAME_CSP,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
        },
    )
