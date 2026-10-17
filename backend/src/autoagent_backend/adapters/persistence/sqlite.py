"""SQLite connection policy.

One short-lived connection per operation, WAL mode, 10 s busy timeout, foreign
keys on. The backend is the sole writer; transactions are explicit and are never
held while a turn is streaming.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast


class SqliteDatabase:
    """Thin, representation-hiding wrapper around ``sqlite3``.

    The database file is an implementation detail; callers of this adapter use
    domain stores, not this class. It exists so tests can point the whole stack
    at a temporary file.
    """

    def __init__(self, path: Path) -> None:
        self._path = path

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=10.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        """Yield a read connection; always closes it."""

        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Run a write transaction, committing on success and rolling back on error."""

        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except BaseException:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            connection.close()

    def execute(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Execute one write in its own transaction. Returns ``rowcount``."""

        with self.transaction() as connection:
            cursor = connection.execute(sql, tuple(params))
            return cursor.rowcount

    def query_one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        with self.connect() as connection:
            return cast(sqlite3.Row | None, connection.execute(sql, tuple(params)).fetchone())

    def query_all(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self.connect() as connection:
            return list(connection.execute(sql, tuple(params)).fetchall())

    def executescript_atomic(self, statements: Sequence[str], params: Sequence[Any] = ()) -> None:
        with self.transaction() as connection:
            for statement in statements:
                connection.execute(statement, tuple(params))
