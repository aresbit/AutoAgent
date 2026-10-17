"""Frontend-editable AutoAgent config at ``<data_dir>/settings.json``.

Writes are atomic (temp file in the same directory + ``os.replace``) and the
file is mode 0600. The apiKey is never logged and never serialized to a DTO.
Unknown fields are preserved.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from ..domain.errors import InvalidSettings
from ..domain.models import AutoAgentConfig, AutoAgentConfigPatch

LOG = logging.getLogger("autoagent.config")

_FIELD_MAP: tuple[tuple[str, str], ...] = (
    ("model", "model"),
    ("baseURL", "base_url"),
    ("apiKey", "api_key"),
    ("apiKeyHelper", "api_key_helper"),
)


class AutoAgentConfigStore:
    """Implements ``AutoAgentConfigPort``."""

    def __init__(self, path: Path) -> None:
        self._path = path

    @property
    def config_path(self) -> str:
        return str(self._path)

    def read(self) -> AutoAgentConfig:
        document = self._read_document()
        return _config_from(document)

    def update(self, patch: AutoAgentConfigPatch) -> AutoAgentConfig:
        document = self._read_document()
        for key, attribute in _FIELD_MAP:
            value = getattr(patch, attribute)
            if value is None:
                continue
            cleaned = value.strip()
            if cleaned:
                document[key] = cleaned
            else:
                document.pop(key, None)
        self._write_document(document)
        return _config_from(document)

    # -- internals ---------------------------------------------------------

    def _read_document(self) -> dict[str, Any]:
        try:
            text = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as exc:
            raise InvalidSettings(
                "could not read the AutoAgent config file"
            ) from exc
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InvalidSettings(
                "the AutoAgent config file is not valid JSON"
            ) from exc
        if not isinstance(value, dict):
            raise InvalidSettings("the AutoAgent config must be a JSON object")
        return dict(value)

    def _write_document(self, document: dict[str, Any]) -> None:
        payload = json.dumps(
            document,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ) + "\n"
        try:
            parent = self._path.parent
            created = not parent.exists()
            parent.mkdir(parents=True, exist_ok=True)
            if created:
                try:
                    parent.chmod(0o700)
                except OSError:
                    pass
            fd, temporary = tempfile.mkstemp(
                prefix=".settings-",
                suffix=".json",
                dir=str(self._path.parent),
            )
        except OSError as exc:
            raise InvalidSettings(
                "could not create the AutoAgent config file"
            ) from exc

        temporary_path = Path(temporary)
        try:
            try:
                os.fchmod(fd, 0o600)
            except (AttributeError, OSError):
                pass
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self._path)
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass
            _fsync_directory(self._path.parent)
        except OSError as exc:
            raise InvalidSettings(
                "could not write the AutoAgent config file"
            ) from exc
        finally:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass


def _config_from(document: dict[str, Any]) -> AutoAgentConfig:
    return AutoAgentConfig(
        model=_string(document.get("model")),
        base_url=_string(document.get("baseURL")),
        api_key=_string(document.get("apiKey")),
        api_key_helper=_string(document.get("apiKeyHelper")),
    )


def _string(value: object) -> str | None:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    return None


def _fsync_directory(directory: Path) -> None:
    """Best-effort durability for the rename; unsupported on some platforms."""

    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
