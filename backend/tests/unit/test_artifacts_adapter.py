"""Unit tests for the filesystem artifact store."""

from __future__ import annotations

import json
import threading
import zipfile
from pathlib import Path

import pytest

from autoagent_backend.adapters.artifacts.fs_store import (
    FilesystemArtifactStore,
    _extract_meta,
    _html_shell,
    _slugify,
    _strip_meta,
)
from autoagent_backend.application.artifact_materializer import (
    build_artifact_document,
    sha256_text,
)
from autoagent_backend.domain.errors import ArtifactNotFound, InvalidInput
from autoagent_backend.domain.models import ArtifactCreate, ArtifactDraft

from ..fixtures.panels import FixedClock


def test_html_shell_wraps_fragments_and_round_trips_meta() -> None:
    document = _html_shell("Title", "<p>body</p>", "desc")
    assert document.startswith("<!doctype html>")
    assert "<p>body</p>" in document
    assert _extract_meta(document) == {
        "name": "Title",
        "schemaVersion": 1,
        "description": "desc",
    }
    assert "autowork-artifact-meta" not in _strip_meta(document)

    full = _html_shell("T", "<html><head></head><body>x</body></html>", "")
    assert full.count("autowork-artifact-meta") == 1


def test_slugify_and_create_versions(tmp_path: Path) -> None:
    assert _slugify(" Hello, World! ") == "hello-world"
    assert _slugify("***") == "artifact"

    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    first = store.create(ArtifactCreate(html="<p>one</p>", title="Same"))
    second = store.create(ArtifactCreate(html="<p>two</p>", title="Same"))
    assert first.id == second.id == "same"
    assert second.versions == (first.updated_at,)
    assert store.content("same").find("<p>two</p>") >= 0
    assert store.get("same").title == "Same"
    assert store.mark_opened("same").last_opened_at is not None


