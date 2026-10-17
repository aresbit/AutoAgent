"""M5: artifact lifecycle with manifest-authoritative metadata."""

from __future__ import annotations

import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from ..fixtures.panels import AUTH, panel_client


def _create(
    client: TestClient, title: str = "Demo Art", html: str = "<h1>Hi</h1>"
):
    return client.post(
        "/api/artifacts",
        headers=AUTH,
        json={"title": title, "description": "demo", "html": html},
    )


def test_create_list_get_and_content(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, _, _):
        created = _create(client)
        assert created.status_code == 200, created.text
        payload = created.json()
        assert payload["id"] == "demo-art"
        assert payload["title"] == "Demo Art"
        assert payload["contentUrl"] == "/api/artifacts/demo-art/content"
        assert payload["versions"] == []
        assert payload["lastOpenedAt"] is None

        manifest = tmp_path / "data" / "artifacts" / "manifest.json"
        assert manifest.is_file()
        assert (tmp_path / "data" / "artifacts" / "demo-art" / "index.html").is_file()

        listed = client.get("/api/artifacts", headers=AUTH)
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["artifacts"]] == ["demo-art"]

        fetched = client.get("/api/artifacts/demo-art", headers=AUTH)
        assert fetched.status_code == 200
        assert fetched.json()["description"] == "demo"

        content = client.get("/api/artifacts/demo-art/content", headers=AUTH)
        assert content.status_code == 200
        assert content.headers["content-type"].startswith("text/html")
        assert "<h1>Hi</h1>" in content.text
        assert 'id="autowork-artifact-meta"' in content.text


def test_recreate_versions_and_mark_opened(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, _, _):
        first = _create(client).json()
        second = _create(client, html="<h1>V2</h1>")

    assert second.status_code == 200, second.text
    payload = second.json()
    assert payload["createdAt"] == first["createdAt"]
    assert len(payload["versions"]) == 1
    assert payload["versions"][0] == first["updatedAt"]
    snapshots = list(
        (tmp_path / "data" / "artifacts" / "demo-art" / "versions").glob("*.html")
    )
    assert len(snapshots) == 1

    with panel_client(tmp_path) as (client, _, _):
        opened = client.post("/api/artifacts/demo-art/open", headers=AUTH)
    assert opened.status_code == 200
    assert isinstance(opened.json()["lastOpenedAt"], int)


def test_export_and_import_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "export" / "demo.zip"

    with panel_client(tmp_path) as (client, _, _):
        _create(client)
        exported = client.post(
            "/api/artifacts/demo-art/export",
            headers=AUTH,
            json={"targetPath": str(target)},
        )
        assert exported.status_code == 200, exported.text
        assert exported.json()["path"] == str(target)

    assert zipfile.is_zipfile(target)
    with zipfile.ZipFile(target) as archive:
        assert "index.html" in archive.namelist()

    incoming = tmp_path / "incoming.zip"
    with zipfile.ZipFile(incoming, "w") as archive:
        archive.writestr(
            "nested/index.html",
            '<!doctype html><html><head>'
            '<script id="autowork-artifact-meta" type="application/json">'
            '{"name":"Imported Doc","description":"from zip"}'
            "</script></head><body><h1>Imported</h1></body></html>",
        )

    with panel_client(tmp_path) as (client, _, _):
        imported = client.post(
            "/api/artifacts/import", headers=AUTH, json={"zipPath": str(incoming)}
        )
        content = client.get("/api/artifacts/imported-doc/content", headers=AUTH)

    assert imported.status_code == 200, imported.text
    assert imported.json()["id"] == "imported-doc"
    assert imported.json()["title"] == "Imported Doc"
    assert "<h1>Imported</h1>" in content.text


def test_manifest_wins_over_stray_disk_directories(tmp_path: Path) -> None:
    root = tmp_path / "data" / "artifacts"
    stray = root / "stray"
    stray.mkdir(parents=True)
    (stray / "index.html").write_text("<html><body>stray</body></html>", encoding="utf-8")

    with panel_client(tmp_path) as (client, _, _):
        _create(client)
        listed = client.get("/api/artifacts", headers=AUTH)

    assert [item["id"] for item in listed.json()["artifacts"]] == ["demo-art"]


def test_artifact_safety_and_validation(tmp_path: Path) -> None:
    not_a_zip = tmp_path / "not-a-zip.txt"
    not_a_zip.write_text("hello", encoding="utf-8")
    zip_slip = tmp_path / "slip.zip"
    with zipfile.ZipFile(zip_slip, "w") as archive:
        archive.writestr("../escaped.txt", "oops")

    with panel_client(tmp_path) as (client, _, _):
        assert client.get("/api/artifacts").status_code == 401
        _create(client)

        unsafe = client.get("/api/artifacts/.hidden", headers=AUTH)
        assert unsafe.status_code == 400

        unknown = client.get("/api/artifacts/absent", headers=AUTH)
        assert unknown.status_code == 404
        assert unknown.json()["code"] == "ARTIFACT_NOT_FOUND"

        bad_export = client.post(
            "/api/artifacts/absent/export",
            headers=AUTH,
            json={"targetPath": str(tmp_path / "x.zip")},
        )
        assert bad_export.status_code == 404

        bad_target = client.post(
            "/api/artifacts/demo-art/export",
            headers=AUTH,
            json={"targetPath": str(tmp_path)},
        )
        assert bad_target.status_code == 400

        bad_import = client.post(
            "/api/artifacts/import",
            headers=AUTH,
            json={"zipPath": str(not_a_zip)},
        )
        assert bad_import.status_code == 400
        assert bad_import.json()["code"] == "INVALID_INPUT"

        slip_import = client.post(
            "/api/artifacts/import", headers=AUTH, json={"zipPath": str(zip_slip)}
        )
        assert slip_import.status_code == 400
        assert not (tmp_path / "data" / "artifacts" / "escaped.txt").exists()

        missing_html = client.post(
            "/api/artifacts", headers=AUTH, json={"title": "x"}
        )
        assert missing_html.status_code == 422

        extra = client.post(
            "/api/artifacts",
            headers=AUTH,
            json={"html": "<p>x</p>", "unknown": True},
        )
        assert extra.status_code == 422
