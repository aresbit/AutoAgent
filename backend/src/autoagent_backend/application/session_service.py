"""Session application service."""

from __future__ import annotations

from collections.abc import Sequence

from ..domain.models import Session
from ..domain.ports import SessionStorePort


class SessionService:
    """CRUD and branching intentions over ``SessionStorePort``."""

    def __init__(self, sessions: SessionStorePort) -> None:
        self._sessions = sessions

    def list(self, limit: int | None = None) -> Sequence[Session]:
        return self._sessions.list(limit)

    def get(self, session_id: str) -> Session:
        return self._sessions.get(session_id)

    def create(self, title: str | None = None) -> Session:
        return self._sessions.create(title)

    def rename(self, session_id: str, title: str) -> Session:
        return self._sessions.rename(session_id, title)

    def delete(self, session_id: str) -> None:
        self._sessions.delete(session_id)

    def branch(self, session_id: str, title: str | None = None) -> Session:
        return self._sessions.branch(session_id, title)
