"""Persistent MCP runtime over the real HTTP surface.

A real stdio child speaks JSON-RPC; the test proves one child survives repeated
invokes, status/logs/resources/prompts work, and the approval flow returns 403
and succeeds after consent.
"""

from __future__ import annotations

import os
import signal
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.app import create_app
from autoagent_backend.config import config_from_env

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

SERVER_SOURCE = r'''
import json
import sys

TOOLS = [
    {
        "name": "echo",
        "title": "Echo",
        "description": "Echo the input",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "destroy",
        "title": "Destroy",
        "description": "A destructive action",
        "inputSchema": {"type": "object"},
        "annotations": {"destructiveHint": True},
    },
]


def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        continue
    if method == "initialize":
        result = {
            "protocolVersion": "2025-06-18",
            "capabilities": {
                "tools": {"listChanged": False},
                "resources": {},
                "prompts": {},
            },
            "serverInfo": {"name": "fake-mcp", "version": "1.0.0"},
        }
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = request.get("params", {})
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if name == "echo":
            text = "echo:" + str(arguments.get("text", ""))
        elif name == "destroy":
            text = "destroyed"
        else:
            send({"jsonrpc": "2.0", "id": request_id,
                  "error": {"code": -32602, "message": "unknown tool"}})
            continue
        result = {"content": [{"type": "text", "text": text}], "isError": False}
    elif method == "resources/list":
        result = {"resources": [
            {"uri": "test://doc", "name": "doc", "mimeType": "text/plain"}
        ]}
    elif method == "resources/read":
        result = {"contents": [
            {"uri": "test://doc", "mimeType": "text/plain", "text": "hello resource"}
        ]}
    elif method == "prompts/list":
        result = {"prompts": [
            {"name": "greet", "description": "Greeting",
             "arguments": [{"name": "who", "required": True}]}
        ]}
    elif method == "prompts/get":
        params = request.get("params", {})
        who = (params.get("arguments") or {}).get("who", "world")
        result = {
            "description": "Greeting",
            "messages": [
                {"role": "user",
                 "content": {"type": "text", "text": "hi " + str(who)}}
            ],
        }
    else:
        send({"jsonrpc": "2.0", "id": request_id,
              "error": {"code": -32601, "message": "method not found"}})
        continue
    send({"jsonrpc": "2.0", "id": request_id, "result": result})
'''


@pytest.fixture
def runtime_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    server = tmp_path / "fake_mcp.py"
    server.write_text(SERVER_SOURCE, encoding="utf-8")
    monkeypatch.setenv("AUTOAGENT_MCP_PERSISTENT", "1")
    monkeypatch.setenv("AUTOAGENT_MCP_HEALTH_INTERVAL_S", "5")
    monkeypatch.setenv("AUTOAGENT_DEFAULT_CWD", str(tmp_path))
    config = config_from_env(data_dir=tmp_path / "data", port=8787)
    app = create_app(config)
    with TestClient(app) as client:
        client.headers.update(AUTH)
        client.fake_server = server  # type: ignore[attr-defined]
        yield client


def _add(client: TestClient) -> None:
    server = client.fake_server  # type: ignore[attr-defined]
    response = client.put(
        "/api/mcp/servers/fake",
        json={
            "name": "fake",
            "transport": "stdio",
            "command": sys.executable,
            "args": [str(server)],
        },
    )
    assert response.status_code == 200, response.text


def test_persistent_session_status_and_calls(runtime_client: TestClient) -> None:
    client = runtime_client
    _add(client)

    discovered = client.post("/api/mcp/discover", json={"name": "fake"})
    assert discovered.status_code == 200, discovered.text
    result = discovered.json()["results"][0]
    assert result["status"] == "connected", result
    assert {tool["name"] for tool in result["tools"]} == {"echo", "destroy"}
    echo = next(tool for tool in result["tools"] if tool["name"] == "echo")
    assert echo["annotations"]["readOnlyHint"] is True

    status = client.get("/api/mcp/servers/fake/status")
    assert status.status_code == 200, status.text
    first = status.json()
    assert first["state"] == "connected"
    assert first["toolCount"] == 2
    assert first["pid"]

    # Read-only tools run without consent.
    first_call = client.post(
        "/api/tools/invoke",
        json={"server": "fake", "tool": "echo", "args": {"text": "one"}},
    )
    assert first_call.status_code == 200, first_call.text
    assert "echo:one" in str(first_call.json()["result"])

    second_call = client.post(
        "/api/tools/invoke",
        json={"server": "fake", "tool": "echo", "args": {"text": "two"}},
    )
    assert second_call.status_code == 200, second_call.text

    # One persistent child serves both calls.
    again = client.get("/api/mcp/servers/fake/status").json()
    assert again["pid"] == first["pid"]
    assert again["toolCount"] == 2

    logs = client.get("/api/mcp/servers/fake/logs")
    assert logs.status_code == 200
    assert logs.json()["entries"]

    resources = client.get("/api/mcp/servers/fake/resources")
    assert resources.status_code == 200
    assert resources.json()["resources"][0]["uri"] == "test://doc"
    read = client.post(
        "/api/mcp/servers/fake/resources/read", json={"uri": "test://doc"}
    )
    assert read.status_code == 200
    assert "hello resource" in str(read.json()["result"])

    prompts = client.get("/api/mcp/servers/fake/prompts")
    assert prompts.status_code == 200
    assert prompts.json()["prompts"][0]["name"] == "greet"
    prompt = client.post(
        "/api/mcp/servers/fake/prompts/get",
        json={"name": "greet", "args": {"who": "tars"}},
    )
    assert prompt.status_code == 200
    assert "hi tars" in str(prompt.json()["result"])


