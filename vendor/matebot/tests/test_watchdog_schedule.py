#!/usr/bin/env python3
"""Unit tests for the watchdog's schedule arithmetic (feishu_bridge._due_slots).

No bridge, no CLI, no tokens:

    python3 tests/test_watchdog_schedule.py

The watchdog used to ask "is it exactly 09:00 right now?", which gave each
scheduled restart a 60-second window. Two ways that lost a whole day:

  * `time.sleep(60)` plus loop-body time drifts, so a given minute value may
    never be observed at all;
  * if the session happened to be mid-turn during that minute the loop
    `continue`d, and by the next tick the minute no longer matched.

Missing a day meant the transcript kept appending for another day — that is how
one session reached 100MB over 33 days. `_due_slots` reframes it as "which
scheduled points have passed", so a missed point stays pending until the session
is idle enough to act on it.

What these guard:

  A. Points that have not arrived yet are not due.
  B. A point stays due after its minute passes (the actual fix).
  C. Yesterday's evening point is still visible after midnight.
  D. Ordering is chronological, so "the last one fired" is well-defined.
  E. Catching up spans every point that was skipped — needed so a missed 09:00
     rotation still rotates when it is caught up at 12:50.
  F. A malformed time string is ignored rather than killing the watchdog.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from feishu_bridge import _due_slots  # noqa: E402

TIMES = ["09:00", "12:50", "18:30"]
ROTATE = {"09:00"}


def hm_today(slots, day: str) -> list[str]:
    return [hm for when, hm in slots if when.strftime("%Y-%m-%d") == day]


def main() -> int:
    failures = 0

    def check(label: str, actual, want) -> None:
        nonlocal failures
        ok = want(actual) if callable(want) else actual == want
        print(f"  {'PASS' if ok else 'FAIL'}  {label}: {actual!r}")
        if not ok:
            failures += 1

    print("A. 未到点的不算 due")
    at_0859 = _due_slots(datetime(2026, 9, 8, 8, 59), TIMES)
    check("09-08 08:59 今天已到点", hm_today(at_0859, "2026-09-08"), [])

    print("B. 过了那一分钟依然 due（本次修复的核心）")
    at_0900 = _due_slots(datetime(2026, 9, 8, 9, 0), TIMES)
    at_0931 = _due_slots(datetime(2026, 9, 8, 9, 31), TIMES)
    check("09:00 整", hm_today(at_0900, "2026-09-08"), ["09:00"])
    check("09:31 仍然待办", hm_today(at_0931, "2026-09-08"), ["09:00"])

    print("C. 跨零点仍看得到昨天的点")
    at_0030 = _due_slots(datetime(2026, 9, 8, 0, 30), TIMES)
    check("昨天三个点都在", hm_today(at_0030, "2026-09-07"), TIMES)
    check("今天还没有", hm_today(at_0030, "2026-09-08"), [])

    print("D. 按时间升序")
    times = [w for w, _ in at_0931]
    check("有序", times == sorted(times), True)
    check("最后一个是最近的", at_0931[-1][1], "09:00")

    print("E. 补执行覆盖被跳过的每一个点")
    # 会话在 09:00 正忙被跳过，直到 13:00 才空闲：last_slot 还停在昨天 18:30。
    last = datetime(2026, 9, 7, 18, 30).isoformat()
    at_1300 = _due_slots(datetime(2026, 9, 8, 13, 0), TIMES)
    pending = [(w, hm) for w, hm in at_1300 if w.isoformat() > last]
    check("待办点", [hm for _, hm in pending], ["09:00", "12:50"])
    check(
        "补执行时仍然轮转（09:00 在里面）",
        any(hm in ROTATE for _, hm in pending),
        True,
    )
    # 对照：旧逻辑只看当前分钟 13:00，既不匹配任何点，也就永远补不上。
    check("旧逻辑此刻命中数", sum(1 for t in TIMES if t == "13:00"), 0)

    print("F. 配错的时刻被忽略而不是炸掉看门狗")
    bad = _due_slots(datetime(2026, 9, 8, 13, 0), ["09:00", "呵呵", "25:99", ""])
    check("只留合法的", sorted({hm for _, hm in bad}), ["09:00"])

    print(f"\n{'FAILED' if failures else 'ALL PASSED'} ({failures} failure(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
