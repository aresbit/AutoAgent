"""Default working directory: config default and persisted-setting precedence."""

from __future__ import annotations

from pathlib import Path

import pytest

from autoagent_backend.composition import build_container
from autoagent_backend.config import config_from_env
from autoagent_backend.domain.models import SettingsPatch


def test_persisted_cwd_is_not_overwritten_by_a_new_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    frontend_dist = tmp_path / "dist"

    monkeypatch.setenv("AUTOAGENT_DEFAULT_CWD", str(tmp_path / "first-default"))
    first_config = config_from_env(
        data_dir=data_dir, frontend_dist=frontend_dist
    )
    assert first_config.default_cwd == (tmp_path / "first-default").resolve()
    first = build_container(first_config)
    try:
        persisted = str((tmp_path / "persisted-workspace").resolve())
        first.settings_service.update(SettingsPatch(cwd=persisted))
    finally:
        first.close()

    monkeypatch.setenv("AUTOAGENT_DEFAULT_CWD", str(tmp_path / "second-default"))
    second_config = config_from_env(
        data_dir=data_dir, frontend_dist=frontend_dist
    )
    assert second_config.default_cwd == (tmp_path / "second-default").resolve()
    second = build_container(second_config)
    try:
        # The persisted aggregate wins; constructing with a new default must not
        # rewrite the stored cwd.
        assert second.settings_service.read().cwd == persisted
        # The workspace adapter is seeded from the new boot default, while the
        # settings aggregate remains the user's choice.
        assert second.workspace.status().work_dir == str(
            (tmp_path / "second-default").resolve()
        )
    finally:
        second.close()
