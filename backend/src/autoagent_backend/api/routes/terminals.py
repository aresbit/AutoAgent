"""FastAPI HTTP + WebSocket routes for integrated terminals.

Drop-in location in AutoAgent::

    backend/src/autoagent_backend/api/routes/terminals.py

The manager is imported from ``adapters/terminal/manager.py`` in the real tree;
the fallback import lets this reference directory run/compile standalone.

Authentication
--------------
HTTP requests are already covered by ``api/deps.authorize_request`` middleware
(origin + launch token).  **Starlette middleware does not run for WebSockets**,
so this module performs the same checks before ``accept()``:

* ``Origin``, when present, must equal ``config.origin`` exactly.
* A launch token is required.  Accepted sources, in order: the HttpOnly
  ``autoagent_token`` cookie, ``Authorization: Bearer``, then ``?token=``.

The query-string fallback exists for tests and for clients that have not
exchanged the cookie.  Prefer ``POST /api/auth/session`` so tokens never appear
in uvicorn access logs.

Frames are JSON text.  Output is UTF-8 (incrementally decoded with
``errors="replace"``); base64 is intentionally not used in v1.
"""

from __future__ import annotations

import asyncio
import codecs
import hmac
import json
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Literal

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from pydantic import Field, field_validator

from ...adapters.terminal.manager import (
    KEY_SEPARATOR,
    TerminalClosed,
    TerminalError,
    TerminalManager,
    TerminalSession,
)
from ...composition import Container
from ...domain.errors import DomainError, InvalidInput, NotFound
from ...domain.models import Session
from ..deps import TOKEN_COOKIE, get_container
from ..schemas import ApiModel, DeleteResponse

LOG = logging.getLogger("autoagent.api.terminals")

router = APIRouter()

KEY_SEP = KEY_SEPARATOR
MAX_TERMINALS_PER_SESSION = 4
MAX_INPUT_CHARS = 64 * 1024
MAX_FRAME_CHARS = 128 * 1024
MAX_BAD_FRAMES = 16
MAX_RATE_DENIALS = 5
INIT_TIMEOUT_S = 10.0
HEARTBEAT_TIMEOUT_S = 75.0

_TAB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# WebSocket close codes (application range).
WS_BAD_FRAME = 4400
WS_UNAUTHORIZED = 4401
WS_FORBIDDEN = 4403
WS_NOT_FOUND = 4404
WS_ALREADY_ATTACHED = 4409
WS_RATE_LIMITED = 4429
WS_INTERNAL = 1011


# ---------------------------------------------------------------------------
# Boundary DTOs
# ---------------------------------------------------------------------------


