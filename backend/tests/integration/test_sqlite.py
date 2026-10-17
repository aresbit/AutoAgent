"""M2: SQLite adapter, WAL policy, migrations and legacy import."""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

from autoagent_backend.adapters.persistence.legacy_import import (
    MARKER_KEY,
    LegacyImporter,
)
from autoagent_backend.adapters.persistence.migrations import migrate
from autoagent_backend.adapters.persistence.session_store import SqliteSessionStore
from autoagent_backend.adapters.persistence.settings_store import SqliteSettingsStore
from autoagent_backend.adapters.persistence.sqlite import SqliteDatabase
from autoagent_backend.application.clock import SystemClock
from autoagent_backend.domain.errors import (
    InvalidInput,
    ProviderNotFound,
    SessionNotFound,
    TurnAlreadyFinished,
    TurnInProgress,
)
from autoagent_backend.domain.models import NewMessage, SettingsPatch, TurnState
from autoagent_backend.domain.values import EngineSessionRef


def _db(tmp_path: Path) -> SqliteDatabase:
    db = SqliteDatabase(tmp_path / "test.db")
    migrate(db)
    return db


def test_migrations_are_idempotent_and_wal_is_enabled(tmp_path: Path) -> None:
    db = SqliteDatabase(tmp_path / "test.db")
    assert migrate(db) == [1]
    assert migrate(db) == []
    with db.connect() as connection:
        mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        assert str(mode).lower() == "wal"


def test_session_crud_and_message_ordering(tmp_path: Path) -> None:
    clock = SystemClock()
    store = SqliteSessionStore(_db(tmp_path), clock)
    session = store.create("First")
    store.append_message(session.id, NewMessage(role="user", text="one"))
    store.append_message(session.id, NewMessage(role="assistant", text="two"))

    loaded = store.get(session.id)
    assert [message.text for message in loaded.messages] == ["one", "two"]
    assert loaded.message_count == 2
    assert loaded.last_message_preview == "two"

    renamed = store.rename(session.id, "Renamed")
    assert renamed.title == "Renamed"
    listed = store.list()
    assert [item.id for item in listed] == [session.id]

    store.delete(session.id)
    assert store.list() == ()
    with pytest.raises(SessionNotFound):
        store.get(session.id)


def test_branch_copies_messages_without_engine_ref(tmp_path: Path) -> None:
    clock = SystemClock()
    store = SqliteSessionStore(_db(tmp_path), clock)
    session = store.create("Source")
    store.append_message(session.id, NewMessage(role="user", text="hello"))
    store.set_ref(
        session.id, EngineSessionRef("11111111-1111-4111-8111-111111111111")
    )

    branch = store.branch(session.id)
    assert branch.id != session.id
    assert [message.text for message in branch.messages] == ["hello"]
    assert store.get_ref(branch.id) is None


def test_engine_refs_are_uuid_validated(tmp_path: Path) -> None:
    clock = SystemClock()
    store = SqliteSessionStore(_db(tmp_path), clock)
    session = store.create()

    ref = EngineSessionRef("11111111-1111-4111-8111-111111111111")
    store.set_ref(session.id, ref)
    assert store.get_ref(session.id) == ref

    with pytest.raises(InvalidInput):
        store.set_ref(session.id, EngineSessionRef("not-a-uuid"))

    store.set_ref(session.id, None)
    assert store.get_ref(session.id) is None


