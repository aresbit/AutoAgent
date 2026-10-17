"""OpenCC (claude-js) spawn backend for MateBot.

Replaces the tmux + transcript-polling architecture for a single chat with a
persistent claude-js subprocess that emits stream-json events. This eliminates
the timing race between bridge.py's ResponseMonitor and the Stop hook, and
enables true streaming intermediate feedback.

Inspired by a5c-ai/claude-code-telegram-bot's ClaudeCodeProcess.ts.

## Why "long-lived" is load-bearing

The CLI in `--input-format stream-json` mode accepts many user turns over one
stdin pipe and keeps the whole conversation in memory. One process per chat
means turn N+1 costs one prompt, not one prompt plus a full transcript replay.
Every avoidable respawn throws that away.

So this module treats process death as an incident, not a normal state:

  * the CLI path is *resolved* against real candidates and validated before
    spawning, instead of being assumed (a bad path used to make every spawn die
    instantly, which the callers silently papered over by spawning again);
  * `session_id` is surfaced the moment the `system/init` frame arrives, so a
    caller can persist it and resume across restarts;
  * a spawn that dies before becoming ready *while resuming* retries once
    without `--resume`, because a stale session id must not brick a chat;
  * exit codes and the tail of stderr are retained so callers can report a real
    reason instead of an empty reply.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import stat
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional


# Candidate CLI locations, most specific first. The vendored copy wins when it
# exists so a checkout can pin its own build; otherwise fall back to the
# standard user install.
CLI_CANDIDATES: tuple[Path, ...] = (
    # .resolve() so the answer does not depend on how this module was imported
    # (xiaoshutong imports it via a relative sys.path entry).
    Path(__file__).resolve().parent / "vendor" / "opencc" / "dist" / "cli.js",
    Path.home() / ".local" / "share" / "opencc" / "cli.js",
    Path.home() / ".opencc" / "cli.js",
)


class OpenccSpawnError(RuntimeError):
    """Raised when the backend cannot be started at all (bad path, no runtime)."""


def claude_config_dir() -> Path:
    """The CLI's state directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.

    Transcripts live under `<config dir>/projects/<slug>/`. MateBot runs the
    bridge with `CLAUDE_CONFIG_DIR=~/.claude2`, so a hardcoded `~/.claude` lookup
    was asking a directory the CLI never writes to — the file was right there,
    the search was in the wrong place. Symptom: every restart reported
    "transcript is gone" and silently began a fresh conversation.
    """
    raw = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".claude"


def transcript_path(session_id: str, cwd: str) -> Path:
    """Where the CLI keeps a session's transcript.

    Layout is `<config dir>/projects/<cwd with '/' and '.' as '-'>/<uuid>.jsonl`.
    """
    slug = re.sub(r"[/.]", "-", str(Path(cwd).resolve()))
    return claude_config_dir() / "projects" / slug / f"{session_id}.jsonl"


# A session id persisted by SessionStore never expires on its own, so without a
# ceiling here one chat pins one transcript forever. That file is append-only and
# `--resume` deserializes all of it: a 100MB transcript (33 days on one chat, seen
# 2026-09-07) drove RSS past 1GB and put the runtime's GC into thrash — the CLI
# burned CPU on startup and never became ready.
#
# 25MB is the middle of an empty band: across 2190 local transcripts the largest
# healthy one was 8.1MB and *nothing* sat between 10MB and 50MB. Age is the second
# axis because a chat can idle for weeks and still carry a stale world model.
MAX_RESUME_BYTES = 25 * 1024 * 1024
MAX_RESUME_AGE_DAYS = 14

# The first record is a small JSON object; cap the read so a pathological
# single-line transcript can't be slurped whole by the very check meant to
# protect us from slurping it whole.
_FIRST_LINE_LIMIT = 64 * 1024


def _human_bytes(n: float) -> str:
    """Size in the largest unit that keeps the number meaningful.

    A fixed MB format renders every sub-megabyte value as "0MB", which is
    exactly what a caller reading the rotation reason needs to distinguish.
    """
    for unit in ("B", "KB", "MB"):
        if abs(n) < 1024 or unit == "MB":
            return f"{int(n)}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}MB"


def _session_started_at(path: Path) -> Optional[float]:
    """Wall-clock start of a session, from its transcript's first record.

    Not `st_mtime` (that is the *last* write) and not birth time (ext4 exposes
    it only through statx, which the stdlib does not surface on Linux). The
    JSONL's opening record already carries the timestamp we want, so one short
    read answers it. Returns None when it cannot be determined.
    """
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            first = fh.readline(_FIRST_LINE_LIMIT)
    except OSError:
        return None
    try:
        stamp = json.loads(first).get("timestamp")
    except (ValueError, AttributeError):
        return None
    if not isinstance(stamp, str):
        return None
    try:
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def resume_blocker(
    session_id: Optional[str],
    cwd: str,
    *,
    max_bytes: int = MAX_RESUME_BYTES,
    max_age_days: float = MAX_RESUME_AGE_DAYS,
) -> Optional[str]:
    """Why `--resume session_id` should not be attempted, or None if it should.

    Returns a human-readable reason so the caller can say which ceiling was hit
    instead of reporting every rotation as a missing transcript.
    """
    if not session_id:
        return "no session id"
    try:
        path = transcript_path(session_id, cwd)
    except OSError:
        # Can't even name the file — let the CLI decide rather than refusing.
        return None
    try:
        st = path.stat()
    except FileNotFoundError:
        # Resuming a session whose transcript is gone makes the CLI exit
        # non-zero *after* emitting an init frame, which reads like a real turn
        # that failed. Catching it here turns that into a quiet, correct
        # decision to start fresh.
        return "transcript is gone"
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return "transcript is not a regular file"
    if max_bytes and st.st_size >= max_bytes:
        return (
            f"transcript is {_human_bytes(st.st_size)} "
            f"(limit {_human_bytes(max_bytes)})"
        )
    if max_age_days:
        started = _session_started_at(path)
        if started is not None:
            age_days = (time.time() - started) / 86400
            if age_days >= max_age_days:
                return f"session is {age_days:.0f} days old (limit {max_age_days:g})"
    return None


def can_resume(session_id: Optional[str], cwd: str) -> bool:
    """Whether `--resume session_id` stands a chance of working *and* is wise."""
    return resume_blocker(session_id, cwd) is None


def resolve_cli_path(explicit: Optional[str | Path] = None) -> Path:
    """Locate the claude-js CLI.

    Order: explicit argument → `OPENCC_CLI_PATH` → known install locations.
    Raises `OpenccSpawnError` listing what was tried, because a silent fallback
    here is exactly the failure that made every message respawn a doomed
    process.
    """
    tried: list[str] = []

    for candidate in (explicit, os.environ.get("OPENCC_CLI_PATH")):
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if path.is_file():
            return path
        tried.append(str(path))

    for path in CLI_CANDIDATES:
        if path.is_file():
            return path
        tried.append(str(path))

    raise OpenccSpawnError(
        "OpenCC CLI not found. Tried:\n  "
        + "\n  ".join(tried)
        + "\nSet OPENCC_CLI_PATH or opencc_cli_path in feishu_config.yaml."
    )


# Kept for backwards compatibility with callers that import it. Resolves
# lazily-ish at import time and degrades to the vendored path when nothing is
# installed, so importing this module never explodes.
try:
    DEFAULT_CLI_PATH = resolve_cli_path()
except OpenccSpawnError:
    DEFAULT_CLI_PATH = CLI_CANDIDATES[0]


class OpenccSession:
    """One persistent claude-js subprocess per logical conversation.

    Reads stream-json from stdout, writes stream-json to stdin. Each parsed
    stdout JSON line is dispatched to `on_event(event_dict)`. Stderr is
    captured into `on_stderr(line)` for debugging.

    The process is spawned on first `send()` (or eagerly via `start()`). If
    `session_id` is provided, the process resumes that existing conversation.
    """

    # A spawn that dies this fast never really started; treat it as a spawn
    # failure rather than an end-of-conversation.
    EARLY_EXIT_S = 25.0

    # Window in which a failing `--resume` gives up. Observed at ~0.6s; the
    # margin covers a loaded machine without swallowing real turn errors.
    RESUME_FAIL_WINDOW_S = 5.0

    def __init__(
        self,
        on_event: Callable[[dict], None],
        on_stderr: Optional[Callable[[str], None]] = None,
        on_close: Optional[Callable[[Optional[int]], None]] = None,
        cli_path: Optional[Path] = None,
        bun_path: str = "bun",
        cwd: Optional[str] = None,
        session_id: Optional[str] = None,
        model: Optional[str] = None,
        extra_args: Optional[list[str]] = None,
        append_system_prompt: Optional[str] = None,
        on_session_id: Optional[Callable[[str], None]] = None,
    ):
        self.on_event = on_event
        self.on_stderr = on_stderr or (lambda _l: None)
        self.on_close = on_close or (lambda _c: None)
        self.on_session_id = on_session_id or (lambda _s: None)
        # Resolve once, at construction, so a misconfiguration surfaces here
        # instead of as a mysterious instant exit on every message.
        self.cli_path = resolve_cli_path(cli_path)
        self.bun_path = bun_path
        self.cwd = cwd or os.getcwd()
        self.session_id = session_id
        self.model = model
        self.extra_args = list(extra_args or [])
        self.append_system_prompt = append_system_prompt

        self._proc: Optional[subprocess.Popen] = None
        self._stdout_thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._spawn_lock = threading.RLock()
        self._stdin_lock = threading.Lock()
        self._spawned = False
        self._closing = False
        self._resume_used = False
        self._spawn_ts = 0.0
        self._last_prompt_line: Optional[str] = None
        self._produced_output = False
        self._published_sid: Optional[str] = None

        # Diagnostics for callers that want to report *why* a turn produced
        # nothing.
        self.spawn_count = 0
        self.last_exit_code: Optional[int] = None
        self.stderr_tail: deque[str] = deque(maxlen=40)

        # Set when the CLI emits its `system/init` frame — the point at which
        # it is genuinely accepting turns.
        self.ready = threading.Event()

        # Messages queued before the process is fully spawned.
        self._pending: queue.Queue[str] = queue.Queue()

    # -- public API -------------------------------------------------------

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    @property
    def uptime(self) -> float:
        return time.time() - self._spawn_ts if self._spawn_ts else 0.0

    def start(self) -> None:
        """Spawn the process now instead of waiting for the first message.

        Warming the process at bridge startup removes several seconds of
        cold-start from the user's first turn.
        """
        self._ensure_spawned()

    def wait_ready(self, timeout: float = 60.0) -> bool:
        return self.ready.wait(timeout=timeout)

    def send(self, text: str) -> None:
        """Send a user prompt to the persistent process."""
        msg = {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": text}],
            },
        }
        line = json.dumps(msg, ensure_ascii=False) + "\n"
        self._last_prompt_line = line

        self._ensure_spawned()

        if not self.is_running:
            # Process hasn't fully come up yet; queue the message.
            self._pending.put(line)
            return
        self._write_stdin(line)

    def send_interrupt(self) -> None:
        """Send SIGINT to ask claude-js to stop generation gracefully."""
        if self.is_running and self._proc:
            try:
                self._proc.send_signal(2)  # SIGINT
            except Exception:
                pass

    def close(self) -> None:
        """Terminate the process and join reader threads."""
        self._closing = True
        self.ready.clear()
        if self._proc and self.is_running:
            try:
                self._proc.stdin and self._proc.stdin.close()
            except Exception:
                pass
            try:
                self._proc.terminate()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        for t in (self._stdout_thread, self._stderr_thread):
            if t and t.is_alive():
                t.join(timeout=1)

    def failure_reason(self) -> str:
        """Best-effort explanation of the last death, for user-facing errors."""
        tail = [l for l in self.stderr_tail if l.strip()][-4:]
        detail = "\n".join(tail) if tail else "(no stderr output)"
        return f"exit code {self.last_exit_code}\n{detail}"

    # -- internals --------------------------------------------------------

    def _ensure_spawned(self) -> None:
        """Spawn if this session has no live process.

        Unlike the previous `if not self._spawned` guard, this also revives a
        session whose process died — the caller keeps the same object, so the
        persisted `session_id` (and therefore the conversation) carries over.
        """
        with self._spawn_lock:
            if self._closing:
                return
            if self._spawned and self.is_running:
                return
            self._spawn()

    def _spawn(self) -> None:
        with self._spawn_lock:
            args = [
                self.bun_path,
                str(self.cli_path),
                "--print",
                "--verbose",
                "--input-format", "stream-json",
                "--output-format", "stream-json",
                "--include-partial-messages",
                "--include-hook-events",
                "--dangerously-skip-permissions",
                "--matebot",
            ]
            if self.model:
                args += ["--model", self.model]
            if self.append_system_prompt:
                args += ["--append-system-prompt", self.append_system_prompt]

            blocker = (
                resume_blocker(self.session_id, self.cwd) if self.session_id else None
            )
            if blocker:
                self.on_stderr(
                    f"[opencc] not resuming {self.session_id}: {blocker}; "
                    "starting a fresh session"
                )
                self.session_id = None
            self._resume_used = bool(self.session_id)
            if self.session_id:
                args += ["--resume", self.session_id]
            args += self.extra_args

            if not shutil.which(self.bun_path) and not Path(self.bun_path).is_file():
                raise OpenccSpawnError(
                    f"runtime {self.bun_path!r} not found on PATH; "
                    "set OPENCC_BUN_PATH to the bun binary"
                )

            env = os.environ.copy()
            # claude-js inherits its own state envs; strip parent's to avoid
            # accidentally resuming a different session.
            for v in ("CLAUDE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"):
                env.pop(v, None)
            env["FORCE_COLOR"] = "0"

            self.ready.clear()
            self._produced_output = False
            # 不要 bufsize=0：那样 proc.stdout 是无缓冲 FileIO，readline() 会退化
            # 成逐字节 read(1)，每个 JSON 行一次系统调用、把 CPU 白白烧掉。默认缓冲
            # 让 readline() 走 BufferedReader；stdin 侧本来就有显式 flush()。
            self._proc = subprocess.Popen(
                args,
                cwd=self.cwd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            self._spawned = True
            self._spawn_ts = time.time()
            self.spawn_count += 1

            proc = self._proc
            self._stdout_thread = threading.Thread(
                target=self._read_stdout, args=(proc,), daemon=True
            )
            self._stderr_thread = threading.Thread(
                target=self._read_stderr, args=(proc,), daemon=True
            )
            self._stdout_thread.start()
            self._stderr_thread.start()

            # Drain pending messages now that stdin is open.
            threading.Thread(
                target=self._drain_pending, args=(proc,), daemon=True
            ).start()

    def _drain_pending(self, proc: subprocess.Popen) -> None:
        # Wait for the CLI to announce itself rather than guessing with a fixed
        # sleep — a prompt written before init can be dropped on a slow start.
        if not self.ready.wait(timeout=60.0):
            self.on_stderr("[opencc] timed out waiting for init frame")
        while not self._pending.empty():
            try:
                line = self._pending.get_nowait()
            except queue.Empty:
                break
            self._write_stdin(line, proc)

    def _write_stdin(
        self, line: str, proc: Optional[subprocess.Popen] = None
    ) -> None:
        proc = proc or self._proc
        if not proc or not proc.stdin:
            return
        with self._stdin_lock:
            try:
                proc.stdin.write(line.encode("utf-8"))
                proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError) as e:
                self.on_stderr(f"[opencc] stdin write failed: {e}")

    def _read_stdout(self, proc: subprocess.Popen) -> None:
        try:
            for raw in iter(proc.stdout.readline, b""):
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    self.on_stderr(f"[opencc] non-JSON stdout: {line[:200]}")
                    continue

                # Track session_id continuously — it changes across resumes —
                # but only *publish* it once a turn has completed cleanly, so
                # a spawn that dies on startup can't overwrite a good id on
                # disk with the throwaway one it announced before failing.
                sid = event.get("session_id")
                if sid and sid != self.session_id:
                    self.session_id = sid

                etype = event.get("type")
                if etype == "system" and event.get("subtype") == "init":
                    self.ready.set()
                elif etype == "assistant":
                    self._produced_output = True
                elif etype == "result" and not event.get("is_error"):
                    self._publish_session_id()

                if self._is_doomed_resume(event):
                    self.on_stderr(
                        "[opencc] swallowing error result from a resume that "
                        "never started; retrying clean"
                    )
                    continue

                try:
                    self.on_event(event)
                except Exception as e:
                    self.on_stderr(f"[opencc] on_event handler error: {e}")
        finally:
            self._handle_exit(proc)

    def _publish_session_id(self) -> None:
        if not self.session_id or self.session_id == self._published_sid:
            return
        self._published_sid = self.session_id
        try:
            self.on_session_id(self.session_id)
        except Exception as e:
            self.on_stderr(f"[opencc] on_session_id error: {e}")

    def _is_doomed_resume(self, event: dict) -> bool:
        """True for the error `result` a failed `--resume` emits on its way out.

        Without this the caller renders an empty errored reply, marks the turn
        finished, and then drops the real answer that the clean retry produces
        a moment later.

        Kept deliberately narrow: only a resumed spawn, only before it has
        produced any assistant output, and only inside the short window in
        which resume validation fails (observed at ~0.6s). A genuine mid-turn
        error therefore still reaches the user.
        """
        return (
            event.get("type") == "result"
            and bool(event.get("is_error"))
            and self._resume_used
            and not self._produced_output
            and (time.time() - self._spawn_ts) < self.RESUME_FAIL_WINDOW_S
        )

    def _handle_exit(self, proc: subprocess.Popen) -> None:
        try:
            code = proc.wait(timeout=5)
        except Exception:
            code = proc.poll()
        self.last_exit_code = code
        lifetime = time.time() - self._spawn_ts
        self.ready.clear()

        if self._closing:
            self._notify_close(code)
            return

        # A resume that dies before ever announcing itself means the session id
        # is unusable (transcript pruned, different cwd, …). Drop it and retry
        # once clean rather than leaving the chat permanently broken.
        never_started = lifetime < self.EARLY_EXIT_S and code not in (0, None)
        if never_started and self._resume_used:
            self.on_stderr(
                f"[opencc] resume of {self.session_id} failed "
                f"(exit {code} after {lifetime:.1f}s); retrying without --resume"
            )
            self.session_id = None
            self._resume_used = False
            if self._last_prompt_line:
                self._pending.put(self._last_prompt_line)
            try:
                self._spawn()
                return
            except OpenccSpawnError as e:
                self.on_stderr(f"[opencc] respawn failed: {e}")

        self._notify_close(code)

    def _notify_close(self, code: Optional[int]) -> None:
        try:
            self.on_close(code)
        except Exception:
            pass

    def _read_stderr(self, proc: subprocess.Popen) -> None:
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line.strip():
                self.stderr_tail.append(line)
                self.on_stderr(line)


# ----------------------------------------------------------------------------
# Stream → Telegram bridge


class TelegramStreamRenderer:
    """Accumulates stream-json events into a per-turn TG message that is
    edit-updated in place.

    Concurrency model: stream-json events arrive on the OpenccSession stdout
    reader thread. Those handlers must NOT call Telegram synchronously —
    `api.telegram.org` is routed through the user's HTTP proxy and a
    round-trip is typically 2–5s in China. Blocking the reader thread
    back-pressures claude-js's stdout, which stalls generation and was the
    cause of the "messages arriving super slow" symptom after the spawn-mode
    switch.

    Design: a single per-renderer worker thread owns ALL Telegram I/O.
    Event handlers only mutate buffered state under a lock and set a
    `_dirty` event. The worker:
      - waits for `_dirty` (or a short timeout)
      - enforces a min interval between TG round-trips (`EDIT_THROTTLE_S`)
      - snapshots the current body and edits / sends in place
      - coalesces: many appends + one network call
    """

    # Min seconds between consecutive editMessageText calls. The proxy adds
    # 2–5s per round-trip; smaller values just queue useless work.
    EDIT_THROTTLE_S = 1.5
    MAX_TG_LEN = 4000
    # _prior_text 只用于「前面是否已发过内容」的判断，留开头一段即可（见 _render_worker）。
    _PRIOR_TEXT_KEEP = 4096

    def __init__(
        self,
        chat_id: int | str,
        telegram_api: Callable[[str, dict], Optional[dict]],
    ):
        self.chat_id = str(chat_id)
        self.telegram_api = telegram_api

        self._text = ""           # current live-chunk content
        self._prior_text = ""     # content already shipped in earlier chunks
        self._live_msg_id: Optional[int] = None
        self._tool_lines: list[str] = []
        self._closed = False
        self._lock = threading.Lock()

        # Worker thread that owns ALL network I/O.
        self._dirty = threading.Event()
        self._worker = threading.Thread(target=self._render_worker, daemon=True)
        self._worker.start()

    # -- event entry points ----------------------------------------------

    def on_event(self, event: dict) -> None:
        et = event.get("type")
        if et == "stream_event":
            self._handle_stream_event(event)
        elif et == "assistant":
            self._handle_assistant_message(event)
        elif et == "user":
            self._handle_tool_result(event)
        elif et == "result":
            self._handle_result(event)
        # "system" init / status frames: nothing user-visible.

    def _handle_stream_event(self, event: dict) -> None:
        ev = event.get("event") or {}
        if ev.get("type") == "content_block_delta":
            delta = ev.get("delta") or {}
            if delta.get("type") == "text_delta":
                self._append_text(delta.get("text", ""))
            # thinking_delta: internal reasoning, skip.

    def _handle_assistant_message(self, event: dict) -> None:
        message = event.get("message") or {}
        added = False
        with self._lock:
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    self._tool_lines.append(f"🔧 {block.get('name', '?')}")
                    added = True
        if added:
            self._dirty.set()

    def _handle_tool_result(self, event: dict) -> None:
        message = event.get("message") or {}
        content = message.get("content")
        if not isinstance(content, list):
            return
        added = False
        with self._lock:
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tag = "❌" if block.get("is_error") else "✓"
                    self._tool_lines.append(f"  {tag}")
                    added = True
        if added:
            self._dirty.set()

    def _handle_result(self, event: dict) -> None:
        is_error = bool(event.get("is_error"))
        with self._lock:
            if not (self._text.strip() or self._prior_text.strip()) and event.get("result"):
                self._text += str(event.get("result"))
            if is_error and event.get("result"):
                self._text += f"\n\n⚠️ {str(event.get('result'))[:300]}"
            self._closed = True
        self._dirty.set()

    def _append_text(self, fragment: str) -> None:
        if not fragment:
            return
        with self._lock:
            self._text += fragment
        self._dirty.set()

    def close(self) -> None:
        """Signal the worker to exit. Idempotent; safe to call when an
        already-finished renderer is being replaced for a new turn."""
        with self._lock:
            self._closed = True
        self._dirty.set()

    # -- worker loop -----------------------------------------------------

    def _render_worker(self) -> None:
        last_sent_ts = 0.0
        last_sent_body = ""
        while True:
            # Wake on new content or periodically (so close detection isn't
            # delayed if `_closed` is set while `_dirty` is already cleared).
            self._dirty.wait(timeout=1.0)
            self._dirty.clear()

            gap = time.time() - last_sent_ts
            if gap < self.EDIT_THROTTLE_S:
                time.sleep(self.EDIT_THROTTLE_S - gap)

            with self._lock:
                tool_prefix = (" ".join(self._tool_lines) + "\n\n") if self._tool_lines else ""
                text_snapshot = self._text
                tool_lines_snap_count = len(self._tool_lines)
                closed = self._closed

            body = (tool_prefix + text_snapshot).rstrip()

            if not body:
                if closed:
                    return
                continue

            try:
                if len(body) <= self.MAX_TG_LEN:
                    if body != last_sent_body:
                        self._upsert_live(body)
                        last_sent_body = body
                        last_sent_ts = time.time()
                else:
                    head = body[: self.MAX_TG_LEN]
                    self._upsert_live(head)
                    last_sent_ts = time.time()
                    with self._lock:
                        shipped_text_chars = max(0, self.MAX_TG_LEN - len(tool_prefix))
                        self._text = self._text[shipped_text_chars:]
                        del self._tool_lines[:tool_lines_snap_count]
                        # _prior_text 只被 _handle_result 用来判断「前面是否已发过
                        # 内容」，整段留存没有消费者，却随这一轮回复长度无界增长。
                        self._prior_text = (
                            self._prior_text + head
                        )[: self._PRIOR_TEXT_KEEP]
                        self._live_msg_id = None
                    last_sent_body = ""
                    # Tail must be sent — wake immediately on next loop.
                    self._dirty.set()
                    continue
            except Exception as e:
                # Don't kill the worker on transient TG/proxy errors; leave
                # last_sent_body untouched so we retry on next wake-up.
                print(f"[opencc-renderer] send error: {e}")

            if closed and not self._dirty.is_set():
                return

    def _upsert_live(self, text: str) -> None:
        if not text.strip():
            return
        if self._live_msg_id is None:
            resp = self.telegram_api("sendMessage", {
                "chat_id": self.chat_id,
                "text": text,
                "disable_notification": True,
            })
            if resp and resp.get("ok"):
                self._live_msg_id = resp["result"]["message_id"]
        else:
            self.telegram_api("editMessageText", {
                "chat_id": self.chat_id,
                "message_id": self._live_msg_id,
                "text": text,
            })


__all__ = [
    "OpenccSession",
    "OpenccSpawnError",
    "TelegramStreamRenderer",
    "DEFAULT_CLI_PATH",
    "CLI_CANDIDATES",
    "resolve_cli_path",
]
