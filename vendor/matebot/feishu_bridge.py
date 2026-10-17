#!/usr/bin/env python3
"""MateBot - Feishu Bot Bridge (Polling Mode)

Replaces the Telegram transport in bridge.py with Feishu.
Uses OpenCC spawn mode by default with tmux fallback.

Architecture:
- Spawn mode (default): persistent claude-js subprocess with stream-json I/O
- tmux mode (fallback): legacy tmux + transcript polling
- Feishu API via feishu_api.py (TokenManager, message polling, sending)
- FeishuStreamRenderer for live streaming edits (replaces TelegramStreamRenderer)
- Keeps existing subsystems: memory, attention_manager, failure_memory, kv_cache
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import threading
import time
from datetime import datetime, timedelta, time as dtime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
import queue

# ── Feishu API ────────────────────────────────────────────────────
from feishu_api import (
    TokenManager,
    discover_chat_id,
    poll_messages,
    parse_message_text,
    send_message,
    edit_message,
    reply_message,
    download_file,
    get_message_content,
    send_card_message,
    edit_card_message,
    build_streaming_card,
    upload_file,
    send_audio_message,
    send_file_message,
)

# ── Existing subsystems (unchanged) ───────────────────────────────
from memory import get_memory
from attention_manager import AttentionManager, StablePromptBuilder
from failure_memory import get_failure_memory
from opencc_backend import (
    OpenccSession,
    OpenccSpawnError,
    claude_config_dir,
    resolve_cli_path,
)
from session_store import SessionStore
from soul import Workspace, default_workspace_root

# 静态 ffmpeg（~/bin/ffmpeg，无需 sudo）——飞书语音是 opus、视频要抽帧，转 16k wav 全靠它
FFMPEG_BIN = os.path.expanduser("~/bin/ffmpeg")

# SenseVoice 转写（懒加载单例）：中文为主，比 Whisper 快且准（FunAudioLLM, iic/SenseVoiceSmall）
_SENSEVOICE = None  # (model, rich_transcription_postprocess)


def transcribe_audio(wav_path: str) -> str:
    """本地 SenseVoice 转写 16k mono wav → 去 tag 文本。失败返回空串。"""
    global _SENSEVOICE
    try:
        if _SENSEVOICE is None:
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess
            model = AutoModel(
                model="iic/SenseVoiceSmall",
                trust_remote_code=True,
                vad_model="fsmn-vad",
                vad_kwargs={"max_single_segment_time": 30000},
                device="cpu",
            )
            _SENSEVOICE = (model, rich_transcription_postprocess)
        model, postprocess = _SENSEVOICE
        res = model.generate(
            input=wav_path, cache={}, language="auto", use_itn=True,
            batch_size_s=60, merge_vad=True, merge_length_s=15,
        )
        if not res:
            return ""
        return postprocess(res[0]["text"])
    except Exception as e:
        print(f"[sensevoice] 转写失败: {e}")
        return ""


# CosyVoice TTS：独立 .cosyvoice venv（python 3.10，官方推荐），bridge 用 subprocess 调
_SCRIPT_DIR = Path(__file__).resolve().parent
COSYVOICE_PY = str(_SCRIPT_DIR / ".cosyvoice" / "bin" / "python")
COSYVOICE_SCRIPT = str(_SCRIPT_DIR / "scripts" / "cosyvoice_tts.py")
TTS_DAEMON_SCRIPT = str(_SCRIPT_DIR / "scripts" / "tts_daemon.py")
TTS_SOCK = "/tmp/matebot_tts.sock"

# 常驻 TTS 守护：模型只加载一次，之后合成秒回；懒启动 + 崩溃重拉
_TTS_DAEMON_PROC: Optional[subprocess.Popen] = None
_TTS_SCRIPT_MISSING_LOGGED = False


def _ensure_tts_daemon() -> bool:
    """保证 CosyVoice 守护活着。返回 socket 是否就绪。"""
    global _TTS_DAEMON_PROC, _TTS_SCRIPT_MISSING_LOGGED
    # TTS 当前停用：scripts/tts_daemon.py 只剩 .bak。脚本不在就直接返回，
    # 不再每次 spawn 一个注定退出的 python，也不打误导性的「守护进程提前退出」。
    if not os.path.exists(TTS_DAEMON_SCRIPT):
        if not _TTS_SCRIPT_MISSING_LOGGED:
            _TTS_SCRIPT_MISSING_LOGGED = True
            print(f"[tts] 已停用：缺少 {TTS_DAEMON_SCRIPT}")
        return False
    if _TTS_DAEMON_PROC is not None and _TTS_DAEMON_PROC.poll() is None:
        return os.path.exists(TTS_SOCK)
    if os.path.exists(TTS_SOCK):
        os.unlink(TTS_SOCK)
    try:
        _TTS_DAEMON_PROC = subprocess.Popen(
            [COSYVOICE_PY, TTS_DAEMON_SCRIPT],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"[tts] 守护启动失败: {e}")
        return False
    # 等模型加载完（最多 150s；首次要加载 2.7GB 模型）
    for _ in range(300):
        if os.path.exists(TTS_SOCK):
            return True
        if _TTS_DAEMON_PROC.poll() is not None:
            print("[tts] 守护进程提前退出")
            return False
        time.sleep(0.5)
    return False


def synthesize_voice(text: str) -> Optional[str]:
    """走常驻守护合成 text → wav 路径；失败返回 None。"""
    if not _ensure_tts_daemon():
        return None
    os.makedirs("/tmp/matebot_tts", exist_ok=True)
    out = f"/tmp/matebot_tts/{int(time.time())}_{os.getpid()}.wav"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(120)
            s.connect(TTS_SOCK)
            s.sendall(json.dumps({"text": text[:200], "out": out}).encode())
            data = s.recv(65536)
        resp = json.loads(data.decode())
        return out if resp.get("ok") and os.path.exists(out) else None
    except Exception as e:
        print(f"[tts] 守护请求失败: {e}")
        return None


def send_voice_reply(chat_id: str, text: str) -> bool:
    """把文本合成语音发给 chat（wav → opus → 上传 → 语音消息）。"""
    text = (text or "").strip()
    if not text:
        return False
    wav = synthesize_voice(text[:200])
    if not wav:
        return False
    opus = f"{wav}.opus"
    try:
        subprocess.run(
            [FFMPEG_BIN, "-y", "-i", wav, "-ar", "16000", "-ac", "1", "-c:a", "libopus", opus],
            check=True, capture_output=True, timeout=60,
        )
    except Exception as e:
        print(f"[tts] 转 opus 失败: {e}")
        return False
    file_key = upload_file(get_token_manager(), opus, file_type="opus")
    if not file_key:
        print("[tts] 音频上传失败")
        return False
    mid = send_audio_message(get_token_manager(), chat_id, file_key)
    return bool(mid)


def send_file(chat_id: str, path: str, file_type: str = "stream") -> bool:
    """把本地文件发给 chat（上传 → file 消息）。

    与 send_voice_reply 同构，仅走 msg_type=file。file_type 取合法枚举：
    stream（通用，推荐）/ pdf / doc / xls / ppt / opus / mp4。
    注意 "file" 是非法值，会报 234001 Invalid request param。
    """
    if not path:
        return False
    if not Path(path).is_file():
        print(f"[file] 文件不存在: {path}")
        return False
    file_key = upload_file(get_token_manager(), path, file_type=file_type)
    if not file_key:
        print("[file] 上传失败（file_type 非法会报 234001）")
        return False
    mid = send_file_message(get_token_manager(), chat_id, file_key)
    return bool(mid)


def ocr_image(path: str) -> str:
    """tesseract 提取图片文字（中英混合优先）。失败返回空串。

    视觉通道（模型直接读图）在当前流式会话里报 [Unsupported Image]，
    所以图片统一走 tesseract 兜底 OCR，把文字喂给模型。
    """
    try:
        out = subprocess.run(
            ["tesseract", path, "stdout", "-l", "chi_sim+eng"],
            check=False, capture_output=True, timeout=120,
        )
        text = out.stdout.decode("utf-8", errors="replace").strip()
        return re.sub(r"\n{3,}", "\n\n", text)[:1500]
    except Exception as e:
        print(f"[ocr] tesseract 失败 {path}: {e}")
        return ""

# ── feishu_config.yaml ────────────────────────────────────────────
# Optional: the bridge runs on env vars alone, but the YAML file is what the
# README documents, and its opencc_* keys used to be dead code that nothing
# read. Env still wins.
try:
    import feishu_config as _yaml_config

    _YAML: Dict[str, Any] = _yaml_config.load_config()
except Exception as _e:  # missing file, bad YAML, no pyyaml — all non-fatal
    print(f"[config] feishu_config.yaml not loaded ({_e}); using environment only")
    _YAML = {}


def _cfg(env_key: str, yaml_key: str, default: str = "") -> str:
    """Resolve a setting: environment > feishu_config.yaml > default."""
    value = os.environ.get(env_key)
    if value:
        return value
    value = _YAML.get(yaml_key)
    return str(value) if value not in (None, "") else default


def _cfg_bool(env_key: str, yaml_key: str, default: bool) -> bool:
    raw = os.environ.get(env_key)
    if raw is not None:
        return raw.strip().lower() in ("1", "true", "yes", "on")
    value = _YAML.get(yaml_key)
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip():
        return value.strip().lower() in ("1", "true", "yes", "on")
    return default

# ── Module-level token manager ────────────────────────────────────

_token_mgr: Optional[TokenManager] = None


def set_token_manager(tm: TokenManager) -> None:
    """Set the global token manager (called once at startup)."""
    global _token_mgr
    _token_mgr = tm


def get_token_manager() -> TokenManager:
    """Get the global token manager. Raises if not initialized."""
    if _token_mgr is None:
        raise RuntimeError("TokenManager not initialized — call set_token_manager() first")
    return _token_mgr


# ── FeishuStreamRenderer ──────────────────────────────────────────
# Try to import from feishu_renderer.py if it exists; otherwise use
# the inline definition below.

try:
    from feishu_renderer import FeishuStreamRenderer  # noqa: F811
except ImportError:

    class FeishuStreamRenderer:
        """Accumulates stream-json events into a per-turn Feishu message that is
        edit-updated in place.

        Concurrency model: stream-json events arrive on the OpenccSession stdout
        reader thread. Event handlers must NOT call Feishu API synchronously --
        network round-trips back-pressure claude-js stdout and stall generation.

        Design: a single per-renderer worker thread owns ALL Feishu I/O.
        Event handlers only mutate buffered state under a lock and set a
        ``_dirty`` event. The worker:
          - waits for ``_dirty`` (or a short timeout)
          - enforces a min interval between API round-trips (``EDIT_THROTTLE_S``)
          - snapshots the current body and edits / sends in place
          - coalesces: many appends + one network call
        """

        EDIT_THROTTLE_S = 1.5       # min seconds between editMessageText calls
        MAX_FEISHU_LEN = 30000      # Feishu message character limit
        # _prior_text 只留开头这么多字符就够（见 _render_worker 里的说明）。
        _PRIOR_TEXT_KEEP = 4096

        def __init__(self, chat_id: str, token_mgr: TokenManager):
            self.chat_id = chat_id
            self.token_mgr = token_mgr

            self._text = ""               # current live-chunk content
            self._prior_text = ""         # content already shipped in earlier chunks
            self._live_msg_id: Optional[str] = None
            self._tool_lines: List[str] = []
            self._closed = False
            self._lock = threading.Lock()

            # Worker thread that owns ALL network I/O.
            self._dirty = threading.Event()
            self._worker = threading.Thread(target=self._render_worker, daemon=True)
            self._worker.start()

        # ── event entry points ────────────────────────────────────

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
                        self._tool_lines.append(
                            f"🔧 {block.get('name', '?')}"
                        )
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
                if (
                    not (self._text.strip() or self._prior_text.strip())
                    and event.get("result")
                ):
                    self._text += str(event.get("result"))
                if is_error and event.get("result"):
                    self._text += f"\n\n⚠️ {str(event.get('result'))[:300]}"
                self._closed = True
            self._dirty.set()

        def final_text(self) -> str:
            """Turn 结束后的完整回复文本（不含工具前缀），供 TTS 用。"""
            with self._lock:
                text = (self._prior_text + self._text)
            # opencc 限流 fallback 时会输出内部占位符 "No response requested."
            # （语义是「不向用户显示错误、只记录进对话历史」），MateBot 自实现的
            # 流式渲染没有 opencc Ink UI 的过滤，会把它原样发到飞书——这里滤掉。
            return text.replace("No response requested.", "").strip()

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

        # ── worker loop ───────────────────────────────────────────

        def _render_worker(self) -> None:
            last_sent_ts = 0.0
            last_sent_text = ""
            last_sent_tool_count = 0
            while True:
                # Wake on new content or periodically (so close detection isn't
                # delayed if ``_closed`` is set while ``_dirty`` is already cleared).
                self._dirty.wait(timeout=1.0)
                self._dirty.clear()

                gap = time.time() - last_sent_ts
                if gap < self.EDIT_THROTTLE_S:
                    time.sleep(self.EDIT_THROTTLE_S - gap)

                with self._lock:
                    text_snapshot = self._text
                    tool_lines_snap_count = len(self._tool_lines)
                    closed = self._closed

                body = text_snapshot.rstrip().replace("No response requested.", "").strip()

                if not body and not self._tool_lines:
                    if closed:
                        return
                    continue

                try:
                    if len(body) <= self.MAX_FEISHU_LEN:
                        if body != last_sent_text or tool_lines_snap_count != last_sent_tool_count:
                            self._upsert_live(body)
                            last_sent_text = body
                            last_sent_tool_count = tool_lines_snap_count
                            last_sent_ts = time.time()
                    else:
                        # Chunk: ship the head, keep the tail for next loop.
                        head = body[: self.MAX_FEISHU_LEN]
                        self._upsert_live(head)
                        last_sent_ts = time.time()
                        with self._lock:
                            self._text = self._text[self.MAX_FEISHU_LEN:]
                            del self._tool_lines[:tool_lines_snap_count]
                            # _prior_text 的消费者只有两个：判断「前面是否已经发过
                            # 内容」（_handle_result），和 TTS（final_text →
                            # send_voice_reply 只取 text[:200]）。整段留存没有消费者，
                            # 却会随这一轮回复长度无界增长，所以只保留开头一段。
                            self._prior_text = (
                                self._prior_text + head
                            )[: self._PRIOR_TEXT_KEEP]
                            self._live_msg_id = None
                        last_sent_text = ""
                        last_sent_tool_count = 0
                        # Tail must be sent -- wake immediately on next loop.
                        self._dirty.set()
                        continue
                except Exception as e:
                    # Don't kill the worker on transient API errors; leave
                    # last_sent_text untouched so we retry on next wake-up.
                    print(f"[feishu-renderer] send error: {e}")

                if closed and not self._dirty.is_set():
                    return

        def _upsert_live(self, text: str) -> None:
            """Create or edit the live streaming card message."""
            if not text.strip() and not self._tool_lines:
                return
            template = "green" if self._closed else "blue"
            card = build_streaming_card(
                text=text, tool_lines=self._tool_lines, template=template
            )
            if self._live_msg_id is None:
                msg_id = send_card_message(self.token_mgr, self.chat_id, card)
                if msg_id:
                    self._live_msg_id = msg_id
            else:
                edit_card_message(self.token_mgr, self._live_msg_id, card)


# ── Config ────────────────────────────────────────────────────────


class Config:
    """Centralized configuration management."""

    # ── Feishu settings ───────────────────────────────────────────
    FEISHU_APP_ID = _cfg("FEISHU_APP_ID", "feishu_app_id")
    FEISHU_APP_SECRET = _cfg("FEISHU_APP_SECRET", "feishu_app_secret")
    FEISHU_CHAT_ID = _cfg("FEISHU_CHAT_ID", "chat_id")
    FEISHU_USER_OPEN_ID = _cfg("FEISHU_USER_OPEN_ID", "user_open_id")
    POLL_INTERVAL = int(_cfg("POLL_INTERVAL", "poll_interval_sec", "5"))

    # ── tmux settings (fallback mode) ─────────────────────────────
    TMUX_SESSION = os.environ.get("TMUX_SESSION", "claude")

    # ── File paths ────────────────────────────────────────────────
    MATE_DIR = Path.home() / ".matecode"
    CHAT_ID_FILE = MATE_DIR / "feishu_chat_id"
    PENDING_FILE = MATE_DIR / "feishu_pending"
    HISTORY_FILE = MATE_DIR / "history.jsonl"
    LAST_MSG_ID_FILE = MATE_DIR / "feishu_last_msg_id"
    SENT_OFFSET_FILE = MATE_DIR / "feishu_sent_offset"

    # ── Memory settings ───────────────────────────────────────────
    MEMORY_ENABLED = os.environ.get("MEMORY_ENABLED", "true").lower() == "true"
    MEMORY_MAX_RESULTS = int(os.environ.get("MEMORY_MAX_RESULTS", "5"))
    MEMORY_MAX_CONTEXT = int(os.environ.get("MEMORY_MAX_CONTEXT", "2000"))

    # ── KV-Cache settings ─────────────────────────────────────────
    # Caches only the static prompt prefix. It used to cache the whole prompt
    # keyed on (prefix, chat_id), which silently replayed the previous turn's
    # user input — see attention_manager.build_optimized_prompt_with_cache.
    KV_CACHE_ENABLED = os.environ.get("KV_CACHE_ENABLED", "true").lower() == "true"
    KV_CACHE_TTL = int(os.environ.get("KV_CACHE_TTL", "3600"))  # 1 hour default

    # ── Raw message mode ──────────────────────────────────────────
    RAW_MESSAGES = os.environ.get("RAW_MESSAGES", "true").lower() == "true"

    # ── OpenCC spawn mode ─────────────────────────────────────────
    # When enabled, bypasses tmux entirely and spawns the claude-js CLI with
    # stream-json I/O. ONE long-lived subprocess per chat_id, resumed via
    # --resume across bridge restarts.
    #
    # OPENCC_CLI_PATH stays empty by default so opencc_backend.resolve_cli_path
    # can search real install locations. Hardcoding a default here is what made
    # every spawn die instantly (vendor/opencc/dist/cli.js does not exist in a
    # plain checkout) and every message start a doomed new process.
    OPENCC_SPAWN_MODE = _cfg_bool("OPENCC_SPAWN_MODE", "opencc_spawn_mode", True)
    OPENCC_CLI_PATH = _cfg("OPENCC_CLI_PATH", "opencc_cli_path")
    OPENCC_BUN_PATH = _cfg("OPENCC_BUN_PATH", "opencc_bun_path", "bun")
    OPENCC_MODEL = _cfg("OPENCC_MODEL", "opencc_model")  # "" = CLI default
    OPENCC_CWD = _cfg("OPENCC_CWD", "opencc_cwd", os.getcwd())
    # Warm the process at startup so the first message doesn't pay cold start.
    OPENCC_PREWARM = _cfg_bool("OPENCC_PREWARM", "opencc_prewarm", True)

    # ── 会话内存看门狗（防 V8 堆无界增长）────────────────────────
    # 一天的对话上下文会堆到 8G+ RSS，V8 不把空闲页还给 OS。到点（用户休息时间）
    # 或超阈值就 close+prewarm LLM 会话（--resume 自动压缩上下文），RSS 掉回 1-2G。
    SESSION_MAX_RSS_MB = int(os.environ.get("SESSION_MAX_RSS_MB", "4000"))
    # 整个 unit cgroup 的匿名内存上限（MB）。超了就让 bridge 退出、交给 systemd
    # 重启，而不是等 MemoryMax=24G 触发 OOM。看的是 anon 不是 MemoryCurrent：
    # MemoryCurrent 把 page cache 也算进来（实测 16.6G 里 15.3G 是文件页、anon
    # 只有 0.5G），照那个数重启就是重启风暴。
    BRIDGE_MAX_ANON_MB = int(os.environ.get("BRIDGE_MAX_ANON_MB", "8192"))
    # 每天到点自动重启，逗号分隔 HH:MM（用户休息时间，避开关话中）。
    # 首个时刻 08:30 刻意排在 crontab 的 `0 9 * * * tech_daily_run.sh` 之前：科技
    # 日报是每天最重的一次生成，让它跑在刚轮转出来的新会话上（空 context、低 RSS），
    # 而不是跑在一个即将被丢掉的 24 小时旧会话上。
    SESSION_RESTART_TIMES = [
        t.strip()
        for t in os.environ.get("SESSION_RESTART_TIMES", "08:30,12:50,18:30").split(",")
        if t.strip()
    ]
    # 在这些到点时刻「轮转 session」：开新会话（forget 旧 session id），而非 --resume。
    # 否则 session jsonl 只追加不轮转，数周后涨到百 MB，opencc 处理时 bun GC 风暴卡死。
    # 默认取 SESSION_RESTART_TIMES 首个（每天 09:00 起新会话），其余时刻仍 resume 只压内存。
    SESSION_ROTATE_TIMES = {
        t.strip()
        for t in os.environ.get(
            "SESSION_ROTATE_TIMES",
            (SESSION_RESTART_TIMES[:1] or ["09:00"])[0],
        ).split(",")
        if t.strip()
    }

    # ── Agent workspace (SOUL.md et al.) ──────────────────────────
    SOUL_ENABLED = _cfg_bool("SOUL_ENABLED", "soul_enabled", True)
    SOUL_WORKSPACE = _cfg("MATEBOT_WORKSPACE", "workspace_dir", str(default_workspace_root()))
    SOUL_MAX_CHARS = int(_cfg("MATEBOT_SOUL_MAX_CHARS", "soul_max_chars", "20000"))
    # Append a one-line summary of each turn to memory/YYYY-MM-DD.md.
    SOUL_DAILY_NOTES = _cfg_bool("SOUL_DAILY_NOTES", "soul_daily_notes", True)

    # ── Bot commands ──────────────────────────────────────────────
    BOT_COMMANDS = [
        {"command": "clear", "description": "Clear conversation"},
        {"command": "resume", "description": "Resume session (shows picker)"},
        {"command": "continue_", "description": "Continue most recent session"},
        {"command": "stop", "description": "Interrupt Claude (Escape)"},
        {"command": "status", "description": "Check bot status"},
        {"command": "remember", "description": "Save to memory: /remember <text>"},
        {"command": "recall", "description": "Search memories: /recall <query>"},
        {"command": "forget", "description": "Delete memory: /forget <query>"},
        {"command": "task", "description": "Manage tasks: /task [goal]"},
        {"command": "todo", "description": "View/update todo: /todo [update]"},
        {
            "command": "failures",
            "description": "View failure lessons: /failures [stats|resolve ID]",
        },
        {"command": "lessons", "description": "View learned lessons: /lessons [query]"},
        {"command": "kvcache", "description": "KV-Cache statistics: /kvcache [clear]"},
        {"command": "soul", "description": "Show agent workspace files"},
        {"command": "reload_soul", "description": "Reload SOUL.md et al. (keeps session)"},
    ]

    BLOCKED_COMMANDS = {
        "/mcp",
        "/help",
        "/settings",
        "/config",
        "/model",
        "/compact",
        "/cost",
        "/doctor",
        "/init",
        "/login",
        "/logout",
        "/memory",
        "/permissions",
        "/pr",
        "/review",
        "/terminal",
        "/vim",
        "/approved-tools",
        "/listen",
    }

    # ── Auto-memory instruction ───────────────────────────────────
    DEFAULT_AUTO_MEMORY_INSTRUCTION = """【记忆模式 - 系统编程优化版】

