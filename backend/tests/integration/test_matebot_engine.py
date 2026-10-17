"""Integration: real vendored OpenccSession + scripted fake CLI + SSE API."""

from __future__ import annotations

import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.adapters.autoagent_config import AutoAgentConfigStore
from autoagent_backend.adapters.engine.matebot_engine import (
    MateBotEngine,
    build_matebot_session_factory,
)
from autoagent_backend.app import create_app
from autoagent_backend.config import config_from_env
from autoagent_backend.domain.events import (
    TextDelta,
    TurnCompleted,
    UsageReported,
)
from autoagent_backend.domain.models import AutoAgentConfigPatch, Settings
from autoagent_backend.domain.ports import StartTurnRequest
from autoagent_backend.domain.values import EngineSessionRef

pytestmark = pytest.mark.integration

REPO = Path(__file__).resolve().parents[3]
VENDOR = REPO / "vendor" / "matebot" / "opencc_backend.py"
FAKE_CLI = Path(__file__).resolve().parents[1] / "fixtures" / "fake_cli.js"
FAKE_SESSION_ID = "44444444-4444-4444-8444-444444444444"
TOKEN = "test-token"


def _bun() -> str:
    bun = shutil.which("bun")
    if bun is None:
        pytest.skip("bun is not installed")
    return bun


class FakeRefs:
    def __init__(self) -> None:
        self.refs: dict[str, EngineSessionRef | None] = {}

    def get_ref(self, session_id: str) -> EngineSessionRef | None:
        return self.refs.get(session_id)

    def set_ref(self, session_id: str, ref: EngineSessionRef | None) -> None:
        self.refs[session_id] = ref


def _engine(tmp_path: Path) -> tuple[MateBotEngine, FakeRefs]:
    refs = FakeRefs()
    factory = build_matebot_session_factory(
        vendor_path=VENDOR,
        cli_path=FAKE_CLI,
        bun_path=Path(_bun()),
    )
    engine = MateBotEngine(
        session_factory=factory,
        refs=refs,
        max_sessions=4,
        cancel_grace_s=0.5,
    )
    return engine, refs


def _request(tmp_path: Path, session_id: str, text: str) -> StartTurnRequest:
    return StartTurnRequest(
        turn_id=str(uuid.uuid4()),
        session_id=session_id,
        text=text,
        settings=Settings(cwd=str(tmp_path)),
    )


def test_two_turns_share_one_process_and_argv_has_matebot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    argv_file = tmp_path / "argv.json"
    pid_file = tmp_path / "pid"
    monkeypatch.setenv("FAKE_CLI_ARGV_FILE", str(argv_file))
    monkeypatch.setenv("FAKE_CLI_PID_FILE", str(pid_file))

    engine, refs = _engine(tmp_path)
    session_id = str(uuid.uuid4())
    try:
        first = list(engine.stream(engine.start_turn(_request(tmp_path, session_id, "one"))))
        assert isinstance(first[-1], TurnCompleted)
        assert first[-1].text == "echo:one"
        assert any(isinstance(event, TextDelta) for event in first)
        assert any(isinstance(event, UsageReported) for event in first)
        assert refs.refs[session_id] == EngineSessionRef(FAKE_SESSION_ID)
        assert engine.session_ref(session_id) == EngineSessionRef(FAKE_SESSION_ID)

        argv = json.loads(argv_file.read_text(encoding="utf-8"))
        assert "--matebot" in argv
        assert "--print" in argv
        assert "--input-format" in argv and "stream-json" in argv
        assert "--dangerously-skip-permissions" in argv
        first_pid = pid_file.read_text(encoding="utf-8")

        second = list(
            engine.stream(engine.start_turn(_request(tmp_path, session_id, "two")))
        )
        assert isinstance(second[-1], TurnCompleted)
        assert second[-1].text == "echo:two"
        assert pid_file.read_text(encoding="utf-8") == first_pid
    finally:
        engine.close_all()


def test_matebot_engine_end_to_end_sse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    argv_file = tmp_path / "argv.json"
    monkeypatch.setenv("AUTOAGENT_ENGINE", "matebot")
    monkeypatch.setenv("AUTOAGENT_OPENCC_CLI_PATH", str(FAKE_CLI))
    monkeypatch.setenv("AUTOAGENT_BUN_PATH", _bun())
    monkeypatch.setenv("AUTOAGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("AUTOAGENT_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("FAKE_CLI_ARGV_FILE", str(argv_file))

    config = config_from_env(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist"
    )
    assert config.engine_mode == "matebot"

    with TestClient(create_app(config)) as client:
        headers = {"Authorization": f"Bearer {TOKEN}"}
        session = client.post(
            "/api/sessions", headers=headers, json={"title": "matebot"}
        )
        assert session.status_code == 200
        session_id = session.json()["id"]

        turn_id = str(uuid.uuid4())
        response = client.post(
            f"/api/turns/{turn_id}/stream",
            headers=headers,
            json={"sessionId": session_id, "text": "hello"},
        )
        assert response.status_code == 200, response.text
        events = _parse_sse(response.text)
        assert [name for name, _data in events] == [
            "turn.started",
            "message.delta",
            "usage",
            "message.completed",
            "turn.completed",
        ]
        payloads = dict(events)
        assert payloads["message.completed"]["text"] == "echo:hello"
        assert payloads["turn.completed"]["stopReason"] == "end_turn"

        status = client.get(f"/api/turns/{turn_id}", headers=headers)
        assert status.status_code == 200
        assert status.json()["state"] == "completed"

        settings = client.get("/api/settings", headers=headers)
        assert settings.status_code == 200
        assert settings.json()["engine"]["cli"] == str(FAKE_CLI)

    argv = json.loads(argv_file.read_text(encoding="utf-8"))
    assert "--matebot" in argv


def test_autoagent_config_env_reaches_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    env_file = tmp_path / "child-env.json"
    monkeypatch.setenv("FAKE_CLI_ENV_FILE", str(env_file))
    monkeypatch.setenv("AUTOAGENT_ENGINE", "matebot")
    monkeypatch.setenv("AUTOAGENT_OPENCC_CLI_PATH", str(FAKE_CLI))
    monkeypatch.setenv("AUTOAGENT_BUN_PATH", _bun())
    monkeypatch.setenv("AUTOAGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("AUTOAGENT_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)

    original = {
        key: os.environ.get(key)
        for key in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")
    }
    config = config_from_env(
        data_dir=data_dir, frontend_dist=tmp_path / "dist"
    )
    store = AutoAgentConfigStore(config.paths.autoagent_config_path)
    store.update(
        AutoAgentConfigPatch(
            api_key="sk-child-secret",
            base_url="http://autoagent.invalid",
        )
    )
    try:
        with TestClient(create_app(config)) as client:
            headers = {"Authorization": f"Bearer {TOKEN}"}
            session = client.post(
                "/api/sessions", headers=headers, json={"title": "env"}
            )
            turn = client.post(
                f"/api/turns/{uuid.uuid4()}/stream",
                headers=headers,
                json={"sessionId": session.json()["id"], "text": "hello"},
            )
            assert turn.status_code == 200
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    child_env = json.loads(env_file.read_text(encoding="utf-8"))
    assert child_env["ANTHROPIC_AUTH_TOKEN"] == "sk-child-secret"
    assert child_env["ANTHROPIC_BASE_URL"] == "http://autoagent.invalid"


def _parse_sse(text: str) -> list[tuple[str, dict[str, Any]]]:
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
