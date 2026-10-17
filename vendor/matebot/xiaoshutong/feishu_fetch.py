#!/usr/bin/env python3
"""小书童数据抓取：增量拉取用户飞书聊天记录 → SQLite + latest.md。

每次运行拉取最近 fetch_hours 小时（首跑回填 initial_backfill_hours）所有会话的
文本消息，写入 data/messages.db；并生成 data/latest.md 供 agent（LLM）阅读。

用法:
    python3 feishu_fetch.py                 # 用默认窗口
    python3 feishu_fetch.py --hours 2       # 指定窗口
    python3 feishu_fetch.py --full          # 强制回填 initial_backfill_hours
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import ensure_config_exists, load_config
from feishu_user_api import (
    UserTokenManager,
    list_chat_members,
    list_chats,
    message_mentions,
    parse_message_text,
    read_messages,
    search_messages,
    sender_name,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("feishu_fetch")

CN_TZ = timezone(timedelta(hours=8))
DB_NAME = "messages.db"
CURSOR_FILE = "last_run.txt"
LATEST_FILE = "latest.md"


# ── SQLite ──────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    message_id  TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL,
    chat_name   TEXT,
    sender_id   TEXT,
    sender_name TEXT,
    text        TEXT,
    msg_type    TEXT DEFAULT 'text',
    received_at INTEGER,          -- epoch ms
    fetched_at  INTEGER,
    at_me       INTEGER DEFAULT 0 -- 1 = @了我 或提到了我的别名
);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

-- open_id → 显示名。消息 API 不返回发送者名字，没有这张表「提出人」列
-- 就只能填 open_id，报告里看起来像 ou_405eac73ea 这种乱码。
CREATE TABLE IF NOT EXISTS users (
    open_id    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    updated_at INTEGER
);
"""

# 消息里出现这些词，视为点名到用户本人（除了 @ 之外的第二种判定）
ME_ALIASES = ("ares", "aresyang", "杨阳")


def init_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    # 老库没有 at_me 列，补上（CREATE TABLE IF NOT EXISTS 不会改已有表）
    existing = {r[1] for r in conn.execute("PRAGMA table_info(messages)")}
    if "at_me" not in existing:
        conn.execute("ALTER TABLE messages ADD COLUMN at_me INTEGER DEFAULT 0")
        conn.commit()
    return conn


# ── 名字缓存 ────────────────────────────────────────────────


def save_names(conn: sqlite3.Connection, people: List[Dict[str, str]]) -> int:
    """写入/更新 open_id → 名字映射。"""
    now = int(time.time())
    rows = [
        (p["open_id"], p["name"], now)
        for p in people
        if p.get("open_id") and p.get("name")
    ]
    if not rows:
        return 0
    conn.executemany(
        "INSERT INTO users (open_id, name, updated_at) VALUES (?,?,?) "
        "ON CONFLICT(open_id) DO UPDATE SET name=excluded.name, "
        "updated_at=excluded.updated_at",
        rows,
    )
    conn.commit()
    return len(rows)


def load_names(conn: sqlite3.Connection) -> Dict[str, str]:
    return {
        open_id: name
        for open_id, name in conn.execute("SELECT open_id, name FROM users")
    }


def refresh_chat_members(tm, conn: sqlite3.Connection, chats: List[Dict[str, Any]]) -> int:
    """把所有被监控会话的成员名字灌进缓存。

    只在缓存里缺人时才值得跑全量，但成员接口很便宜（每会话 1-2 次请求），
    每轮刷一次可以顺带跟上改名和新成员。
    """
    total = 0
    for chat in chats:
        cid = chat.get("chat_id", "")
        if not cid:
            continue
        try:
            total += save_names(conn, list_chat_members(tm, cid))
        except Exception as e:
            log.debug("拉取 %s 成员失败: %s", cid, e)
    return total


def mentions_me(item: Dict[str, Any], text: str, me_open_id: str) -> bool:
    """这条消息是不是点名到我。

    两种判定，够用就行：@ 到我的 open_id，或正文里出现我的别名
    （ares / aresyang / 杨阳）。
    """
    if me_open_id:
        for m in message_mentions(item):
            if m.get("open_id") == me_open_id:
                return True
            # 缺 contact 权限时 mention 的 id 会退化成 @_user_N 掩码，匹配不到
            # open_id；但 name 往往还在 —— 名字里含我的别名也算点名到我。
            if any(alias in (m.get("name") or "").lower() for alias in ME_ALIASES):
                return True
    low = text.lower()
    return any(alias in low for alias in ME_ALIASES)


