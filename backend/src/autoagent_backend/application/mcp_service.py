"""MCP registry application service.

CRUD and network/protocol work are adapter concerns; this service exposes the
use cases without leaking a transport object.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..domain.models import (
    McpDiscovery,
    McpInvocationResult,
    McpServer,
    McpServerSpec,
)
from ..domain.ports import McpRegistryPort


class McpService:
    def __init__(self, registry: McpRegistryPort) -> None:
        self._registry = registry

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
        return self._registry.upsert(
            name, spec, enabled=enabled, auto_run=auto_run
        )

    def remove(self, name: str) -> None:
        self._registry.remove(name)

    def enable(self, name: str) -> McpServer:
        return self._registry.set_enabled(name, True)

    def disable(self, name: str) -> McpServer:
        return self._registry.set_enabled(name, False)

    def discover(
        self, name: str | None = None, enabled_only: bool = True
    ) -> Sequence[McpDiscovery]:
        return self._registry.discover(name, enabled_only)

    def invoke(
        self, server: str | None, tool: str, args: dict[str, object]
    ) -> McpInvocationResult:
        return self._registry.invoke(server, tool, args)
