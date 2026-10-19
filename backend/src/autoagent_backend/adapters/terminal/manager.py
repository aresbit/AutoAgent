"""Framework-free PTY terminal manager for the AutoAgent reference integration.

This module deliberately imports nothing from FastAPI, Starlette, Pydantic or
the AutoAgent application layers.  It can be unit-tested on its own and can be
moved to ``adapters/terminal/manager.py`` without changes.

Design
------
* One ``TerminalSession`` owns one ``os.openpty()`` pair and one child shell.
* The child is started with ``fork`` -> ``setsid`` -> ``TIOCSCTTY`` -> ``execvpe``.
  There is **no shell string** anywhere: ``argv`` is always a list and
  ``shell=False`` semantics apply (``execvpe``).
* The PTY master is non-blocking and watched with ``loop.add_reader``.  Data is
  decoded by the transport (the WebSocket route) with an incremental UTF-8
  decoder, so multi-byte characters split across reads stay intact.
* Output fans out to (a) a bounded ``asyncio.Queue`` consumed by the WebSocket
  pump and (b) a fixed-size in-memory ring buffer used for reconnect replay.
  When the queue fills the reader is paused; the kernel PTY buffer then applies
  backpressure to the child instead of dropping output.
* Closing a session signals the **whole process group** (``os.killpg``) and
  escalates HUP -> TERM -> KILL.  On Linux the child also requests
  ``PR_SET_PDEATHSIG`` so a hard backend crash does not leave shells behind.

Threading/loop contract
-----------------------
Every method except ``shutdown_now`` / ``reap_blocking`` must be called from the
event loop that created the manager.  There is no cross-thread locking because
there is no cross-thread access.

Windows is not supported.  AutoAgent ships Linux/macOS desktop builds; a
ConPTY adapter would be a separate implementation of the same surface.
"""

from __future__ import annotations

import asyncio
import errno
import fcntl
import logging
import os
import re
import signal
import struct
import sys
import termios
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Final, Literal

from .spawner import PtySpawner, PtySpawnerError

LOG = logging.getLogger("autoagent.terminal")

# ---------------------------------------------------------------------------
# Limits and constants
# ---------------------------------------------------------------------------

DEFAULT_RING_BYTES: Final = 1024 * 1024  # 1 MiB replay buffer per tab
DEFAULT_QUEUE_ITEMS: Final = 256  # 256 * 64 KiB worst case, usually far less
DEFAULT_READ_CHUNK: Final = 64 * 1024
DEFAULT_MAX_SESSIONS: Final = 12
DEFAULT_MAX_WRITE_BYTES: Final = 1024 * 1024
DEFAULT_TERM: Final = "xterm-256color"
DEFAULT_PATH: Final = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DEFAULT_LANG: Final = "C.UTF-8"

# The route layer builds keys as ``f"{session_id}::{tab_id}"``.  Keep the
# separator here so session deletion can remove its terminals without the
# HTTP layer duplicating the format.
KEY_SEPARATOR: Final = "::"

MIN_DIMENSION: Final = 1
MAX_DIMENSION: Final = 1000

# Only these keys survive the environment scrub.  Everything else (API keys,
# cloud credentials, LD_PRELOAD, NODE_OPTIONS, ...) is dropped.
SAFE_ENV_KEYS: Final[tuple[str, ...]] = (
    "PATH",
    "HOME",
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
)

# Canonical executable paths accepted by default.  ``Path.resolve()`` collapses
# the /bin -> /usr/bin symlink, so both spellings are listed for portability.
STANDARD_SHELL_PATHS: Final[frozenset[str]] = frozenset(
    {
        "/bin/bash",
        "/bin/zsh",
        "/bin/sh",
        "/usr/bin/bash",
        "/usr/bin/zsh",
        "/usr/bin/sh",
    }
)

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_MAX_KEY_LENGTH: Final = 256
_MAX_CWD_LENGTH: Final = 4096

State = Literal["starting", "running", "exited"]
DataCallback = Callable[["TerminalSession", bytes], None]
ExitCallback = Callable[["TerminalSession", "int | None"], None]

_EOF: Final = object()


# ---------------------------------------------------------------------------
# Errors (framework-free; the HTTP/WS layer maps them to wire codes)
# ---------------------------------------------------------------------------


class TerminalError(Exception):
    """Base class for expected terminal failures.

    Each subclass carries a stable ``code`` and an HTTP-ish ``status`` so the
    FastAPI adapter can translate without inspecting strings.
    """

    code: str = "TERMINAL_ERROR"
    status: int = 400

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class InvalidTerminalKey(TerminalError):
    code = "INVALID_TERMINAL_KEY"
    status = 400


class TerminalAlreadyExists(TerminalError):
    code = "TERMINAL_EXISTS"
    status = 409


class TerminalLimitExceeded(TerminalError):
    code = "TERMINAL_LIMIT_EXCEEDED"
    status = 429


