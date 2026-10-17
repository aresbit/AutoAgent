"""M2: SSE turn endpoints, status, cancel, settings and bootstrap."""

from __future__ import annotations

import json
import logging
import os
import stat
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-token"


def _create_session(client: TestClient) -> str:
    response = client.post(
        "/api/sessions",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"title": "api test"},
    )
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


def _sse_events(text: str) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    for block in text.strip().split("\n\n"):
        if not block.strip():
            continue
        name = ""
        data = ""
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[len("event: ") :]
            elif line.startswith("data: "):
                data = line[len("data: ") :]
        if name and data:
            events.append((name, json.loads(data)))
    return events


def test_fake_engine_sse_sequence(client: TestClient) -> None:
    session_id = _create_session(client)
    turn_id = str(uuid.uuid4())
    response = client.post(
        f"/api/turns/{turn_id}/stream",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"sessionId": session_id, "text": "hello"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")

    events = _sse_events(response.text)
    assert [name for name, _ in events] == [
        "turn.started",
        "message.delta",
        "message.delta",
        "message.delta",
        "tool.start",
        "tool.result",
        "usage",
        "message.completed",
        "turn.completed",
    ]
    assert [data["seq"] for _, data in events] == list(range(1, 10))
    assert events[0][1]["model"] == "fake-model"
    channels = [
        data["channel"] for name, data in events if name == "message.delta"
    ]
    assert channels == ["text", "thinking", "text"]
    assert events[-1][1]["stopReason"] == "end_turn"

    raw = response.text
    for forbidden in ("content_block", "tool_use", "session_id", "argv", "pid"):
        assert forbidden not in raw

    status = client.get(
        f"/api/turns/{turn_id}", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert status.status_code == 200
    payload = status.json()
    assert payload["state"] == "completed"
    assert payload["stopReason"] == "end_turn"
    assert payload["assistantMessageId"]


def test_duplicate_turn_id_returns_409(client: TestClient) -> None:
    session_id = _create_session(client)
    turn_id = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {TOKEN}"}
    first = client.post(
        f"/api/turns/{turn_id}/stream",
        headers=headers,
        json={"sessionId": session_id, "text": "hello"},
    )
    assert first.status_code == 200
    second = client.post(
        f"/api/turns/{turn_id}/stream",
        headers=headers,
        json={"sessionId": session_id, "text": "again"},
    )
    assert second.status_code == 409
    assert second.json()["code"] == "TURN_ALREADY_FINISHED"


def test_invalid_turn_id_returns_400(client: TestClient) -> None:
    session_id = _create_session(client)
    response = client.post(
        "/api/turns/not-a-uuid/stream",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"sessionId": session_id, "text": "hello"},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "INVALID_TURN_ID"


def test_unknown_turn_returns_404(client: TestClient) -> None:
    response = client.get(
        f"/api/turns/{uuid.uuid4()}", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert response.status_code == 404
    assert response.json()["code"] == "TURN_NOT_FOUND"


def test_turn_requires_token_and_existing_session(client: TestClient) -> None:
    session_id = _create_session(client)
    turn_id = str(uuid.uuid4())
    assert (
        client.post(
            f"/api/turns/{turn_id}/stream",
            json={"sessionId": session_id, "text": "hello"},
        ).status_code
        == 401
    )
    response = client.post(
        f"/api/turns/{turn_id}/stream",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={"sessionId": str(uuid.uuid4()), "text": "hello"},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "SESSION_NOT_FOUND"


def test_cancel_after_completion_is_idempotent(client: TestClient) -> None:
    session_id = _create_session(client)
    turn_id = str(uuid.uuid4())
    headers = {"Authorization": f"Bearer {TOKEN}"}
    response = client.post(
        f"/api/turns/{turn_id}/stream",
        headers=headers,
        json={"sessionId": session_id, "text": "hello"},
    )
    assert response.status_code == 200

    first = client.post(f"/api/turns/{turn_id}/cancel", headers=headers)
    second = client.post(f"/api/turns/{turn_id}/cancel", headers=headers)
    assert first.status_code == 202 and first.json() == {"cancelling": True}
    assert second.status_code == 202 and second.json() == {"cancelling": True}


def test_sessions_and_bootstrap(client: TestClient) -> None:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    session_id = _create_session(client)

    listing = client.get("/api/sessions", headers=headers)
    assert listing.status_code == 200
    assert listing.json()["sessions"][0]["id"] == session_id

    bootstrap = client.get("/api/bootstrap", headers=headers)
    assert bootstrap.status_code == 200
    payload = bootstrap.json()
    assert payload["apiVersion"] == "1"
    assert payload["settings"]["permissionMode"] == "bypassPermissions"
    assert payload["settings"]["providerId"] == "matebot"
    assert payload["settings"]["model"] == ""
    assert payload["settings"]["fallbackModel"] is None
    assert payload["settings"]["engine"]["preset"] == "matebot"
    assert payload["settings"]["engine"]["mode"] == "matebot"
    assert payload["engine"]["mode"] == "matebot"
    assert "sessions" in payload

    renamed = client.patch(
        f"/api/sessions/{session_id}", headers=headers, json={"title": "renamed"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "renamed"

    branched = client.post(
        f"/api/sessions/{session_id}/branch", headers=headers, json={}
    )
    assert branched.status_code == 200
    assert branched.json()["id"] != session_id

    deleted = client.delete(f"/api/sessions/{session_id}", headers=headers)
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}


def test_settings_update_and_permission_policy(client: TestClient) -> None:
    headers = {"Authorization": f"Bearer {TOKEN}"}

    defaults = client.get("/api/settings", headers=headers)
    assert defaults.status_code == 200
    default_payload = defaults.json()
    assert default_payload["providerId"] == "matebot"
    assert default_payload["model"] == ""
    assert default_payload["fallbackModel"] is None
    default_engine = default_payload["engine"]
    assert default_engine["preset"] == "matebot"
    assert default_engine["mode"] == "matebot"
    assert default_engine["version"] == "fake"
    assert default_engine["model"] is None
    assert default_engine["modelSource"] == "default"
    assert default_engine["configPath"] == str(
        (Path(os.environ["CLAUDE_CONFIG_DIR"]) / "settings.json").resolve()
    )
    autoagent_path = str(
        Path(client.app.state.config.paths.autoagent_config_path).resolve()
    )
    assert default_engine["autoagentConfigPath"] == autoagent_path
    assert default_engine["credentialSource"] == "none"
    assert default_engine["credentialConfigured"] is False
    assert default_engine["cli"].endswith(
        "packages/opencc/dist/cli.js"
    )

    updated = client.put(
        "/api/settings", headers=headers, json={"model": "my-opencc-model"}
    )
    assert updated.status_code == 200
    assert updated.json()["model"] == "my-opencc-model"
    assert updated.json()["providerId"] == "matebot"
    assert updated.json()["apiKeyConfigured"] is False

    rejected = client.put(
        "/api/settings", headers=headers, json={"permissionMode": "default"}
    )
    assert rejected.status_code == 400
    assert rejected.json()["code"] == "PERMISSION_MODE_UNSUPPORTED"

    providers = client.get("/api/providers", headers=headers)
    assert providers.status_code == 200
    builtin = providers.json()["builtin"]
    assert len(builtin) == 1
    assert builtin[0] == {
        "id": "matebot",
        "name": "MateBot (OpenCC)",
        "apiType": None,
        "baseURL": None,
        "models": [],
        "allowCustomModels": True,
    }
    assert providers.json()["custom"] == []

    provider = client.get("/api/providers/matebot", headers=headers)
    assert provider.status_code == 200
    assert provider.json()["id"] == "matebot"
    missing = client.get("/api/providers/anthropic", headers=headers)
    assert missing.status_code == 404


def test_engine_profile_reads_claude_settings(client: TestClient) -> None:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    config_dir = Path(os.environ["CLAUDE_CONFIG_DIR"])
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "settings.json").write_text(
        json.dumps({"env": {"ANTHROPIC_MODEL": "global-claude-model"}}),
        encoding="utf-8",
    )

    resolved = client.get("/api/settings", headers=headers)
    assert resolved.status_code == 200
    engine = resolved.json()["engine"]
    assert engine["model"] == "global-claude-model"
    assert engine["modelSource"] == "claude-settings"
    assert engine["configPath"] == str(
        (config_dir / "settings.json").resolve()
    )

    overridden = client.put(
        "/api/settings", headers=headers, json={"model": "desktop-model"}
    )
    assert overridden.status_code == 200
    engine = overridden.json()["engine"]
    assert engine["model"] == "desktop-model"
    assert engine["modelSource"] == "override"


def test_engine_config_api(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    autoagent_path = Path(
        client.app.state.config.paths.autoagent_config_path
    ).resolve()

    assert client.get("/api/engine/config").status_code == 401

    initial = client.get("/api/engine/config", headers=headers)
    assert initial.status_code == 200
    initial_payload = initial.json()
    assert initial_payload["configPath"] == str(autoagent_path)
    assert initial_payload["model"] is None
    assert initial_payload["baseURL"] is None
    assert initial_payload["apiKeyConfigured"] is False
    assert initial_payload["apiKeyHelperConfigured"] is False
    assert "apiKey" not in initial_payload
    assert "apiKeyHelper" not in initial_payload
    assert initial_payload["engine"]["credentialSource"] == "none"

    secret = "sk-test-secret-never-serialized"
    original = {
        key: os.environ.get(key)
        for key in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
    }
    try:
        with caplog.at_level(logging.INFO):
            updated = client.put(
                "/api/engine/config",
                headers=headers,
                json={
                    "model": "auto-model",
                    "baseURL": "https://auto.invalid",
                    "apiKey": secret,
                    "apiKeyHelper": "/usr/bin/helper",
                },
            )
        assert updated.status_code == 200, updated.text
        assert secret not in updated.text
        assert secret not in caplog.text

        payload = updated.json()
        assert payload["configPath"] == str(autoagent_path)
        assert payload["model"] == "auto-model"
        assert payload["baseURL"] == "https://auto.invalid"
        assert payload["apiKeyConfigured"] is True
        assert payload["apiKeyHelperConfigured"] is True
        assert "apiKey" not in payload
        assert "apiKeyHelper" not in payload
        engine = payload["engine"]
        assert engine["model"] == "auto-model"
        assert engine["modelSource"] == "autoagent"
        assert engine["configPath"] == str(autoagent_path)
        assert engine["autoagentConfigPath"] == str(autoagent_path)
        assert engine["credentialSource"] == "autoagent"
        assert engine["credentialConfigured"] is True
        assert stat.S_IMODE(autoagent_path.stat().st_mode) == 0o600

        client.put(
            "/api/settings", headers=headers, json={"model": "desktop-model"}
        )
        overridden = client.get("/api/settings", headers=headers).json()["engine"]
        assert overridden["model"] == "desktop-model"
        assert overridden["modelSource"] == "override"

        cleared = client.put(
            "/api/engine/config",
            headers=headers,
            json={"model": "", "apiKey": "", "apiKeyHelper": ""},
        )
        assert cleared.json()["model"] is None
        assert cleared.json()["apiKeyConfigured"] is False
        assert cleared.json()["apiKeyHelperConfigured"] is False
        assert cleared.json()["engine"]["credentialSource"] in {"none", "env"}
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_oversized_body_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/sessions",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Length": str(2 * 1024 * 1024),
        },
        content=b"{}",
    )
    assert response.status_code == 413
    assert response.json()["code"] == "PAYLOAD_TOO_LARGE"
