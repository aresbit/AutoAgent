#!/usr/bin/env python3
"""小书童结果发送：用 bot token 把 markdown 报告作为「飞书卡片」发给用户。

关键：飞书卡片的 text 元素不渲染 markdown；table 元素需要原生 table 组件。
本脚本把 markdown 报告拆分为 markdown 元素 + 原生 table 组件，保证表格真正渲染。
卡片用 JSON 2.0 结构（schema:"2.0" + body.elements）。

用法:
    cat result.md | python3 feishu_send.py
    python3 feishu_send.py --file result.md --title "小书童日报"
    python3 feishu_send.py --text "直接文本"
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

# 清除 socks/http 代理（httpx 不认 socks://，飞书 API 需直连；与 matebot 别名一致）
for _k in list(os.environ):
    if _k.lower().endswith("proxy"):
        os.environ.pop(_k, None)

_ROOT = Path(__file__).resolve().parent.parent  # MateBot/
sys.path.insert(0, str(_ROOT))

from feishu_api import TokenManager, send_card_message  # noqa: E402
from config import ensure_config_exists, load_config  # noqa: E402

MAX_LEN = 8000
MAX_TABLES_PER_CARD = 5

# 飞书 table 组件的 page_size 上限就是 10：行数一超，卡片右下角就出现 `1/2`
# 翻页控件，手机上很难用。所以宁可截断也不让它分页（用户明确不要「另有 N 条」提示）。
MAX_TABLE_ROWS = 10


# ── Markdown 表格解析 ───────────────────────────────────────


def _split_row(line: str) -> List[str]:
    """按未转义的 | 拆一行 markdown 表格，去掉首尾空单元格。"""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    cells: List[str] = []
    cur: List[str] = []
    i = 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            cur.append("|")
            i += 2
            continue
        if s[i] == "|":
            cells.append("".join(cur).strip())
            cur = []
            i += 1
            continue
        cur.append(s[i])
        i += 1
    cells.append("".join(cur).strip())
    return cells


def _is_table_header(line: str) -> bool:
    l = line.strip()
    return l.startswith("|") and "|" in l[1:]


def _is_table_separator(line: str) -> bool:
    l = line.strip()
    return l.startswith("|") and all(c in "-| :" for c in l)


def split_markdown_tables(text: str) -> List[Dict[str, str]]:
    """把 markdown 拆成交替的 markdown / table 片段。"""
    lines = text.split("\n")
    segs: List[Dict[str, str]] = []
    md_buf: List[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if (
            _is_table_header(line)
            and i + 1 < len(lines)
            and _is_table_separator(lines[i + 1])
        ):
            if md_buf:
                segs.append({"type": "markdown", "content": "\n".join(md_buf).strip()})
                md_buf = []
            table_lines = [line, lines[i + 1]]
            i += 2
            while i < len(lines) and _is_table_header(lines[i]):
                table_lines.append(lines[i])
                i += 1
            segs.append({"type": "table", "content": "\n".join(table_lines)})
            if i < len(lines) and not lines[i].strip():
                i += 1  # 跳过表格后的空行
        else:
            md_buf.append(line)
            i += 1
    if md_buf:
        segs.append({"type": "markdown", "content": "\n".join(md_buf).strip()})
    return [s for s in segs if s.get("content", "").strip()]


def md_table_to_feishu_table(md: str) -> tuple[Dict[str, Any], int]:
    """GFM 表格 → 飞书原生 table 组件（Card JSON 2.0）。

    返回 (table 元素, 被截掉的行数)。超过 MAX_TABLE_ROWS 的部分直接截掉，
    不补「另有 N 条」说明（用户明确不要这行字）。
    """
    lines = [l for l in (ln.strip() for ln in md.split("\n")) if l]
    header = _split_row(lines[0]) if lines else []
    rows = [_split_row(l) for l in lines[2:]]

    dropped = max(0, len(rows) - MAX_TABLE_ROWS)
    rows = rows[:MAX_TABLE_ROWS]

    columns = []
    for idx, h in enumerate(header):
        columns.append({
            "name": f"c{idx}",
            "display_name": h or f"列{idx + 1}",
            "data_type": "text",
            "horizontal_align": "left",
            "vertical_align": "center",
            "width": "auto",
        })
    feishu_rows = []
    for r in rows:
        row = {}
        for idx in range(len(header)):
            row[f"c{idx}"] = (r[idx] if idx < len(r) else "") or ""
        feishu_rows.append(row)

    return {
        "tag": "table",
        "page_size": MAX_TABLE_ROWS,
        "columns": columns,
        "rows": feishu_rows,
    }, dropped


# ── 卡片构建（JSON 2.0）────────────────────────────────────


def build_card_v2(title: str, elements: List[Dict[str, Any]], template: str = "blue") -> Dict[str, Any]:
    return {
        "schema": "2.0",
        "config": {"wide_screen_mode": True},
        "header": {
            "template": template,
            "title": {"tag": "plain_text", "content": title},
        },
        "body": {"elements": elements},
    }


def build_report_cards(md_text: str, title: str) -> List[Dict[str, Any]]:
    """markdown 报告 → 卡片列表（每卡最多 5 个 table 组件）。"""
    segs = split_markdown_tables(md_text)
    cards: List[Dict[str, Any]] = []
    elements: List[Dict[str, Any]] = []
    tables_in_card = 0

    def flush():
        nonlocal elements, tables_in_card
        if elements:
            cards.append(build_card_v2(title, elements))
        elements = []
        tables_in_card = 0

    for seg in segs:
        if seg["type"] == "markdown":
            elements.append({"tag": "markdown", "content": seg["content"]})
        else:
            if tables_in_card >= MAX_TABLES_PER_CARD:
                flush()
            table, _dropped = md_table_to_feishu_table(seg["content"])
            elements.append(table)
            tables_in_card += 1
    flush()
    if not cards:
        cards.append(build_card_v2(title, [{"tag": "markdown", "content": md_text}]))
    return cards


# ── 发送 ────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description="小书童结果发送（markdown → 卡片）")
    parser.add_argument("--file", help="读取文件内容（否则读 stdin）")
    parser.add_argument("--text", help="直接传文本")
    parser.add_argument("--title", default=None, help="卡片标题")
    args = parser.parse_args()

    ensure_config_exists()
    cfg = load_config()
    if not cfg.feishu_app_id or not cfg.feishu_app_secret:
        print("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量", file=sys.stderr)
        return 1
    chat_id = cfg.send_chat_id
    if not chat_id:
        print("缺少发送目标 chat_id（config.send_chat 或 FEISHU_CHAT_ID）",
              file=sys.stderr)
        return 1

    if args.text is not None:
        text = args.text
    elif args.file:
        text = Path(args.file).read_text("utf-8")
    else:
        text = sys.stdin.read()
    text = text.strip()
    if not text:
        print("空内容，不发送", file=sys.stderr)
        return 1
    if len(text) > MAX_LEN:
        print(f"内容过长（{len(text)} 字符），截断到 {MAX_LEN}", file=sys.stderr)
        text = text[:MAX_LEN]

    title = args.title or cfg.send_title
    cards = build_report_cards(text, title)
    tm = TokenManager(cfg.feishu_app_id, cfg.feishu_app_secret)
    sent = 0
    for card in cards:
        msg_id = send_card_message(tm, chat_id, card)
        if not msg_id:
            print("卡片发送失败", file=sys.stderr)
            return 1
        sent += 1
        print(f"✔ 已发送卡片 #{sent}: {msg_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