class TerminalCreateRequest(ApiModel):
    """Client input for creating a tab.

    Pre: ``shell`` (when supplied) is an allowlisted absolute path; ``cwd``
         (when supplied) is an existing directory inside an approved root.
    Post: unknown fields are rejected by ``ApiModel``.
    """

    shell: str | None = Field(default=None, max_length=1024)
    cwd: str | None = Field(default=None, max_length=4096)
    cols: int = Field(default=80, ge=1, le=1000)
    rows: int = Field(default=24, ge=1, le=1000)

    @field_validator("shell", "cwd")
    @classmethod
    def _no_control_characters(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("control characters are not allowed")
        return value


class TerminalView(ApiModel):
    tabId: str
    sessionId: str
    shell: str
    cwd: str
    cols: int
    rows: int
    state: Literal["starting", "running", "exited"]
    exitCode: int | None = None
    createdAt: float


class TerminalListView(ApiModel):
    terminals: list[TerminalView]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _api_error(code: str, status: int, message: str) -> DomainError:
    """Build a domain error with a terminal-specific code/status."""

    error: DomainError = InvalidInput(message)
    error.code = code
    error.status_code = status
    return error


def _require_manager(container: Container) -> TerminalManager:
    config = getattr(container, "config", None)
    if config is not None and not getattr(config, "terminals_enabled", True):
        raise _api_error(
            "TERMINAL_DISABLED", 503, "the terminal subsystem is disabled"
        )
    manager = getattr(container, "terminal_manager", None)
    if not isinstance(manager, TerminalManager):
        raise _api_error(
            "TERMINAL_UNAVAILABLE", 503, "the terminal subsystem is unavailable"
        )
    return manager


def _http_error(exc: TerminalError) -> DomainError:
    """Translate a framework-free manager error into the domain error space."""

    base: DomainError = (
        NotFound(exc.message)
        if exc.code.endswith("NOT_FOUND")
        else InvalidInput(exc.message)
    )
    # DomainError reads these as instance attributes in the single mapper.
    base.code = exc.code
    base.status_code = exc.status
    return base


def _tab_id(session_key: str) -> str:
    return session_key.rsplit(KEY_SEP, 1)[-1]


def _view(session: TerminalSession, session_id: str) -> TerminalView:
    return TerminalView(
        tabId=_tab_id(session.key),
        sessionId=session_id,
        shell=session.shell,
        cwd=session.cwd,
        cols=session.cols,
        rows=session.rows,
        state=session.state,
        exitCode=session.exit_code,
        createdAt=session.created_at,
    )


def _default_cwd(container: Container) -> str:
    """Resolve the configured workspace without inventing another setting."""

    try:
        configured = container.settings_service.read().cwd
    except Exception:  # pragma: no cover - DB degraded; use boot default
        configured = None
    return configured or str(container.config.default_cwd)


def _session_exists(container: Container, session_id: str) -> Session:
    """Raises SessionNotFound (mapped to 404) when the conversation is gone."""

    return container.session_service.get(session_id)


class _TokenBucket:
    """Small monotonic token bucket for input-frame rate limiting."""

    __slots__ = ("_capacity", "_rate", "_tokens", "_updated")

    def __init__(self, capacity: int = 120, rate_per_s: float = 240.0) -> None:
        self._capacity = float(capacity)
        self._tokens = self._capacity
        self._rate = rate_per_s
        self._updated = time.monotonic()

    def allow(self, cost: float = 1.0) -> bool:
        now = time.monotonic()
        self._tokens = min(
            self._capacity, self._tokens + (now - self._updated) * self._rate
        )
        self._updated = now
        if self._tokens < cost:
            return False
        self._tokens -= cost
        return True


class _FrameSender:
    """Serialize outgoing frames and assign a per-connection monotonic ``seq``."""

    __slots__ = ("_lock", "_seq", "_ws")

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket
        self._seq = 0
        self._lock = asyncio.Lock()

    async def send(self, frame: dict[str, object]) -> None:
        async with self._lock:
            self._seq += 1
            await self._ws.send_json({**frame, "seq": self._seq})


SendFn = Callable[[dict[str, object]], Awaitable[None]]


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


@router.get(
    "/api/sessions/{session_id}/terminals",
    response_model=TerminalListView,
)
def list_terminals(
    session_id: str,
    container: Container = Depends(get_container),
) -> TerminalListView:
    """List tabs for a conversation, including exited tabs awaiting cleanup."""

    _session_exists(container, session_id)
    manager = _require_manager(container)
    prefix = f"{session_id}{KEY_SEP}"
    return TerminalListView(
        terminals=[
            _view(session, session_id)
            for session in manager.list()
            if session.key.startswith(prefix)
        ]
    )


@router.post(
    "/api/sessions/{session_id}/terminals",
    response_model=TerminalView,
    status_code=201,
)
async def create_terminal(
    session_id: str,
    body: TerminalCreateRequest,
    container: Container = Depends(get_container),
) -> TerminalView:
    """Create and spawn a terminal tab.

    Post: returns the generated ``tabId``; the PTY starts immediately so output
          is retained for the first WebSocket attach.
    """

    _session_exists(container, session_id)
    manager = _require_manager(container)
    prefix = f"{session_id}{KEY_SEP}"
    if manager.count_with_prefix(prefix) >= MAX_TERMINALS_PER_SESSION:
        raise _api_error(
            "TERMINAL_LIMIT_PER_SESSION",
            429,
            "too many terminals for this conversation",
        )

    tab_id = uuid.uuid4().hex
    key = f"{session_id}{KEY_SEP}{tab_id}"
    cwd = body.cwd if body.cwd is not None else _default_cwd(container)

    try:
        session = await manager.spawn(
            key,
            shell=body.shell,
            cwd=cwd,
            cols=body.cols,
            rows=body.rows,
        )
    except TerminalError as exc:
        raise _http_error(exc) from None

    LOG.info("terminal tab created session=%s tab=%s", session_id, tab_id)
    return _view(session, session_id)


@router.delete(
    "/api/sessions/{session_id}/terminals/{tab_id}",
    response_model=DeleteResponse,
)
async def delete_terminal(
    session_id: str,
    tab_id: str,
    container: Container = Depends(get_container),
) -> DeleteResponse:
    """Close the process group and forget the tab."""

    _session_exists(container, session_id)
    manager = _require_manager(container)
    if not _TAB_ID.match(tab_id):
        raise _api_error("INVALID_TAB_ID", 400, "the tab id is invalid")
    deleted = await manager.destroy(
        f"{session_id}{KEY_SEP}{tab_id}"
    )
    if not deleted:
        raise NotFound("terminal not found")
    return DeleteResponse(deleted=True)


# ---------------------------------------------------------------------------
# WebSocket surface
# ---------------------------------------------------------------------------


def _ws_token(websocket: WebSocket) -> str | None:
    """Post: returns the first available launch-token source."""

    header = websocket.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    cookie = websocket.cookies.get(TOKEN_COOKIE)
    if cookie:
        return cookie.strip()
    query = websocket.query_params.get("token")
    return query.strip() if query else None


async def _authorize_ws(websocket: WebSocket, container: Container) -> bool:
    """Origin + launch-token gate for WebSockets.

    Post: returns ``True`` only when the socket may be accepted; otherwise the
          socket is closed with 4403/4401 and the caller returns.
    """

    origin = websocket.headers.get("origin")
    if origin is not None and origin != container.config.origin:
        await websocket.close(code=WS_FORBIDDEN, reason="origin is not allowed")
        return False

    expected = container.config.api_token
    provided = _ws_token(websocket)
    if not expected or provided is None or not hmac.compare_digest(provided, expected):
        await websocket.close(
            code=WS_UNAUTHORIZED, reason="a valid launch token is required"
        )
        return False
    return True


async def _next_text(websocket: WebSocket, timeout_s: float) -> str | None:
    """Receive one frame, returning ``None`` for binary frames.

    Post: returns a text payload; raises ``TimeoutError`` on idle and
          ``WebSocketDisconnect`` when the peer is gone.
    """

    message = await asyncio.wait_for(websocket.receive(), timeout_s)
    if message.get("type") == "websocket.disconnect":
        code = message.get("code", 1000)
        raise WebSocketDisconnect(code if isinstance(code, int) else 1000)
    text = message.get("text")
    return text if isinstance(text, str) else None


async def _receive_init(
    websocket: WebSocket, sender: _FrameSender
) -> tuple[int, int, bool] | None:
    """Read and validate the mandatory first ``init`` frame.

    Post: returns ``(cols, rows, replay)`` or ``None`` after closing the socket.
    """

    try:
        raw = await _next_text(websocket, INIT_TIMEOUT_S)
    except TimeoutError:
        await websocket.close(code=WS_BAD_FRAME, reason="init timeout")
        return None
    except WebSocketDisconnect:
        return None

    if raw is None:
        await sender.send(
            {
                "type": "error",
                "code": "UNSUPPORTED_BINARY",
                "message": "terminal frames must be JSON text",
            }
        )
        await websocket.close(code=WS_BAD_FRAME, reason="binary frame")
        return None

    if len(raw) > MAX_FRAME_CHARS:
        await sender.send(
            {"type": "error", "code": "FRAME_TOO_LARGE", "message": "frame too large"}
        )
        await websocket.close(code=WS_BAD_FRAME, reason="frame too large")
        return None

    try:
        frame = json.loads(raw)
    except json.JSONDecodeError:
        await sender.send(
            {"type": "error", "code": "BAD_JSON", "message": "invalid JSON frame"}
        )
        await websocket.close(code=WS_BAD_FRAME, reason="invalid JSON")
        return None

    if not isinstance(frame, dict) or frame.get("type") != "init":
        await sender.send(
            {
                "type": "error",
                "code": "INIT_REQUIRED",
                "message": "the first frame must be init",
            }
        )
        await websocket.close(code=WS_BAD_FRAME, reason="init required")
        return None

    cols = frame.get("cols", 80)
    rows = frame.get("rows", 24)
    replay = frame.get("replay", True)
    if (
        not isinstance(cols, int)
        or isinstance(cols, bool)
        or not 1 <= cols <= 1000
        or not isinstance(rows, int)
        or isinstance(rows, bool)
        or not 1 <= rows <= 1000
    ):
        await sender.send(
            {
                "type": "error",
                "code": "BAD_SIZE",
                "message": "cols and rows must be integers in 1..1000",
            }
        )
        await websocket.close(code=WS_BAD_FRAME, reason="bad size")
        return None

    return cols, rows, bool(replay)


def _ready_frame(session: TerminalSession, session_id: str) -> dict[str, object]:
    return {
        "type": "ready",
        "tabId": _tab_id(session.key),
        "sessionId": session_id,
        "shell": session.shell,
        "cwd": session.cwd,
        "cols": session.cols,
        "rows": session.rows,
        "state": session.state,
        "exitCode": session.exit_code,
        "replayBytes": len(session.scrollback()),
    }


async def _pump_output(session: TerminalSession, send: SendFn) -> None:
    """Stream PTY output as UTF-8 text, then send exactly one exit frame."""

    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        chunk = await session.read()
        if chunk is None:
            tail = decoder.decode(b"", final=True)
            if tail:
                await send({"type": "data", "data": tail})
            await send(
                {
                    "type": "exit",
                    "code": session.exit_code,
                    "signal": session.exit_signal,
                }
            )
            return
        text = decoder.decode(chunk)
        if text:
            await send({"type": "data", "data": text})


async def _receive_frames(
    websocket: WebSocket,
    session: TerminalSession,
    send: SendFn,
) -> None:
    """Validate and dispatch client frames until close/disconnect."""

    bucket = _TokenBucket()
    bad_frames = 0
    rate_denials = 0

    while True:
        try:
            raw = await _next_text(websocket, HEARTBEAT_TIMEOUT_S)
        except TimeoutError:
            await send(
                {
                    "type": "error",
                    "code": "IDLE_TIMEOUT",
                    "message": "no client frames; detaching",
                }
            )
            return

        if raw is None:
            bad_frames += 1
            await send(
                {
                    "type": "error",
                    "code": "UNSUPPORTED_BINARY",
                    "message": "terminal frames must be JSON text",
                }
            )
            if bad_frames >= MAX_BAD_FRAMES:
                await websocket.close(
                    code=WS_BAD_FRAME, reason="too many bad frames"
                )
                return
            continue

        if len(raw) > MAX_FRAME_CHARS:
            bad_frames += 1
            await send(
                {
                    "type": "error",
                    "code": "FRAME_TOO_LARGE",
                    "message": "frame too large",
                }
            )
            if bad_frames >= MAX_BAD_FRAMES:
                await websocket.close(code=WS_BAD_FRAME, reason="too many bad frames")
                return
            continue

        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            bad_frames += 1
            await send(
                {"type": "error", "code": "BAD_JSON", "message": "invalid JSON frame"}
            )
            if bad_frames >= MAX_BAD_FRAMES:
                await websocket.close(code=WS_BAD_FRAME, reason="too many bad frames")
                return
            continue

        if not isinstance(frame, dict):
            bad_frames += 1
            continue

        frame_type = frame.get("type")

        if frame_type == "input":
            if not bucket.allow():
                rate_denials += 1
                await send(
                    {
                        "type": "error",
                        "code": "RATE_LIMITED",
                        "message": "input rate limit exceeded",
                    }
                )
                if rate_denials >= MAX_RATE_DENIALS:
                    await websocket.close(
                        code=WS_RATE_LIMITED, reason="input rate limit exceeded"
                    )
                    return
                continue
            data = frame.get("data")
            if not isinstance(data, str) or len(data) > MAX_INPUT_CHARS:
                bad_frames += 1
                await send(
                    {
                        "type": "error",
                        "code": "BAD_INPUT",
                        "message": "input must be UTF-8 text <= 64 KiB",
                    }
                )
                if bad_frames >= MAX_BAD_FRAMES:
                    await websocket.close(
                        code=WS_BAD_FRAME, reason="too many bad frames"
                    )
                    return
                continue
            try:
                await session.write(data)
            except TerminalClosed:
                await send(
                    {
                        "type": "error",
                        "code": "TERMINAL_CLOSED",
                        "message": "the terminal has exited",
                    }
                )
                return
            continue

        if frame_type == "resize":
            cols = frame.get("cols")
            rows = frame.get("rows")
            if (
                not isinstance(cols, int)
                or isinstance(cols, bool)
                or not isinstance(rows, int)
                or isinstance(rows, bool)
                or not 1 <= cols <= 1000
                or not 1 <= rows <= 1000
            ):
                bad_frames += 1
                await send(
                    {
                        "type": "error",
                        "code": "BAD_SIZE",
                        "message": "cols and rows must be integers in 1..1000",
                    }
                )
                if bad_frames >= MAX_BAD_FRAMES:
                    await websocket.close(
                        code=WS_BAD_FRAME, reason="too many bad frames"
                    )
                    return
                continue
            await session.resize(cols, rows)
            continue

        if frame_type == "ping":
            await send({"type": "pong", "ts": int(time.time() * 1000)})
            continue

        if frame_type == "close":
            await session.close()
            return

        bad_frames += 1
        await send(
            {
                "type": "error",
                "code": "UNKNOWN_FRAME",
                "message": "unknown frame type",
            }
        )
        if bad_frames >= MAX_BAD_FRAMES:
            await websocket.close(code=WS_BAD_FRAME, reason="too many bad frames")
            return


@router.websocket("/api/sessions/{session_id}/terminals/{tab_id}/ws")
async def terminal_ws(
    websocket: WebSocket, session_id: str, tab_id: str
) -> None:
    """Attach one WebSocket to one terminal tab.

    Client: ``init`` -> ``input``/``resize``/``ping``/``close``
    Server: ``ready`` -> ``data``* -> ``exit`` (or ``error`` at any time)

    The PTY survives a WebSocket disconnect so a remount can replay scrollback;
    ``DELETE`` (or app shutdown) is what terminates the process group.
    """

    container = getattr(websocket.app.state, "container", None)
    if not isinstance(container, Container):
        await websocket.close(code=WS_INTERNAL, reason="backend is not initialized")
        return

    if not await _authorize_ws(websocket, container):
        return

    if not _TAB_ID.match(tab_id):
        await websocket.close(code=WS_BAD_FRAME, reason="invalid tab id")
        return

    try:
        _session_exists(container, session_id)
    except DomainError:
        await websocket.close(code=WS_NOT_FOUND, reason="session not found")
        return

    manager = getattr(container, "terminal_manager", None)
    if not isinstance(manager, TerminalManager):
        await websocket.close(code=WS_INTERNAL, reason="terminal subsystem unavailable")
        return

    session = manager.get(f"{session_id}{KEY_SEP}{tab_id}")
    if session is None:
        await websocket.close(code=WS_NOT_FOUND, reason="terminal not found")
        return
    if not session.try_attach():
        await websocket.close(
            code=WS_ALREADY_ATTACHED, reason="terminal already attached"
        )
        return

    await websocket.accept()
    sender = _FrameSender(websocket)

    try:
        init = await _receive_init(websocket, sender)
        if init is None:
            return
        cols, rows, replay = init
        await session.resize(cols, rows)

        await sender.send(_ready_frame(session, session_id))
        if replay:
            snapshot = session.scrollback()
            if snapshot:
                await sender.send(
                    {
                        "type": "data",
                        "data": snapshot.decode("utf-8", errors="replace"),
                        "replay": True,
                    }
                )

        pump = asyncio.create_task(_pump_output(session, sender.send))
        receiver = asyncio.create_task(
            _receive_frames(websocket, session, sender.send)
        )
        done, _pending = await asyncio.wait(
            {pump, receiver}, return_when=asyncio.FIRST_COMPLETED
        )

        if pump in done:
            receiver.cancel()
        else:
            # The client closed or disconnected; give the pump a moment to
            # flush buffered output and the exit frame before we tear down.
            try:
                await asyncio.wait_for(asyncio.shield(pump), 1.5)
            except (TimeoutError, asyncio.CancelledError):
                pump.cancel()

        for task in (pump, receiver):
            if not task.done():
                task.cancel()
            try:
                await task
            except (asyncio.CancelledError, WebSocketDisconnect):
                pass
            except Exception:  # pragma: no cover - socket already gone
                LOG.debug("terminal ws task ended with an error", exc_info=True)
    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - defensive
        LOG.exception("terminal websocket failed session=%s tab=%s", session_id, tab_id)
        try:
            await sender.send(
                {
                    "type": "error",
                    "code": "TERMINAL_INTERNAL",
                    "message": "terminal connection failed",
                }
            )
        except Exception:
            pass
    finally:
        session.detach()
        try:
            await websocket.close()
        except Exception:  # pragma: no cover - already closed
            pass
