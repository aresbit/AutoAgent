"""File browser HTTP surface: roots, containment, CAS, range and upload."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.api.routes.file_router import _require_loopback
from autoagent_backend.app import create_app
from autoagent_backend.config import config_from_env

TOKEN = "test-token"


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "hello.txt").write_text("hello\nworld\n", encoding="utf-8")
    (root / "sub").mkdir()
    (root / "sub" / "nested.txt").write_text("nested\n", encoding="utf-8")
    (root / "outside-target.txt").write_text("secret\n", encoding="utf-8")
    monkeypatch.setenv("AUTOAGENT_DEFAULT_CWD", str(root))
    return root


@pytest.fixture
def file_client(workspace: Path, tmp_path: Path) -> Iterator[TestClient]:
    del workspace
    config = config_from_env(data_dir=tmp_path / "data", port=8787)
    app = create_app(config)
    # TestClient reports "testclient" as the peer; the real server is loopback.
    app.dependency_overrides[_require_loopback] = lambda: None
    with TestClient(app) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        yield client


def test_list_and_read(file_client: TestClient) -> None:
    listing = file_client.get("/api/files", params={"root": "workspace"})
    assert listing.status_code == 200, listing.text
    body = listing.json()
    assert body["root"] == "workspace"
    assert body["path"] == ""
    names = {entry["name"] for entry in body["entries"]}
    assert {"hello.txt", "sub"} <= names
    # No absolute path leaks into the DTO.
    assert "/workspace" not in listing.text

    read = file_client.get(
        "/api/files/content", params={"root": "workspace", "path": "hello.txt"}
    )
    assert read.status_code == 200, read.text
    text = read.json()
    assert text["text"] == "hello\nworld\n"
    assert text["binary"] is False
    assert len(text["sha256"]) == 64

    nested = file_client.get(
        "/api/files", params={"root": "workspace", "path": "sub"}
    )
    assert nested.status_code == 200
    assert [entry["name"] for entry in nested.json()["entries"]] == ["nested.txt"]


def test_path_policy(file_client: TestClient) -> None:
    for bad in ("..", "../outside-target.txt", "/etc/passwd", "sub/../../x"):
        response = file_client.get(
            "/api/files/content", params={"root": "workspace", "path": bad}
        )
        assert response.status_code == 400, (bad, response.text)
        assert response.json()["code"] == "INVALID_PATH"

    unknown = file_client.get("/api/files", params={"root": "elsewhere"})
    assert unknown.status_code == 403
    assert unknown.json()["code"] == "ROOT_NOT_ALLOWED"


def test_symlink_is_refused_and_described(
    file_client: TestClient, workspace: Path
) -> None:
    link = workspace / "link.txt"
    os.symlink(workspace / "outside-target.txt", link)

    listed = file_client.get("/api/files", params={"root": "workspace"})
    entry = next(item for item in listed.json()["entries"] if item["name"] == "link.txt")
    assert entry["kind"] == "symlink"
    assert entry["isSymlink"] is True

    read = file_client.get(
        "/api/files/content", params={"root": "workspace", "path": "link.txt"}
    )
    assert read.status_code == 403
    assert read.json()["code"] == "SYMLINK_NOT_ALLOWED"

    deleted = file_client.post(
        "/api/files/delete", json={"root": "workspace", "path": "link.txt"}
    )
    assert deleted.status_code == 200
    assert (workspace / "outside-target.txt").is_file()


def test_atomic_write_and_hash_cas(file_client: TestClient, workspace: Path) -> None:
    created = file_client.put(
        "/api/files/content",
        json={"root": "workspace", "path": "new.txt", "text": "v1"},
    )
    assert created.status_code == 200, created.text
    first = created.json()
    assert (workspace / "new.txt").read_text() == "v1"

    stale = file_client.put(
        "/api/files/content",
        json={
            "root": "workspace",
            "path": "new.txt",
            "text": "v2",
            "expectedSha256": "0" * 64,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "HASH_MISMATCH"
    assert (workspace / "new.txt").read_text() == "v1"

    fresh = file_client.put(
        "/api/files/content",
        json={
            "root": "workspace",
            "path": "new.txt",
            "text": "v2",
            "expectedSha256": first["sha256"],
        },
    )
    assert fresh.status_code == 200, fresh.text
    assert (workspace / "new.txt").read_text() == "v2"


def test_missing_file_and_oversize_read(
    file_client: TestClient, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = file_client.get(
        "/api/files/content", params={"root": "workspace", "path": "absent.txt"}
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "FILE_NOT_FOUND"

    # The cap is a boot-time configuration value; a fresh app enforces it.
    monkeypatch.setenv("AUTOAGENT_FILE_MAX_READ_BYTES", "4")
    config = config_from_env(data_dir=workspace.parent / "data2", port=8788)
    app = create_app(config)
    app.dependency_overrides[_require_loopback] = lambda: None
    with TestClient(app) as client:
        client.headers["Authorization"] = f"Bearer {TOKEN}"
        large = client.get(
            "/api/files/content",
            params={"root": "workspace", "path": "hello.txt"},
        )
        assert large.status_code == 413
        assert large.json()["code"] == "FILE_TOO_LARGE"


def test_byte_range_and_download_headers(
    file_client: TestClient,
) -> None:
    ranged = file_client.get(
        "/api/files/content",
        params={"root": "workspace", "path": "hello.txt", "mode": "bytes"},
        headers={"Range": "bytes=0-4"},
    )
    assert ranged.status_code == 206, ranged.text
    assert ranged.content == b"hello"
    assert ranged.headers["content-range"] == "bytes 0-4/12"
    assert ranged.headers["x-content-type-options"] == "nosniff"

    download = file_client.get(
        "/api/files/download", params={"root": "workspace", "path": "hello.txt"}
    )
    assert download.status_code == 200
    assert download.content == b"hello\nworld\n"
    assert download.headers["content-disposition"].startswith("attachment")
    assert "workspace" not in download.headers["content-disposition"]


def test_raw_streaming_upload(file_client: TestClient, workspace: Path) -> None:
    response = file_client.post(
        "/api/files/upload",
        params={"root": "workspace", "path": "uploaded.bin", "overwrite": "true"},
        content=b"\x00\x01binary",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 200, response.text
    assert (workspace / "uploaded.bin").read_bytes() == b"\x00\x01binary"

    too_large = file_client.post(
        "/api/files/upload",
        params={"root": "workspace", "path": "big.bin"},
        content=b"x" * (1024 * 1024 + 1),
        headers={"Content-Type": "application/octet-stream"},
    )
    assert too_large.status_code == 413
    assert not (workspace / "big.bin").exists()


def test_mutation_routes(file_client: TestClient, workspace: Path) -> None:
    made = file_client.post(
        "/api/files/mkdir", json={"root": "workspace", "path": "made"}
    )
    assert made.status_code == 200, made.text
    assert (workspace / "made").is_dir()

    renamed = file_client.post(
        "/api/files/rename",
        json={
            "root": "workspace",
            "fromPath": "hello.txt",
            "toPath": "renamed.txt",
        },
    )
    assert renamed.status_code == 200, renamed.text
    assert (workspace / "renamed.txt").is_file()

    copied = file_client.post(
        "/api/files/copy",
        json={
            "root": "workspace",
            "fromPath": "renamed.txt",
            "toPath": "copy.txt",
        },
    )
    assert copied.status_code == 200, copied.text
    assert (workspace / "copy.txt").read_text() == "hello\nworld\n"
