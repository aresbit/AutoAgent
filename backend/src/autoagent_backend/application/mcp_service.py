"""MCP application service: CRUD, discovery, invocation, status and consent.

Connection details stay in the adapter. This service owns the process-local
consent table (never persisted), turns policy failures into domain errors with
UI-safe details, and publishes the `mcp.*` invalidation events.
"""

from __future__ import annotations

import threading
from collections.abc import Mapping, Sequence

from ..domain.errors import (
    InvalidInput,
    McpApprovalDenied,
    McpApprovalRequired,
)
from ..domain.models import (
    McpApprovalContext,
    McpDiscovery,
    McpInvocationResult,
    McpLogEntry,
    McpPrompt,
    McpResource,
    McpServer,
    McpServerSpec,
    McpServerStatus,
    McpTool,
)
from ..domain.ports import McpRegistryPort
from .event_bus import EventBus


class McpService:
    def __init__(
        self, registry: McpRegistryPort, *, events: EventBus | None = None
    ) -> None:
        self._registry = registry
        self._events = events
        self._lock = threading.RLock()
        self._allowed_tools: set[tuple[str, str]] = set()
        self._denied_tools: set[tuple[str, str]] = set()
        self._allowed_servers: set[str] = set()
        self._denied_servers: set[str] = set()
        self._once_tools: set[tuple[str, str]] = set()

    # -- registry CRUD -----------------------------------------------------

    def list(self) -> Sequence[McpServer]:
        return self._registry.list()

    def upsert(
        self,
        name: str,
        spec: McpServerSpec,
        *,
        enabled: bool = True,
        auto_run: bool = False,
    ) -> McpServer:
        server = self._registry.upsert(
            name, spec, enabled=enabled, auto_run=auto_run
        )
        self._publish({"type": "mcp.server_changed", "server": server.name})
        return server

    def remove(self, name: str) -> None:
        self._registry.remove(name)
        with self._lock:
            self._forget(name)
        self._publish({"type": "mcp.server_changed", "server": name})

    def enable(self, name: str) -> McpServer:
        server = self._registry.set_enabled(name, True)
        self._publish({"type": "mcp.server_changed", "server": server.name})
        return server

    def disable(self, name: str) -> McpServer:
        server = self._registry.set_enabled(name, False)
        self._publish({"type": "mcp.server_changed", "server": server.name})
        return server

    # -- discovery and invocation -----------------------------------------

    def discover(
        self,
        name: str | None = None,
        enabled_only: bool = True,
        *,
        refresh: bool = False,
    ) -> Sequence[McpDiscovery]:
        return self._registry.discover(name, enabled_only, refresh=refresh)

    def invoke(
        self,
        server: str | None,
        tool: str,
        args: dict[str, object],
        *,
        approval: McpApprovalContext | None = None,
    ) -> McpInvocationResult:
        context = self._approval_context(server, tool, approval)
        self._assert_not_denied(server, tool)
        try:
            return self._registry.invoke(server, tool, args, approval=context)
        except McpApprovalRequired as exc:
            self._publish(
                {"type": "mcp.approval_required", "approval": dict(exc.details)}
            )
            raise
        except McpApprovalDenied as exc:
            self._publish(
                {"type": "mcp.approval_denied", "approval": dict(exc.details)}
            )
            raise

    # -- status and capabilities ------------------------------------------

    def status(self, name: str | None = None) -> Sequence[McpServerStatus]:
        return self._registry.status(name)

    def reconnect(self, name: str) -> McpServerStatus:
        return self._registry.reconnect(name)

    def logs(self, name: str, limit: int = 200) -> Sequence[McpLogEntry]:
        return self._registry.logs(name, limit)

    def tools(self, name: str, *, refresh: bool = False) -> Sequence[McpTool]:
        return self._registry.tools(name, refresh=refresh)

    def list_resources(
        self, name: str, *, refresh: bool = False
    ) -> Sequence[McpResource]:
        return self._registry.list_resources(name, refresh=refresh)

    def read_resource(self, name: str, uri: str) -> object:
        return self._registry.read_resource(name, uri)

    def list_prompts(
        self, name: str, *, refresh: bool = False
    ) -> Sequence[McpPrompt]:
        return self._registry.list_prompts(name, refresh=refresh)

    def get_prompt(
        self, name: str, prompt: str, args: Mapping[str, str]
    ) -> object:
        return self._registry.get_prompt(name, prompt, args)

    # -- consent -----------------------------------------------------------

    def decide(
        self,
        server: str,
        tool: str,
        decision: str,
        scope: str = "once",
    ) -> bool:
        """Record a user decision; ``once`` applies to the next invocation."""

        if decision not in {"allow", "deny"}:
            raise InvalidInput("decision must be 'allow' or 'deny'")
        if scope not in {"once", "session"}:
            raise InvalidInput("scope must be 'once' or 'session'")
        key = (server, tool)
        with self._lock:
            if decision == "allow":
                self._denied_tools.discard(key)
                if scope == "session":
                    self._allowed_tools.add(key)
                    self._allowed_servers.add(server)
                else:
                    self._once_tools.add(key)
            else:
                self._allowed_tools.discard(key)
                self._once_tools.discard(key)
                # Both scopes block the immediate retry; only session persists.
                self._denied_tools.add(key)
        return True

    # -- internals ---------------------------------------------------------

    def _approval_context(
        self,
        server: str | None,
        tool: str,
        approval: McpApprovalContext | None,
    ) -> McpApprovalContext | None:
        approved_tools = set(approval.approved_tools if approval else ())
        approved_servers = set(approval.approved_servers if approval else ())
        auto_approve = bool(approval.auto_approve) if approval else False
        with self._lock:
            if server is not None:
                if (server, tool) in self._once_tools:
                    self._once_tools.discard((server, tool))
                    approved_tools.add(tool)
                    approved_servers.add(server)
                if (server, tool) in self._allowed_tools:
                    approved_tools.add(tool)
                    approved_servers.add(server)
                if server in self._allowed_servers:
                    approved_servers.add(server)
        if not approved_tools and not approved_servers and not auto_approve:
            return approval
        return McpApprovalContext(
            approved_tools=frozenset(approved_tools),
            approved_servers=frozenset(approved_servers),
            auto_approve=auto_approve,
        )

    def _assert_not_denied(self, server: str | None, tool: str) -> None:
        if server is None:
            return
        with self._lock:
            denied = (server, tool) in self._denied_tools or (
                server in self._denied_servers
            )
        if denied:
            raise McpApprovalDenied(
                f"{server}/{tool}: the user denied this tool for the session.",
                details={
                    "server": server,
                    "tool": tool,
                    "code": "user_denied",
                },
            )

    def _forget(self, server: str) -> None:
        self._allowed_tools = {
            key for key in self._allowed_tools if key[0] != server
        }
        self._denied_tools = {
            key for key in self._denied_tools if key[0] != server
        }
        self._once_tools = {
            key for key in self._once_tools if key[0] != server
        }
        self._allowed_servers.discard(server)
        self._denied_servers.discard(server)

    def _publish(self, payload: dict[str, object]) -> None:
        if self._events is not None:
            try:
                self._events.publish(payload)
            except Exception:
                # Advisory invalidation must never fail the request.
                pass


__all__ = ["McpService"]
