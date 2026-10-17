"""``EnginePort`` backed by the vendored MateBot ``OpenccSession``.

The class is loaded from ``vendor/matebot/opencc_backend.py`` by path (via
importlib) and remains read-only. This adapter owns only desktop-specific
concerns: per-session long connections, max-4 LRU eviction, normalized event
translation, cancellation synthesis and persisting the opaque resume ref.
"""

from __future__ import annotations

import hashlib
import importlib.util
import logging
import queue
import sys
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any, Protocol

from ...domain.errors import EngineUnavailable, TurnInProgress
from ...domain.events import (
    DomainEvent,
    TurnCompleted,
    TurnFailed,
    TurnStarted,
    is_terminal,
)
from ...domain.models import EngineState, EngineStatus, Settings
from ...domain.ports import EngineRefStorePort, StartTurnRequest, TurnHandle
from ...domain.values import EngineSessionRef
from ...logging_setup import redact
from .argv import valid_engine_ref
from .stream_json import StreamJsonTranslator

LOG = logging.getLogger("autoagent.matebot")

_MODULES: dict[Path, ModuleType] = {}
_MODULES_LOCK = threading.Lock()


class SessionLike(Protocol):
    """The subset of ``OpenccSession`` this adapter uses."""

    @property
    def is_running(self) -> bool: ...

    def send(self, text: str) -> None: ...

    def send_interrupt(self) -> None: ...

    def close(self) -> None: ...


SessionFactory = Callable[..., SessionLike]


@dataclass(slots=True)
class _Turn:
    handle: TurnHandle
    settings: Settings
    prompt: str
    translator: StreamJsonTranslator
    events: queue.Queue[DomainEvent] = field(default_factory=queue.Queue)
    cancel_requested: bool = False
    terminal: bool = False
    started_emitted: bool = False


@dataclass(slots=True)
class _Session:
    session_id: str
    session: SessionLike | None = None
    ref: EngineSessionRef | None = None
    published_ref: EngineSessionRef | None = None
    turn: _Turn | None = None
    generation: int = 0
    ready: bool = False
    version: str | None = None
    last_error: str | None = None
    last_used: float = 0.0


