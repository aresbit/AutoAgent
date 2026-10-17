"""Engine config precedence: Claude settings > AutoAgent > process env."""

from __future__ import annotations

import json
from pathlib import Path

from autoagent_backend.adapters.autoagent_config import AutoAgentConfigStore
from autoagent_backend.adapters.claude_settings import ClaudeSettingsReader
from autoagent_backend.adapters.engine_config import EngineConfigResolver
from autoagent_backend.domain.models import AutoAgentConfigPatch


def _reader(
    tmp_path: Path,
    settings: dict[str, object] | None = None,
    local: dict[str, object] | None = None,
    environ: dict[str, str] | None = None,
) -> ClaudeSettingsReader:
    config_dir = tmp_path / "claude"
    if settings is not None or local is not None:
        config_dir.mkdir(parents=True, exist_ok=True)
    if settings is not None:
        (config_dir / "settings.json").write_text(
            json.dumps(settings), encoding="utf-8"
        )
    if local is not None:
        (config_dir / "settings.local.json").write_text(
            json.dumps(local), encoding="utf-8"
        )
    return ClaudeSettingsReader(config_dir=config_dir, environ=environ or {})


def _auto(
    tmp_path: Path,
    *,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    api_key_helper: str | None = None,
) -> AutoAgentConfigStore:
    store = AutoAgentConfigStore(tmp_path / "autoagent" / "settings.json")
    if any(value is not None for value in (model, base_url, api_key, api_key_helper)):
        store.update(
            AutoAgentConfigPatch(
                model=model,
                base_url=base_url,
                api_key=api_key,
                api_key_helper=api_key_helper,
            )
        )
    return store


def _resolver(
    tmp_path: Path,
    *,
    claude: dict[str, object] | None = None,
    claude_local: dict[str, object] | None = None,
    auto: AutoAgentConfigStore | None = None,
    environ: dict[str, str] | None = None,
) -> EngineConfigResolver:
    env = environ if environ is not None else {}
    return EngineConfigResolver(
        claude=_reader(tmp_path, claude, claude_local, env),
        autoagent=auto or AutoAgentConfigStore(tmp_path / "autoagent" / "settings.json"),
        environ=env,
    )


def test_model_override_wins(tmp_path: Path) -> None:
    resolver = _resolver(
        tmp_path,
        claude={"env": {"ANTHROPIC_MODEL": "claude-env"}},
        auto=_auto(tmp_path, model="auto-model"),
        environ={"ANTHROPIC_MODEL": "process-model"},
    )
    resolution = resolver.resolve("desktop-override")
    assert resolution.model == "desktop-override"
    assert resolution.source == "override"


def test_claude_env_model_wins(tmp_path: Path) -> None:
    resolver = _resolver(
        tmp_path,
        claude={"env": {"ANTHROPIC_MODEL": "claude-env"}, "model": "claude-top"},
        auto=_auto(tmp_path, model="auto-model"),
        environ={"ANTHROPIC_MODEL": "process-model"},
    )
    resolution = resolver.resolve()
    assert resolution.model == "claude-env"
    assert resolution.source == "claude-settings"
    assert resolution.config_path == str(
        (tmp_path / "claude" / "settings.json").resolve()
    )


def test_claude_top_level_model_wins_over_autoagent(tmp_path: Path) -> None:
    resolver = _resolver(
        tmp_path,
        claude={"model": "claude-top"},
        auto=_auto(tmp_path, model="auto-model"),
        environ={"ANTHROPIC_MODEL": "process-model"},
    )
    resolution = resolver.resolve()
    assert resolution.model == "claude-top"
    assert resolution.source == "claude-settings"


def test_autoagent_model_wins_over_process_env(tmp_path: Path) -> None:
    store = _auto(tmp_path, model="auto-model")
    resolver = _resolver(
        tmp_path, auto=store, environ={"ANTHROPIC_MODEL": "process-model"}
    )
    resolution = resolver.resolve()
    assert resolution.model == "auto-model"
    assert resolution.source == "autoagent"
    assert resolution.config_path == store.config_path
    assert resolution.autoagent_config_path == store.config_path


def test_process_env_model_then_default(tmp_path: Path) -> None:
    process = _resolver(tmp_path, environ={"ANTHROPIC_MODEL": "process-model"})
    resolution = process.resolve()
    assert resolution.model == "process-model"
    assert resolution.source == "env"

    empty = _resolver(tmp_path / "empty")
    resolution = empty.resolve()
    assert resolution.model is None
    assert resolution.source == "default"


def test_credentials_precedence(tmp_path: Path) -> None:
    claude_wins = _resolver(
        tmp_path,
        claude={"env": {"ANTHROPIC_AUTH_TOKEN": "claude-token"}},
        auto=_auto(tmp_path, api_key="auto-key"),
        environ={"ANTHROPIC_API_KEY": "process-key"},
    ).resolve()
    assert claude_wins.credential_source == "claude-settings"
    assert claude_wins.credentials_configured is True

    helper_wins = _resolver(
        tmp_path / "helper",
        claude={"apiKeyHelper": "/usr/bin/helper"},
        auto=_auto(tmp_path / "helper", api_key="auto-key"),
    ).resolve()
    assert helper_wins.credential_source == "claude-settings"

    autoagent_wins = _resolver(
        tmp_path / "auto",
        auto=_auto(tmp_path / "auto", api_key="auto-key"),
        environ={"ANTHROPIC_API_KEY": "process-key"},
    ).resolve()
    assert autoagent_wins.credential_source == "autoagent"

    autohelper = _resolver(
        tmp_path / "autohelper",
        auto=_auto(tmp_path / "autohelper", api_key_helper="/usr/bin/auto-helper"),
    ).resolve()
    assert autohelper.credential_source == "autoagent"

    env_wins = _resolver(
        tmp_path / "env", environ={"ANTHROPIC_AUTH_TOKEN": "process-token"}
    ).resolve()
    assert env_wins.credential_source == "env"

    none = _resolver(tmp_path / "none").resolve()
    assert none.credential_source == "none"
    assert none.credentials_configured is False


