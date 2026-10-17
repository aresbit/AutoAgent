#!/usr/bin/env python3
"""Feishu streaming renderer — accumulates stream-json events from an OpenCC
(claude-js) subprocess and streams them to Feishu via interactive card messages.

Mirrors the design of TelegramStreamRenderer from opencc_backend.py, adapted
for Feishu's send_card_message / edit_card_message API.

Card messages (msg_type="interactive") are required because Feishu only
supports editing card messages via PATCH — plain text messages cannot be edited.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from feishu_api import (
    TokenManager,
    send_card_message,
    edit_card_message,
    build_streaming_card,
)


class FeishuStreamRenderer:
    """Accumulates stream-json events into a per-turn Feishu card message that
    is edit-updated in place.

    Concurrency model: stream-json events arrive on the OpenccSession stdout
    reader thread. Those handlers must NOT call Feishu synchronously — a
    round-trip to open.feishu.cn is typically 1–3s in China. Blocking the
    reader thread back-pressures claude-js's stdout, which stalls generation.

    Design: a single per-renderer worker thread owns ALL Feishu network I/O.
    Event handlers only mutate buffered state under a lock and set a
    `_dirty` event. The worker:
      - waits for `_dirty` (or a short timeout)
      - enforces a min interval between Feishu round-trips (`EDIT_THROTTLE_S`)
      - snapshots the current body and edits / sends in place
      - coalesces: many appends + one network call
    """

    # Min seconds between consecutive edit_card_message calls.
    EDIT_THROTTLE_S = 1.5
    MAX_FEISHU_LEN = 30000

    # Max tool calls kept visible on the card. A "call" is a '[tool] NAME'
    # line plus the result line that follows it; older calls are folded into
    # a single summary line. This also bounds `_tool_lines` memory: a long
    # turn can issue hundreds of calls, and only the newest few are shown.
    MAX_VISIBLE_TOOL_CALLS = 5
    TOOL_LINE_PREFIX = "[tool] "
    TOOL_RESULT_PREFIX = "  "

    def __init__(
        self,
        chat_id: str,
        token_mgr: TokenManager,
    ):
        self.chat_id = str(chat_id)
        self.token_mgr = token_mgr

        self._text = ""           # current live-chunk content
        self._prior_text = ""     # content already shipped in earlier chunks
        self._live_msg_id: Optional[str] = None
        self._tool_lines: list[str] = []
        self._folded_calls = 0    # tool calls dropped from the visible window
        self._folded_errors = 0   # failed results among those dropped
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
                    tool_name = block.get("name", "?")
                    self._tool_lines.append(f"{self.TOOL_LINE_PREFIX}{tool_name}")
                    added = True
            self._fold_old_tool_calls_locked()
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
                    tag = "[error]" if block.get("is_error") else "[ok]"
                    self._tool_lines.append(f"{self.TOOL_RESULT_PREFIX}{tag}")
                    added = True
            self._fold_old_tool_calls_locked()
        if added:
            self._dirty.set()

    def _handle_result(self, event: dict) -> None:
        is_error = bool(event.get("is_error"))
        with self._lock:
            if not (self._text.strip() or self._prior_text.strip()) and event.get("result"):
                self._text += str(event.get("result"))
            if is_error and event.get("result"):
                self._text += f"\n\nError: {str(event.get('result'))[:300]}"
            self._closed = True
        self._dirty.set()

    def final_text(self) -> str:
        """Turn 结束后的完整回复文本（不含工具前缀），供 TTS 语音回复用。"""
        with self._lock:
            return (self._prior_text + self._text).strip()

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

    # -- tool-line folding ------------------------------------------------

    def _fold_old_tool_calls_locked(self) -> None:
        """Drop the oldest tool calls once more than MAX_VISIBLE_TOOL_CALLS
        are buffered, counting what was dropped.

        Bounds both the card content and `_tool_lines` memory. The cut is made
        only at a '[tool]' line boundary, so a result line ('  [ok]' /
        '  [error]') can never be left orphaned without its call. A call whose
        result has not arrived yet (a trailing '[tool]' with nothing after it)
        is never folded on its own.

        Caller must hold `self._lock`.
        """
        starts = [
            i for i, line in enumerate(self._tool_lines)
            if line.startswith(self.TOOL_LINE_PREFIX)
        ]
        excess = len(starts) - self.MAX_VISIBLE_TOOL_CALLS
        if excess <= 0:
            return
        cut = starts[excess]
        dropped = self._tool_lines[:cut]
        self._folded_calls += excess
        self._folded_errors += sum(
            1 for line in dropped
            if line.startswith(self.TOOL_RESULT_PREFIX) and "[error]" in line
        )
        del self._tool_lines[:cut]

    def _shippable_tool_count_locked(self, count: int) -> int:
        """How many leading lines may be dropped after being shipped, keeping
        pairing: never drop a trailing in-flight '[tool]' line, whose result
        would otherwise be appended later as an orphan.

        Caller must hold `self._lock`.
        """
        if count > 0 and self._tool_lines[count - 1].startswith(self.TOOL_LINE_PREFIX):
            return count - 1
        return count

    def _snapshot_tool_lines(self) -> list[str]:
        """Snapshot the tool lines to render: a folded-calls hint, when any
        calls have been folded out, followed by the newest calls."""
        with self._lock:
            folded_calls = self._folded_calls
            folded_errors = self._folded_errors
            lines = list(self._tool_lines)
        if folded_calls > 0:
            hint = f"… 前 {folded_calls} 个工具调用已折叠"
            if folded_errors:
                hint += f"（含 {folded_errors} 个失败）"
            lines.insert(0, hint)
        return lines

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
                text_snapshot = self._text
                tool_snapshot_count = len(self._tool_lines)
                closed = self._closed

            body = text_snapshot.rstrip()
            # Approximate total length: card text + tool lines overhead.
            # Use the *rendered* view (fold hint included) so this matches
            # what `_upsert_live` actually ships in the card.
            tool_text = "\n".join(self._snapshot_tool_lines())
            approx_len = len(tool_text) + len(body)

            if not body and not tool_text:
                if closed:
                    return
                continue

            try:
                if approx_len <= self.MAX_FEISHU_LEN:
                    if body != last_sent_body:
                        self._upsert_live(body)
                        last_sent_body = body
                        last_sent_ts = time.time()
                else:
                    # Ship the head as a card, then send a NEW card for the tail.
                    head = body[:self.MAX_FEISHU_LEN]
                    self._upsert_live(head)
                    last_sent_ts = time.time()
                    with self._lock:
                        shipped_text_chars = max(0, self.MAX_FEISHU_LEN - len(tool_text))
                        self._text = self._text[shipped_text_chars:]
                        # The tool lines just shipped are cleared from the
                        # buffer; the new card starts its own view, so the
                        # fold counters restart with it. Never drop a trailing
                        # in-flight '[tool]' (its result would be an orphan).
                        del self._tool_lines[:self._shippable_tool_count_locked(tool_snapshot_count)]
                        self._folded_calls = 0
                        self._folded_errors = 0
                        self._prior_text += head
                        self._live_msg_id = None
                    last_sent_body = ""
                    # Tail must be sent — wake immediately on next loop.
                    self._dirty.set()
                    continue
            except Exception as e:
                # Don't kill the worker on transient Feishu/proxy errors;
                # leave last_sent_body untouched so we retry on next wake-up.
                print(f"[feishu-renderer] send error: {e}")

            if closed and not self._dirty.is_set():
                return

    def _upsert_live(self, text: str) -> None:
        """Send or edit the live card message.

        Builds a card via build_streaming_card, using the current tool_lines
        and closed state to determine title and template colour.
        """
        if not text.strip() and not self._tool_lines:
            return

        # Determine card title and template based on state
        if self._closed:
            title = "MateBot \u2705"      # MateBot ✅
            template = "green"
        elif self._tool_lines:
            title = "MateBot \u2699\ufe0f"  # MateBot ⚙️
            template = "blue"
        else:
            title = "MateBot"
            template = "blue"

        card = build_streaming_card(
            text=text,
            title=title,
            template=template,
            tool_lines=self._snapshot_tool_lines(),
        )

        if self._live_msg_id is None:
            msg_id = send_card_message(self.token_mgr, self.chat_id, card)
            if msg_id:
                self._live_msg_id = msg_id
        else:
            edit_card_message(self.token_mgr, self._live_msg_id, card)