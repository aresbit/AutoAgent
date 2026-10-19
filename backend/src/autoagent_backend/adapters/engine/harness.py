"""``EnginePort`` that dispatches each turn to the selected harness.

The settings aggregate stores the user's choice (``opencc`` or
``claude-code``). Both harnesses are ordinary ``EnginePort`` adapters; this
composite adds only the routing:

* a turn is started on the engine selected at that moment;
* ``stream``/``cancel`` are routed by turn id, so switching the setting never
  redirects a turn that is already running;
* closing a conversation closes it on every engine, so no stale child survives
  a harness change;
* the resume ref is read from the engine that most recently served the
  conversation.

The engines are constructed once by the composition root; neither is spawned
until it receives a turn.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator, Mapping

from ...domain.errors import EngineUnavailable
from ...domain.events import DomainEvent
from ...domain.models import EngineStatus
from ...domain.ports import EnginePort, StartTurnRequest, TurnHandle
from ...domain.values import EngineSessionRef

DEFAULT_HARNESS = "opencc"


class HarnessEngine:
    """Route ``EnginePort`` calls to the harness selected in settings."""

    def __init__(
        self,
        *,
        harness: Callable[[], str],
        engines: Mapping[str, EnginePort],
        default: str = DEFAULT_HARNESS,
    ) -> None:
        if not engines:
            raise ValueError("at least one harness engine is required")
        if default not in engines:
            raise ValueError("the default harness is not configured")
        self._harness = harness
        self._engines = dict(engines)
        self._default = default
        self._lock = threading.RLock()
        self._routes: dict[str, str] = {}
        self._last_by_session: dict[str, str] = {}
        self._closed = False

    # -- EnginePort --------------------------------------------------------

    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        name = self._selected()
        engine = self._engines[name]
        with self._lock:
            if self._closed:
                raise EngineUnavailable("engine is shutting down")
            previous = self._last_by_session.get(request.session_id)
            self._last_by_session[request.session_id] = name
        if previous is not None and previous != name:
            # The previous harness may still hold a process for this
            # conversation. Close it before the new one spawns.
            try:
                self._engines[previous].close(request.session_id)
            except Exception:
                pass
        handle = engine.start_turn(request)
        with self._lock:
            self._routes[handle.turn_id] = name
        return handle

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        return self._engine_for(handle).stream(handle)

    def cancel(self, handle: TurnHandle) -> None:
        self._engine_for(handle).cancel(handle)

    def status(self) -> EngineStatus:
        name = self._selected()
        status = self._engines[name].status()
        return EngineStatus(
            state=status.state,
            mode="claude-code" if name == "claude-code" else "matebot",
            active_turns=status.active_turns,
            version=status.version,
            last_error=status.last_error,
        )

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        with self._lock:
            last = self._last_by_session.get(session_id)
        if last is not None:
            ref = self._engines[last].session_ref(session_id)
            if ref is not None:
                return ref
        for engine in self._engines.values():
            ref = engine.session_ref(session_id)
            if ref is not None:
                return ref
        return None

    def close(self, session_id: str) -> None:
        for engine in self._engines.values():
            engine.close(session_id)
        with self._lock:
            self._last_by_session.pop(session_id, None)

    # -- lifecycle ---------------------------------------------------------

    def close_all(self) -> None:
        with self._lock:
            self._closed = True
            self._routes.clear()
            self._last_by_session.clear()
        for engine in self._engines.values():
            close_all = getattr(engine, "close_all", None)
            if callable(close_all):
                close_all()

    # -- helpers -----------------------------------------------------------

    def _selected(self) -> str:
        try:
            name = self._harness()
        except Exception:
            return self._default
        return name if name in self._engines else self._default

    def _engine_for(self, handle: TurnHandle) -> EnginePort:
        with self._lock:
            name = self._routes.get(handle.turn_id)
        if name is None:
            name = self._selected()
        return self._engines[name]
