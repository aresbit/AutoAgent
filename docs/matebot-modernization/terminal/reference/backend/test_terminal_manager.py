"""Unit tests for the framework-free ``TerminalManager``.

Run (reference directory, no FastAPI needed):

    python -m pytest -q test_terminal_manager.py

The tests use only stdlib + pytest.  Async cases are driven with
``asyncio.run`` so no pytest-asyncio plugin is required.

They exercise real kernel PTYs.  They are skipped on Windows.
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Awaitable

import pytest

from terminal_manager import (
    CwdNotAllowed,
    InvalidShell,
    InvalidTerminalKey,
    TerminalAlreadyExists,
    TerminalClosed,
    TerminalLimitExceeded,
    TerminalManager,
    TerminalSession,
    resolve_shell,
    scrub_environment,
)

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="POSIX PTYs only"
)


def run(coro: Awaitable[None]) -> None:
    asyncio.run(coro)  # type: ignore[arg-type]


async def collect(
    session: TerminalSession, *, timeout: float = 8.0
) -> bytes:
    """Read until the session reports EOF, with a hard timeout."""

    chunks: list[bytes] = []

    async def consume() -> None:
        while True:
            chunk = await session.read()
            if chunk is None:
                return
            chunks.append(chunk)

    await asyncio.wait_for(consume(), timeout)
    return b"".join(chunks)


async def run_command(
    manager: TerminalManager,
    *,
    key: str,
    command: str,
    shell: str = "/bin/bash",
    cols: int = 80,
    rows: int = 24,
    env: dict[str, str] | None = None,
) -> tuple[TerminalSession, bytes]:
    session = await manager.spawn(
        key,
        shell=shell,
        cwd=os.getcwd(),
        env=env,
        cols=cols,
        rows=rows,
        argv=[shell, "-lc", command],
    )
    try:
        output = await collect(session)
    finally:
        await manager.destroy(key, grace_s=0.2)
    return session, output


def test_spawn_read_and_exit_code() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        try:
            session, output = await run_command(
                manager, key="s::t1", command="printf hello"
            )
            assert b"hello" in output
            assert session.exit_code == 0
            assert session.closed is True
        finally:
            await manager.shutdown()

    run(case())


def test_nonzero_exit_code() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        try:
            session, _ = await run_command(
                manager, key="s::t2", command="exit 7"
            )
            assert session.exit_code == 7
        finally:
            await manager.shutdown()

    run(case())


def test_resize_changes_kernel_winsize() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        session = await manager.spawn(
            "s::resize",
            shell="/bin/bash",
            cwd=os.getcwd(),
            cols=80,
            rows=24,
            argv=["/bin/bash", "-lc", "sleep 0.5; stty size"],
        )
        try:
            await asyncio.sleep(0.1)
            await session.resize(100, 40)
            output = await collect(session)
            assert b"40 100" in output
            assert (session.cols, session.rows) == (100, 40)
        finally:
            await manager.destroy("s::resize", grace_s=0.2)

    run(case())


def test_write_reaches_interactive_shell() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        session = await manager.spawn(
            "s::write",
            shell="/bin/bash",
            cwd=os.getcwd(),
            argv=["/bin/bash", "-l"],
        )
        try:
            await asyncio.sleep(0.15)
            await session.write("printf 'WRITTEN\\n'\n")
            await session.write("exit 0\n")
            output = await collect(session)
            assert b"WRITTEN" in output
            assert session.exit_code == 0
        finally:
            await manager.destroy("s::write", grace_s=0.2)

    run(case())


def test_write_after_exit_raises_closed() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        session, _ = await run_command(
            manager, key="s::closed", command="printf bye"
        )
        with pytest.raises(TerminalClosed):
            await session.write("x")

    run(case())


def test_cwd_containment_hook_rejects_outside_root() -> None:
    async def case() -> None:
        manager = TerminalManager(
            max_sessions=4, is_cwd_allowed=lambda path: False
        )
        with pytest.raises(CwdNotAllowed):
            await manager.spawn(
                "s::cwd",
                shell="/bin/bash",
                cwd=os.getcwd(),
                argv=["/bin/bash", "-lc", "true"],
            )
        assert len(manager) == 0
        await manager.shutdown()

    run(case())


def test_cwd_containment_hook_accepts_inside_root() -> None:
    async def case() -> None:
        root = os.getcwd()

        def allowed(path: str) -> bool:
            return path == root or path.startswith(root + os.sep)

        manager = TerminalManager(max_sessions=4, is_cwd_allowed=allowed)
        session = await manager.spawn(
            "s::cwd-ok",
            shell="/bin/bash",
            cwd=root,
            argv=["/bin/bash", "-lc", "pwd"],
        )
        try:
            output = await collect(session)
            assert root.encode() in output
        finally:
            await manager.destroy("s::cwd-ok", grace_s=0.2)

    run(case())


def test_environment_is_scrubbed() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        session = await manager.spawn(
            "s::env",
            shell="/bin/bash",
            cwd=os.getcwd(),
            env={
                "SECRET_TOKEN": "do-not-leak",
                "LD_PRELOAD": "/tmp/evil.so",
                "ANTHROPIC_API_KEY": "sk-secret",
            },
            argv=[
                "/bin/bash",
                "-lc",
                (
                    "printf '%s|%s|%s|%s' "
                    "\"${SECRET_TOKEN-unset}\" \"${LD_PRELOAD-unset}\" "
                    "\"${ANTHROPIC_API_KEY-unset}\" \"$TERM\""
                ),
            ],
        )
        try:
            output = await collect(session)
            assert b"unset|unset|unset|xterm-256color" in output
            assert b"do-not-leak" not in output
        finally:
            await manager.destroy("s::env", grace_s=0.2)

    run(case())


def test_scrub_environment_keeps_only_safe_keys() -> None:
    env = scrub_environment(
        {
            "PATH": "/custom/bin",
            "HOME": "/home/tester",
            "LANG": "en_US.UTF-8",
            "TERM": "dumb",
            "SECRET": "x",
            "LD_PRELOAD": "/tmp/evil.so",
        }
    )
    assert env["PATH"] == "/custom/bin"
    assert env["HOME"] == "/home/tester"
    assert env["TERM"] == "xterm-256color"
    assert "SECRET" not in env
    assert "LD_PRELOAD" not in env
    assert set(env) <= {
        "PATH",
        "HOME",
        "TERM",
        "COLORTERM",
        "LANG",
        "LC_ALL",
    }


def test_close_kills_process_group() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        session = await manager.spawn(
            "s::kill",
            shell="/bin/bash",
            cwd=os.getcwd(),
            argv=["/bin/bash", "-lc", "sleep 60"],
        )
        await asyncio.sleep(0.2)
        pid = session.pid
        pgid = session.pgid
        assert pgid == pid

        await session.close(grace_s=0.3)
        assert session.closed is True

        # The reaper must have consumed the zombie; otherwise killpg(0) sees it.
        for _ in range(100):
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.01)
        else:  # pragma: no cover - failure diagnostic
            pytest.fail("process group survived close")

        # There must be no reaped child left for waitpid.
        with pytest.raises(ChildProcessError):
            os.waitpid(pid, os.WNOHANG)

    run(case())


def test_shell_allowlist_rejects_arbitrary_path() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        with pytest.raises(InvalidShell):
            await manager.spawn(
                "s::shell",
                shell="/tmp/not-a-shell",
                cwd=os.getcwd(),
            )
        assert len(manager) == 0
        await manager.shutdown()

    run(case())


def test_resolve_shell_defaults_to_bash() -> None:
    resolved = resolve_shell(None, base_env={"SHELL": "/usr/bin/fish"})
    assert resolved in {
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/zsh",
        "/usr/bin/zsh",
        "/bin/sh",
        "/usr/bin/sh",
    }
    assert resolved.endswith(("bash", "zsh", "sh"))


def test_invalid_key_and_duplicate_key() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        with pytest.raises(InvalidTerminalKey):
            await manager.spawn(
                "bad\x00key", shell="/bin/bash", cwd=os.getcwd()
            )
        first = await manager.spawn(
            "s::dup",
            shell="/bin/bash",
            cwd=os.getcwd(),
            argv=["/bin/bash", "-lc", "sleep 1"],
        )
        assert first is not None
        with pytest.raises(TerminalAlreadyExists):
            await manager.spawn(
                "s::dup", shell="/bin/bash", cwd=os.getcwd()
            )
        await manager.destroy("s::dup", grace_s=0.2)

    run(case())


def test_session_limit() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=1)
        await manager.spawn(
            "s::one",
            shell="/bin/bash",
            cwd=os.getcwd(),
            argv=["/bin/bash", "-lc", "sleep 1"],
        )
        with pytest.raises(TerminalLimitExceeded):
            await manager.spawn(
                "s::two", shell="/bin/bash", cwd=os.getcwd()
            )
        await manager.shutdown()

    run(case())


def test_ring_buffer_is_bounded() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4, ring_bytes=4096)
        session = await manager.spawn(
            "s::ring",
            shell="/bin/bash",
            cwd=os.getcwd(),
            argv=[
                "/bin/bash",
                "-lc",
                (
                    "python3 -c \"import sys; "
                    "sys.stdout.write('a' * 100000)\""
                ),
            ],
        )
        try:
            output = await collect(session)
            assert len(output) >= 100000
            snapshot = session.scrollback()
            assert 0 < len(snapshot) <= 4096
            assert snapshot.endswith(b"a")
        finally:
            await manager.destroy("s::ring", grace_s=0.2)

    run(case())


def test_destroy_removes_session_and_marks_closed() -> None:
    async def case() -> None:
        manager = TerminalManager(max_sessions=4)
        session = await manager.spawn(
            "s::destroy",
            shell="/bin/bash",
            cwd=os.getcwd(),
            argv=["/bin/bash", "-lc", "sleep 5"],
        )
        assert manager.get("s::destroy") is session
        assert await manager.destroy("s::destroy", grace_s=0.2) is True
        assert manager.get("s::destroy") is None
        assert session.closed is True
        assert await manager.destroy("s::destroy") is False

    run(case())


def test_shutdown_now_reaps_everything() -> None:
    manager = TerminalManager(max_sessions=4)

    async def spawn_one() -> TerminalSession:
        return await manager.spawn(
            "s::now",
            shell="/bin/bash",
            cwd=os.getcwd(),
            argv=["/bin/bash", "-lc", "sleep 60"],
        )

    session = asyncio.run(spawn_one())
    manager.shutdown_now(timeout_s=0.5)
    assert session.closed is True
    assert len(manager) == 0
