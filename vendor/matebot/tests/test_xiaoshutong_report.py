#!/usr/bin/env python3
"""Offline tests for the 小书童 report pipeline. No network, no tokens.

    python3 tests/test_xiaoshutong_report.py

Each test pins one thing that was visibly wrong in a shipped report:

  * 「提出人」showed `ou_405eac73ea` — the messages API does not return sender
    names, and the old code fell back to a truncated open_id.
  * 「涉及人/提出人」showed `未知同事(ou_xxx)` — user wants a blank instead.
  * 「指派」was guessed by the LLM and got it wrong; @-mentions are now
    resolved during fetch and marked in latest.md.
  * The card grew a `1/2` pager because a table had more rows than Feishu's
    table component can show on one page — and it appended「另有 N 条见
    data/todos.md」, which the user explicitly does not want.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "xiaoshutong"))

import feishu_fetch as F  # noqa: E402
from feishu_send import build_report_cards  # noqa: E402

ME = "ou_me00000000000000000000000000000"


def _msg(mid, sender, text, mentions=None, ts=1754300000):
    return {
        "message_id": mid,
        "chat_id": "oc_chat1",
        "sender": {"id": sender},
        "msg_type": "text",
        "create_time": str(ts),
        "body": {"content": json.dumps({"text": text}, ensure_ascii=False)},
        "mentions": mentions or [],
    }


def _latest_md() -> str:
    tmp = Path(tempfile.mkdtemp(prefix="xst-test-"))
    conn = F.init_db(tmp / "m.db")
    F.save_names(conn, [
        {"open_id": "ou_405eac73ea11", "name": "薛老师"},
        {"open_id": ME, "name": "杨阳"},
    ])
    msgs = [
        # 点名到我 → 应浮出，且发送者显示真实姓名（薛老师），不是 open_id
        _msg("m1", "ou_405eac73ea11", "帮忙看下 abseil perf 集成",
             mentions=[{"key": "@_user_1", "id": {"open_id": ME}, "name": "杨阳"}]),
        # mentions 里 @ 杨阳（我）→ 【@我】
        _msg("m2", "ou_405eac73ea11", "@杨阳 这个 jira 自动化谁跟？",
             mentions=[{"key": "@_user_1", "id": {"open_id": ME}, "name": "杨阳"}]),
        # 掩码提及 @_user_1 → 值得浮出；发送者查不到名字 → 留空白
        _msg("m3", "ou_unknown999999", "72#机器人 pad 有问题 @_user_1"),
        # 我自己发的 → 显示「我」，不标 @我
        _msg("m4", ME, "我来跟 GitLab 绿区管控"),
        # 正文含别名 aresyang → 点名到我，发送者未知 → 留空白 + 【@我】
        _msg("m5", "ou_newguy0001", "aresyang 看下这个包"),
        # 泛泛讨论、没人被点名 → 不进快照
        _msg("m6", "ou_405eac73ea11", "今天联调顺利没有新问题"),
    ]
    F.insert_messages(conn, msgs, {"chat_id": "oc_chat1", "name": "AWR交付群"}, ME)

    class Cfg:
        data_dir = tmp
        _me_open_id = ME

    return F.build_latest_md(Cfg(), conn, 0, 9_999_999_999_999)


def _line(md: str, needle: str) -> str:
    return next(l for l in md.splitlines() if needle in l)


def test_sender_names_resolve() -> None:
    print("A. 提出人显示真实姓名，不是 open_id")
    md = _latest_md()
    assert "薛老师" in md, "会话成员名字缓存没生效"
    speaker = _line(md, "abseil").split(":")[0]
    assert "ou_" not in speaker, f"open_id 冒充人名: {speaker!r}"
    assert "· 我:" in md, "本人未识别为「我」"
    print("    ✅", _line(md, "abseil").strip())


def test_unresolved_is_blank() -> None:
    print("B. 查不到名字的留空白，不写 未知同事(ou_xxx)")
    md = _latest_md()
    assert "未知同事" not in md, "unknown 不应写成 未知同事(...)"
    line = _line(md, "72#")
    # 发送者未知 → 发言人为空 → 行里直接是 `> HH:MM: 内容`，没有「· 名字」
    assert "· " not in line.split("72#")[0], f"未知发送者被塞了名字: {line!r}"
    print("    ✅", line.strip())


def test_at_me_detection() -> None:
    print("C. @我 在抓取阶段判定，不留给 LLM 猜")
    md = _latest_md()
    assert "【@我】" in _line(md, "jira"), "mentions 里 @ 我未标记"
    assert "【@我】" in _line(md, "aresyang"), "别名点名未标记"
    assert "【@我】" not in _line(md, "GitLab"), "自己发的消息不该标 @我"
    print("    ✅ mentions + 别名(ares/aresyang/杨阳) 都命中，自发消息不误标")


def test_snapshot_only_keeps_relevant() -> None:
    print("C2. latest.md 只保留相关消息，泛泛讨论不进快照")
    md = _latest_md()
    assert "联调顺利" not in md, "没人被点名的泛泛讨论不该进快照"
    assert "72#" in md, "掩码提及 @_user_1 应浮出"
    print("    ✅ 无点名的消息被滤掉")


def test_table_never_paginates_and_no_overflow_note() -> None:
    print("D. 表格不分页，且不出现「另有 N 条见 data/todos.md」")
    rows = "\n".join(
        f"| ① | 事项{i}（点名我） | 薛老师 | 1{i % 10}:0{i % 10} | ⬜ |"
        for i in range(14)
    )
    md = (
        "## 一、新增待办\n\n"
        "| 类别 | 事项 | 提出人 | 时间 | 进度 |\n|---|---|---|---|---|\n"
        + rows
    )
    cards = build_report_cards(md, "小书童")
    tables = [
        el for card in cards for el in card["body"]["elements"]
        if el["tag"] == "table"
    ]
    assert len(tables) == 1
    table = tables[0]
    assert [c["display_name"] for c in table["columns"]] == [
        "类别", "事项", "提出人", "时间", "进度"
    ], "列定义漂了"
    assert len(table["rows"]) <= table["page_size"], (
        f"{len(table['rows'])} 行 > page_size {table['page_size']}，卡片会出现翻页"
    )
    notes = [
        el["content"] for card in cards for el in card["body"]["elements"]
        if el["tag"] == "markdown" and "另有" in el["content"]
    ]
    assert not notes, f"不应出现「另有 N 条」提示: {notes}"
    print(f"    ✅ 10 行封顶，无「另有 N 条」提示")


def main() -> int:
    test_sender_names_resolve()
    test_unresolved_is_blank()
    test_at_me_detection()
    test_snapshot_only_keeps_relevant()
    test_table_never_paginates_and_no_overflow_note()
    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
