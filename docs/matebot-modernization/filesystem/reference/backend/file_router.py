"""FastAPI file-browser router (reference implementation).

Integration mapping
-------------------
Copy to ``backend/src/autoagent_backend/api/routes/file_router.py``.  Change
the service import to ``from ...adapters.files.safe_file_service import ...``
and keep ``from ..deps import get_container``.  Register the router in
``app.py`` **before** ``static_api.router`` and add a ``FileServiceError``
exception handler in ``errors.py`` that preserves ``exc.code``.

Security
--------
* Authentication and origin checks are already enforced by the
  ``security_middleware`` in ``app.py`` (launch token + cookie).  This module
  additionally requires a loopback client address.
* The router never accepts absolute paths and never returns the absolute path
  of a workspace file except to the injected native reveal hook.
* All filesystem work is delegated to ``SafeFileService``; handlers only
  convert failures to HTTP and DTOs to JSON.
"""

from __future__ import annotations

import functools
import mimetypes
import re
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, BinaryIO, Literal, NoReturn
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
)
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.concurrency import run_in_threadpool

# Integration: ``get_container`` lives one level up in ``api/deps.py``.
from ..deps import get_container
from .file_service import (
    DirListing,
    FileBytes,
    FileEntry,
    FileServiceError,
    FileStat,
    FileText,
    SafeFileService,
    WriteResult,
)

router = APIRouter()

_MAX_TEXT_CHARS = 1_048_576
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_THUMBNAIL_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
        "image/x-icon",
    }
)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


def _require_loopback(request: Request) -> None:
    """Defence in depth: accept only loopback peers.

    Pre: ``request.client`` may be ``None`` for in-process transports.
    Post: returns for 127.0.0.1/::1/localhost; raises 403 otherwise.
    """

    client = request.client
    host = client.host if client is not None else None
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="loopback access only")


router = APIRouter(dependencies=[Depends(_require_loopback)])


def get_file_service(request: Request) -> SafeFileService:
    """Return the composed file service.

    Pre: the lifespan has built a container exposing ``file_service`` or the
         test app set ``app.state.file_service``.
    Post: returns the single shared ``SafeFileService`` instance.
    Raises: 503 when composition has not provided one.
    """

    candidate = getattr(request.app.state, "file_service", None)
    if isinstance(candidate, SafeFileService):
        return candidate
    container = get_container(request)
    service = getattr(container, "file_service", None)
    if not isinstance(service, SafeFileService):
        raise HTTPException(status_code=503, detail="file service is unavailable")
    return service


def get_reveal_hook(request: Request) -> Callable[[str], None] | None:
    """Return the optional desktop-shell bridge.

    Pre: the hook, when present, is callable with an absolute path and performs
         no work in the request thread beyond delegating to Electron.
    Post: returns ``None`` in browser-only builds.
    """

    hook = getattr(request.app.state, "file_reveal_hook", None)
    return hook if callable(hook) else None


