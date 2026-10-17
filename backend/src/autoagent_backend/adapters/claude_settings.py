"""Read the opencc/Claude CLI configuration (read-only).

The user's global model may live in ``~/.claude/settings.json`` (or the
directory named by ``CLAUDE_CONFIG_DIR``). The desktop override is optional; when
empty the engine reuses the global model. This adapter never writes these files
and never exposes credentials beyond a boolean flag.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..domain.models import ModelResolution

LOG = logging.getLogger("autoagent.claude_settings")

_SETTINGS_FILE = "settings.json"
_LOCAL_SETTINGS_FILE = "settings.local.json"
_MODEL_ENV_KEY = "ANTHROPIC_MODEL"
_CREDENTIAL_ENV_KEYS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
)


@dataclass(frozen=True, slots=True)
class ClaudeSettingsSnapshot:
    """Safe projection of the merged Claude settings.

    Credential values are reduced to ``has_env_credentials``; no token or key is
    carried here.
    """

    config_path: str
    env_model: str | None
    model: str | None
    base_url: str | None
    api_key_helper: str | None
    has_env_credentials: bool


class ClaudeSettingsReader:
    """Read the Claude CLI configuration (``settings.json`` + local).

    Precedence for the effective model:
      1. desktop override (non-empty ``Settings.model``) -> ``override``
      2. ``settings(.local).json`` ``env.ANTHROPIC_MODEL`` -> ``claude-settings``
      3. ``settings(.local).json`` top-level ``model`` -> ``claude-settings``
      4. process environment ``ANTHROPIC_MODEL`` -> ``env``
      5. none -> ``default``

    ``settings.local.json`` is merged over ``settings.json`` (including the
    ``env`` object), matching CLI local-override behavior.
    """

    def __init__(
        self,
        *,
        config_dir: str | Path | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self._environ = dict(os.environ if environ is None else environ)
        if config_dir is None:
            config_dir = self._environ.get("CLAUDE_CONFIG_DIR", "")
        raw = str(config_dir).strip()
        self._config_dir = (
            Path(raw).expanduser().resolve()
            if raw
            else (Path.home() / ".claude").resolve()
        )

    @property
    def config_dir(self) -> Path:
        return self._config_dir

    @property
    def config_path(self) -> Path:
        return self._config_dir / _SETTINGS_FILE

    def resolve(self, override: str | None = None) -> ModelResolution:
        merged = self._load_merged()
        env_block = _dict(merged.get("env"))
        process_model = _non_empty(self._environ.get(_MODEL_ENV_KEY))
        credentials = self._credentials_configured(merged, env_block)

        chosen_override = _non_empty(override)
        if chosen_override is not None:
            return ModelResolution(
                model=chosen_override,
                source="override",
                config_path=str(self.config_path),
                credentials_configured=credentials,
            )

        configured_env_model = _non_empty(env_block.get(_MODEL_ENV_KEY))
        if configured_env_model is not None:
            return ModelResolution(
                model=configured_env_model,
                source="claude-settings",
                config_path=str(self.config_path),
                credentials_configured=credentials,
            )

        configured_model = _non_empty(merged.get("model"))
        if configured_model is not None:
            return ModelResolution(
                model=configured_model,
                source="claude-settings",
                config_path=str(self.config_path),
                credentials_configured=credentials,
            )

        if process_model is not None:
            return ModelResolution(
                model=process_model,
                source="env",
                config_path=str(self.config_path),
                credentials_configured=credentials,
            )

        return ModelResolution(
            model=None,
            source="default",
            config_path=str(self.config_path),
            credentials_configured=credentials,
        )

    def snapshot(self) -> ClaudeSettingsSnapshot:
        """Return the values the engine-config resolver needs.

        Post: no credential value is included; only its presence flag.
        """

        merged = self._load_merged()
        env_block = _dict(merged.get("env"))
        return ClaudeSettingsSnapshot(
            config_path=str(self.config_path),
            env_model=_non_empty(env_block.get(_MODEL_ENV_KEY)),
            model=_non_empty(merged.get("model")),
            base_url=_non_empty(env_block.get("ANTHROPIC_BASE_URL")),
            api_key_helper=_non_empty(merged.get("apiKeyHelper")),
            has_env_credentials=any(
                _non_empty(env_block.get(key)) is not None
                for key in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")
            ),
        )

    # -- file handling -----------------------------------------------------

    def _load_merged(self) -> dict[str, Any]:
        base = self._load_json(self.config_path)
        local = self._load_json(self._config_dir / _LOCAL_SETTINGS_FILE)
        return _merge(base, local)

    def _load_json(self, path: Path) -> dict[str, Any]:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError:
            LOG.warning("could not read CLI settings file %s", path.name)
            return {}
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            LOG.warning("ignoring invalid JSON in CLI settings file %s", path.name)
            return {}
        return value if isinstance(value, dict) else {}

    def _credentials_configured(
        self, merged: Mapping[str, Any], env_block: Mapping[str, Any]
    ) -> bool:
        for key in _CREDENTIAL_ENV_KEYS:
            if _non_empty(env_block.get(key)) or _non_empty(self._environ.get(key)):
                return True
        return _non_empty(merged.get("apiKeyHelper")) is not None


def _merge(base: Mapping[str, Any], local: Mapping[str, Any]) -> dict[str, Any]:
    """Merge local settings over global settings, including ``env`` keys."""

    merged: dict[str, Any] = dict(base)
    for key, value in local.items():
        base_value = merged.get(key)
        if key == "env" and isinstance(base_value, dict) and isinstance(value, dict):
            merged[key] = {**base_value, **value}
        else:
            merged[key] = value
    return merged


def _dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _non_empty(value: object) -> str | None:
    if isinstance(value, str):
        trimmed = value.strip()
        return trimmed or None
    return None
