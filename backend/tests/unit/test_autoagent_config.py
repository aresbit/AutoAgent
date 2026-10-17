"""AutoAgent config store: atomicity, mode 0600, secret hygiene."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from autoagent_backend.adapters.autoagent_config import AutoAgentConfigStore
from autoagent_backend.domain.errors import InvalidSettings
from autoagent_backend.domain.models import AutoAgentConfigPatch


def test_missing_file_is_empty_config(tmp_path: Path) -> None:
    store = AutoAgentConfigStore(tmp_path / "settings.json")
    config = store.read()
    assert config.model is None
    assert config.base_url is None
    assert config.api_key is None
    assert config.api_key_helper is None
    assert config.api_key_configured is False
    assert not (tmp_path / "settings.json").exists()


def test_update_writes_atomic_0600_and_preserves_unknown_fields(
    tmp_path: Path,
) -> None:
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"future": "kept"}), encoding="utf-8")
    store = AutoAgentConfigStore(path)

    config = store.update(
        AutoAgentConfigPatch(
            model="auto-model",
            base_url="https://autoagent.invalid",
            api_key="sk-secret-value",
            api_key_helper="/usr/bin/helper",
        )
    )
    assert config.model == "auto-model"
    assert config.base_url == "https://autoagent.invalid"
    assert config.api_key == "sk-secret-value"
    assert config.api_key_helper == "/usr/bin/helper"
    assert config.api_key_configured is True
    assert config.api_key_helper_configured is True
    assert stat.S_IMODE(path.stat().st_mode) == 0o600

    document = json.loads(path.read_text(encoding="utf-8"))
    assert document == {
        "future": "kept",
        "model": "auto-model",
        "baseURL": "https://autoagent.invalid",
        "apiKey": "sk-secret-value",
        "apiKeyHelper": "/usr/bin/helper",
    }
    assert "sk-secret-value" not in repr(config)
    assert not list(tmp_path.glob(".settings-*"))


def test_creates_parent_directory_0700(tmp_path: Path) -> None:
    config_dir = tmp_path / "fresh-autoagent"
    store = AutoAgentConfigStore(config_dir / "settings.json")
    store.update(AutoAgentConfigPatch(model="m"))
    assert stat.S_IMODE(config_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE((config_dir / "settings.json").stat().st_mode) == 0o600


def test_helper_only_has_separate_flags(tmp_path: Path) -> None:
    store = AutoAgentConfigStore(tmp_path / "settings.json")
    config = store.update(
        AutoAgentConfigPatch(api_key_helper="/usr/bin/helper")
    )
    assert config.api_key_configured is False
    assert config.api_key_helper_configured is True


def test_empty_string_clears_a_field(tmp_path: Path) -> None:
    store = AutoAgentConfigStore(tmp_path / "settings.json")
    store.update(AutoAgentConfigPatch(model="m", api_key="k"))
    config = store.update(AutoAgentConfigPatch(model="", api_key=""))
    assert config.model is None
    assert config.api_key is None
    document = json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))
    assert "model" not in document
    assert "apiKey" not in document


def test_failed_replace_keeps_the_original_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model": "old"}), encoding="utf-8")
    store = AutoAgentConfigStore(path)

    def fail_replace(_src: object, _dst: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(
        "autoagent_backend.adapters.autoagent_config.os.replace", fail_replace
    )
    with pytest.raises(InvalidSettings):
        store.update(AutoAgentConfigPatch(model="new"))

    assert json.loads(path.read_text(encoding="utf-8"))["model"] == "old"
    assert not list(tmp_path.glob(".settings-*"))


def test_invalid_json_is_reported(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{not json", encoding="utf-8")
    store = AutoAgentConfigStore(path)
    with pytest.raises(InvalidSettings):
        store.read()
    with pytest.raises(InvalidSettings):
        store.update(AutoAgentConfigPatch(model="m"))