def test_export_and_import(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    created = store.create(
        ArtifactCreate(html="<h1>Hi</h1>", title="Demo", description="d")
    )
    target = tmp_path / "demo.zip"
    assert store.export(created.id, str(target)) == str(target)
    assert zipfile.is_zipfile(target)

    imported = store.import_archive(str(target))
    assert imported.id == "demo"
    assert len(imported.versions) == 1


def test_import_rejects_unsafe_archives(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    missing = tmp_path / "missing.zip"
    with pytest.raises(InvalidInput):
        store.import_archive(str(missing))

    text = tmp_path / "plain.zip"
    text.write_text("not a zip", encoding="utf-8")
    with pytest.raises(InvalidInput):
        store.import_archive(str(text))

    slip = tmp_path / "slip.zip"
    with zipfile.ZipFile(slip, "w") as archive:
        archive.writestr("../escape.txt", "x")
    with pytest.raises(InvalidInput):
        store.import_archive(str(slip))
    assert not (tmp_path / "artifacts" / "escape.txt").exists()


def test_invalid_ids_never_derive_paths(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    for artifact_id in ("../x", ".hidden", "a/b", ""):
        with pytest.raises(InvalidInput):
            store.get(artifact_id)


def _draft(title: str, body: str) -> ArtifactDraft:
    document = build_artifact_document(title, body, "")
    return ArtifactDraft(
        html=document,
        title=title,
        description="",
        sha256=sha256_text(document),
        size_bytes=len(document.encode("utf-8")),
    )


def test_manifest_schema_current_and_immutable_versions(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    first = store.create(ArtifactCreate(html="<p>one</p>", title="Doc"))
    assert first.revision == "v1"
    v1_file = tmp_path / "artifacts" / "doc" / "versions" / "v1.html"
    v1_content = v1_file.read_text(encoding="utf-8")

    second = store.create(ArtifactCreate(html="<p>two</p>", title="Doc"))
    assert second.revision == "v2"
    assert second.version_refs[0].version_id == "v2"
    assert second.versions == (first.updated_at,)
    # The immutable snapshot is never rewritten.
    assert v1_file.read_text(encoding="utf-8") == v1_content

    manifest = json.loads(
        (tmp_path / "artifacts" / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["schema"] == "autoagent.ui/1"
    record = manifest["artifacts"][0]
    assert record["id"] == "doc"
    assert record["current"] == "v2"
    assert [item["versionId"] for item in record["history"]] == ["v1", "v2"]
    version = record["history"][0]
    assert version["uri"] == "ui://doc/v1/index.html"
    assert version["mimeType"] == "text/html;profile=mcp-app"
    assert version["immutable"] is True
    assert version["entry"] == "index.html"
    assert version["csp"] == {
        "connectDomains": [],
        "resourceDomains": [],
        "frameDomains": [],
    }
    assert version["permissions"] == {}
    assert version["displayModes"] == ["inline", "fullscreen"]
    assert version["sha256"] == sha256_text(v1_content)


def test_versions_content_restore_and_verify(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    first = store.create(ArtifactCreate(html="<p>one</p>", title="Doc"))
    store.create(ArtifactCreate(html="<p>two</p>", title="Doc"))

    listed = store.versions("doc")
    assert [item.version_id for item in listed] == ["v2", "v1"]
    assert "<p>one</p>" in store.version_content("doc", "v1")
    assert "<p>two</p>" in store.version_content("doc", "v2")

    restored = store.restore("doc", "v1")
    assert restored.revision == "v3"
    assert [item.version_id for item in restored.version_refs] == ["v3", "v2", "v1"]
    assert "<p>one</p>" in store.content("doc")
    assert store.versions("doc")[2].version_id == "v1"
    assert first.revision == "v1"

    verified = store.verify("doc")
    assert verified.ok is True
    assert verified.version_id == "v3"
    assert verified.sha256 == verified.expected_sha256

    (tmp_path / "artifacts" / "doc" / "index.html").write_text(
        "<p>tampered</p>", encoding="utf-8"
    )
    assert store.verify("doc").ok is False


def test_dedupe_by_sha256(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    draft = _draft("Doc", "<p>same</p>")
    first = store.save_materialized(
        draft, session_id="s1", turn_id="t1", message_id="m1"
    )
    second = store.save_materialized(
        draft, session_id="s1", turn_id="t2", message_id="m2"
    )
    assert first.created is True and first.changed is True
    assert second.created is False and second.changed is False
    assert second.artifact.revision == "v1"
    assert len(store.versions("doc")) == 1


def test_slug_collisions_and_session_identity(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    first = store.create(ArtifactCreate(html="<p>a</p>", title="Hello World"))
    second = store.create(ArtifactCreate(html="<p>b</p>", title="Hello, World!"))
    assert first.id == "hello-world"
    assert second.id == "hello-world-2"

    # Materialized artifacts update by (title, session) and never overwrite a
    # same-title artifact from another session.
    one = store.save_materialized(
        _draft("Report", "<p>one</p>"),
        session_id="session-a",
        turn_id="t1",
        message_id="m1",
    )
    two = store.save_materialized(
        _draft("Report", "<p>two</p>"),
        session_id="session-b",
        turn_id="t2",
        message_id="m2",
    )
    assert one.artifact.id == "report"
    assert two.artifact.id == "report-2"
    assert two.created is True

    again = store.save_materialized(
        _draft("Report", "<p>three</p>"),
        session_id="session-a",
        turn_id="t3",
        message_id="m3",
    )
    assert again.artifact.id == "report"
    assert again.created is False
    assert again.artifact.revision == "v2"


def test_unknown_manifest_fields_are_preserved(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(parents=True)
    manifest = {
        "schema": "autoagent.ui/1",
        "futureTopLevel": {"keep": True},
        "artifacts": [
            {
                "id": "doc",
                "artifactId": "doc",
                "title": "Doc",
                "description": "",
                "createdAt": 1,
                "updatedAt": 1,
                "futureRecordField": 42,
                "history": [],
                "current": "v1",
            }
        ],
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    store = FilesystemArtifactStore(root, FixedClock())
    store.create(ArtifactCreate(html="<p>new</p>", title="Other"))

    reloaded = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    assert reloaded["futureTopLevel"] == {"keep": True}
    doc = next(item for item in reloaded["artifacts"] if item["id"] == "doc")
    assert doc["futureRecordField"] == 42


def test_concurrent_create_keeps_all_records(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    errors: list[BaseException] = []

    def create(index: int) -> None:
        try:
            store.create(
                ArtifactCreate(html=f"<p>{index}</p>", title=f"Doc {index}")
            )
        except BaseException as exc:  # pragma: no cover - failure reporting
            errors.append(exc)

    threads = [threading.Thread(target=create, args=(index,)) for index in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    ids = {item.id for item in store.list()}
    assert ids == {f"doc-{index}" for index in range(20)}


def test_capabilities_persist_in_manifest(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    store = FilesystemArtifactStore(root, FixedClock())
    created = store.create(ArtifactCreate(html="<p>x</p>", title="Doc"))
    assert created.mcp_tools == ()
    assert created.allow_external is False

    updated = store.set_capabilities(
        "doc", ("echo", "search"), allow_external=True
    )
    assert updated.mcp_tools == ("echo", "search")
    assert updated.allow_external is True

    # A fresh store reads the persisted manifest, not in-memory state.
    reloaded = FilesystemArtifactStore(root, FixedClock()).get("doc")
    assert reloaded.mcp_tools == ("echo", "search")
    assert reloaded.allow_external is True

    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    record = manifest["artifacts"][0]
    assert record["mcpTools"] == ["echo", "search"]
    assert record["allowExternal"] is True


def test_version_ids_are_validated(tmp_path: Path) -> None:
    store = FilesystemArtifactStore(tmp_path / "artifacts", FixedClock())
    store.create(ArtifactCreate(html="<p>x</p>", title="Doc"))
    for version_id in ("../v1", "v0", "v1/../../x", "1"):
        with pytest.raises(InvalidInput):
            store.version_content("doc", version_id)
        with pytest.raises(InvalidInput):
            store.restore("doc", version_id)
    with pytest.raises(ArtifactNotFound):
        store.version_content("doc", "v99")
    with pytest.raises(ArtifactNotFound):
        store.restore("doc", "v99")
