"""M5.2: artifact capabilities, host-mediated tool calls and version diff."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.application.artifact_materializer import (
    materialize_artifacts,
)

from ..fixtures.panels import AUTH, TOKEN, FakeMcpFactory, panel_client

AUDIT_LOGGER = "autoagent.artifacts.audit"


def _create(
    client: TestClient, title: str = "Demo Art", html: str = "<h1>Hi</h1>"
) -> dict[str, object]:
    response = client.post(
        "/api/artifacts",
        headers=AUTH,
        json={"title": title, "description": "demo", "html": html},
    )
    assert response.status_code == 200, response.text
    payload: dict[str, object] = response.json()
    return payload


def _register_echo(client: TestClient) -> None:
    response = client.put(
        "/api/mcp/servers/echo",
        headers=AUTH,
        json={
            "name": "echo",
            "transport": "stdio",
            "command": "fake-mcp",
            "args": [],
            "enabled": True,
            "autoRun": True,
        },
    )
    assert response.status_code == 200, response.text


def _allow(
    client: TestClient, artifact_id: str, tools: list[str]
) -> dict[str, object]:
    response = client.put(
        f"/api/artifacts/{artifact_id}/capabilities",
        headers=AUTH,
        json={"mcpTools": tools},
    )
    assert response.status_code == 200, response.text
    payload: dict[str, object] = response.json()
    return payload


def _call(
    client: TestClient,
    artifact_id: str,
    *,
    name: str = "echo",
    arguments: dict[str, object] | None = None,
    consent: bool = True,
    request_id: str | None = "req-1",
) -> Any:
    body: dict[str, object] = {
        "name": name,
        "arguments": arguments if arguments is not None else {"text": "hi"},
        "consent": consent,
    }
    if request_id is not None:
        body["requestId"] = request_id
    return client.post(
        f"/api/artifacts/{artifact_id}/tools/call",
        headers=AUTH,
        json=body,
    )


def test_capabilities_update_validates_dedupes_and_persists(
    tmp_path: Path,
) -> None:
    with panel_client(tmp_path) as (client, container, _):
        created = _create(client)
        artifact_id = str(created["id"])
        assert created["mcpTools"] == []
        assert created["allowExternal"] is False

        updated = _allow(client, artifact_id, ["echo", "echo", "search"])
        assert updated["mcpTools"] == ["echo", "search"]

        fetched = client.get(f"/api/artifacts/{artifact_id}", headers=AUTH)
        assert fetched.status_code == 200
        assert fetched.json()["mcpTools"] == ["echo", "search"]

        assert container.artifact_store.get(artifact_id).mcp_tools == (
            "echo",
            "search",
        )

        missing = client.put(
            "/api/artifacts/nope/capabilities",
            headers=AUTH,
            json={"mcpTools": []},
        )
        assert missing.status_code == 404
        assert missing.json()["code"] == "ARTIFACT_NOT_FOUND"

        invalid = client.put(
            f"/api/artifacts/{artifact_id}/capabilities",
            headers=AUTH,
            json={"mcpTools": ["bad name"]},
        )
        assert invalid.status_code == 400
        assert invalid.json()["code"] == "INVALID_INPUT"

        assert (
            client.put(
                f"/api/artifacts/{artifact_id}/capabilities",
                json={"mcpTools": []},
            ).status_code
            == 401
        )


def test_capabilities_audit_log(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    with (
        caplog.at_level(logging.INFO, logger=AUDIT_LOGGER),
        panel_client(tmp_path) as (client, _, _),
    ):
        created = _create(client)
        _allow(client, str(created["id"]), ["echo"])

    assert "capabilities artifact=demo-art outcome=ok tools=1" in caplog.text


def test_tool_call_allowlist_and_consent_denials(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        _register_echo(client)
        created = _create(client)
        artifact_id = str(created["id"])
        _allow(client, artifact_id, ["echo"])

        denied = _call(client, artifact_id, name="search")
        assert denied.status_code == 403
        assert denied.json()["code"] == "TOOL_NOT_ALLOWED"

        consent = _call(client, artifact_id, consent=False)
        assert consent.status_code == 403
        assert consent.json()["code"] == "CONSENT_REQUIRED"

        assert factory.connections == []


def test_tool_call_success_is_sanitized_and_audited(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    factory = FakeMcpFactory()
    with (
        caplog.at_level(logging.INFO, logger=AUDIT_LOGGER),
        panel_client(tmp_path, connections=factory) as (client, _, _),
    ):
        _register_echo(client)
        created = _create(client)
        artifact_id = str(created["id"])
        _allow(client, artifact_id, ["echo"])

        response = _call(
            client,
            artifact_id,
            arguments={"text": "hi", "secret": "super-secret-value"},
            request_id="req-abc",
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert isinstance(payload["content"], list)
    assert payload["content"][0]["text"].startswith("echo:")
    assert payload["structuredContent"] is None
    assert payload["isError"] is False
    assert TOKEN not in response.text

    assert "artifact=demo-art" in caplog.text
    assert "tool=echo" in caplog.text
    assert "outcome=ok" in caplog.text
    assert "request_id=req-abc" in caplog.text
    # Arguments are never written to the audit log.
    assert "super-secret-value" not in caplog.text
    assert factory.connections and all(item.closed for item in factory.connections)


def test_tool_call_argument_size_cap(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        _register_echo(client)
        created = _create(client)
        artifact_id = str(created["id"])
        _allow(client, artifact_id, ["echo"])

        response = _call(
            client, artifact_id, arguments={"text": "x" * 70_000}
        )

    assert response.status_code == 413
    assert response.json()["code"] == "PAYLOAD_TOO_LARGE"
    assert factory.connections == []


def test_tool_call_rate_limit(tmp_path: Path) -> None:
    factory = FakeMcpFactory()
    with panel_client(tmp_path, connections=factory) as (client, _, _):
        _register_echo(client)
        created = _create(client)
        artifact_id = str(created["id"])
        _allow(client, artifact_id, ["echo"])

        for _ in range(30):
            response = _call(client, artifact_id, request_id=None)
            assert response.status_code == 200, response.text

        limited = _call(client, artifact_id, request_id=None)
        assert limited.status_code == 429
        assert limited.json()["code"] == "RATE_LIMITED"
        assert len(factory.connections) == 30


def test_tool_call_auth_and_unknown_artifact(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, _, _):
        created = _create(client)
        artifact_id = str(created["id"])

        assert (
            client.post(
                f"/api/artifacts/{artifact_id}/tools/call",
                json={"name": "echo", "arguments": {}, "consent": True},
            ).status_code
            == 401
        )

        missing = _call(client, "nope")
        assert missing.status_code == 404
        assert missing.json()["code"] == "ARTIFACT_NOT_FOUND"


def test_materialized_frontmatter_capabilities_are_persisted(
    tmp_path: Path,
) -> None:
    with panel_client(tmp_path) as (client, container, _):
        result = materialize_artifacts(
            "```artifact-html\n---\n"
            "title: Tool Art\n"
            "mcpTools: [echo, search]\n"
            "---\n<p>x</p>\n```"
        )
        assert len(result.artifacts) == 1
        mutation = container.artifact_store.save_materialized(
            result.artifacts[0],
            session_id="s1",
            turn_id="t1",
            message_id="m1",
        )
        artifact_id = mutation.artifact.id
        assert mutation.artifact.mcp_tools == ("echo", "search")

        view = client.get(f"/api/artifacts/{artifact_id}", headers=AUTH)
        assert view.json()["mcpTools"] == ["echo", "search"]


def test_version_diff(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, _, _):
        created = _create(client, html="<h1>one</h1>")
        artifact_id = str(created["id"])
        _create(client, html="<h1>two</h1>")

        changed = client.get(
            f"/api/artifacts/{artifact_id}/diff",
            headers=AUTH,
            params={"from": "v1", "to": "v2"},
        )
        assert changed.status_code == 200, changed.text
        payload = changed.json()
        assert payload["from"] == "v1"
        assert payload["to"] == "v2"
        assert payload["truncated"] is False
        assert "<h1>one</h1>" in payload["patch"]
        assert "<h1>two</h1>" in payload["patch"]
        assert any(
            line.startswith("-") and "<h1>one</h1>" in line
            for line in payload["patch"].splitlines()
        )
        assert any(
            line.startswith("+") and "<h1>two</h1>" in line
            for line in payload["patch"].splitlines()
        )

        same = client.get(
            f"/api/artifacts/{artifact_id}/diff",
            headers=AUTH,
            params={"from": "v1", "to": "v1"},
        )
        assert same.status_code == 200
        assert same.json()["patch"] == ""
        assert same.json()["truncated"] is False

        missing_version = client.get(
            f"/api/artifacts/{artifact_id}/diff",
            headers=AUTH,
            params={"from": "v1", "to": "v99"},
        )
        assert missing_version.status_code == 404

        invalid_version = client.get(
            f"/api/artifacts/{artifact_id}/diff",
            headers=AUTH,
            params={"from": "v1", "to": "nope"},
        )
        assert invalid_version.status_code == 400
        assert invalid_version.json()["code"] == "INVALID_INPUT"

        missing_artifact = client.get(
            "/api/artifacts/nope/diff",
            headers=AUTH,
            params={"from": "v1", "to": "v2"},
        )
        assert missing_artifact.status_code == 404

        assert (
            client.get(
                f"/api/artifacts/{artifact_id}/diff",
                params={"from": "v1", "to": "v2"},
            ).status_code
            == 401
        )