def test_approval_flow_and_events(runtime_client: TestClient) -> None:
    client = runtime_client
    _add(client)
    client.post("/api/mcp/discover", json={"name": "fake"})

    container = client.app.state.container
    subscription = container.event_bus.subscribe()
    try:
        denied = client.post(
            "/api/tools/invoke",
            json={"server": "fake", "tool": "destroy", "args": {}},
        )
        assert denied.status_code == 403, denied.text
        payload = denied.json()
        assert payload["code"] == "MCP_APPROVAL_REQUIRED"
        assert payload["details"]["server"] == "fake"
        assert payload["details"]["tool"] == "destroy"
        assert payload["details"]["risk"] == "destructive"

        events = []
        while True:
            event = subscription.next(0.2)
            if event is None:
                break
            events.append(event)
        assert any(event.get("type") == "mcp.approval_required" for event in events)

        decision = client.post(
            "/api/mcp/approvals",
            json={
                "server": "fake",
                "tool": "destroy",
                "decision": "allow",
                "scope": "once",
            },
        )
        assert decision.status_code == 200, decision.text
        assert decision.json()["ok"] is True

        allowed = client.post(
            "/api/tools/invoke",
            json={"server": "fake", "tool": "destroy", "args": {}},
        )
        assert allowed.status_code == 200, allowed.text
        assert "destroyed" in str(allowed.json()["result"])

        # A one-off consent is consumed; the next call asks again.
        again = client.post(
            "/api/tools/invoke",
            json={"server": "fake", "tool": "destroy", "args": {}},
        )
        assert again.status_code == 403

        session = client.post(
            "/api/mcp/approvals",
            json={
                "server": "fake",
                "tool": "destroy",
                "decision": "allow",
                "scope": "session",
            },
        )
        assert session.status_code == 200
        repeated = client.post(
            "/api/tools/invoke",
            json={"server": "fake", "tool": "destroy", "args": {}},
        )
        assert repeated.status_code == 200
    finally:
        container.event_bus.unsubscribe(subscription)


def test_killed_child_reconnects(runtime_client: TestClient) -> None:
    client = runtime_client
    _add(client)
    client.post("/api/mcp/discover", json={"name": "fake"})
    first = client.get("/api/mcp/servers/fake/status").json()
    assert first["pid"]

    os.kill(int(first["pid"]), signal.SIGKILL)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.kill(int(first["pid"]), 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)

    # The next call reconnects instead of failing permanently.
    recovered = client.post(
        "/api/tools/invoke",
        json={"server": "fake", "tool": "echo", "args": {"text": "back"}},
    )
    assert recovered.status_code == 200, recovered.text
    second = client.get("/api/mcp/servers/fake/status").json()
    assert second["pid"] != first["pid"]
    assert second["state"] == "connected"


def test_child_is_gone_after_shutdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = tmp_path / "fake_mcp.py"
    server.write_text(SERVER_SOURCE, encoding="utf-8")
    monkeypatch.setenv("AUTOAGENT_MCP_PERSISTENT", "1")
    monkeypatch.setenv("AUTOAGENT_DEFAULT_CWD", str(tmp_path))
    config = config_from_env(data_dir=tmp_path / "data", port=8787)
    app = create_app(config)
    pid = 0
    with TestClient(app) as client:
        client.headers.update(AUTH)
        client.fake_server = server  # type: ignore[attr-defined]
        _add(client)
        client.post("/api/mcp/discover", json={"name": "fake"})
        pid = int(client.get("/api/mcp/servers/fake/status").json()["pid"])
        assert pid > 0

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    pytest.fail("MCP child survived container shutdown")


def test_reconnect_and_disable(runtime_client: TestClient) -> None:
    client = runtime_client
    _add(client)
    client.post("/api/mcp/discover", json={"name": "fake"})

    reconnected = client.post("/api/mcp/servers/fake/reconnect")
    assert reconnected.status_code == 200, reconnected.text
    assert reconnected.json()["state"] == "connected"

    disabled = client.post("/api/mcp/servers/fake/disable")
    assert disabled.status_code == 200
    assert client.get("/api/mcp/servers/fake/status").json()["state"] == "disabled"

    rejected = client.post(
        "/api/tools/invoke",
        json={"server": "fake", "tool": "echo", "args": {}},
    )
    assert rejected.status_code == 502
