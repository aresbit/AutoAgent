"""Static SPA serving for the Electron shell.

The API is registered before this router; the catch-all only handles non-``/api``
paths. Serving the SPA is deliberately not token-gated: the browser must load
it before it can read the token from the URL and authorize API calls.

Security: asset paths are resolved and must stay inside ``<dist>/assets``; the
fallback never serves arbitrary filesystem files.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import cast

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from ..config import BootConfig

router = APIRouter()

INDEX_CACHE = "no-cache"
ASSET_CACHE = "public, max-age=31536000, immutable"
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "frame-src 'self' data:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'none'"
)
UNAVAILABLE_MESSAGE = (
    "frontend build is not available; build frontend/dist or set "
    "AUTOAGENT_FRONTEND_DIST"
)

_CONTENT_TYPES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
}


def resolve_asset(dist: Path, asset_path: str) -> Path | None:
    """Return the asset file, or ``None`` when missing or outside ``assets``.

    Pre: ``asset_path`` is the URL-decoded remainder after ``/assets/``.
    Post: the resolved path is a regular file strictly inside ``<dist>/assets``;
          symlinks that escape the root are rejected.
    """

    root = (dist / "assets").resolve()
    try:
        candidate = (root / asset_path).resolve()
    except OSError:
        return None
    if not candidate.is_relative_to(root) or candidate == root:
        return None
    if not candidate.is_file():
        return None
    return candidate


def content_type_for(path: Path) -> str:
    override = _CONTENT_TYPES.get(path.suffix.lower())
    if override is not None:
        return override
    guessed, _encoding = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def _frontend_dist(request: Request) -> Path:
    config = cast(BootConfig, request.app.state.config)
    return config.frontend_dist


def _unavailable() -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "ok": False,
            "code": "STATIC_UNAVAILABLE",
            "error": UNAVAILABLE_MESSAGE,
        },
        headers={"Cache-Control": "no-store"},
    )


def _not_found(message: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={"ok": False, "code": "NOT_FOUND", "error": message},
    )


def _index_response(request: Request) -> Response:
    dist = _frontend_dist(request)
    index = dist / "index.html"
    if not dist.is_dir() or not index.is_file():
        return _unavailable()
    return FileResponse(
        index,
        media_type=_CONTENT_TYPES[".html"],
        headers={
            "Cache-Control": INDEX_CACHE,
            "Content-Security-Policy": CONTENT_SECURITY_POLICY,
        },
    )


@router.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def spa_root(request: Request) -> Response:
    return _index_response(request)


@router.api_route(
    "/assets/{asset_path:path}", methods=["GET", "HEAD"], include_in_schema=False
)
def static_asset(asset_path: str, request: Request) -> Response:
    dist = _frontend_dist(request)
    if not dist.is_dir():
        return _unavailable()
    resolved = resolve_asset(dist, asset_path)
    if resolved is None:
        return _not_found("asset not found")
    return FileResponse(
        resolved,
        media_type=content_type_for(resolved),
        headers={"Cache-Control": ASSET_CACHE},
    )


@router.api_route(
    "/{spa_path:path}", methods=["GET", "HEAD"], include_in_schema=False
)
def spa_fallback(spa_path: str, request: Request) -> Response:
    # API precedence: unknown API routes must stay JSON 404s, not index.html.
    if spa_path == "api" or spa_path.startswith("api/"):
        return _not_found("not found")
    return _index_response(request)