class InvalidShell(TerminalError):
    code = "INVALID_SHELL"
    status = 400


class CwdNotAllowed(TerminalError):
    code = "CWD_NOT_ALLOWED"
    status = 400


class InvalidSize(TerminalError):
    code = "INVALID_SIZE"
    status = 400


class TerminalClosed(TerminalError):
    code = "TERMINAL_CLOSED"
    status = 409


class TerminalSpawnFailed(TerminalError):
    code = "TERMINAL_SPAWN_FAILED"
    status = 500


# ---------------------------------------------------------------------------
# Shell and environment resolution
# ---------------------------------------------------------------------------


def _has_control(value: str) -> bool:
    return _CONTROL_CHARS.search(value) is not None


def resolve_shell(
    requested: str | None = None,
    *,
    allowed_shells: frozenset[str] | None = None,
    base_env: Mapping[str, str] | None = None,
) -> str:
    """Resolve an allowed shell executable.

    Pre: ``requested`` is ``None`` or an absolute path without control chars.
    Post: returns a resolved, executable path present in the allowlist.

    ``$SHELL`` is used only when ``requested`` is ``None`` and is silently
    skipped when it is not allowlisted (fish/nu users still get bash).  An
    explicit ``requested`` value is never silently replaced.

    Raises: ``InvalidShell`` when no candidate is acceptable.
    """

    allowed = allowed_shells if allowed_shells is not None else STANDARD_SHELL_PATHS

    if requested is not None:
        candidates: list[str] = [requested]
    else:
        env = base_env if base_env is not None else os.environ
        env_shell = env.get("SHELL", "").strip()
        candidates = [env_shell] if env_shell else []
        candidates.extend(["/bin/bash", "/bin/zsh", "/bin/sh"])

    for raw in candidates:
        if not raw or _has_control(raw) or not raw.startswith("/"):
            continue
        try:
            resolved = str(Path(raw).resolve(strict=True))
        except (OSError, RuntimeError):
            continue
        if resolved not in allowed:
            continue
        if not os.path.isfile(resolved) or not os.access(resolved, os.X_OK):
            continue
        return resolved

    if requested is not None:
        raise InvalidShell("the requested shell is not allowed")
    raise InvalidShell("no allowed shell was found")


