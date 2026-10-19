"""SQLite implementation of the session, turn and engine-ref stores."""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Sequence

from ...domain.errors import (
    InvalidInput,
    SessionNotFound,
    TurnAlreadyFinished,
    TurnInProgress,
    TurnNotFound,
)
from ...domain.models import (
    Message,
    NewMessage,
    Session,
    TurnResult,
    TurnState,
    TurnStatus,
)
from ...domain.ports import ClockPort
from ...domain.values import EngineSessionRef
from .sqlite import SqliteDatabase

_PREVIEW_CHARS = 120


def _as_uuid(value: str) -> str | None:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _decode_meta(raw: str | None) -> dict[str, object] | None:
    if not raw:
        return None
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


class SqliteSessionStore:
    """Implements ``SessionStorePort``, ``TurnStorePort`` and ``EngineRefStorePort``."""

    def __init__(self, db: SqliteDatabase, clock: ClockPort) -> None:
        self._db = db
        self._clock = clock

    # -- SessionStorePort -------------------------------------------------

    def list(self, limit: int | None = None) -> Sequence[Session]:
        capped = 100 if limit is None else max(1, min(limit, 1000))
        rows = self._db.query_all(
            """
            SELECT s.id, s.title, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                   (SELECT m.text FROM messages m WHERE m.session_id = s.id
                    ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text
            FROM sessions s
            WHERE s.deleted_at IS NULL
            ORDER BY s.updated_at DESC, s.id DESC
            LIMIT ?
            """,
            (capped,),
        )
        return tuple(_row_to_session(row) for row in rows)

    def counts(self) -> tuple[int, int, int]:
        row = self._db.query_one(
            """
            SELECT
              (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL) AS sessions,
              (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM turns) AS turns
            """
        )
        if row is None:  # pragma: no cover - aggregate always returns a row
            return (0, 0, 0)
        return (int(row["sessions"]), int(row["messages"]), int(row["turns"]))

    def get(self, session_id: str) -> Session:
        row = self._db.query_one(
            """
            SELECT id, title, created_at, updated_at
            FROM sessions
            WHERE id = ? AND deleted_at IS NULL
            """,
            (session_id,),
        )
        if row is None:
            raise SessionNotFound(f"session {session_id} does not exist")
        message_rows = self._db.query_all(
            """
            SELECT id, session_id, turn_id, role, text, created_at, meta_json
            FROM messages
            WHERE session_id = ?
            ORDER BY created_at ASC, id ASC
            """,
            (session_id,),
        )
        messages = tuple(_row_to_message(message_row) for message_row in message_rows)
        return Session(
            id=str(row["id"]),
            title=str(row["title"]),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
            message_count=len(messages),
            last_message_preview=_preview(messages[-1].text) if messages else None,
            messages=messages,
        )

    def create(self, title: str | None = None) -> Session:
        session_id = str(uuid.uuid4())
        now = self._clock.now_ms()
        clean_title = (title or "").strip() or "New chat"
        with self._db.transaction() as connection:
            connection.execute(
                "INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (session_id, clean_title, now, now),
            )
        return Session(id=session_id, title=clean_title, created_at=now, updated_at=now)

    def rename(self, session_id: str, title: str) -> Session:
        now = self._clock.now_ms()
        clean_title = title.strip()
        if not clean_title:
            raise InvalidInput("title must not be empty")
        changed = self._db.execute(
            """
            UPDATE sessions SET title = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            """,
            (clean_title, now, session_id),
        )
        if changed == 0:
            raise SessionNotFound(f"session {session_id} does not exist")
        return self.get(session_id)

    def delete(self, session_id: str) -> None:
        changed = self._db.execute(
            "UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            (self._clock.now_ms(), session_id),
        )
        if changed == 0:
            raise SessionNotFound(f"session {session_id} does not exist")

    def branch(self, session_id: str, title: str | None = None) -> Session:
        source = self.get(session_id)
        new_id = str(uuid.uuid4())
        now = self._clock.now_ms()
        new_title = (title or "").strip() or f"{source.title} (branch)"
        with self._db.transaction() as connection:
            connection.execute(
                "INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (new_id, new_title, now, now),
            )
            for message in source.messages:
                connection.execute(
                    """
                    INSERT INTO messages(id, session_id, turn_id, role, text, created_at, meta_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        new_id,
                        message.turn_id,
                        message.role,
                        message.text,
                        message.created_at,
                        json.dumps(message.meta) if message.meta is not None else None,
                    ),
                )
        # A branch always starts a fresh engine transcript.
        return self.get(new_id)

    def append_message(self, session_id: str, message: NewMessage) -> Message:
        message_id = str(uuid.uuid4())
        now = self._clock.now_ms()
        try:
            with self._db.transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO messages(id, session_id, turn_id, role, text, created_at, meta_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        message_id,
                        session_id,
                        message.turn_id,
                        message.role,
                        message.text,
                        now,
                        json.dumps(message.meta) if message.meta is not None else None,
                    ),
                )
                connection.execute(
                    "UPDATE sessions SET updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                    (now, session_id),
                )
        except sqlite3.IntegrityError as exc:
            raise SessionNotFound(f"session {session_id} does not exist") from exc
        return Message(
            id=message_id,
            session_id=session_id,
            role=message.role,
            text=message.text,
            created_at=now,
            turn_id=message.turn_id,
            meta=message.meta,
        )

    def record_turn(self, session_id: str, result: TurnResult) -> Message:
        return self.append_message(
            session_id,
            NewMessage(role="assistant", text=result.text, turn_id=result.turn_id),
        )

    # -- TurnStorePort -----------------------------------------------------

    def begin_turn(self, turn_id: str, session_id: str, started_at: int) -> None:
        with self._db.transaction() as connection:
            existing = connection.execute(
                "SELECT 1 FROM turns WHERE id = ?", (turn_id,)
            ).fetchone()
            if existing is not None:
                raise TurnAlreadyFinished(f"turn {turn_id} already exists")
            running = connection.execute(
                "SELECT id FROM turns WHERE session_id = ? AND state = ?",
                (session_id, TurnState.RUNNING.value),
            ).fetchone()
            if running is not None:
                raise TurnInProgress(f"session {session_id} already has a running turn")
            try:
                connection.execute(
                    """
                    INSERT INTO turns(id, session_id, state, attempt, started_at)
                    VALUES (?, ?, ?, 1, ?)
                    """,
                    (turn_id, session_id, TurnState.RUNNING.value, started_at),
                )
            except sqlite3.IntegrityError as exc:
                raise SessionNotFound(f"session {session_id} does not exist") from exc

    def finish_turn(
        self,
        turn_id: str,
        state: TurnState,
        *,
        stop_reason: str | None,
        error_code: str | None,
        error_message: str | None,
        assistant_message_id: str | None,
        finished_at: int,
    ) -> None:
        changed = self._db.execute(
            """
            UPDATE turns
            SET state = ?, stop_reason = ?, error_code = ?, error_message = ?,
                assistant_message_id = ?, finished_at = ?
            WHERE id = ?
            """,
            (
                state.value,
                stop_reason,
                error_code,
                error_message,
                assistant_message_id,
                finished_at,
                turn_id,
            ),
        )
        if changed == 0:
            raise TurnNotFound(f"turn {turn_id} does not exist")

    def get_turn(self, turn_id: str) -> TurnStatus | None:
        row = self._db.query_one(
            """
            SELECT id, session_id, state, stop_reason, error_code, error_message,
                   started_at, finished_at, assistant_message_id
            FROM turns WHERE id = ?
            """,
            (turn_id,),
        )
        if row is None:
            return None
        return TurnStatus(
            turn_id=str(row["id"]),
            session_id=str(row["session_id"]),
            state=TurnState(str(row["state"])),
            stop_reason=(
                None if row["stop_reason"] is None else str(row["stop_reason"])
            ),
            assistant_message_id=(
                None
                if row["assistant_message_id"] is None
                else str(row["assistant_message_id"])
            ),
            error=(
                str(row["error_message"])
                if row["error_code"]
                else None
            ),
            started_at=int(row["started_at"]),
            finished_at=(
                None if row["finished_at"] is None else int(row["finished_at"])
            ),
        )

    def running_turn_for_session(self, session_id: str) -> str | None:
        row = self._db.query_one(
            "SELECT id FROM turns WHERE session_id = ? AND state = ? LIMIT 1",
            (session_id, TurnState.RUNNING.value),
        )
        return None if row is None else str(row["id"])

    def fail_orphaned_turns(self, finished_at: int, code: str) -> int:
        return self._db.execute(
            """
            UPDATE turns
            SET state = ?, error_code = ?, error_message = ?, finished_at = ?
            WHERE state = ?
            """,
            (
                TurnState.FAILED.value,
                code,
                "backend restarted before the turn finished",
                finished_at,
                TurnState.RUNNING.value,
            ),
        )

    # -- EngineRefStorePort ------------------------------------------------

    def get_ref(self, session_id: str) -> EngineSessionRef | None:
        row = self._db.query_one(
            "SELECT engine_session_ref FROM sessions WHERE id = ? AND deleted_at IS NULL",
            (session_id,),
        )
        if row is None:
            raise SessionNotFound(f"session {session_id} does not exist")
        raw = row["engine_session_ref"]
        if raw is None:
            return None
        validated = _as_uuid(str(raw))
        if validated is None:
            # Never resume from a corrupt value; clear it rather than failing.
            self.set_ref(session_id, None)
            return None
        return EngineSessionRef(validated)

    def set_ref(self, session_id: str, ref: EngineSessionRef | None) -> None:
        if ref is None:
            value: str | None = None
        else:
            value = _as_uuid(str(ref))
            if value is None:
                raise InvalidInput("engine session ref must be a UUID")
        changed = self._db.execute(
            """
            UPDATE sessions
            SET engine_session_ref = ?, engine_ref_updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            """,
            (value, self._clock.now_ms() if value is not None else None, session_id),
        )
        if changed == 0:
            raise SessionNotFound(f"session {session_id} does not exist")

    # -- Legacy import support (adapter-internal, not part of any port) ----

    def import_legacy_session(
        self,
        *,
        session_id: str,
        title: str,
        created_at: int,
        updated_at: int,
        messages: Sequence[dict[str, object]],
        engine_ref: str | None,
    ) -> None:
        """Insert a legacy session without overwriting an existing v2 row."""

        validated_ref = _as_uuid(engine_ref) if engine_ref else None
        with self._db.transaction() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO sessions
                    (id, title, created_at, updated_at, engine_session_ref, engine_ref_updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    title,
                    created_at,
                    updated_at,
                    validated_ref,
                    self._clock.now_ms() if validated_ref else None,
                ),
            )
            if cursor.rowcount == 0:
                return
            for message in messages:
                message_id = str(message.get("id") or uuid.uuid4())
                role = str(message.get("role") or "user")
                text = str(message.get("text") or "")
                stamp = _int_value(message.get("createdAt"), created_at)
                connection.execute(
                    """
                    INSERT OR IGNORE INTO messages
                        (id, session_id, role, text, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (message_id, session_id, role, text, stamp),
                )


def _row_to_session(row: sqlite3.Row) -> Session:
    last_text = row["last_text"]
    return Session(
        id=str(row["id"]),
        title=str(row["title"]),
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
        message_count=int(row["message_count"]),
        last_message_preview=_preview(str(last_text)) if last_text else None,
    )


def _row_to_message(row: sqlite3.Row) -> Message:
    return Message(
        id=str(row["id"]),
        session_id=str(row["session_id"]),
        turn_id=None if row["turn_id"] is None else str(row["turn_id"]),
        role=str(row["role"]),
        text=str(row["text"]),
        created_at=int(row["created_at"]),
        meta=_decode_meta(row["meta_json"]),
    )


def _preview(text: str) -> str:
    collapsed = " ".join(text.split())
    return collapsed[:_PREVIEW_CHARS]


def _int_value(value: object, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default
