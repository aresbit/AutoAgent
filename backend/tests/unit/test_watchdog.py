"""Parent-death watchdog: deterministic injected clock/trigger tests."""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.config import config_from_env
from autoagent_backend.watchdog import (
    ParentWatchdog,
    pid_is_alive,
    watchdog_from_config,
)


class FakeClock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def _trigger_counter() -> tuple[list[int], Callable[[], None]]:
    calls: list[int] = []

    def trigger() -> None:
        calls.append(1)

    return calls, trigger


def test_disabled_watchdog_does_not_start() -> None:
    calls, trigger = _trigger_counter()
    watchdog = ParentWatchdog(
        desktop_pid=None,
        heartbeat_path=None,
        trigger=trigger,
    )
    assert watchdog.enabled is False
    assert watchdog.start() is False
    assert watchdog.check_once() is False
    assert calls == []
    watchdog.stop()


def test_parent_gone_triggers_once() -> None:
    calls, trigger = _trigger_counter()
    watchdog = ParentWatchdog(
        desktop_pid=424242,
        heartbeat_path=None,
        trigger=trigger,
        pid_alive=lambda pid: False,
    )
    assert watchdog.check_once() is True
    assert calls == [1]
    assert watchdog.check_once() is True
    assert calls == [1], "shutdown must be idempotent"
    assert watchdog.triggered is True


def test_live_parent_does_not_trigger() -> None:
    calls, trigger = _trigger_counter()
    watchdog = ParentWatchdog(
        desktop_pid=424242,
        heartbeat_path=None,
        trigger=trigger,
        pid_alive=lambda pid: True,
    )
    assert watchdog.check_once() is False
    assert calls == []


def test_missing_heartbeat_triggers(tmp_path: Path) -> None:
    calls, trigger = _trigger_counter()
    watchdog = ParentWatchdog(
        desktop_pid=None,
        heartbeat_path=tmp_path / "missing.heartbeat",
        trigger=trigger,
        clock=FakeClock(1_700_000_000.0),
    )
    assert watchdog.check_once() is True
    assert calls == [1]


def test_stale_heartbeat_triggers(tmp_path: Path) -> None:
    heartbeat = tmp_path / "desktop.heartbeat"
    heartbeat.write_text("1", encoding="utf-8")
    base = 1_700_000_000.0
    os.utime(heartbeat, (base - 20.0, base - 20.0))
    calls, trigger = _trigger_counter()
    watchdog = ParentWatchdog(
        desktop_pid=None,
        heartbeat_path=heartbeat,
        trigger=trigger,
        heartbeat_timeout_s=15.0,
        clock=FakeClock(base),
    )
    assert watchdog.check_once() is True
    assert calls == [1]


def test_fresh_heartbeat_does_not_trigger(tmp_path: Path) -> None:
    heartbeat = tmp_path / "desktop.heartbeat"
    heartbeat.write_text("1", encoding="utf-8")
    base = 1_700_000_000.0
    os.utime(heartbeat, (base - 5.0, base - 5.0))
    calls, trigger = _trigger_counter()
    watchdog = ParentWatchdog(
        desktop_pid=None,
        heartbeat_path=heartbeat,
        trigger=trigger,
        heartbeat_timeout_s=15.0,
        clock=FakeClock(base),
    )
    assert watchdog.check_once() is False
    assert calls == []


def test_permission_error_means_process_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def denied(_pid: int, _sig: int) -> None:
        raise PermissionError

    monkeypatch.setattr("autoagent_backend.watchdog.os.kill", denied)
    assert pid_is_alive(1234) is True


def test_process_lookup_means_process_is_gone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def gone(_pid: int, _sig: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr("autoagent_backend.watchdog.os.kill", gone)
    assert pid_is_alive(1234) is False


def test_thread_fires_and_exits() -> None:
    fired = threading.Event()
    watchdog = ParentWatchdog(
        desktop_pid=424242,
        heartbeat_path=None,
        trigger=fired.set,
        interval_s=0.01,
        pid_alive=lambda pid: False,
    )
    try:
        assert watchdog.start() is True
        assert fired.wait(1.0) is True
        assert watchdog.triggered is True
    finally:
        watchdog.stop()
    assert watchdog._thread is not None and watchdog._thread.is_alive() is False


def test_watchdog_from_config_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUTOAGENT_DESKTOP_PID", "424242")
    heartbeat = tmp_path / "desktop.heartbeat"
    monkeypatch.setenv("AUTOAGENT_DESKTOP_HEARTBEAT", str(heartbeat))
    config = config_from_env(data_dir=tmp_path / "data")
    watchdog = watchdog_from_config(config, trigger=lambda: None)
    assert watchdog.enabled is True


def test_watchdog_from_config_disabled(tmp_path: Path) -> None:
    config = config_from_env(data_dir=tmp_path / "data")
    watchdog = watchdog_from_config(config, trigger=lambda: None)
    assert watchdog.enabled is False


def test_app_lifespan_has_disabled_watchdog(client: TestClient) -> None:
    watchdog = client.app.state.watchdog
    assert isinstance(watchdog, ParentWatchdog)
    assert watchdog.enabled is False