仅在以下场景触发记忆（避免无意义内容）：
- 架构决策、API设计、性能优化
- Bug发现及修复方案
- 引入新依赖/工具/技术栈
- 安全/并发/内存管理相关

格式 (-- memory 块会自动过滤，用户不可见)：
-- memory
ctx  = 项目上下文或文件路径
type = decision|bug|perf|security|api|tool|refactor
key  = 关键信息（一句话摘要）
--

多行值缩进示例：
-- memory
ctx  = src/memory.py
type = bugfix
key  = FTS5删除顺序错误，需先删索引再删主表
     = 原因是 content_rowid=rowid 的外键约束
--

无记忆内容时输出空标记：
-- memory
--"""


# ── Global state ──────────────────────────────────────────────────

recent_messages: Dict[str, str] = {}
recent_full_prompts: Dict[str, str] = {}


# ── Helper functions ──────────────────────────────────────────────


def tmux_exists() -> bool:
    """Check if tmux session exists."""
    return TmuxManager.exists()


def reply(chat_id: str, text: str) -> bool:
    """Send a text message to a Feishu chat. Returns True on success.

    Handles long messages by splitting into chunks at Feishu's
    character limit (30000 chars).
    """
    MAX_LENGTH = 30000  # Leave some margin

    if len(text) <= MAX_LENGTH:
        msg_id = send_message(get_token_manager(), chat_id, text)
        return msg_id is not None

    # Split long messages into chunks
    chunks: List[str] = []
    current_chunk = ""

    for line in text.split("\n"):
        if len(current_chunk) + len(line) + 1 > MAX_LENGTH:
            if current_chunk:
                chunks.append(current_chunk)
            current_chunk = line
        else:
            current_chunk += "\n" + line if current_chunk else line

    if current_chunk:
        chunks.append(current_chunk)

    # Send chunks
    all_success = True
    for i, chunk in enumerate(chunks):
        prefix = f"[{i + 1}/{len(chunks)}] " if len(chunks) > 1 else ""
        msg_id = send_message(get_token_manager(), chat_id, prefix + chunk)
        if msg_id is None:
            all_success = False

    return all_success


def send_typing_loop(chat_id: str) -> None:
    """Minimal presence loop for tmux mode.

    Feishu does not have a typing indicator API, so this just serves
    as a lightweight heartbeat while a pending request is active.
    """
    while os.path.exists(Config.PENDING_FILE):
        time.sleep(5)


def send_typing_loop_until(chat_id: str, done_predicate: Callable[[], bool]) -> None:
    """Like send_typing_loop, but stops when done_predicate() returns truthy.

    Used in OPENCC_SPAWN_MODE where there is no pending file -- the renderer's
    ``_closed`` flag is the natural completion signal.
    """
    # Hard cap so a stuck process can't keep the thread alive forever.
    deadline = time.time() + 600
    while time.time() < deadline:
        try:
            if done_predicate():
                return
        except Exception:
            return
        time.sleep(5)


def load_claude_md() -> str:
    """Load .CLAUDE.md from project or home directory."""
    paths = [Path(".CLAUDE.md"), claude_config_dir() / ".CLAUDE.md"]
    for path in paths:
        if path.exists():
            try:
                return path.read_text(encoding="utf-8")
            except Exception as e:
                print(f"Error reading {path}: {e}")
    return ""


def _note_daily(text: str) -> None:
    """Append a line to today's workspace note, if the workspace is enabled."""
    ws = opencc_registry.workspace if Config.SOUL_ENABLED else None
    if ws is not None:
        ws.append_daily(text)


