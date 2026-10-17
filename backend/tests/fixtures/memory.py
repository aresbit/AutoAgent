"""In-memory ports for unit tests (no sqlite, no subprocess)."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import replace

from autoagent_backend.domain.errors import (
    Conflict,
    InvalidInput,
    SessionNotFound,
    TurnAlreadyFinished,
    TurnInProgress,
    TurnNotFound,
)
from autoagent_backend.domain.models import (
    Message,
    NewMessage,
    Provider,
    ProviderCatalog,
    Session,
    Settings,
    SettingsPatch,
    TurnResult,
    TurnState,
    TurnStatus,
)
from autoagent_backend.domain.values import EngineSessionRef


class FakeClock:
    def __init__(self, start_ms: int = 1_700_000_000_000) -> None:
        self._now = start_ms

    def now_ms(self) -> int:
        self._now += 1
        return self._now


class InMemoryStore:
    """Implements SessionStorePort, TurnStorePort and EngineRefStorePort."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.sessions: dict[str, Session] = {}
        self.messages: dict[str, list[Message]] = {}
        self.turns: dict[str, TurnStatus] = {}
        self.refs: dict[str, EngineSessionRef | None] = {}

    # -- sessions ----------------------------------------------------------

    def list(self, limit: int | None = None) -> Sequence[Session]:
        ordered = sorted(
            self.sessions.values(), key=lambda item: (item.updated_at, item.id), reverse=True
        )
        return tuple(ordered[: (limit or 100)])

    def get(self, session_id: str) -> Session:
        session = self.sessions.get(session_id)
        if session is None:
            raise SessionNotFound(session_id)
        return replace(
            session,
            messages=tuple(self.messages.get(session_id, ())),
            message_count=len(self.messages.get(session_id, ())),
        )

    def create(self, title: str | None = None) -> Session:
        now = self.clock.now_ms()
        session = Session(
            id=str(uuid.uuid4()),
            title=(title or "New chat"),
            created_at=now,
            updated_at=now,
        )
        self.sessions[session.id] = session
        self.messages[session.id] = []
        return session

    def rename(self, session_id: str, title: str) -> Session:
        session = self.get(session_id)
        updated = replace(session, title=title, updated_at=self.clock.now_ms())
        self.sessions[session_id] = updated
        return updated

    def delete(self, session_id: str) -> None:
        if session_id not in self.sessions:
            raise SessionNotFound(session_id)
        del self.sessions[session_id]

    def branch(self, session_id: str, title: str | None = None) -> Session:
        source = self.get(session_id)
        now = self.clock.now_ms()
        new = Session(
            id=str(uuid.uuid4()),
            title=title or f"{source.title} (branch)",
            created_at=now,
            updated_at=now,
        )
        self.sessions[new.id] = new
        self.messages[new.id] = [
            replace(message, id=str(uuid.uuid4()), session_id=new.id)
            for message in self.messages.get(session_id, ())
        ]
        return self.get(new.id)

    def append_message(self, session_id: str, message: NewMessage) -> Message:
        if session_id not in self.sessions:
            raise SessionNotFound(session_id)
        now = self.clock.now_ms()
        created = Message(
            id=str(uuid.uuid4()),
            session_id=session_id,
            role=message.role,
            text=message.text,
            created_at=now,
            turn_id=message.turn_id,
            meta=message.meta,
        )
        self.messages.setdefault(session_id, []).append(created)
        self.sessions[session_id] = replace(
            self.sessions[session_id], updated_at=now
        )
        return created

    def record_turn(self, session_id: str, result: TurnResult) -> Message:
        return self.append_message(
            session_id,
            NewMessage(role="assistant", text=result.text, turn_id=result.turn_id),
        )

    # -- turns -------------------------------------------------------------

    def begin_turn(self, turn_id: str, session_id: str, started_at: int) -> None:
        if session_id not in self.sessions:
            raise SessionNotFound(session_id)
        if turn_id in self.turns:
            raise TurnAlreadyFinished(turn_id)
        if self.running_turn_for_session(session_id) is not None:
            raise TurnInProgress(session_id)
        self.turns[turn_id] = TurnStatus(
            turn_id=turn_id,
            session_id=session_id,
            state=TurnState.RUNNING,
            started_at=started_at,
        )

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
        current = self.turns.get(turn_id)
        if current is None:
            raise TurnNotFound(turn_id)
        self.turns[turn_id] = replace(
            current,
            state=state,
            stop_reason=stop_reason,
            error=error_message if error_code else None,
            assistant_message_id=assistant_message_id,
            finished_at=finished_at,
        )

    def get_turn(self, turn_id: str) -> TurnStatus | None:
        return self.turns.get(turn_id)

    def running_turn_for_session(self, session_id: str) -> str | None:
        for status in self.turns.values():
            if status.session_id == session_id and status.state is TurnState.RUNNING:
                return status.turn_id
        return None

    def fail_orphaned_turns(self, finished_at: int, code: str) -> int:
        count = 0
        for turn_id, status in list(self.turns.items()):
            if status.state is TurnState.RUNNING:
                self.turns[turn_id] = replace(
                    status,
                    state=TurnState.FAILED,
                    error=code,
                    finished_at=finished_at,
                )
                count += 1
        return count

    # -- engine refs -------------------------------------------------------

    def get_ref(self, session_id: str) -> EngineSessionRef | None:
        if session_id not in self.sessions:
            raise SessionNotFound(session_id)
        return self.refs.get(session_id)

    def set_ref(self, session_id: str, ref: EngineSessionRef | None) -> None:
        if session_id not in self.sessions:
            raise SessionNotFound(session_id)
        if ref is not None:
            try:
                uuid.UUID(str(ref))
            except ValueError as exc:
                raise InvalidInput("engine ref must be a UUID") from exc
        self.refs[session_id] = ref


class ConflictProbe:
    """Kept for type completeness in tests that expect a Conflict instance."""

    @staticmethod
    def is_conflict(exc: Exception) -> bool:
        return isinstance(exc, (Conflict, TurnInProgress, TurnAlreadyFinished))


class InMemorySettings:
    """Implements SettingsPort; no persistence."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def read(self) -> Settings:
        return self.settings

    def update(self, patch: SettingsPatch) -> Settings:
        values = {
            field: getattr(self.settings, field)
            for field in (
                "provider_id",
                "model",
                "fallback_model",
                "base_url",
                "api_key",
                "cwd",
                "permission_mode",
                "thinking_mode",
                "effort",
                "max_thinking_tokens",
                "max_turns",
                "max_budget_usd",
                "task_budget",
                "allowed_tools",
                "disallowed_tools",
                "add_dirs",
                "append_system_prompt",
                "layout",
            )
        }
        for field in (
            "provider_id",
            "model",
            "fallback_model",
            "base_url",
            "api_key",
            "cwd",
            "permission_mode",
            "thinking_mode",
            "effort",
            "max_thinking_tokens",
            "max_turns",
            "max_budget_usd",
            "task_budget",
            "allowed_tools",
            "disallowed_tools",
            "add_dirs",
            "append_system_prompt",
            "layout",
        ):
            value = getattr(patch, field)
            if value is not None:
                values[field] = value
        self.settings = replace(self.settings, **values)  # type: ignore[arg-type]
        return self.settings

    def provider(self, provider_id: str) -> Provider:
        return Provider(id=provider_id, name=provider_id)

    def providers(self) -> ProviderCatalog:
        return ProviderCatalog()
