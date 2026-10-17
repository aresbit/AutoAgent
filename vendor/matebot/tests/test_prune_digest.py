#!/usr/bin/env python3
"""Unit tests for the per-day digest in scripts/prune_transcripts.py.

No CLI, no tokens:

    python3 tests/test_prune_digest.py

What they guard, and why:

  A. Machine-injected turns never reach the digest. Regression: 97% of the
     `user` records in a real 100MB transcript were `<task-notification>`
     plumbing, so an unfiltered digest buries the 3% a human actually said.

  B. Only prose survives — thinking and tool_use blocks are the agent's
     internals and would drown the flow they are supposed to summarize.

  C. Sub-agent records (isSidechain) stay out of the main-line flow.

  D. Days group by *local* time, or a UTC-evening turn lands on tomorrow.

  E. merge_digest_into is idempotent and never eats hand-written content —
     it has to be safe to put in a cron job next to a live memory file.

  F. Already-archived .gz transcripts can be digested without unpacking.
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import prune_transcripts as P  # noqa: E402


def record(kind: str, content, when: str, sidechain: bool = False) -> str:
    return json.dumps({
        "type": kind,
        "timestamp": when,
        "isSidechain": sidechain,
        "message": {"content": content},
    }) + "\n"


def local_day(iso_utc: str) -> str:
    parsed = datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    return parsed.astimezone().strftime("%Y-%m-%d")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="matebot-digest-"))
    failures = 0

    def check(label: str, actual, want) -> None:
        nonlocal failures
        ok = want(actual) if callable(want) else actual == want
        print(f"  {'PASS' if ok else 'FAIL'}  {label}: {actual!r}")
        if not ok:
            failures += 1

    src = tmp / "t.jsonl"
    src.write_text("".join([
        record("user", "<task-notification>\n<task-id>abc</task-id>", "2026-08-06T01:00:00Z"),
        record("user", "继续训练", "2026-08-06T01:01:00Z"),
        record("user", "<system-reminder>noise</system-reminder>真正的问题", "2026-08-06T01:02:00Z"),
        record("assistant", [
            {"type": "thinking", "thinking": "internal"},
            {"type": "tool_use", "name": "Bash", "input": {}},
            {"type": "text", "text": "训练已重启"},
        ], "2026-08-06T01:03:00Z"),
        record("assistant", [{"type": "text", "text": "子 agent 的话"}],
               "2026-08-06T01:04:00Z", sidechain=True),
        record("user", [{"type": "tool_result", "content": "output"}], "2026-08-06T01:05:00Z"),
        record("assistant", [{"type": "text", "text": "重复"}], "2026-08-06T01:06:00Z"),
        record("assistant", [{"type": "text", "text": "重复"}], "2026-08-06T01:06:00Z"),
    ]), encoding="utf-8")

    day = local_day("2026-08-06T01:00:00Z")
    got = P.extract_daily_digest(src)
    bullets = got.get(day, [])
    joined = "\n".join(bullets)

    print("A. 机器注入被滤掉")
    check("task-notification", "task-notification" in joined, False)
    check("system-reminder 内容", "noise" in joined, False)
    check("剥壳后的真人文本保留", "真正的问题" in joined, True)

    print("B. 只留正文")
    check("thinking 不进流水", "internal" in joined, False)
    check("tool_use 不进流水", "Bash" in joined, False)
    check("tool_result 不进流水", "output" in joined, False)
    check("assistant 正文保留", "训练已重启" in joined, True)

    print("C. 子 agent 不进主线")
    check("isSidechain", "子 agent 的话" in joined, False)

    print("D. 连续重复只留一条")
    check("重复条数", joined.count("重复"), 1)

    print("E. 按本地日期分组")
    check("只有一天", sorted(got), [day])
    check("条数", len(bullets), 4)

    print("F. merge_digest_into 幂等且不吃人工内容")
    target = tmp / f"{day}.md"
    target.write_text("# 手写的\n\n- 我自己记的一条\n", encoding="utf-8")
    body = P.render_digest(day, bullets, "sess-1", str(src))
    P.merge_digest_into(target, body, "sess-1")
    once = target.read_text(encoding="utf-8")
    P.merge_digest_into(target, body, "sess-1")
    twice = target.read_text(encoding="utf-8")
    check("重跑不重复", once, twice)
    check("人工内容还在", "我自己记的一条" in twice, True)
    check("只有一个 BEGIN 标记", twice.count("<!-- BEGIN prune-digest sess-1 -->"), 1)

    print("G. 直接读 .gz")
    gz = tmp / "t.jsonl.gz"
    with gzip.open(gz, "wb") as fh:
        fh.write(src.read_bytes())
    check("gz 结果与明文一致", P.extract_daily_digest(gz), got)

    print(f"\n{'FAILED' if failures else 'ALL PASSED'} ({failures} failure(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