def extract_meta_prompt(claude_md_content: str) -> str:
    """Extract the meta-prompt section from .CLAUDE.md content."""
    if not claude_md_content:
        return ""

    lines = claude_md_content.split("\n")
    in_initial_prompt = False
    prompt_lines: List[str] = []

    for line in lines:
        if line.strip() == "## 初始提示词":
            in_initial_prompt = True
            continue
        if in_initial_prompt:
            if line.startswith("## "):
                break
            prompt_lines.append(line)

    return "\n".join(prompt_lines).strip()


def extract_memory_update(response: str) -> tuple:
    """Extract memory update from Claude's response using CCL-style format.

    Returns (cleaned_response, memory_content).
    """
    # First, extract -- memory blocks
    memory_pattern = r"--\s*memory\s*\n(.*?)\n--"
    memory_match = re.search(memory_pattern, response, re.DOTALL)

    memory_content = ""
    cleaned_response = response

    if memory_match:
        memory_content = memory_match.group(1).strip()
        cleaned_response = re.sub(
            memory_pattern + r"\s*", "", response, flags=re.DOTALL
        ).strip()

    # Extract and remove XML observation blocks (claude-mem output)
    xml_pattern = r"<(observation|memory|fact|narrative|concept)\b.*?>.*?</\1>"
    xml_matches = list(re.finditer(xml_pattern, cleaned_response, re.DOTALL))

    if xml_matches:
        xml_contents = []
        for match in xml_matches:
            xml_contents.append(match.group(0).strip())

        cleaned_response = re.sub(
            xml_pattern, "", cleaned_response, flags=re.DOTALL
        ).strip()

        if xml_contents:
            xml_text = "\n\n".join(xml_contents)
            if memory_content:
                memory_content = f"{memory_content}\n\n{xml_text}"
            else:
                memory_content = xml_text

    # Clean up excessive blank lines (3 or more newlines -> 2 newlines)
    if cleaned_response:
        cleaned_response = re.sub(r"\n{3,}", "\n\n", cleaned_response)

    return cleaned_response, memory_content


def get_recent_sessions(limit: int = 5) -> List[dict]:
    """Get list of recent Claude sessions from history file."""
    if not os.path.exists(Config.HISTORY_FILE):
        return []

    sessions: List[dict] = []
    try:
        with open(Config.HISTORY_FILE) as f:
            for line in f:
                try:
                    sessions.append(json.loads(line.strip()))
                except json.JSONDecodeError:
                    continue
    except Exception:
        return []

    sessions.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
    return sessions[:limit]


def get_session_id(project_path: str) -> Optional[str]:
    """Get session ID from project path."""
    encoded = project_path.replace("/", "-").lstrip("-")
    for prefix in [f"-{encoded}", encoded]:
        project_dir = claude_config_dir() / "projects" / prefix
        if project_dir.exists():
            jsonls = list(project_dir.glob("*.jsonl"))
            if jsonls:
                return max(jsonls, key=lambda p: p.stat().st_mtime).stem
    return None


def find_latest_transcript() -> Optional[Path]:
    """Find the most recent Claude transcript file."""
    search_paths = [
        claude_config_dir() / "transcripts",
        claude_config_dir() / "projects",
    ]

    all_transcripts: List[Path] = []

    for path in search_paths:
        if not path.exists():
            continue
        if path.name == "projects":
            for project_dir in path.iterdir():
                if project_dir.is_dir():
                    all_transcripts.extend(project_dir.glob("*.jsonl"))
        else:
            all_transcripts.extend(path.glob("*.jsonl"))

    return max(all_transcripts, key=lambda p: p.stat().st_mtime) if all_transcripts else None


def _iter_lines_with_pos(path: Path):
    """逐行产出 (行首字符偏移, 行文本)；文件在迭代期间保持打开。

    替代 readlines()：下面的 extract_assistant_responses 是文件监视器在每次
    transcript 写入后调用的，而 transcript 整天追加。readlines() 每次都把整份
    文件物化成一张行表（数万条 str）再丢掉，持续制造分配 churn；逐行读任何时刻
    只保留一行。偏移口径与 readlines() 版本一致（累加每行字符数）。
    """
    pos = 0
    with open(path, "r") as fh:
        for line in fh:
            yield pos, line
            pos += len(line)


def extract_assistant_responses(
    transcript_path: Path,
    last_response_pos: int = 0,
    seen_message_ids: Optional[set] = None,
) -> tuple:
    """Extract assistant responses from transcript starting from a position.

    Uses incremental reading -- only processes new lines since last_position.
    Tracks seen line positions to avoid duplicates.
    """
    if not transcript_path or not transcript_path.exists():
        return "", 0, seen_message_ids or set()

    if seen_message_ids is None:
        seen_message_ids = set()

    responses: List[str] = []
    current_pos = 0
    found_new_content = False

    try:
        for line_start_pos, line in _iter_lines_with_pos(transcript_path):
            current_pos = line_start_pos + len(line)

            # Skip lines we've already processed
            if line_start_pos < last_response_pos:
                continue

            # Also skip if we've seen this exact line position before
            line_pos_key = f"{transcript_path}:{line_start_pos}"
            if line_pos_key in seen_message_ids:
                continue

            try:
                entry = json.loads(line.strip())
                if entry.get("type") == "assistant":
                    message = entry.get("message", {})
                    text_content: List[str] = []

                    content_blocks = message.get("content", [])
                    if not isinstance(content_blocks, list):
                        content_blocks = []

                    for block in content_blocks:
                        if not isinstance(block, dict):
                            continue

                        block_type = block.get("type")

                        if block_type == "text":
                            text = block.get("text", "").strip()
                            if not text:
                                continue
                            # Skip pure XML blocks
                            if (
                                text.startswith("<")
                                and text.endswith(">")
                                and "/" in text[1:]
                            ):
                                continue
                            if text.startswith("```xml") or text.startswith("```\n<"):
                                continue
                            text_content.append(text)

                        elif block_type == "thinking":
                            continue

                        elif block_type == "tool_use":
                            tool_name = block.get("name", "unknown_tool")
                            tool_input = block.get("input", {})
                            tool_id = block.get("id", "")
                            try:
                                input_str = json.dumps(
                                    tool_input, indent=2, ensure_ascii=False
                                )
                            except Exception:
                                input_str = str(tool_input)
                            tool_text = (
                                f"🔧 Tool Use: `{tool_name}` (ID: `{tool_id}`)\n\n"
                                f"```json\n{input_str}\n```"
                            )
                            text_content.append(tool_text)

                        elif block_type == "tool_result":
                            tool_content = block.get("content", "")
                            tool_use_id = block.get("tool_use_id", "")
                            is_error = block.get("is_error", False)

                            if isinstance(tool_content, list):
                                content_parts = []
                                for item in tool_content:
                                    if isinstance(item, dict):
                                        if item.get("type") == "text":
                                            content_parts.append(item.get("text", ""))
                                        else:
                                            content_parts.append(str(item))
                                    else:
                                        content_parts.append(str(item))
                                tool_content_str = "\n".join(content_parts)
                            elif isinstance(tool_content, str):
                                tool_content_str = tool_content
                            else:
                                tool_content_str = str(tool_content)

                            if len(tool_content_str) > 3000:
                                tool_content_str = (
                                    tool_content_str[:3000] + "\n\n... (truncated)"
                                )

                            error_prefix = "❌ " if is_error else ""
                            tool_text = (
                                f"{error_prefix}📤 Tool Result (ID: `{tool_use_id}`):\n\n"
                                f"```\n{tool_content_str}\n```"
                            )
                            text_content.append(tool_text)

                        elif block_type == "artifact":
                            artifact_id = block.get("id", "")
                            artifact_type = block.get("artifact_type", "")
                            artifact_title = block.get("title", "")
                            artifact_content = block.get("content", "")

                            language_hint = ""
                            if artifact_type == "application/vnd.chat.code":
                                if artifact_title.endswith(".py"):
                                    language_hint = "python"
                                elif artifact_title.endswith((".js", ".ts")):
                                    language_hint = "javascript"
                                elif artifact_title.endswith(".html"):
                                    language_hint = "html"
                                elif artifact_title.endswith(".css"):
                                    language_hint = "css"
                                elif artifact_title.endswith(".json"):
                                    language_hint = "json"
                                elif artifact_title.endswith(".sh"):
                                    language_hint = "bash"
                                elif artifact_title.endswith((".yml", ".yaml")):
                                    language_hint = "yaml"
                            elif artifact_type == "text/markdown":
                                language_hint = "markdown"
                            elif artifact_type == "text/html":
                                language_hint = "html"
                            elif artifact_type == "image/svg+xml":
                                language_hint = "svg"

                            artifact_text = (
                                f"📄 Artifact: {artifact_title}\n"
                                f"Type: `{artifact_type}` | ID: `{artifact_id}`\n\n"
                                f"```{language_hint}\n{artifact_content}\n```"
                            )
                            text_content.append(artifact_text)

                    # Mark this line as processed
                    seen_message_ids.add(line_pos_key)

                    if text_content:
                        full_text = "\n".join(text_content)
                        responses.append(full_text)
                        found_new_content = True

            except (json.JSONDecodeError, KeyError):
                continue

    except Exception as e:
        print(f"Error reading transcript: {e}")
        return "", last_response_pos, seen_message_ids

    if not found_new_content:
        return "", last_response_pos, seen_message_ids

    return "\n\n".join(responses).strip(), current_pos, seen_message_ids


# ── TmuxManager ───────────────────────────────────────────────────


class TmuxManager:
    """Tmux session management (unchanged from bridge.py)."""

    @staticmethod
    def exists() -> bool:
        """Check if tmux session exists."""
        return (
            subprocess.run(
                ["tmux", "has-session", "-t", Config.TMUX_SESSION],
                capture_output=True,
            ).returncode
            == 0
        )

    @staticmethod
    def send(text: str, literal: bool = True) -> None:
        """Send text to tmux session."""
        cmd = ["tmux", "send-keys", "-t", Config.TMUX_SESSION]
        if literal:
            cmd.append("-l")
        cmd.append(text)
        subprocess.run(cmd)

    @staticmethod
    def send_enter() -> None:
        """Send Enter key to tmux."""
        subprocess.run(
            ["tmux", "send-keys", "-t", Config.TMUX_SESSION, "Enter"]
        )

    @staticmethod
    def send_escape() -> None:
        """Send Escape key to tmux."""
        subprocess.run(
            ["tmux", "send-keys", "-t", Config.TMUX_SESSION, "Escape"]
        )


