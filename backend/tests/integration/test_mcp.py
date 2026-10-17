"""M5: MCP registry routes, discovery and invocation (fake transport only)."""

from __future__ import annotations

from pathlib import Path

from ..fixtures.panels import AUTH, FakeMcpFactory, panel_client


def _stdio_server(
    name: str = "echo",
    *,
    command: str = "fake-mcp",
    enabled: bool = True,
) -> dict[str, object]:
    return {
        "name": name,
        "transport": "stdio",
        "command": command,
        "args": ["--serve"],
        "env": {"SECRET_TOKEN": "secret-value"},
        "enabled": enabled,
        "autoRun": True,
    }


def test_upsert_list_and_secret_hiding(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        created = client.put(
            "/api/mcp/servers/echo", headers=AUTH, json=_stdio_server()
        )
        assert created.status_code == 200, created.text
        assert created.json() == {
            "id": "echo",
            "name": "echo",
            "transport": "stdio",
            "target": "fake-mcp --serve",
            "enabled": True,
            "autoRun": True,
            "toolCount": None,
        }
        # Env values are domain input, never response data.
        assert "SECRET_TOKEN" not in created.text
        assert "secret-value" not in created.text

        listed = client.get("/api/mcp/servers", headers=AUTH)
        assert listed.status_code == 200
        assert [item["name"] for item in listed.json()["servers"]] == ["echo"]


def test_enable_disable_and_delete(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        client.put(
            "/api/mcp/servers/echo", headers=AUTH, json=_stdio_server()
        )

        disabled = client.post("/api/mcp/servers/echo/disable", headers=AUTH)
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False

        enabled = client.post("/api/mcp/servers/echo/enable", headers=AUTH)
        assert enabled.status_code == 200
        assert enabled.json()["enabled"] is True

        removed = client.delete("/api/mcp/servers/echo", headers=AUTH)
        assert removed.status_code == 200
        assert removed.json() == {"deleted": True}

        missing = client.delete("/api/mcp/servers/echo", headers=AUTH)
        assert missing.status_code == 404
        assert missing.json()["code"] == "MCP_SERVER_NOT_FOUND"


def test_discover_uses_the_injected_transport(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        client.put(
            "/api/mcp/servers/echo", headers=AUTH, json=_stdio_server()
        )
        response = client.post(
            "/api/mcp/discover", headers=AUTH, json={"name": "echo"}
        )

    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["status"] == "connected"
    assert result["error"] is None
    assert result["tools"][0]["name"] == "echo"
    assert result["tools"][0]["inputSchema"]["type"] == "object"
    assert result["durationMs"] >= 0
    assert factory.connections and all(item.closed for item in factory.connections)


def test_discover_reports_per_server_failure(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        client.put(
            "/api/mcp/servers/broken",
            headers=AUTH,
            json=_stdio_server("broken", command="broken"),
        )
        response = client.post(
            "/api/mcp/discover", headers=AUTH, json={"name": "broken"}
        )

    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["status"] == "error"
    assert result["tools"] == []
    assert result["error"] == "fake MCP transport failed"


def test_invoke_returns_sanitized_result(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        client.put(
            "/api/mcp/servers/echo", headers=AUTH, json=_stdio_server()
        )
        response = client.post(
            "/api/tools/invoke",
            headers=AUTH,
            json={"server": "echo", "tool": "echo", "args": {"text": "hi"}},
        )

    assert response.status_code == 200, response.text
    text = response.json()["result"]["content"][0]["text"]
    assert text.startswith("echo:")
    assert factory.connections[-1].closed is True


def test_invoke_unknown_tool_is_404(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        client.put(
            "/api/mcp/servers/echo", headers=AUTH, json=_stdio_server()
        )
        response = client.post(
            "/api/tools/invoke",
            headers=AUTH,
            json={"server": "echo", "tool": "nope", "args": {}},
        )

    assert response.status_code == 404
    assert response.json()["code"] == "MCP_TOOL_NOT_FOUND"


def test_disabled_server_cannot_be_invoked(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        client.put(
            "/api/mcp/servers/echo",
            headers=AUTH,
            json=_stdio_server(enabled=False),
        )
        response = client.post(
            "/api/tools/invoke",
            headers=AUTH,
            json={"server": "echo", "tool": "echo", "args": {}},
        )

    assert response.status_code == 502
    assert response.json()["code"] == "MCP_UNAVAILABLE"


def test_mcp_requires_auth_and_validates_input(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        assert client.get("/api/mcp/servers").status_code == 401

        mismatch = client.put(
            "/api/mcp/servers/echo",
            headers=AUTH,
            json={**_stdio_server(), "name": "other"},
        )
        assert mismatch.status_code == 400
        assert mismatch.json()["code"] == "INVALID_INPUT"

        no_command = client.put(
            "/api/mcp/servers/echo",
            headers=AUTH,
            json={
                "name": "echo",
                "transport": "stdio",
                "command": "",
            },
        )
        assert no_command.status_code == 400
        assert no_command.json()["code"] == "INVALID_INPUT"

        bad_transport = client.put(
            "/api/mcp/servers/echo",
            headers=AUTH,
            json={"name": "echo", "transport": "carrier-pigeon"},
        )
        assert bad_transport.status_code == 422

        unknown = client.post(
            "/api/mcp/discover", headers=AUTH, json={"name": "absent"}
        )
        assert unknown.status_code == 404
        assert unknown.json()["code"] == "MCP_SERVER_NOT_FOUND"
