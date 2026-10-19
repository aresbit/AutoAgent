"""Persistent, framework-free MCP connection manager.

One :class:`McpConnectionManager` owns at most one live transport per server.
Connections are created lazily on the first discovery/call, kept open across
requests, and replaced with exponential backoff after a transport failure.

Design boundaries:

* no FastAPI, Pydantic, SQLite or AutoAgent imports;
* transports do framing; this module owns lifecycle, cache, policy and events;
* callbacks are advisory and must be quick (the application layer should enqueue
  them onto its event bus); exceptions raised by a callback are swallowed.

The manager emits the following event payloads through ``event_callback``:

``mcp.status``
    ``{"type": "mcp.status", "server": str, "status": {...}}``
``mcp.log``
    ``{"type": "mcp.log", "server": str, "entry": {...}}``
``mcp.tools_changed``
    ``{"type": "mcp.tools_changed", "server": str, "tools": [...]}``

A ``notifications/tools/list_changed`` notification clears the tool cache and
refreshes it on a worker thread (refreshing inline would deadlock stdio, whose
reader thread is the one dispatching the notification).
"""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from .approval import (
    ApprovalContext,
    ApprovalDecision,
    ApprovalEngine,
    ServerApprovalPolicy,
    ToolAnnotations,
    ToolMetadata,
)
from .transports import (
    LegacySseTransport,
    McpCancelled,
    McpClosed,
    McpHttpError,
    McpProtocolError,
    McpRpcError,
    McpTimeout,
    McpTransportError,
    StdioTransport,
    StreamableHttpTransport,
    Transport,
)

TransportKind = Literal["stdio", "http", "sse"]
ServerState = Literal[
    "idle", "connecting", "connected", "reconnecting", "error", "disabled", "closed"
]
LogLevel = Literal["debug", "info", "warning", "error", "stderr"]

_PROTOCOL_VERSION = "2025-06-18"
_CLIENT_INFO: dict[str, object] = {"name": "autoagent-backend", "version": "0.2.0"}
_DEFAULT_CONNECT_TIMEOUT = 10.0
_DEFAULT_CALL_TIMEOUT = 30.0
_DEFAULT_HEALTH_TIMEOUT = 5.0
_DEFAULT_MAX_CONCURRENCY = 4
_DEFAULT_LOG_CAPACITY = 500
_MAX_ERROR_CHARS = 300


class McpManagerError(Exception):
    """Base class for expected manager failures."""


class McpServerNotFound(McpManagerError):
    """No server with that name is registered."""


class McpToolNotFound(McpManagerError):
    """The connected server does not expose that tool."""


class McpUnavailable(McpManagerError):
    """The server could not be reached or the connection was lost."""


class McpCapabilityUnavailable(McpManagerError):
    """The server did not advertise resources or prompts."""


class McpApprovalRequired(McpManagerError):
    """The policy returned ``ask``; the caller must collect consent and retry."""

    def __init__(self, decision: ApprovalDecision) -> None:
        super().__init__(decision.reason)
        self.decision = decision


class McpApprovalDenied(McpManagerError):
    """The policy returned ``deny``."""

    def __init__(self, decision: ApprovalDecision) -> None:
        super().__init__(decision.reason)
        self.decision = decision


@dataclass(frozen=True, slots=True)
class ServerSpec:
    """User-owned server definition.

    Pre: stdio requires ``command``; http/sse require an http(s) ``url``.
    Post: ``env`` and ``headers`` are copies; they are never included in status
          events or logs.
    """

    name: str
    transport: TransportKind = "stdio"
    command: str | None = None
    args: tuple[str, ...] = ()
    env: Mapping[str, str] = field(default_factory=dict)
    url: str | None = None
    headers: Mapping[str, str] = field(default_factory=dict)
    cwd: str | None = None
    connect_timeout: float = _DEFAULT_CONNECT_TIMEOUT
    call_timeout: float = _DEFAULT_CALL_TIMEOUT
    health_timeout: float = _DEFAULT_HEALTH_TIMEOUT
    max_concurrency: int = _DEFAULT_MAX_CONCURRENCY
    notification_stream: bool = True

    def __post_init__(self) -> None:
        name = self.name.strip()
        if not name:
            raise ValueError("MCP server name is required")
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "args", tuple(str(item) for item in self.args))
        object.__setattr__(self, "env", dict(self.env))
        object.__setattr__(self, "headers", dict(self.headers))
        if self.transport == "stdio" and not (self.command or "").strip():
            raise ValueError("stdio MCP servers require a command")
        if self.transport in {"http", "sse"} and not (self.url or "").strip():
            raise ValueError("http/sse MCP servers require a url")
        if self.transport not in {"stdio", "http", "sse"}:
            raise ValueError("unsupported MCP transport")
        if self.connect_timeout <= 0 or self.call_timeout <= 0:
            raise ValueError("MCP timeouts must be positive")
        if self.max_concurrency < 1:
            raise ValueError("MCP max_concurrency must be at least 1")


