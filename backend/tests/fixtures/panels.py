"""Shared fixtures for the M5 panel tests."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi.testclient import TestClient

from autoagent_backend.adapters.mcp.client import McpConnectionFactory
from autoagent_backend.app import create_app
from autoagent_backend.composition import Container, build_container
from autoagent_backend.config import BootConfig, config_from_env
from autoagent_backend.domain.errors import McpUnavailable
from autoagent_backend.domain.models import McpServerSpec, McpTool, SettingsPatch
from autoagent_backend.domain.ports import ClockPort

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@contextmanager
def panel_client(
    tmp_path: Path,
    *,
    cwd: Path | None = None,
    home: Path | None = None,
    connections: McpConnectionFactory | None = None,
) -> Iterator[tuple[TestClient, Container, BootConfig]]:
    """Build a container with test-owned skill home and MCP connections."""

    config = config_from_env(data_dir=tmp_path / "data", port=8787)
    container = build_container(
        config,
        home_dir=home or (tmp_path / "home"),
        mcp_connections=connections,
    )
    if cwd is not None:
        container.settings_store.update(SettingsPatch(cwd=str(cwd)))
    app = create_app(config, container=container)
    with TestClient(app) as client:
        yield client, container, config


class FakeMcpConnection:
    def __init__(
        self,
        tools: tuple[McpTool, ...],
        *,
        fail: bool = False,
        result: object | None = None,
    ) -> None:
        self._tools = tools
        self._fail = fail
        self._result = result
        self.closed = False
        self.initialized = False

    def initialize(self) -> None:
        if self._fail:
            raise McpUnavailable("fake MCP transport failed")
        self.initialized = True

    def list_tools(self) -> tuple[McpTool, ...]:
        return self._tools

    def call_tool(self, name: str, arguments: dict[str, object]) -> object:
        if self._result is not None:
            return self._result
        return {"content": [{"type": "text", "text": f"{name}:{arguments}"}]}

    def close(self) -> None:
        self.closed = True


class FakeMcpFactory:
    """Deterministic transport factory; never touches the network."""

    def __init__(self, *, tools: tuple[McpTool, ...] | None = None) -> None:
        self.tools = tools or (
            McpTool(
                name="echo",
                description="Echo input",
                input_schema={"type": "object", "properties": {"text": {"type": "string"}}},
            ),
        )
        self.connections: list[FakeMcpConnection] = []

    def __call__(self, spec: McpServerSpec) -> FakeMcpConnection:
        fail = spec.command == "broken" or (spec.url or "").endswith("/broken")
        connection = FakeMcpConnection(self.tools, fail=fail)
        self.connections.append(connection)
        return connection


class FixedClock(ClockPort):
    def __init__(self, value: int = 1_700_000_000_000) -> None:
        self.value = value

    def now_ms(self) -> int:
        self.value += 1
        return self.value