def insert_messages(
    conn: sqlite3.Connection,
    msgs: List[Dict[str, Any]],
    chat: Dict[str, Any],
    me_open_id: str = "",
) -> int:
    rows = []
    now = int(time.time() * 1000)
    chat_name = chat.get("name") or chat.get("chat_id", "")
    for it in msgs:
        body = it.get("body", {})
        msg_type = it.get("msg_type") or body.get("msg_type") or "text"
        text = parse_message_text(it)
        if not text.strip():
            continue
        # mentions 是少数带 name 的字段，顺手把名字喂进缓存
        save_names(conn, message_mentions(it))
        create_ts = it.get("create_time")
        # 消息列表 API 的 create_time 是毫秒；normalize 的搜索项传的是秒。
        # 统一转毫秒：>=1e12 视为已毫秒，<1e12 视为秒。
        try:
            received_at = int(float(create_ts)) if create_ts else now
            if received_at < 10**12:
                received_at *= 1000
        except (TypeError, ValueError):
            received_at = now
        sender = it.get("sender", {}) or {}
        rows.append((
            it.get("message_id", ""),
            it.get("chat_id") or chat.get("chat_id", ""),
            chat_name,
            sender.get("id", "") or "",
            sender_name(it),
            text,
            msg_type,
            received_at,
            now,
            1 if mentions_me(it, text, me_open_id) else 0,
        ))
    if not rows:
        return 0
    conn.executemany(
        "INSERT OR IGNORE INTO messages "
        "(message_id, chat_id, chat_name, sender_id, sender_name, text, msg_type, received_at, fetched_at, at_me) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.commit()
    return len(rows)


# ── 游标 ────────────────────────────────────────────────────


def get_last_run(data_dir: Path) -> Optional[int]:
    """返回上次运行时间（epoch ms），无记录返回 None。"""
    p = data_dir / CURSOR_FILE
    if not p.exists():
        return None
    try:
        return int(p.read_text().strip())
    except (ValueError, OSError):
        return None


def set_last_run(data_dir: Path, ts_ms: int) -> None:
    (data_dir / CURSOR_FILE).write_text(str(ts_ms))


# ── 会话过滤 ────────────────────────────────────────────────


def filter_chats(cfg, chats: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not cfg.chat_filters_enabled:
        return chats[: cfg.max_chats]
    out = []
    for c in chats:
        name = c.get("name") or ""
        if cfg.exclude_keywords and any(k in name for k in cfg.exclude_keywords):
            continue
        if cfg.include_keywords and not any(k in name for k in cfg.include_keywords):
            continue
        out.append(c)
        if len(out) >= cfg.max_chats:
            break
    return out


# ── 搜索挖掘回退（当读消息缺权限时用关键词搜索补数据）──────

MINING_KEYWORDS = [
    "排期", "风险", "截止", "上线", "需求", "承诺", "交付", "延期",
    "下周", "明天", "尽快", "接口", "方案", "review", "客户", "版本",
    "转岗", "请假", "依赖", "隐患", "待办",
]


def normalize_search_item(item: Dict[str, Any]) -> Dict[str, Any]:
    """搜索 API 结果 → insert_messages 兼容的消息 dict。

    搜索返回结构: {id, display_info, meta_data:{chat_id, create_time(ISO8601), from_id, type}}
    display_info 含 HTML 标签与实体，需清理。
    """
    import html as _html

    meta = item.get("meta_data") or {}
    text = (item.get("display_info") or "").strip()
    text = _html.unescape(text)              # &amp; → &
    text = re.sub(r"<[^>]+>", "", text)      # 去掉 <pi> <asl-style> 等标签
    text = re.sub(r"\s+", " ", text).strip()  # 折叠空白
    create = meta.get("create_time", "")
    received_ms = int(time.time() * 1000)
    if create:
        try:
            dt = datetime.fromisoformat(create.replace("Z", "+00:00"))
            received_ms = int(dt.timestamp() * 1000)
        except (ValueError, TypeError):
            pass
    from_id = meta.get("from_id", "")
    return {
        "message_id": item.get("id") or meta.get("message_id", ""),
        "chat_id": meta.get("chat_id", ""),
        "sender": {"id": from_id},
        "msg_type": (meta.get("type") or "text").lower(),
        "create_time": str(int(received_ms / 1000)),  # 秒（insert 内部转毫秒）
        "body": {"content": json.dumps({"text": text}, ensure_ascii=False)},
    }


def search_mine(tm, since_ms: int, now_ms: int) -> List[Dict[str, Any]]:
    """用关键词搜索挖掘聊天记录（去重）。"""
    seen: set = set()
    out: List[Dict[str, Any]] = []
    for kw in MINING_KEYWORDS:
        try:
            results = search_messages(
                tm, kw, start_ts_ms=since_ms, end_ts_ms=now_ms, max_items=15
            )
        except Exception as e:
            log.debug("search '%s' 失败: %s", kw, e)
            continue
        for it in results:
            mid = it.get("id") or (it.get("meta_data") or {}).get("message_id")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            out.append(it)
        if len(out) >= 300:
            break
    log.info("搜索挖掘: %d 条命中", len(out))
    return out


# ── latest.md 生成 ─────────────────────────────────────────


def display_name(names: Dict[str, str], sender_id: str, stored_name: str) -> str:
    """open_id → 人类可读的发言人；查不到名字就留空白。

    报告里「涉及人/提出人」列查不到名字要留空白，不写 `未知同事(ou_xxx)`、
    更不写裸 `ou_...` —— 空白就是空白，别拿乱码冒充人名。
    """
    name = names.get(sender_id) or (stored_name or "").strip()
    if name and not name.startswith("ou_"):
        return name
    return ""


def build_latest_md(cfg, conn: sqlite3.Connection, since_ms: int, now_ms: int,
                    p2p_chat_ids: Optional[set] = None) -> str:
    """生成 latest.md。

    只保留与用户相关的消息：点名到我(at_me=1) / 我发的 / p2p 私聊 / 文本含
    `@_user_` 掩码提及（缺 contact 权限时 @ 会退化成 @_user_N，这类点名值得浮出）。
    其余泛泛讨论不进入快照 —— agent 就不会把它们记进报告。
    """
    me_open_id = getattr(cfg, "_me_open_id", "") or ""
    p2p = p2p_chat_ids or set()
    in_clause = "chat_id IN (%s)" % ",".join("?" * len(p2p)) if p2p else "1=0"
    sql = (
        "SELECT chat_id, chat_name, sender_id, sender_name, text, received_at, at_me "
        "FROM messages WHERE received_at >= ? AND received_at <= ? "
        "AND (at_me = 1 OR sender_id = ? OR " + in_clause +
        " OR text LIKE '%@\\_user\\_%' ESCAPE '\\') "
        "ORDER BY received_at ASC"
    )
    params = (since_ms, now_ms, me_open_id) + tuple(sorted(p2p))
    rows = conn.execute(sql, params).fetchall()

    names = load_names(conn)

    # 按会话分组，保持时间顺序
    chats: Dict[str, Dict[str, Any]] = {}
    for chat_id, chat_name, sender_id, sender_name_, text, received_at, at_me in rows:
        g = chats.setdefault(chat_id, {"name": chat_name or chat_id, "msgs": []})
        g["msgs"].append((received_at, sender_id, sender_name_, text, at_me))

    lines: List[str] = []
    since_str = datetime.fromtimestamp(since_ms / 1000, CN_TZ).strftime("%H:%M")
    now_str = datetime.fromtimestamp(now_ms / 1000, CN_TZ).strftime("%H:%M")
    lines.append("# 聊天记录快照")
    lines.append(f"> 抓取窗口: {since_str} - {now_str} | 会话数: {len(chats)} | 消息数: {len(rows)}")
    lines.append("> 行格式: `HH:MM · 发言人: 内容`，`【@我】` 表示这条点名到了我本人")
    lines.append("> 已过滤：只收录「点名到我 / 我发的 / 私聊 / 含@提及」的消息，泛泛讨论不分析")
    lines.append("")

    for chat_id, g in sorted(chats.items(), key=lambda kv: kv[1]["msgs"][0][0]):
        lines.append(f"## {g['name']}  (chat_id: {chat_id})")
        for received_at, sender_id, sender_name_, text, at_me in g["msgs"]:
            t = datetime.fromtimestamp(received_at / 1000, CN_TZ).strftime("%H:%M")
            is_me = bool(me_open_id and sender_id == me_open_id)
            who = "我" if is_me else display_name(names, sender_id, sender_name_)
            # 我自己发的消息不需要标 @我；名字查不到就留空白
            tag = " 【@我】" if (at_me and not is_me) else ""
            speaker = f"{who}{tag}".strip()
            # 单行折叠，避免 markdown 表格被换行打乱
            text_one = text.replace("\n", " ").replace("|", "\\|").strip()
            if speaker:
                lines.append(f"> {t} · {speaker}: {text_one}")
            else:
                lines.append(f"> {t}: {text_one}")
        lines.append("")

    md = "\n".join(lines)
    (cfg.data_dir / LATEST_FILE).write_text(md, "utf-8")
    return md


# ── 主流程 ──────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description="小书童聊天记录抓取")
    parser.add_argument("--hours", type=float, default=None, help="抓取最近 N 小时")
    parser.add_argument("--full", action="store_true", help="强制回填 initial_backfill_hours")
    args = parser.parse_args()

    ensure_config_exists()
    cfg = load_config()
    if not cfg.feishu_app_id or not cfg.feishu_app_secret:
        log.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量")
        return 1
    cfg.ensure_dirs()
    cfg._me_open_id = ""  # 占位，下面填充

    tm = UserTokenManager(cfg.feishu_app_id, cfg.feishu_app_secret, cfg.token_file)
    try:
        me_open_id = tm.open_id
    except RuntimeError as e:
        log.error("%s", e)
        return 1
    cfg._me_open_id = me_open_id

    now_ms = int(time.time() * 1000)
    last_run = get_last_run(cfg.data_dir)
    if args.full or last_run is None:
        window_hours = args.hours or cfg.initial_backfill_hours
        since_ms = now_ms - int(window_hours * 3600 * 1000)
        log.info("首跑/强制回填: 最近 %.1f 小时", window_hours)
    elif args.hours:
        # 手动指定窗口：从 now - N 小时回填（覆盖游标）
        since_ms = now_ms - int(args.hours * 3600 * 1000)
        log.info("手动回填: 最近 %.1f 小时", args.hours)
    else:
        # 严格增量：从上次游标开始，但窗口不超过 fetch_hours —— 游标太老（比如
        # 昨天）时最多回溯 fetch_hours 小时，昨天的旧消息不进窗口占位。
        since_ms = max(last_run, now_ms - int(cfg.fetch_hours * 3600 * 1000))
        log.info("增量抓取: %s → %s",
                 datetime.fromtimestamp(since_ms / 1000, CN_TZ).strftime("%Y-%m-%d %H:%M"),
                 datetime.fromtimestamp(now_ms / 1000, CN_TZ).strftime("%Y-%m-%d %H:%M"))

    # 1. 列会话
    log.info("列取用户会话...")
    try:
        chats = list_chats(tm)
    except Exception as e:
        log.error("list_chats 失败: %s", e)
        return 1
    chats = filter_chats(cfg, chats)
    log.info("监控 %d 个会话", len(chats))
    if not chats:
        log.warning("无可监控会话，请检查 im:chat:read 权限与 filter 配置")
        return 1

    # 2. 逐会话拉消息
    conn = init_db(cfg.data_dir / DB_NAME)

    # 2a. 先补名字缓存 —— 消息 API 不返回发送者名字，没有这一步「提出人」
    #     列只能填 open_id。
    refresh_chat_members(tm, conn, chats)
    log.info("名字缓存: %d 人", len(load_names(conn)))

    total = 0
    chat_stats: List[str] = []
    perm_blocked = False
    for chat in chats:
        cid = chat.get("chat_id", "")
        name = chat.get("name") or cid
        try:
            msgs = read_messages(tm, cid, since_ms, now_ms)
        except PermissionError as e:
            perm_blocked = True
            log.warning("读取会话 %s 缺权限（回退搜索挖掘）: %s", name, e)
            continue
        except Exception as e:
            log.warning("读取会话 %s 失败: %s", name, e)
            continue
        n = insert_messages(conn, msgs, chat, me_open_id)
        if n:
            chat_stats.append(f"{name}: {n} 条")
        total += n
        log.info("  %s: %d 条新消息", name, n)

    # 2b. 回退：读消息缺权限时用关键词搜索补数据（搜索接口可用当前 token）
    if perm_blocked or total == 0:
        log.info("使用搜索挖掘回退...")
        chat_name_map = {
            c.get("chat_id", ""): (c.get("name") or c.get("chat_id", ""))
            for c in chats
        }
        mined = search_mine(tm, since_ms, now_ms)
        for it in mined:
            norm = normalize_search_item(it)
            norm_chat = {
                "chat_id": norm["chat_id"],
                "name": chat_name_map.get(norm["chat_id"], "关键词命中"),
            }
            if insert_messages(conn, [norm], norm_chat, me_open_id):
                total += 1
        if total:
            chat_stats.append(f"搜索命中: {total} 条")

    # 3. 生成 latest.md
    p2p_ids = {c.get("chat_id") for c in chats if c.get("chat_type") == "p2p"}
    md = build_latest_md(cfg, conn, since_ms, now_ms, p2p_ids)
    conn.close()
    set_last_run(cfg.data_dir, now_ms)

    print(f"✔ 抓取完成: 共 {total} 条消息 / {len(chat_stats)} 个会话")
    if chat_stats:
        print("   " + "; ".join(chat_stats[:20]))
    print(f"✔ 快照写入: {cfg.data_dir / LATEST_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
