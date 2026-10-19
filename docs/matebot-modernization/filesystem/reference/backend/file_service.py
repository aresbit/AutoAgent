"""Workspace-scoped, framework-free filesystem service.

This module is a reference implementation intended to be copied to
``backend/src/autoagent_backend/adapters/files/safe_file_service.py``.  It uses
only the Python standard library and knows nothing about FastAPI, pydantic or
the AutoAgent container.

Design invariants
-----------------
* Callers address files with a *root id* plus a POSIX-style path **relative to
  that root**.  Absolute paths are never accepted from clients.
* Roots are supplied by an injected ``root_resolver``.  A second injected
  predicate, ``is_allowed_root``, is the final authority on whether the
  resolved root may be touched.  Approval policy (workspace vs. session roots,
  native-dialog grants, read-only roots) lives with the caller.
* ``Path.resolve(strict=...)`` canonicalises the candidate, and
  ``os.path.commonpath`` proves containment.  Symbolic links are rejected at
  every component by default (``lstat`` walking), including the final one.
* Reads and writes re-check after resolution and use ``O_NOFOLLOW`` where the
  platform provides it.  On Linux the opened descriptor is additionally checked
  through ``/proc/self/fd``.  Residual TOCTOU windows are documented in
  ``README.md``; a complete fix needs ``openat2(RESOLVE_BENEATH)``.
* Writes are atomic: a same-directory temporary file is fsynced and then
  ``os.replace``d over the target.  Optional SHA-256 compare-and-swap prevents
  clobbering concurrent editor changes.
* No shell, no subprocess, no path interpolation into commands.

Pre/post conditions are written for every public method.  Errors are typed and
carry a stable ``code`` plus the HTTP status the API layer should map them to.
"""

from __future__ import annotations

import base64
import contextlib
import errno
import hashlib
import hmac
import mimetypes
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Literal

EntryKind = Literal["file", "directory", "symlink"]

_TEMP_PREFIX = ".autoagent-tmp-"
_MAX_PATH_CHARS = 4096
_MAX_SEGMENT_CHARS = 255
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_COPY_CHUNK = 64 * 1024
_LINK_MODE = getattr(os, "O_NOFOLLOW", 0)

DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_WRITE_BYTES = 1024 * 1024
DEFAULT_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_LINES = 20_000
DEFAULT_MAX_SCAN_ENTRIES = 50_000
DEFAULT_MAX_COPY_ENTRIES = 10_000
DEFAULT_MAX_COPY_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_COPY_DEPTH = 64


# ---------------------------------------------------------------------------
# Typed failures
# ---------------------------------------------------------------------------


class FileServiceError(Exception):
    """Base class for expected filesystem-policy failures.

    Pre: ``message`` is already safe to show to a local desktop client.
    Post: ``code`` is a stable upper-snake-case identifier and ``status`` is an
          HTTP status in the 4xx/5xx range.
    """

    code = "FILE_SERVICE_ERROR"
    status = 400

    def __init__(self, message: str = "") -> None:
        super().__init__(message)
        self.message = message or self.code.replace("_", " ").capitalize()


class InvalidPath(FileServiceError):
    code = "INVALID_PATH"
    status = 400


class RootNotAllowed(FileServiceError):
    code = "ROOT_NOT_ALLOWED"
    status = 403


class RootEscape(FileServiceError):
    code = "PATH_ESCAPES_ROOT"
    status = 403


class SymlinkNotAllowed(FileServiceError):
    code = "SYMLINK_NOT_ALLOWED"
    status = 403


class NotFound(FileServiceError):
    code = "FILE_NOT_FOUND"
    status = 404


class NotAFile(FileServiceError):
    code = "NOT_A_FILE"
    status = 409


class NotADirectory(FileServiceError):
    code = "NOT_A_DIRECTORY"
    status = 409


class AlreadyExists(FileServiceError):
    code = "FILE_EXISTS"
    status = 409


class DirectoryNotEmpty(FileServiceError):
    code = "DIRECTORY_NOT_EMPTY"
    status = 409


class HashMismatch(FileServiceError):
    code = "HASH_MISMATCH"
    status = 409


class CrossDeviceMove(FileServiceError):
    code = "CROSS_DEVICE_MOVE"
    status = 409


class TooLarge(FileServiceError):
    code = "FILE_TOO_LARGE"
    status = 413


class TooManyEntries(FileServiceError):
    code = "TOO_MANY_ENTRIES"
    status = 413


class RevealUnavailable(FileServiceError):
    code = "REVEAL_UNAVAILABLE"
    status = 501


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FileEntry:
    """One directory entry.  ``path`` is relative to the root."""

    name: str
    path: str
    kind: EntryKind
    size: int
    mtime_ms: int
    hidden: bool
    is_symlink: bool


@dataclass(frozen=True, slots=True)
class DirListing:
    root: str
    path: str
    entries: tuple[FileEntry, ...]
    next_cursor: str | None
    total: int
    hidden: bool


@dataclass(frozen=True, slots=True)
class FileStat:
    root: str
    path: str
    name: str
    kind: EntryKind
    size: int
    mtime_ms: int
    mode: int
    hidden: bool
    is_symlink: bool


@dataclass(frozen=True, slots=True)
class FileBytes:
    root: str
    path: str
    data: bytes
    total_size: int
    offset: int
    mime: str
    mtime_ms: int
    sha256: str | None


@dataclass(frozen=True, slots=True)
class FileText:
    root: str
    path: str
    text: str | None
    binary: bool
    encoding: str | None
    size: int
    line_count: int
    truncated: bool
    mtime_ms: int
    mime: str
    sha256: str | None


@dataclass(frozen=True, slots=True)
class WriteResult:
    root: str
    path: str
    size: int
    sha256: str
    mtime_ms: int
    created: bool


