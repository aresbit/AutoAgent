"""Turn orchestration: start, stream, cancel, status.

One ``TurnRunner`` thread per active turn drains ``EnginePort`` independently of
SSE subscribers. Exactly one terminal event is published per turn; a subscriber
disconnect never cancels the engine.
"""

from __future__ import annotations

import dataclasses
import logging
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field

from ..domain.errors import (
    DomainError,
    InvalidTurnId,
    TurnAlreadyFinished,
    TurnInProgress,
    TurnNotFound,
)
from ..domain.events import (
    DomainEvent,
    TurnCompleted,
    TurnFailed,
    is_terminal,
)
from ..domain.models import (
    NewMessage,
    Settings,
    SettingsPatch,
    TurnResult,
    TurnState,
    TurnStatus,
)
from ..domain.ports import (
    ClockPort,
    EnginePort,
    EngineRefStorePort,
    SessionStorePort,
    SettingsPort,
    StartTurnRequest,
    TurnHandle,
    TurnStorePort,
)
from .event_bus import EventBus
from .journal import TurnJournal, TurnSubscription
from .settings_service import merge_settings

LOG = logging.getLogger("autoagent.turns")
MAX_TEXT_LENGTH = 100_000


@dataclass(slots=True)
class _Run:
    turn_id: str
    session_id: str
    text: str
    settings: Settings
    journal: TurnJournal = field(default_factory=TurnJournal)
    cancel_requested: bool = False
    handle: TurnHandle | None = None
    thread: threading.Thread | None = None


