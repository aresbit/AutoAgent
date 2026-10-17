"""Unit tests for git output parsing and input hardening."""

from __future__ import annotations

from pathlib import Path

import pytest

from autoagent_backend.adapters.workspace.git_cli import (
    GitCliWorkspace,
    _branch_name,
    _normalize_status,
    _parse_branches,
    _parse_numstat,
    _relative_path,
)
from autoagent_backend.domain.errors import InvalidInput


def test_relative_path_rejects_traversal_and_absolute_paths() -> None:
    assert _relative_path("src/app.py") == "src/app.py"
    for bad in ("", "../secret", "/etc/passwd", "a/../b", "a\\b", "a//b"):
        with pytest.raises(InvalidInput):
            _relative_path(bad)


def test_branch_name_rejects_option_injection() -> None:
    assert _branch_name("feature/x") == "feature/x"
    for bad in ("", "-x", "a b", "a\nb"):
        with pytest.raises(InvalidInput):
            _branch_name(bad)


def test_parse_branches_deduplicates_and_marks_remotes() -> None:
    output = "main\norigin/main\norigin/HEAD -> origin/main\nfeature\nmain\n"
    branches = _parse_branches(output)
    assert [(item.name, item.is_remote) for item in branches] == [
        ("main", False),
        ("origin/main", True),
        ("feature", False),
    ]


def test_parse_numstat_handles_renames_and_binaries() -> None:
    counts = _parse_numstat(
        "1\t2\ta.txt\n-\t-\tb.png\n3\t4\tdir/{old.py => new.py}\n6\t7\n"
    )
    assert counts["a.txt"] == (1, 2)
    assert counts["b.png"] == (0, 0)
    assert counts["dir/old.py"] == (3, 4)
    assert counts["dir/new.py"] == (3, 4)
    assert _normalize_status("R100") == "renamed"
    assert _normalize_status("X") == "unknown"


def test_missing_workspace_is_truthful(tmp_path: Path) -> None:
    workspace = GitCliWorkspace(str(tmp_path / "absent"))
    status = workspace.status()
    assert status.is_git_repo is False
    assert "does not exist" in status.warnings[0]
