"""Single-threaded PTY spawner used by the backend.

Why this exists
---------------
Creating a controlling terminal needs ``setsid`` + ``TIOCSCTTY``, which cannot
be expressed through ``posix_spawn``; ``os.fork`` in a multi-threaded uvicorn
process is unsafe. This module runs the fork in a dedicated single-threaded
child process, passes the PTY master FD back over a Unix socket pair, and keeps
supervision (waitpid + process-group kill on backend exit) in that child.

Protocol (newline-delimited JSON over the inherited socket):
  backend -> host: {"type":"spawn","id","argv","cwd","env","cols","rows"}
                   {"type":"kill","id"}
                   {"type":"shutdown"}
  host -> backend: {"type":"spawned","id","pid","pgid"} + SCM_RIGHTS master fd
                   {"type":"exit","id","code","signal"}
                   {"type":"error","id","message"}

The host never shells out: argv is passed to ``execvpe`` as a list.
"""

from __future__ import annotations

import array
import errno
import fcntl
import json
import os
import queue
import select
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
from collections.abc import Callable, Mapping, Sequence

_SOCKET_FD_ENV = "AUTOAGENT_PTY_SOCKET_FD"
_MAX_MESSAGE = 256 * 1024
_SPAWN_TIMEOUT = 10.0


# ---------------------------------------------------------------------------
# Host side (runs in the dedicated process)
# ---------------------------------------------------------------------------


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def _request_parent_death_signal() -> None:
    try:
        import ctypes

        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        prctl = libc.prctl
        prctl.argtypes = [
            ctypes.c_int,
            ctypes.c_ulong,
            ctypes.c_ulong,
            ctypes.c_ulong,
            ctypes.c_ulong,
        ]
        prctl.restype = ctypes.c_int
        prctl(1, signal.SIGKILL, 0, 0, 0)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def _child_exec(
    *,
    slave_fd: int,
    master_fd: int,
    argv: Sequence[str],
    cwd: str,
    env: Mapping[str, str],
    parent_pid: int,
) -> None:
    def debug(message: str) -> None:
        if os.environ.get("AUTOAGENT_PTY_DEBUG") != "1":
            return
        try:
            fd = os.open(
                "/tmp/autoagent-pty-debug.log",
                os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                0o600,
            )
            try:
                os.write(fd, (message + "\n").encode("utf-8", "replace"))
            finally:
                os.close(fd)
        except OSError:
            pass

    try:
        os.close(master_fd)
        os.setsid()
        try:
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        except OSError as exc:
            debug(f"TIOCSCTTY failed: {exc!r}")
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)
        os.chdir(cwd)
        _request_parent_death_signal()
        actual_parent = os.getppid()
        if actual_parent != parent_pid:
            debug(f"parent changed: {actual_parent} != {parent_pid}")
            os._exit(127)
        debug(f"exec {argv!r} cwd={cwd}")
        os.execvpe(argv[0], list(argv), dict(env))
    except BaseException as exc:
        debug(f"exec failed: {exc!r}")
        try:
            os.write(2, f"pty host child exec failed: {exc!r}\n".encode())
        except Exception:
            pass
        os._exit(127)


