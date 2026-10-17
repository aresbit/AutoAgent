"""Wall clock implementation used by the composition root."""

from __future__ import annotations

import time


class SystemClock:
    """``ClockPort`` backed by the system wall clock."""

    def now_ms(self) -> int:
        return int(time.time() * 1000)
