"""Parent-death watchdog.

Electron spawns the backend as a detached process and passes its own PID and a
heartbeat file. If Electron is SIGKILLed, nothing would otherwise stop the
backend; this daemon checks both signals every ``interval_s`` and requests a
graceful shutdown (SIGTERM, handled by uvicorn) when the parent is gone.

Disabled when neither ``desktop_pid`` nor ``desktop_heartbeat`` is configured,
so tests and standalone development never spawn the thread.
"""

from __future__ import annotations

import ctypes
import logging
import os
import signal
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .config import BootConfig

LOG = logging.getLogger("autoagent.watchdog")

DEFAULT_INTERVAL_S = 2.0
DEFAULT_HEARTBEAT_TIMEOUT_S = 15.0
_STILL_ACTIVE = 259


def pid_is_alive(pid: int) -> bool:
    """Return whether ``pid`` names a live process.

    Post: on POSIX this uses signal 0; ``PermissionError`` means the process
          exists but is owned by another user. On Windows it uses
          ``OpenProcess``/``GetExitCodeProcess`` because ``os.kill(pid, 0)``
          would terminate the process there.
    """

    if pid <= 0:
        return True
    if sys.platform == "win32":
        return _windows_pid_is_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        # EPERM and other transient errors: assume alive rather than killing
        # the backend on a probe failure.
        return True
    return True


def _windows_pid_is_alive(pid: int) -> bool:
    try:
        windll = getattr(ctypes, "windll", None)
        if windll is None:  # pragma: no cover - only reachable on Windows
            return True
        kernel32 = windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return bool(ok) and code.value == _STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        LOG.warning("could not probe parent pid", exc_info=True)
        return True


def request_graceful_shutdown() -> None:
    """Ask uvicorn to shut down via its SIGTERM handler."""

    signal.raise_signal(signal.SIGTERM)


class ParentWatchdog:
    """Daemon thread that stops the backend when its desktop parent disappears.

    Pre: ``trigger`` is idempotent-safe (calling it more than once must not
         corrupt shutdown); the class additionally guarantees one call.
    Post: ``check_once`` returns True once a shutdown condition was observed.
    """

    def __init__(
        self,
        *,
        desktop_pid: int | None,
        heartbeat_path: Path | None,
        trigger: Callable[[], None] = request_graceful_shutdown,
        interval_s: float = DEFAULT_INTERVAL_S,
        heartbeat_timeout_s: float = DEFAULT_HEARTBEAT_TIMEOUT_S,
        clock: Callable[[], float] = time.time,
        pid_alive: Callable[[int], bool] = pid_is_alive,
    ) -> None:
        self._desktop_pid = (
            desktop_pid
            if desktop_pid is not None and desktop_pid > 0
            else None
        )
        self._heartbeat_path = heartbeat_path
        self._trigger = trigger
        self._interval_s = max(0.01, interval_s)
        self._heartbeat_timeout_s = max(0.0, heartbeat_timeout_s)
        self._clock = clock
        self._pid_alive = pid_alive
        self._lock = threading.Lock()
        self._triggered = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def enabled(self) -> bool:
        return self._desktop_pid is not None or self._heartbeat_path is not None

    @property
    def triggered(self) -> bool:
        with self._lock:
            return self._triggered

    def start(self) -> bool:
        """Start the daemon thread; returns False when disabled/already running."""

        if not self.enabled:
            return False
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False
            self._stop.clear()
            thread = threading.Thread(
                target=self._run, name="parent-watchdog", daemon=True
            )
            self._thread = thread
            thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    def check_once(self) -> bool:
        """Evaluate both signals once; trigger shutdown at most once."""

        if self.triggered:
            return True
        if self._desktop_pid is not None and not self._pid_alive(self._desktop_pid):
            LOG.warning(
                "desktop parent process %s is gone; shutting down",
                self._desktop_pid,
            )
            self._fire()
            return True
        if self._heartbeat_path is not None and not self._heartbeat_is_fresh():
            LOG.warning(
                "desktop heartbeat is missing or older than %.1fs; shutting down",
                self._heartbeat_timeout_s,
            )
            self._fire()
            return True
        return False

    def _heartbeat_is_fresh(self) -> bool:
        assert self._heartbeat_path is not None
        try:
            modified = self._heartbeat_path.stat().st_mtime
        except FileNotFoundError:
            return False
        except OSError:
            return False
        return (self._clock() - modified) <= self._heartbeat_timeout_s

    def _fire(self) -> None:
        with self._lock:
            if self._triggered:
                return
            self._triggered = True
        try:
            self._trigger()
        except Exception:
            LOG.exception("shutdown trigger failed")

    def _run(self) -> None:
        while not self._stop.is_set():
            if self.check_once():
                return
            self._stop.wait(self._interval_s)


def watchdog_from_config(
    config: BootConfig,
    *,
    trigger: Callable[[], None] = request_graceful_shutdown,
    interval_s: float = DEFAULT_INTERVAL_S,
    heartbeat_timeout_s: float = DEFAULT_HEARTBEAT_TIMEOUT_S,
) -> ParentWatchdog:
    """Build a watchdog from boot configuration; disabled when unset."""

    heartbeat = Path(config.desktop_heartbeat) if config.desktop_heartbeat else None
    return ParentWatchdog(
        desktop_pid=config.desktop_pid,
        heartbeat_path=heartbeat,
        trigger=trigger,
        interval_s=interval_s,
        heartbeat_timeout_s=heartbeat_timeout_s,
    )
