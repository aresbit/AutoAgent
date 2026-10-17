"""Unit tests for the filesystem skill catalog."""

from __future__ import annotations

from pathlib import Path

import pytest

from autoagent_backend.adapters.skills.fs_catalog import (
    FilesystemSkillCatalog,
    extract_description,
)
from autoagent_backend.domain.errors import InvalidInput, SkillNotFound


def _skill(directory: Path, description: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: x\ndescription: {description}\n---\n", encoding="utf-8"
    )


def test_extract_description_frontmatter_and_body() -> None:
    assert (
        extract_description("---\ndescription: 'quoted'\n---\nbody")
        == "quoted"
    )
    assert extract_description("# Heading\n\nFirst prose line\n") == "First prose line"
    assert extract_description("# only heading\n") == ""


def test_project_overrides_system_and_disabled(tmp_path: Path) -> None:
    home = tmp_path / "home"
    project = tmp_path / "project"
    _skill(home / ".claude" / "skills" / "same", "user")
    _skill(project / ".autoagent" / "skills" / "same", "project")
    _skill(project / ".autoagent" / "skills" / ".disabled" / "same", "disabled")

    catalog = FilesystemSkillCatalog(home_dir=home, default_cwd=str(project))
    data = catalog.catalog()

    entry = next(item for item in data.skills if item.name == "same")
    assert entry.description == "disabled"
    assert entry.enabled is False


def test_toggle_moves_entry_in_and_out_of_disabled(tmp_path: Path) -> None:
    home = tmp_path / "home"
    project = tmp_path / "project"
    _skill(project / ".autoagent" / "skills" / "alpha", "alpha")
    catalog = FilesystemSkillCatalog(home_dir=home, default_cwd=str(project))

    after_disable = catalog.disable("alpha")
    assert next(item for item in after_disable.skills if item.name == "alpha").enabled is False
    assert (project / ".autoagent" / "skills" / ".disabled" / "alpha").is_dir()
    assert not (project / ".autoagent" / "skills" / "alpha").exists()

    after_enable = catalog.enable("alpha")
    assert next(item for item in after_enable.skills if item.name == "alpha").enabled is True
    assert (project / ".autoagent" / "skills" / "alpha").is_dir()


def test_enable_unknown_requires_a_path(tmp_path: Path) -> None:
    catalog = FilesystemSkillCatalog(
        home_dir=tmp_path / "home", default_cwd=str(tmp_path / "project")
    )
    with pytest.raises(SkillNotFound):
        catalog.enable("missing")
    with pytest.raises(InvalidInput):
        FilesystemSkillCatalog(home_dir=tmp_path / "home").catalog()


def test_discover_respects_query_and_limit(tmp_path: Path) -> None:
    project = tmp_path / "project"
    _skill(project / ".autoagent" / "skills" / "alpha", "a")
    _skill(project / ".autoagent" / "skills" / "beta", "b")

    catalog = FilesystemSkillCatalog(
        home_dir=tmp_path / "home", default_cwd=str(project)
    )
    matches = catalog.discover(str(project), "alpha")
    assert [item.name for item in matches] == ["alpha"]

    limited = FilesystemSkillCatalog(
        home_dir=tmp_path / "home", default_cwd=str(project), discover_limit=1
    ).discover(str(project))
    assert len(limited) == 1