# ── Function aliases for backward compatibility ───────────────────


def tmux_send(text: str, literal: bool = True) -> None:
    """Send text to tmux session."""
    TmuxManager.send(text, literal)


def tmux_send_enter() -> None:
    """Send Enter key to tmux."""
    TmuxManager.send_enter()


def tmux_send_escape() -> None:
    """Send Escape key to tmux."""
    TmuxManager.send_escape()


# ── ResponseMonitor ───────────────────────────────────────────────


class ResponseMonitor:
    """Monitor Claude responses (via transcript polling) and send them to Feishu.

    Used in tmux fallback mode. In spawn mode, responses are streamed directly
    by the FeishuStreamRenderer.
    """

    def __init__(self, check_interval: float = 0.1):
        self.check_interval = check_interval
        self.monitor_thread: Optional[threading.Thread] = None
        self.running = False
        self.last_transcript_path: Optional[str] = None
        self.last_position = 0
        self.response_queue: queue.Queue = queue.Queue()
        self._checking = False
        self._seen_message_ids: set = set()
        self._file_states: Dict[str, dict] = {}
        self._cumulative_sent: Dict[str, int] = {}

    def start(self) -> None:
        """Start the response monitor with file watching."""
        if self.running:
            return
        self.running = True

        # Start file watcher for immediate response detection
        self._start_file_watcher()

        # Also start the polling thread as backup
        self.monitor_thread = threading.Thread(
            target=self._monitor_loop, daemon=True
        )
        self.monitor_thread.start()
        print("Response monitor started with file watching")

    def _start_file_watcher(self) -> None:
        """Start watching for transcript file updates using polling."""

        def file_watcher() -> None:
            last_transcript_mtime = 0.0
            pending_existed = False
            while self.running:
                try:
                    # Check if pending file exists (indicates active request)
                    if os.path.exists(Config.PENDING_FILE):
                        transcript_path = find_latest_transcript()
                        if transcript_path and transcript_path.exists():
                            mtime = transcript_path.stat().st_mtime
                            if mtime > last_transcript_mtime or not pending_existed:
                                self._immediate_response_check()
                                last_transcript_mtime = mtime
                        pending_existed = True
                    else:
                        pending_existed = False
                        last_transcript_mtime = 0.0

                    time.sleep(0.05)  # 50ms polling interval
                except Exception as e:
                    print(f"[DEBUG] File watcher error: {e}")
                    time.sleep(0.1)

        watcher_thread = threading.Thread(target=file_watcher, daemon=True)
        watcher_thread.start()

    def _immediate_response_check(self) -> None:
        """Immediate response check when pending file is detected."""
        try:
            time.sleep(0.05)
            self._check_for_responses()
        except Exception as e:
            print(f"[DEBUG] Immediate response check error: {e}")

    def _monitor_loop(self) -> None:
        """Main monitoring loop."""
        while self.running:
            try:
                self._check_for_responses()
            except Exception as e:
                print(f"Response monitor error: {e}")
            time.sleep(self.check_interval)

    def _check_for_responses(self) -> None:
        """Check for new assistant responses and send to Feishu."""
        pending_exists = os.path.exists(Config.PENDING_FILE)

        if not pending_exists:
            transcript_path = find_latest_transcript()
            if transcript_path and self.last_transcript_path == str(transcript_path):
                responses, new_position, self._seen_message_ids = (
                    extract_assistant_responses(
                        Path(transcript_path),
                        self.last_position,
                        self._seen_message_ids,
                    )
                )
                if responses:
                    self._process_responses(
                        str(transcript_path), responses, new_position
                    )
                    return
            self.last_transcript_path = None
            self.last_position = 0
            self._seen_message_ids.clear()
            return

        if hasattr(self, "_checking") and self._checking:
            return

        self._checking = True

        try:
            transcript_path = find_latest_transcript()
            if not transcript_path:
                return

            tp_str = str(transcript_path)
            if self.last_transcript_path != tp_str:
                if self.last_transcript_path:
                    self._file_states[self.last_transcript_path] = {
                        "position": self.last_position,
                        "seen_ids": self._seen_message_ids.copy(),
                    }
                self.last_transcript_path = tp_str
                if tp_str in self._file_states:
                    saved_state = self._file_states[tp_str]
                    self.last_position = saved_state["position"]
                    self._seen_message_ids = saved_state["seen_ids"].copy()
                else:
                    self.last_position = 0
                    self._seen_message_ids.clear()

            responses, new_position, self._seen_message_ids = (
                extract_assistant_responses(
                    transcript_path, self.last_position, self._seen_message_ids
                )
            )

            self.last_position = new_position
            if self.last_transcript_path:
                self._file_states[self.last_transcript_path] = {
                    "position": self.last_position,
                    "seen_ids": self._seen_message_ids.copy(),
                }

            if not responses:
                return

            self._process_responses(tp_str, responses, new_position)

        except Exception as e:
            print(f"Error sending response: {e}")
            import traceback

            traceback.print_exc()
            # Remove pending file after 10min timeout to avoid infinite loop
            pending_time = 0.0
            if os.path.exists(Config.PENDING_FILE):
                try:
                    with open(Config.PENDING_FILE) as f:
                        pending_time = float(f.read().strip())
                except (ValueError, OSError):
                    pass
                if time.time() - pending_time > 600:
                    os.remove(Config.PENDING_FILE)
        finally:
            self._checking = False

    def stop(self) -> None:
        """Stop the response monitor."""
        self.running = False
        if self.monitor_thread:
            self.monitor_thread.join(timeout=1)
        print("Response monitor stopped")

    def _process_responses(
        self, transcript_path: str, responses: str, new_position: int
    ) -> None:
        """Process and send responses to Feishu."""
        if not os.path.exists(Config.CHAT_ID_FILE):
            return

        with open(Config.CHAT_ID_FILE) as f:
            chat_id = f.read().strip()

        cleaned_responses, memory_update = extract_memory_update(responses)

        # Skip empty responses
        if not cleaned_responses or not cleaned_responses.strip():
            if os.path.exists(Config.PENDING_FILE):
                os.remove(Config.PENDING_FILE)
            return

        # Save to memory
        self._save_to_memory(chat_id, cleaned_responses, memory_update)

        # Send to Feishu
        result = reply(chat_id, cleaned_responses)
        if result is not False:
            if os.path.exists(Config.PENDING_FILE):
                os.remove(Config.PENDING_FILE)
        else:
            print(f"[DEBUG] Failed to send response, keeping pending file for retry")

    def _save_to_memory(
        self, chat_id: str, cleaned_responses: str, memory_update: str
    ) -> None:
        """Save conversation to memory."""
        if not Config.MEMORY_ENABLED:
            return

        try:
            memory = get_memory()

            if chat_id in recent_messages:
                user_msg = recent_messages[chat_id]
                memory.add(
                    chat_id,
                    f"Q: {user_msg}\nA: {cleaned_responses[:2000]}",
                    metadata={"type": "conversation"},
                )
                recent_messages.pop(chat_id, None)
                recent_full_prompts.pop(chat_id, None)

            if memory_update:
                memory.add(
                    chat_id,
                    memory_update[:5000],
                    metadata={"type": "meta_update", "auto": True},
                    message_type="meta_update",
                )

            self._record_failures_if_any(chat_id, cleaned_responses)

        except Exception as e:
            print(f"Error saving to memory: {e}")

    def _record_failures_if_any(self, chat_id: str, response: str) -> None:
        """Record failure lessons if error patterns detected."""
        try:
            failure_memory = get_failure_memory()
            user_msg = recent_messages.get(chat_id)
            if not user_msg:
                return

            lesson = failure_memory.extract_lesson_from_response(response)
            if lesson:
                failure_memory.record_failure(
                    user_id=chat_id,
                    action=user_msg[:100],
                    error_message=response[:500],
                    context=f"用户输入: {user_msg[:200]}",
                    lesson=lesson,
                )
                return

            error_keywords = [
                "错误", "失败", "bug", "error", "exception",
                "failed", "invalid", "cannot", "unable",
            ]
            if any(keyword in response.lower() for keyword in error_keywords):
                failure_memory.record_failure(
                    user_id=chat_id,
                    action=user_msg[:100],
                    error_message=response[:500],
                    context=f"用户输入: {user_msg[:200]}",
                    lesson="检测到错误关键词，建议手动总结教训",
                )

        except Exception as e:
            print(f"Error recording failure: {e}")


response_monitor = ResponseMonitor(check_interval=0.1)


# ── OpenccSessionRegistry ─────────────────────────────────────────


