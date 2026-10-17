"""M2 integration: real vendored opencc CLI with a keep-alive frame.

No model call and no API key are used. The test verifies the actual argv handed
to the OS contains ``--matebot`` and that the persistent child stays alive.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest

from autoagent_backend.adapters.engine import process as process_module
from autoagent_backend.adapters.engine.argv import (
    EngineCommand,
    build_argv,
    resolve_bun,
    resolve_cli,
)
from autoagent_backend.adapters.engine.process import EngineChild, build_child_env

pytestmark = pytest.mark.integration


def test_real_opencc_child_accepts_keep_alive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bun = resolve_bun(None)
    cli = resolve_cli(None)
    if "packages/opencc" not in str(cli):
        pytest.skip("vendored opencc CLI is not present")

    argv = build_argv(EngineCommand(bun_path=bun, cli_path=cli, cwd=tmp_path))

    recorded: list[list[str]] = []
    real_popen = subprocess.Popen

    def spy(*args: object, **kwargs: object) -> object:
        recorded.append(list(args[0]))  # type: ignore[call-overload]
        return real_popen(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(process_module.subprocess, "Popen", spy)

    child = EngineChild(
        argv=argv,
        cwd=tmp_path,
        env=build_child_env(tmp_path / ".claude"),
        on_frame=lambda frame: None,
        on_exit=lambda code: None,
        on_stderr=lambda line: None,
        label="real-keepalive",
    )
    try:
        child.spawn()
        child.send_frame({"type": "keep_alive"}, require_ready=False)
        time.sleep(1.0)
        assert child.alive, "real opencc CLI exited immediately"
        assert recorded, "Popen was not called"
        assert recorded[0] == argv
        assert "--matebot" in recorded[0]
        assert "--print" in recorded[0]
        assert "--dangerously-skip-permissions" in recorded[0]
        assert "--permission-mode" not in recorded[0]
    finally:
        child.close()