@dataclass(frozen=True, slots=True)
class McpTool:
    """One tool advertised by a server, with approval-relevant annotations."""

    name: str
    title: str | None = None
    description: str = ""
    input_schema: Mapping[str, object] | None = None
    output_schema: Mapping[str, object] | None = None
    annotations: ToolAnnotations = field(default_factory=ToolAnnotations)

    def as_dict(self) -> dict[str, object]:
        """Post: JSON-serializable view without any transport state."""

        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": dict(self.input_schema) if self.input_schema else None,
            "outputSchema": dict(self.output_schema) if self.output_schema else None,
            "annotations": {
                "readOnlyHint": self.annotations.read_only,
                "destructiveHint": self.annotations.destructive,
                "idempotentHint": self.annotations.idempotent,
                "openWorldHint": self.annotations.open_world,
            },
        }


@dataclass(frozen=True, slots=True)
class McpResource:
    uri: str
    name: str = ""
    description: str = ""
    mime_type: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "uri": self.uri,
            "name": self.name,
            "description": self.description,
            "mimeType": self.mime_type,
        }


@dataclass(frozen=True, slots=True)
class McpPromptArgument:
    name: str
    description: str = ""
    required: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "description": self.description,
            "required": self.required,
        }


@dataclass(frozen=True, slots=True)
class McpPrompt:
    name: str
    description: str = ""
    arguments: tuple[McpPromptArgument, ...] = ()

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "description": self.description,
            "arguments": [argument.as_dict() for argument in self.arguments],
        }


@dataclass(frozen=True, slots=True)
class McpToolResult:
    """A normalized ``tools/call`` result.

    Post: ``content`` preserves MCP content blocks; ``structured_content`` is
          present when the server declared an output schema.
    """

    content: tuple[object, ...] = ()
    structured_content: object | None = None
    is_error: bool = False
    meta: Mapping[str, object] | None = None

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "content": list(self.content),
            "isError": self.is_error,
        }
        if self.structured_content is not None:
            result["structuredContent"] = self.structured_content
        if self.meta is not None:
            result["_meta"] = dict(self.meta)
        return result


@dataclass(frozen=True, slots=True)
class McpLogEntry:
    server: str
    level: LogLevel
    message: str
    ts_ms: int

    def as_dict(self) -> dict[str, object]:
        return {
            "server": self.server,
            "level": self.level,
            "message": self.message,
            "ts": self.ts_ms,
        }


@dataclass(frozen=True, slots=True)
class ServerStatus:
    """Public status snapshot; deliberately contains no argv, env or headers."""

    name: str
    state: ServerState
    connected: bool = False
    tool_count: int = 0
    resource_count: int = 0
    prompt_count: int = 0
    last_error: str | None = None
    protocol_version: str | None = None
    server_name: str | None = None
    server_version: str | None = None
    instructions: str | None = None
    session_id: str | None = None
    pid: int | None = None
    reconnect_attempts: int = 0
    next_retry_in_ms: int | None = None
    updated_at: int = 0

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "state": self.state,
            "connected": self.connected,
            "toolCount": self.tool_count,
            "resourceCount": self.resource_count,
            "promptCount": self.prompt_count,
            "lastError": self.last_error,
            "protocolVersion": self.protocol_version,
            "serverName": self.server_name,
            "serverVersion": self.server_version,
            "instructions": self.instructions,
            "sessionId": self.session_id,
            "pid": self.pid,
            "reconnectAttempts": self.reconnect_attempts,
            "nextRetryInMs": self.next_retry_in_ms,
            "updatedAt": self.updated_at,
        }


StatusCallback = Callable[[ServerStatus], None]
LogCallback = Callable[[McpLogEntry], None]
EventCallback = Callable[[dict[str, object]], None]
ToolsChangedCallback = Callable[[str, tuple[McpTool, ...]], None]


@dataclass(slots=True)
class _ManagedServer:
    spec: ServerSpec
    enabled: bool = True
    state: ServerState = "idle"
    transport: Transport | None = None
    tools: tuple[McpTool, ...] | None = None
    resources: tuple[McpResource, ...] | None = None
    prompts: tuple[McpPrompt, ...] | None = None
    capabilities: dict[str, object] = field(default_factory=dict)
    protocol_version: str | None = None
    server_name: str | None = None
    server_version: str | None = None
    instructions: str | None = None
    last_error: str | None = None
    reconnect_attempts: int = 0
    next_retry_at: float = 0.0
    updated_at: int = 0
    refreshing_tools: bool = False
    lock: threading.RLock = field(default_factory=threading.RLock)
    connect_lock: threading.RLock = field(default_factory=threading.RLock)
    log_lock: threading.RLock = field(default_factory=threading.RLock)
    fetch_lock: threading.RLock = field(default_factory=threading.RLock)
    semaphore: threading.BoundedSemaphore = field(init=False)
    logs: deque[McpLogEntry] = field(default_factory=lambda: deque(maxlen=_DEFAULT_LOG_CAPACITY))

    def __post_init__(self) -> None:
        self.semaphore = threading.BoundedSemaphore(self.spec.max_concurrency)