class OpenccSessionRegistry:
    """One long-lived claude-js (OpenCC) process per chat, with Feishu streaming.

    The contract this class exists to enforce: **a chat has one process, and it
    outlives individual turns.** A new turn swaps the renderer (so each reply
    gets its own Feishu card) but reuses the process, so the model keeps the
    whole conversation in context instead of re-reading a transcript.

    The previous version looked like it did this, but only ever checked
    `sess.is_running` — and since the configured CLI path did not exist, every
    spawn died instantly and every message quietly built a brand new session.
    Three things stop that from recurring:

    1. `OpenccSession` resolves and validates the CLI path up front, raising
       instead of spawning something that cannot run.
    2. A dead process is *revived in place* (`_ensure_spawned`) with its
       persisted `session_id`, rather than replaced by a blank object.
    3. Repeated deaths are counted and reported to the user with the real
       stderr, instead of failing silently forever.
    """

    def __init__(self):
        self._sessions: Dict[str, OpenccSession] = {}
        self._renderers: Dict[str, FeishuStreamRenderer] = {}
        self._failures: Dict[str, int] = {}
        self._lock = threading.RLock()
        self._store = SessionStore()
        self._workspace = (
            Workspace(Path(Config.SOUL_WORKSPACE), max_chars=Config.SOUL_MAX_CHARS)
            if Config.SOUL_ENABLED
            else None
        )
        self._soul_fingerprint: Optional[str] = None

    # ── workspace / soul ──────────────────────────────────────────

    @property
    def workspace(self) -> Optional[Workspace]:
        return self._workspace

    def _system_prompt(self) -> Optional[str]:
        if not self._workspace:
            return None
        try:
            prompt = self._workspace.system_prompt()
            self._soul_fingerprint = self._workspace.fingerprint()
            return prompt
        except Exception as e:
            print(f"[soul] could not assemble workspace prompt: {e}")
            return None

    def soul_changed(self) -> bool:
        """True when the identity files changed since the live processes spawned.

        The system prompt is baked in at spawn time, so editing SOUL.md only
        takes effect on the next process. Callers use this to say so.
        """
        if not self._workspace or self._soul_fingerprint is None:
            return False
        try:
            return self._workspace.fingerprint() != self._soul_fingerprint
        except Exception:
            return False

    # ── session lifecycle ─────────────────────────────────────────

    def _build_session(self, chat_id: str) -> OpenccSession:
        """Construct a session bound to this chat's persisted conversation."""
        key = chat_id
        resumed = self._store.get_session_id(key)

        def _on_session_id(sid: str) -> None:
            self._store.set_session_id(
                key, sid, cwd=Config.OPENCC_CWD, model=Config.OPENCC_MODEL or ""
            )

        def _on_stderr(line: str) -> None:
            print(f"[opencc:{key}] {line}")

        def _on_close(code: Optional[int]) -> None:
            print(f"[opencc:{key}] process exited code={code}")

        sess = OpenccSession(
            on_event=lambda ev: self._dispatch(key, ev),
            on_stderr=_on_stderr,
            on_close=_on_close,
            on_session_id=_on_session_id,
            cli_path=(Config.OPENCC_CLI_PATH or None),
            bun_path=Config.OPENCC_BUN_PATH,
            cwd=Config.OPENCC_CWD,
            model=(Config.OPENCC_MODEL or None),
            session_id=resumed,
            append_system_prompt=self._system_prompt(),
        )
        if resumed:
            print(f"[opencc:{key}] resuming session {resumed}")
        return sess

    def _dispatch(self, chat_id: str, event: dict) -> None:
        """Route a stream event to whichever renderer owns the current turn.

        Indirecting through the registry (rather than binding `rend.on_event`
        into the session) means a renderer swap mid-flight can never leave the
        reader thread writing into a closed renderer.
        """
        if (
            Config.SOUL_DAILY_NOTES
            and self._workspace is not None
            and event.get("type") == "result"
            and not event.get("is_error")
        ):
            summary = str(event.get("result") or "").strip()
            if summary:
                self._workspace.append_daily(f"MateBot: {summary[:300]}")

        with self._lock:
            rend = self._renderers.get(chat_id)
        if rend is None:
            return
        rend.on_event(event)

    def ensure_session(self, chat_id: str) -> OpenccSession:
        """Return this chat's live process, spawning or reviving as needed."""
        with self._lock:
            sess = self._sessions.get(chat_id)
            if sess is None:
                sess = self._build_session(chat_id)
                self._sessions[chat_id] = sess
            return sess

    def prewarm(self, chat_id: str) -> Optional[str]:
        """Start the process before the first message arrives.

        Returns an error string if the backend cannot start at all, so startup
        can surface a real reason instead of failing on the first user message.
        """
        try:
            sess = self.ensure_session(chat_id)
            sess.start()
            return None
        except OpenccSpawnError as e:
            return str(e)
        except Exception as e:
            return f"{type(e).__name__}: {e}"

    def new_turn(self, chat_id: str) -> tuple:
        """Start a fresh reply card, keeping the conversation process alive."""
        key = chat_id
        with self._lock:
            prev = self._renderers.get(key)
            if prev is not None:
                try:
                    prev.close()
                except Exception:
                    pass
            rend = FeishuStreamRenderer(chat_id, get_token_manager())
            self._renderers[key] = rend

            sess = self._sessions.get(key)
            if sess is None:
                sess = self._build_session(key)
                self._sessions[key] = sess
            elif not sess.is_running and sess.spawn_count:
                # Died between turns. Revive in place so --resume carries the
                # conversation over instead of starting from nothing.
                print(
                    f"[opencc:{key}] process not running "
                    f"(exit={sess.last_exit_code}); reviving with resume"
                )
            return sess, rend

    def note_turn_started(self, chat_id: str) -> None:
        with self._lock:
            self._failures[chat_id] = 0

    def note_spawn_failure(self, chat_id: str) -> int:
        with self._lock:
            self._failures[chat_id] = self._failures.get(chat_id, 0) + 1
            return self._failures[chat_id]

    def status(self, chat_id: str) -> Dict[str, Any]:
        with self._lock:
            sess = self._sessions.get(chat_id)
        if sess is None:
            return {"state": "not started"}
        return {
            "state": "running" if sess.is_running else "stopped",
            "session_id": sess.session_id or "(none)",
            "ready": sess.ready.is_set(),
            "uptime_s": int(sess.uptime),
            "spawns": sess.spawn_count,
            "last_exit": sess.last_exit_code,
            "cli": str(sess.cli_path),
            "why": sess.failure_reason() if not sess.is_running else "",
        }

    def interrupt(self, chat_id: str) -> bool:
        """Send SIGINT to the claude-js process."""
        with self._lock:
            sess = self._sessions.get(chat_id)
        if sess and sess.is_running:
            sess.send_interrupt()
            return True
        return False

    def close(self, chat_id: str, forget_session: bool = False) -> None:
        """Terminate the process and renderer for a chat.

        `forget_session=True` also drops the persisted session id, so the next
        spawn starts a genuinely new conversation (that is what /clear means).
        """
        with self._lock:
            sess = self._sessions.pop(chat_id, None)
            rend = self._renderers.pop(chat_id, None)
            self._failures.pop(chat_id, None)
        if rend:
            try:
                rend.close()
            except Exception:
                pass
        if sess:
            sess.close()
        if forget_session:
            self._store.clear(chat_id)

    def close_all(self) -> None:
        """Terminate all sessions, leaving session ids on disk to resume."""
        with self._lock:
            keys = list(self._sessions.keys())
        for k in keys:
            self.close(k)


opencc_registry = OpenccSessionRegistry()


def _due_slots(now: datetime, times: List[str]) -> List[tuple]:
    """列出「已经到点」的调度时刻，按时间升序，返回 [(datetime, "HH:MM"), ...]。

    看门狗原先判断 `now_hm in SESSION_RESTART_TIMES`，即「此刻是不是恰好等于某个
    调度分钟」——只有 60 秒窗口。两种情况会让一整天的轮转永久丢失：sleep(60) 随
    循环耗时漂移，某个分钟值可能根本没被观察到；以及那一分钟里会话若正在生成回复
    就被 continue 跳过，而下一分钟已经不匹配了。漏一天，transcript 就多追加一天，
    正是它涨到 100MB 的原因。

    改成「哪些调度点已经过了」之后，错过的点会一直是待办，等会话空闲时补上。回看
    昨天是为了跨零点：凌晨 00:30 醒来时，昨天 18:30 那个点仍应算已到点。
    """
    slots = []
    for offset in (1, 0):
        day = (now - timedelta(days=offset)).date()
        for hm in times:
            try:
                hour, minute = (int(x) for x in hm.split(":"))
                when = datetime.combine(day, dtime(hour, minute))
            except ValueError:
                continue  # 配错的时刻直接忽略，不能让它拖垮整个看门狗
            if when <= now:
                slots.append((when, hm))
    slots.sort()
    return slots


def _cgroup_anon_mb() -> float:
    """本 unit 整个 cgroup 的匿名内存（MB）；读不到返回 0。

    只取 `anon`，不取 page cache：systemd 的 MemoryCurrent 把文件页也算进来
    （实测 16.6G 里 15.3G 是 cache、anon 仅 0.5G），拿 MemoryCurrent 当阈值
    会一直越界。anon 才是进程真正占住、内核回收不掉的那部分，也是唯一值得
    为它重启的。
    """
    rel = ""
    try:
        with open("/proc/self/cgroup") as fh:
            for line in fh:
                parts = line.strip().split(":", 2)
                if len(parts) == 3:
                    rel = parts[2].strip()
                    break
    except Exception:
        rel = ""

    # 只在【命名】cgroup 里读。rel 为空或 "/" 意味着进程没被 systemd 收进任何
    # slice —— 手工跑 `python feishu_bridge.py` 就是这样 —— 此时 /sys/fs/cgroup
    # 下那份 memory.stat 是【根 cgroup】的，也就是全机 anon（本机实测 13.0G），
    # 拿它比 8G 阈值，手工起的 bridge 会在 60 秒后自杀并进入重启循环。按"读不到"
    # 处理，走下面的自身 RSS 兜底。
    if rel and rel != "/":
        try:
            with (Path("/sys/fs/cgroup") / rel.lstrip("/") / "memory.stat").open() as fh:
                for line in fh:
                    # "anon " 带空格，所以不会误匹配 anon_thp。
                    if line.startswith("anon "):
                        return int(line.split()[1]) / 1024.0 / 1024.0
        except Exception:
            pass

    # 拿不到 cgroup 就退回自身 RSS，至少兜住 bridge 进程自己。
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except Exception:
        pass
    return 0.0


def _exit_for_anon(anon_mb: float) -> None:
    """匿名内存越界：尽力记一行日志，然后**无条件**退进程。

    日志那段包在 try 里是有原因的：`os._exit` 在 watchdog 的 try 块内调用，而
    print 只要抛（stdout 被关、管道断了），异常会被外层 `except Exception` 吃掉，
    循环继续跑 —— 内存护栏从此静默失效，而且每 60 秒失败一次。护栏的失败模式
    不能是"看起来在跑"。

    flush=True 也不能省：stdout 接的是管道（journal），默认块缓冲，而 os._exit
    跳过 atexit，缓冲区里那一行就永远不落盘 —— 日志里只剩一个没有原因的退出。
    """
    try:
        print(
            f"[watchdog] cgroup anon {anon_mb:.0f}MB > "
            f"{Config.BRIDGE_MAX_ANON_MB}MB，退出进程由 systemd 重启",
            flush=True,
        )
    except Exception:
        pass
    os._exit(1)


def _session_watchdog() -> None:
    """定时（用户休息时间到点）/ 超内存重启 opencc 会话，防 V8 堆无界增长（8G+ RSS）。

    只 close+prewarm LLM 会话：--resume 会先把上下文压缩成摘要再恢复，
    进程换新、RSS 掉回 1-2G；bridge / MCP / TTS 守护不受影响。
    """
    # chat_id -> 最后一个已执行的调度点（ISO 字符串）。首次见到某个 chat 时用
    # 当前已到点的最后一个初始化且不触发，否则 bridge 每次重启都会立刻轮转一次
    # 用户正在用的会话。
    last_slot: Dict[str, str] = {}
    while True:
        time.sleep(60)
        try:
            anon_mb = _cgroup_anon_mb()
            if anon_mb and anon_mb > Config.BRIDGE_MAX_ANON_MB:
                # 整个 unit 的匿名内存越界。交给 systemd（Restart=always +
                # RestartSec=5s）重来：比等 MemoryMax=24G OOM 更早；而 KillMode=
                # control-group 会把闯祸的子孙进程一起带走，所以重启确实能把 anon
                # 收回来 —— 是"重启即回收"，不是重启风暴。
                _exit_for_anon(anon_mb)
            now = datetime.now()
            slots = _due_slots(now, Config.SESSION_RESTART_TIMES)
            with opencc_registry._lock:
                items = list(opencc_registry._sessions.items())
            for chat_id, sess in items:
                if chat_id not in last_slot:
                    last_slot[chat_id] = slots[-1][0].isoformat() if slots else ""
                    continue
                if not sess.is_running:
                    continue
                # 有进行中的回合就不动（避免掐断正在生成的回复）。注意这里不更新
                # last_slot，所以待办的调度点会留到下一轮再试，不会被这次跳过吃掉。
                rend = opencc_registry._renderers.get(chat_id)
                if rend is not None and not getattr(rend, "_closed", True):
                    continue
                rss_mb = 0.0
                proc = getattr(sess, "_proc", None)
                if proc is not None and proc.poll() is None:
                    try:
                        with open(f"/proc/{proc.pid}/status") as f:
                            for line in f:
                                if line.startswith("VmRSS:"):
                                    rss_mb = int(line.split()[1]) / 1024.0
                                    break
                    except Exception:
                        pass
                pending = [s for s in slots if s[0].isoformat() > last_slot[chat_id]]
                reason = ""
                if pending:
                    hm_list = "、".join(hm for _, hm in pending)
                    overdue = "" if len(pending) == 1 else f"（补执行 {len(pending)} 个错过的点）"
                    reason = f"到点 {hm_list}（休息时间）定时重启{overdue}"
                elif rss_mb and rss_mb > Config.SESSION_MAX_RSS_MB:
                    reason = f"RSS {rss_mb:.0f}MB > {Config.SESSION_MAX_RSS_MB}MB"
                if reason:
                    # 轮转时刻（默认每天 09:00）→ forget session id 开新会话，旧 jsonl 归档不再追加；
                    # 否则 session jsonl 无界增长，数周上百 MB，opencc 处理时 bun GC 风暴卡死/崩溃。
                    # 补执行时只要跨过的点里有一个是轮转点就轮转，否则错过 09:00
                    # 后在 12:50 补上会退化成普通 resume，那一天照样不轮转。
                    rotate = any(hm in Config.SESSION_ROTATE_TIMES for _, hm in pending)
                    print(
                        f"[watchdog] 重启 opencc 会话 {chat_id[:12]}: {reason}"
                        + ("（轮转：开新会话，旧 jsonl 归档）" if rotate else "（resume 压内存）")
                    )
                    if pending:
                        last_slot[chat_id] = pending[-1][0].isoformat()
                    opencc_registry.close(chat_id, forget_session=rotate)
                    err = opencc_registry.prewarm(chat_id)
                    if err:
                        print(f"[watchdog] prewarm 失败: {err}")
        except Exception as e:
            print(f"[watchdog] 检查异常: {e}")


# ── MessageQueue ──────────────────────────────────────────────────


