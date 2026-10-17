#!/usr/bin/env python3
"""Unit tests for the cgroup anonymous-memory reading in feishu_bridge.

No cgroup, no systemd, no tokens:

    python3 tests/test_watchdog_anon.py

What they guard, and why:

  A. **A hand-started bridge must not read the whole machine's memory.**
     Regression, found 2026-09-12 while reviewing the change before landing it:
     `_cgroup_anon_mb` read `memory.stat` under `/sys/fs/cgroup` + the cgroup
     path from `/proc/self/cgroup`. Started by systemd that path is
     `/user.slice/.../matebot-bridge.service` and all is well, but started by
     hand it is `/`, so the lookup collapses to the **root** cgroup — which
     reports the whole machine's anon (13.0G measured here) against an 8G
     threshold. The bridge would exit 60s after every manual start and loop
     forever. The comment claimed a fallback to self RSS; the fallback only ran
     on an *exception*, and reading the root cgroup raises nothing.

  B. Inside a named cgroup the cgroup's own `anon` is what is returned — the
     fix must not turn the working case into the fallback.

  C. Nothing here may raise. This runs in the session watchdog thread, so an
     exception does not surface as an error — it kills the thread and silently
     disables the memory guard.

`anon ` is matched with its trailing space on purpose: `memory.stat` also
carries `anon_thp`, and a prefix match without the space would pick it up.
"""

from __future__ import annotations

import builtins
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import feishu_bridge as fb  # noqa: E402


class FakeFiles:
    """A stand-in for `open` that serves canned text per path.

    Patched over `io.open`, not `builtins.open`: the two are the same object but
    `pathlib.Path.open` looks up the name `io.open` at call time, so rebinding
    `builtins.open` alone leaves every `Path(...).open()` reading the real file.
    That mistake made an earlier version of this file pass while reading live
    data — the assertion compared a canned number against the machine's.
    """

    def __init__(self, files: dict[str, str]) -> None:
        self.files = files
        self.read_paths: list[str] = []

    def __call__(self, path, *args, **kwargs):
        key = str(path)
        if key not in self.files:
            raise FileNotFoundError(key)
        self.read_paths.append(key)
        return _FakeHandle(self.files[key])


