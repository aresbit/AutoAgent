"""M1: configuration and path stability."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from autoagent_backend import __version__
from autoagent_backend.__main__ import main
from autoagent_backend.config import config_from_env
from autoagent_backend.logging_setup import redact
from autoagent_backend.paths import (
    default_autoagent_config_dir,
    default_data_dir,
    resolve_paths,
)


def test_version_is_reported() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__)


def test_paths_are_stable(tmp_path: Path) -> None:
    first = resolve_paths(tmp_path / "data", tmp_path / "logs")
    second = resolve_paths(tmp_path / "data", tmp_path / "logs")
    assert first == second
    assert first.db_path == (tmp_path / "data").resolve() / "autoagent-v2.db"
    assert first.claude_config_dir == (tmp_path / "data").resolve() / ".claude"
    assert first.log_dir == (tmp_path / "logs").resolve()
    assert first.engine_log_dir == (tmp_path / "logs").resolve() / "engine"


def test_explicit_data_dir_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUTOAGENT_DATA_DIR", str(tmp_path / "env-data"))
    config = config_from_env(data_dir=tmp_path / "explicit")
    assert config.paths.data_dir == (tmp_path / "explicit").resolve()


def test_token_and_origin(tmp_path: Path) -> None:
    config = config_from_env(data_dir=tmp_path / "data", port=8899)
    assert config.origin == "http://127.0.0.1:8899"
    assert config.api_token == "test-token"
    assert "test-token" not in repr(config)


def test_non_loopback_bind_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        config_from_env(host="0.0.0.0", data_dir=tmp_path / "data")


def test_invalid_port_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        config_from_env(port=70000, data_dir=tmp_path / "data")


def test_default_data_dir_platform_conventions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AUTOAGENT_DATA_DIR", raising=False)
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setattr("autoagent_backend.paths.sys.platform", "linux")
    assert default_data_dir() == Path.home() / ".config" / "autoagent"

    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg))
    assert default_data_dir() == xdg / "autoagent"

    monkeypatch.setattr("autoagent_backend.paths.sys.platform", "darwin")
    assert default_data_dir() == (
        Path.home() / "Library" / "Application Support" / "autoagent"
    )

    local = tmp_path / "LocalAppData"
    monkeypatch.setattr("autoagent_backend.paths.sys.platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    assert default_data_dir() == local / "AutoAgent"


def test_default_data_dir_override_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUTOAGENT_DATA_DIR", str(tmp_path / "custom"))
    assert default_data_dir() == tmp_path / "custom"


def test_autoagent_config_dir_is_independent_of_data_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AUTOAGENT_CONFIG_DIR", raising=False)
    assert default_autoagent_config_dir() == Path.home() / ".autoagent"

    custom = tmp_path / "engine-config"
    monkeypatch.setenv("AUTOAGENT_CONFIG_DIR", str(custom))
    assert default_autoagent_config_dir() == custom.resolve()

    paths = resolve_paths(
        data_dir=tmp_path / "data", frontend_dist=tmp_path / "dist"
    )
    assert paths.data_dir == (tmp_path / "data").resolve()
    assert paths.autoagent_config_path == custom.resolve() / "settings.json"


def test_fake_engine_refused_in_packaged_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUTOAGENT_ENGINE", "fake")
    monkeypatch.setenv("AUTOAGENT_PACKAGED", "1")
    with pytest.raises(ValueError):
        config_from_env(data_dir=tmp_path / "data")


def test_default_cwd_is_home(tmp_path: Path) -> None:
    config = config_from_env(data_dir=tmp_path / "data")
    assert config.default_cwd == Path.home().resolve()


def test_default_cwd_env_override_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("AUTOAGENT_DEFAULT_CWD", str(workspace))
    config = config_from_env(data_dir=tmp_path / "data")
    assert config.default_cwd == workspace.resolve()


def test_redaction_removes_tokens() -> None:
    secret = "supersecretvalue"
    message = f"Authorization: Bearer {secret} api_key={secret} sk-abcdef123456"
    cleaned = redact(message, [secret])
    assert secret not in cleaned
    assert "sk-abcdef123456" not in cleaned
    assert "[REDACTED]" in cleaned


def test_default_engine_mode_is_matebot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AUTOAGENT_ENGINE", raising=False)
    config = config_from_env(data_dir=tmp_path / "data")
    assert config.engine_mode == "matebot"
    assert config.matebot_vendor.name == "opencc_backend.py"
    assert config.matebot_vendor.is_file()


def test_matebot_vendor_dir_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vendor_dir = tmp_path / "vendor"
    vendor_dir.mkdir()
    monkeypatch.setenv("AUTOAGENT_MATEBOT_VENDOR_DIR", str(vendor_dir))
    config = config_from_env(data_dir=tmp_path / "data")
    assert config.matebot_vendor == (vendor_dir / "opencc_backend.py").resolve()


def test_runtime_check_reports_matebot_vendor_and_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("AUTOAGENT_ENGINE", raising=False)
    code = main(["--runtime-check", "--data-dir", str(tmp_path / "data")])
    captured = capsys.readouterr()
    assert code == 0, captured.err
    payload = json.loads(captured.out)
    assert payload["engineMode"] == "matebot"
    engine = payload["engine"]
    assert engine["mode"] == "matebot"
    vendor = Path(engine["matebotVendor"])
    assert vendor.name == "opencc_backend.py"
    assert vendor.is_file()
    cli = Path(engine["cli"])
    assert cli.is_file()
