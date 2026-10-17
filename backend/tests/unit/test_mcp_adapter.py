"""Unit tests for the SQLite MCP registry and transport selection."""

from __future__ import annotations

from pathlib import Path

import pytest

from autoagent_backend.adapters.mcp.client import (
    DefaultMcpConnectionFactory,
    HttpMcpConnection,
    StdioMcpConnection,
)
from autoagent_backend.adapters.mcp.mcp_store import SqliteMcpRegistry
from autoagent_backend.adapters.persistence.migrations import migrate
from autoagent_backend.adapters.persistence.sqlite import SqliteDatabase
from autoagent_backend.domain.errors import (
    InvalidInput,
    McpServerNotFound,
    McpToolNotFound,
)
from autoagent_backend.domain.models import McpServerSpec

from ..fixtures.panels import FakeMcpFactory, FixedClock


def _registry(tmp_path: Path, factory: FakeMcpFactory) -> SqliteMcpRegistry:
    db = SqliteDatabase(tmp_path / "registry.db")
    migrate(db, now_ms=1)
    return SqliteMcpRegistry(db, FixedClock(), connections=factory)


def test_upsert_persists_across_instances(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    first = _registry(tmp_path, factory)
    spec = McpServerSpec(
        transport="stdio",
        command="fake",
        args=("--x",),
        env={"KEY": "value"},
    )
    created = first.upsert("echo", spec, auto_run=True)
    assert created.name == "echo"
    assert created.auto_run is True

    second = SqliteMcpRegistry(
        SqliteDatabase(tmp_path / "registry.db"), FixedClock(), connections=factory
    )
    listed = second.list()
    assert len(listed) == 1
    assert listed[0].spec.args == ("--x",)
    assert listed[0].spec.env == {"KEY": "value"}

    disabled = second.set_enabled("echo", False)
    assert disabled.enabled is False
    second.remove("echo")
    assert second.list() == ()
    with pytest.raises(McpServerNotFound):
        second.set_enabled("echo", True)


def test_discover_reports_failures_per_server(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    registry = _registry(tmp_path, factory)
    registry.upsert("good", McpServerSpec(transport="stdio", command="fake"))
    registry.upsert("bad", McpServerSpec(transport="stdio", command="broken"))

    results = registry.discover()
    by_name = {item.name: item for item in results}
    assert by_name["good"].status == "connected"
    assert by_name["good"].tools[0].name == "echo"
    assert by_name["bad"].status == "error"
    assert by_name["bad"].error == "fake MCP transport failed"
    assert all(connection.closed for connection in factory.connections)


def test_invoke_and_tool_not_found(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    registry = _registry(tmp_path, factory)
    registry.upsert("echo", McpServerSpec(transport="stdio", command="fake"))

    result = registry.invoke("echo", "echo", {"text": "hi"})
    assert isinstance(result.result, dict)
    assert factory.connections[-1].closed is True

    with pytest.raises(McpToolNotFound):
        registry.invoke("echo", "absent", {})


def test_spec_validation_and_name_validation(tmp_path: Path) -> None:
    registry = _registry(tmp_path, FakeMcpFactory())
    with pytest.raises(ValueError):
        McpServerSpec(transport="stdio", command="")
    with pytest.raises(InvalidInput):
        registry.upsert("../escape", McpServerSpec(transport="stdio", command="x"))


def test_default_factory_selects_transport() -> None:
    factory = DefaultMcpConnectionFactory()
    stdio = factory(McpServerSpec(transport="stdio", command="fake"))
    http = factory(McpServerSpec(transport="http", url="http://127.0.0.1:9/mcp"))
    assert isinstance(stdio, StdioMcpConnection)
    assert isinstance(http, HttpMcpConnection)
    stdio.close()
    http.close()
