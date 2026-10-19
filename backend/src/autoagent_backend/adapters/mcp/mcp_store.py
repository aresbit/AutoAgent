"""SQLite MCP registry with a persistent runtime and a short-lived rollback.

The registry is the only place that maps persisted rows to the runtime. When a
``McpConnectionManager`` is injected, discovery/invocation/status use its
persistent sessions; otherwise the legacy fresh-connection factory is used so
``AUTOAGENT_MCP_PERSISTENT=0`` restores the previous behavior without a data
migration.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from collections.abc import Callable, Mapping
from typing import TypeVar

from ...domain.errors import (
    InvalidInput,
    McpApprovalDenied,
    McpApprovalRequired,
    McpCapabilityUnavailable,
    McpServerNotFound,
    McpTimeout,
    McpToolNotFound,
    McpUnavailable,
)
from ...domain.models import (
    McpApprovalContext,
    McpDiscovery,
    McpInvocationResult,
    McpLogEntry,
    McpPrompt,
    McpPromptArgument,
    McpResource,
    McpServer,
    McpServerSpec,
    McpServerStatus,
    McpTool,
    McpToolAnnotations,
)
from ...domain.ports import ClockPort
from ..persistence.sqlite import SqliteDatabase
from .approval import ApprovalContext
from .client import DefaultMcpConnectionFactory, McpConnection, McpConnectionFactory
from .connection_manager import (
    McpApprovalDenied as RuntimeApprovalDenied,
)
from .connection_manager import (
    McpApprovalRequired as RuntimeApprovalRequired,
)
from .connection_manager import (
    McpCapabilityUnavailable as RuntimeCapabilityUnavailable,
)
from .connection_manager import McpConnectionManager
from .connection_manager import (
    McpServerNotFound as RuntimeServerNotFound,
)
from .connection_manager import (
    McpTool as RuntimeTool,
)
from .connection_manager import (
    McpToolNotFound as RuntimeToolNotFound,
)
from .connection_manager import (
    McpUnavailable as RuntimeUnavailable,
)
from .connection_manager import (
    ServerSpec as RuntimeServerSpec,
)
from .connection_manager import (
    ServerStatus as RuntimeServerStatus,
)
from .transports import McpCancelled, McpProtocolError, McpRpcError
from .transports import McpTimeout as RuntimeTimeout

_T = TypeVar("_T")


def runtime_spec_for(server: McpServer) -> RuntimeServerSpec:
    """Project a persisted server onto the runtime's immutable spec."""

    spec = server.spec
    return RuntimeServerSpec(
        name=server.name,
        transport=spec.transport,
        command=spec.command,
        args=spec.args,
        env=spec.env,
        url=spec.url,
        headers=spec.headers,
    )


def _spec_to_json(spec: McpServerSpec) -> str:
    return json.dumps(
        {
            "transport": spec.transport,
            "command": spec.command,
            "args": list(spec.args),
            "env": dict(spec.env),
            "url": spec.url,
            "headers": dict(spec.headers),
        },
        separators=(",", ":"),
    )


def _spec_from_json(raw: str) -> McpServerSpec:
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InvalidInput("stored MCP server specification is invalid") from exc
    if not isinstance(document, dict):
        raise InvalidInput("stored MCP server specification is invalid")
    transport = document.get("transport", "stdio")
    if transport not in {"stdio", "http", "sse"}:
        raise InvalidInput("stored MCP server specification is invalid")
    args = document.get("args", [])
    env = document.get("env", {})
    headers = document.get("headers", {})
    try:
        return McpServerSpec(
            transport=transport,
            command=document.get("command"),
            args=tuple(str(item) for item in args) if isinstance(args, list) else (),
            env={str(k): str(v) for k, v in env.items()} if isinstance(env, dict) else {},
            url=document.get("url"),
            headers=(
                {str(k): str(v) for k, v in headers.items()}
                if isinstance(headers, dict)
                else {}
            ),
        )
    except ValueError as exc:
        raise InvalidInput("stored MCP server specification is invalid") from exc