class _Host:
    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._buffer = b""
        self._children: dict[str, int] = {}
        self._closed = False

    def send(self, message: Mapping[str, object], fd: int | None = None) -> None:
        payload = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        if fd is None:
            self._sock.sendall(payload)
            return
        fds = array.array("i", [fd])
        self._sock.sendmsg(
            [payload],
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, fds.tobytes())],
        )

    def spawn(self, request: Mapping[str, object]) -> None:
        request_id = str(request.get("id", ""))
        argv = request.get("argv")
        cwd = request.get("cwd")
        env = request.get("env")
        cols = request.get("cols", 80)
        rows = request.get("rows", 24)
        if (
            not request_id
            or not isinstance(argv, list)
            or not argv
            or not all(isinstance(item, str) and item for item in argv)
            or not isinstance(cwd, str)
            or not isinstance(env, dict)
            or not isinstance(cols, int)
            or not isinstance(rows, int)
        ):
            self.send(
                {"type": "error", "id": request_id or "-", "message": "invalid spawn request"}
            )
            return
        try:
            master_fd, slave_fd = os.openpty()
        except OSError as exc:
            self.send(
                {"type": "error", "id": request_id, "message": f"openpty: {exc.errno}"}
            )
            return
        try:
            _set_winsize(slave_fd, cols, rows)
            host_pid = os.getpid()
            pid = os.fork()
        except OSError as exc:
            os.close(master_fd)
            os.close(slave_fd)
            self.send(
                {"type": "error", "id": request_id, "message": f"fork: {exc.errno}"}
            )
            return
        if pid == 0:  # pragma: no cover - child never returns
            _child_exec(
                slave_fd=slave_fd,
                master_fd=master_fd,
                argv=[str(item) for item in argv],
                cwd=cwd,
                env={str(k): str(v) for k, v in env.items()},
                parent_pid=host_pid,
            )
            os._exit(127)
        os.close(slave_fd)
        self._children[request_id] = pid
        try:
            self.send(
                {"type": "spawned", "id": request_id, "pid": pid, "pgid": pid},
                fd=master_fd,
            )
        except OSError:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
        finally:
            os.close(master_fd)

    def kill(self, request_id: str) -> None:
        pid = self._children.get(request_id)
        if pid is None:
            return
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass

    def reap(self) -> None:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            except OSError:
                return
            if pid <= 0:
                return
            request_id = next(
                (key for key, value in self._children.items() if value == pid), None
            )
            if request_id is None:
                continue
            self._children.pop(request_id, None)
            code: int | None
            sig: int | None = None
            if os.WIFSIGNALED(status):
                code = None
                sig = os.WTERMSIG(status)
            else:
                code = os.WEXITSTATUS(status)
            try:
                self.send(
                    {
                        "type": "exit",
                        "id": request_id,
                        "code": code,
                        "signal": sig,
                    }
                )
            except OSError:
                return

    def run(self) -> None:
        try:
            while not self._closed:
                ready, _, _ = select.select([self._sock], [], [], 0.2)
                if ready:
                    chunk = self._sock.recv(65536)
                    if not chunk:
                        break
                    self._buffer += chunk
                    if len(self._buffer) > _MAX_MESSAGE:
                        break
                    while b"\n" in self._buffer:
                        line, self._buffer = self._buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        try:
                            request = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(request, dict):
                            continue
                        kind = request.get("type")
                        if kind == "spawn":
                            self.spawn(request)
                        elif kind == "kill":
                            self.kill(str(request.get("id", "")))
                        elif kind == "shutdown":
                            self._closed = True
                            break
                self.reap()
        finally:
            for pid in tuple(self._children.values()):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except OSError:
                    pass
            self._children.clear()


def host_main() -> int:
    raw = os.environ.get(_SOCKET_FD_ENV, "")
    if not raw.isdigit():
        print("pty host: missing socket fd", file=sys.stderr)
        return 2
    sock = socket.socket(fileno=int(raw))
    # A helper process must never inherit a controlling terminal from the
    # backend; it only needs the socket.
    _Host(sock).run()
    return 0


# ---------------------------------------------------------------------------
# Backend side
# ---------------------------------------------------------------------------


class PtySpawnerError(Exception):
    pass


