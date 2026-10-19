"""MCP transports implemented with the Python standard library only.

The module deliberately has no dependency on FastAPI, Pydantic or AutoAgent's
domain package.  It is a reference implementation that can be copied into
``autoagent_backend.adapters.mcp`` with only import-path changes.

Three transports are provided:

``StdioTransport``
    Newline-delimited JSON-RPC over a child process' stdin/stdout.  The child
    is started in its own process group and killed as a group on close.

``StreamableHttpTransport``
    The MCP 2025-03-26 Streamable HTTP transport: one POST per JSON-RPC
    message, ``Mcp-Session-Id`` and ``MCP-Protocol-Version`` headers, and
    either a JSON body or an SSE response body.  An optional GET SSE stream
    carries server notifications (including ``tools/list_changed``).

``LegacySseTransport``
    The 2024-11-05 HTTP+SSE transport: a long-lived GET stream announces an
    endpoint via an ``endpoint`` event; JSON-RPC messages are POSTed there and
    responses arrive on the GET stream.

All transports support request-id matching, per-request timeouts, cooperative
cancellation, notification dispatch and deterministic close semantics.  None
of them uses ``shell=True`` or interpolates user input into a command string.
"""

from __future__ import annotations

import codecs
import http.client
import json
import os
import queue
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import NoReturn, Protocol

JsonObject = dict[str, object]
JsonRpcId = int | str
NotificationHandler = Callable[[str, JsonObject], None]
LogHandler = Callable[[str, str], None]

_MAX_ERROR_CHARS = 300
_SAFE_ENV_KEYS: frozenset[str] = frozenset(
    {
        "APPDATA",
        "COLORTERM",
        "COMSPEC",
        "HOME",
        "LANG",
        "LOGNAME",
        "PATH",
        "PATHEXT",
        "SHELL",
        "SYSTEMROOT",
        "TEMP",
        "TERM",
        "TMP",
        "TMPDIR",
        "USER",
        "USERPROFILE",
        "WINDIR",
    }
)
_SAFE_ENV_PREFIXES = ("LC_",)


class McpTransportError(Exception):
    """Base class for transport failures.

    Pre: ``message`` is already sanitized (no argv, env values or headers).
    Post: ``retryable`` states whether a fresh connection may succeed.
    """

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable


class McpClosed(McpTransportError):
    """The peer closed the connection or the transport was closed locally."""

    def __init__(self, message: str = "MCP connection is closed") -> None:
        super().__init__(message, retryable=True)


class McpTimeout(McpTransportError):
    """A request did not complete before its deadline."""

    def __init__(self, message: str = "MCP request timed out") -> None:
        super().__init__(message, retryable=False)


class McpCancelled(McpTransportError):
    """The caller's cancel event fired before the response arrived."""

    def __init__(self, message: str = "MCP request was cancelled") -> None:
        super().__init__(message, retryable=False)


class McpProtocolError(McpTransportError):
    """A malformed frame or an interrupted stream."""

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=True)


class McpRpcError(McpTransportError):
    """A well-formed JSON-RPC error returned by the server.

    This is *not* a connection failure: the server processed the request and
    rejected it.  ``error_code`` is the JSON-RPC error code when present.
    """

    def __init__(self, message: str, *, error_code: int | None = None) -> None:
        super().__init__(message, retryable=False)
        self.error_code = error_code


class McpHttpError(McpTransportError):
    """An HTTP status outside 2xx.

    ``session_expired`` is set for 404 responses that carry a session id, which
    is how Streamable HTTP servers signal that the session must be
    re-initialized.
    """

    def __init__(
        self,
        status: int,
        message: str,
        *,
        session_expired: bool = False,
    ) -> None:
        super().__init__(message, retryable=status >= 500 or session_expired)
        self.status = status
        self.session_expired = session_expired


class McpCapabilityUnavailable(McpTransportError):
    """The server did not advertise the capability this call needs."""


def sanitize_message(value: object, fallback: str = "MCP request failed") -> str:
    """Collapse whitespace and cap the length of a wire-provided message."""

    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text[:_MAX_ERROR_CHARS] or fallback


