"""SQLite MCP registry with connection-scoped discovery and invocation."""

from __future__ import annotations

import json
import sqlite3
import time

from ...domain.errors import (
    InvalidInput,
    McpServerNotFound,
    McpToolNotFound,
    McpUnavailable,
)
from ...domain.models import (
    McpDiscovery,
    McpInvocationResult,
    McpServer,
    McpServerSpec,
)
from ...domain.ports import ClockPort
from ..persistence.sqlite import SqliteDatabase
from .client import DefaultMcpConnectionFactory, McpConnection, McpConnectionFactory


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

    CRUD is persisted in ``mcp_servers``. Discovery/invocation always uses a
    fresh connection and closes it in ``finally``; a failed server is reported
    per-server rather than aborting a bulk discovery.
    """

    def __init__(
        self,
        db: SqliteDatabase,
        clock: ClockPort,
        *,
        connections: McpConnectionFactory | None = None,
    ) -> None:
        self._db = db
        self._clock = clock
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
        return self._row_to_server(row)

    def remove(self, name: str) -> None:
        cleaned = _validate_name(name)
        deleted = self._db.execute(
            "DELETE FROM mcp_servers WHERE name = ?", (cleaned,)
        )
        if deleted == 0:
            raise McpServerNotFound(f"MCP server not found: {cleaned}")

    def set_enabled(self, name: str, enabled: bool) -> McpServer:
        cleaned = _validate_name(name)
        changed = self._db.execute(
            "UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE name = ?",
            (1 if enabled else 0, self._clock.now_ms(), cleaned),
        )
        if changed == 0:
            raise McpServerNotFound(f"MCP server not found: {cleaned}")
        return self._get(cleaned)

    def get(self, name: str) -> McpServer:
        """Return one server; not part of the port but useful to services/tests."""

        return self._get(_validate_name(name))

    # -- connections -------------------------------------------------------

    def discover(
        self, name: str | None = None, enabled_only: bool = True
    ) -> tuple[McpDiscovery, ...]:
        if name is not None:
            servers: tuple[McpServer, ...] = (
                self._get(_validate_name(name)),
            )
        else:
            servers = tuple(
                server for server in self.list() if server.enabled or not enabled_only
            )
        return tuple(self._discover_one(server) for server in servers)

    def invoke(
        self, server: str | None, tool: str, args: dict[str, object]
    ) -> McpInvocationResult:
        tool_name = tool.strip()
        if not tool_name:
            raise InvalidInput("tool name is required")
        candidates = self._candidates(server)
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

    # -- internals ---------------------------------------------------------

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