class MateBotEngine:
    """One persistent ``OpenccSession`` per application session id."""

    def __init__(
        self,
        *,
        session_factory: SessionFactory,
        refs: EngineRefStorePort,
        max_sessions: int = 4,
        cancel_grace_s: float = 3.0,
        engine_log_dir: Path | None = None,
        mode: str = "matebot",
    ) -> None:
        self._session_factory = session_factory
        self._refs = refs
        self._max_sessions = max(1, max_sessions)
        self._cancel_grace_s = max(0.05, cancel_grace_s)
        self._engine_log_dir = engine_log_dir
        self._mode = mode
        self._lock = threading.RLock()
        self._sessions: OrderedDict[str, _Session] = OrderedDict()
        self._log_lock = threading.Lock()
        self._closed = False

    # -- EnginePort --------------------------------------------------------

    def start_turn(self, request: StartTurnRequest) -> TurnHandle:
        with self._lock:
            if self._closed:
                raise EngineUnavailable("engine is shutting down")
            runtime = self._sessions.get(request.session_id)
            if runtime is None:
                runtime = _Session(session_id=request.session_id)
                self._sessions[request.session_id] = runtime
            self._touch_locked(runtime)

            if runtime.turn is not None and not runtime.turn.terminal:
                raise TurnInProgress(
                    f"session {request.session_id} already has an active turn"
                )

            self._load_ref_locked(runtime, request.engine_session_ref)
            self._ensure_session_locked(runtime, request.settings)

            turn = _Turn(
                handle=TurnHandle(
                    turn_id=request.turn_id,
                    session_id=request.session_id,
                    engine_session_ref=runtime.ref,
                ),
                settings=request.settings,
                prompt=request.text,
                translator=StreamJsonTranslator(
                    turn_id=request.turn_id,
                    session_id=request.session_id,
                ),
            )
            runtime.turn = turn
            session = runtime.session

        assert session is not None
        try:
            session.send(request.text)
        except Exception as exc:
            with self._lock:
                runtime.turn = None
            raise EngineUnavailable("could not send the turn to MateBot") from exc
        return turn.handle

    def stream(self, handle: TurnHandle) -> Iterator[DomainEvent]:
        with self._lock:
            runtime = self._sessions.get(handle.session_id)
            turn = runtime.turn if runtime is not None else None
            if turn is None or turn.handle.turn_id != handle.turn_id:
                raise EngineUnavailable("turn handle is no longer active")
        while True:
            try:
                event = turn.events.get(timeout=0.5)
            except queue.Empty:
                with self._lock:
                    if self._closed:
                        return
                continue
            yield event
            if is_terminal(event):
                return

    def cancel(self, handle: TurnHandle) -> None:
        with self._lock:
            runtime = self._sessions.get(handle.session_id)
            turn = runtime.turn if runtime is not None else None
            if (
                runtime is None
                or turn is None
                or turn.handle.turn_id != handle.turn_id
                or turn.terminal
            ):
                return
            turn.cancel_requested = True
            session = runtime.session

        if session is not None:
            try:
                session.send_interrupt()
            except Exception:
                LOG.warning("MateBot interrupt failed", exc_info=True)

        deadline = time.monotonic() + self._cancel_grace_s
        while time.monotonic() < deadline:
            with self._lock:
                if turn.terminal:
                    return
            time.sleep(0.01)

        with self._lock:
            runtime = self._sessions.get(handle.session_id)
            if runtime is None:
                return
            if turn.terminal:
                return
            self._emit_locked(
                runtime,
                turn,
                TurnCompleted(
                    turn_id=turn.handle.turn_id,
                    session_id=runtime.session_id,
                    stop_reason="cancelled",
                    text=turn.translator.assistant_text,
                ),
            )
            # The child did not acknowledge the interrupt: drop it so the next
            # turn can resume from the persisted ref on a fresh process.
            if runtime.session is not None:
                self._close_session_locked(runtime)

    def status(self) -> EngineStatus:
        with self._lock:
            active = sum(
                1
                for runtime in self._sessions.values()
                if runtime.turn is not None and not runtime.turn.terminal
            )
            starting = any(
                runtime.session is not None and not runtime.ready
                for runtime in self._sessions.values()
            )
            version = next(
                (
                    runtime.version
                    for runtime in self._sessions.values()
                    if runtime.version
                ),
                None,
            )
            last_error = next(
                (
                    runtime.last_error
                    for runtime in reversed(self._sessions.values())
                    if runtime.last_error
                ),
                None,
            )
            if active:
                state = EngineState.BUSY
            elif starting:
                state = EngineState.STARTING
            elif last_error:
                state = EngineState.ERROR
            else:
                state = EngineState.IDLE
            return EngineStatus(
                state=state,
                mode=self._mode,
                active_turns=active,
                version=version,
                last_error=last_error,
            )

    def session_ref(self, session_id: str) -> EngineSessionRef | None:
        with self._lock:
            runtime = self._sessions.get(session_id)
            return None if runtime is None else runtime.published_ref

    def close(self, session_id: str) -> None:
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is None:
                return
            if runtime.turn is not None and not runtime.turn.terminal:
                runtime.turn.cancel_requested = True
                self._emit_locked(
                    runtime,
                    runtime.turn,
                    TurnCompleted(
                        turn_id=runtime.turn.handle.turn_id,
                        session_id=runtime.session_id,
                        stop_reason="cancelled",
                        text=runtime.turn.translator.assistant_text,
                    ),
                )
            self._close_session_locked(runtime)

    def close_all(self) -> None:
        with self._lock:
            self._closed = True
            runtimes = list(self._sessions.values())
        for runtime in runtimes:
            self.close(runtime.session_id)

    # -- session lifecycle --------------------------------------------------

    def _ensure_session_locked(self, runtime: _Session, settings: Settings) -> None:
        if runtime.session is not None:
            return
        self._evict_if_needed_locked(exclude=runtime.session_id)

        runtime.generation += 1
        generation = runtime.generation
        session_id = runtime.session_id

        def on_event(frame: dict[str, Any]) -> None:
            self._handle_frame(session_id, generation, frame)

        def on_stderr(line: str) -> None:
            self._log_stderr(session_id, line)

        def on_close(code: int | None) -> None:
            self._handle_close(session_id, generation, code)

        def on_session_id(value: str) -> None:
            self._handle_session_id(session_id, generation, value)

        try:
            session = self._session_factory(
                session_id=None if runtime.ref is None else str(runtime.ref),
                cwd=settings.cwd or None,
                model=settings.model or None,
                append_system_prompt=settings.append_system_prompt or None,
                on_event=on_event,
                on_stderr=on_stderr,
                on_close=on_close,
                on_session_id=on_session_id,
            )
        except Exception as exc:
            raise EngineUnavailable("could not start the MateBot session") from exc

        runtime.session = session
        runtime.ready = False
        runtime.last_error = None

    def _evict_if_needed_locked(self, *, exclude: str) -> None:
        while True:
            live = [
                runtime
                for runtime in self._sessions.values()
                if runtime.session is not None
            ]
            if len(live) < self._max_sessions:
                return
            candidates = [
                runtime
                for runtime in live
                if runtime.session_id != exclude
                and (runtime.turn is None or runtime.turn.terminal)
            ]
            if not candidates:
                raise EngineUnavailable("MateBot session capacity reached")
            victim = min(candidates, key=lambda runtime: runtime.last_used)
            LOG.info("evicting idle MateBot session %s", _short(victim.session_id))
            self._close_session_locked(victim)

    def _close_session_locked(self, runtime: _Session) -> None:
        session = runtime.session
        runtime.generation += 1
        runtime.session = None
        runtime.ready = False
        if session is not None:
            try:
                session.close()
            except Exception:
                LOG.warning("MateBot session close failed", exc_info=True)

    def _load_ref_locked(
        self, runtime: _Session, incoming: EngineSessionRef | None
    ) -> None:
        if incoming is not None:
            validated = valid_engine_ref(str(incoming))
            runtime.ref = EngineSessionRef(validated) if validated else None
            return
        if runtime.ref is not None:
            return
        try:
            stored = self._refs.get_ref(runtime.session_id)
        except Exception:
            LOG.warning("could not read the persisted engine ref", exc_info=True)
            return
        validated = valid_engine_ref(None if stored is None else str(stored))
        runtime.ref = EngineSessionRef(validated) if validated else None

    # -- session callbacks --------------------------------------------------

    def _handle_frame(
        self, session_id: str, generation: int, frame: dict[str, Any]
    ) -> None:
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is None or runtime.generation != generation:
                return
            if frame.get("type") == "system" and frame.get("subtype") == "init":
                runtime.ready = True
                version = frame.get("claude_code_version")
                if isinstance(version, str):
                    runtime.version = version
            turn = runtime.turn
            if turn is None or turn.terminal:
                return
            events = turn.translator.feed(frame)
            if not events:
                return
            if turn.cancel_requested:
                return
            for event in events:
                if isinstance(event, TurnStarted):
                    if turn.started_emitted:
                        continue
                    turn.started_emitted = True
                self._emit_locked(runtime, turn, event)
                if is_terminal(event):
                    return

    def _handle_session_id(
        self, session_id: str, generation: int, value: str
    ) -> None:
        validated = valid_engine_ref(value)
        if validated is None:
            return
        ref = EngineSessionRef(validated)
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is None or runtime.generation != generation:
                return
            runtime.ref = ref
            runtime.published_ref = ref
        try:
            self._refs.set_ref(session_id, ref)
        except Exception:
            LOG.warning("could not persist the engine session ref", exc_info=True)

    def _handle_close(
        self, session_id: str, generation: int, code: int | None
    ) -> None:
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is None or runtime.generation != generation:
                return
            runtime.session = None
            runtime.ready = False
            turn = runtime.turn
            if turn is None or turn.terminal:
                return
            if turn.cancel_requested:
                self._emit_locked(
                    runtime,
                    turn,
                    TurnCompleted(
                        turn_id=turn.handle.turn_id,
                        session_id=runtime.session_id,
                        stop_reason="cancelled",
                        text=turn.translator.assistant_text,
                    ),
                )
                return
            message = "MateBot process exited before the turn finished"
            runtime.last_error = message
            self._emit_locked(
                runtime,
                turn,
                TurnFailed(
                    turn_id=turn.handle.turn_id,
                    session_id=runtime.session_id,
                    code="ENGINE_EXITED",
                    message=message,
                    retryable=True,
                ),
            )

    def _emit_locked(
        self, runtime: _Session, turn: _Turn, event: DomainEvent
    ) -> None:
        if turn.terminal:
            return
        if is_terminal(event):
            turn.terminal = True
        turn.events.put(event)
        self._touch_locked(runtime)

    # -- helpers ------------------------------------------------------------

    def _touch_locked(self, runtime: _Session) -> None:
        runtime.last_used = time.monotonic()
        self._sessions.move_to_end(runtime.session_id)

    def _log_stderr(self, session_id: str, line: str) -> None:
        safe = redact(line)
        LOG.info("matebot[%s] %s", _short(session_id), safe)
        if self._engine_log_dir is None:
            return
        try:
            with self._log_lock:
                self._engine_log_dir.mkdir(parents=True, exist_ok=True)
                with (self._engine_log_dir / f"{session_id}.log").open(
                    "a", encoding="utf-8"
                ) as handle:
                    handle.write(safe + "\n")
        except OSError:
            pass


