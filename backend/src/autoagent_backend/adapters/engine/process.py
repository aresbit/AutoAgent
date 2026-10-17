"""Persistent child process: spawn, NDJSON framing, reader threads, kill ladder.

No shell is ever involved: ``argv`` is always a list and ``Popen`` is called with
``shell=False``. stdin/stdout/stderr are pipes; stdout is parsed as one JSON
object per line.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from ...domain.errors import EngineExited
from .stream_json import parse_frame

_SCRUB_ENV = ("CLAUDE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")
_STDERR_RING_LINES = 40
_PENDING_PROMPT_LIMIT = 16

LOG = logging.getLogger("autoagent.engine.process")


def build_child_env(
    config_dir: Path,
    *,
    extra: Mapping[str, str] | None = None,
    parent: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build the child environment.

    Post: inherits the parent, removes nested-session markers, forces
          ``FORCE_COLOR=0``, points the CLI at ``config_dir`` and disables actor
          networking in v1. Credentials stay in the environment, never argv.
    """

    env = dict(os.environ if parent is None else parent)
    for key in _SCRUB_ENV:
        env.pop(key, None)
    env["FORCE_COLOR"] = "0"
    env["CLAUDE_CONFIG_DIR"] = str(config_dir)
    env["OPENCC_ACTOR_NETWORKING"] = "0"
    if extra:
        env.update({str(key): str(value) for key, value in extra.items()})
    return env