def build_child_environment(
    overrides: Mapping[str, str],
    *,
    base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build the child environment from a small allowlist plus explicit values.

    Pre: ``overrides`` keys are non-empty and contain neither ``=`` nor NUL.
    Post: inherited loader hooks (``LD_PRELOAD``, ``PYTHONPATH``,
          ``NODE_OPTIONS``, ``BASH_ENV`` and similar) are absent unless the
          caller explicitly listed them in ``overrides``.
    Raises: ``McpTransportError`` for an invalid key or value.
    """

    source = os.environ if base is None else base
    environment = {
        key: value
        for key, value in source.items()
        if key in _SAFE_ENV_KEYS or key.startswith(_SAFE_ENV_PREFIXES)
    }
    for key, value in overrides.items():
        if not key or "=" in key or "\x00" in key:
            raise McpTransportError("MCP environment contains an invalid variable name")
        if "\x00" in value:
            raise McpTransportError("MCP environment contains an invalid variable value")
        environment[str(key)] = str(value)
    return environment


@dataclass(frozen=True, slots=True)
class SseEvent:
    """One dispatched Server-Sent Event."""

    event: str
    data: str
    id: str | None = None
    retry_ms: int | None = None


class SseParser:
    """Incremental ``text/event-stream`` parser.

    Feed arbitrary chunks; complete events are returned as soon as a blank line
    terminates them.  Handles CRLF, LF and CR line endings, multi-line ``data:``
    fields, comments and the ``event``/``id``/``retry`` fields.
    """

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, chunk: str) -> list[SseEvent]:
        """Post: returns every event completed by ``chunk`` in order."""

        if not chunk:
            return []
        normalized = chunk.replace("\r\n", "\n").replace("\r", "\n")
        self._buffer += normalized
        events: list[SseEvent] = []
        while True:
            boundary = self._buffer.find("\n\n")
            if boundary < 0:
                break
            block = self._buffer[:boundary]
            self._buffer = self._buffer[boundary + 2 :]
            event = self._parse_block(block)
            if event is not None:
                events.append(event)
        return events

    def flush(self) -> list[SseEvent]:
        """Return a final event when the stream ended without a blank line."""

        block = self._buffer
        self._buffer = ""
        if not block.strip():
            return []
        event = self._parse_block(block)
        return [] if event is None else [event]

    @staticmethod
    def _parse_block(block: str) -> SseEvent | None:
        event_name = "message"
        data: list[str] = []
        event_id: str | None = None
        retry_ms: int | None = None
        for line in block.split("\n"):
            if not line or line.startswith(":"):
                continue
            colon = line.find(":")
            field = line if colon < 0 else line[:colon]
            value = "" if colon < 0 else line[colon + 1 :]
            if value.startswith(" "):
                value = value[1:]
            if field == "event":
                event_name = value or "message"
            elif field == "data":
                data.append(value)
            elif field == "id":
                event_id = value
            elif field == "retry":
                try:
                    retry_ms = int(value)
                except ValueError:
                    retry_ms = None
        if not data:
            return None
        return SseEvent(
            event=event_name,
            data="\n".join(data),
            id=event_id,
            retry_ms=retry_ms,
        )


class Transport(Protocol):
    """Common contract consumed by the connection manager.

    Pre: ``start`` is idempotent; ``request`` is safe for concurrent callers
         after ``start`` returned.
    Post: ``close`` releases the process/streams, fails in-flight requests with
          ``McpClosed`` and is idempotent.  No callback is invoked after close.
    """

    @property
    def session_id(self) -> str | None: ...

    @property
    def pid(self) -> int | None: ...

    def set_notification_handler(self, handler: NotificationHandler | None) -> None: ...

    def set_log_handler(self, handler: LogHandler | None) -> None: ...

    def start(self) -> None: ...

    def start_notification_stream(self) -> None: ...

    def request(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        *,
        timeout: float,
        cancel_event: threading.Event | None = None,
    ) -> object: ...

    def notify(self, method: str, params: Mapping[str, object] | None = None) -> None: ...

    def close(self) -> None: ...


class _BaseTransport:
    """Request-id registry, dispatch and cancellation shared by transports."""

    def __init__(self) -> None:
        self._pending: dict[JsonRpcId, queue.Queue[JsonObject | BaseException]] = {}
        self._pending_lock = threading.Lock()
        self._id_lock = threading.Lock()
        self._next_id = 1
        self._closed = threading.Event()
        self._failure: BaseException | None = None
        self._notification_handler: NotificationHandler | None = None
        self._log_handler: LogHandler | None = None
        self._handler_lock = threading.Lock()

    # -- callbacks ---------------------------------------------------------

    def set_notification_handler(self, handler: NotificationHandler | None) -> None:
        with self._handler_lock:
            self._notification_handler = handler

    def set_log_handler(self, handler: LogHandler | None) -> None:
        with self._handler_lock:
            self._log_handler = handler

    def _log(self, level: str, message: str) -> None:
        with self._handler_lock:
            handler = self._log_handler
        if handler is not None:
            try:
                handler(level, sanitize_message(message))
            except Exception:
                # Logging must never take a transport down.
                pass

    def _notification(self, method: str, params: JsonObject) -> None:
        with self._handler_lock:
            handler = self._notification_handler
        if handler is not None:
            try:
                handler(method, params)
            except Exception as exc:
                self._log("error", f"notification handler failed: {exc}")

    # -- JSON-RPC core -----------------------------------------------------

    def _new_id(self) -> int:
        with self._id_lock:
            value = self._next_id
            self._next_id += 1
            return value

    def _register(self, request_id: JsonRpcId) -> queue.Queue[JsonObject | BaseException]:
        pending: queue.Queue[JsonObject | BaseException] = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = pending
            failure = self._failure
        if failure is not None:
            # The reader may have observed EOF before this request was
            # registered; deliver the stored failure instead of waiting.
            try:
                pending.put_nowait(failure)
            except queue.Full:
                pass
        return pending

    def _unregister(self, request_id: JsonRpcId) -> None:
        with self._pending_lock:
            self._pending.pop(request_id, None)

    def _fail_pending(self, error: BaseException) -> None:
        with self._pending_lock:
            self._failure = error
            pending = tuple(self._pending.values())
        for entry in pending:
            try:
                entry.put_nowait(error)
            except queue.Full:
                pass

    def _dispatch(self, message: JsonObject) -> None:
        """Route a decoded JSON-RPC object.

        Responses go to the queue registered for their id; notifications go to
        the handler; server-initiated requests are refused with -32601 rather
        than being silently dropped.
        """

        method = message.get("method")
        if isinstance(method, str):
            raw_params = message.get("params")
            params = _as_object(raw_params) or {}
            if "id" in message:
                self._log("warning", f"unsupported server request: {method}")
                self._send_server_error(message.get("id"), method)
            else:
                self._notification(method, params)
            return
        request_id = message.get("id")
        if not isinstance(request_id, (int, str)) or isinstance(request_id, bool):
            return
        with self._pending_lock:
            pending = self._pending.get(request_id)
        if pending is not None:
            try:
                pending.put_nowait(message)
            except queue.Full:
                pass

    def _send_server_error(self, request_id: object, method: str) -> None:
        if not isinstance(request_id, (int, str)) or isinstance(request_id, bool):
            return
        try:
            self._send_message(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Method not supported by client: {method}",
                    },
                }
            )
        except McpTransportError:
            pass

    def _request(
        self,
        method: str,
        params: Mapping[str, object] | None,
        *,
        timeout: float,
        cancel_event: threading.Event | None,
    ) -> object:
        if self._closed.is_set():
            raise McpClosed()
        if cancel_event is not None and cancel_event.is_set():
            raise McpCancelled()
        request_id = self._new_id()
        payload: JsonObject = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params or {}),
        }
        pending = self._register(request_id)
        try:
            self._send_message(payload)
            return self._await_response(request_id, pending, timeout, cancel_event)
        finally:
            self._unregister(request_id)

    def _await_response(
        self,
        request_id: JsonRpcId,
        pending: queue.Queue[JsonObject | BaseException],
        timeout: float,
        cancel_event: threading.Event | None,
    ) -> object:
        deadline = time.monotonic() + max(timeout, 0.0)
        while True:
            if cancel_event is not None and cancel_event.is_set():
                self._cancel(request_id, "cancelled by caller")
                raise McpCancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._cancel(request_id, "request timed out")
                raise McpTimeout()
            try:
                item = pending.get(timeout=min(0.05, remaining))
            except queue.Empty:
                continue
            if isinstance(item, BaseException):
                raise item
            error = item.get("error")
            if isinstance(error, Mapping):
                code = error.get("code")
                code_value = code if isinstance(code, int) else None
                raise McpRpcError(
                    sanitize_message(error.get("message"), "MCP request failed"),
                    error_code=code_value,
                )
            return item.get("result")

    def _cancel(self, request_id: JsonRpcId, reason: str) -> None:
        """Best-effort ``notifications/cancelled`` (never masks the original error)."""

        try:
            self._send_message(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/cancelled",
                    "params": {"requestId": request_id, "reason": reason},
                }
            )
        except McpTransportError:
            pass

    def _notify_message(self, method: str, params: Mapping[str, object] | None) -> None:
        if self._closed.is_set():
            raise McpClosed()
        self._send_message(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": dict(params or {}),
            }
        )

    # -- abstract ----------------------------------------------------------

    def _send_message(self, payload: JsonObject) -> None:
        raise NotImplementedError


class StdioTransport(_BaseTransport):
    """JSON-RPC over newline-delimited JSON on a child process' stdio.

    Pre: ``command`` is a non-empty executable name or path.  ``args`` are
         passed as an argv vector; no shell is involved.
    Post: ``close`` terminates the whole process group (SIGTERM, then SIGKILL)
          so helper processes spawned by the server do not leak.
    """

    def __init__(
        self,
        command: str,
        args: Sequence[str] = (),
        *,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        base_env: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__()
        if not command.strip():
            raise McpTransportError("stdio MCP server has no command")
        self._command = command
        self._args = tuple(str(item) for item in args)
        self._env = dict(env or {})
        self._cwd = cwd
        self._base_env = base_env
        self._process: subprocess.Popen[bytes] | None = None
        self._start_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._pid: int | None = None

    @property
    def session_id(self) -> str | None:
        return None

    @property
    def pid(self) -> int | None:
        return self._pid

    def start(self) -> None:
        """Spawn the child exactly once; concurrent callers wait for it."""

        if self._closed.is_set():
            raise McpClosed()
        with self._start_lock:
            if self._process is not None:
                return
            environment = build_child_environment(self._env, base=self._base_env)
            creationflags = (
                int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)) if os.name == "nt" else 0
            )
            try:
                process = subprocess.Popen(
                    [self._command, *self._args],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=self._cwd,
                    env=environment,
                    bufsize=0,
                    close_fds=True,
                    start_new_session=os.name == "posix",
                    creationflags=creationflags,
                )
            except OSError as exc:
                raise McpTransportError(
                    "could not start the MCP stdio server", retryable=True
                ) from exc
            self._process = process
            self._pid = process.pid
            self._stdout_thread = threading.Thread(
                target=self._read_stdout, name="mcp-stdio-stdout", daemon=True
            )
            self._stderr_thread = threading.Thread(
                target=self._read_stderr, name="mcp-stdio-stderr", daemon=True
            )
            self._stdout_thread.start()
            self._stderr_thread.start()
            self._log("debug", f"MCP stdio server started (pid {process.pid})")

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            self._fail_pending(McpClosed("MCP stdio server has no stdout"))
            return
        try:
            while not self._closed.is_set():
                raw = process.stdout.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    decoded = json.loads(line)
                except json.JSONDecodeError:
                    self._log("warning", "MCP stdio server wrote a non-JSON line")
                    continue
                if isinstance(decoded, dict):
                    self._dispatch(_as_object(decoded) or {})
        except (OSError, ValueError) as exc:
            self._log("error", f"MCP stdio read failed: {exc}")
        finally:
            self._fail_pending(McpClosed("MCP stdio server exited"))
            if not self._closed.is_set():
                self._log("warning", "MCP stdio server exited")

    def _read_stderr(self) -> None:
        process = self._process
        if process is None or process.stderr is None:
            return
        try:
            while not self._closed.is_set():
                raw = process.stderr.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line:
                    self._log("stderr", line)
        except (OSError, ValueError):
            pass

    def _send_message(self, payload: JsonObject) -> None:
        self.start()
        process = self._process
        if process is None or process.stdin is None:
            raise McpClosed("MCP stdio server is not running")
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        with self._write_lock:
            try:
                process.stdin.write(encoded.encode("utf-8") + b"\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError) as exc:
                self._fail_pending(McpClosed("MCP stdio server closed the connection"))
                raise McpClosed("MCP stdio server closed the connection") from exc

    def request(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        *,
        timeout: float,
        cancel_event: threading.Event | None = None,
    ) -> object:
        self.start()
        return self._request(method, params, timeout=timeout, cancel_event=cancel_event)

    def notify(self, method: str, params: Mapping[str, object] | None = None) -> None:
        self.start()
        self._notify_message(method, params)

    def start_notification_stream(self) -> None:
        """No-op: stdio notifications arrive on the same stdout stream."""

    def close(self) -> None:
        """Close stdin, then terminate the process group with escalation."""

        if self._closed.is_set():
            return
        self._closed.set()
        self._fail_pending(McpClosed())
        process = self._process
        if process is None:
            return
        if process.stdin is not None:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            self._signal_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                self._signal_group(process, signal.SIGKILL)
                try:
                    process.wait(timeout=2.0)
                except subprocess.TimeoutExpired:  # pragma: no cover - defensive
                    pass
        for thread in (self._stdout_thread, self._stderr_thread):
            if thread is not None:
                thread.join(timeout=1.0)
        self._process = None
        self._pid = None

    @staticmethod
    def _signal_group(process: subprocess.Popen[bytes], sig: signal.Signals) -> None:
        if os.name == "posix":
            try:
                os.killpg(os.getpgid(process.pid), sig)
                return
            except (ProcessLookupError, PermissionError, OSError):
                pass
        try:
            process.send_signal(sig)
        except (ProcessLookupError, OSError):
            pass


class StreamableHttpTransport(_BaseTransport):
    """MCP Streamable HTTP client.

    Every JSON-RPC message is a POST.  The server may answer with
    ``application/json`` or ``text/event-stream``; notifications may also
    arrive on an optional GET SSE stream.  Sessions are carried in
    ``Mcp-Session-Id`` and the negotiated version in ``MCP-Protocol-Version``.

    Pre: ``url`` is an absolute ``http`` or ``https`` URL.
    Post: ``close`` unblocks the notification reader and fails in-flight calls.
    """

    def __init__(
        self,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        notification_stream: bool = True,
        open_timeout: float = 10.0,
    ) -> None:
        super().__init__()
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise McpTransportError("MCP HTTP server requires an http(s) URL")
        self._url = url
        self._headers = _validate_headers(headers)
        self._notification_stream_enabled = notification_stream
        self._open_timeout = open_timeout
        self._session_id: str | None = None
        self._protocol_version: str | None = None
        self._state_lock = threading.Lock()
        self._stream_thread: threading.Thread | None = None
        self._stream_response: http.client.HTTPResponse | None = None

    @property
    def session_id(self) -> str | None:
        with self._state_lock:
            return self._session_id

    @property
    def pid(self) -> int | None:
        return None

    def set_protocol_version(self, version: str) -> None:
        with self._state_lock:
            self._protocol_version = version

    def _request_headers(self, accept: str) -> dict[str, str]:
        headers = {
            "Accept": accept,
            "Content-Type": "application/json",
            **self._headers,
        }
        with self._state_lock:
            if self._session_id:
                headers["Mcp-Session-Id"] = self._session_id
            if self._protocol_version:
                headers["MCP-Protocol-Version"] = self._protocol_version
        return headers

    def start(self) -> None:
        if self._closed.is_set():
            raise McpClosed()

    def start_notification_stream(self) -> None:
        """Open the optional GET SSE stream once a session exists."""

        if (
            not self._notification_stream_enabled
            or self._closed.is_set()
            or (self._stream_thread is not None and self._stream_thread.is_alive())
        ):
            return
        self._stream_thread = threading.Thread(
            target=self._notification_reader,
            name="mcp-http-notifications",
            daemon=True,
        )
        self._stream_thread.start()

    def _notification_reader(self) -> None:
        delay = 0.5
        while not self._closed.is_set():
            request = urllib.request.Request(
                self._url,
                headers=self._request_headers("text/event-stream"),
                method="GET",
            )
            try:
                response = urllib.request.urlopen(request, timeout=self._open_timeout)
            except urllib.error.HTTPError as exc:
                # 405/404 means the server does not offer a standalone stream;
                # notifications still arrive on POST responses.
                if exc.code in {404, 405, 501}:
                    self._log("debug", "MCP HTTP notification stream is unavailable")
                    return
                self._log("warning", f"MCP notification stream failed ({exc.code})")
                self._wait_or_closed(delay)
                delay = min(delay * 2.0, 30.0)
                continue
            except (urllib.error.URLError, OSError, TimeoutError):
                if self._closed.is_set():
                    return
                self._wait_or_closed(delay)
                delay = min(delay * 2.0, 30.0)
                continue
            with self._state_lock:
                self._stream_response = response
            try:
                self._read_event_stream(response)
            except (McpTransportError, OSError, ValueError) as exc:
                if not self._closed.is_set():
                    self._log("debug", f"MCP notification stream ended: {exc}")
            finally:
                with self._state_lock:
                    self._stream_response = None
                try:
                    response.close()
                except OSError:
                    pass
            if self._closed.is_set():
                return
            self._wait_or_closed(delay)

    def _wait_or_closed(self, seconds: float) -> None:
        self._closed.wait(seconds)

    def _read_event_stream(self, response: http.client.HTTPResponse) -> dict[str, object] | None:
        """Consume an SSE body, dispatching every JSON-RPC frame.

        Returns the first decoded JSON object when ``dispatch`` is false; the
        method is also used by ``request`` which selects the response by id.
        """

        parser = SseParser()
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        reader = getattr(response, "readline", None)
        if reader is None:
            raise McpProtocolError("MCP SSE response has no body")
        while True:
            line = reader()
            if not line:
                break
            text = decoder.decode(line if isinstance(line, bytes) else bytes(line))
            for event in parser.feed(text):
                decoded = self._decode_event(event)
                if decoded is not None:
                    self._dispatch(decoded)
        for event in parser.flush():
            decoded = self._decode_event(event)
            if decoded is not None:
                self._dispatch(decoded)
        return None

    def _read_sse_response(
        self, response: http.client.HTTPResponse, request_id: JsonRpcId
    ) -> object:
        parser = SseParser()
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        reader = getattr(response, "readline", None)
        if reader is None:
            raise McpProtocolError("MCP SSE response has no body")
        while True:
            line = reader()
            if not line:
                break
            text = decoder.decode(line if isinstance(line, bytes) else bytes(line))
            for event in parser.feed(text):
                decoded = self._decode_event(event)
                if decoded is None:
                    continue
                if decoded.get("id") == request_id and "method" not in decoded:
                    return self._result_from_response(decoded)
                self._dispatch(decoded)
        for event in parser.flush():
            decoded = self._decode_event(event)
            if decoded is None:
                continue
            if decoded.get("id") == request_id and "method" not in decoded:
                return self._result_from_response(decoded)
            self._dispatch(decoded)
        raise McpProtocolError("MCP SSE stream ended before the response arrived")

    @staticmethod
    def _decode_event(event: SseEvent) -> JsonObject | None:
        try:
            decoded = json.loads(event.data)
        except json.JSONDecodeError:
            return None
        return _as_object(decoded)

    @staticmethod
    def _result_from_response(message: JsonObject) -> object:
        error = message.get("error")
        if isinstance(error, Mapping):
            code = error.get("code")
            raise McpRpcError(
                sanitize_message(error.get("message"), "MCP request failed"),
                error_code=code if isinstance(code, int) else None,
            )
        return message.get("result")

    def _open_post(self, payload: JsonObject, timeout: float) -> http.client.HTTPResponse:
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        request = urllib.request.Request(
            self._url,
            data=data,
            headers=self._request_headers("application/json, text/event-stream"),
            method="POST",
        )
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            self._raise_http_error(exc)
        except TimeoutError as exc:
            raise McpTimeout("MCP HTTP request timed out") from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, TimeoutError):
                raise McpTimeout("MCP HTTP request timed out") from exc
            raise McpTransportError("MCP HTTP request failed", retryable=True) from exc
        except OSError as exc:
            raise McpTransportError("MCP HTTP request failed", retryable=True) from exc
        if not isinstance(response, http.client.HTTPResponse):
            raise McpProtocolError("MCP HTTP response was not an HTTP response")
        return response

    def _raise_http_error(self, exc: urllib.error.HTTPError) -> NoReturn:
        try:
            body = exc.read()
        except OSError:
            body = b""
        message = f"MCP HTTP request failed ({exc.code})"
        if body:
            try:
                decoded = json.loads(body.decode("utf-8", errors="replace"))
                if isinstance(decoded, Mapping):
                    error = decoded.get("error")
                    if isinstance(error, Mapping):
                        message = sanitize_message(error.get("message"), message)
                    elif isinstance(decoded.get("message"), str):
                        message = sanitize_message(decoded.get("message"), message)
            except (json.JSONDecodeError, UnicodeDecodeError):
                pass
        with self._state_lock:
            expired = exc.code == 404 and self._session_id is not None
            if expired:
                self._session_id = None
        raise McpHttpError(exc.code, message, session_expired=expired) from exc

    def request(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        *,
        timeout: float,
        cancel_event: threading.Event | None = None,
    ) -> object:
        if self._closed.is_set():
            raise McpClosed()
        if cancel_event is not None and cancel_event.is_set():
            raise McpCancelled()
        request_id = self._new_id()
        payload: JsonObject = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params or {}),
        }
        response = self._open_post(payload, timeout)
        with response:
            content_type = response.headers.get("Content-Type", "")
            self._capture_session(response.headers)
            if "text/event-stream" in content_type.lower():
                return self._read_sse_response(response, request_id)
            body = response.read()
        if not body:
            raise McpProtocolError("MCP HTTP response had no body")
        try:
            decoded = json.loads(body.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise McpProtocolError("MCP HTTP response was not JSON") from exc
        message = _as_object(decoded)
        if message is None:
            raise McpProtocolError("MCP HTTP response was malformed")
        return self._result_from_response(message)

    def _capture_session(self, headers: http.client.HTTPMessage) -> None:
        session = headers.get("Mcp-Session-Id")
        if session:
            with self._state_lock:
                self._session_id = session

    def _send_message(self, payload: JsonObject) -> None:
        """Send a client-to-server response (e.g. rejecting a server request)."""

        response = self._open_post(payload, self._open_timeout)
        with response:
            self._capture_session(response.headers)
            response.read()

    def notify(self, method: str, params: Mapping[str, object] | None = None) -> None:
        if self._closed.is_set():
            raise McpClosed()
        payload: JsonObject = {
            "jsonrpc": "2.0",
            "method": method,
            "params": dict(params or {}),
        }
        response = self._open_post(payload, self._open_timeout)
        with response:
            self._capture_session(response.headers)
            if response.status < 200 or response.status >= 300:
                raise McpHttpError(response.status, "MCP notification was rejected")
            response.read()

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        self._fail_pending(McpClosed())
        with self._state_lock:
            response = self._stream_response
        if response is not None:
            try:
                response.close()
            except (OSError, ValueError):
                pass
        if self._stream_thread is not None:
            self._stream_thread.join(timeout=1.0)
        with self._state_lock:
            self._stream_response = None
            self._session_id = None


class LegacySseTransport(_BaseTransport):
    """MCP 2024-11-05 HTTP+SSE transport.

    A GET stream emits an ``endpoint`` event naming the POST URL; responses
    and notifications arrive as ``message`` events on the same stream.

    Pre: ``url`` is the SSE endpoint URL.
    Post: requests fail with ``McpClosed`` if the stream drops; the manager
          reconnects by constructing a new transport.
    """

    def __init__(
        self,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        open_timeout: float = 10.0,
    ) -> None:
        super().__init__()
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise McpTransportError("MCP SSE server requires an http(s) URL")
        self._url = url
        self._headers = _validate_headers(headers)
        self._open_timeout = open_timeout
        self._endpoint: str | None = None
        self._ready = threading.Event()
        self._reader: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._active_response: http.client.HTTPResponse | None = None

    @property
    def session_id(self) -> str | None:
        endpoint = self._endpoint
        if not endpoint:
            return None
        query = urllib.parse.urlsplit(endpoint).query
        values = urllib.parse.parse_qs(query)
        for key in ("sessionId", "session_id", "session"):
            if values.get(key):
                return values[key][0]
        return None

    @property
    def pid(self) -> int | None:
        return None

    def start(self) -> None:
        if self._closed.is_set():
            raise McpClosed()
        with self._start_lock:
            if self._reader is not None:
                return
            self._reader = threading.Thread(
                target=self._stream_reader, name="mcp-legacy-sse", daemon=True
            )
            self._reader.start()
        if not self._ready.wait(self._open_timeout):
            raise McpTimeout("MCP SSE endpoint was not announced")
        if self._closed.is_set() or self._endpoint is None:
            raise McpClosed("MCP SSE stream closed before the endpoint arrived")

    def start_notification_stream(self) -> None:
        """No-op: the legacy GET stream already carries notifications."""

    def _stream_reader(self) -> None:
        request = urllib.request.Request(
            self._url,
            headers={
                "Accept": "text/event-stream",
                "Cache-Control": "no-cache",
                **self._headers,
            },
            method="GET",
        )
        try:
            response = urllib.request.urlopen(request, timeout=self._open_timeout)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            self._log("error", f"MCP SSE connection failed: {exc}")
            self._ready.set()
            self._fail_pending(McpClosed("MCP SSE connection failed"))
            return
        self._active_response = response
        parser = SseParser()
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            with response:
                while not self._closed.is_set():
                    line = response.readline()
                    if not line:
                        break
                    text = decoder.decode(line if isinstance(line, bytes) else bytes(line))
                    for event in parser.feed(text):
                        self._handle_event(event)
                for event in parser.flush():
                    self._handle_event(event)
        except (OSError, ValueError) as exc:
            if not self._closed.is_set():
                self._log("warning", f"MCP SSE stream ended: {exc}")
        finally:
            self._active_response = None
            if not self._closed.is_set():
                self._ready.set()
                self._fail_pending(McpClosed("MCP SSE stream ended"))

    def _handle_event(self, event: SseEvent) -> None:
        if event.event == "endpoint":
            endpoint = urllib.parse.urljoin(self._url, event.data.strip())
            self._endpoint = endpoint
            self._ready.set()
            return
        if event.event not in {"message", ""}:
            self._log("debug", f"MCP SSE event ignored: {event.event}")
            return
        try:
            decoded = json.loads(event.data)
        except json.JSONDecodeError:
            self._log("warning", "MCP SSE stream carried a non-JSON message")
            return
        message = _as_object(decoded)
        if message is not None:
            self._dispatch(message)

    def _post(self, payload: JsonObject, timeout: float) -> None:
        self.start()
        endpoint = self._endpoint
        if endpoint is None:
            raise McpClosed("MCP SSE endpoint is not available")
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        request = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                **self._headers,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            raise McpHttpError(exc.code, f"MCP SSE POST failed ({exc.code})") from exc
        except TimeoutError as exc:
            raise McpTimeout("MCP SSE POST timed out") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise McpTransportError("MCP SSE POST failed", retryable=True) from exc

    def _send_message(self, payload: JsonObject) -> None:
        """Send a client-to-server response over the announced POST endpoint."""

        self._post(payload, self._open_timeout)

    def request(
        self,
        method: str,
        params: Mapping[str, object] | None = None,
        *,
        timeout: float,
        cancel_event: threading.Event | None = None,
    ) -> object:
        if self._closed.is_set():
            raise McpClosed()
        if cancel_event is not None and cancel_event.is_set():
            raise McpCancelled()
        request_id = self._new_id()
        pending = self._register(request_id)
        try:
            self._post(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": dict(params or {}),
                },
                timeout,
            )
            return self._await_response(request_id, pending, timeout, cancel_event)
        finally:
            self._unregister(request_id)

    def notify(self, method: str, params: Mapping[str, object] | None = None) -> None:
        if self._closed.is_set():
            raise McpClosed()
        self._post(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": dict(params or {}),
            },
            self._open_timeout,
        )

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        self._fail_pending(McpClosed())
        self._ready.set()
        response = self._active_response
        if response is not None:
            try:
                response.close()
            except (OSError, ValueError):
                pass
        if self._reader is not None:
            self._reader.join(timeout=1.0)
        self._active_response = None
        self._endpoint = None


def _validate_headers(headers: Mapping[str, str] | None) -> dict[str, str]:
    """Copy user headers, rejecting CR/LF injection and reserved framing keys."""

    result: dict[str, str] = {}
    reserved = {"accept", "content-type", "mcp-session-id", "mcp-protocol-version"}
    for key, value in (headers or {}).items():
        name = str(key).strip()
        text = str(value)
        if not name or "\r" in text or "\n" in text:
            raise McpTransportError("MCP headers contain an invalid value")
        if name.lower() in reserved:
            raise McpTransportError(f"MCP header is managed by the transport: {name}")
        result[name] = text
    return result


def _as_object(value: object) -> JsonObject | None:
    """Return a string-keyed copy of a JSON object, or ``None``."""

    if not isinstance(value, dict):
        return None
    return {str(key): item for key, item in value.items()}


__all__ = [
    "JsonObject",
    "JsonRpcId",
    "LegacySseTransport",
    "LogHandler",
    "McpCancelled",
    "McpCapabilityUnavailable",
    "McpClosed",
    "McpHttpError",
    "McpProtocolError",
    "McpRpcError",
    "McpTimeout",
    "McpTransportError",
    "NotificationHandler",
    "SseEvent",
    "SseParser",
    "StdioTransport",
    "StreamableHttpTransport",
    "Transport",
    "build_child_environment",
    "sanitize_message",
]