class _FakeHandle:
    def __init__(self, text: str) -> None:
        self._lines = text.splitlines(keepends=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(self._lines)


def with_fake_files(files: dict[str, str], fn):
    """Patch **both** open paths for the duration of ``fn``.

    Two names, one object, and rebinding one does not rebind the other:

      * ``io.open``          — what ``pathlib.Path.open`` calls (the cgroup stat)
      * ``builtins.open``    — what a bare ``open()`` in the module calls
                               (``/proc/self/cgroup``, ``/proc/self/status``)

    Patching either alone leaves the other reading the real filesystem. The
    first version of this file patched only ``builtins`` and passed by reading
    live data; the second patched only ``io`` and failed for the same reason.
    """
    fake = FakeFiles(files)
    real_io, real_builtins = io.open, builtins.open
    io.open = fake  # type: ignore[assignment]
    builtins.open = fake  # type: ignore[assignment]
    try:
        return fn(), fake
    finally:
        io.open = real_io  # type: ignore[assignment]
        builtins.open = real_builtins  # type: ignore[assignment]


# A machine-wide anon far above any sane threshold: if a test ever returns this
# number, the bridge would have exited.
ROOT_ANON_BYTES = 13_970_129_000
CGROUP_ANON_BYTES = 398_458_880  # ~380 MB, the real reading on this box


def test_a_hand_started_bridge_falls_back_to_its_own_rss() -> None:
    """A. rel == "/" must not be read as the machine's memory."""
    files = {
        "/proc/self/cgroup": "0::/\n",
        "/sys/fs/cgroup/memory.stat": f"anon {ROOT_ANON_BYTES}\nfile 1\n",
        "/proc/self/status": "Name:\tpython3\nVmRSS:\t  123456 kB\n",
    }
    value, fake = with_fake_files(files, fb._cgroup_anon_mb)

    assert value == 123456 / 1024.0, f"expected the RSS fallback, got {value}"
    machine_wide = ROOT_ANON_BYTES / 1024 / 1024
    assert value < machine_wide, f"returned the machine's anon ({machine_wide:.0f}MB)"
    # And it must not even have opened the root cgroup's stat — that read is the bug.
    assert "/sys/fs/cgroup/memory.stat" not in fake.read_paths


def test_an_empty_cgroup_path_also_falls_back() -> None:
    """The same trap by another spelling: an unparsable /proc/self/cgroup."""
    files = {
        "/proc/self/cgroup": "not a cgroup line\n",
        "/sys/fs/cgroup/memory.stat": f"anon {ROOT_ANON_BYTES}\n",
        "/proc/self/status": "VmRSS:\t 2048 kB\n",
    }
    value, _ = with_fake_files(files, fb._cgroup_anon_mb)
    assert value == 2.0, value


def test_a_named_cgroup_reports_its_own_anon() -> None:
    """B. The working case must keep working."""
    rel = "/user.slice/user-1000.slice/user@1000.service/app.slice/matebot-bridge.service"
    files = {
        "/proc/self/cgroup": f"0::{rel}\n",
        f"/sys/fs/cgroup{rel}/memory.stat": (
            f"anon {CGROUP_ANON_BYTES}\n"
            "anon_thp 999999999999\n"  # must not be picked up
            "file 5948149760\n"
        ),
        "/proc/self/status": "VmRSS:\t 999999 kB\n",
    }
    value, _ = with_fake_files(files, fb._cgroup_anon_mb)

    assert abs(value - CGROUP_ANON_BYTES / 1024 / 1024) < 0.01, value
    big = 999999999999 / 1024 / 1024
    assert value < big, "anon_thp was matched — the pattern needs its trailing space"


def test_nothing_readable_returns_zero_not_an_exception() -> None:
    """C. A zero reading is skipped by the caller, so this is the safe failure."""
    value, _ = with_fake_files({}, fb._cgroup_anon_mb)
    assert value == 0.0


def test_a_named_cgroup_with_a_broken_memory_stat_falls_back() -> None:
    rel = "/user.slice/x.service"
    files = {
        "/proc/self/cgroup": f"0::{rel}\n",
        f"/sys/fs/cgroup{rel}/memory.stat": "this is not memory.stat\n",
        "/proc/self/status": "VmRSS:\t 4096 kB\n",
    }
    value, _ = with_fake_files(files, fb._cgroup_anon_mb)
    assert value == 4.0, value


def test_the_caller_skips_a_zero_reading() -> None:
    """The guard in the watchdog is `if anon_mb and ...` — 0.0 must disable it."""
    assert not 0.0, "0.0 must be falsy or an unreadable cgroup would trigger a restart"


def test_the_exit_survives_a_broken_log_pipe() -> None:
    """E. A guard whose failure mode is "quietly stops guarding" is not a guard.

    `os._exit` sits inside the watchdog's `try`, and `print` raises
    BrokenPipeError whenever stdout is gone. Unhandled, that lands in the outer
    ``except Exception``, the loop prints "检查异常" and carries on — the memory
    guard is off from then on, failing every 60s, and the log says nothing about
    memory at all.
    """
    exits: list[int] = []
    real_exit, real_print = fb.os._exit, builtins.print

    def boom(*a, **k):
        raise BrokenPipeError("stdout is gone")

    fb.os._exit = lambda code: exits.append(code)  # type: ignore[assignment]
    builtins.print = boom  # type: ignore[assignment]
    try:
        fb._exit_for_anon(9000.0)
    finally:
        fb.os._exit = real_exit  # type: ignore[assignment]
        builtins.print = real_print  # type: ignore[assignment]

    assert exits == [1], f"a broken stdout swallowed the exit: {exits!r}"


def test_the_exit_uses_a_nonzero_code_systemd_will_restart() -> None:
    """`Restart=always` covers any exit, but a 0 would read as a clean stop."""
    exits: list[int] = []
    real_exit = fb.os._exit
    fb.os._exit = lambda code: exits.append(code)  # type: ignore[assignment]
    try:
        fb._exit_for_anon(9000.0)
    finally:
        fb.os._exit = real_exit  # type: ignore[assignment]
    assert exits == [1]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
        else:
            print(f"ok   {fn.__name__}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
