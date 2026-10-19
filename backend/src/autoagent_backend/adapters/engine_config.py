"""Resolve effective engine settings from Claude config, AutoAgent config and env.

Precedence (highest first):
  model:       desktop override -> Claude env.ANTHROPIC_MODEL -> Claude model
               -> AutoAgent model -> process ANTHROPIC_MODEL -> default
  credentials: Claude token/apiKeyHelper -> AutoAgent apiKey/apiKeyHelper
               -> process ANTHROPIC_* token -> none
  base URL:    Claude env.ANTHROPIC_BASE_URL -> AutoAgent baseURL
               -> process ANTHROPIC_BASE_URL

Only values from the selected source are exported to the process environment
for the engine child. ``api_credential_source`` selects the source explicitly;
``auto`` keeps the documented precedence (Claude, AutoAgent, env).
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable, MutableMapping

from ..domain.models import (
    API_CREDENTIAL_SOURCES,
    AutoAgentConfig,
    ModelResolution,
)
from ..domain.ports import AutoAgentConfigPort
from .claude_settings import ClaudeSettingsReader

LOG = logging.getLogger("autoagent.engine_config")

_PROCESS_CREDENTIAL_KEYS: tuple[str, ...] = (
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
)


class EngineConfigResolver:
    """Implements ``EngineConfigPort``."""

    def __init__(
        self,
        *,
        claude: ClaudeSettingsReader,
        autoagent: AutoAgentConfigPort,
        environ: MutableMapping[str, str] | None = None,
        preference_provider: Callable[[], str] | None = None,
    ) -> None:
        self._claude = claude
        self._autoagent = autoagent
        self._environ = environ
        self._preference_provider = preference_provider
        self._env_lock = threading.Lock()
        # Original process values for keys we overrode from AutoAgent, so
        # clearing the config restores the previous environment instead of
        # leaving a stale secret behind.
        self._overridden: dict[str, str | None] = {}

    def _preference(self) -> str:
        provider = self._preference_provider
        if provider is None:
            return "auto"
        try:
            value = provider()
        except Exception:
            LOG.warning("could not read the API credential source", exc_info=True)
            return "auto"
        return value if value in API_CREDENTIAL_SOURCES else "auto"

    def resolve(
        self, override: str | None = None, *, preference: str | None = None
    ) -> ModelResolution:
        snapshot = self._claude.snapshot()
        autoagent = self._read_autoagent()
        process = self._process_environ()

        chosen_override = _non_empty(override)
        auto_model = _non_empty(autoagent.model)
        process_model = _non_empty(process.get("ANTHROPIC_MODEL"))
        pref = preference if preference in API_CREDENTIAL_SOURCES else self._preference()
        if pref not in API_CREDENTIAL_SOURCES:
            pref = "auto"

        model: str | None
        if chosen_override is not None:
            model, source, config_path = (
                chosen_override,
                "override",
                snapshot.config_path,
            )
        elif pref == "claude":
            if snapshot.env_model is not None or snapshot.model is not None:
                model = snapshot.env_model or snapshot.model
                source, config_path = "claude-settings", snapshot.config_path
            else:
                model, source, config_path = None, "default", snapshot.config_path
        elif pref == "autoagent":
            if auto_model is not None:
                model, source, config_path = (
                    auto_model,
                    "autoagent",
                    self._autoagent.config_path,
                )
            else:
                model, source, config_path = None, "default", snapshot.config_path
        elif pref == "env":
            if process_model is not None:
                model, source, config_path = (
                    process_model,
                    "env",
                    snapshot.config_path,
                )
            else:
                model, source, config_path = None, "default", snapshot.config_path
        elif snapshot.env_model is not None:
            model, source, config_path = (
                snapshot.env_model,
                "claude-settings",
                snapshot.config_path,
            )
        elif snapshot.model is not None:
            model, source, config_path = (
                snapshot.model,
                "claude-settings",
                snapshot.config_path,
            )
        elif auto_model is not None:
            model, source, config_path = (
                auto_model,
                "autoagent",
                self._autoagent.config_path,
            )
        elif process_model is not None:
            model, source, config_path = (
                process_model,
                "env",
                snapshot.config_path,
            )
        else:
            model, source, config_path = (None, "default", snapshot.config_path)

        claude_credentials = (
            snapshot.has_env_credentials or snapshot.api_key_helper is not None
        )
        autoagent_credentials = bool(autoagent.api_key or autoagent.api_key_helper)
        process_credentials = any(
            _non_empty(process.get(key)) for key in _PROCESS_CREDENTIAL_KEYS
        )
        if pref == "claude":
            credential_source = "claude-settings" if claude_credentials else "none"
        elif pref == "autoagent":
            credential_source = "autoagent" if autoagent_credentials else "none"
        elif pref == "env":
            credential_source = "env" if process_credentials else "none"
        elif claude_credentials:
            credential_source = "claude-settings"
        elif autoagent_credentials:
            credential_source = "autoagent"
        elif process_credentials:
            credential_source = "env"
        else:
            credential_source = "none"

        auto_base = _non_empty(autoagent.base_url)
        process_base = _non_empty(process.get("ANTHROPIC_BASE_URL"))
        if pref == "claude":
            base_url = snapshot.base_url
            base_url_source = "claude-settings" if base_url is not None else "none"
        elif pref == "autoagent":
            base_url = auto_base
            base_url_source = "autoagent" if base_url is not None else "none"
        elif pref == "env":
            base_url = process_base
            base_url_source = "env" if base_url is not None else "none"
        elif snapshot.base_url is not None:
            base_url, base_url_source = snapshot.base_url, "claude-settings"
        elif auto_base is not None:
            base_url, base_url_source = auto_base, "autoagent"
        elif process_base is not None:
            base_url, base_url_source = process_base, "env"
        else:
            base_url, base_url_source = None, "none"

        return ModelResolution(
            model=model,
            source=source,
            config_path=config_path,
            credentials_configured=credential_source != "none",
            autoagent_config_path=self._autoagent.config_path,
            credential_source=credential_source,
            base_url=base_url,
            base_url_source=base_url_source,
        )

    def apply_environment(self, *, preference: str | None = None) -> None:
        """Export the selected source's values for the vendored engine child.

        Post: sets ``ANTHROPIC_MODEL`` / ``ANTHROPIC_AUTH_TOKEN`` /
              ``ANTHROPIC_BASE_URL`` only for values sourced from the AutoAgent
              config; every other selection clears the override and restores the
              process's original environment. Secret values are never logged.
        """

        resolution = self.resolve(None, preference=preference)
        target = self._process_environ()
        base_url = (
            resolution.base_url
            if resolution.base_url_source == "autoagent"
            else None
        )
        api_key = None
        if resolution.credential_source == "autoagent":
            api_key = _non_empty(self._read_autoagent().api_key)
        model = (
            _non_empty(self._read_autoagent().model)
            if resolution.source == "autoagent"
            else None
        )
        with self._env_lock:
            self._sync_env(target, "ANTHROPIC_MODEL", model)
            self._sync_env(target, "ANTHROPIC_BASE_URL", base_url)
            self._sync_env(target, "ANTHROPIC_AUTH_TOKEN", api_key)

    # -- helpers -----------------------------------------------------------

    def _sync_env(
        self,
        target: MutableMapping[str, str],
        name: str,
        desired: str | None,
    ) -> None:
        if desired is not None:
            if name not in self._overridden:
                self._overridden[name] = target.get(name)
            target[name] = desired
            return
        if name not in self._overridden:
            return
        original = self._overridden.pop(name)
        if original is None:
            target.pop(name, None)
        else:
            target[name] = original

    def _read_autoagent(self) -> AutoAgentConfig:
        try:
            return self._autoagent.read()
        except Exception:
            # A corrupt frontend config must not break boot or health; the API
            # surfaces the error when the user reads/writes it.
            LOG.warning("could not read the AutoAgent config", exc_info=True)
            return AutoAgentConfig()

    def _process_environ(self) -> MutableMapping[str, str]:
        return os.environ if self._environ is None else self._environ


def _non_empty(value: object) -> str | None:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    return None
