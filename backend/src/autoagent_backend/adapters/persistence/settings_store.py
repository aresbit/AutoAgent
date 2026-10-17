"""SQLite-backed settings aggregate with unknown-field preservation."""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Mapping

from ...domain.errors import (
    InvalidSettings,
    PermissionModeUnsupported,
    ProviderNotFound,
)
from ...domain.models import (
    Layout,
    PermissionPolicy,
    Provider,
    ProviderCatalog,
    Settings,
    SettingsPatch,
)
from ...domain.ports import ClockPort
from .sqlite import SqliteDatabase

SCHEMA_VERSION = 1

_BUILTIN_PROVIDERS: tuple[Provider, ...] = (
    Provider(
        id="matebot",
        name="MateBot (OpenCC)",
        api_type=None,
        base_url=None,
        models=(),
        allow_custom_models=True,
    ),
)

# Models that used to be the implied Anthropic defaults. They are cleared when a
# legacy provider is migrated so opencc/MateBot falls back to its own choice.
_LEGACY_DEFAULT_MODELS = frozenset(
    {
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    }
)

_KNOWN_FIELDS = {field.name for field in dataclasses.fields(Settings)}


class SqliteSettingsStore:
    """Implements ``SettingsPort``.

    The stored document may contain fields this version does not know about; they
    are preserved verbatim across updates.
    """

    def __init__(self, db: SqliteDatabase, clock: ClockPort, *, default_cwd: str) -> None:
        self._db = db
        self._clock = clock
        self._default_cwd = default_cwd

    def read(self) -> Settings:
        row = self._db.query_one("SELECT document FROM settings WHERE id = 1")
        if row is None:
            return self._defaults()
        try:
            document = json.loads(str(row["document"]))
        except json.JSONDecodeError as exc:
            raise InvalidSettings("stored settings document is not valid JSON") from exc
        if not isinstance(document, dict):
            raise InvalidSettings("stored settings document must be an object")
        return self._from_document(document)

    def update(self, patch: SettingsPatch) -> Settings:
        document = self._read_document()
        if patch.permission_mode not in (None, PermissionPolicy.FULL_ACCESS.value):
            raise PermissionModeUnsupported(
                "v1 supports permissionMode='bypassPermissions' only"
            )
        for field in dataclasses.fields(patch):
            value = getattr(patch, field.name)
            if value is None:
                continue
            if field.name == "layout":
                assert isinstance(value, Layout)
                document["layout"] = dataclasses.asdict(value)
            elif isinstance(value, tuple):
                document[field.name] = list(value)
            else:
                document[field.name] = value
        _migrate_provider(document)
        self._write_document(document)
        return self._from_document(document)

    def provider(self, provider_id: str) -> Provider:
        for provider in _BUILTIN_PROVIDERS:
            if provider.id == provider_id:
                return provider
        raise ProviderNotFound(f"provider {provider_id} is not configured")

    def providers(self) -> ProviderCatalog:
        return ProviderCatalog(builtin=_BUILTIN_PROVIDERS, custom=())

    # -- internals ---------------------------------------------------------

    def _defaults(self) -> Settings:
        return Settings(cwd=self._default_cwd)

    def _read_document(self) -> dict[str, object]:
        row = self._db.query_one("SELECT document FROM settings WHERE id = 1")
        if row is None:
            return dataclasses.asdict(self._defaults())
        try:
            document = json.loads(str(row["document"]))
        except json.JSONDecodeError as exc:
            raise InvalidSettings("stored settings document is not valid JSON") from exc
        if not isinstance(document, dict):
            raise InvalidSettings("stored settings document must be an object")
        return document

    def _write_document(self, document: Mapping[str, object]) -> None:
        now = self._clock.now_ms()
        payload = json.dumps(dict(document), separators=(",", ":"), sort_keys=True)
        with self._db.transaction() as connection:
            connection.execute(
                """
                INSERT INTO settings(id, document, schema_version, updated_at)
                VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    document = excluded.document,
                    schema_version = excluded.schema_version,
                    updated_at = excluded.updated_at
                """,
                (payload, SCHEMA_VERSION, now),
            )

    def _from_document(self, document: Mapping[str, object]) -> Settings:
        values: dict[str, object] = {}
        for key, value in document.items():
            if key not in _KNOWN_FIELDS:
                continue
            if key in {"allowed_tools", "disallowed_tools", "add_dirs"}:
                values[key] = tuple(str(item) for item in value) if isinstance(value, list) else ()
            elif key == "layout":
                values[key] = _layout_from(value)
            else:
                values[key] = value

        # Provider migration: the backend is MateBot/opencc, never a direct
        # Anthropic client.
        _migrate_provider(values)

        cwd = values.get("cwd")
        if not isinstance(cwd, str) or not cwd:
            values["cwd"] = self._default_cwd
        permission = values.get("permission_mode")
        if permission != PermissionPolicy.FULL_ACCESS.value:
            values["permission_mode"] = PermissionPolicy.FULL_ACCESS.value
        try:
            return Settings(**values)  # type: ignore[arg-type]
        except (TypeError, ValueError) as exc:
            raise InvalidSettings("stored settings document has invalid field types") from exc


def _migrate_provider(values: dict[str, object]) -> None:
    """Normalize a legacy provider id to MateBot.

    Post: a stored provider other than ``matebot`` becomes ``matebot``. If that
          legacy provider carried one of the old built-in model defaults, the
          model is cleared so opencc chooses its own default. Any other model is
          preserved.
    """

    if "provider_id" not in values or values.get("provider_id") == "matebot":
        return
    values["provider_id"] = "matebot"
    model = values.get("model")
    if isinstance(model, str) and model in _LEGACY_DEFAULT_MODELS:
        values["model"] = ""


def _layout_from(value: object) -> Layout:
    if not isinstance(value, dict):
        return Layout()
    defaults = Layout()
    return Layout(
        left_open=bool(value.get("left_open", defaults.left_open)),
        left_width=_int_value(value.get("left_width"), defaults.left_width),
        right_open=bool(value.get("right_open", defaults.right_open)),
        right_width=_int_value(value.get("right_width"), defaults.right_width),
    )


def _int_value(value: object, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default
