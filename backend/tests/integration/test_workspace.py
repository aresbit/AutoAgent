"""M5: workspace aggregate status, diff, branch switch and init."""

from __future__ import annotations

import subprocess
from pathlib import Path

from ..fixtures.panels import AUTH, panel_client


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    (repo / "a.txt").write_text("one\n", encoding="utf-8")
    (repo / "c.txt").write_text("remove\n", encoding="utf-8")
    _git(repo, "add", "a.txt", "c.txt")
    _git(
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "init",
    )
    _git(repo, "branch", "feature")
    (repo / "a.txt").write_text("one\ntwo\n", encoding="utf-8")
    (repo / "c.txt").unlink()
    return repo


def test_status_is_one_aggregate_read_model(tmp_path: Path) -> None:
    repo = _repo(tmp_path)

    with panel_client(tmp_path, cwd=repo) as (client, _, _):
        response = client.get(
            "/api/workspace", headers=AUTH, params={"workDir": str(repo)}
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["workDir"] == str(repo)
    assert payload["isGitRepo"] is True
    assert payload["changedFiles"] == 2
    assert payload["additions"] == 1
    assert payload["deletions"] == 1
    files = {item["path"]: item for item in payload["files"]}
    assert files["a.txt"]["status"] == "modified"
    assert files["c.txt"]["status"] == "deleted"
    assert {"main", "feature"} <= {item["name"] for item in payload["branches"]}
    assert all(item["isRemote"] is False for item in payload["branches"])


def test_diff_returns_patch_and_both_sides(tmp_path: Path) -> None:
    repo = _repo(tmp_path)

    with panel_client(tmp_path, cwd=repo) as (client, _, _):
        response = client.get(
            "/api/workspace/diff",
            headers=AUTH,
            params={"path": "a.txt", "workDir": str(repo)},
        )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["path"] == "a.txt"
    assert "+two" in payload["patch"]
    assert payload["original"] == "one\n"
    assert payload["current"] == "one\ntwo\n"


def test_switch_branch_returns_new_status(tmp_path: Path) -> None:
    repo = _repo(tmp_path)

    with panel_client(tmp_path, cwd=repo) as (client, _, _):
        response = client.post(
            "/api/workspace/branches/switch",
            headers=AUTH,
            json={"branch": "feature", "workDir": str(repo)},
        )

    assert response.status_code == 200, response.text
    assert _git(repo, "branch", "--show-current").strip() == "feature"
    payload = response.json()
    assert payload["isGitRepo"] is True
    assert {"main", "feature"} <= {item["name"] for item in payload["branches"]}


def test_init_creates_a_repository(tmp_path: Path) -> None:
    working = tmp_path / "fresh"
    working.mkdir()

    with panel_client(tmp_path, cwd=working) as (client, _, _):
        response = client.post(
            "/api/workspace/init",
            headers=AUTH,
            json={"workDir": str(working)},
        )

    assert response.status_code == 200, response.text
    assert response.json()["isGitRepo"] is True
    assert (working / ".git").is_dir()


def test_non_repository_and_missing_directory_are_truthful(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    absent = tmp_path / "absent"

    with panel_client(tmp_path, cwd=plain) as (client, _, _):
        plain_status = client.get(
            "/api/workspace", headers=AUTH, params={"workDir": str(plain)}
        )
        missing_status = client.get(
            "/api/workspace", headers=AUTH, params={"workDir": str(absent)}
        )

    assert plain_status.status_code == 200
    assert plain_status.json()["isGitRepo"] is False
    assert missing_status.status_code == 200
    assert missing_status.json()["isGitRepo"] is False
    assert "does not exist" in missing_status.json()["warnings"][0]


def test_workspace_requires_auth_and_validates_inputs(tmp_path: Path) -> None:
    repo = _repo(tmp_path)

    with panel_client(tmp_path, cwd=repo) as (client, _, _):
        assert client.get("/api/workspace").status_code == 401

        missing_path = client.get(
            "/api/workspace/diff", headers=AUTH, params={"workDir": str(repo)}
        )
        assert missing_path.status_code == 422

        traversal = client.get(
            "/api/workspace/diff",
            headers=AUTH,
            params={"path": "../secret", "workDir": str(repo)},
        )
        assert traversal.status_code == 400
        assert traversal.json()["code"] == "INVALID_INPUT"

        bad_base = client.get(
            "/api/workspace",
            headers=AUTH,
            params={"workDir": str(repo), "base": "--cached"},
        )
        assert bad_base.status_code == 400

        injection = client.post(
            "/api/workspace/branches/switch",
            headers=AUTH,
            json={"branch": "-x", "workDir": str(repo)},
        )
        assert injection.status_code == 400

        absent_branch = client.post(
            "/api/workspace/branches/switch",
            headers=AUTH,
            json={"branch": "no-such-branch", "workDir": str(repo)},
        )
        assert absent_branch.status_code == 503
        assert absent_branch.json()["code"] == "WORKSPACE_UNAVAILABLE"