def load_vendored_matebot_module(path: Path) -> ModuleType:
    """Load ``opencc_backend.py`` from ``path`` without copying its code.

    Raises: ``EngineUnavailable`` when the file is missing, fails to import or
            does not define ``OpenccSession``.
    """

    resolved = path.expanduser().resolve()
    with _MODULES_LOCK:
        cached = _MODULES.get(resolved)
        if cached is not None:
            return cached
        if not resolved.is_file():
            raise EngineUnavailable("vendored MateBot module was not found")
        name = "autoagent_vendored_matebot_" + hashlib.sha1(
            str(resolved).encode("utf-8")
        ).hexdigest()[:12]
        spec = importlib.util.spec_from_file_location(name, resolved)
        if spec is None or spec.loader is None:
            raise EngineUnavailable("could not load the vendored MateBot module")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:
            sys.modules.pop(name, None)
            raise EngineUnavailable(
                "could not import the vendored MateBot module"
            ) from exc
        if not hasattr(module, "OpenccSession"):
            sys.modules.pop(name, None)
            raise EngineUnavailable(
                "vendored MateBot module does not define OpenccSession"
            )
        _MODULES[resolved] = module
        return module


def build_matebot_session_factory(
    *, vendor_path: Path, cli_path: Path, bun_path: Path
) -> SessionFactory:
    """Build the production factory around the vendored ``OpenccSession``."""

    module = load_vendored_matebot_module(vendor_path)
    opencc_session = module.__dict__["OpenccSession"]

    def factory(**kwargs: Any) -> SessionLike:
        session: SessionLike = opencc_session(
            cli_path=cli_path,
            bun_path=str(bun_path),
            **kwargs,
        )
        return session

    return factory


def _short(session_id: str) -> str:
    return session_id[:8]