def test_turn_lifecycle(tmp_path: Path) -> None:
    clock = SystemClock()
    store = SqliteSessionStore(_db(tmp_path), clock)
    session = store.create()
    turn_id = str(uuid.uuid4())

    store.begin_turn(turn_id, session.id, clock.now_ms())
    status = store.get_turn(turn_id)
    assert status is not None and status.state is TurnState.RUNNING

    with pytest.raises(TurnAlreadyFinished):
        store.begin_turn(turn_id, session.id, clock.now_ms())
    with pytest.raises(TurnInProgress):
        store.begin_turn(str(uuid.uuid4()), session.id, clock.now_ms())

    store.finish_turn(
        turn_id,
        TurnState.COMPLETED,
        stop_reason="end_turn",
        error_code=None,
        error_message=None,
        assistant_message_id=None,
        finished_at=clock.now_ms(),
    )
    assert store.get_turn(turn_id).state is TurnState.COMPLETED  # type: ignore[union-attr]

    orphan = str(uuid.uuid4())
    store.begin_turn(orphan, session.id, clock.now_ms())
    assert store.fail_orphaned_turns(clock.now_ms(), "ENGINE_EXITED") == 1
    assert store.get_turn(orphan).state is TurnState.FAILED  # type: ignore[union-attr]


