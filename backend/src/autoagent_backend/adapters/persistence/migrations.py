"""Schema ownership and migrations.

``schema_migrations`` records applied versions. Each version is applied in one
transaction; re-running is a no-op.
"""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Sequence

from .sqlite import SqliteDatabase

_VERSION_1: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        engine_session_ref TEXT,
        engine_ref_updated_at INTEGER,
        deleted_at INTEGER,
        meta_json TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        meta_json TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at, id)
    """,
    """
    CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        stop_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        assistant_message_id TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_turns_session_state
        ON turns(session_id, state)
    """,
    """
    CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        document TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS mcp_servers (
        name TEXT PRIMARY KEY,
        spec_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_run INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_sessions_updated
        ON sessions(deleted_at, updated_at DESC)
    """,
)

MIGRATIONS: tuple[tuple[int, tuple[str, ...]], ...] = ((1, _VERSION_1),)


def migrate(db: SqliteDatabase, *, now_ms: int | None = None) -> list[int]:
    """Apply all pending migrations.

    Post: returns the versions applied by this call, in ascending order.
    Raises: ``sqlite3.Error`` if a migration fails; the transaction is rolled
            back and no partial version is recorded.
    """

    now = int(time.time() * 1000) if now_ms is None else now_ms
    applied: list[int] = []
    with db.transaction() as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
        )
        existing = {
            int(row[0])
            for row in connection.execute("SELECT version FROM schema_migrations").fetchall()
        }
        for version, statements in MIGRATIONS:
            if version in existing:
                continue
            _execute_all(connection, statements)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, now),
            )
            applied.append(version)
    return applied


def _execute_all(connection: sqlite3.Connection, statements: Sequence[str]) -> None:
    for statement in statements:
        connection.execute(statement)