def _validate_name(name: str) -> str:
    cleaned = name.strip()
    if (
        not cleaned
        or len(cleaned) > 200
        or cleaned in {".", ".."}
        or "/" in cleaned
        or "\\" in cleaned
        or cleaned.startswith(".")
    ):
        raise InvalidInput("invalid MCP server name")
    return cleaned


def _sanitize_result(value: object) -> object:
    """Round-trip through JSON so transports cannot leak exotic objects."""

    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


class SqliteMcpRegistry:
    """Implements ``McpRegistryPort``.

    ``runtime`` owns persistent sessions (T0). ``connections`` is only used when
    no runtime is injected and remains the rollback path.
    """

    def __init__(
        self,
        db: SqliteDatabase,
        clock: ClockPort,
        *,
        connections: McpConnectionFactory | None = None,
        runtime: McpConnectionManager | None = None,
    ) -> None:
        self._db = db
        self._clock = clock
        self._runtime = runtime
        self._connections: McpConnectionFactory = (
            connections or DefaultMcpConnectionFactory()
        )

    # -- CRUD --------------------------------------------------------------

    def list(self) -> tuple[McpServer, ...]:
        rows = self._db.query_all(
            "SELECT name, spec_json, enabled, auto_run, created_at, updated_at "
            "FROM mcp_servers ORDER BY created_at ASC, name ASC"
        )
        return tuple(self._row_to_server(row) for row in rows)

    def upsert(
        self,
        name: str,
        spec: McpServerSpec,
        *,
        enabled: bool = True,
        auto_run: bool = False,
    ) -> McpServer:
        cleaned = _validate_name(name)
        now = self._clock.now_ms()
        encoded = _spec_to_json(spec)
        with self._db.transaction() as connection:
            connection.execute(
                "INSERT INTO mcp_servers"
                "(name, spec_json, enabled, auto_run, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET "
                "spec_json=excluded.spec_json, "
                "enabled=excluded.enabled, "
                "auto_run=excluded.auto_run, "
                "updated_at=excluded.updated_at",
                (
                    cleaned,
                    encoded,
                    1 if enabled else 0,
                    1 if auto_run else 0,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT name, spec_json, enabled, auto_run, created_at, updated_at "
                "FROM mcp_servers WHERE name = ?",
                (cleaned,),
            ).fetchone()
        if row is None:  # pragma: no cover - upsert invariant
            raise McpServerNotFound(f"MCP server not found: {cleaned}")
        server = self._row_to_server(row)
        if self._runtime is not None:
            self._runtime.register(runtime_spec_for(server), enabled=enabled)
        return server

    def remove(self, name: str) -> None:
        cleaned = _validate_name(name)
        deleted = self._db.execute(
            "DELETE FROM mcp_servers WHERE name = ?", (cleaned,)
        )
        if deleted == 0:
            raise McpServerNotFound(f"MCP server not found: {cleaned}")
        if self._runtime is not None:
            self._runtime.unregister(cleaned)

    def set_enabled(self, name: str, enabled: bool) -> McpServer:
        cleaned = _validate_name(name)
        changed = self._db.execute(
            "UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE name = ?",
            (1 if enabled else 0, self._clock.now_ms(), cleaned),
        )
        if changed == 0:
            raise McpServerNotFound(f"MCP server not found: {cleaned}")
        if self._runtime is not None:
            self._runtime.set_enabled(cleaned, enabled)
        return self._get(cleaned)

    def get(self, name: str) -> McpServer:
        """Return one server; not part of the port but useful to services/tests."""

        return self._get(_validate_name(name))

    # -- discovery and invocation -----------------------------------------

    def discover(
        self,
        name: str | None = None,
        enabled_only: bool = True,
        *,
        refresh: bool = False,
    ) -> tuple[McpDiscovery, ...]:
        if name is not None:
            servers: tuple[McpServer, ...] = (
                self._get(_validate_name(name)),
            )
        else:
            servers = tuple(
                server for server in self.list() if server.enabled or not enabled_only
            )
        if self._runtime is not None:
            return tuple(
                self._discover_managed(server, refresh) for server in servers
            )
        return tuple(self._discover_one(server) for server in servers)

    def invoke(
        self,
        server: str | None,
        tool: str,
        args: dict[str, object],
        *,
        approval: McpApprovalContext | None = None,
    ) -> McpInvocationResult:
        tool_name = tool.strip()
        if not tool_name:
            raise InvalidInput("tool name is required")
        candidates = self._candidates(server)
        if self._runtime is not None:
            return self._invoke_managed(candidates, tool_name, args, approval)
        return self._invoke_short_lived(candidates, tool_name, args)

    # -- runtime status and capabilities -----------------------------------

    def status(self, name: str | None = None) -> tuple[McpServerStatus, ...]:
        if self._runtime is None:
            servers = self.list() if name is None else (self._get(_validate_name(name)),)
            return tuple(
                McpServerStatus(
                    name=item.name,
                    state="idle" if item.enabled else "disabled",
                    updated_at=item.updated_at,
                )
                for item in servers
            )
        if name is None:
            statuses = self._runtime.statuses()
        else:
            statuses = (self._runtime.status(_validate_name(name)),)
        return tuple(self._status_to_domain(status) for status in statuses)

    def reconnect(self, name: str) -> McpServerStatus:
        runtime = self._require_runtime()
        cleaned = _validate_name(name)
        status = self._call(runtime.reconnect, cleaned)
        return self._status_to_domain(status)

    def logs(self, name: str, limit: int = 200) -> tuple[McpLogEntry, ...]:
        runtime = self._require_runtime()
        entries = self._call(runtime.logs, _validate_name(name), limit=limit)
        return tuple(
            McpLogEntry(
                server=entry.server,
                level=entry.level,
                message=entry.message,
                ts_ms=entry.ts_ms,
            )
            for entry in entries
        )

    def tools(self, name: str, *, refresh: bool = False) -> tuple[McpTool, ...]:
        runtime = self._require_runtime()
        entries = self._call(runtime.list_tools, _validate_name(name), refresh=refresh)
        return tuple(self._tool_to_domain(entry) for entry in entries)

    def list_resources(
        self, name: str, *, refresh: bool = False
    ) -> tuple[McpResource, ...]:
        runtime = self._require_runtime()
        entries = self._call(
            runtime.list_resources, _validate_name(name), refresh=refresh
        )
        return tuple(
            McpResource(
                uri=entry.uri,
                name=entry.name,
                description=entry.description,
                mime_type=entry.mime_type,
            )
            for entry in entries
        )

    def read_resource(self, name: str, uri: str) -> object:
        runtime = self._require_runtime()
        result = self._call(runtime.read_resource, _validate_name(name), uri)
        return _sanitize_result(result)

    def list_prompts(
        self, name: str, *, refresh: bool = False
    ) -> tuple[McpPrompt, ...]:
        runtime = self._require_runtime()
        entries = self._call(runtime.list_prompts, _validate_name(name), refresh=refresh)
        return tuple(
            McpPrompt(
                name=entry.name,
                description=entry.description,
                arguments=tuple(
                    McpPromptArgument(
                        name=argument.name,
                        description=argument.description,
                        required=argument.required,
                    )
                    for argument in entry.arguments
                ),
            )
            for entry in entries
        )

    def get_prompt(
        self, name: str, prompt: str, args: Mapping[str, str]
    ) -> object:
        runtime = self._require_runtime()
        result = self._call(
            runtime.get_prompt, _validate_name(name), prompt, dict(args)
        )
        return _sanitize_result(result)

    # -- internals ---------------------------------------------------------

    def _invoke_managed(
        self,
        candidates: tuple[McpServer, ...],
        tool_name: str,
        args: dict[str, object],
        approval: McpApprovalContext | None,
    ) -> McpInvocationResult:
        runtime = self._require_runtime()
        context = (
            None
            if approval is None
            else ApprovalContext(
                approved_tools=approval.approved_tools,
                approved_servers=approval.approved_servers,
                auto_approve=approval.auto_approve,
            )
        )
        last_error: str | None = None
        for item in candidates:
            try:
                result = runtime.call_tool(
                    item.name,
                    tool_name,
                    dict(args),
                    approval=context,
                )
                return McpInvocationResult(result=result.as_dict())
            except RuntimeToolNotFound:
                continue
            except RuntimeUnavailable as exc:
                last_error = str(exc)
                if len(candidates) == 1:
                    raise self._translate(exc, item.name, tool_name) from exc
            except (
                RuntimeApprovalRequired,
                RuntimeApprovalDenied,
                RuntimeCapabilityUnavailable,
                RuntimeServerNotFound,
                RuntimeTimeout,
                McpCancelled,
                McpProtocolError,
                McpRpcError,
            ) as exc:
                raise self._translate(exc, item.name, tool_name) from exc
        if last_error is not None:
            raise McpUnavailable(last_error)
        raise McpToolNotFound(f"MCP tool not found: {tool_name}")

    def _invoke_short_lived(
        self,
        candidates: tuple[McpServer, ...],
        tool_name: str,
        args: dict[str, object],
    ) -> McpInvocationResult:
        last_error: str | None = None
        for item in candidates:
            connection = self._connections(item.spec)
            try:
                connection.initialize()
                tools = connection.list_tools()
                if not any(entry.name == tool_name for entry in tools):
                    continue
                result = connection.call_tool(tool_name, dict(args))
                return McpInvocationResult(result=_sanitize_result(result))
            except McpUnavailable as exc:
                last_error = exc.message
            finally:
                connection.close()
        if last_error is not None:
            raise McpUnavailable(last_error)
        raise McpToolNotFound(f"MCP tool not found: {tool_name}")

    def _discover_managed(self, server: McpServer, refresh: bool) -> McpDiscovery:
        runtime = self._require_runtime()
        started = time.monotonic()
        if not server.enabled:
            return McpDiscovery(
                name=server.name, status="disabled", duration_ms=0
            )
        try:
            tools = runtime.list_tools(server.name, refresh=refresh)
            elapsed = int((time.monotonic() - started) * 1000)
            return McpDiscovery(
                name=server.name,
                status="connected",
                duration_ms=elapsed,
                tools=tuple(self._tool_to_domain(tool) for tool in tools),
            )
        except Exception as exc:
            elapsed = int((time.monotonic() - started) * 1000)
            return McpDiscovery(
                name=server.name,
                status="error",
                duration_ms=elapsed,
                error=self._error_text(exc),
            )

    def _candidates(self, server: str | None) -> tuple[McpServer, ...]:
        if server is not None:
            item = self._get(_validate_name(server))
            if not item.enabled:
                raise McpUnavailable(f"MCP server is disabled: {item.name}")
            return (item,)
        return tuple(item for item in self.list() if item.enabled)

    def _discover_one(self, server: McpServer) -> McpDiscovery:
        started = time.monotonic()
        connection: McpConnection = self._connections(server.spec)
        try:
            connection.initialize()
            tools = connection.list_tools()
            elapsed = int((time.monotonic() - started) * 1000)
            return McpDiscovery(
                name=server.name,
                status="connected",
                duration_ms=elapsed,
                tools=tools,
            )
        except McpUnavailable as exc:
            elapsed = int((time.monotonic() - started) * 1000)
            return McpDiscovery(
                name=server.name,
                status="error",
                duration_ms=elapsed,
                error=exc.message,
            )
        except Exception as exc:
            elapsed = int((time.monotonic() - started) * 1000)
            return McpDiscovery(
                name=server.name,
                status="error",
                duration_ms=elapsed,
                error=type(exc).__name__,
            )
        finally:
            connection.close()

    def _get(self, name: str) -> McpServer:
        row = self._db.query_one(
            "SELECT name, spec_json, enabled, auto_run, created_at, updated_at "
            "FROM mcp_servers WHERE name = ?",
            (name,),
        )
        if row is None:
            raise McpServerNotFound(f"MCP server not found: {name}")
        return self._row_to_server(row)

    def _require_runtime(self) -> McpConnectionManager:
        if self._runtime is None:
            raise McpUnavailable("persistent MCP runtime is disabled")
        return self._runtime

    @staticmethod
    def _tool_to_domain(tool: RuntimeTool) -> McpTool:
        annotations = tool.annotations
        return McpTool(
            name=tool.name,
            description=tool.description,
            input_schema=dict(tool.input_schema) if tool.input_schema else None,
            title=tool.title,
            output_schema=dict(tool.output_schema) if tool.output_schema else None,
            annotations=McpToolAnnotations(
                title=annotations.title,
                read_only=annotations.read_only,
                destructive=annotations.destructive,
                idempotent=annotations.idempotent,
                open_world=annotations.open_world,
            ),
        )

    @staticmethod
    def _status_to_domain(status: RuntimeServerStatus) -> McpServerStatus:
        return McpServerStatus(
            name=status.name,
            state=status.state,
            connected=status.connected,
            tool_count=status.tool_count,
            resource_count=status.resource_count,
            prompt_count=status.prompt_count,
            last_error=status.last_error,
            protocol_version=status.protocol_version,
            server_name=status.server_name,
            server_version=status.server_version,
            instructions=status.instructions,
            session_id=status.session_id,
            pid=status.pid,
            reconnect_attempts=status.reconnect_attempts,
            next_retry_in_ms=status.next_retry_in_ms,
            updated_at=status.updated_at,
        )

    @staticmethod
    def _translate(
        exc: Exception, server: str, tool: str
    ) -> Exception:
        if isinstance(exc, RuntimeApprovalRequired):
            decision = exc.decision
            return McpApprovalRequired(
                f"{server}/{tool}: {decision.reason}",
                details={
                    "server": server,
                    "tool": tool,
                    "risk": decision.risk,
                    "code": decision.code,
                    "reason": decision.reason,
                    "callId": uuid.uuid4().hex,
                },
            )
        if isinstance(exc, RuntimeApprovalDenied):
            decision = exc.decision
            return McpApprovalDenied(
                f"{server}/{tool}: {decision.reason}",
                details={
                    "server": server,
                    "tool": tool,
                    "risk": decision.risk,
                    "code": decision.code,
                    "reason": decision.reason,
                },
            )
        if isinstance(exc, RuntimeCapabilityUnavailable):
            return McpCapabilityUnavailable(str(exc))
        if isinstance(exc, RuntimeServerNotFound):
            return McpServerNotFound(str(exc))
        if isinstance(exc, RuntimeToolNotFound):
            return McpToolNotFound(str(exc))
        if isinstance(exc, RuntimeTimeout):
            return McpTimeout(str(exc))
        if isinstance(exc, McpCancelled):
            return McpUnavailable("MCP call was cancelled")
        if isinstance(exc, RuntimeUnavailable):
            return McpUnavailable(str(exc))
        return McpUnavailable("MCP request failed")

    @staticmethod
    def _error_text(exc: Exception) -> str:
        text = str(exc).strip().replace("\n", " ")
        return text[:300] or type(exc).__name__

    def _call(
        self, function: Callable[..., _T], *args: object, **kwargs: object
    ) -> _T:
        try:
            return function(*args, **kwargs)
        except Exception as exc:
            raise self._translate(exc, "", "") from exc

    @staticmethod
    def _row_to_server(row: sqlite3.Row) -> McpServer:
        return McpServer(
            name=str(row["name"]),
            spec=_spec_from_json(str(row["spec_json"])),
            enabled=bool(row["enabled"]),
            auto_run=bool(row["auto_run"]),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
        )


__all__ = ["McpConnection", "SqliteMcpRegistry"]