class TurnService:
    """Application service owning the turn state machine."""

    def __init__(
        self,
        *,
        sessions: SessionStorePort,
        turns: TurnStorePort,
        refs: EngineRefStorePort,
        engine: EnginePort,
        settings: SettingsPort,
        clock: ClockPort,
        events: EventBus | None = None,
        cancel_wait_s: float = 5.0,
    ) -> None:
        self._sessions = sessions
        self._turns = turns
        self._refs = refs
        self._engine = engine
        self._settings = settings
        self._clock = clock
        self._events = events
        self._cancel_wait_s = max(0.0, cancel_wait_s)
        self._lock = threading.RLock()
        self._runs: dict[str, _Run] = {}
        self._session_active: dict[str, str] = {}

    # -- commands ----------------------------------------------------------

    def start(
        self,
        turn_id: str,
        session_id: str,
        text: str,
        overrides: SettingsPatch | None = None,
    ) -> TurnSubscription:
        """Start (or attach to) one turn and return a live subscription.

        Pre: ``turn_id`` is a UUID; ``1 <= len(text) <= 100_000``.
        Post: at most one runner per turn id and one active turn per session.
        Raises: ``InvalidTurnId``, ``SessionNotFound``, ``TurnInProgress``,
                ``TurnAlreadyFinished``.
        """

        _validate_turn_id(turn_id)
        if not text:
            raise InvalidTurnId("turn text must not be empty")
        if len(text) > MAX_TEXT_LENGTH:
            raise InvalidTurnId(f"turn text exceeds {MAX_TEXT_LENGTH} characters")

        # Raises SessionNotFound before any turn row is written.
        self._sessions.get(session_id)
        settings = merge_settings(self._settings.read(), overrides)

        with self._lock:
            existing = self._runs.get(turn_id)
            if existing is not None:
                if existing.journal.ended:
                    raise TurnAlreadyFinished(
                        f"turn {turn_id} has already finished"
                    )
                start_index = existing.journal.length
                if existing.journal.ended:
                    raise TurnAlreadyFinished(
                        f"turn {turn_id} has already finished"
                    )
                return TurnSubscription(existing.journal, start_index=start_index)

            stored = self._turns.get_turn(turn_id)
            if stored is not None:
                raise TurnAlreadyFinished(f"turn {turn_id} has already finished")
            active = self._session_active.get(session_id)
            if active is not None:
                raise TurnInProgress(
                    f"session {session_id} already has an active turn"
                )

            now = self._clock.now_ms()
            self._turns.begin_turn(turn_id, session_id, now)
            try:
                self._sessions.append_message(
                    session_id,
                    NewMessage(role="user", text=text, turn_id=turn_id),
                )
            except Exception:
                self._turns.finish_turn(
                    turn_id,
                    TurnState.FAILED,
                    stop_reason=None,
                    error_code="TURN_START_FAILED",
                    error_message="could not persist the user message",
                    assistant_message_id=None,
                    finished_at=self._clock.now_ms(),
                )
                raise

            run = _Run(
                turn_id=turn_id,
                session_id=session_id,
                text=text,
                settings=settings,
            )
            self._runs[turn_id] = run
            self._session_active[session_id] = turn_id
            thread = threading.Thread(
                target=self._run_turn,
                args=(run,),
                name=f"turn-{turn_id[:8]}",
                daemon=True,
            )
            run.thread = thread
            thread.start()
            return TurnSubscription(run.journal, start_index=0)

    def cancel(self, turn_id: str) -> None:
        """Request cancellation. Idempotent for terminal and unknown turns.

        Raises: ``TurnNotFound`` when the turn id was never seen.
        """

        status = self._turns.get_turn(turn_id)
        if status is None:
            with self._lock:
                if turn_id not in self._runs:
                    raise TurnNotFound(f"turn {turn_id} does not exist")
        elif status.state is not TurnState.RUNNING:
            return

        with self._lock:
            run = self._runs.get(turn_id)
            if run is None or run.journal.ended:
                return
            run.cancel_requested = True
            handle = run.handle

        if handle is not None:
            try:
                self._engine.cancel(handle)
            except DomainError:
                LOG.warning("engine cancel rejected", exc_info=True)
            except Exception:
                LOG.exception("engine cancel failed")

        # Belt and braces: the adapter contract says cancellation terminates the
        # stream within its deadline. If a buggy adapter does not, the service
        # still guarantees exactly one terminal event.
        deadline = time.monotonic() + self._cancel_wait_s
        while time.monotonic() < deadline:
            with self._lock:
                current = self._runs.get(turn_id)
                if current is None or current.journal.ended:
                    return
            time.sleep(0.01)
        with self._lock:
            current = self._runs.get(turn_id)
            if current is not None and not current.journal.ended:
                try:
                    self._turns.finish_turn(
                        turn_id,
                        TurnState.CANCELLED,
                        stop_reason="cancelled",
                        error_code=None,
                        error_message=None,
                        assistant_message_id=None,
                        finished_at=self._clock.now_ms(),
                    )
                except Exception:
                    LOG.exception("failed to persist a cancelled turn")
                current.journal.append(
                    TurnCompleted(
                        turn_id=current.turn_id,
                        session_id=current.session_id,
                        stop_reason="cancelled",
                        text="",
                    )
                )

    def status(self, turn_id: str) -> TurnStatus:
        status = self._turns.get_turn(turn_id)
        if status is None:
            raise TurnNotFound(f"turn {turn_id} does not exist")
        return status

    def shutdown(self) -> None:
        with self._lock:
            runs = list(self._runs.values())
        for run in runs:
            with self._lock:
                run.cancel_requested = True
                handle = run.handle
            if handle is not None:
                try:
                    self._engine.cancel(handle)
                except Exception:
                    continue
        for run in runs:
            thread = run.thread
            if thread is not None:
                thread.join(timeout=1.0)

    # -- runner ------------------------------------------------------------

    def _run_turn(self, run: _Run) -> None:
        terminal_emitted = False
        try:
            ref = self._refs.get_ref(run.session_id)
            request = StartTurnRequest(
                turn_id=run.turn_id,
                session_id=run.session_id,
                text=run.text,
                settings=run.settings,
                engine_session_ref=ref,
            )
            handle = self._engine.start_turn(request)
            with self._lock:
                run.handle = handle
                cancel_requested = run.cancel_requested
            if cancel_requested:
                self._engine.cancel(handle)

            for event in self._engine.stream(handle):
                if run.journal.ended:
                    terminal_emitted = True
                    break
                if isinstance(event, TurnCompleted):
                    if run.cancel_requested:
                        event = dataclasses.replace(
                            event, stop_reason="cancelled"
                        )
                    event = self._persist_completed(run, event)
                elif isinstance(event, TurnFailed):
                    self._persist_failed(run, event)
                run.journal.append(event)
                if is_terminal(event):
                    terminal_emitted = True
                    break

            if not terminal_emitted:
                failure = TurnFailed(
                    turn_id=run.turn_id,
                    session_id=run.session_id,
                    code="ENGINE_EXITED",
                    message="the engine ended without a result",
                    retryable=True,
                )
                self._persist_failed(run, failure)
                run.journal.append(failure)
        except DomainError as exc:
            failure = TurnFailed(
                turn_id=run.turn_id,
                session_id=run.session_id,
                code=exc.code,
                message=exc.message,
                retryable=exc.status_code >= 500,
            )
            self._persist_failed(run, failure)
            run.journal.append(failure)
        except Exception:
            LOG.exception("turn runner failed")
            failure = TurnFailed(
                turn_id=run.turn_id,
                session_id=run.session_id,
                code="ENGINE_ERROR",
                message="internal engine failure",
                retryable=True,
            )
            self._persist_failed(run, failure)
            run.journal.append(failure)
        finally:
            run.journal.end()
            with self._lock:
                self._runs.pop(run.turn_id, None)
                if self._session_active.get(run.session_id) == run.turn_id:
                    self._session_active.pop(run.session_id, None)
            self._publish_status()

    def _persist_completed(
        self, run: _Run, event: TurnCompleted
    ) -> TurnCompleted:
        cancelled = event.stop_reason == "cancelled"
        state = TurnState.CANCELLED if cancelled else TurnState.COMPLETED
        message_id: str | None = None
        try:
            if event.text:
                message = self._sessions.record_turn(
                    run.session_id,
                    TurnResult(
                        text=event.text,
                        stop_reason=event.stop_reason,
                        turn_id=run.turn_id,
                    ),
                )
                message_id = message.id
            if not cancelled:
                ref = self._engine.session_ref(run.session_id)
                if ref is not None:
                    self._refs.set_ref(run.session_id, ref)
        except Exception:
            LOG.exception("failed to persist a completed turn")
        try:
            self._turns.finish_turn(
                run.turn_id,
                state,
                stop_reason=event.stop_reason,
                error_code=None,
                error_message=None,
                assistant_message_id=message_id,
                finished_at=self._clock.now_ms(),
            )
        except Exception:
            LOG.exception("failed to update the turn row")
        return dataclasses.replace(event, message_id=message_id)

    def _persist_failed(self, run: _Run, event: TurnFailed) -> None:
        try:
            self._sessions.append_message(
                run.session_id,
                NewMessage(
                    role="system",
                    text=event.message,
                    turn_id=run.turn_id,
                    meta={"code": event.code},
                ),
            )
        except Exception:
            LOG.exception("failed to persist a failed turn message")
        try:
            self._turns.finish_turn(
                run.turn_id,
                TurnState.FAILED,
                stop_reason=None,
                error_code=event.code,
                error_message=event.message,
                assistant_message_id=None,
                finished_at=self._clock.now_ms(),
            )
        except Exception:
            LOG.exception("failed to update the failed turn row")

    def _publish_status(self) -> None:
        if self._events is None:
            return
        status = self._engine.status()
        self._events.publish(
            {
                "type": "engine.status",
                "state": status.state.value,
                "activeTurns": status.active_turns,
            }
        )


def _validate_turn_id(turn_id: str) -> None:
    try:
        uuid.UUID(turn_id)
    except (ValueError, AttributeError, TypeError) as exc:
        raise InvalidTurnId("turnId must be a UUID") from exc


def iter_subscription(
    subscription: TurnSubscription, *, heartbeat_s: float = 15.0
) -> Iterator[tuple[DomainEvent | None, bool]]:
    """Yield ``(event, ended)`` pairs, returning ``(None, False)`` on heartbeat.

    This helper belongs to the application layer so the SSE adapter does not
    need to know journal internals.
    """

    while True:
        event, ended = subscription.next_event(heartbeat_s)
        yield event, ended
        if event is not None and is_terminal(event):
            return
        if event is None and ended:
            return