def _call[**P, T](func: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    """Invoke a service method and translate policy failures to HTTP."""

    try:
        return func(*args, **kwargs)
    except FileServiceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc


def _fail(exc: FileServiceError) -> NoReturn:
    raise HTTPException(status_code=exc.status, detail=exc.message)


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class HashGuardedModel(ApiModel):
    expectedSha256: str | None = None

    @field_validator("expectedSha256")
    @classmethod
    def _check_hash(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        if re.fullmatch(r"[0-9a-f]{64}", cleaned) is None:
            raise ValueError("expectedSha256 must be 64 hex characters")
        return cleaned


class FileEntryView(ApiModel):
    name: str
    path: str
    kind: Literal["file", "directory", "symlink"]
    size: int
    mtimeMs: int
    hidden: bool
    isSymlink: bool


class FileListResponse(ApiModel):
    root: str
    path: str
    entries: list[FileEntryView]
    nextCursor: str | None
    total: int
    hidden: bool


class FileStatView(ApiModel):
    root: str
    path: str
    name: str
    kind: Literal["file", "directory", "symlink"]
    size: int
    mtimeMs: int
    mode: int
    hidden: bool
    isSymlink: bool


class FileTextView(ApiModel):
    root: str
    path: str
    text: str | None
    binary: bool
    encoding: str | None
    size: int
    lineCount: int
    truncated: bool
    mtimeMs: int
    mime: str
    sha256: str | None


class WriteContentView(HashGuardedModel):
    root: str = Field(default="workspace", max_length=200)
    path: str = Field(min_length=1, max_length=4096)
    text: str = Field(max_length=_MAX_TEXT_CHARS)


class CreateRequest(ApiModel):
    root: str = Field(default="workspace", max_length=200)
    path: str = Field(min_length=1, max_length=4096)
    text: str = Field(default="", max_length=_MAX_TEXT_CHARS)
    overwrite: bool = False


class MkdirRequest(ApiModel):
    root: str = Field(default="workspace", max_length=200)
    path: str = Field(min_length=1, max_length=4096)
    parents: bool = False


class RenameRequest(ApiModel):
    root: str = Field(default="workspace", max_length=200)
    fromPath: str = Field(min_length=1, max_length=4096)
    toPath: str = Field(min_length=1, max_length=4096)
    overwrite: bool = False


class DeleteRequest(ApiModel):
    root: str = Field(default="workspace", max_length=200)
    path: str = Field(min_length=1, max_length=4096)


class CopyMoveRequest(ApiModel):
    root: str = Field(default="workspace", max_length=200)
    fromPath: str = Field(min_length=1, max_length=4096)
    toPath: str = Field(min_length=1, max_length=4096)
    overwrite: bool = False


class WriteResponse(ApiModel):
    root: str
    path: str
    size: int
    sha256: str
    mtimeMs: int
    created: bool


class DeleteResponse(ApiModel):
    deleted: bool


class RevealRequest(ApiModel):
    root: str = Field(default="workspace", max_length=200)
    path: str = Field(min_length=1, max_length=4096)


class RevealResponse(ApiModel):
    revealed: bool
    root: str
    path: str


# ---------------------------------------------------------------------------
# Mappers
# ---------------------------------------------------------------------------


def _entry_view(entry: FileEntry) -> FileEntryView:
    return FileEntryView(
        name=entry.name,
        path=entry.path,
        kind=entry.kind,
        size=entry.size,
        mtimeMs=entry.mtime_ms,
        hidden=entry.hidden,
        isSymlink=entry.is_symlink,
    )


def _listing_view(listing: DirListing) -> FileListResponse:
    return FileListResponse(
        root=listing.root,
        path=listing.path,
        entries=[_entry_view(entry) for entry in listing.entries],
        nextCursor=listing.next_cursor,
        total=listing.total,
        hidden=listing.hidden,
    )


def _stat_view(info: FileStat) -> FileStatView:
    return FileStatView(
        root=info.root,
        path=info.path,
        name=info.name,
        kind=info.kind,
        size=info.size,
        mtimeMs=info.mtime_ms,
        mode=info.mode,
        hidden=info.hidden,
        isSymlink=info.is_symlink,
    )


def _text_view(text: FileText) -> FileTextView:
    return FileTextView(
        root=text.root,
        path=text.path,
        text=text.text,
        binary=text.binary,
        encoding=text.encoding,
        size=text.size,
        lineCount=text.line_count,
        truncated=text.truncated,
        mtimeMs=text.mtime_ms,
        mime=text.mime,
        sha256=text.sha256,
    )


def _write_view(result: WriteResult) -> WriteResponse:
    return WriteResponse(
        root=result.root,
        path=result.path,
        size=result.size,
        sha256=result.sha256,
        mtimeMs=result.mtime_ms,
        created=result.created,
    )


def _mime_for(name: str) -> str:
    guessed, _ = mimetypes.guess_type(name)
    return guessed or "application/octet-stream"


def _disposition(name: str, *, inline: bool) -> str:
    fallback = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "download"
    encoded = quote(name, safe="")
    return (
        f"{'inline' if inline else 'attachment'}; "
        f'filename="{fallback}"; filename*=UTF-8\'\'{encoded}'
    )


def _range(value: str, size: int) -> tuple[int, int]:
    """Parse a single ``bytes=`` range.

    Post: returns inclusive ``(start, end)`` clamped to the file size.
    Raises: 416 for malformed, multiple, or unsatisfiable ranges.
    """

    match = _RANGE_RE.fullmatch(value.strip())
    if match is None:
        raise HTTPException(
            status_code=416,
            detail="only a single bytes range is supported",
            headers={"Content-Range": f"bytes */{size}"},
        )
    raw_start, raw_end = match.groups()
    if raw_start == "" and raw_end == "":
        raise HTTPException(status_code=416, detail="empty range")
    if size <= 0:
        raise HTTPException(status_code=416, detail="file is empty")
    if raw_start == "":
        suffix = int(raw_end)
        if suffix <= 0:
            raise HTTPException(status_code=416, detail="invalid suffix range")
        start = max(size - suffix, 0)
        end = size - 1
    else:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
        if start >= size or end < start:
            raise HTTPException(
                status_code=416,
                detail="range is not satisfiable",
                headers={"Content-Range": f"bytes */{size}"},
            )
        end = min(end, size - 1)
    return start, end


def _iter_stream(stream: BinaryIO) -> Iterator[bytes]:
    """Yield a binary stream in chunks and always close it."""

    try:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            yield chunk
    finally:
        stream.close()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/api/files", response_model=FileListResponse)
def list_files(
    root: str = Query(default="workspace", max_length=200),
    path: str = Query(default="", max_length=4096),
    hidden: bool = Query(default=False),
    cursor: str | None = Query(default=None, max_length=512),
    limit: int = Query(default=200, ge=1, le=1000),
    service: SafeFileService = Depends(get_file_service),
) -> FileListResponse:
    """List one directory.  ``path=""`` lists the root."""

    listing = _call(
        service.list_dir,
        root,
        path,
        cursor=cursor,
        limit=limit,
        hidden=hidden,
    )
    return _listing_view(listing)


@router.get("/api/files/stat", response_model=FileStatView)
def stat_file(
    root: str = Query(default="workspace", max_length=200),
    path: str = Query(default="", max_length=4096),
    service: SafeFileService = Depends(get_file_service),
) -> FileStatView:
    """Return ``lstat`` metadata; symlinks are described, not followed."""

    return _stat_view(_call(service.stat, root, path))


@router.get("/api/files/content")
def read_content(
    root: str = Query(default="workspace", max_length=200),
    path: str = Query(min_length=1, max_length=4096),
    mode: Literal["text", "bytes"] = Query(default="text"),
    maxLines: int = Query(default=20_000, ge=1, le=200_000),
    range_header: Annotated[str | None, Header(alias="Range")] = None,
    service: SafeFileService = Depends(get_file_service),
) -> Response:
    """Read text (JSON) or raw bytes (``mode=bytes``, optional Range)."""

    if mode == "text":
        if range_header:
            raise HTTPException(
                status_code=400, detail="range is only supported for bytes"
            )
        result = _call(service.read_text, root, path, max_lines=maxLines)
        return JSONResponse(_text_view(result).model_dump())

    if range_header:
        info = _call(service.stat, root, path)
        start, end = _range(range_header, info.size)
        payload = _call(
            service.read_bytes,
            root,
            path,
            offset=start,
            length=end - start + 1,
        )
        headers = _byte_headers(payload, _mime_for(path))
        headers["Content-Range"] = f"bytes {start}-{end}/{info.size}"
        return Response(
            content=payload.data,
            status_code=206,
            media_type="application/octet-stream",
            headers=headers,
        )

    payload = _call(service.read_bytes, root, path)
    return Response(
        content=payload.data,
        status_code=200,
        media_type="application/octet-stream",
        headers=_byte_headers(payload, _mime_for(path)),
    )


def _byte_headers(payload: FileBytes, mime: str) -> dict[str, str]:
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "X-File-Size": str(payload.total_size),
        "X-File-Mtime-Ms": str(payload.mtime_ms),
        "X-File-Mime": mime,
    }
    if payload.sha256 is not None:
        headers["X-File-Sha256"] = payload.sha256
    return headers


@router.put("/api/files/content", response_model=WriteResponse)
def write_content(
    body: WriteContentView,
    service: SafeFileService = Depends(get_file_service),
) -> WriteResponse:
    """Atomically write UTF-8 text; optional compare-and-swap hash."""

    result = _call(
        service.write_atomic,
        body.root,
        body.path,
        body.text.encode("utf-8"),
        expected_sha256=body.expectedSha256,
    )
    return _write_view(result)


@router.post("/api/files/create", response_model=WriteResponse)
def create_file(
    body: CreateRequest,
    service: SafeFileService = Depends(get_file_service),
) -> WriteResponse:
    """Create a file (``O_EXCL`` unless ``overwrite`` is true)."""

    result = _call(
        service.create_file,
        body.root,
        body.path,
        body.text.encode("utf-8"),
        overwrite=body.overwrite,
    )
    return _write_view(result)


@router.post("/api/files/mkdir", response_model=FileStatView)
def make_directory(
    body: MkdirRequest,
    service: SafeFileService = Depends(get_file_service),
) -> FileStatView:
    """Create one directory or, with ``parents``, a parent chain."""

    return _stat_view(
        _call(service.mkdir, body.root, body.path, parents=body.parents)
    )


@router.post("/api/files/rename", response_model=FileStatView)
def rename_entry(
    body: RenameRequest,
    service: SafeFileService = Depends(get_file_service),
) -> FileStatView:
    """Rename or move an entry within the root."""

    return _stat_view(
        _call(
            service.rename,
            body.root,
            body.fromPath,
            body.toPath,
            overwrite=body.overwrite,
        )
    )


@router.post("/api/files/delete", response_model=DeleteResponse)
def delete_entry(
    body: DeleteRequest,
    service: SafeFileService = Depends(get_file_service),
) -> DeleteResponse:
    """Delete a file, symlink, or empty directory."""

    _call(service.delete, body.root, body.path)
    return DeleteResponse(deleted=True)


@router.post("/api/files/copy", response_model=FileStatView)
def copy_entry(
    body: CopyMoveRequest,
    service: SafeFileService = Depends(get_file_service),
) -> FileStatView:
    """Copy a file or directory tree within the root."""

    return _stat_view(
        _call(
            service.copy,
            body.root,
            body.fromPath,
            body.toPath,
            overwrite=body.overwrite,
        )
    )


@router.post("/api/files/move", response_model=FileStatView)
def move_entry(
    body: CopyMoveRequest,
    service: SafeFileService = Depends(get_file_service),
) -> FileStatView:
    """Move an entry within one filesystem root."""

    return _stat_view(
        _call(
            service.move,
            body.root,
            body.fromPath,
            body.toPath,
            overwrite=body.overwrite,
        )
    )


@router.get("/api/files/download")
def download_file(
    root: str = Query(default="workspace", max_length=200),
    path: str = Query(min_length=1, max_length=4096),
    service: SafeFileService = Depends(get_file_service),
) -> StreamingResponse:
    """Stream a file as an attachment without buffering it in memory."""

    try:
        stream, info = service.open_binary(root, path)
    except FileServiceError as exc:
        _fail(exc)
    headers = {
        "Content-Disposition": _disposition(Path(info.path).name, inline=False),
        "Content-Length": str(info.size),
        "Content-Type": _mime_for(info.path),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
    }
    return StreamingResponse(
        _iter_stream(stream),
        media_type=_mime_for(info.path),
        headers=headers,
    )


@router.post("/api/files/upload", response_model=WriteResponse)
async def upload_file(
    request: Request,
    root: str = Query(default="workspace", max_length=200),
    path: str = Query(min_length=1, max_length=4096),
    overwrite: bool = Query(default=False),
    content_length: Annotated[int | None, Header(alias="Content-Length")] = None,
    service: SafeFileService = Depends(get_file_service),
) -> WriteResponse:
    """Store a raw ``application/octet-stream`` request body atomically.

    A raw body is used instead of ``multipart/form-data`` because AutoAgent does
    not depend on ``python-multipart``; declaring ``Form``/``File`` parameters
    makes FastAPI fail at router-registration time.  The body is spooled to a
    temporary file (1 MiB in memory, then disk) so the process never buffers an
    unbounded upload.  ``Content-Length`` is an early hint only; the byte count
    and the service's ``max_write_bytes`` are authoritative.

    Note: ``app.py`` currently rejects any ``/api/*`` body larger than 1 MiB
    before routing.  Exempt this path (see PATCH_PLAN) when larger uploads are
    required.
    """

    cap = service.max_write_bytes
    if content_length is not None and content_length > cap:
        raise HTTPException(status_code=413, detail="upload exceeds the size limit")

    received = 0
    with tempfile.SpooledTemporaryFile(
        max_size=min(cap, 1024 * 1024), mode="w+b"
    ) as spool:
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                received += len(chunk)
                if received > cap:
                    raise HTTPException(
                        status_code=413, detail="upload exceeds the size limit"
                    )
                spool.write(chunk)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail="upload body could not be read"
            ) from exc
        spool.seek(0)
        try:
            result = await run_in_threadpool(
                functools.partial(
                    service.write_stream_atomic,
                    root,
                    path,
                    spool,
                    overwrite=overwrite,
                )
            )
        except FileServiceError as exc:
            _fail(exc)
    return _write_view(result)


