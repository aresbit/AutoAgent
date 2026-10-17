"""Read the CLI settings model without writing files or leaking credentials."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path

from autoagent_backend.adapters.claude_settings import ClaudeSettingsReader


def _write(directory: Path, name: str, payload: object) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_config_dir_from_environment(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    reader = ClaudeSettingsReader(environ={"CLAUDE_CONFIG_DIR": str(config_dir)})
    assert reader.config_dir == config_dir.resolve()
    assert reader.config_path == config_dir.resolve() / "settings.json"


def test_env_block_model(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    _write(
        config_dir,
        "settings.json",
        {"env": {"ANTHROPIC_MODEL": "env-block-model"}},
    )
    resolution = ClaudeSettingsReader(config_dir=config_dir, environ={}).resolve()
    assert resolution.model == "env-block-model"
    assert resolution.source == "claude-settings"
    assert resolution.config_path == str(config_dir.resolve() / "settings.json")


def test_top_level_model(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    _write(config_dir, "settings.json", {"model": "top-level-model"})
    resolution = ClaudeSettingsReader(config_dir=config_dir, environ={}).resolve()
    assert resolution.model == "top-level-model"
    assert resolution.source == "claude-settings"


def test_local_settings_override_global(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    _write(
        config_dir,
        "settings.json",
        {"env": {"ANTHROPIC_MODEL": "global-env"}},
    )
    _write(
        config_dir,
        "settings.local.json",
        {"env": {"ANTHROPIC_MODEL": "local-env"}},
    )
    resolution = ClaudeSettingsReader(config_dir=config_dir, environ={}).resolve()
    assert resolution.model == "local-env"
    assert resolution.source == "claude-settings"

    _write(config_dir, "settings.json", {"model": "global-model"})
    _write(config_dir, "settings.local.json", {"model": "local-model"})
    resolution = ClaudeSettingsReader(config_dir=config_dir, environ={}).resolve()
    assert resolution.model == "local-model"


def test_missing_files_use_process_env_or_default(tmp_path: Path) -> None:
    config_dir = tmp_path / "absent"
    default = ClaudeSettingsReader(config_dir=config_dir, environ={}).resolve()
    assert default.model is None
    assert default.source == "default"
    assert default.credentials_configured is False
    assert default.config_path == str(config_dir.resolve() / "settings.json")

    from_env = ClaudeSettingsReader(
        config_dir=config_dir, environ={"ANTHROPIC_MODEL": "process-model"}
    ).resolve()
    assert from_env.model == "process-model"
    assert from_env.source == "env"


def test_desktop_override_wins_over_global(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    _write(
        config_dir,
        "settings.json",
        {"env": {"ANTHROPIC_MODEL": "global-model"}},
    )
    resolution = ClaudeSettingsReader(config_dir=config_dir, environ={}).resolve(
        "desktop-override"
    )
    assert resolution.model == "desktop-override"
    assert resolution.source == "override"


def test_invalid_json_is_ignored(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    config_dir.mkdir(parents=True)
    (config_dir / "settings.json").write_text("{not json", encoding="utf-8")
    resolution = ClaudeSettingsReader(
        config_dir=config_dir, environ={"ANTHROPIC_MODEL": "process-model"}
    ).resolve()
    assert resolution.model == "process-model"
    assert resolution.source == "env"


def test_no_credentials_are_exposed(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    _write(
        config_dir,
        "settings.json",
        {
            "env": {
                "ANTHROPIC_MODEL": "secret-model",
                "ANTHROPIC_API_KEY": "sk-super-secret-key",
                "ANTHROPIC_AUTH_TOKEN": "auth-super-secret-token",
            }
        },
    )
    resolution = ClaudeSettingsReader(
        config_dir=config_dir,
        environ={"CLAUDE_CODE_OAUTH_TOKEN": "oauth-super-secret"},
    ).resolve()
    assert resolution.model == "secret-model"
    assert resolution.credentials_configured is True
    rendered = repr(resolution)
    for secret in (
        "sk-super-secret-key",
        "auth-super-secret-token",
        "oauth-super-secret",
    ):
        assert secret not in rendered
        for item in dataclasses.fields(resolution):
            assert secret not in str(getattr(resolution, item.name))


def test_apikey_helper_counts_as_credentials(tmp_path: Path) -> None:
    config_dir = tmp_path / "cfg"
    _write(config_dir, "settings.json", {"apiKeyHelper": "/usr/bin/helper"})
    resolution = ClaudeSettingsReader(config_dir=config_dir, environ={}).resolve()
    assert resolution.credentials_configured is True
