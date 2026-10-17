"""Unit tests for the filesystem artifact store."""

from __future__ import annotations

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
from autoagent_backend.domain.errors import InvalidInput
from autoagent_backend.domain.models import ArtifactCreate

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