@router.get("/api/files/thumbnail")
def thumbnail(
    root: str = Query(default="workspace", max_length=200),
    path: str = Query(min_length=1, max_length=4096),
    service: SafeFileService = Depends(get_file_service),
) -> Response:
    """Return a small raster image inline; SVG is refused (active content)."""

    mime = _mime_for(path)
    if mime not in _THUMBNAIL_TYPES:
        raise HTTPException(status_code=415, detail="unsupported thumbnail type")
    payload = _call(
        service.read_bytes,
        root,
        path,
        max_bytes=service.max_thumbnail_bytes,
    )
    return Response(
        content=payload.data,
        media_type=mime,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=60",
            "Content-Disposition": _disposition(Path(path).name, inline=True),
        },
    )


@router.post("/api/files/reveal", response_model=RevealResponse)
def reveal_file(
    body: RevealRequest,
    request: Request,
    service: SafeFileService = Depends(get_file_service),
) -> RevealResponse:
    """Ask the desktop shell to show a validated path in the OS file manager.

    The absolute path is passed only to the native hook; the HTTP response
    carries the root id and relative path.
    """

    hook = get_reveal_hook(request)
    if hook is None:
        raise HTTPException(status_code=501, detail="desktop reveal is unavailable")
    absolute = _call(service.absolute_path, body.root, body.path)
    try:
        hook(absolute)
    except Exception as exc:
        raise HTTPException(status_code=501, detail="desktop reveal failed") from exc
    return RevealResponse(revealed=True, root=body.root, path=body.path)
