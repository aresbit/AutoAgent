"""Reference tests for ``file_service.SafeFileService``.

Run from this directory:

    python -m pytest -q test_file_service.py
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from file_service import (
    AlreadyExists,
    DirectoryNotEmpty,
    HashMismatch,
    InvalidPath,
    NotFound,
    RootNotAllowed,
    SafeFileService,
    SymlinkNotAllowed,
    TooLarge,
)

MAX = 1024


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return workspace


@pytest.fixture()
def service(root: Path) -> SafeFileService:
    allowed = {root.resolve()}

    def resolve(root_id: str) -> Path | None:
        return root if root_id == "workspace" else None

    return SafeFileService(
        resolve,
        lambda candidate: candidate in allowed,
        max_read_bytes=MAX,
        max_write_bytes=MAX,
        max_copy_bytes=MAX * 4,
        max_copy_entries=100,
    )


def _write(root: Path, rel: str, data: bytes) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


# -- list / read / stat ----------------------------------------------------


def test_list_read_and_stat(service: SafeFileService, root: Path) -> None:
    service.mkdir("workspace", "sub")
    service.write_atomic("workspace", "b.txt", b"bravo")
    service.create_file("workspace", "a.txt", b"alpha")
    _write(root, ".hidden", b"x")

    listing = service.list_dir("workspace", "")
    assert [entry.name for entry in listing.entries] == ["sub", "a.txt", "b.txt"]
    assert listing.total == 3
    assert listing.next_cursor is None
    assert listing.entries[0].kind == "directory"

    with_hidden = service.list_dir("workspace", "", hidden=True)
    assert ".hidden" in [entry.name for entry in with_hidden.entries]

    text = service.read_text("workspace", "a.txt")
    assert text.text == "alpha"
    assert text.encoding == "utf-8"
    assert text.binary is False
    assert text.line_count == 1
    assert text.sha256 == hashlib.sha256(b"alpha").hexdigest()

    info = service.stat("workspace", "a.txt")
    assert info.kind == "file"
    assert info.size == 5
    assert info.path == "a.txt"
    assert info.mode & 0o777 == 0o600


def test_list_pagination(service: SafeFileService) -> None:
    service.mkdir("workspace", "many")
    for index in range(5):
        service.write_atomic("workspace", f"many/{index}.txt", b"x")

    names: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        page = service.list_dir("workspace", "many", cursor=cursor, limit=2)
        names.extend(entry.name for entry in page.entries)
        pages += 1
        cursor = page.next_cursor
        if cursor is None:
            break
    assert names == [f"{index}.txt" for index in range(5)]
    assert pages == 3


def test_stat_symlink_is_described_not_followed(
    service: SafeFileService, root: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"secret")
    (root / "link").symlink_to(outside)

    info = service.stat("workspace", "link")
    assert info.kind == "symlink"
    assert info.is_symlink is True
    assert service.list_dir("workspace", "").entries[0].kind == "symlink"


# -- path policy -----------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "..",
        "../outside",
        "a/../../outside",
        "/etc/passwd",
        "C:\\Windows\\system32",
        "a\\b",
        "a//b",
        "./a",
        "a/",
        "a/\x00b",
        "a\nb",
        "",
    ],
)
def test_traversal_and_absolute_paths_rejected(
    service: SafeFileService, bad: str
) -> None:
    with pytest.raises(InvalidPath):
        service.read_text("workspace", bad)


def test_root_not_allowed(root: Path) -> None:
    service = SafeFileService(lambda _root_id: None, lambda _candidate: True)
    with pytest.raises(RootNotAllowed):
        service.list_dir("session:missing", "")

    denied = SafeFileService(
        lambda _root_id: root, lambda _candidate: False
    )
    with pytest.raises(RootNotAllowed):
        denied.list_dir("workspace", "")

    relative = SafeFileService(
        lambda _root_id: Path("relative/root"), lambda _candidate: True
    )
    with pytest.raises(RootNotAllowed):
        relative.list_dir("workspace", "")


def test_symlink_escape_rejected(
    service: SafeFileService, root: Path, tmp_path: Path
) -> None:
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    secret = outside_dir / "secret.txt"
    secret.write_bytes(b"secret")
    (root / "escape").symlink_to(outside_dir)
    (root / "inside.txt").write_bytes(b"inside")
    (root / "inside-link").symlink_to(root / "inside.txt")

    with pytest.raises(SymlinkNotAllowed):
        service.read_text("workspace", "escape/secret.txt")
    with pytest.raises(SymlinkNotAllowed):
        service.read_text("workspace", "inside-link")

    # Deletion removes the link itself, never the target.
    service.delete("workspace", "escape")
    assert secret.exists()
    assert not (root / "escape").exists()


def test_copy_rejects_symlinks(service: SafeFileService, root: Path) -> None:
    (root / "bad").mkdir()
    (root / "bad" / "target.txt").write_bytes(b"x")
    (root / "bad" / "link").symlink_to(root / "bad" / "target.txt")

    with pytest.raises(SymlinkNotAllowed):
        service.copy("workspace", "bad", "bad-copy")
    assert not (root / "bad-copy").exists()


# -- size / binary ---------------------------------------------------------


def test_oversized_file_rejected(service: SafeFileService, root: Path) -> None:
    _write(root, "large.bin", b"x" * (MAX + 1))
    with pytest.raises(TooLarge):
        service.read_bytes("workspace", "large.bin")
    with pytest.raises(TooLarge):
        service.read_text("workspace", "large.bin")
    with pytest.raises(TooLarge):
        service.write_atomic("workspace", "large2.bin", b"x" * (MAX + 1))


def test_binary_detection(service: SafeFileService, root: Path) -> None:
    _write(root, "nul.bin", b"abc\x00def")
    result = service.read_text("workspace", "nul.bin")
    assert result.binary is True
    assert result.text is None
    assert result.encoding is None

    _write(root, "bad-utf8.bin", b"\xff\xfe\xfd")
    result = service.read_text("workspace", "bad-utf8.bin")
    assert result.binary is True
    assert result.text is None


def test_line_limit_marks_truncation(service: SafeFileService) -> None:
    service.write_atomic("workspace", "lines.txt", b"a\nb\nc\n")
    result = service.read_text("workspace", "lines.txt", max_lines=2)
    assert result.truncated is True
    assert result.line_count == 3
    assert result.text == "a\nb"
    # The hash still covers the whole file, so a save from the truncated buffer
    # is rejected by the expected-hash guard.
    assert result.sha256 == hashlib.sha256(b"a\nb\nc\n").hexdigest()


# -- writes ----------------------------------------------------------------


def test_atomic_write_and_hash_guard(
    service: SafeFileService, root: Path
) -> None:
    first = service.write_atomic("workspace", "note.txt", b"one")
    assert first.created is True
    assert first.sha256 == hashlib.sha256(b"one").hexdigest()

    with pytest.raises(HashMismatch):
        service.write_atomic(
            "workspace", "note.txt", b"two", expected_sha256="0" * 64
        )
    assert (root / "note.txt").read_bytes() == b"one"

    second = service.write_atomic(
        "workspace", "note.txt", b"two", expected_sha256=first.sha256
    )
    assert second.created is False
    assert (root / "note.txt").read_bytes() == b"two"
    assert not [
        item.name for item in root.iterdir() if item.name.startswith(".autoagent-tmp-")
    ]

    with pytest.raises(HashMismatch):
        service.write_atomic(
            "workspace", "missing.txt", b"x", expected_sha256=first.sha256
        )


def test_create_file_never_clobbers(service: SafeFileService) -> None:
    service.create_file("workspace", "one.txt", b"one")
    with pytest.raises(AlreadyExists):
        service.create_file("workspace", "one.txt", b"two")
    replaced = service.create_file("workspace", "one.txt", b"two", overwrite=True)
    assert replaced.size == 3
    assert service.read_text("workspace", "one.txt").text == "two"


def test_write_stream_atomic(service: SafeFileService, root: Path) -> None:
    result = service.write_stream_atomic(
        "workspace", "stream.txt", io.BytesIO(b"streamed")
    )
    assert result.sha256 == hashlib.sha256(b"streamed").hexdigest()
    assert (root / "stream.txt").read_bytes() == b"streamed"

    with pytest.raises(AlreadyExists):
        service.write_stream_atomic(
            "workspace", "stream.txt", io.BytesIO(b"x"), overwrite=False
        )

    with pytest.raises(HashMismatch):
        service.write_stream_atomic(
            "workspace",
            "stream.txt",
            io.BytesIO(b"changed"),
            expected_sha256="0" * 64,
        )
    assert (root / "stream.txt").read_bytes() == b"streamed"


def test_read_bytes_range(service: SafeFileService) -> None:
    service.write_atomic("workspace", "digits.txt", b"0123456789")
    full = service.read_bytes("workspace", "digits.txt")
    assert full.data == b"0123456789"
    assert full.sha256 == hashlib.sha256(b"0123456789").hexdigest()

    part = service.read_bytes("workspace", "digits.txt", offset=2, length=3)
    assert part.data == b"234"
    assert part.sha256 is None
    assert part.offset == 2


# -- mutations -------------------------------------------------------------


def test_mkdir_create_rename_delete(service: SafeFileService, root: Path) -> None:
    service.mkdir("workspace", "a/b/c", parents=True)
    assert (root / "a" / "b" / "c").is_dir()

    service.write_atomic("workspace", "a/file.txt", b"one")
    moved = service.rename("workspace", "a/file.txt", "a/renamed.txt")
    assert moved.path == "a/renamed.txt"
    assert not (root / "a" / "file.txt").exists()

    service.write_atomic("workspace", "a/target.txt", b"target")
    with pytest.raises(AlreadyExists):
        service.rename("workspace", "a/renamed.txt", "a/target.txt")
    service.rename("workspace", "a/renamed.txt", "a/target.txt", overwrite=True)
    assert (root / "a" / "target.txt").read_bytes() == b"one"

    with pytest.raises(DirectoryNotEmpty):
        service.delete("workspace", "a")
    service.delete("workspace", "a/target.txt")
    service.delete("workspace", "a/b/c")
    service.delete("workspace", "a/b")
    service.delete("workspace", "a")

    with pytest.raises(NotFound):
        service.stat("workspace", "a")


def test_copy_and_move(service: SafeFileService, root: Path) -> None:
    service.write_atomic("workspace", "src.txt", b"copy me")
    service.copy("workspace", "src.txt", "copied.txt")
    assert (root / "copied.txt").read_bytes() == b"copy me"

    service.mkdir("workspace", "tree/sub", parents=True)
    service.write_atomic("workspace", "tree/sub/x.txt", b"x")
    service.copy("workspace", "tree", "tree-copy")
    assert (root / "tree-copy" / "sub" / "x.txt").read_bytes() == b"x"

    with pytest.raises(InvalidPath):
        service.copy("workspace", "tree", "tree/newdir")

    service.move("workspace", "copied.txt", "moved.txt")
    assert not (root / "copied.txt").exists()
    assert (root / "moved.txt").read_bytes() == b"copy me"


def test_move_directory_into_itself(service: SafeFileService) -> None:
    service.mkdir("workspace", "dir/sub", parents=True)
    with pytest.raises(InvalidPath):
        service.move("workspace", "dir", "dir/sub/dir")


def test_absolute_path_export(service: SafeFileService, root: Path) -> None:
    service.write_atomic("workspace", "export.txt", b"x")
    absolute = service.absolute_path("workspace", "export.txt")
    assert absolute == str((root / "export.txt").resolve())

    with pytest.raises(InvalidPath):
        service.absolute_path("workspace", "../export.txt")


def test_temp_files_are_ignored_in_listing(
    service: SafeFileService, root: Path
) -> None:
    _write(root, ".autoagent-tmp-stale", b"partial")
    assert service.list_dir("workspace", "", hidden=True).entries == ()


def test_permissions_preserved_on_overwrite(
    service: SafeFileService, root: Path
) -> None:
    target = root / "mode.txt"
    target.write_bytes(b"one")
    os.chmod(target, 0o640)
    service.write_atomic("workspace", "mode.txt", b"two")
    assert (target.stat().st_mode & 0o777) == 0o640