class EngineChild:
    """One live opencc child process.

    Post: ``spawn`` starts exactly one process and two daemon reader threads.
    Post: ``send_frame`` writes one NDJSON frame and flushes.
    Post: ``cancel`` escalates SIGINT -> SIGTERM -> SIGKILL within the grace
          period; it is safe to call repeatedly.
    Raises: ``EngineExited`` when writing to a process that is no longer alive.
    """

    def __init__(
        self,
        *,
        argv: Sequence[str],
        cwd: Path,
        env: Mapping[str, str],
        on_frame: Any,
        on_exit: Any,
        on_stderr: Any,
        label: str = "",
    ) -> None:
        self._argv = list(argv)
        self._cwd = cwd
        self._env = dict(env)
        self._on_frame = on_frame
        self._on_exit = on_exit
        self._on_stderr = on_stderr
        self._label = label
        self._proc: subprocess.Popen[str] | None = None
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._ready = threading.Event()
        self._exit_reported = False
        self._closing = False
        self._pending: deque[dict[str, Any]] = deque()
        self._stderr_ring: deque[str] = deque(maxlen=_STDERR_RING_LINES)
        self._stdout_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self.spawned_at = time.monotonic()
        self.exit_code: int | None = None

    @property
    def argv(self) -> tuple[str, ...]:
        return tuple(self._argv)

    @property
    def pid(self) -> int | None:
        with self._state_lock:
            return None if self._proc is None else self._proc.pid

    @property
    def ready(self) -> bool:
        return self._ready.is_set()

    @property
    def alive(self) -> bool:
        with self._state_lock:
            return self._proc is not None and self._proc.poll() is None

    @property
    def stderr_tail(self) -> tuple[str, ...]:
        with self._state_lock:
            return tuple(self._stderr_ring)

    def spawn(self) -> None:
        """Start the process.

        Raises: ``OSError``/``ValueError`` when the executable cannot be run.
        """

        proc = subprocess.Popen(
            self._argv,
            cwd=str(self._cwd),
            env=self._env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
        )
        with self._state_lock:
            self._proc = proc
        self.spawned_at = time.monotonic()
        self._stdout_thread = threading.Thread(
            target=self._read_stdout,
            name=f"engine-stdout-{self._label or proc.pid}",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr,
            name=f"engine-stderr-{self._label or proc.pid}",
            daemon=True,
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

    def wait_ready(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    def send_user(self, text: str) -> None:
        self.send_frame(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": text}],
                },
            }
        )

    def send_keep_alive(self) -> None:
        self.send_frame({"type": "keep_alive"})

    def send_frame(
        self, frame: Mapping[str, Any], *, require_ready: bool = True
    ) -> None:
        """Send one frame, optionally queueing until the child is ready.

        ``require_ready=False`` writes immediately; it is used by the keep-alive
        smoke test, where no model turn is started.
        Raises: ``EngineExited`` when the process is gone.
        """

        with self._write_lock:
            if not self.alive:
                raise EngineExited("engine process is not running")
            if require_ready and not self._ready.is_set():
                if len(self._pending) >= _PENDING_PROMPT_LIMIT:
                    raise EngineExited("engine is not ready and the queue is full")
                self._pending.append(dict(frame))
                return
            self._write_locked(dict(frame))

    def cancel(self, grace_s: float) -> None:
        """Escalate SIGINT -> SIGTERM -> SIGKILL, each bounded by ``grace_s``."""

        if not self.alive:
            return
        self._signal(signal.SIGINT)
        if self._wait_exit(grace_s):
            return
        self._signal(signal.SIGTERM)
        if self._wait_exit(grace_s):
            return
        self.kill_now()

    def kill_now(self) -> None:
        with self._state_lock:
            proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
        self._wait_exit(1.0)

    def terminate_now(self, grace_s: float = 3.0) -> None:
        with self._state_lock:
            proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
        except OSError:
            return
        if not self._wait_exit(grace_s):
            self.kill_now()

    def close(self) -> None:
        """Idempotent shutdown: close stdin, terminate, join readers briefly."""

        self._closing = True
        with self._write_lock:
            proc = self._proc
            if proc is not None and proc.stdin is not None:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
        self.terminate_now(3.0)
        self.kill_now()
        for thread in (self._stdout_thread, self._stderr_thread):
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=1.0)

    # -- internals ---------------------------------------------------------

    def _signal(self, sig: int) -> None:
        with self._state_lock:
            proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            if sys.platform == "win32" and sig == signal.SIGINT:
                proc.send_signal(
                    getattr(signal, "CTRL_BREAK_EVENT", signal.SIGTERM)
                )
            else:
                proc.send_signal(sig)
        except (OSError, ValueError):
            pass

    def _wait_exit(self, timeout: float) -> bool:
        with self._state_lock:
            proc = self._proc
        if proc is None:
            return True
        try:
            proc.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    def _write_locked(self, frame: dict[str, Any]) -> None:
        with self._state_lock:
            proc = self._proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise EngineExited("engine process is not running")
        payload = json.dumps(frame, separators=(",", ":"), ensure_ascii=False)
        try:
            proc.stdin.write(payload + "\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            raise EngineExited("engine stdin is closed") from exc

    def _drain_pending_locked(self) -> None:
        while self._pending and self.alive:
            frame = self._pending.popleft()
            try:
                self._write_locked(frame)
            except EngineExited:
                self._pending.clear()
                return

    def _read_stdout(self) -> None:
        with self._state_lock:
            proc = self._proc
        if proc is None or proc.stdout is None:
            return
        exit_code: int | None = None
        try:
            for line in proc.stdout:
                frame = parse_frame(line)
                if frame is None:
                    if line.strip():
                        LOG.debug("engine emitted a non-JSON stdout line")
                    continue
                if _is_init_frame(frame):
                    self._ready.set()
                    with self._write_lock:
                        self._drain_pending_locked()
                try:
                    self._on_frame(frame)
                except Exception:
                    LOG.exception("engine frame callback failed")
        finally:
            try:
                exit_code = proc.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                pass
            self._report_exit(exit_code)

    def _read_stderr(self) -> None:
        with self._state_lock:
            proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            for line in proc.stderr:
                stripped = line.rstrip("\r\n")
                if not stripped:
                    continue
                with self._state_lock:
                    self._stderr_ring.append(stripped)
                try:
                    self._on_stderr(stripped)
                except Exception:
                    LOG.exception("engine stderr callback failed")
        finally:
            pass

    def _report_exit(self, code: int | None) -> None:
        with self._state_lock:
            if self._exit_reported:
                return
            self._exit_reported = True
            self.exit_code = code
            self._proc = None
        self._ready.clear()
        try:
            self._on_exit(code)
        except Exception:
            LOG.exception("engine exit callback failed")


def _is_init_frame(frame: Mapping[str, Any]) -> bool:
    return frame.get("type") == "system" and frame.get("subtype") == "init"