class SafeFileService:
    """Policy-enforcing filesystem operations beneath approved roots."""

    def __init__(
        self,
        root_resolver: Callable[[str], Path | None],
        is_allowed_root: Callable[[Path], bool],
        *,
        default_root_id: str = "workspace",
        is_writable_root: Callable[[str], bool] | None = None,
        max_read_bytes: int = DEFAULT_MAX_READ_BYTES,
        max_write_bytes: int = DEFAULT_MAX_WRITE_BYTES,
        max_thumbnail_bytes: int = DEFAULT_MAX_THUMBNAIL_BYTES,
        max_lines: int = DEFAULT_MAX_LINES,
        max_scan_entries: int = DEFAULT_MAX_SCAN_ENTRIES,
        max_copy_entries: int = DEFAULT_MAX_COPY_ENTRIES,
        max_copy_bytes: int = DEFAULT_MAX_COPY_BYTES,
        max_copy_depth: int = DEFAULT_MAX_COPY_DEPTH,
    ) -> None:
        """Build the service.

        Pre: every numeric limit is positive and every callable is synchronous.
        Post: constructing the service performs no filesystem I/O and resolves
              no roots; policy changes take effect on the next call only for
              ``is_allowed_root`` / ``is_writable_root``.
        """

        for name, value in (
            ("max_read_bytes", max_read_bytes),
            ("max_write_bytes", max_write_bytes),
            ("max_thumbnail_bytes", max_thumbnail_bytes),
            ("max_lines", max_lines),
            ("max_scan_entries", max_scan_entries),
            ("max_copy_entries", max_copy_entries),
            ("max_copy_bytes", max_copy_bytes),
            ("max_copy_depth", max_copy_depth),
        ):
            if value <= 0:
                raise ValueError(f"{name} must be positive")
        self._root_resolver = root_resolver
        self._is_allowed_root = is_allowed_root
        self._default_root_id = default_root_id
        self._is_writable_root = is_writable_root
        self._max_read_bytes = max_read_bytes
        self._max_write_bytes = max_write_bytes
        self._max_thumbnail_bytes = max_thumbnail_bytes
        self._max_lines = max_lines
        self._max_scan_entries = max_scan_entries
        self._max_copy_entries = max_copy_entries
        self._max_copy_bytes = max_copy_bytes
        self._max_copy_depth = max_copy_depth

    # -- roots -------------------------------------------------------------

    def default_root_id(self) -> str:
        """Return the root id used when a request omits one."""

        return self._default_root_id

    @property
    def max_thumbnail_bytes(self) -> int:
        """Maximum size the thumbnail route may read in one response."""

        return self._max_thumbnail_bytes

    @property
    def max_write_bytes(self) -> int:
        """Maximum size accepted by the atomic writers."""

        return self._max_write_bytes

    def _root(self, root_id: str | None, *, write: bool = False) -> Path:
        """Resolve and authorise a root id.

        Pre: ``root_id`` is an opaque id, not a filesystem path.
        Post: returns an absolute, existing, allowed directory.  Never returns a
              symlink (``resolve`` canonicalises it); only the canonical path is
              checked against the allowlist.
        Raises: ``RootNotAllowed`` or ``NotFound``.
        """

        requested = root_id or self._default_root_id
        if not requested:
            raise RootNotAllowed("a root id is required")
        try:
            raw = self._root_resolver(requested)
        except Exception as exc:
            raise RootNotAllowed("root is not available") from exc
        if raw is None:
            raise RootNotAllowed("root is not allowed")
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            raise RootNotAllowed("root must be absolute")
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as exc:
            raise NotFound("root does not exist") from exc
        if not resolved.is_dir():
            raise RootNotAllowed("root is not a directory")
        try:
            allowed = self._is_allowed_root(resolved)
        except Exception as exc:
            raise RootNotAllowed("root is not allowed") from exc
        if not allowed:
            raise RootNotAllowed("root is not allowed")
        if write and self._is_writable_root is not None:
            try:
                writable = self._is_writable_root(requested)
            except Exception as exc:
                raise RootNotAllowed("root is not writable") from exc
            if not writable:
                raise RootNotAllowed("root is read-only")
        return resolved

    # -- path policy -------------------------------------------------------

    @staticmethod
    def _split(rel: str, *, allow_root: bool) -> tuple[str, ...]:
        """Validate a relative path and split it into segments.

        Pre: ``rel`` is untrusted client input.
        Post: returns a tuple with no empty, ``.`` or ``..`` segments, no
              absolute prefix, no backslash and no NUL/control newlines.
        Raises: ``InvalidPath``.
        """

        if not isinstance(rel, str):
            raise InvalidPath("path must be a string")
        if "\x00" in rel or "\n" in rel or "\r" in rel:
            raise InvalidPath("path contains a forbidden character")
        if len(rel) > _MAX_PATH_CHARS:
            raise InvalidPath("path is too long")
        if "\\" in rel:
            raise InvalidPath("use '/' as the path separator")
        if rel.startswith("/"):
            raise InvalidPath("absolute paths are not accepted")
        if rel == "":
            if allow_root:
                return ()
            raise InvalidPath("a file path is required")
        if len(rel) >= 2 and rel[1] == ":":
            raise InvalidPath("drive-qualified paths are not accepted")
        parts = rel.split("/")
        for part in parts:
            if part in {"", ".", ".."}:
                raise InvalidPath("invalid path segment")
            if len(part) > _MAX_SEGMENT_CHARS:
                raise InvalidPath("path segment is too long")
        return tuple(parts)

    @staticmethod
    def _inside(root: Path, candidate: Path) -> bool:
        """Return whether ``candidate`` is lexically inside ``root``."""

        try:
            return os.path.commonpath((str(root), str(candidate))) == str(root)
        except ValueError:
            return False

    @staticmethod
    def _entry_kind(mode: int) -> EntryKind:
        if stat.S_ISLNK(mode):
            return "symlink"
        if stat.S_ISDIR(mode):
            return "directory"
        return "file"

    @staticmethod
    def _hidden(name: str) -> bool:
        return name.startswith(".")

    def _walk(
        self,
        root: Path,
        parts: tuple[str, ...],
        *,
        must_exist: bool,
        allow_final_symlink: bool = False,
    ) -> Path:
        """Walk each component with ``lstat`` and reject links.

        Pre: ``parts`` came from ``_split``; ``root`` is canonical.
        Post: returns the lexical path.  Missing tails are allowed only when
              ``must_exist`` is false.
        Raises: ``SymlinkNotAllowed``, ``NotFound``, ``NotADirectory``.
        """

        current = root
        last = len(parts) - 1
        for index, part in enumerate(parts):
            current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError as exc:
                if must_exist:
                    raise NotFound("path does not exist") from exc
                return current
            except NotADirectoryError as exc:
                raise NotADirectory("a path component is not a directory") from exc
            except OSError as exc:
                raise InvalidPath("path cannot be inspected") from exc
            if stat.S_ISLNK(info.st_mode) and not (
                allow_final_symlink and index == last
            ):
                raise SymlinkNotAllowed("symbolic links are not allowed")
            if index < last and not stat.S_ISDIR(info.st_mode):
                raise NotADirectory("a path component is not a directory")
        return current

    def _resolve_existing(
        self,
        root: Path,
        parts: tuple[str, ...],
        *,
        allow_final_symlink: bool = False,
    ) -> Path:
        """Return a canonical existing path proven to be inside ``root``.

        Pre: ``root`` is canonical and allowed.
        Post: for a regular path, returns ``resolve(strict=True)``.  When
              ``allow_final_symlink`` is set and the last component is a link,
              returns the link itself without following it.
        Raises: ``NotFound``, ``RootEscape``, ``SymlinkNotAllowed``.
        """

        if not parts:
            return root
        path = self._walk(
            root, parts, must_exist=True, allow_final_symlink=allow_final_symlink
        )
        if allow_final_symlink and path.is_symlink():
            parent = path.parent.resolve(strict=True)
            if not self._inside(root, parent):
                raise RootEscape("path escapes the root")
            return path
        try:
            resolved = path.resolve(strict=True)
        except OSError as exc:
            raise NotFound("path does not exist") from exc
        if not self._inside(root, resolved):
            raise RootEscape("path escapes the root")
        # Re-walk after resolve: narrows the window in which a component could
        # have been swapped for a link between the first walk and resolve().
        self._walk(root, parts, must_exist=True)
        return resolved

    def _resolve_for_create(self, root: Path, parts: tuple[str, ...]) -> Path:
        """Return a canonical non-existent (or existing) target for a write.

        Pre: ``parts`` is non-empty and came from ``_split``.
        Post: the parent exists and is canonical; the final component is not a
              symlink.
        Raises: ``InvalidPath``, ``NotFound``, ``RootEscape``,
                ``SymlinkNotAllowed``.
        """

        if not parts:
            raise InvalidPath("a file path is required")
        parent_parts = parts[:-1]
        if parent_parts:
            parent = self._walk(root, parent_parts, must_exist=True)
            try:
                resolved_parent = parent.resolve(strict=True)
            except OSError as exc:
                raise NotFound("parent directory does not exist") from exc
        else:
            resolved_parent = root
        if not self._inside(root, resolved_parent):
            raise RootEscape("path escapes the root")
        if not resolved_parent.is_dir():
            raise NotADirectory("parent is not a directory")
        target = resolved_parent / parts[-1]
        if not self._inside(root, target):
            raise RootEscape("path escapes the root")
        try:
            info = target.lstat()
        except FileNotFoundError:
            return target
        except OSError as exc:
            raise InvalidPath("path cannot be inspected") from exc
        if stat.S_ISLNK(info.st_mode):
            raise SymlinkNotAllowed("symbolic links are not allowed")
        return target

    def _open_read(self, root: Path, path: Path) -> BinaryIO:
        """Open a file read-only without following a final symlink.

        Pre: ``path`` is canonical and inside ``root``.
        Post: returns a binary stream for a regular file.  On Linux the opened
              descriptor is checked with ``/proc/self/fd``.
        Raises: ``SymlinkNotAllowed``, ``NotFound``, ``NotAFile``,
                ``RootEscape``.
        """

        flags = os.O_RDONLY | _LINK_MODE | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_BINARY", 0)
        try:
            fd = os.open(path, flags)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise SymlinkNotAllowed("symbolic links are not allowed") from exc
            if exc.errno in (errno.ENOENT, errno.ENOTDIR):
                raise NotFound("path does not exist") from exc
            raise InvalidPath("file cannot be opened") from exc
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise NotAFile("path is not a regular file")
            self._verify_open_fd(fd, root)
            return os.fdopen(fd, "rb")
        except Exception:
            os.close(fd)
            raise

    @staticmethod
    def _verify_open_fd(fd: int, root: Path) -> None:
        """Best-effort containment check for an open descriptor.

        Pre: ``fd`` refers to an already-open file.
        Post: raises ``RootEscape`` if Linux exposes a descriptor path outside
              ``root``; silently no-ops on platforms without ``/proc``.
        """

        proc = Path(f"/proc/self/fd/{fd}")
        try:
            actual = Path(os.readlink(proc))
        except OSError:
            return
        if not actual.is_absolute() or str(actual).endswith(" (deleted)"):
            return
        if not SafeFileService._inside(root, actual):
            raise RootEscape("path escapes the root")

    # -- list / stat -------------------------------------------------------

    def list_dir(
        self,
        root_id: str | None,
        rel: str = "",
        *,
        cursor: str | None = None,
        limit: int = 200,
        hidden: bool = False,
        include_symlinks: bool = True,
    ) -> DirListing:
        """List one directory, sorted directories-first then casefold name.

        Pre: ``limit`` is in 1..1000; ``cursor`` is a value previously returned
             by this method (or ``None``).
        Post: ``entries`` is a stable page; ``next_cursor`` is set iff more
              entries exist.  Hidden entries are filtered unless ``hidden`` is
              true.  Temporary write files are always omitted.  Symlinks are
              reported by ``lstat`` and never followed.
        Raises: ``NotFound``, ``NotADirectory``, ``InvalidPath``,
                ``TooManyEntries``.
        """

        if limit < 1 or limit > 1000:
            raise InvalidPath("limit must be between 1 and 1000")
        root = self._root(root_id)
        parts = self._split(rel, allow_root=True)
        directory = self._resolve_existing(root, parts)
        if not directory.is_dir():
            raise NotADirectory("path is not a directory")
        offset = _decode_cursor(cursor)

        items: list[tuple[str, os.stat_result]] = []
        try:
            with os.scandir(directory) as iterator:
                for scanned, dirent in enumerate(iterator, start=1):
                    if scanned > self._max_scan_entries:
                        raise TooManyEntries("directory has too many entries")
                    if dirent.name.startswith(_TEMP_PREFIX):
                        continue
                    if not hidden and self._hidden(dirent.name):
                        continue
                    try:
                        info = dirent.stat(follow_symlinks=False)
                    except FileNotFoundError:
                        # Entry vanished during the scan: it is not part of the
                        # resulting page and must not shift pagination.
                        continue
                    except OSError as exc:
                        raise InvalidPath("directory entry cannot be read") from exc
                    items.append((dirent.name, info))
        except FileNotFoundError as exc:
            raise NotFound("directory does not exist") from exc
        except NotADirectoryError as exc:
            raise NotADirectory("path is not a directory") from exc

        items.sort(key=lambda item: (not stat.S_ISDIR(item[1].st_mode),
                                     item[0].casefold(), item[0]))
        total = len(items)
        page = items[offset: offset + limit]
        entries = tuple(
            FileEntry(
                name=name,
                path=_join(parts, name),
                kind=self._entry_kind(info.st_mode),
                size=info.st_size if not stat.S_ISDIR(info.st_mode) else 0,
                mtime_ms=int(info.st_mtime * 1000),
                hidden=self._hidden(name),
                is_symlink=stat.S_ISLNK(info.st_mode),
            )
            for name, info in page
        )
        next_cursor = (
            _encode_cursor(offset + limit) if offset + limit < total else None
        )
        return DirListing(
            root=root_id or self._default_root_id,
            path=_path_text(parts),
            entries=entries,
            next_cursor=next_cursor,
            total=total,
            hidden=hidden,
        )

    def stat(
        self,
        root_id: str | None,
        rel: str,
        *,
        follow_symlinks: bool = False,
    ) -> FileStat:
        """Return metadata for a single entry.

        Pre: ``rel`` is a relative path.
        Post: symlinks are described by ``lstat`` unless ``follow_symlinks`` is
              true, in which case the target must still be inside the root.
        Raises: ``NotFound``, ``RootEscape``, ``SymlinkNotAllowed``.
        """

        root = self._root(root_id)
        parts = self._split(rel, allow_root=True)
        path = self._resolve_existing(
            root, parts, allow_final_symlink=not follow_symlinks
        )
        try:
            info = path.lstat() if not follow_symlinks else path.stat()
        except OSError as exc:
            raise NotFound("path does not exist") from exc
        name = path.name or root.name
        return FileStat(
            root=root_id or self._default_root_id,
            path=_path_text(parts),
            name=name,
            kind=self._entry_kind(info.st_mode),
            size=info.st_size if not stat.S_ISDIR(info.st_mode) else 0,
            mtime_ms=int(info.st_mtime * 1000),
            mode=stat.S_IMODE(info.st_mode),
            hidden=self._hidden(name),
            is_symlink=stat.S_ISLNK(info.st_mode),
        )

    def absolute_path(self, root_id: str | None, rel: str) -> str:
        """Validate a path and return its absolute form.

        Pre: caller is a trusted native shell bridge.
        Post: the returned absolute path MUST NOT be sent to the SPA; it is for
              ``shell.showItemInFolder`` in the Electron main process.
        Raises: the same errors as ``stat``.
        """

        root = self._root(root_id)
        parts = self._split(rel, allow_root=True)
        return str(self._resolve_existing(root, parts, allow_final_symlink=True))

    # -- reads -------------------------------------------------------------

    def read_bytes(
        self,
        root_id: str | None,
        rel: str,
        *,
        max_bytes: int | None = None,
        offset: int = 0,
        length: int | None = None,
    ) -> FileBytes:
        """Read a byte range from a regular file.

        Pre: ``offset >= 0``; ``length`` is ``None`` or positive.
        Post: a full read (``offset == 0`` and no ``length``) carries the
              whole-file SHA-256; a partial read carries ``None``.  Reads are
              rejected once the size exceeds the effective cap.
        Raises: ``TooLarge``, ``NotFound``, ``NotAFile``, ``SymlinkNotAllowed``.
        """

        cap = (
            self._max_read_bytes
            if max_bytes is None
            else min(max_bytes, self._max_read_bytes)
        )
        if cap <= 0:
            raise InvalidPath("max_bytes must be positive")
        if offset < 0:
            raise InvalidPath("offset must not be negative")
        if length is not None and length <= 0:
            raise InvalidPath("length must be positive")

        root = self._root(root_id)
        parts = self._split(rel, allow_root=False)
        path = self._resolve_existing(root, parts)
        with self._open_read(root, path) as stream:
            info = os.fstat(stream.fileno())
            size = info.st_size
            if offset > size:
                data = b""
            elif length is None:
                remaining = size - offset
                if remaining > cap:
                    raise TooLarge("file exceeds the read limit")
                stream.seek(offset)
                data = stream.read(remaining)
                if len(data) > cap:
                    raise TooLarge("file exceeds the read limit")
            else:
                if length > cap:
                    raise TooLarge("range exceeds the read limit")
                stream.seek(offset)
                data = stream.read(length)
            whole = offset == 0 and len(data) == size
            return FileBytes(
                root=root_id or self._default_root_id,
                path=_path_text(parts),
                data=data,
                total_size=size,
                offset=offset,
                mime=_mime(rel, binary=b"\x00" in data[:8192]),
                mtime_ms=int(info.st_mtime * 1000),
                sha256=hashlib.sha256(data).hexdigest() if whole else None,
            )

    def read_text(
        self,
        root_id: str | None,
        rel: str,
        *,
        max_bytes: int | None = None,
        max_lines: int | None = None,
    ) -> FileText:
        """Read a UTF-8 text file with NUL-based binary detection.

        Pre: ``max_lines`` is ``None`` or positive.
        Post: ``binary`` is true when a NUL byte is present or UTF-8 decoding
              fails; then ``text``/``encoding`` are ``None``.  When the line
              count exceeds ``max_lines``, ``truncated`` is true and ``text``
              holds only the first ``max_lines`` lines; the SHA-256 still
              covers the whole file, so an editing client cannot silently save
              a truncated buffer (the optional hash guard returns 409).
        Raises: ``TooLarge``, ``NotFound``, ``NotAFile``.
        """

        line_cap = self._max_lines if max_lines is None else max_lines
        if line_cap <= 0:
            raise InvalidPath("max_lines must be positive")
        raw = self.read_bytes(root_id, rel, max_bytes=max_bytes)
        binary = b"\x00" in raw.data
        text: str | None = None
        encoding: str | None = None
        if not binary:
            try:
                text = raw.data.decode("utf-8")
                encoding = "utf-8"
            except UnicodeDecodeError:
                binary = True
        line_count = 0
        truncated = False
        if text is not None:
            line_count = text.count("\n") + (
                1 if text and not text.endswith("\n") else 0
            )
            if line_count > line_cap:
                text = "\n".join(text.splitlines()[:line_cap])
                truncated = True
        return FileText(
            root=raw.root,
            path=raw.path,
            text=text,
            binary=binary,
            encoding=encoding,
            size=raw.total_size,
            line_count=line_count,
            truncated=truncated,
            mtime_ms=raw.mtime_ms,
            mime=raw.mime,
            sha256=raw.sha256,
        )

    def open_binary(self, root_id: str | None, rel: str) -> tuple[BinaryIO, FileStat]:
        """Open a file for streaming a download.

        Pre: caller will close the returned stream.
        Post: the stream is positioned at 0; ``FileStat`` describes its metadata.
        Raises: ``NotFound``, ``NotAFile``, ``SymlinkNotAllowed``.
        """

        root = self._root(root_id)
        parts = self._split(rel, allow_root=False)
        path = self._resolve_existing(root, parts)
        stream = self._open_read(root, path)
        info = os.fstat(stream.fileno())
        return stream, FileStat(
            root=root_id or self._default_root_id,
            path=_path_text(parts),
            name=path.name,
            kind="file",
            size=info.st_size,
            mtime_ms=int(info.st_mtime * 1000),
            mode=stat.S_IMODE(info.st_mode),
            hidden=self._hidden(path.name),
            is_symlink=False,
        )

    # -- writes ------------------------------------------------------------

    def write_atomic(
        self,
        root_id: str | None,
        rel: str,
        data: bytes,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
    ) -> WriteResult:
        """Atomically replace or create a file from ``data``.

        Pre: ``expected_sha256`` is ``None`` or 64 hex characters; ``data`` is
             the complete new content.
        Post: on success the target contains exactly ``data``; the previous
              file (if any) is replaced atomically.  With an expected hash, the
              write is a compare-and-swap and fails with ``HashMismatch`` (409)
              without touching the target.
        Raises: ``TooLarge``, ``HashMismatch``, ``SymlinkNotAllowed``,
                ``NotAFile``, ``NotFound``.
        """

        cap = (
            self._max_write_bytes
            if max_bytes is None
            else min(max_bytes, self._max_write_bytes)
        )
        if len(data) > cap:
            raise TooLarge("content exceeds the write limit")
        root = self._root(root_id, write=True)
        parts = self._split(rel, allow_root=False)
        target = self._resolve_for_create(root, parts)
        self._check_expected(root, target, expected_sha256)
        existed = _lstat_or_none(target)
        if existed is not None and stat.S_ISDIR(existed.st_mode):
            raise NotAFile("path is a directory")
        digest = hashlib.sha256(data).hexdigest()
        self._atomic_write_chunks(target, (data,), existed)
        return WriteResult(
            root=root_id or self._default_root_id,
            path=_path_text(parts),
            size=len(data),
            sha256=digest,
            mtime_ms=_mtime_ms(target),
            created=existed is None,
        )

    def write_stream_atomic(
        self,
        root_id: str | None,
        rel: str,
        source: BinaryIO,
        *,
        expected_sha256: str | None = None,
        overwrite: bool = True,
        max_bytes: int | None = None,
        chunk_size: int = _COPY_CHUNK,
    ) -> WriteResult:
        """Atomically write a stream without loading it into memory.

        Pre: ``source`` is readable and remains owned by the caller (this
             method does not close it); ``chunk_size`` is positive.
        Post: same atomicity and hash semantics as ``write_atomic``.  With
              ``overwrite=False`` an existing target yields ``AlreadyExists``.
        Raises: ``AlreadyExists``, ``TooLarge``, ``HashMismatch``.
        """

        if chunk_size <= 0:
            raise InvalidPath("chunk_size must be positive")
        cap = (
            self._max_write_bytes
            if max_bytes is None
            else min(max_bytes, self._max_write_bytes)
        )
        root = self._root(root_id, write=True)
        parts = self._split(rel, allow_root=False)
        target = self._resolve_for_create(root, parts)
        existed = _lstat_or_none(target)
        if existed is not None:
            if stat.S_ISDIR(existed.st_mode):
                raise NotAFile("path is a directory")
            if not overwrite:
                raise AlreadyExists("file already exists")
        self._check_expected(root, target, expected_sha256)
        chunks = _limited_chunks(source, chunk_size, cap)
        size, digest = self._atomic_write_chunks(target, chunks, existed)
        return WriteResult(
            root=root_id or self._default_root_id,
            path=_path_text(parts),
            size=size,
            sha256=digest,
            mtime_ms=_mtime_ms(target),
            created=existed is None,
        )

    def create_file(
        self,
        root_id: str | None,
        rel: str,
        data: bytes = b"",
        *,
        overwrite: bool = False,
    ) -> WriteResult:
        """Create a file, refusing to clobber by default.

        Pre: ``data`` is at most the write limit.
        Post: with ``overwrite=False`` the call is ``O_CREAT|O_EXCL`` and fails
              if anything already exists at ``rel``.
        Raises: ``AlreadyExists``, ``TooLarge``, ``SymlinkNotAllowed``.
        """

        if overwrite:
            return self.write_atomic(root_id, rel, data)
        if len(data) > self._max_write_bytes:
            raise TooLarge("content exceeds the write limit")
        root = self._root(root_id, write=True)
        parts = self._split(rel, allow_root=False)
        target = self._resolve_for_create(root, parts)
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | _LINK_MODE
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_BINARY", 0)
        )
        try:
            fd = os.open(target, flags, 0o600)
        except FileExistsError as exc:
            raise AlreadyExists("file already exists") from exc
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise SymlinkNotAllowed("symbolic links are not allowed") from exc
            raise InvalidPath("file cannot be created") from exc
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        except Exception:
            with contextlib.suppress(OSError):
                target.unlink()
            raise
        _fsync_dir(target.parent)
        return WriteResult(
            root=root_id or self._default_root_id,
            path=_path_text(parts),
            size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            mtime_ms=_mtime_ms(target),
            created=True,
        )

    # -- directory / entry mutations --------------------------------------

    def mkdir(
        self, root_id: str | None, rel: str, *, parents: bool = False
    ) -> FileStat:
        """Create one directory (or a parent chain when ``parents``).

        Pre: ``rel`` is non-empty.
        Post: the new directory is inside the root; existing parents are not
              followed through symlinks.
        Raises: ``AlreadyExists``, ``NotADirectory``, ``SymlinkNotAllowed``.
        """

        root = self._root(root_id, write=True)
        parts = self._split(rel, allow_root=False)
        if not parts:
            raise InvalidPath("a directory path is required")
        if parents:
            current = root
            for part in parts:
                current = current / part
                try:
                    info = current.lstat()
                except FileNotFoundError:
                    try:
                        os.mkdir(current, 0o755)
                    except FileExistsError:
                        pass
                    except OSError as exc:
                        raise InvalidPath("directory cannot be created") from exc
                else:
                    if stat.S_ISLNK(info.st_mode):
                        raise SymlinkNotAllowed("symbolic links are not allowed")
                    if not stat.S_ISDIR(info.st_mode):
                        raise NotADirectory("a path component is not a directory")
            # Re-walk after creation: a racing process could have replaced a
            # newly created component with a symlink.
            current = root
            for part in parts:
                current = current / part
                info = current.lstat()
                if stat.S_ISLNK(info.st_mode):
                    raise SymlinkNotAllowed("symbolic links are not allowed")
                if not stat.S_ISDIR(info.st_mode):
                    raise NotADirectory("a path component is not a directory")
            resolved = current.resolve(strict=True)
            if not self._inside(root, resolved):
                raise RootEscape("path escapes the root")
        else:
            target = self._resolve_for_create(root, parts)
            try:
                os.mkdir(target, 0o755)
            except FileExistsError as exc:
                raise AlreadyExists("path already exists") from exc
            except OSError as exc:
                raise InvalidPath("directory cannot be created") from exc
        return self.stat(root_id, rel)

    def rename(
        self,
        root_id: str | None,
        src: str,
        dst: str,
        *,
        overwrite: bool = False,
    ) -> FileStat:
        """Rename or move an entry within one root.

        Pre: neither path is the root itself.
        Post: with ``overwrite=False`` an existing destination is rejected; a
              directory cannot be moved inside itself.
        Raises: ``AlreadyExists``, ``InvalidPath``, ``CrossDeviceMove``.
        """

        root = self._root(root_id, write=True)
        src_parts = self._split(src, allow_root=False)
        dst_parts = self._split(dst, allow_root=False)
        src_path = self._resolve_existing(root, src_parts)
        dst_path = self._resolve_for_create(root, dst_parts)
        if src_path == dst_path:
            return self.stat(root_id, dst)
        src_info = _lstat_or_none(src_path)
        if src_info is None:
            raise NotFound("source does not exist")
        if stat.S_ISLNK(src_info.st_mode):
            raise SymlinkNotAllowed("symbolic links are not allowed")
        if stat.S_ISDIR(src_info.st_mode) and self._inside(src_path, dst_path):
            raise InvalidPath("cannot move a directory inside itself")
        dst_info = _lstat_or_none(dst_path)
        if dst_info is not None:
            if stat.S_ISLNK(dst_info.st_mode):
                raise SymlinkNotAllowed("symbolic links are not allowed")
            if not overwrite:
                raise AlreadyExists("destination already exists")
            if stat.S_ISDIR(dst_info.st_mode):
                raise AlreadyExists("destination directory already exists")
        try:
            if overwrite:
                os.replace(src_path, dst_path)
            else:
                os.rename(src_path, dst_path)
        except OSError as exc:
            if exc.errno == errno.EXDEV:
                raise CrossDeviceMove(
                    "source and destination are on different filesystems"
                ) from exc
            if exc.errno in (errno.ENOTEMPTY, errno.EEXIST):
                raise AlreadyExists("destination already exists") from exc
            if exc.errno == errno.ENOENT:
                raise NotFound("source does not exist") from exc
            raise InvalidPath("entry cannot be moved") from exc
        _fsync_dir(dst_path.parent)
        return self.stat(root_id, dst)

    def delete(self, root_id: str | None, rel: str) -> None:
        """Delete a file, a symlink, or an empty directory.

        Pre: ``rel`` is non-empty.
        Post: the entry is gone; non-empty directories are never removed
              recursively.
        Raises: ``NotFound``, ``DirectoryNotEmpty``.
        """

        root = self._root(root_id, write=True)
        parts = self._split(rel, allow_root=False)
        path = self._resolve_existing(root, parts, allow_final_symlink=True)
        info = _lstat_or_none(path)
        if info is None:
            raise NotFound("path does not exist")
        try:
            if stat.S_ISDIR(info.st_mode):
                os.rmdir(path)
            else:
                # unlink removes a symlink itself, never its target.
                os.unlink(path)
        except OSError as exc:
            if exc.errno in (errno.ENOTEMPTY, errno.EEXIST):
                raise DirectoryNotEmpty("directory is not empty") from exc
            if exc.errno == errno.ENOENT:
                raise NotFound("path does not exist") from exc
            raise InvalidPath("entry cannot be deleted") from exc
        _fsync_dir(path.parent)

    def copy(
        self,
        root_id: str | None,
        src: str,
        dst: str,
        *,
        overwrite: bool = False,
    ) -> FileStat:
        """Copy a file or directory tree within one root.

        Pre: ``src`` and ``dst`` are non-empty and differ.
        Post: symlinks anywhere in the source abort the copy; entry, byte and
              depth caps apply; a partially created destination is removed on
              failure.
        Raises: ``AlreadyExists``, ``TooLarge``, ``TooManyEntries``,
                ``SymlinkNotAllowed``, ``InvalidPath``.
        """

        root = self._root(root_id, write=True)
        src_parts = self._split(src, allow_root=False)
        dst_parts = self._split(dst, allow_root=False)
        src_path = self._resolve_existing(root, src_parts)
        dst_path = self._resolve_for_create(root, dst_parts)
        if src_path == dst_path:
            raise InvalidPath("source and destination are identical")
        src_info = _lstat_or_none(src_path)
        if src_info is None:
            raise NotFound("source does not exist")
        if stat.S_ISLNK(src_info.st_mode):
            raise SymlinkNotAllowed("symbolic links are not allowed")
        dst_info = _lstat_or_none(dst_path)
        if dst_info is not None:
            if stat.S_ISLNK(dst_info.st_mode):
                raise SymlinkNotAllowed("symbolic links are not allowed")
            if not overwrite:
                raise AlreadyExists("destination already exists")
            if stat.S_ISDIR(dst_info.st_mode):
                raise AlreadyExists("destination directory already exists")
        if stat.S_ISDIR(src_info.st_mode):
            if self._inside(src_path, dst_path):
                raise InvalidPath("cannot copy a directory inside itself")
            try:
                os.mkdir(dst_path, 0o755)
            except FileExistsError as exc:
                raise AlreadyExists("destination already exists") from exc
            except OSError as exc:
                raise InvalidPath("destination cannot be created") from exc
            counter = _CopyCounter()
            try:
                self._copy_tree(root, src_path, dst_path, counter, depth=0)
            except Exception:
                shutil.rmtree(dst_path, ignore_errors=True)
                raise
        else:
            if not stat.S_ISREG(src_info.st_mode):
                raise InvalidPath("unsupported file type")
            self._copy_file(root, src_path, dst_path, src_info, overwrite=overwrite)
        return self.stat(root_id, dst)

    def move(
        self,
        root_id: str | None,
        src: str,
        dst: str,
        *,
        overwrite: bool = False,
    ) -> FileStat:
        """Move an entry within one root (same filesystem only).

        Post: identical semantics to ``rename``; cross-device moves report
              ``CrossDeviceMove`` instead of silently copying and deleting.
        """

        return self.rename(root_id, src, dst, overwrite=overwrite)

    # -- internals ---------------------------------------------------------

    def _copy_tree(
        self,
        root: Path,
        src: Path,
        dst: Path,
        counter: _CopyCounter,
        *,
        depth: int,
    ) -> None:
        """Recursively copy a tree, rejecting links and enforcing caps."""

        if depth > self._max_copy_depth:
            raise TooLarge("directory tree is too deep")
        try:
            with os.scandir(src) as iterator:
                entries = sorted(iterator, key=lambda item: item.name.casefold())
        except OSError as exc:
            raise InvalidPath("source directory cannot be read") from exc
        for dirent in entries:
            if dirent.name.startswith(_TEMP_PREFIX):
                continue
            counter.entries += 1
            if counter.entries > self._max_copy_entries:
                raise TooManyEntries("copy exceeds the entry limit")
            source = Path(dirent.path)
            target = dst / dirent.name
            try:
                info = source.lstat()
            except OSError as exc:
                raise InvalidPath("source entry cannot be read") from exc
            if stat.S_ISLNK(info.st_mode):
                raise SymlinkNotAllowed("symbolic links are not allowed")
            if stat.S_ISDIR(info.st_mode):
                try:
                    os.mkdir(target, 0o755)
                except OSError as exc:
                    raise InvalidPath("destination cannot be created") from exc
                self._copy_tree(root, source, target, counter, depth=depth + 1)
            elif stat.S_ISREG(info.st_mode):
                counter.bytes += info.st_size
                if counter.bytes > self._max_copy_bytes:
                    raise TooLarge("copy exceeds the byte limit")
                self._copy_file(root, source, target, info, overwrite=False)
            else:
                raise InvalidPath("unsupported file type")

    def _copy_file(
        self,
        root: Path,
        src: Path,
        dst: Path,
        info: os.stat_result,
        *,
        overwrite: bool,
    ) -> None:
        """Copy one regular file through the atomic writer."""

        if not overwrite:
            try:
                dst.lstat()
            except FileNotFoundError:
                pass
            else:
                raise AlreadyExists("destination already exists")
        with self._open_read(root, src) as stream:
            self._atomic_write_chunks(
                dst,
                _limited_chunks(stream, _COPY_CHUNK, self._max_copy_bytes),
                _lstat_or_none(dst),
            )
        with contextlib.suppress(OSError):
            os.chmod(dst, stat.S_IMODE(info.st_mode))

    def _check_expected(
        self, root: Path, target: Path, expected: str | None
    ) -> None:
        """Compare-and-swap hash guard.

        Post: returns when ``expected`` is ``None`` or matches the current
              regular-file content; otherwise raises ``HashMismatch``.
        """

        if expected is None:
            return
        if _SHA256_RE.fullmatch(expected) is None:
            raise InvalidPath("expectedSha256 must be 64 hex characters")
        info = _lstat_or_none(target)
        if info is None:
            raise HashMismatch("file does not exist")
        if stat.S_ISLNK(info.st_mode):
            raise SymlinkNotAllowed("symbolic links are not allowed")
        if not stat.S_ISREG(info.st_mode):
            raise NotAFile("path is not a regular file")
        with self._open_read(root, target) as stream:
            digest = _hash_stream(stream)
        if not hmac.compare_digest(digest, expected.lower()):
            raise HashMismatch("file changed since it was read")

    def _atomic_write_chunks(
        self,
        target: Path,
        chunks: Iterable[bytes],
        existed: os.stat_result | None,
    ) -> tuple[int, str]:
        """Write ``chunks`` to a temporary file and replace ``target``.

        Pre: ``target`` is an authorised path whose parent exists.
        Post: target is replaced atomically; the temporary file is removed on
              any failure.  Permissions are preserved when overwriting and
              default to 0600 for new files.  Returns ``(size, sha256_hex)``.
        """

        if existed is not None:
            if stat.S_ISLNK(existed.st_mode):
                raise SymlinkNotAllowed("symbolic links are not allowed")
            if stat.S_ISDIR(existed.st_mode):
                raise NotAFile("path is a directory")
        temporary: str | None = None
        digest = hashlib.sha256()
        size = 0
        try:
            descriptor, temporary = tempfile.mkstemp(
                prefix=_TEMP_PREFIX, dir=str(target.parent)
            )
            with os.fdopen(descriptor, "wb") as stream:
                for chunk in chunks:
                    stream.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            mode = stat.S_IMODE(existed.st_mode) if existed is not None else 0o600
            os.chmod(temporary, mode)
            # Final symlink re-check immediately before replace.  os.replace
            # itself would replace a symlink rather than follow it, but refusing
            # keeps the policy observable and deterministic.
            current = _lstat_or_none(target)
            if current is not None and stat.S_ISLNK(current.st_mode):
                raise SymlinkNotAllowed("symbolic links are not allowed")
            os.replace(temporary, target)
            temporary = None
            _fsync_dir(target.parent)
        finally:
            if temporary is not None:
                with contextlib.suppress(OSError):
                    os.unlink(temporary)
        return size, digest.hexdigest()


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _CopyCounter:
    entries: int = 0
    bytes: int = 0