class MessageQueue:
    """Ensure messages are processed in order."""

    def __init__(self):
        self.queue: queue.Queue = queue.Queue()
        self.processing = False
        self.lock = threading.Lock()

    def add_message(self, chat_id: str, text: str, full_prompt: str, voice_reply: bool = False) -> None:
        """Add a message to the queue."""
        with self.lock:
            self.queue.put((chat_id, text, full_prompt, voice_reply))
            if not self.processing:
                self.processing = True
                threading.Thread(target=self._process_queue, daemon=True).start()

    def _process_queue(self) -> None:
        """Process messages in the queue, keeping only the latest."""
        while True:
            try:
                chat_id, text, full_prompt, voice_reply = self.queue.get(timeout=1)

                # Drain any newer messages for the same chat
                while not self.queue.empty():
                    try:
                        chat_id, text, full_prompt, voice_reply = self.queue.get_nowait()
                    except queue.Empty:
                        break

                self._handle_message(chat_id, text, full_prompt, voice_reply)

            except queue.Empty:
                with self.lock:
                    self.processing = False
                break
            except Exception as e:
                print(f"Error processing message queue: {e}")

    def _handle_message(self, chat_id: str, text: str, full_prompt: str, voice_reply: bool = False) -> None:
        """Handle a single message."""
        try:
            recent_messages[chat_id] = text
            recent_full_prompts[chat_id] = full_prompt

            # ── OpenCC spawn path ─────────────────────────────────
            if Config.OPENCC_SPAWN_MODE:
                sess, rend = opencc_registry.new_turn(chat_id)
                threading.Thread(
                    target=send_typing_loop_until,
                    args=(chat_id, lambda: rend._closed),
                    daemon=True,
                ).start()
                try:
                    reused = sess.is_running
                    sess.send(full_prompt)
                except OpenccSpawnError as e:
                    # Cannot start the backend at all. Say so instead of
                    # letting the user watch a card that never fills in.
                    rend.close()
                    count = opencc_registry.note_spawn_failure(chat_id)
                    reply(chat_id, f"OpenCC 无法启动（第 {count} 次）：\n{e}")
                    return

                opencc_registry.note_turn_started(chat_id)
                if Config.SOUL_DAILY_NOTES:
                    _note_daily(f"用户: {text.strip()[:200]}")
                if voice_reply:
                    # 语音进→语音出：等这轮渲染完成，把回复合成语音补发
                    threading.Thread(
                        target=self._tts_after_turn, args=(chat_id, rend), daemon=True
                    ).start()
                print(
                    f"[DEBUG] Routed chat={chat_id} via opencc spawn "
                    f"(model={Config.OPENCC_MODEL or 'default'}, "
                    f"{'reused live process' if reused else 'spawned'}, "
                    f"session={sess.session_id or 'new'}, "
                    f"spawns={sess.spawn_count})"
                )
                return

            # ── tmux fallback path ─────────────────────────────────
            Config.PENDING_FILE.parent.mkdir(parents=True, exist_ok=True)

            with open(Config.PENDING_FILE, "w") as f:
                f.write(str(int(time.time())))

            if not tmux_exists():
                reply(chat_id, "tmux not found")
                if os.path.exists(Config.PENDING_FILE):
                    os.remove(Config.PENDING_FILE)
                return

            threading.Thread(
                target=send_typing_loop, args=(chat_id,), daemon=True
            ).start()

            tmux_send(full_prompt)
            tmux_send_enter()

        except Exception as e:
            print(f"Error handling queued message: {e}")
            if os.path.exists(Config.PENDING_FILE):
                os.remove(Config.PENDING_FILE)

    def _tts_after_turn(self, chat_id: str, rend) -> None:
        """语音进→语音出：等这轮渲染完成，把回复文本合成语音补发。"""
        deadline = time.time() + 150
        while time.time() < deadline and not getattr(rend, "_closed", False):
            time.sleep(0.5)
        if not getattr(rend, "_closed", False):
            return
        text = rend.final_text()
        if text:
            send_voice_reply(chat_id, text)


message_queue = MessageQueue()


# ── BotHandler ────────────────────────────────────────────────────


