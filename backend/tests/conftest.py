"""Shared fixtures."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.app import create_app
from autoagent_backend.config import BootConfig, config_from_env

TOKEN = "test-token"
_ENGINE_ENV = (
    "AUTOAGENT_API_TOKEN",
    "AUTOAGENT_ENGINE",
    "AUTOAGENT_BOOT_ID",
    "AUTOAGENT_BUN_PATH",
    "AUTOAGENT_OPENCC_CLI_PATH",
    "AUTOAGENT_LOG_DIR",
    "AUTOAGENT_STATE_DIR",
    "AUTOAGENT_DATA_DIR",
    "AUTOAGENT_PACKAGED",
    "AUTOAGENT_DEBUG_ENGINE",
    "AUTOAGENT_FRONTEND_DIST",
    "AUTOAGENT_DESKTOP_PID",
    "AUTOAGENT_DESKTOP_HEARTBEAT",
    "AUTOAGENT_DEFAULT_CWD",
    "AUTOAGENT_MATEBOT_VENDOR_DIR",
    "AUTOAGENT_CONFIG_DIR",
    "AUTOAGENT_MCP_PERSISTENT",
    "AUTOAGENT_MCP_HEALTH_INTERVAL_S",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in _ENGINE_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AUTOAGENT_API_TOKEN", TOKEN)
    monkeypatch.setenv("AUTOAGENT_ENGINE", "fake")
    # Existing suites inject a short-lived MCP factory; the persistent runtime
    # is covered by tests/integration/test_mcp_runtime.py.
    monkeypatch.setenv("AUTOAGENT_MCP_PERSISTENT", "0")
    monkeypatch.setenv("AUTOAGENT_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("AUTOAGENT_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config"))
    monkeypatch.setenv("AUTOAGENT_CONFIG_DIR", str(tmp_path / "autoagent-config"))


@pytest.fixture
def boot_config(tmp_path: Path) -> BootConfig:
    return config_from_env(data_dir=tmp_path / "data", port=8787)


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(boot_config: BootConfig) -> Iterator[TestClient]:
    app = create_app(boot_config)
    with TestClient(app) as test_client:
        yield test_client


def make_client(config: BootConfig) -> TestClient:
    return TestClient(create_app(config))


def remove_env(name: str) -> None:
    os.environ.pop(name, None)