def _join(parts: tuple[str, ...], name: str) -> str:
    return "/".join((*parts, name))


def _path_text(parts: tuple[str, ...]) -> str:
    return "/".join(parts)


def _encode_cursor(offset: int) -> str:
    raw = f"o:{offset}".encode("ascii")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str | None) -> int:
    if cursor is None or cursor == "":
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("ascii")
    except (ValueError, UnicodeError) as exc:
        raise InvalidPath("invalid cursor") from exc
    if not raw.startswith("o:"):
        raise InvalidPath("invalid cursor")
    try:
        offset = int(raw[2:])
    except ValueError as exc:
        raise InvalidPath("invalid cursor") from exc
    if offset < 0:
        raise InvalidPath("invalid cursor")
    return offset


def _mime(name: str, *, binary: bool) -> str:
    guessed, _ = mimetypes.guess_type(name)
    if guessed:
        return guessed
    return "application/octet-stream" if binary else "text/plain"


def _lstat_or_none(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise InvalidPath("path cannot be inspected") from exc


def _mtime_ms(path: Path) -> int:
    info = _lstat_or_none(path)
    return int(info.st_mtime * 1000) if info is not None else 0


def _limited_chunks(
    source: BinaryIO, chunk_size: int, max_bytes: int
) -> Iterator[bytes]:
    """Yield chunks, raising ``TooLarge`` once ``max_bytes`` is exceeded."""

    total = 0
    while True:
        chunk = source.read(chunk_size)
        if not chunk:
            return
        total += len(chunk)
        if total > max_bytes:
            raise TooLarge("content exceeds the write limit")
        yield chunk


def _hash_stream(stream: BinaryIO) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(_COPY_CHUNK), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _fsync_dir(directory: Path) -> None:
    """Best-effort directory fsync (unsupported on Windows)."""

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        return
    try:
        with contextlib.suppress(OSError):
            os.fsync(descriptor)
    finally:
        os.close(descriptor)