def _as_object(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    return {str(key): item for key, item in value.items()}


def _as_list(value: object) -> list[object]:
    return list(value) if isinstance(value, list) else []


def _as_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _sanitize_error(value: object, fallback: str = "MCP request failed") -> str:
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text[:_MAX_ERROR_CHARS] or fallback


class McpConnectionManager:
    """Owns one persistent session per registered server.

    Pre: ``specs`` names are unique; callbacks are thread-safe and non-blocking.
    Post: ``shutdown`` closes every transport; no callback runs after it
          returns.  All public methods are safe for concurrent callers.
    """

    def __init__(
        self,
        specs: Iterable[ServerSpec] = (),
        *,
        status_callback: StatusCallback | None = None,
        log_callback: LogCallback | None = None,
        event_callback: EventCallback | None = None,
        tools_changed_callback: ToolsChangedCallback | None = None,
        approval_engine: ApprovalEngine | None = None,
        backoff_initial: float = 0.5,
        backoff_max: float = 30.0,
        log_capacity: int = _DEFAULT_LOG_CAPACITY,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], int] = lambda: int(time.time() * 1000),
    ) -> None:
        self._servers: dict[str, _ManagedServer] = {}
        self._servers_lock = threading.RLock()
        self._status_callback = status_callback
        self._log_callback = log_callback
        self._event_callback = event_callback
        self._tools_changed_callback = tools_changed_callback
        self.approval = approval_engine or ApprovalEngine()
        self._backoff_initial = max(backoff_initial, 0.01)
        self._backoff_max = max(backoff_max, self._backoff_initial)
        self._log_capacity = max(log_capacity, 1)
        self._clock = clock
        self._wall_clock = wall_clock
        self._stop = threading.Event()
        self._background: threading.Thread | None = None
        self._shutdown = False
        for spec in specs:
            self.register(spec)

    # -- registration ------------------------------------------------------

    def register(
        self,
        spec: ServerSpec,
        *,
        enabled: bool = True,
        policy: ServerApprovalPolicy | None = None,
    ) -> ServerStatus:
        """Add or replace a server definition.

        Post: replacing a connected server closes the old transport; the new
              one connects lazily on the next operation.
        """

        if self._shutdown:
            raise McpUnavailable("MCP connection manager is shut down")
        managed = _ManagedServer(spec=spec, enabled=enabled)
        managed.state = "idle" if enabled else "disabled"
        managed.logs = deque(maxlen=self._log_capacity)
        with self._servers_lock:
            previous = self._servers.get(spec.name)
            self._servers[spec.name] = managed
        if previous is not None:
            self._close_managed(previous)
        if policy is not None:
            self.approval.set_server_policy(spec.name, policy)
        self._emit_status(managed)
        self._log(managed, "info", f"MCP server registered ({spec.transport} transport)")
        return self._status_of(managed)

    def unregister(self, name: str) -> None:
        """Remove a server and close its transport; idempotent for the map."""

        with self._servers_lock:
            managed = self._servers.pop(name, None)
        if managed is not None:
            self._close_managed(managed)
            managed.state = "closed"
            self._emit_status(managed)

    def set_enabled(self, name: str, enabled: bool) -> ServerStatus:
        """Enable (lazy connect) or disable (drop the live connection)."""

        managed = self._managed(name)
        managed.enabled = enabled
        if not enabled:
            with managed.lock:
                managed.tools = None
                managed.resources = None
                managed.prompts = None
            self._close_managed(managed)
            managed.state = "disabled"
            managed.reconnect_attempts = 0
            managed.next_retry_at = 0.0
        else:
            managed.state = "idle"
        self._emit_status(managed)
        return self._status_of(managed)

    def names(self) -> tuple[str, ...]:
        with self._servers_lock:
            return tuple(self._servers)

    def statuses(self) -> tuple[ServerStatus, ...]:
        with self._servers_lock:
            managed = tuple(self._servers.values())
        return tuple(self._status_of(item) for item in managed)

    def status(self, name: str) -> ServerStatus:
        return self._status_of(self._managed(name))

    # -- connection lifecycle ---------------------------------------------

    def connect(self, name: str) -> ServerStatus:
        """Ensure a live initialized session; return its status."""

        self._ensure_connected(name)
        return self.status(name)

    def reconnect(self, name: str) -> ServerStatus:
        """Drop the current transport and initialize a new session."""

        managed = self._managed(name)
        self._close_managed(managed)
        with managed.lock:
            managed.state = "reconnecting"
            managed.next_retry_at = 0.0
        self._emit_status(managed)
        self._ensure_connected(name)
        return self.status(name)

    def health_check(self, name: str, *, reconnect: bool = False) -> bool:
        """Send ``ping``; on failure mark the server unhealthy.

        Post: returns ``True`` when the session answers (or rejects ``ping``
              with method-not-found, which still proves liveness).
        """

        managed = self._managed(name)
        if not managed.enabled or managed.transport is None:
            return False
        try:
            self._request(
                managed,
                "ping",
                {},
                timeout=managed.spec.health_timeout,
                cancel_event=None,
                retry_safe=False,
            )
            return True
        except McpRpcError as exc:
            # -32601: ping is optional. The connection is still alive.
            return exc.error_code in {-32601, -32600}
        except (McpTransportError, McpUnavailable) as exc:
            self._mark_failed(managed, str(exc))
            if reconnect and managed.enabled:
                try:
                    self._ensure_connected(name, respect_backoff=True)
                except McpUnavailable:
                    return False
                return True
            return False

    def check_all(self) -> dict[str, bool]:
        results: dict[str, bool] = {}
        for name in self.names():
            managed = self._managed(name)
            if managed.enabled:
                results[name] = self.health_check(name, reconnect=True)
        return results

    # -- tools -------------------------------------------------------------

    def list_tools(self, name: str, *, refresh: bool = False) -> tuple[McpTool, ...]:
        """Return cached tools, fetching ``tools/list`` once when needed."""

        managed = self._managed(name)
        if not managed.enabled:
            raise McpUnavailable(f"MCP server is disabled: {name}")
        if not refresh:
            with managed.lock:
                cached = managed.tools
            if cached is not None:
                return cached
        return self._fetch_tools(managed, ensure=True)

    def invalidate_tools(self, name: str) -> None:
        """Drop the cache; the next call refetches."""

        managed = self._managed(name)
        with managed.lock:
            managed.tools = None
        self._emit_status(managed)

    def tool_metadata(self, name: str, tool: str) -> ToolMetadata:
        """Post: approval metadata for one tool; raises ``McpToolNotFound``."""

        entry = self._find_tool(self.list_tools(name), tool)
        return ToolMetadata(
            server=name,
            tool=entry.name,
            annotations=entry.annotations,
            description=entry.description,
        )

    def call_tool(
        self,
        name: str,
        tool: str,
        arguments: Mapping[str, object] | None = None,
        *,
        approval: ApprovalContext | None = None,
        cancel_event: threading.Event | None = None,
    ) -> McpToolResult:
        """Invoke one tool after applying the approval policy.

        Pre: ``arguments`` is a JSON-object-shaped mapping.
        Post: the call is sent at most once; transport failures are not retried
              because tool calls may not be idempotent.
        Raises: ``McpApprovalRequired``, ``McpApprovalDenied``,
                ``McpToolNotFound``, ``McpUnavailable``, ``McpTimeout``,
                ``McpCancelled`` or ``McpRpcError``.
        """

        managed = self._managed(name)
        entry = self._find_tool(self.list_tools(name), tool)
        decision = self.approval.evaluate(
            ToolMetadata(
                server=name,
                tool=entry.name,
                annotations=entry.annotations,
                description=entry.description,
            ),
            approval,
        )
        if decision.action == "deny":
            raise McpApprovalDenied(decision)
        if decision.action == "ask":
            raise McpApprovalRequired(decision)

        self._acquire(managed, managed.spec.call_timeout, cancel_event)
        try:
            result = self._request(
                managed,
                "tools/call",
                {"name": tool, "arguments": dict(arguments or {})},
                timeout=managed.spec.call_timeout,
                cancel_event=cancel_event,
                retry_safe=False,
            )
        finally:
            managed.semaphore.release()
        return self._tool_result(result)

    # -- resources and prompts --------------------------------------------

    def list_resources(self, name: str, *, refresh: bool = False) -> tuple[McpResource, ...]:
        managed = self._managed(name)
        managed = self._ensure_connected(name)
        self._require_capability(managed, "resources")
        if not refresh:
            with managed.lock:
                cached = managed.resources
            if cached is not None:
                return cached
        resources: list[McpResource] = []
        cursor: str | None = None
        while True:
            result = self._request(
                managed,
                "resources/list",
                {} if cursor is None else {"cursor": cursor},
                timeout=managed.spec.call_timeout,
                cancel_event=None,
                retry_safe=True,
            )
            payload = _as_object(result) or {}
            for raw in _as_list(payload.get("resources")):
                item = _as_object(raw)
                uri = _as_str(item.get("uri")) if item else None
                if item is None or not uri:
                    continue
                resources.append(
                    McpResource(
                        uri=uri,
                        name=_as_str(item.get("name")) or uri,
                        description=_as_str(item.get("description")) or "",
                        mime_type=_as_str(item.get("mimeType")),
                    )
                )
            cursor = _as_str(payload.get("nextCursor"))
            if not cursor:
                break
        with managed.lock:
            managed.resources = tuple(resources)
        self._emit_status(managed)
        return managed.resources or ()

    def read_resource(self, name: str, uri: str) -> dict[str, object]:
        """Post: returns the raw ``resources/read`` result (``contents``)."""

        if not uri.strip():
            raise ValueError("resource uri is required")
        managed = self._ensure_connected(name)
        self._require_capability(managed, "resources")
        result = self._request(
            managed,
            "resources/read",
            {"uri": uri},
            timeout=managed.spec.call_timeout,
            cancel_event=None,
            retry_safe=True,
        )
        payload = _as_object(result)
        if payload is None:
            raise McpProtocolError("resources/read returned a malformed result")
        return payload

    def list_prompts(self, name: str, *, refresh: bool = False) -> tuple[McpPrompt, ...]:
        managed = self._managed(name)
        managed = self._ensure_connected(name)
        self._require_capability(managed, "prompts")
        if not refresh:
            with managed.lock:
                cached = managed.prompts
            if cached is not None:
                return cached
        prompts: list[McpPrompt] = []
        cursor: str | None = None
        while True:
            result = self._request(
                managed,
                "prompts/list",
                {} if cursor is None else {"cursor": cursor},
                timeout=managed.spec.call_timeout,
                cancel_event=None,
                retry_safe=True,
            )
            payload = _as_object(result) or {}
            for raw in _as_list(payload.get("prompts")):
                item = _as_object(raw)
                prompt_name = _as_str(item.get("name")) if item else None
                if item is None or not prompt_name:
                    continue
                arguments: list[McpPromptArgument] = []
                for raw_argument in _as_list(item.get("arguments")):
                    argument = _as_object(raw_argument)
                    argument_name = _as_str(argument.get("name")) if argument else None
                    if argument is None or not argument_name:
                        continue
                    arguments.append(
                        McpPromptArgument(
                            name=argument_name,
                            description=_as_str(argument.get("description")) or "",
                            required=argument.get("required") is True,
                        )
                    )
                prompts.append(
                    McpPrompt(
                        name=prompt_name,
                        description=_as_str(item.get("description")) or "",
                        arguments=tuple(arguments),
                    )
                )
            cursor = _as_str(payload.get("nextCursor"))
            if not cursor:
                break
        with managed.lock:
            managed.prompts = tuple(prompts)
        self._emit_status(managed)
        return managed.prompts or ()

    def get_prompt(
        self,
        name: str,
        prompt: str,
        arguments: Mapping[str, str] | None = None,
    ) -> dict[str, object]:
        """Post: returns the raw ``prompts/get`` result."""

        if not prompt.strip():
            raise ValueError("prompt name is required")
        managed = self._ensure_connected(name)
        self._require_capability(managed, "prompts")
        result = self._request(
            managed,
            "prompts/get",
            {"name": prompt, "arguments": dict(arguments or {})},
            timeout=managed.spec.call_timeout,
            cancel_event=None,
            retry_safe=True,
        )
        payload = _as_object(result)
        if payload is None:
            raise McpProtocolError("prompts/get returned a malformed result")
        return payload

    # -- logs and lifecycle ------------------------------------------------

    def logs(self, name: str, *, limit: int = 200) -> tuple[McpLogEntry, ...]:
        """Post: newest-last bounded log slice."""

        managed = self._managed(name)
        count = max(min(limit, self._log_capacity), 0)
        with managed.log_lock:
            entries = tuple(managed.logs)
        return entries[-count:] if count else ()

    def start_background(self, *, interval: float = 30.0) -> None:
        """Start health checks and backoff-driven reconnects.

        Post: idempotent; the thread is daemonized and stopped by ``shutdown``.
        """

        if self._background is not None and self._background.is_alive():
            return
        self._stop.clear()
        self._background = threading.Thread(
            target=self._background_loop,
            args=(max(interval, 0.5),),
            name="mcp-health",
            daemon=True,
        )
        self._background.start()

    def shutdown(self) -> None:
        """Close every transport and stop the health loop."""

        self._shutdown = True
        self._stop.set()
        with self._servers_lock:
            managed = tuple(self._servers.values())
        for item in managed:
            self._close_managed(item)
            item.state = "closed"
            self._emit_status(item)
        if self._background is not None:
            self._background.join(timeout=2.0)
            self._background = None

    def close(self) -> None:
        """Alias for ``shutdown`` (container-friendly)."""

        self.shutdown()

    def __enter__(self) -> McpConnectionManager:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.shutdown()

    # -- internals ---------------------------------------------------------

    def _managed(self, name: str) -> _ManagedServer:
        with self._servers_lock:
            managed = self._servers.get(name)
        if managed is None:
            raise McpServerNotFound(f"MCP server not found: {name}")
        return managed

    def _status_of(self, managed: _ManagedServer) -> ServerStatus:
        with managed.lock:
            tool_count = len(managed.tools or ())
            resource_count = len(managed.resources or ())
            prompt_count = len(managed.prompts or ())
            next_retry = (
                max(0.0, managed.next_retry_at - self._clock())
                if managed.state in {"error", "reconnecting"} and managed.next_retry_at > 0
                else 0.0
            )
            return ServerStatus(
                name=managed.spec.name,
                state=managed.state,
                connected=managed.state == "connected",
                tool_count=tool_count,
                resource_count=resource_count,
                prompt_count=prompt_count,
                last_error=managed.last_error,
                protocol_version=managed.protocol_version,
                server_name=managed.server_name,
                server_version=managed.server_version,
                instructions=managed.instructions,
                session_id=(
                    managed.transport.session_id if managed.transport is not None else None
                ),
                pid=(managed.transport.pid if managed.transport is not None else None),
                reconnect_attempts=managed.reconnect_attempts,
                next_retry_in_ms=(int(next_retry * 1000.0) if next_retry > 0 else None),
                updated_at=managed.updated_at or self._wall_clock(),
            )

    def _ensure_connected(self, name: str, *, respect_backoff: bool = False) -> _ManagedServer:
        managed = self._managed(name)
        if not managed.enabled:
            raise McpUnavailable(f"MCP server is disabled: {name}")
        with managed.connect_lock:
            if managed.state == "connected" and managed.transport is not None:
                return managed
            if respect_backoff and self._clock() < managed.next_retry_at:
                raise McpUnavailable(f"MCP server is backing off after a failure: {name}")
            managed.state = "reconnecting" if managed.reconnect_attempts > 0 else "connecting"
            managed.updated_at = self._wall_clock()
            self._emit_status(managed)
            transport = self._build_transport(managed)
            managed.transport = transport
            try:
                result = transport.request(
                    "initialize",
                    {
                        "protocolVersion": _PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": dict(_CLIENT_INFO),
                    },
                    timeout=managed.spec.connect_timeout,
                )
                payload = _as_object(result) or {}
                managed.protocol_version = (
                    _as_str(payload.get("protocolVersion")) or _PROTOCOL_VERSION
                )
                managed.capabilities = _as_object(payload.get("capabilities")) or {}
                server_info = _as_object(payload.get("serverInfo")) or {}
                managed.server_name = _as_str(server_info.get("name"))
                managed.server_version = _as_str(server_info.get("version"))
                managed.instructions = _as_str(payload.get("instructions"))
                setter = getattr(transport, "set_protocol_version", None)
                if callable(setter) and managed.protocol_version:
                    setter(managed.protocol_version)
                transport.notify("notifications/initialized")
                managed.state = "connected"
                managed.last_error = None
                managed.reconnect_attempts = 0
                managed.next_retry_at = 0.0
                managed.updated_at = self._wall_clock()
                self._emit_status(managed)
                self._log(
                    managed,
                    "info",
                    f"MCP server connected (protocol {managed.protocol_version})",
                )
                try:
                    self._fetch_tools(managed, ensure=False)
                except (McpTransportError, McpUnavailable) as exc:
                    self._log(managed, "warning", f"tools/list failed: {exc}")
                transport.start_notification_stream()
                return managed
            except Exception as exc:
                managed.state = "error"
                managed.last_error = _sanitize_error(exc)
                managed.reconnect_attempts += 1
                managed.next_retry_at = self._clock() + self._backoff(managed.reconnect_attempts)
                managed.updated_at = self._wall_clock()
                self._emit_status(managed)
                self._log(managed, "error", f"MCP connect failed: {exc}")
                self._close_transport(managed)
                raise McpUnavailable(managed.last_error or str(exc)) from exc

    def _build_transport(self, managed: _ManagedServer) -> Transport:
        spec = managed.spec
        log_handler = lambda level, message: self._log(  # noqa: E731
            managed, "stderr" if level == "stderr" else _log_level(level), message
        )
        if spec.transport == "stdio":
            transport: Transport = StdioTransport(
                spec.command or "",
                spec.args,
                env=spec.env,
                cwd=spec.cwd,
            )
        elif spec.transport == "http":
            transport = StreamableHttpTransport(
                spec.url or "",
                headers=spec.headers,
                notification_stream=spec.notification_stream,
                open_timeout=spec.connect_timeout,
            )
        else:
            transport = LegacySseTransport(
                spec.url or "",
                headers=spec.headers,
                open_timeout=spec.connect_timeout,
            )
        transport.set_log_handler(log_handler)
        transport.set_notification_handler(
            lambda method, params: self._on_notification(managed, method, params)
        )
        return transport

    def _fetch_tools(self, managed: _ManagedServer, *, ensure: bool) -> tuple[McpTool, ...]:
        with managed.fetch_lock:
            if ensure:
                managed = self._ensure_connected(managed.spec.name)
            collected: list[McpTool] = []
            cursor: str | None = None
            while True:
                try:
                    result = self._request(
                        managed,
                        "tools/list",
                        {} if cursor is None else {"cursor": cursor},
                        timeout=managed.spec.call_timeout,
                        cancel_event=None,
                        retry_safe=True,
                    )
                except McpTransportError as exc:
                    raise McpUnavailable(_sanitize_error(exc)) from exc
                payload = _as_object(result) or {}
                for raw in _as_list(payload.get("tools")):
                    tool = self._parse_tool(raw)
                    if tool is not None:
                        collected.append(tool)
                cursor = _as_str(payload.get("nextCursor"))
                if not cursor:
                    break
            tools = tuple(collected)
            with managed.lock:
                changed = managed.tools != tools
                managed.tools = tools
                managed.updated_at = self._wall_clock()
            if changed:
                self._emit_status(managed)
                self._emit_tools_changed(managed)
            return tools

    @staticmethod
    def _parse_tool(raw: object) -> McpTool | None:
        item = _as_object(raw)
        if item is None:
            return None
        name = _as_str(item.get("name"))
        if not name:
            return None
        input_schema = _as_object(item.get("inputSchema"))
        output_schema = _as_object(item.get("outputSchema"))
        return McpTool(
            name=name,
            title=_as_str(item.get("title")),
            description=_as_str(item.get("description")) or "",
            input_schema=input_schema,
            output_schema=output_schema,
            annotations=ToolAnnotations.from_mcp(_as_object(item.get("annotations"))),
        )

    @staticmethod
    def _find_tool(tools: Sequence[McpTool], name: str) -> McpTool:
        for tool in tools:
            if tool.name == name:
                return tool
        raise McpToolNotFound(f"MCP tool not found: {name}")

    def _request(
        self,
        managed: _ManagedServer,
        method: str,
        params: Mapping[str, object],
        *,
        timeout: float,
        cancel_event: threading.Event | None,
        retry_safe: bool,
    ) -> object:
        attempts = 2 if retry_safe else 1
        last_error = "MCP request failed"
        for attempt in range(attempts):
            managed = self._ensure_connected(managed.spec.name)
            transport = managed.transport
            if transport is None:
                raise McpUnavailable(f"MCP server is not connected: {managed.spec.name}")
            try:
                return transport.request(
                    method,
                    params,
                    timeout=timeout,
                    cancel_event=cancel_event,
                )
            except (McpCancelled, McpTimeout, McpRpcError):
                # Timeouts and RPC errors leave the session usable.
                raise
            except McpHttpError as exc:
                if exc.session_expired:
                    self._log(managed, "warning", "MCP HTTP session expired")
                    self._close_transport(managed)
                    if attempt + 1 < attempts:
                        continue
                self._mark_failed(managed, str(exc))
                last_error = str(exc)
            except (McpClosed, McpProtocolError) as exc:
                self._mark_failed(managed, str(exc))
                last_error = str(exc)
            except McpTransportError as exc:
                self._mark_failed(managed, str(exc))
                last_error = str(exc)
                if not exc.retryable:
                    break
            if attempt + 1 < attempts:
                self._log(managed, "warning", "retrying an idempotent MCP request")
        raise McpUnavailable(last_error)

    def _tool_result(self, result: object) -> McpToolResult:
        payload = _as_object(result)
        if payload is None:
            raise McpProtocolError("tools/call returned a malformed result")
        meta = _as_object(payload.get("_meta"))
        return McpToolResult(
            content=tuple(_as_list(payload.get("content"))),
            structured_content=payload.get("structuredContent"),
            is_error=payload.get("isError") is True,
            meta=meta,
        )

    def _acquire(
        self,
        managed: _ManagedServer,
        timeout: float,
        cancel_event: threading.Event | None,
    ) -> None:
        deadline = self._clock() + timeout
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise McpCancelled()
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise McpTimeout("MCP call queue wait timed out")
            if managed.semaphore.acquire(timeout=min(0.05, remaining)):
                return

    def _require_capability(self, managed: _ManagedServer, capability: str) -> None:
        with managed.lock:
            advertised = _as_object(managed.capabilities.get(capability))
        if advertised is None:
            raise McpCapabilityUnavailable(
                f"MCP server {managed.spec.name} does not advertise {capability}"
            )

    def _on_notification(
        self, managed: _ManagedServer, method: str, params: Mapping[str, object]
    ) -> None:
        del params
        known = {
            "notifications/tools/list_changed",
            "notifications/resources/list_changed",
            "notifications/prompts/list_changed",
        }
        if method not in known:
            self._log(managed, "debug", f"unhandled notification: {method}")
            return
        # Notifications are dispatched on the transport reader thread, which
        # must never block (a stdio response may follow the notification).
        threading.Thread(
            target=self._process_notification,
            args=(managed, method),
            name=f"mcp-notify-{managed.spec.name}",
            daemon=True,
        ).start()

    def _process_notification(self, managed: _ManagedServer, method: str) -> None:
        if method == "notifications/tools/list_changed":
            with managed.lock:
                managed.tools = None
            self._emit_status(managed)
            self._schedule_tool_refresh(managed)
            return
        if method == "notifications/resources/list_changed":
            with managed.lock:
                managed.resources = None
            self._emit_status(managed)
            return
        if method == "notifications/prompts/list_changed":
            with managed.lock:
                managed.prompts = None
            self._emit_status(managed)
            return
        self._log(managed, "debug", f"unhandled notification: {method}")

    def _schedule_tool_refresh(self, managed: _ManagedServer) -> None:
        with managed.lock:
            if managed.refreshing_tools or managed.state != "connected":
                return
            managed.refreshing_tools = True
        thread = threading.Thread(
            target=self._refresh_tools_worker,
            args=(managed,),
            name=f"mcp-refresh-{managed.spec.name}",
            daemon=True,
        )
        thread.start()

    def _refresh_tools_worker(self, managed: _ManagedServer) -> None:
        try:
            self._fetch_tools(managed, ensure=True)
        except (McpTransportError, McpUnavailable) as exc:
            self._log(managed, "warning", f"tools/list refresh failed: {exc}")
        finally:
            with managed.lock:
                managed.refreshing_tools = False

    def _mark_failed(self, managed: _ManagedServer, message: str) -> None:
        with managed.lock:
            managed.state = "error"
            managed.last_error = _sanitize_error(message)
            managed.reconnect_attempts += 1
            managed.next_retry_at = self._clock() + self._backoff(managed.reconnect_attempts)
            managed.updated_at = self._wall_clock()
            self._emit_status(managed)
        self._log(managed, "error", f"MCP connection failed: {managed.last_error}")
        self._close_transport(managed)

    def _close_managed(self, managed: _ManagedServer) -> None:
        self._close_transport(managed)

    def _close_transport(self, managed: _ManagedServer) -> None:
        with managed.lock:
            transport = managed.transport
            managed.transport = None
        if transport is not None:
            try:
                transport.close()
            except Exception:
                # Close is best-effort; the process group kill is already
                # attempted inside the transport.
                pass

    def _backoff(self, attempt: int) -> float:
        exponent = min(max(attempt - 1, 0), 16)
        return min(self._backoff_max, self._backoff_initial * (2.0**exponent))

    def _background_loop(self, interval: float) -> None:
        while not self._stop.wait(interval):
            for name in self.names():
                if self._stop.is_set():
                    return
                managed = self._managed(name)
                if not managed.enabled:
                    continue
                if managed.state == "connected":
                    self.health_check(name, reconnect=True)
                elif managed.state in {"idle", "error"} and self._clock() >= managed.next_retry_at:
                    try:
                        self._ensure_connected(name, respect_backoff=True)
                    except (McpUnavailable, McpTransportError):
                        pass

    def _log(self, managed: _ManagedServer, level: LogLevel, message: str) -> None:
        entry = McpLogEntry(
            server=managed.spec.name,
            level=level,
            message=_sanitize_error(message),
            ts_ms=self._wall_clock(),
        )
        with managed.log_lock:
            managed.logs.append(entry)
        callback = self._log_callback
        if callback is not None:
            try:
                callback(entry)
            except Exception:
                pass
        self._emit({"type": "mcp.log", "server": entry.server, "entry": entry.as_dict()})

    def _emit_status(self, managed: _ManagedServer) -> None:
        status = self._status_of(managed)
        callback = self._status_callback
        if callback is not None:
            try:
                callback(status)
            except Exception:
                pass
        self._emit({"type": "mcp.status", "server": status.name, "status": status.as_dict()})

    def _emit_tools_changed(self, managed: _ManagedServer) -> None:
        tools = managed.tools or ()
        callback = self._tools_changed_callback
        if callback is not None:
            try:
                callback(managed.spec.name, tools)
            except Exception:
                pass
        self._emit(
            {
                "type": "mcp.tools_changed",
                "server": managed.spec.name,
                "tools": [tool.as_dict() for tool in tools],
            }
        )

    def _emit(self, payload: dict[str, object]) -> None:
        callback = self._event_callback
        if callback is None:
            return
        try:
            callback(payload)
        except Exception:
            pass


def _log_level(level: str) -> LogLevel:
    if level == "debug":
        return "debug"
    if level == "info":
        return "info"
    if level == "warning":
        return "warning"
    if level == "error":
        return "error"
    if level == "stderr":
        return "stderr"
    return "info"


def dumps_status(status: ServerStatus) -> str:
    """Convenience for tests and adapter glue."""

    return json.dumps(status.as_dict(), separators=(",", ":"), ensure_ascii=False)


__all__ = [
    "McpApprovalDenied",
    "McpApprovalRequired",
    "McpCapabilityUnavailable",
    "McpConnectionManager",
    "McpLogEntry",
    "McpManagerError",
    "McpPrompt",
    "McpPromptArgument",
    "McpResource",
    "McpServerNotFound",
    "McpTool",
    "McpToolNotFound",
    "McpToolResult",
    "McpUnavailable",
    "ServerSpec",
    "ServerState",
    "ServerStatus",
    "dumps_status",
]