def test_base_url_precedence(tmp_path: Path) -> None:
    claude_wins = _resolver(
        tmp_path,
        claude={"env": {"ANTHROPIC_BASE_URL": "https://claude.invalid"}},
        auto=_auto(tmp_path, base_url="https://auto.invalid"),
        environ={"ANTHROPIC_BASE_URL": "https://process.invalid"},
    ).resolve()
    assert claude_wins.base_url == "https://claude.invalid"
    assert claude_wins.base_url_source == "claude-settings"

    auto_wins = _resolver(
        tmp_path / "auto",
        auto=_auto(tmp_path / "auto", base_url="https://auto.invalid"),
        environ={"ANTHROPIC_BASE_URL": "https://process.invalid"},
    ).resolve()
    assert auto_wins.base_url == "https://auto.invalid"
    assert auto_wins.base_url_source == "autoagent"

    env_wins = _resolver(
        tmp_path / "env", environ={"ANTHROPIC_BASE_URL": "https://process.invalid"}
    ).resolve()
    assert env_wins.base_url == "https://process.invalid"
    assert env_wins.base_url_source == "env"

    none = _resolver(tmp_path / "none").resolve()
    assert none.base_url is None
    assert none.base_url_source == "none"


def test_apply_environment_exports_autoagent_values(tmp_path: Path) -> None:
    environment: dict[str, str] = {}
    store = _auto(
        tmp_path,
        base_url="https://auto.invalid",
        api_key="sk-auto-secret",
    )
    resolver = EngineConfigResolver(
        claude=_reader(tmp_path, environ=environment),
        autoagent=store,
        environ=environment,
    )
    resolution = resolver.resolve()
    assert "sk-auto-secret" not in repr(resolution)
    resolver.apply_environment()
    assert environment["ANTHROPIC_AUTH_TOKEN"] == "sk-auto-secret"
    assert environment["ANTHROPIC_BASE_URL"] == "https://auto.invalid"


def test_apply_environment_never_overrides_claude_settings(tmp_path: Path) -> None:
    environment: dict[str, str] = {}
    store = _auto(tmp_path, api_key="sk-auto-secret", base_url="https://auto.invalid")
    resolver = EngineConfigResolver(
        claude=_reader(
            tmp_path,
            {
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "claude-token",
                    "ANTHROPIC_BASE_URL": "https://claude.invalid",
                }
            },
            environ=environment,
        ),
        autoagent=store,
        environ=environment,
    )
    resolver.apply_environment()
    assert "ANTHROPIC_AUTH_TOKEN" not in environment
    assert "ANTHROPIC_BASE_URL" not in environment


def test_apply_environment_restores_process_values_when_cleared(
    tmp_path: Path,
) -> None:
    environment = {
        "ANTHROPIC_AUTH_TOKEN": "process-token",
        "ANTHROPIC_BASE_URL": "https://process.invalid",
    }
    store = _auto(
        tmp_path,
        api_key="auto-key",
        base_url="https://auto.invalid",
    )
    resolver = EngineConfigResolver(
        claude=_reader(tmp_path, environ=environment),
        autoagent=store,
        environ=environment,
    )
    resolver.apply_environment()
    assert environment["ANTHROPIC_AUTH_TOKEN"] == "auto-key"
    assert environment["ANTHROPIC_BASE_URL"] == "https://auto.invalid"

    store.update(AutoAgentConfigPatch(api_key="", base_url=""))
    resolver.apply_environment()
    assert environment["ANTHROPIC_AUTH_TOKEN"] == "process-token"
    assert environment["ANTHROPIC_BASE_URL"] == "https://process.invalid"


def test_apply_environment_removes_values_when_no_original(
    tmp_path: Path,
) -> None:
    environment: dict[str, str] = {}
    store = _auto(tmp_path, api_key="auto-key", base_url="https://auto.invalid")
    resolver = EngineConfigResolver(
        claude=_reader(tmp_path, environ=environment),
        autoagent=store,
        environ=environment,
    )
    resolver.apply_environment()
    assert set(environment) == {
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
    }
    store.update(AutoAgentConfigPatch(api_key="", base_url=""))
    resolver.apply_environment()
    assert environment == {}


def test_apply_environment_does_not_export_process_values(tmp_path: Path) -> None:
    environment = {"ANTHROPIC_AUTH_TOKEN": "process-token"}
    store = _auto(tmp_path)
    resolver = EngineConfigResolver(
        claude=_reader(tmp_path, environ=environment),
        autoagent=store,
        environ=environment,
    )
    resolver.apply_environment()
    assert environment == {"ANTHROPIC_AUTH_TOKEN": "process-token"}