class BotHandler:
    """Handle Feishu bot messages and commands."""

    def __init__(self, chat_id: str):
        self.chat_id = chat_id
        self.last_msg_id = self._load_last_msg_id()
        self._session_initialized = False
        self._attention_manager = AttentionManager()
        self._prompt_builder = StablePromptBuilder(self._attention_manager)

    # ── offset persistence ────────────────────────────────────────

    def _load_last_msg_id(self) -> str:
        """Load last processed message ID from file."""
        if os.path.exists(Config.LAST_MSG_ID_FILE):
            try:
                with open(Config.LAST_MSG_ID_FILE) as f:
                    return f.read().strip()
            except OSError:
                pass
        return ""

    def _save_last_msg_id(self) -> None:
        """Save last processed message ID to file."""
        Config.LAST_MSG_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(Config.LAST_MSG_ID_FILE, "w") as f:
            f.write(self.last_msg_id)

    # ── tmux helpers ──────────────────────────────────────────────

    def _require_tmux(self, chat_id: str) -> bool:
        """Check if tmux exists, reply with error if not."""
        if not tmux_exists():
            reply(chat_id, "tmux not found")
            return False
        return True

    def _start_typing(self, chat_id: str) -> None:
        """Start typing indicator (pending file + heartbeat thread)."""
        Config.PENDING_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(Config.PENDING_FILE, "w") as f:
            f.write(str(int(time.time())))
        threading.Thread(
            target=send_typing_loop, args=(chat_id,), daemon=True
        ).start()

    # ── prompt building ───────────────────────────────────────────

    def _get_or_init_auto_memory_instruction(self) -> str:
        """Get auto-memory instruction from DB, initialize if not exists."""
        if not Config.MEMORY_ENABLED:
            return Config.DEFAULT_AUTO_MEMORY_INSTRUCTION

        try:
            memory = get_memory()
            results = memory.get_by_type("system", "meta_instruction", limit=1)
            if results:
                return results[0]["content"]

            memory.add(
                "system",
                Config.DEFAULT_AUTO_MEMORY_INSTRUCTION,
                metadata={"type": "self_referential", "auto": False},
                message_type="meta_instruction",
            )
            return Config.DEFAULT_AUTO_MEMORY_INSTRUCTION
        except Exception as e:
            print(f"Error loading meta-instruction: {e}")
            return Config.DEFAULT_AUTO_MEMORY_INSTRUCTION

    def _build_full_prompt(
        self, text: str, chat_id: str, is_new_session: bool = False
    ) -> str:
        """Build full prompt with AttentionManager for KV-Cache optimization."""
        memories = None
        if Config.MEMORY_ENABLED:
            try:
                memory = get_memory()
                memories = memory.search(
                    chat_id, text, limit=Config.MEMORY_MAX_RESULTS
                )
            except Exception as e:
                print(f"Memory search error: {e}")

        claude_md_content = None
        include_meta = is_new_session or not self._session_initialized
        if include_meta:
            claude_md_content = load_claude_md()
            self._session_initialized = True

        if Config.KV_CACHE_ENABLED:
            full_prompt, cache_info = self._attention_manager.build_optimized_prompt_with_cache(
                user_input=text,
                chat_id=chat_id,
                memories=memories,
                include_meta_prompt=include_meta,
                claude_md_content=claude_md_content,
                ttl_seconds=Config.KV_CACHE_TTL,
            )
            if cache_info.get("cache_hit"):
                print(
                    f"[KV-Cache] Hit for chat {chat_id}, "
                    f"key: {cache_info.get('cache_key', 'unknown')}"
                )
        else:
            full_prompt = self._attention_manager.build_optimized_prompt(
                user_input=text,
                chat_id=chat_id,
                memories=memories,
                include_meta_prompt=include_meta,
                claude_md_content=claude_md_content,
            )

        return full_prompt

    # ── message handling ──────────────────────────────────────────

    def handle_message(self, item: dict) -> None:
        """Process incoming message from Feishu."""
        msg_type = item.get("msg_type", "")
        msg_id = item.get("message_id", "")
        chat_id = item.get("chat_id", "")

        if not chat_id:
            return

        # Save chat_id for persistence
        Config.CHAT_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(Config.CHAT_ID_FILE, "w") as f:
            f.write(chat_id)

        # Extract text based on message type
        text = self._extract_message_text(item, msg_type)

        if not text:
            print(f"[DEBUG] Empty or unknown message type: {msg_type}, skipping")
            return

        print(f"[{chat_id}] {text[:50]}...")

        if text.startswith("/"):
            if self._handle_command(text, chat_id, msg_id):
                return
            # 未匹配的 / 命令（如 /goal 等 opencc 内置命令）不拦截，
            # 走下方普通消息流程转发给 opencc 处理

        # Build full prompt
        if Config.RAW_MESSAGES:
            full_prompt = text
        else:
            full_prompt = self._build_full_prompt(text, chat_id)

        message_queue.add_message(chat_id, text, full_prompt, voice_reply=(msg_type == "audio"))

    def _download_key(self, file_key: str, file_type: str, subdir: str, msg_id: str) -> str:
        """按显式 key 下载，返回本地路径；失败返回空串。

        与 _download_resource 分开，是因为 key 不总在 content 顶层：图文消息（post）的
        附件在 content["files"][i]["file_key"]，内嵌图片在 tag=img 的元素里。
        """
        if not file_key:
            return ""
        save_dir = f"/tmp/matebot_{subdir}"
        os.makedirs(save_dir, exist_ok=True)
        return download_file(get_token_manager(), msg_id, file_key, file_type, save_dir) or ""

    def _download_resource(self, item: dict, key_field: str, file_type: str, subdir: str) -> str:
        """下载消息里的资源（image_key / file_key），返回本地路径；失败返回空串。"""
        content_str = item.get("body", {}).get("content", "")
        try:
            file_key = json.loads(content_str).get(key_field, "")
        except (json.JSONDecodeError, TypeError):
            return ""
        return self._download_key(file_key, file_type, subdir, item.get("message_id", ""))

    def _handle_image(self, item: dict) -> str:
        """下载图片 → 优先 tesseract OCR 提文字（视觉通道读不了图）。"""
        path = self._download_resource(item, "image_key", "image", "images")
        if not path:
            return "[Image: 无法解析 image_key 或下载失败]"
        text = ocr_image(path)
        if text:
            return f"[图片OCR: {text}]"
        return f"[图片已保存: {path}]（OCR 无结果，可尝试读图）"

    def _handle_file(self, item: dict) -> str:
        """下载文件到本地，把路径交给模型让它用工具读内容。"""
        path = self._download_resource(item, "file_key", "file", "files")
        if path:
            return f"[文件已保存: {path}]"
        return "[File: 下载失败]"

    def _handle_audio(self, item: dict) -> str:
        """语音 → 下载 → ffmpeg 转 16k wav → SenseVoice 转写 → 文字给模型。"""
        path = self._download_resource(item, "file_key", "file", "audio")
        if not path:
            return "[Audio: 下载失败]"
        wav = f"{path}.wav"
        try:
            subprocess.run(
                [FFMPEG_BIN, "-y", "-i", path, "-ar", "16000", "-ac", "1", wav],
                check=True, capture_output=True, timeout=120,
            )
        except Exception as e:
            print(f"[audio] ffmpeg 转码失败 {path}: {e}")
            return f"[Audio: 转码失败 {path}]"
        text = transcribe_audio(wav)
        if text:
            return f"[语音转写: {text}]"
        return f"[Audio: 转写为空 {path}]"

    def _handle_video(self, item: dict) -> str:
        """视频 → 下载 → 抽首帧，模型可看画面。"""
        path = self._download_resource(item, "file_key", "file", "videos")
        if not path:
            return "[Video: 下载失败]"
        frame = f"{path}.frame.jpg"
        try:
            subprocess.run(
                [FFMPEG_BIN, "-y", "-i", path, "-frames:v", "1", frame],
                check=True, capture_output=True, timeout=120,
            )
            if os.path.exists(frame):
                return f"[视频已保存: {path}, 首帧: {frame}]"
        except Exception as e:
            print(f"[video] 抽帧失败 {path}: {e}")
        return f"[视频已保存: {path}]"

    def _handle_post(self, item: dict) -> str:
        """图文消息：抽出标题、正文、内嵌图片，以及**附件**。

        附件以前是整段被丢掉的：这个分支只读 content 里的 text 元素，于是「派个 agent
        学下这本 <附件的书>」到我手上只剩前半句，书根本没到 —— 而带附件发文件正是飞书里
        自然的用法。2026-09-12 一本 PDF 就这样丢过一次。

        顺序上把附件放最后：文字是要求，附件是要处理的材料，模型先读到「要干什么」。
        """
        try:
            content = json.loads(item.get("body", {}).get("content", ""))
        except (json.JSONDecodeError, TypeError):
            return "[Post]"
        if not isinstance(content, dict):
            return "[Post]"

        parts: list[str] = []
        title = content.get("title")
        if isinstance(title, str) and title.strip():
            parts.append(title.strip())

        body: list[str] = []
        image_keys: list[str] = []
        for para in content.get("content", []):
            if not isinstance(para, list):
                continue
            for elem in para:
                if not isinstance(elem, dict):
                    continue
                if elem.get("tag") == "img":
                    key = elem.get("image_key")
                    if isinstance(key, str) and key:
                        image_keys.append(key)
                    continue
                text = elem.get("text")
                if isinstance(text, str) and text:
                    body.append(text)
        if body:
            parts.append("\n".join(body))

        msg_id = item.get("message_id", "")
        for key in image_keys:
            path = self._download_key(key, "image", "images", msg_id)
            parts.append(f"[图片已保存: {path}]" if path else "[Image: 下载失败]")

        files = content.get("files", [])
        if isinstance(files, list):
            for entry in files:
                if not isinstance(entry, dict):
                    continue
                name = entry.get("file_name", "?")
                path = self._download_key(entry.get("file_key", ""), "file", "files", msg_id)
                parts.append(f"[文件已保存: {path}]" if path else f"[File: 下载失败 {name}]")

        return "\n".join(p for p in parts if p) or "[Post]"

    def _extract_message_text(self, item: dict, msg_type: str) -> str:
        """Extract human-readable text from a Feishu message item."""
        if msg_type == "text":
            return parse_message_text(item)

        if msg_type == "image":
            return self._handle_image(item)

        if msg_type == "file":
            return self._handle_file(item)

        if msg_type == "audio":
            return self._handle_audio(item)

        if msg_type == "media":
            # media 可能是视频/图文：有 file_key 就按视频下载+抽帧，否则提取文本
            content_str = item.get("body", {}).get("content", "")
            try:
                content = json.loads(content_str)
                if isinstance(content, dict):
                    if content.get("file_key"):
                        return self._handle_video(item)
                    text_part = content.get("text", "")
                    if text_part:
                        return text_part
            except (json.JSONDecodeError, TypeError):
                pass
            return "[Media]"

        if msg_type == "sticker":
            return "[Sticker]"

        if msg_type == "post":
            return self._handle_post(item)

        # Unknown type
        return ""

    # ── command handling ──────────────────────────────────────────

    def _handle_command(
        self, text: str, chat_id: str, msg_id: str = ""
    ) -> bool:
        """Handle bot commands. 返回 True 表示已本地处理；False 表示未匹配，应转发给 opencc。"""
        parts = text.split(maxsplit=1)
        cmd = parts[0].lower()
        args = parts[1] if len(parts) > 1 else ""

        handlers = {
            "/status": self._cmd_status,
            "/stop": self._cmd_stop,
            "/clear": self._cmd_clear,
            "/continue_": self._cmd_continue,
            "/resume": self._cmd_resume,
            "/remember": self._cmd_remember,
            "/recall": self._cmd_recall,
            "/forget": self._cmd_forget,
            "/memstats": self._cmd_memstats,
            "/task": self._cmd_task,
            "/todo": self._cmd_todo,
            "/failures": self._cmd_failures,
            "/lessons": self._cmd_lessons,
            "/kvcache": self._cmd_kvcache,
            "/soul": self._cmd_soul,
            "/reload_soul": self._cmd_reload_soul,
            "/tts": self._cmd_tts,
        }

        if cmd in handlers:
            handlers[cmd](chat_id, args)
            return True
        if cmd in Config.BLOCKED_COMMANDS:
            reply(chat_id, f"'{cmd}' not supported (interactive)")
            return True
        # 未匹配的 / 命令（如 /goal 等 opencc 内置命令）→ 交给 opencc 处理
        return False

    def _cmd_status(self, chat_id: str, _: str) -> None:
        if Config.OPENCC_SPAWN_MODE:
            st = opencc_registry.status(chat_id)
            lines = [
                f"OpenCC: {st['state']}",
                f"Model: {Config.OPENCC_MODEL or 'default'}",
            ]
            if st["state"] != "not started":
                lines += [
                    f"Session: {st['session_id']}",
                    f"Ready: {st['ready']}",
                    # spawns > 1 is the tell for the respawn bug coming back:
                    # a healthy chat spawns exactly once and stays up.
                    f"Uptime: {st['uptime_s']}s  Spawns: {st['spawns']}",
                    f"CLI: {st['cli']}",
                ]
                if st["why"]:
                    lines.append(f"Died with: {st['why']}")
            if Config.SOUL_ENABLED:
                ws = opencc_registry.workspace
                lines.append(f"Workspace: {ws.root if ws else '(disabled)'}")
                if opencc_registry.soul_changed():
                    lines.append(
                        "⚠️ 身份文件已改动，重启进程后生效（/clear 或 /reload_soul）"
                    )
            reply(chat_id, "\n".join(lines))
        else:
            status = "running" if tmux_exists() else "not found"
            reply(chat_id, f"tmux '{Config.TMUX_SESSION}': {status}")

    def _cmd_stop(self, chat_id: str, _: str) -> None:
        """Stop/interrupt Claude and send any partial response."""
        if Config.OPENCC_SPAWN_MODE:
            interrupted = opencc_registry.interrupt(chat_id)
            reply(
                chat_id,
                "Interrupted (opencc)" if interrupted else "No active session",
            )
            return

        # tmux mode: send partial response before interrupting
        if os.path.exists(Config.PENDING_FILE):
            try:
                transcript_path = find_latest_transcript()
                if transcript_path:
                    responses, new_position, _ = extract_assistant_responses(
                        transcript_path,
                        response_monitor.last_position,
                        response_monitor._seen_message_ids,
                    )
                    if responses and responses.strip():
                        cleaned_responses, _ = extract_memory_update(responses)
                        if cleaned_responses and cleaned_responses.strip():
                            reply(chat_id, cleaned_responses)
                            response_monitor.last_position = new_position
            except Exception as e:
                print(f"[DEBUG] Error checking for partial response: {e}")

        if tmux_exists():
            tmux_send_escape()

        if os.path.exists(Config.PENDING_FILE):
            os.remove(Config.PENDING_FILE)

        reply(chat_id, "Interrupted")

    def _cmd_clear(self, chat_id: str, _: str) -> None:
        if Config.OPENCC_SPAWN_MODE:
            # /clear means "forget this conversation", so drop the persisted
            # session id too — otherwise the next spawn would --resume right
            # back into what was just cleared.
            opencc_registry.close(chat_id, forget_session=True)
            self._session_initialized = False
            err = opencc_registry.prewarm(chat_id)
            reply(
                chat_id,
                "Cleared (new opencc session)"
                if not err
                else f"Cleared, but backend failed to restart:\n{err}",
            )
            return

    def _cmd_soul(self, chat_id: str, _: str) -> None:
        """Show what identity files are loaded and how big they are."""
        if not Config.SOUL_ENABLED:
            reply(chat_id, "Workspace disabled (SOUL_ENABLED=false)")
            return
        ws = opencc_registry.workspace
        if ws is None:
            reply(chat_id, "Workspace not initialised")
            return

        from soul import WORKSPACE_FILES

        lines = [f"📁 {ws.root}", ""]
        for name in WORKSPACE_FILES:
            path = ws.root / name
            if path.exists():
                size = len(path.read_text(encoding="utf-8", errors="replace"))
                mark = "  ⚠️ 超限被截断" if size > ws.max_chars else ""
                lines.append(f"  ✅ {name}  {size} chars{mark}")
            else:
                lines.append(f"  ⬜ {name}  (缺失)")
        note = ws.daily_note_path()
        lines.append(
            f"  {'✅' if note.exists() else '⬜'} memory/{note.name}"
        )
        lines.append("")
        lines.append(f"上限: {ws.max_chars} chars/文件 · 指纹 {ws.fingerprint()}")
        if opencc_registry.soul_changed():
            lines.append("⚠️ 改动未生效，/reload_soul 重载")
        reply(chat_id, "\n".join(lines))

    def _cmd_reload_soul(self, chat_id: str, _: str) -> None:
        """Re-read the workspace files and restart the process to apply them.

        The identity bundle is passed via --append-system-prompt at spawn, so
        it cannot change under a live process. The conversation itself is kept:
        the persisted session id is left alone and resumed.
        """
        if not Config.SOUL_ENABLED:
            reply(chat_id, "Workspace disabled (SOUL_ENABLED=false)")
            return
        ws = opencc_registry.workspace
        created = ws.ensure_scaffold() if ws else []
        opencc_registry.close(chat_id)  # keeps session id → resumes
        err = opencc_registry.prewarm(chat_id)
        if err:
            reply(chat_id, f"Reload failed:\n{err}")
            return
        note = f"，已创建 {', '.join(created)}" if created else ""
        reply(chat_id, f"身份文件已重载（会话保留）{note}")

        if not self._require_tmux(chat_id):
            return
        self._session_initialized = False
        tmux_send_escape()
        time.sleep(0.2)
        tmux_send("/clear")
        tmux_send_enter()
        reply(chat_id, "Cleared")

    def _start_claude_with_command(
        self, chat_id: str, command: str, message: str
    ) -> bool:
        """Start Claude with a specific command (tmux mode only)."""
        if Config.OPENCC_SPAWN_MODE:
            reply(chat_id, "This command requires tmux mode (OPENCC_SPAWN_MODE=false)")
            return False

        if not self._require_tmux(chat_id):
            return False

        self._session_initialized = False
        tmux_send_escape()
        time.sleep(0.2)
        tmux_send("/exit")
        tmux_send_enter()
        time.sleep(0.5)
        tmux_send(command)
        tmux_send_enter()
        reply(chat_id, message)
        return True

    def _cmd_tts(self, chat_id: str, args: str) -> None:
        """/tts 说点什么 → 合成语音发回来。"""
        text = args.strip()
        if not text:
            reply(chat_id, "用法：/tts 说点什么")
            return
        reply(chat_id, "🎤 合成中…")
        ok = send_voice_reply(chat_id, text)
        if not ok:
            reply(chat_id, "TTS 失败，看 journal 日志")

    def _cmd_continue(self, chat_id: str, _: str) -> None:
        """Continue most recent session."""
        self._start_claude_with_command(
            chat_id,
            "claude --continue --dangerously-skip-permissions",
            "Continuing...",
        )

    def _cmd_resume(self, chat_id: str, _: str) -> None:
        """Show recent sessions (Feishu has no inline keyboards)."""
        self._session_initialized = False
        sessions = get_recent_sessions()
        if not sessions:
            reply(chat_id, "No recent sessions found")
            return

        lines = ["📋 Recent sessions:", ""]
        for s in sessions:
            sid = get_session_id(s.get("project", ""))
            display = s.get("display", "?")[:60]
            if sid:
                lines.append(f"  {display}")
                lines.append(f"    ID: {sid}")
            else:
                lines.append(f"  {display}")
            lines.append("")

        lines.append(
            "To resume a session, set OPENCC_SESSION_ID=<id> and restart."
        )
        reply(chat_id, "\n".join(lines))

    def _cmd_remember(self, chat_id: str, args: str) -> None:
        if not args:
            reply(chat_id, "Usage: /remember <text>")
            return

        memory = get_memory()
        if memory.add(chat_id, args, metadata={"type": "manual"}):
            reply(chat_id, "✅ Saved to memory")
        else:
            reply(chat_id, "❌ Failed to save")

    def _cmd_recall(self, chat_id: str, args: str) -> None:
        memory = get_memory()

        if args:
            results = memory.search(chat_id, args, limit=10)
        else:
            results = memory.get_recent(chat_id, limit=10)

        if not results:
            reply(chat_id, "No memories found")
            return

        lines = ["📚 Your memories:", ""]
        for i, mem in enumerate(results[:10], 1):
            content = mem["content"][:100]
            if len(mem["content"]) > 100:
                content += "..."
            lines.append(f"{i}. {content}")

        reply(chat_id, "\n".join(lines))

    def _cmd_forget(self, chat_id: str, args: str) -> None:
        if not args:
            reply(chat_id, "Usage: /forget <query or 'all'>")
            return

        memory = get_memory()

        if args.lower() == "all":
            if memory.clear_all(chat_id):
                reply(chat_id, "🗑️ All memories cleared")
            else:
                reply(chat_id, "❌ Failed to clear")
        else:
            count = memory.delete_by_query(chat_id, args)
            reply(chat_id, f"🗑️ Deleted {count} memory(s)")

    def _cmd_memstats(self, chat_id: str, _: str) -> None:
        memory = get_memory()
        stats = memory.get_stats(chat_id)
        type_info = "\n".join(
            [f"  {t}: {c}" for t, c in stats.get("by_type", {}).items()]
        )
        reply(
            chat_id,
            f"📊 Memory Stats:\n"
            f"Total: {stats['count']} memories\n"
            f"Newest: {stats['newest'] or 'N/A'}\n"
            f"Oldest: {stats['oldest'] or 'N/A'}\n"
            f"By type:\n{type_info or '  N/A'}",
        )

    def _cmd_task(self, chat_id: str, args: str) -> None:
        """Create or manage tasks with todo.md tracking."""
        if args:
            task_id = self._attention_manager.create_task(chat_id, args)
            reply(
                chat_id,
                f"🎯 Task created!\n"
                f"Goal: {args}\n"
                f"Task ID: {task_id}\n\n"
                f"The task goal will be appended to every prompt.\n"
                f"Use /todo to view or update progress.",
            )
        else:
            tasks = self._attention_manager._external.list_tasks(chat_id)
            if not tasks:
                reply(chat_id, "No active tasks. Create one with /task <goal>")
                return

            lines = ["🎯 Active Tasks:", ""]
            for t in tasks[:5]:
                task_name = (
                    t["task_id"].replace("_todo.md", "").replace("_", " ")
                )
                lines.append(f"• {task_name}")

            current = self._attention_manager.get_task_id(chat_id)
            lines.append(f"\nCurrent: {current}")
            reply(chat_id, "\n".join(lines))

    def _cmd_todo(self, chat_id: str, args: str) -> None:
        """View or update todo.md for current task."""
        if args:
            task_id = self._attention_manager.get_task_id(chat_id)
            if self._attention_manager._external.update_todo_md(
                chat_id, args, task_id, append=True
            ):
                reply(chat_id, "✅ Todo updated")
            else:
                reply(chat_id, "❌ Failed to update")
        else:
            task_id = self._attention_manager.get_task_id(chat_id)
            todo = self._attention_manager._external.get_todo_md(chat_id, task_id)

            if not todo or todo.startswith("# 当前任务目标"):
                reply(
                    chat_id,
                    "No active todo. Create a task first with /task <goal>",
                )
                return

            if len(todo) > 3000:
                todo = todo[:3000] + "\n\n... (truncated)"

            reply(chat_id, f"📝 Current Todo ({task_id}):\n\n{todo}")

    def _cmd_failures(self, chat_id: str, args: str) -> None:
        """View failure lessons or mark as resolved."""
        try:
            fm = get_failure_memory()

            if not args:
                stats = fm.get_stats(chat_id)
                failures = fm.get_user_failures(
                    chat_id, resolved_only=False, limit=5
                )

                lines = [
                    "📊 失败经验统计",
                    f"总计: {stats['total_unique']} 个独立失败",
                    f"已解决: {stats['resolved']}，未解决: {stats['unresolved']}",
                    f"总发生次数: {stats['total_occurrences']}",
                    f"平均重复: {stats['avg_recurrence']:.1f} 次/失败",
                    "",
                    "📝 最近的未解决失败:",
                ]

                if failures:
                    for i, f in enumerate(failures, 1):
                        lines.append(f"{i}. {f.action[:50]}")
                        lines.append(f"   错误: {f.error_message[:80]}")
                        if f.recurrence_count > 1:
                            lines.append(f"   重复: {f.recurrence_count} 次")
                        lines.append(f"   ID: {f.failure_id[:8]}")
                        lines.append("")
                else:
                    lines.append("暂无未解决失败")

                lines.append("\n使用 /failures stats 查看详细统计")
                lines.append("使用 /failures resolve <ID> 标记为已解决")
                reply(chat_id, "\n".join(lines))
                return

            args_lower = args.lower().strip()
            if args_lower == "stats":
                stats = fm.get_stats(chat_id)
                lines = ["📊 失败经验详细统计", ""]
                for key, value in stats.items():
                    if key == "by_type":
                        lines.append("按错误类型分类:")
                        for err_type, count in value.items():
                            lines.append(f"  {err_type}: {count}")
                    else:
                        lines.append(f"{key}: {value}")
                reply(chat_id, "\n".join(lines))
                return

            if args_lower.startswith("resolve "):
                failure_id = args_lower[8:].strip()
                if fm.mark_resolved(chat_id, failure_id):
                    reply(chat_id, f"✅ 失败记录 {failure_id[:8]} 标记为已解决")
                else:
                    reply(chat_id, f"❌ 未找到失败记录 {failure_id[:8]}")
                return

            # Search failures by query
            failures = fm.get_user_failures(
                chat_id, resolved_only=False, limit=20
            )
            filtered = [
                f
                for f in failures
                if args.lower() in f.action.lower()
                or args.lower() in f.error_message.lower()
            ]
            if not filtered:
                reply(chat_id, f"未找到包含 '{args}' 的失败记录")
                return

            lines = [f"🔍 找到 {len(filtered)} 个相关失败:", ""]
            for i, f in enumerate(filtered[:5], 1):
                lines.append(f"{i}. {f.action[:60]}")
                lines.append(f"   错误: {f.error_message[:80]}")
                if f.lesson and f.lesson != "待总结":
                    lines.append(f"   教训: {f.lesson[:80]}")
                lines.append(f"   ID: {f.failure_id[:8]}")
                lines.append("")
            if len(filtered) > 5:
                lines.append(f"... 还有 {len(filtered) - 5} 个未显示")
            reply(chat_id, "\n".join(lines))

        except Exception as e:
            print(f"Error handling /failures: {e}")
            reply(chat_id, f"❌ 处理失败记录时出错: {e}")

    def _cmd_lessons(self, chat_id: str, args: str) -> None:
        """View learned lessons from failures."""
        try:
            fm = get_failure_memory()

            failures = fm.get_user_failures(
                chat_id, resolved_only=False, limit=50
            )
            lessons = [
                f for f in failures if f.lesson and f.lesson != "待总结"
            ]

            if args:
                query = args.lower()
                lessons = [
                    f
                    for f in lessons
                    if query in f.lesson.lower() or query in f.action.lower()
                ]

            if not lessons:
                reply(
                    chat_id,
                    f"📭 暂无已总结的教训{' (查询: ' + args + ')' if args else ''}",
                )
                return

            lines = [f"📚 学到的教训 ({len(lessons)} 个):", ""]
            for i, f in enumerate(lessons[:10], 1):
                lines.append(f"{i}. 【{f.action[:50]}】")
                lines.append(f"   教训: {f.lesson[:100]}")
                if f.recurrence_count > 1:
                    lines.append(f"   (重复 {f.recurrence_count} 次)")
                lines.append("")

            if len(lessons) > 10:
                lines.append(f"... 还有 {len(lessons) - 10} 个未显示")
            reply(chat_id, "\n".join(lines))

        except Exception as e:
            print(f"Error handling /lessons: {e}")
            reply(chat_id, f"❌ 处理教训记录时出错: {e}")

    def _cmd_kvcache(self, chat_id: str, args: str) -> None:
        """Display KV-Cache statistics or clear cache."""
        try:
            stats = self._attention_manager.get_cache_stats()

            if args.strip().lower() == "clear":
                cleared = self._attention_manager._kv_cache.clear_cache()
                reply(chat_id, f"🗑️ 已清除 {cleared} 个缓存条目")
                return

            lines = [
                "🔧 KV-Cache 统计信息",
                f"命中率: {stats['hit_rate']:.1%}",
                f"总查询: {stats['total_queries']}",
                f"命中: {stats['hit_count']}",
                f"未命中: {stats['miss_count']}",
                f"缓存条目: {stats['cache_size']}",
                f"缓存目录: {stats['cache_dir']}",
                "",
                "使用 /kvcache clear 清除缓存",
            ]

            reply(chat_id, "\n".join(lines))

        except Exception as e:
            print(f"Error handling /kvcache: {e}")
            reply(chat_id, f"❌ 处理KV-Cache统计时出错: {e}")

    # ── polling loop ──────────────────────────────────────────────

    def poll_updates(self) -> None:
        """Main polling loop for Feishu messages."""
        print(f"MateBot Feishu Bridge started")
        print(f"  Spawn mode: {Config.OPENCC_SPAWN_MODE}")
        print(f"  Chat ID: {self.chat_id}")
        print(f"  Last msg ID: {self.last_msg_id or '(none)'}")

        response_monitor.start()

        try:
            while True:
                try:
                    items = poll_messages(
                        get_token_manager(), self.chat_id, self.last_msg_id
                    )
                    for item in items:
                        try:
                            # Skip messages sent by the bot itself
                            sender = item.get("sender", {})
                            if sender.get("id_type") == "app_id":
                                continue
                            self.handle_message(item)
                        except Exception as e:
                            print(f"Error handling message: {e}")
                            import traceback
                            traceback.print_exc()

                        self.last_msg_id = item.get(
                            "message_id", self.last_msg_id
                        )
                        self._save_last_msg_id()

                    if not items:
                        time.sleep(Config.POLL_INTERVAL)

                except KeyboardInterrupt:
                    print("\nStopping...")
                    break
                except Exception as e:
                    print(f"Polling error: {e}")
                    time.sleep(5)
        finally:
            response_monitor.stop()
            if Config.OPENCC_SPAWN_MODE:
                opencc_registry.close_all()


