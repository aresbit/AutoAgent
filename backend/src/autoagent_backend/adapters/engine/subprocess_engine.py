"""Persistent ``EnginePort`` implementation over the MateBot CLI.

One child per conversation, at most ``max_engines`` live children, LRU eviction,
readiness gating, resume gates, doomed-resume retry, process-death recovery and
a SIGINT -> SIGTERM -> SIGKILL cancel ladder.

Nothing in this module crosses the HTTP boundary: frames, argv, PIDs and
``session_id`` values stay here.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ...domain.errors import EngineUnavailable, TurnInProgress
from ...domain.events import (
    DomainEvent,
    TextDelta,
    ThinkingDelta,
    TurnCompleted,
    TurnFailed,
    TurnStarted,
    is_terminal,
)
from ...domain.models import EngineState, EngineStatus, Settings
from ...domain.ports import StartTurnRequest, TurnHandle
from ...domain.values import EngineSessionRef
from ...logging_setup import redact
from .argv import (
    EngineCommand,
    build_argv,
    command_for_settings,
    resolve_bun,
    resolve_cli,
    valid_engine_ref,
)
from .process import EngineChild, build_child_env
from .resume import resume_blocker
from .stream_json import StreamJsonTranslator

LOG = logging.getLogger("autoagent.engine")

_DOOMED_INITIAL_WINDOW_S = 5.0
_DOOMED_EXIT_WINDOW_S = 25.0


@dataclass(frozen=True, slots=True)
class EngineOptions:
    bun_path: Path
    cli_path: Path
    claude_config_dir: Path
    engine_log_dir: Path
    max_engines: int = 4
    cancel_grace_s: float = 3.0
    init_timeout_s: float = 60.0
    debug_frames: bool = False


@dataclass(slots=True)
class _Turn:
    handle: TurnHandle
    settings: Settings
    prompt: str
    translator: StreamJsonTranslator
    events: queue.Queue[DomainEvent] = field(default_factory=queue.Queue)
    cancel_requested: bool = False
    terminal: bool = False
    retried: bool = False
    started_emitted: bool = False


@dataclass(slots=True)
class _Session:
    session_id: str
    ref: EngineSessionRef | None = None
    published_ref: EngineSessionRef | None = None
    child: EngineChild | None = None
    generation: int = 0
    used_resume: bool = False
    spawned_at: float = 0.0
    last_used: float = 0.0
    saw_output: bool = False
    retried_clean: bool = False
    turn: _Turn | None = None
    version: str | None = None
    last_error: str | None = None
    ready: bool = False


class SubprocessEngine:
    """``EnginePort`` backed by persistent opencc children."""

    def __init__(
        self,
        options: EngineOptions,
        *,
        mode: str = "matebot",
        matebot: bool = True,
    ) -> None:
        self._options = options
        self._mode = mode
        self._matebot = matebot
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

            requested_ref = valid_engine_ref(
                None
                if request.engine_session_ref is None
                else str(request.engine_session_ref)
            )
            if request.engine_session_ref is not None:
                runtime.ref = (
                    EngineSessionRef(requested_ref) if requested_ref else None
                )

            translator = StreamJsonTranslator(
                turn_id=request.turn_id,
                session_id=request.session_id,
            )
            turn = _Turn(
                handle=TurnHandle(
                    turn_id=request.turn_id,
                    session_id=request.session_id,
                    engine_session_ref=runtime.ref,
                ),
                settings=request.settings,
                prompt=request.text,
                translator=translator,
            )
            runtime.turn = turn
            runtime.saw_output = False
            runtime.retried_clean = False
            try:
                self._ensure_child_locked(runtime, request.settings)
                assert runtime.child is not None
                runtime.child.send_user(request.text)
            except EngineUnavailable:
                runtime.turn = None
                raise
            except Exception as exc:
                runtime.turn = None
                raise EngineUnavailable("could not start the engine") from exc
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
            child = runtime.child

        if child is not None:
            child.cancel(self._options.cancel_grace_s)

        with self._lock:
            runtime = self._sessions.get(handle.session_id)
            turn = runtime.turn if runtime is not None else None
            if runtime is None or turn is None or turn.terminal:
                return
            self._finish_cancelled_locked(runtime, turn)

    def status(self) -> EngineStatus:
        with self._lock:
            active = sum(
                1
                for runtime in self._sessions.values()
                if runtime.turn is not None and not runtime.turn.terminal
            )
            starting = any(
                runtime.child is not None
                and runtime.child.alive
                and not runtime.child.ready
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
            turn = runtime.turn
            if turn is not None and not turn.terminal:
                turn.cancel_requested = True
                self._finish_cancelled_locked(runtime, turn)
            child = runtime.child
            runtime.child = None
            runtime.ready = False
        if child is not None:
            child.close()

    def close_all(self) -> None:
        with self._lock:
            self._closed = True
            runtimes = list(self._sessions.values())
        for runtime in runtimes:
            self.close(runtime.session_id)

    # -- child lifecycle ---------------------------------------------------

    def _ensure_child_locked(self, runtime: _Session, settings: Settings) -> None:
        if runtime.child is not None and runtime.child.alive:
            return
        if runtime.child is not None:
            runtime.child = None

        self._evict_locked(exclude=runtime.session_id)
        cwd = Path(settings.cwd).expanduser() if settings.cwd else Path.cwd()
        if not cwd.exists():
            raise EngineUnavailable("configured working directory does not exist")

        resume_ref = valid_engine_ref(
            None if runtime.ref is None else str(runtime.ref)
        )
        if resume_ref is not None:
            blocker = resume_blocker(
                resume_ref,
                cwd,
                config_dir=self._options.claude_config_dir,
            )
            if blocker is not None:
                LOG.info(
                    "resume refused for session %s: %s",
                    _short(runtime.session_id),
                    blocker,
                )
                runtime.ref = None
                resume_ref = None

        command: EngineCommand = command_for_settings(
            settings=settings,
            bun_path=self._options.bun_path,
            cli_path=self._options.cli_path,
            cwd=cwd,
            resume=resume_ref,
            matebot=self._matebot,
        )
        argv = build_argv(command)
        runtime.generation += 1
        generation = runtime.generation

        def on_frame(frame: dict[str, Any], sid: str = runtime.session_id) -> None:
            self._handle_frame(sid, generation, frame)

        def on_exit(code: int | None, sid: str = runtime.session_id) -> None:
            self._handle_exit(sid, generation, code)

        def on_stderr(line: str, sid: str = runtime.session_id) -> None:
            self._log_stderr(sid, line)

        child = EngineChild(
            argv=argv,
            cwd=cwd,
            env=build_child_env(self._options.claude_config_dir),
            on_frame=on_frame,
            on_exit=on_exit,
            on_stderr=on_stderr,
            label=f"{_short(runtime.session_id)}-{generation}",
        )
        try:
            child.spawn()
        except (OSError, ValueError) as exc:
            raise EngineUnavailable("could not spawn the engine process") from exc

        runtime.child = child
        runtime.ready = False
        runtime.used_resume = resume_ref is not None
        runtime.spawned_at = time.monotonic()
        runtime.last_error = None
        self._arm_init_timeout(runtime.session_id, generation)

    def _evict_locked(self, *, exclude: str) -> None:
        while True:
            live = [
                runtime
                for runtime in self._sessions.values()
                if runtime.child is not None and runtime.child.alive
            ]
            if len(live) < self._options.max_engines:
                return
            candidates = [
                runtime
                for runtime in live
                if runtime.session_id != exclude
                and (runtime.turn is None or runtime.turn.terminal)
            ]
            if not candidates:
                raise EngineUnavailable("engine process capacity reached")
            victim = min(candidates, key=lambda runtime: runtime.last_used)
            LOG.info("evicting idle engine process for %s", _short(victim.session_id))
            child = victim.child
            victim.child = None
            victim.ready = False
            if child is not None:
                child.close()

    def _arm_init_timeout(self, session_id: str, generation: int) -> None:
        def check() -> None:
            time.sleep(self._options.init_timeout_s)
            with self._lock:
                runtime = self._sessions.get(session_id)
                if (
                    runtime is None
                    or runtime.generation != generation
                    or runtime.child is None
                    or runtime.child.ready
                ):
                    return
                turn = runtime.turn
                if turn is None or turn.terminal:
                    return
                runtime.last_error = "engine did not become ready"
                turn.terminal = True
                turn.events.put(
                    TurnFailed(
                        turn_id=turn.handle.turn_id,
                        session_id=session_id,
                        code="ENGINE_INIT_TIMEOUT",
                        message="engine did not become ready",
                        retryable=True,
                    )
                )
                child = runtime.child
                runtime.child = None
                runtime.ready = False
            if child is not None:
                child.kill_now()

        threading.Thread(
            target=check,
            name=f"engine-init-timeout-{_short(session_id)}",
            daemon=True,
        ).start()

    # -- callbacks ---------------------------------------------------------

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
            if self._options.debug_frames:
                LOG.debug("engine frame %s", _short_frame(frame))
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
                if isinstance(event, (TextDelta, ThinkingDelta)):
                    runtime.saw_output = True
                if isinstance(event, TurnCompleted):
                    published = valid_engine_ref(turn.translator.engine_session_id)
                    if published is not None:
                        runtime.ref = EngineSessionRef(published)
                        runtime.published_ref = EngineSessionRef(published)
                    self._emit_locked(runtime, turn, event)
                    return
                if isinstance(event, TurnFailed):
                    if self._should_retry_frame_locked(runtime, turn):
                        self._retry_clean_locked(runtime, turn)
                        return
                    runtime.last_error = event.message
                    self._emit_locked(runtime, turn, event)
                    return
                self._emit_locked(runtime, turn, event)

    def _handle_exit(
        self, session_id: str, generation: int, code: int | None
    ) -> None:
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is None or runtime.generation != generation:
                return
            runtime.ready = False
            runtime.child = None
            turn = runtime.turn
            if turn is None or turn.terminal:
                return
            if turn.cancel_requested:
                self._finish_cancelled_locked(runtime, turn)
                return
            elapsed = time.monotonic() - runtime.spawned_at
            if (
                runtime.used_resume
                and (code is None or code != 0)
                and elapsed < _DOOMED_EXIT_WINDOW_S
                and not runtime.saw_output
                and not turn.retried
            ):
                LOG.info(
                    "doomed resume for %s exited (%s); retrying clean",
                    _short(session_id),
                    code,
                )
                self._retry_clean_locked(runtime, turn)
                return
            message = "engine process exited before the turn finished"
            runtime.last_error = message
            self._emit_locked(
                runtime,
                turn,
                TurnFailed(
                    turn_id=turn.handle.turn_id,
                    session_id=session_id,
                    code="ENGINE_EXITED",
                    message=message,
                    retryable=True,
                ),
            )

    def _should_retry_frame_locked(self, runtime: _Session, turn: _Turn) -> bool:
        return (
            runtime.used_resume
            and not turn.retried
            and not runtime.saw_output
            and time.monotonic() - runtime.spawned_at < _DOOMED_INITIAL_WINDOW_S
        )

    def _retry_clean_locked(self, runtime: _Session, turn: _Turn) -> None:
        turn.retried = True
        runtime.retried_clean = True
        runtime.ref = None
        runtime.published_ref = None
        runtime.used_resume = False
        runtime.saw_output = False
        old_child = runtime.child
        runtime.child = None
        runtime.ready = False
        if old_child is not None:
            old_child.kill_now()
        turn.translator = StreamJsonTranslator(
            turn_id=turn.handle.turn_id,
            session_id=runtime.session_id,
        )
        try:
            self._ensure_child_locked(runtime, turn.settings)
            assert runtime.child is not None
            runtime.child.send_user(turn.prompt)
        except Exception as exc:
            LOG.warning("clean retry failed: %s", type(exc).__name__)
            runtime.last_error = "engine could not be restarted"
            self._emit_locked(
                runtime,
                turn,
                TurnFailed(
                    turn_id=turn.handle.turn_id,
                    session_id=runtime.session_id,
                    code="ENGINE_UNAVAILABLE",
                    message="engine could not be restarted",
                    retryable=True,
                ),
            )

    def _finish_cancelled_locked(self, runtime: _Session, turn: _Turn) -> None:
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

    def _emit_locked(
        self, runtime: _Session, turn: _Turn, event: DomainEvent
    ) -> None:
        if turn.terminal:
            return
        if is_terminal(event):
            turn.terminal = True
        turn.events.put(event)
        self._touch_locked(runtime)

    # -- helpers -----------------------------------------------------------

    def _touch_locked(self, runtime: _Session) -> None:
        runtime.last_used = time.monotonic()
        self._sessions.move_to_end(runtime.session_id)

    def _log_stderr(self, session_id: str, line: str) -> None:
        safe = redact(line)
        LOG.info("engine[%s] %s", _short(session_id), safe)
        path = self._options.engine_log_dir / f"{session_id}.log"
        try:
            with self._log_lock:
                self._options.engine_log_dir.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as handle:
                    handle.write(safe + "\n")
        except OSError:
            pass


def build_subprocess_engine(
    *,
    bun_path: str | Path | None,
    cli_path: str | Path | None,
    claude_config_dir: Path,
    engine_log_dir: Path,
    max_engines: int,
    cancel_grace_s: float,
    init_timeout_s: float = 60.0,
    debug_frames: bool = False,
    matebot: bool = True,
) -> SubprocessEngine:
    """Resolve executables and construct the engine adapter (composition only)."""

    options = EngineOptions(
        bun_path=resolve_bun(bun_path),
        cli_path=resolve_cli(cli_path),
        claude_config_dir=claude_config_dir,
        engine_log_dir=engine_log_dir,
        max_engines=max(1, max_engines),
        cancel_grace_s=max(0.1, cancel_grace_s),
        init_timeout_s=max(0.1, init_timeout_s),
        debug_frames=debug_frames,
    )
    return SubprocessEngine(options, matebot=matebot)


def _short(session_id: str) -> str:
    return session_id[:8]


def _short_frame(frame: dict[str, Any]) -> str:
    frame_type = frame.get("type")
    subtype = frame.get("subtype")
    return f"{frame_type}/{subtype}" if subtype else str(frame_type)