class PtySpawner:
    """Client for the dedicated PTY host process."""

    def __init__(
        self,
        *,
        python: str | None = None,
        request_timeout: float = _SPAWN_TIMEOUT,
    ) -> None:
        self._python = python or sys.executable
        self._request_timeout = request_timeout
        self._lock = threading.RLock()
        self._send_lock = threading.Lock()
        self._requests: dict[str, queue.Queue[dict[str, object]]] = {}
        self._exit_callbacks: dict[str, Callable[[int | None, int | None], None]] = {}
        self._early_exits: dict[str, tuple[int | None, int | None]] = {}
        self._pending_fds: list[int] = []
        self._buffer = b""
        self._sock: socket.socket | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._reader: threading.Thread | None = None
        self._closed = False

    @property
    def alive(self) -> bool:
        process = self._process
        return bool(process and process.poll() is None and not self._closed)

    def ensure_started(self) -> None:
        with self._lock:
            if self.alive:
                return
            if self._closed:
                raise PtySpawnerError("PTY host is shut down")
            parent, child = socket.socketpair()
            env = dict(os.environ)
            env[_SOCKET_FD_ENV] = str(child.fileno())
            try:
                process = subprocess.Popen(
                    [self._python, "-m", "autoagent_backend.adapters.terminal.spawner"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=None,
                    close_fds=True,
                    pass_fds=(child.fileno(),),
                    env=env,
                )
            except OSError as exc:
                parent.close()
                child.close()
                raise PtySpawnerError(f"could not start the PTY host: {exc}") from exc
            child.close()
            self._sock = parent
            self._process = process
            self._buffer = b""
            self._pending_fds = []
            self._reader = threading.Thread(
                target=self._read_loop, name="pty-host-reader", daemon=True
            )
            self._reader.start()

    def register_exit(
        self, request_id: str, callback: Callable[[int | None, int | None], None]
    ) -> None:
        with self._lock:
            early = self._early_exits.pop(request_id, None)
            if early is not None:
                callback(*early)
                return
            self._exit_callbacks[request_id] = callback

    def spawn(
        self,
        request_id: str,
        *,
        argv: Sequence[str],
        cwd: str,
        env: Mapping[str, str],
        cols: int,
        rows: int,
    ) -> tuple[int, int, int]:
        self.ensure_started()
        result_queue: queue.Queue[dict[str, object]] = queue.Queue(maxsize=1)
        with self._lock:
            self._requests[request_id] = result_queue
        try:
            self._send(
                {
                    "type": "spawn",
                    "id": request_id,
                    "argv": list(argv),
                    "cwd": cwd,
                    "env": dict(env),
                    "cols": cols,
                    "rows": rows,
                }
            )
            try:
                result = result_queue.get(timeout=self._request_timeout)
            except queue.Empty as exc:
                raise PtySpawnerError("PTY host did not answer the spawn request") from exc
        finally:
            with self._lock:
                self._requests.pop(request_id, None)
        if result.get("type") != "spawned":
            raise PtySpawnerError(str(result.get("message", "PTY spawn failed")))
        fd = result.get("fd")
        pid = result.get("pid")
        pgid = result.get("pgid", pid)
        if not isinstance(fd, int) or fd < 0:
            raise PtySpawnerError("PTY host returned no master descriptor")
        if not isinstance(pid, int) or pid <= 0:
            raise PtySpawnerError("PTY host returned no child pid")
        if not isinstance(pgid, int) or pgid <= 0:
            pgid = pid
        return fd, pid, pgid

    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            sock = self._sock
            process = self._process
            self._sock = None
            self._process = None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        if process is not None:
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    process.kill()

    # -- internals -----------------------------------------------------

    def _send(self, message: Mapping[str, object]) -> None:
        sock = self._sock
        if sock is None:
            raise PtySpawnerError("PTY host is not running")
        payload = (json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8")
        try:
            with self._send_lock:
                sock.sendall(payload)
        except OSError as exc:
            raise PtySpawnerError(f"PTY host write failed: {exc}") from exc

    def _read_loop(self) -> None:
        sock = self._sock
        if sock is None:
            return
        while True:
            try:
                data, ancdata, _, _ = sock.recvmsg(
                    65536, socket.CMSG_SPACE(4 * 4)
                )
            except OSError as exc:
                if exc.errno in (errno.EBADF, errno.ENOTCONN):
                    break
                break
            for level, kind, payload in ancdata:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    fds = array.array("i")
                    usable = len(payload) - (len(payload) % fds.itemsize)
                    fds.frombytes(payload[:usable])
                    with self._lock:
                        self._pending_fds.extend(fds)
            if not data:
                break
            self._buffer += data
            while b"\n" in self._buffer:
                line, self._buffer = self._buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict):
                    self._dispatch(message)
        self._fail_all(PtySpawnerError("PTY host exited"))

    def _dispatch(self, message: dict[str, object]) -> None:
        kind = message.get("type")
        request_id = str(message.get("id", ""))
        if kind == "spawned":
            with self._lock:
                fd = self._pending_fds.pop(0) if self._pending_fds else -1
                waiter = self._requests.get(request_id)
            message["fd"] = fd
            if waiter is not None:
                try:
                    waiter.put_nowait(message)
                except queue.Full:
                    if fd >= 0:
                        os.close(fd)
            return
        if kind == "error":
            with self._lock:
                waiter = self._requests.get(request_id)
            if waiter is not None:
                try:
                    waiter.put_nowait(message)
                except queue.Full:
                    pass
            return
        if kind == "exit":
            code = message.get("code")
            sig = message.get("signal")
            exit_code = int(code) if isinstance(code, int) else None
            exit_signal = int(sig) if isinstance(sig, int) else None
            with self._lock:
                callback = self._exit_callbacks.pop(request_id, None)
                if callback is None:
                    self._early_exits[request_id] = (exit_code, exit_signal)
            if callback is not None:
                callback(exit_code, exit_signal)

    def _fail_all(self, error: Exception) -> None:
        with self._lock:
            waiters = list(self._requests.values())
            self._requests.clear()
            fds = self._pending_fds
            self._pending_fds = []
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass
        for waiter in waiters:
            try:
                waiter.put_nowait({"type": "error", "message": str(error)})
            except queue.Full:
                pass


__all__ = ["PtySpawner", "PtySpawnerError", "host_main"]


if __name__ == "__main__":  # pragma: no cover - exercised by the backend
    raise SystemExit(host_main())