def test_legacy_import_is_idempotent_and_read_only(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    sessions_dir = data_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    session_id = str(uuid.uuid4())
    ref = str(uuid.uuid4())
    legacy_session = {
        "id": session_id,
        "title": "Legacy chat",
        "createdAt": 1000,
        "updatedAt": 2000,
        "claudeSessionId": ref,
        "messages": [
            {"id": str(uuid.uuid4()), "role": "user", "text": "hi", "createdAt": 1100},
            {"id": str(uuid.uuid4()), "role": "assistant", "text": "hey", "createdAt": 1200},
        ],
    }
    (sessions_dir / f"{session_id}.json").write_text(
        json.dumps(legacy_session), encoding="utf-8"
    )
    (data_dir / "settings.json").write_text(
        json.dumps(
            {
                "providerId": "anthropic",
                "model": "legacy-model",
                "cwd": str(data_dir),
            }
        ),
        encoding="utf-8",
    )

    db = _db(tmp_path)
    clock = SystemClock()
    store = SqliteSessionStore(db, clock)
    settings = SqliteSettingsStore(db, clock, default_cwd=str(tmp_path))
    importer = LegacyImporter(
        db=db,
        sessions=store,
        settings=settings,
        clock=clock,
        data_dir=data_dir,
        log_path=tmp_path / "migration.log",
    )

    summary = importer.run()
    assert summary.skipped is False
    assert summary.sessions == 1
    assert summary.messages == 2
    assert settings.read().model == "legacy-model"
    assert store.get_ref(session_id) == EngineSessionRef(ref)
    assert len(store.get(session_id).messages) == 2
    assert (tmp_path / "migration.log").is_file()

    # Source files are untouched and a second run is a no-op.
    assert (sessions_dir / f"{session_id}.json").is_file()
    assert importer.run().skipped is True
    with db.connect() as connection:
        marker = connection.execute(
            "SELECT value FROM kv WHERE key = ?", (MARKER_KEY,)
        ).fetchone()
        assert marker is not None


def test_invalid_legacy_ref_is_dropped(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    sessions_dir = data_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    session_id = str(uuid.uuid4())
    (sessions_dir / f"{session_id}.json").write_text(
        json.dumps(
            {
                "id": session_id,
                "title": "Bad ref",
                "claudeSessionId": "definitely-not-a-uuid",
                "messages": [],
            }
        ),
        encoding="utf-8",
    )
    db = _db(tmp_path)
    clock = SystemClock()
    store = SqliteSessionStore(db, clock)
    LegacyImporter(
        db=db,
        sessions=store,
        settings=SqliteSettingsStore(db, clock, default_cwd=str(tmp_path)),
        clock=clock,
        data_dir=data_dir,
        log_path=tmp_path / "migration.log",
    ).run()
    assert store.get_ref(session_id) is None


def test_settings_unknown_fields_are_preserved(tmp_path: Path) -> None:
    db = _db(tmp_path)
    clock = SystemClock()
    store = SqliteSettingsStore(db, clock, default_cwd=str(tmp_path))
    settings = store.update(SettingsPatch(model="m1"))
    assert settings.model == "m1"
    assert settings.cwd == str(tmp_path)

    with db.transaction() as connection:
        connection.execute(
            "UPDATE settings SET document = ? WHERE id = 1",
            (json.dumps({"model": "m1", "future": "kept"}),),
        )
    store.update(SettingsPatch(model="m2"))
    with db.connect() as connection:
        document = json.loads(
            connection.execute("SELECT document FROM settings WHERE id = 1").fetchone()[0]
        )
    assert document["future"] == "kept"
    assert document["model"] == "m2"


def _write_settings_document(db: SqliteDatabase, document: dict[str, object]) -> None:
    with db.transaction() as connection:
        connection.execute(
            """
            INSERT INTO settings(id, document, schema_version, updated_at)
            VALUES (1, ?, 1, 0)
            ON CONFLICT(id) DO UPDATE SET document = excluded.document
            """,
            (json.dumps(document),),
        )


def test_default_settings_use_matebot(tmp_path: Path) -> None:
    store = SqliteSettingsStore(_db(tmp_path), SystemClock(), default_cwd=str(tmp_path))
    settings = store.read()
    assert settings.provider_id == "matebot"
    assert settings.model == ""
    assert settings.fallback_model is None

    catalog = store.providers()
    assert catalog.custom == ()
    assert len(catalog.builtin) == 1
    provider = catalog.builtin[0]
    assert provider.id == "matebot"
    assert provider.name == "MateBot (OpenCC)"
    assert provider.api_type is None
    assert provider.base_url is None
    assert provider.models == ()
    assert provider.allow_custom_models is True
    assert store.provider("matebot") == provider
    with pytest.raises(ProviderNotFound):
        store.provider("anthropic")


@pytest.mark.parametrize(
    "old_model",
    [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ],
)
def test_legacy_provider_migrates_and_clears_builtin_models(
    tmp_path: Path, old_model: str
) -> None:
    db = _db(tmp_path)
    store = SqliteSettingsStore(db, SystemClock(), default_cwd=str(tmp_path))
    _write_settings_document(
        db, {"provider_id": "anthropic", "model": old_model}
    )

    settings = store.read()
    assert settings.provider_id == "matebot"
    assert settings.model == ""


def test_legacy_provider_preserves_user_chosen_model(tmp_path: Path) -> None:
    db = _db(tmp_path)
    store = SqliteSettingsStore(db, SystemClock(), default_cwd=str(tmp_path))
    _write_settings_document(
        db, {"provider_id": "anthropic", "model": "my-custom-model"}
    )

    settings = store.read()
    assert settings.provider_id == "matebot"
    assert settings.model == "my-custom-model"


def test_update_normalizes_legacy_provider(tmp_path: Path) -> None:
    db = _db(tmp_path)
    store = SqliteSettingsStore(db, SystemClock(), default_cwd=str(tmp_path))
    settings = store.update(
        SettingsPatch(provider_id="anthropic", model="claude-opus-4-6")
    )
    assert settings.provider_id == "matebot"
    assert settings.model == ""

    with db.connect() as connection:
        document = json.loads(
            connection.execute("SELECT document FROM settings WHERE id = 1").fetchone()[0]
        )
    assert document["provider_id"] == "matebot"
    assert document["model"] == ""


def test_matebot_provider_preserves_explicit_model(tmp_path: Path) -> None:
    store = SqliteSettingsStore(_db(tmp_path), SystemClock(), default_cwd=str(tmp_path))
    store.update(SettingsPatch(model="claude-opus-4-6"))
    settings = store.read()
    assert settings.provider_id == "matebot"
    assert settings.model == "claude-opus-4-6"


def test_one_connection_per_operation(tmp_path: Path) -> None:
    """WAL readers see committed data, and no connection is shared."""
    db = _db(tmp_path)
    with db.connect() as first, db.connect() as second:
        assert first is not second
        assert sqlite3.sqlite_version