# ── Main entry point ──────────────────────────────────────────────


def main() -> int:
    """Start the Feishu bot bridge."""
    if not Config.FEISHU_APP_ID or not Config.FEISHU_APP_SECRET:
        print("Error: FEISHU_APP_ID and FEISHU_APP_SECRET must be set")
        return 1

    # Create token manager
    tm = TokenManager(Config.FEISHU_APP_ID, Config.FEISHU_APP_SECRET)
    set_token_manager(tm)

    # Discover or use configured chat_id
    chat_id = Config.FEISHU_CHAT_ID
    if not chat_id and Config.FEISHU_USER_OPEN_ID:
        print("Discovering chat_id...")
        chat_id = discover_chat_id(tm, Config.FEISHU_USER_OPEN_ID) or ""

    if not chat_id:
        # Try loading from saved file
        if os.path.exists(Config.CHAT_ID_FILE):
            with open(Config.CHAT_ID_FILE) as f:
                chat_id = f.read().strip()
            if chat_id:
                print(f"Loaded chat_id from file: {chat_id}")

    if not chat_id:
        print("Error: No chat_id configured and auto-discovery failed")
        print("Set FEISHU_CHAT_ID or FEISHU_USER_OPEN_ID, or send a message")
        print("to the bot first so auto-discovery can find the chat.")
        return 1

    print(f"Using chat_id: {chat_id}")

    if Config.OPENCC_SPAWN_MODE:
        # Fail loudly and immediately on a broken backend. Discovering this on
        # the user's first message — as a card that silently never fills in —
        # is how the respawn bug stayed invisible for so long.
        try:
            cli = resolve_cli_path(Config.OPENCC_CLI_PATH or None)
            print(f"OpenCC CLI: {cli}")
        except OpenccSpawnError as e:
            print(f"Error: {e}")
            return 1

        if Config.SOUL_ENABLED:
            ws = opencc_registry.workspace
            if ws is not None:
                created = ws.ensure_scaffold()
                print(f"Workspace: {ws.root}")
                if created:
                    print(f"  created: {', '.join(created)}")

        if Config.OPENCC_PREWARM:
            print("Warming OpenCC session...")
            err = opencc_registry.prewarm(chat_id)
            if err:
                print(f"Warning: prewarm failed: {err}")

        # 后台预热 CosyVoice TTS 守护（首次加载 2.7GB 模型较慢，先跑起来，/tts 即用）
        threading.Thread(target=_ensure_tts_daemon, daemon=True).start()
        # 会话内存看门狗：定时/超 RSS 自动重启 opencc 会话，防 V8 堆涨到 8G+
        threading.Thread(target=_session_watchdog, daemon=True).start()

    handler = BotHandler(chat_id)
    handler.poll_updates()
    return 0


if __name__ == "__main__":
    exit(main())