def scrub_environment(
    base: Mapping[str, str] | None = None,
    overrides: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build the minimal environment for the child shell.

    Pre: ``base`` and ``overrides`` contain no NUL bytes.
    Post: result contains only ``SAFE_ENV_KEYS``; ``TERM`` is forced to
          ``xterm-256color``; ``PATH`` and ``HOME`` are always present.
          Secrets, ``LD_PRELOAD``, ``NODE_OPTIONS`` and every other key are
          dropped.
    """

    source: dict[str, str] = dict(os.environ if base is None else base)
    if overrides:
        source.update(overrides)

    env: dict[str, str] = {}
    for key in SAFE_ENV_KEYS:
        value = source.get(key)
        if isinstance(value, str) and "\x00" not in value:
            env[key] = value

    env["PATH"] = env.get("PATH") or DEFAULT_PATH
    env["HOME"] = env.get("HOME") or str(Path.home())
    env["TERM"] = DEFAULT_TERM
    env.setdefault("LANG", DEFAULT_LANG)
    return env


def _validate_dimension(value: int, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvalidSize(f"{name} must be an integer")
    if value < MIN_DIMENSION or value > MAX_DIMENSION:
        raise InvalidSize(f"{name} must be in {MIN_DIMENSION}..{MAX_DIMENSION}")
    return value


def _set_window_size(fd: int, cols: int, rows: int) -> None:
    """Apply ``TIOCSWINSZ``; ``rows``/``cols`` order matters for the struct."""

    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def _request_parent_death_signal() -> None:
    """Ask Linux to SIGTERM the child if the backend dies (best effort)."""

    if sys.platform != "linux":
        return
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        # PR_SET_PDEATHSIG = 1
        libc.prctl(1, int(signal.SIGTERM), 0, 0, 0)
    except Exception:  # pragma: no cover - platform/libc dependent
        return


# ---------------------------------------------------------------------------
# TerminalSession
# ---------------------------------------------------------------------------


class TerminalSession:
    """One PTY and its child process group.

    Instances are created by :class:`TerminalManager`; do not construct them
    directly.  Public methods are coroutines because they may need to wait for
    the event loop, child exit, or a non-blocking write.

    Representation invariant:
      * ``_master_fd`` is ``None`` iff ``_finished`` is true.
      * ``_pgid == _pid`` because the child calls ``setsid()``.
      * ``_ring`` length is always <= ``_ring_bytes``.
      * output is appended to ``_ring`` and the queue in the same loop turn, so
        replay and live data preserve order up to the queue's bounded capacity.
    """

    __slots__ = (
        "_attached",
        "_closing",
        "_cols",
        "_created_at",
        "_cwd",
        "_dropped_bytes",
        "_eof_at",
        "_exit_code",
        "_exit_status",
        "_finished",
        "_key",
        "_loop",
        "_master_fd",
        "_on_data",
        "_on_exit",
        "_pgid",
        "_pid",
        "_queue",
        "_queue_items",
        "_read_chunk",
        "_reader_eof",
        "_reader_paused",
        "_reaped",
        "_reaper_task",
        "_ring",
        "_ring_bytes",
        "_rows",
        "_shell",
        "_started_at",
        "_state",
        "_supervised",
        "_supervised_exit",
        "_supervised_exit_at",
        "_supervised_signal",
    )

    def __init__(
        self,
        *,
        key: str,
        pid: int,
        pgid: int,
        master_fd: int,
        shell: str,
        cwd: str,
        cols: int,
        rows: int,
        ring_bytes: int,
        queue_items: int,
        read_chunk: int,
        loop: asyncio.AbstractEventLoop,
        on_data: DataCallback | None,
        on_exit: ExitCallback | None,
        supervised: bool = False,
    ) -> None:
        self._key = key
        self._pid = pid
        self._pgid = pgid
        self._supervised = supervised
        self._supervised_exit: tuple[int | None, int | None] | None = None
        self._supervised_exit_at: float | None = None
        self._supervised_signal: int | None = None
        self._master_fd: int | None = master_fd
        self._loop = loop
        self._shell = shell
        self._cwd = cwd
        self._cols = cols
        self._rows = rows
        self._ring = bytearray()
        self._ring_bytes = ring_bytes
        self._queue: asyncio.Queue[bytes | object] = asyncio.Queue(
            maxsize=queue_items
        )
        self._queue_items = queue_items
        self._read_chunk = read_chunk
        self._on_data = on_data
        self._on_exit = on_exit
        self._state: State = "starting"
        self._finished = False
        self._reaped = False
        self._exit_status: int | None = None
        self._exit_code: int | None = None
        self._reader_eof = False
        self._reader_paused = False
        self._eof_at: float | None = None
        self._closing = False
        self._reaper_task: asyncio.Task[None] | None = None
        self._started_at = loop.time()
        self._created_at = time.time()
        self._dropped_bytes = 0
        self._attached = False

    # -- read-only metadata -------------------------------------------------

    @property
    def key(self) -> str:
        return self._key

    @property
    def pid(self) -> int:
        return self._pid

    @property
    def pgid(self) -> int:
        return self._pgid

    @property
    def shell(self) -> str:
        return self._shell

    @property
    def cwd(self) -> str:
        return self._cwd

    @property
    def cols(self) -> int:
        return self._cols

    @property
    def rows(self) -> int:
        return self._rows

    @property
    def state(self) -> State:
        return self._state

    @property
    def created_at(self) -> float:
        return self._created_at

    @property
    def closed(self) -> bool:
        return self._finished

    @property
    def exit_code(self) -> int | None:
        return self._exit_code

    @property
    def exit_signal(self) -> int | None:
        """Return the terminating signal number, or ``None``."""

        if self._supervised and self._supervised_signal is not None:
            return self._supervised_signal
        status = self._exit_status
        if status is None:
            return None
        try:
            if os.WIFSIGNALED(status):
                return os.WTERMSIG(status)
        except (AttributeError, ValueError):  # pragma: no cover
            return None
        return None

    @property
    def dropped_bytes(self) -> int:
        """Bytes displaced from the bounded queue under extreme backpressure."""

        return self._dropped_bytes

    def scrollback(self) -> bytes:
        """Post: returns a copy of the most recent <= ``ring_bytes`` output."""

        return bytes(self._ring)

    def try_attach(self) -> bool:
        """Claim the single WebSocket attachment slot.

        Post: returns ``True`` only for the first caller; a second concurrent
              viewer is rejected so two sockets cannot steal each other's data.
        """

        if self._attached:
            return False
        self._attached = True
        return True

    def detach(self) -> None:
        self._attached = False

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Register the reader and reaper on the running loop.

        Post: data produced by the child reaches the queue; ``state`` moves to
              ``running`` shortly after spawn unless the child already exited.
        """

        if self._finished:
            return
        self._loop.add_reader(self._master_fd, self._on_readable)  # type: ignore[arg-type]
        self._reaper_task = self._loop.create_task(self._reap_loop())

    async def read(self, timeout: float | None = None) -> bytes | None:
        """Read the next output chunk.

        Post: returns bytes in order, or ``None`` once the child is gone and the
              queue is drained.  On timeout returns ``b""`` (an idle tick, not
              end-of-stream).  Re-entrant calls are not supported; the router
              guarantees one pump per session.
        """

        if self._finished and self._queue.empty():
            return None
        try:
            item = (
                await asyncio.wait_for(self._queue.get(), timeout)
                if timeout is not None
                else await self._queue.get()
            )
        except TimeoutError:
            return b""

        self._resume_reader_if_drained()
        if item is _EOF:
            return None
        assert isinstance(item, bytes)
        return item

    async def write(self, data: bytes | str) -> None:
        """Write input to the PTY.

        Pre: ``data`` encodes to <= 1 MiB.
        Post: bytes are queued to the kernel; on a full PTY buffer the coroutine
              retries until writable or the session closes.
        Raises: ``TerminalClosed`` after the child is gone.
        """

        payload = (
            data.encode("utf-8", errors="strict")
            if isinstance(data, str)
            else bytes(data)
        )
        if len(payload) > DEFAULT_MAX_WRITE_BYTES:
            raise ValueError("input frame is too large")

        offset = 0
        deadline = self._loop.time() + 5.0
        while offset < len(payload):
            fd = self._master_fd
            if fd is None or self._finished:
                raise TerminalClosed("the terminal has exited")
            try:
                written = os.write(fd, payload[offset:])
            except BlockingIOError:
                if self._loop.time() >= deadline:
                    raise TerminalClosed(
                        "the terminal input buffer is full"
                    ) from None
                await asyncio.sleep(0.005)
                continue
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF):
                    raise TerminalClosed("the terminal has exited") from exc
                raise
            if written <= 0:
                raise TerminalClosed("the terminal has exited")
            offset += written

    async def resize(self, cols: int, rows: int) -> None:
        """Apply a new window size.

        Post: the kernel reports the new size to the child; no-op after exit.
        Raises: ``InvalidSize`` for out-of-range values.
        """

        cols = _validate_dimension(cols, "cols")
        rows = _validate_dimension(rows, "rows")
        self._cols = cols
        self._rows = rows
        fd = self._master_fd
        if fd is None or self._finished:
            return
        try:
            _set_window_size(fd, cols, rows)
        except OSError as exc:  # pragma: no cover - child may close between
            if exc.errno not in (errno.EIO, errno.EBADF):
                raise

    async def close(self, grace_s: float = 1.0) -> None:
        """Terminate the child and its process group.

        Post: idempotent.  Sends SIGHUP, waits up to ``grace_s``, then SIGTERM,
        then SIGKILL.  The master fd is closed, a final EOF is queued, and
        ``on_exit`` fires exactly once.
        """

        if self._finished:
            return
        if self._closing:
            # Another caller is already escalating; wait for completion.
            while not self._finished:
                await asyncio.sleep(0.01)
            return

        self._closing = True
        self._remove_reader()
        self._signal_group(signal.SIGHUP)

        deadline = self._loop.time() + max(0.0, grace_s)
        while self._loop.time() < deadline:
            if self._poll_wait():
                break
            await asyncio.sleep(0.02)

        if not self._reaped:
            self._signal_group(signal.SIGTERM)
            term_deadline = min(deadline + 0.5, self._loop.time() + 0.5)
            while self._loop.time() < term_deadline:
                if self._poll_wait():
                    break
                await asyncio.sleep(0.02)

        if not self._reaped:
            self._signal_group(signal.SIGKILL)

        for _ in range(100):
            if self._poll_wait():
                break
            await asyncio.sleep(0.01)

        self._drain_available()
        self._finish(self._exit_code)

    def kill_now(self) -> None:
        """Synchronously SIGKILL the process group (last-resort shutdown)."""

        self._remove_reader()
        self._signal_group(signal.SIGKILL)

    def reap_blocking(self, timeout_s: float = 1.0) -> None:
        """Reap synchronously; used only by ``TerminalManager.shutdown_now``."""

        self._remove_reader()
        self._signal_group(signal.SIGKILL)
        deadline = time.monotonic() + max(0.0, timeout_s)
        while time.monotonic() < deadline:
            if self._poll_wait():
                break
            time.sleep(0.01)
        self._drain_available()
        self._finish(self._exit_code)

    # -- reader / reaper ----------------------------------------------------

    def mark_supervised_exit(self, code: int | None, signal_number: int | None) -> None:
        """Record an exit reported by the PTY host (event-loop thread only)."""

        if self._supervised_exit is not None or self._finished:
            return
        self._supervised_exit = (code, signal_number)
        self._supervised_exit_at = self._loop.time()
        self._supervised_signal = signal_number
        self._exit_code = code

    def _on_readable(self) -> None:
        if self._finished:
            return
        fd = self._master_fd
        if fd is None:
            return
        try:
            chunk = os.read(fd, self._read_chunk)
        except BlockingIOError:
            return
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF):
                self._on_eof()
                return
            LOG.warning("terminal read failed key=%s errno=%s", self._key, exc.errno)
            self._on_eof()
            return

        if not chunk:
            self._on_eof()
            return

        if self._state == "starting":
            self._state = "running"
        self._publish(chunk)

    def _publish(self, chunk: bytes) -> None:
        self._append_ring(chunk)

        if self._queue.full():
            # The consumer is behind.  Keep the newest chunk (readers must make
            # progress) and drop the oldest; then pause until the queue drains.
            try:
                displaced = self._queue.get_nowait()
                if isinstance(displaced, bytes):
                    self._dropped_bytes += len(displaced)
            except asyncio.QueueEmpty:  # pragma: no cover - full implies nonempty
                pass
            self._pause_reader()

        try:
            self._queue.put_nowait(chunk)
        except asyncio.QueueFull:  # pragma: no cover - defended above
            self._dropped_bytes += len(chunk)

        callback = self._on_data
        if callback is not None:
            try:
                callback(self, chunk)
            except Exception:  # pragma: no cover - callback must not break I/O
                LOG.exception("terminal on_data callback failed key=%s", self._key)

    def _append_ring(self, chunk: bytes) -> None:
        self._ring.extend(chunk)
        overflow = len(self._ring) - self._ring_bytes
        if overflow > 0:
            del self._ring[:overflow]

    def _on_eof(self) -> None:
        self._reader_eof = True
        self._eof_at = self._loop.time()
        self._remove_reader()

    def _pause_reader(self) -> None:
        if self._reader_paused:
            return
        self._reader_paused = True
        self._remove_reader()

    def _resume_reader_if_drained(self) -> None:
        if not self._reader_paused or self._finished or self._reader_eof:
            return
        if self._queue.qsize() <= max(1, self._queue_items // 2):
            self._reader_paused = False
            fd = self._master_fd
            if fd is not None:
                self._loop.add_reader(fd, self._on_readable)

    def _remove_reader(self) -> None:
        fd = self._master_fd
        if fd is None:
            return
        try:
            self._loop.remove_reader(fd)
        except (ValueError, OSError, RuntimeError):  # pragma: no cover - loop closed
            pass

    def _drain_available(self) -> None:
        """Drain bytes still buffered when the child exits."""

        fd = self._master_fd
        if fd is None:
            return
        while True:
            try:
                chunk = os.read(fd, self._read_chunk)
            except (BlockingIOError, OSError):
                return
            if not chunk:
                return
            self._publish(chunk)

    async def _reap_loop(self) -> None:
        try:
            while not self._reaped:
                if self._poll_wait():
                    break
                if self._state == "starting" and self._loop.time() - self._started_at > 0.05:
                    self._state = "running"
                if (
                    self._reader_eof
                    and self._eof_at is not None
                    and self._loop.time() - self._eof_at > 2.0
                ):
                    # The slave closed but the child did not exit.  Do not leave
                    # a detached process group (or a zombie) behind.
                    LOG.warning("terminal child did not exit after EOF key=%s", self._key)
                    self._signal_group(signal.SIGTERM)
                    for _ in range(25):
                        if self._poll_wait():
                            break
                        await asyncio.sleep(0.02)
                    if not self._reaped:
                        self._signal_group(signal.SIGKILL)
                        for _ in range(25):
                            if self._poll_wait():
                                break
                            await asyncio.sleep(0.02)
                    self._drain_available()
                    self._finish(self._exit_code)
                    return
                await asyncio.sleep(0.02)
        except asyncio.CancelledError:  # pragma: no cover - loop shutdown
            raise

        self._drain_available()
        self._finish(self._exit_code)

    def _poll_wait(self) -> bool:
        if self._reaped:
            return True
        if self._supervised:
            # The PTY host owns waitpid. Wait for the reader to drain the last
            # output (EOF) or a short grace after the exit report, so a fast
            # child cannot lose its final bytes.
            if self._supervised_exit is None:
                return False
            drained = self._reader_eof or (
                self._supervised_exit_at is not None
                and self._loop.time() - self._supervised_exit_at > 0.5
            )
            if drained:
                self._reaped = True
                return True
            return False
        try:
            pid, status = os.waitpid(self._pid, os.WNOHANG)
        except ChildProcessError:
            self._reaped = True
            return True
        except OSError as exc:  # pragma: no cover - unexpected
            LOG.warning("waitpid failed key=%s errno=%s", self._key, exc.errno)
            self._reaped = True
            return True

        if pid != self._pid:
            return False

        self._reaped = True
        self._exit_status = status
        try:
            self._exit_code = os.waitstatus_to_exitcode(status)
        except ValueError:  # pragma: no cover
            self._exit_code = None
        return True

    def _finish(self, exit_code: int | None) -> None:
        if self._finished:
            return
        self._finished = True
        self._state = "exited"
        self._exit_code = exit_code if self._exit_code is None else self._exit_code

        self._remove_reader()
        fd = self._master_fd
        self._master_fd = None
        if fd is not None:
            try:
                os.close(fd)
            except OSError:  # pragma: no cover - already closed
                pass

        # Preserve ordering: the EOF marker is enqueued after all data.
        while self._queue.full():
            try:
                displaced = self._queue.get_nowait()
                if isinstance(displaced, bytes):
                    self._dropped_bytes += len(displaced)
            except asyncio.QueueEmpty:  # pragma: no cover
                break
        try:
            self._queue.put_nowait(_EOF)
        except asyncio.QueueFull:  # pragma: no cover
            pass

        self._reader_paused = False
        callback = self._on_exit
        if callback is not None:
            try:
                callback(self, self._exit_code)
            except Exception:  # pragma: no cover
                LOG.exception("terminal on_exit callback failed key=%s", self._key)

    def _signal_group(self, sig: int) -> None:
        if self._pgid <= 0 or self._pid <= 0:
            return
        try:
            os.killpg(self._pgid, sig)
            return
        except ProcessLookupError:
            # The child may not have executed setsid() yet.
            try:
                os.kill(self._pid, sig)
            except ProcessLookupError:
                return
        except PermissionError:  # pragma: no cover - same-user normally
            LOG.warning("killpg denied key=%s signal=%s", self._key, sig)
            return


# ---------------------------------------------------------------------------
# TerminalManager
# ---------------------------------------------------------------------------


class TerminalManager:
    """Owns the live terminal sessions for the backend process.

    Pre: constructed and used on a single asyncio event loop.
    Post: ``shutdown``/``shutdown_now`` leaves no live child process groups.

    The manager is intentionally unaware of HTTP sessions.  The key is an
    opaque string; the route layer uses ``f"{session_id}::{tab_id}"``.
    """

    def __init__(
        self,
        *,
        is_cwd_allowed: Callable[[str], bool] | None = None,
        max_sessions: int = DEFAULT_MAX_SESSIONS,
        ring_bytes: int = DEFAULT_RING_BYTES,
        queue_items: int = DEFAULT_QUEUE_ITEMS,
        read_chunk: int = DEFAULT_READ_CHUNK,
        shell_allowlist: frozenset[str] | None = None,
        env_base: Mapping[str, str] | None = None,
        default_cwd: str | None = None,
        on_data: DataCallback | None = None,
        on_exit: ExitCallback | None = None,
        use_pty_host: bool = True,
    ) -> None:
        if max_sessions < 1:
            raise ValueError("max_sessions must be positive")
        if ring_bytes < 1:
            raise ValueError("ring_bytes must be positive")
        if queue_items < 2:
            raise ValueError("queue_items must be >= 2")

        self._is_cwd_allowed = is_cwd_allowed
        self._max_sessions = max_sessions
        self._ring_bytes = ring_bytes
        self._queue_items = queue_items
        self._read_chunk = read_chunk
        self._shell_allowlist = shell_allowlist
        self._env_base = env_base
        self._default_cwd = default_cwd
        self._on_data = on_data
        self._on_exit = on_exit
        self._use_pty_host = use_pty_host
        self._spawner: PtySpawner | None = None
        self._spawner_failed = False
        self._sessions: dict[str, TerminalSession] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # -- inspection ---------------------------------------------------------

    def __len__(self) -> int:
        return len(self._sessions)

    @property
    def max_sessions(self) -> int:
        return self._max_sessions

    def get(self, session_key: str) -> TerminalSession | None:
        return self._sessions.get(session_key)

    def list(self) -> tuple[TerminalSession, ...]:
        """Post: returns a snapshot tuple; never the internal dict."""

        return tuple(self._sessions.values())

    def keys_with_prefix(self, prefix: str) -> tuple[str, ...]:
        return tuple(key for key in self._sessions if key.startswith(prefix))

    def count_with_prefix(self, prefix: str) -> int:
        return sum(1 for key in self._sessions if key.startswith(prefix))

    # -- spawn --------------------------------------------------------------

    async def spawn(
        self,
        session_key: str,
        *,
        shell: str | None = None,
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        cols: int = 80,
        rows: int = 24,
        argv: Sequence[str] | None = None,
    ) -> TerminalSession:
        """Create a PTY, fork/exec the shell, and start reading.

        Pre: ``session_key`` is unique, control-character free and <= 256 chars;
             ``cwd`` (when given) passes ``is_cwd_allowed``; ``cols``/``rows``
             are in 1..1000; ``argv`` (when given) starts with an allowlisted
             shell executable.
        Post: returns a live ``TerminalSession`` registered under the key.  On
              any failure the PTY fds are closed and no session is registered.
        Raises: ``InvalidTerminalKey``, ``TerminalAlreadyExists``,
                ``TerminalLimitExceeded``, ``InvalidShell``, ``CwdNotAllowed``,
                ``InvalidSize`` or ``TerminalSpawnFailed``.
        """

        self._ensure_loop()
        self._validate_key(session_key)
        if session_key in self._sessions:
            raise TerminalAlreadyExists("a terminal with this tab id already exists")
        if len(self._sessions) >= self._max_sessions:
            raise TerminalLimitExceeded("the terminal session limit was reached")

        cols = _validate_dimension(cols, "cols")
        rows = _validate_dimension(rows, "rows")
        resolved_cwd = self._resolve_cwd(cwd)
        resolved_shell = resolve_shell(
            shell,
            allowed_shells=self._shell_allowlist,
            base_env=self._env_base,
        )
        command = self._build_argv(resolved_shell, argv)
        child_env = scrub_environment(self._env_base, env)

        supervised = False
        pgid = 0
        master_fd: int
        slave_fd: int | None = None
        if self._use_pty_host and not self._spawner_failed:
            try:
                spawner = self._spawner
                if spawner is None:
                    spawner = PtySpawner()
                    self._spawner = spawner
                master_fd, pid, pgid = await asyncio.to_thread(
                    spawner.spawn,
                    session_key,
                    argv=command,
                    cwd=resolved_cwd,
                    env=child_env,
                    cols=cols,
                    rows=rows,
                )
                os.set_blocking(master_fd, False)
                supervised = True
            except PtySpawnerError as exc:
                LOG.warning(
                    "PTY host unavailable (%s); falling back to in-process fork",
                    exc,
                )
                self._spawner_failed = True
                self._close_spawner()

        if not supervised:
            try:
                master_fd, slave_fd = os.openpty()
            except OSError as exc:
                raise TerminalSpawnFailed("could not allocate a PTY") from exc
            try:
                _set_window_size(slave_fd, cols, rows)
                # Only the master is non-blocking. The child inherits the slave
                # as stdin/stdout/stderr and must see blocking tty semantics.
                os.set_blocking(master_fd, False)
                pid = os.fork()
            except OSError as exc:
                os.close(master_fd)
                os.close(slave_fd)
                raise TerminalSpawnFailed("could not start the terminal") from exc
            except BaseException:
                os.close(master_fd)
                os.close(slave_fd)
                raise

            if pid == 0:  # pragma: no cover - child never returns to pytest
                self._child_exec(
                    master_fd=master_fd,
                    slave_fd=slave_fd,
                    command=command,
                    cwd=resolved_cwd,
                    env=child_env,
                    parent_pid=os.getppid(),
                )
                os._exit(127)

            os.close(slave_fd)
            pgid = pid

        loop = asyncio.get_running_loop()
        try:
            session = TerminalSession(
                key=session_key,
                pid=pid,
                pgid=pgid or pid,
                master_fd=master_fd,
                shell=resolved_shell,
                cwd=resolved_cwd,
                cols=cols,
                rows=rows,
                ring_bytes=self._ring_bytes,
                queue_items=self._queue_items,
                read_chunk=self._read_chunk,
                loop=loop,
                on_data=self._on_data,
                on_exit=self._on_exit,
                supervised=supervised,
            )
        except BaseException as exc:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
            os.close(master_fd)
            raise TerminalSpawnFailed("could not register the terminal") from exc

        try:
            self._sessions[session_key] = session
            if supervised and self._spawner is not None:
                loop = asyncio.get_running_loop()

                def _deliver(
                    code: int | None,
                    signal_number: int | None,
                    *,
                    target: TerminalSession = session,
                    event_loop: asyncio.AbstractEventLoop = loop,
                ) -> None:
                    if event_loop.is_closed():
                        return
                    try:
                        event_loop.call_soon_threadsafe(
                            target.mark_supervised_exit, code, signal_number
                        )
                    except RuntimeError:  # pragma: no cover - loop shut down
                        pass

                self._spawner.register_exit(session_key, _deliver)
            session.start()
        except BaseException as exc:
            self._sessions.pop(session_key, None)
            session.reap_blocking(timeout_s=0.5)
            raise TerminalSpawnFailed("could not start the terminal reader") from exc
        LOG.info(
            "terminal spawned key=%s pid=%s shell=%s cols=%s rows=%s",
            session_key,
            pid,
            resolved_shell,
            cols,
            rows,
        )
        return session

    # -- teardown -----------------------------------------------------------

    async def close(self, session_key: str, grace_s: float = 1.0) -> bool:
        """Close a session but keep its metadata for a final exit frame.

        Post: returns ``True`` when a session existed.  The session stays in the
              map; call :meth:`destroy` to remove it.
        """

        session = self._sessions.get(session_key)
        if session is None:
            return False
        await session.close(grace_s=grace_s)
        return True

    async def destroy(self, session_key: str, grace_s: float = 1.0) -> bool:
        """Close and remove a session; subsequent attaches return 404."""

        session = self._sessions.pop(session_key, None)
        if session is None:
            return False
        await session.close(grace_s=grace_s)
        return True

    async def destroy_prefix(self, prefix: str, grace_s: float = 1.0) -> int:
        """Close every session whose key starts with ``prefix``.

        Post: returns the number of sessions removed.  Wire this into
              ``DELETE /api/sessions/{id}`` so conversation deletion cannot
              leak shells.
        """

        keys = tuple(key for key in self._sessions if key.startswith(prefix))
        results = await asyncio.gather(
            *(self.destroy(key, grace_s=grace_s) for key in keys),
            return_exceptions=False,
        )
        return sum(1 for removed in results if removed)

    async def destroy_owner(self, owner_id: str, grace_s: float = 1.0) -> int:
        """Close every terminal owned by one conversation.

        Post: returns the number removed.  Call from the session DELETE path.
        """

        return await self.destroy_prefix(
            f"{owner_id}{KEY_SEPARATOR}", grace_s=grace_s
        )

    async def shutdown(self, grace_s: float = 0.5) -> None:
        """Close every session concurrently.  Post: map is empty."""

        sessions = tuple(self._sessions.values())
        self._sessions.clear()
        if sessions:
            await asyncio.gather(
                *(session.close(grace_s=grace_s) for session in sessions),
                return_exceptions=True,
            )
        self._close_spawner()

    def shutdown_now(self, timeout_s: float = 1.0) -> None:
        """Synchronous last-resort shutdown for ``Container.close()``."""

        sessions = tuple(self._sessions.values())
        self._sessions.clear()
        for session in sessions:
            try:
                session.reap_blocking(timeout_s=timeout_s)
            except Exception:  # pragma: no cover - never let shutdown raise
                LOG.exception("terminal shutdown failed key=%s", session.key)
        self._close_spawner()

    def _close_spawner(self) -> None:
        spawner = self._spawner
        self._spawner = None
        if spawner is not None:
            try:
                spawner.shutdown()
            except Exception:  # pragma: no cover - best effort
                LOG.exception("PTY host shutdown failed")

    # -- internals ----------------------------------------------------------

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        loop = asyncio.get_running_loop()
        if self._loop is None:
            self._loop = loop
        elif self._loop is not loop:
            raise RuntimeError("TerminalManager must be used on one event loop")
        return loop

    @staticmethod
    def _validate_key(session_key: str) -> None:
        if not session_key or len(session_key) > _MAX_KEY_LENGTH:
            raise InvalidTerminalKey("the terminal key is invalid")
        if _has_control(session_key):
            raise InvalidTerminalKey("the terminal key is invalid")

    def _resolve_cwd(self, cwd: str | None) -> str:
        raw = cwd if cwd is not None else self._default_cwd
        if raw is None:
            raw = str(Path.home())
        if not raw or len(raw) > _MAX_CWD_LENGTH or _has_control(raw):
            raise CwdNotAllowed("the requested working directory is not allowed")
        try:
            resolved = Path(raw).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            raise CwdNotAllowed("the requested working directory is not allowed") from None
        if not resolved.is_dir():
            raise CwdNotAllowed("the requested working directory is not allowed")
        text = str(resolved)
        if self._is_cwd_allowed is not None:
            try:
                allowed = self._is_cwd_allowed(text)
            except Exception:
                LOG.exception("cwd containment hook failed")
                allowed = False
            if not allowed:
                raise CwdNotAllowed("the requested working directory is not allowed")
        return text

    @staticmethod
    def _build_argv(shell: str, argv: Sequence[str] | None) -> tuple[str, ...]:
        if argv is None:
            return (shell, "-l")
        if not argv:
            raise InvalidShell("the shell argv must not be empty")
        for part in argv:
            if not isinstance(part, str) or "\x00" in part:
                raise InvalidShell("the shell argv is invalid")
        try:
            first = str(Path(argv[0]).resolve(strict=True))
        except (OSError, RuntimeError):
            raise InvalidShell("the shell argv is invalid") from None
        if first != shell:
            raise InvalidShell("the shell argv must start with the resolved shell")
        return tuple(argv)

    @staticmethod
    def _child_exec(
        *,
        master_fd: int,
        slave_fd: int,
        command: tuple[str, ...],
        cwd: str,
        env: Mapping[str, str],
        parent_pid: int,
    ) -> None:
        """Child half of ``fork``: become a session leader and exec.

        Post: never returns on success.  On failure writes a short diagnostic to
              the PTY and exits 127.
        """

        try:
            os.close(master_fd)
            os.setsid()
            try:
                # Become the controlling terminal for job control (Ctrl-C,
                # SIGTSTP, foreground process groups).
                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            except OSError:
                pass

            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)

            os.chdir(cwd)
            _request_parent_death_signal()
            if os.getppid() != parent_pid:
                os._exit(127)
            os.execvpe(command[0], list(command), dict(env))
        except BaseException as exc:  # pragma: no cover - child process
            try:
                os.write(2, f"terminal exec failed: {type(exc).__name__}\r\n".encode())
            except OSError:
                pass
            os._exit(127)
