"""M5: skill catalog, source precedence and enable/disable moves."""

from __future__ import annotations

from pathlib import Path

from ..fixtures.panels import AUTH, panel_client


def _write_skill(directory: Path, description: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        f"---\ndescription: {description}\n---\n\n# Body\n", encoding="utf-8"
    )


def _project(tmp_path: Path) -> tuple[Path, Path]:
    home = tmp_path / "home"
    project = tmp_path / "project"
    _write_skill(home / ".claude" / "skills" / "user-skill", "From user")
    _write_skill(project / ".autoagent" / "skills" / "proj-skill", "From project")
    _write_skill(project / ".claude" / "skills" / "shared", "claude copy")
    _write_skill(project / ".autoagent" / "skills" / "shared", "autoagent copy")
    _write_skill(home / ".claude" / "skills" / "shared", "user copy")
    return home, project


def test_catalog_returns_sources_and_project_precedence(tmp_path: Path) -> None:
    home, project = _project(tmp_path)

    with panel_client(tmp_path, cwd=project, home=home) as (client, _, _):
        response = client.get("/api/skills", headers=AUTH)

    assert response.status_code == 200, response.text
    payload = response.json()
    skills = {item["name"]: item for item in payload["skills"]}
    assert set(skills) == {"user-skill", "proj-skill", "shared"}
    assert skills["user-skill"]["source"] == "system"
    assert skills["proj-skill"]["source"] == "project"
    # Project `.autoagent` is scanned last and therefore wins.
    assert skills["shared"]["source"] == "project"
    assert skills["shared"]["description"] == "autoagent copy"
    assert all(item["enabled"] for item in skills.values())
    assert any(item["source"] == "system" and item["exists"] for item in payload["dirs"])
    assert any(item["source"] == "project" and item["exists"] for item in payload["dirs"])


def test_disable_then_enable_moves_directory_atomically(tmp_path: Path) -> None:
    home, project = _project(tmp_path)
    active = project / ".autoagent" / "skills" / "proj-skill"
    disabled = project / ".autoagent" / "skills" / ".disabled" / "proj-skill"

    with panel_client(tmp_path, cwd=project, home=home) as (client, _, _):
        off = client.post("/api/skills/proj-skill/disable", headers=AUTH)
        assert off.status_code == 200, off.text
        assert not active.exists()
        assert disabled.is_dir()
        listed = {item["name"]: item for item in off.json()["skills"]}
        assert listed["proj-skill"]["enabled"] is False

        on = client.post("/api/skills/proj-skill/enable", headers=AUTH)
        assert on.status_code == 200, on.text
        assert active.is_dir()
        assert not disabled.exists()
        listed = {item["name"]: item for item in on.json()["skills"]}
        assert listed["proj-skill"]["enabled"] is True


def test_enable_with_path_copies_an_unmanaged_skill(tmp_path: Path) -> None:
    home, project = _project(tmp_path)
    external = tmp_path / "external-skill"
    _write_skill(external, "External skill")

    with panel_client(tmp_path, cwd=project, home=home) as (client, _, _):
        response = client.post(
            "/api/skills/external-skill/enable",
            headers=AUTH,
            json={"path": str(external)},
        )

    assert response.status_code == 200, response.text
    copied = project / ".autoagent" / "skills" / "external-skill"
    assert copied.is_dir()
    listed = {item["name"]: item for item in response.json()["skills"]}
    assert listed["external-skill"]["source"] == "project"


def test_discover_finds_skill_markdown(tmp_path: Path) -> None:
    home, project = _project(tmp_path)

    with panel_client(tmp_path, cwd=project, home=home) as (client, _, _):
        response = client.post(
            "/api/skills/discover",
            headers=AUTH,
            json={"cwd": str(project), "query": "proj"},
        )

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == ".autoagent/skills/proj-skill/SKILL.md"
    assert items[0]["name"] == "proj-skill"


def test_skills_require_auth_and_validate_input(tmp_path: Path) -> None:
    home, project = _project(tmp_path)

    with panel_client(tmp_path, cwd=project, home=home) as (client, _, _):
        assert client.get("/api/skills").status_code == 401

        missing_cwd = client.post("/api/skills/discover", headers=AUTH, json={})
        assert missing_cwd.status_code == 422

        unknown = client.post("/api/skills/absent/disable", headers=AUTH)
        assert unknown.status_code == 404
        assert unknown.json()["code"] == "SKILL_NOT_FOUND"

        unsafe = client.post(
            "/api/skills/.../enable", headers=AUTH, json={}
        )
        assert unsafe.status_code == 400
        assert unsafe.json()["code"] == "INVALID_INPUT"


def test_disable_reports_unknown_skill(tmp_path: Path) -> None:
    home, project = _project(tmp_path)
    with panel_client(tmp_path, cwd=project, home=home) as (client, _, _):
        response = client.post("/api/skills/missing/disable", headers=AUTH)
    assert response.status_code == 404
