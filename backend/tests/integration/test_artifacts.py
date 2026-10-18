"""M5: artifact lifecycle with manifest-authoritative metadata."""

from __future__ import annotations

import uuid
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from autoagent_backend.adapters.engine.fake_engine import FakeEngine
from autoagent_backend.application.turn_service import TurnService
from autoagent_backend.domain.events import (
    DomainEvent,
    TextDelta,
    TurnCompleted,
    TurnStarted,
)

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
    # Immutable snapshots for both versions: v1 (first) and v2 (second/current).
    assert sorted(item.name for item in snapshots) == ["v1.html", "v2.html"]

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


def test_versions_content_restore_and_verify(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, _, _):
        _create(client)
        second = _create(client, html="<h1>V2</h1>")
        assert second.status_code == 200

        versions = client.get("/api/artifacts/demo-art/versions", headers=AUTH)
        assert versions.status_code == 200
        listed = versions.json()["versions"]
        assert [item["versionId"] for item in listed] == ["v2", "v1"]
        assert listed[0]["uri"] == "ui://demo-art/v2/index.html"
        assert listed[0]["immutable"] is True
        assert listed[0]["mimeType"] == "text/html;profile=mcp-app"
        assert len(listed[0]["sha256"]) == 64

        v1 = client.get(
            "/api/artifacts/demo-art/versions/v1/content", headers=AUTH
        )
        assert v1.status_code == 200
        assert v1.headers["content-type"].startswith("text/html")
        assert "<h1>Hi</h1>" in v1.text

        restored = client.post(
            "/api/artifacts/demo-art/versions/v1/restore", headers=AUTH
        )
        assert restored.status_code == 200, restored.text
        payload = restored.json()
        assert payload["revision"] == "v3"
        assert len(payload["versionRefs"]) == 3
        assert payload["versionCount"] == 3
        assert "<h1>Hi</h1>" in client.get(
            "/api/artifacts/demo-art/content", headers=AUTH
        ).text

        verified = client.post("/api/artifacts/demo-art/verify", headers=AUTH)
        assert verified.status_code == 200
        assert verified.json()["ok"] is True
        assert verified.json()["version"] == "v3"

        # No filesystem path leaks through the DTOs.
        assert str(tmp_path) not in restored.text

        assert (
            client.get("/api/artifacts/demo-art/versions").status_code == 401
        )
        bad = client.get(
            "/api/artifacts/demo-art/versions/v0/content", headers=AUTH
        )
        assert bad.status_code == 400
        traversal = client.get(
            "/api/artifacts/demo-art/versions/..%2Fv1/content", headers=AUTH
        )
        assert traversal.status_code in {400, 404}
        missing = client.get(
            "/api/artifacts/demo-art/versions/v99/content", headers=AUTH
        )
        assert missing.status_code == 404
        missing_restore = client.post(
            "/api/artifacts/absent/versions/v1/restore", headers=AUTH
        )
        assert missing_restore.status_code == 404


def test_artifact_change_event_is_published(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, container, _):
        subscription = container.event_bus.subscribe()
        try:
            _create(client)
            payload = subscription.next(0.5)
        finally:
            container.event_bus.unsubscribe(subscription)
    assert payload is not None
    assert payload["type"] == "artifacts.changed"
    assert payload["artifactIds"] == ["demo-art"]
    assert payload["reason"] == "created"


ARTIFACT_TURN_TEXT = (
    "Here is the artifact.\n\n"
    "```artifact-html\n"
    "---\n"
    "title: SSE Demo\n"
    "---\n"
    "<h1>From turn</h1>\n"
    "```\n"
)


def _artifact_script(text: str):
    def factory(turn_id: str, session_id: str) -> tuple[DomainEvent, ...]:
        return (
            TurnStarted(turn_id=turn_id, session_id=session_id, model="fake"),
            TextDelta(turn_id=turn_id, session_id=session_id, text=text),
            TurnCompleted(
                turn_id=turn_id,
                session_id=session_id,
                stop_reason="end_turn",
                text=text,
            ),
        )

    return factory


def _sse_names(text: str) -> list[str]:
    names: list[str] = []
    for block in text.strip().split("\n\n"):
        for line in block.splitlines():
            if line.startswith("event: "):
                names.append(line[len("event: ") :])
    return names


def test_sse_artifact_events_between_message_and_turn_completed(
    tmp_path: Path,
) -> None:
    with panel_client(tmp_path) as (client, container, _):
        container.turn_service = TurnService(
            sessions=container.sessions,
            turns=container.sessions,
            refs=container.sessions,
            engine=FakeEngine(
                script_factory=_artifact_script(ARTIFACT_TURN_TEXT)
            ),
            settings=container.settings_store,
            clock=container.clock,
            events=container.event_bus,
            artifacts=container.artifact_store,
        )
        created = client.post(
            "/api/sessions", headers=AUTH, json={"title": "sse"}
        ).json()
        response = client.post(
            f"/api/turns/{uuid.uuid4()}/stream",
            headers=AUTH,
            json={"sessionId": created["id"], "text": "make one"},
        )
        assert response.status_code == 200, response.text
        names = _sse_names(response.text)
        assert names[-3:] == [
            "message.completed",
            "artifact.created",
            "turn.completed",
        ]

        listing = client.get("/api/artifacts", headers=AUTH)
        assert [item["id"] for item in listing.json()["artifacts"]] == [
            "sse-demo"
        ]
        artifact = listing.json()["artifacts"][0]
        assert artifact["sessionId"] == created["id"]
        assert artifact["revision"] == "v1"
        assert artifact["versionCount"] == 1

        raw = response.text
        for forbidden in ("manifest.json", "versions/v1.html", str(tmp_path)):
            assert forbidden not in raw


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
