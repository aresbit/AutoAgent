"""Filesystem artifact store with immutable versions.

``manifest.json`` is authoritative for metadata.  The manifest uses the
``autoagent.ui/1`` schema: a top-level object with a ``schema`` marker and an
``artifacts`` array.  Each artifact records an explicit ``current`` version
pointer and a ``history`` of immutable snapshots::

    {
      "schema": "autoagent.ui/1",
      "artifacts": [
        {
          "id": "quarterly-review",
          "current": "v3",
          "history": [
            {"versionId": "v1", "uri": "ui://quarterly-review/v1/index.html", ...}
          ],
          ...
        }
      ]
    }

Content lives in ``<root>/<id>/index.html`` (current) and
``<root>/<id>/versions/v<N>.html`` (immutable).  A legacy manifest list and
legacy timestamp-named snapshots are read transparently.  Unknown manifest
fields are preserved on rewrite.

All ids are validated as a single path segment and paths are always derived
from the validated id, never from manifest data.  Every read-modify-write runs
under one re-entrant lock so concurrent materialization cannot lose records.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ...application.artifact_materializer import (
    DEFAULT_CSP,
    DEFAULT_PERMISSIONS,
    DISPLAY_MODES,
    ENTRY,
    MIME_TYPE,
    build_artifact_document,
    extract_meta,
    sha256_text,
    strip_meta,
)
from ...domain.errors import ArtifactNotFound, ArtifactUnavailable, InvalidInput
from ...domain.models import (
    Artifact,
    ArtifactCreate,
    ArtifactDraft,
    ArtifactMutation,
    ArtifactVerification,
    ArtifactVersion,
)
from ...domain.ports import ClockPort

_MANIFEST = "manifest.json"
_MANIFEST_SCHEMA = "autoagent.ui/1"
_INDEX = "index.html"
_VERSIONS = "versions"
_MAX_ID_CHARS = 48
_MAX_ZIP_ENTRIES = 2000
_MAX_ZIP_BYTES = 50 * 1024 * 1024
_SLUG = re.compile(r"[^a-z0-9]+")
_VERSION_ID = re.compile(r"^v([1-9][0-9]*)$")
_LEGACY_VERSION = re.compile(r"^(0|[1-9][0-9]*)$")

# Backwards-compatible private names used by existing tests.
_extract_meta = extract_meta
_strip_meta = strip_meta


def _slugify(title: str) -> str:
    return _SLUG.sub("-", title.lower()).strip("-")[:_MAX_ID_CHARS] or "artifact"


def _html_shell(title: str, body: str, description: str) -> str:
    return build_artifact_document(title, body, description)


def _validate_id(artifact_id: str) -> str:
    cleaned = artifact_id.strip()
    if (
        not cleaned
        or cleaned in {".", ".."}
        or "/" in cleaned
        or "\\" in cleaned
        or cleaned.startswith(".")
        or "\x00" in cleaned
    ):
        raise InvalidInput("invalid artifact id")
    return cleaned


def _validate_version_id(version_id: str) -> str:
    cleaned = version_id.strip()
    if _VERSION_ID.fullmatch(cleaned) is None:
        raise InvalidInput("invalid artifact version id")
    return cleaned


def _uri(artifact_id: str, version_id: str) -> str:
    return f"ui://{artifact_id}/{version_id}/{ENTRY}"


@dataclass
class _Version:
    version_id: str
    created_at: int
    sha256: str
    size_bytes: int
    source: str = "manual"
    session_id: str | None = None
    turn_id: str | None = None
    message_id: str | None = None
    file_name: str = ""
    extra: dict[str, object] = field(default_factory=dict)

    @property
    def number(self) -> int:
        match = _VERSION_ID.fullmatch(self.version_id)
        return int(match.group(1)) if match else 0

    @property
    def path_name(self) -> str:
        return self.file_name or f"{self.version_id}.html"


@dataclass
class _Record:
    id: str
    title: str
    description: str
    created_at: int
    updated_at: int
    last_opened_at: int | None = None
    current: str = "v1"
    history: list[_Version] = field(default_factory=list)
    session_id: str | None = None
    turn_id: str | None = None
    message_id: str | None = None
    kind: str = "html"
    mcp_tools: tuple[str, ...] = ()
    allow_external: bool = False
    extra: dict[str, object] = field(default_factory=dict)


@dataclass
class _Manifest:
    records: list[_Record] = field(default_factory=list)
    extra: dict[str, object] = field(default_factory=dict)


RecordList = list[_Record]


_RECORD_KNOWN = {
    "id",
    "artifactId",
    "title",
    "description",
    "createdAt",
    "updatedAt",
    "lastOpenedAt",
    "versions",
    "current",
    "history",
    "sessionId",
    "turnId",
    "messageId",
    "kind",
    "sizeBytes",
    "revision",
    "version",
    "sha256",
    "path",
    "mcpTools",
    "allowExternal",
}
_VERSION_KNOWN = {
    "versionId",
    "version",
    "createdAt",
    "sha256",
    "sizeBytes",
    "source",
    "sessionId",
    "turnId",
    "messageId",
    "fileName",
    "uri",
    "mimeType",
    "immutable",
    "entry",
    "csp",
    "permissions",
    "displayModes",
}


class FilesystemArtifactStore:
    """Implements ``ArtifactStorePort`` with ``manifest.json`` as the authority."""

    def __init__(self, root: Path | str, clock: ClockPort) -> None:
        self._root = Path(root).expanduser()
        self._clock = clock
        self._lock = threading.RLock()

    # -- port --------------------------------------------------------------

    def list(self) -> tuple[Artifact, ...]:
        with self._lock:
            records = self._load_or_refresh().records
            records.sort(
                key=lambda item: (item.updated_at, item.created_at), reverse=True
            )
            return tuple(self._to_value(item) for item in records)

    def get(self, artifact_id: str) -> Artifact:
        with self._lock:
            manifest = self._load_or_refresh()
            return self._to_value(self._find(manifest, _validate_id(artifact_id)))

    def create(self, request: ArtifactCreate) -> Artifact:
        title = (request.title or "").strip() or "Artifact"
        description = (request.description or "").strip()
        document = build_artifact_document(title, request.html, description)
        digest = sha256_text(document)
        size = len(document.encode("utf-8"))

        with self._lock:
            manifest = self._load()
            existing = next(
                (item for item in manifest.records if item.title == title), None
            )
            if existing is None:
                record = self._new_record(
                    manifest,
                    title=title,
                    description=description,
                    document=document,
                    digest=digest,
                    size=size,
                    source=request.source,
                    session_id=request.session_id,
                    turn_id=request.turn_id,
                    message_id=request.message_id,
                    mcp_tools=request.mcp_tools,
                    allow_external=request.allow_external,
                )
                self._save(manifest)
                return self._to_value(record)

            self._append_version(
                existing,
                document=document,
                digest=digest,
                size=size,
                source=request.source,
                session_id=request.session_id,
                turn_id=request.turn_id,
                message_id=request.message_id,
            )
            self._save(manifest)
            return self._to_value(existing)

    def content(self, artifact_id: str) -> str:
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            return self._read_current(record)

    def mark_opened(self, artifact_id: str) -> Artifact:
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            record.last_opened_at = self._clock.now_ms()
            self._save(manifest)
            return self._to_value(record)

    def set_capabilities(
        self,
        artifact_id: str,
        mcp_tools: tuple[str, ...],
        allow_external: bool | None = None,
    ) -> Artifact:
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            record.mcp_tools = tuple(mcp_tools)
            if allow_external is not None:
                record.allow_external = allow_external
            record.updated_at = self._clock.now_ms()
            self._save(manifest)
            return self._to_value(record)

    def export(self, artifact_id: str, target_path: str) -> str:
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            target = _target_path(target_path)
            directory = self._directory(record.id)
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
                    for entry in sorted(directory.rglob("*")):
                        if entry == target or not entry.is_file():
                            continue
                        archive.write(entry, entry.relative_to(directory).as_posix())
            except OSError as exc:
                raise ArtifactUnavailable("could not export artifact") from exc
            return str(target)

    def import_archive(self, zip_path: str) -> Artifact:
        source = Path(zip_path).expanduser()
        if not source.is_file() or not zipfile.is_zipfile(source):
            raise InvalidInput("artifact archive is not a valid zip file")
        with tempfile.TemporaryDirectory(prefix="autoagent-artifact-") as temporary:
            directory = Path(temporary)
            self._extract_safely(source, directory)
            index = self._find_index(directory)
            if index is None:
                raise InvalidInput("artifact archive does not contain index.html")
            try:
                html = index.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                raise InvalidInput("artifact archive index.html is not readable") from exc
            meta = extract_meta(html)
            relative = index.relative_to(directory)
            fallback = relative.parts[-2] if len(relative.parts) > 1 else "Artifact"
            title = str(meta.get("name") or fallback)
            description = str(meta.get("description") or "")
            return self.create(
                ArtifactCreate(
                    html=strip_meta(html),
                    title=title,
                    description=description,
                    source="import",
                )
            )

    def save_materialized(
        self,
        draft: ArtifactDraft,
        *,
        session_id: str | None,
        turn_id: str | None,
        message_id: str | None,
    ) -> ArtifactMutation:
        title = (draft.title or "").strip() or "Artifact"
        digest = sha256_text(draft.html)
        size = len(draft.html.encode("utf-8"))

        with self._lock:
            manifest = self._load()
            existing = self._find_materialized_record(
                manifest.records, title=title, session_id=session_id
            )
            if existing is None:
                record = self._new_record(
                    manifest,
                    title=title,
                    description=draft.description.strip(),
                    document=draft.html,
                    digest=digest,
                    size=size,
                    source="turn",
                    session_id=session_id,
                    turn_id=turn_id,
                    message_id=message_id,
                    mcp_tools=draft.mcp_tools,
                )
                self._save(manifest)
                return ArtifactMutation(
                    artifact=self._to_value(record), created=True, changed=True
                )

            version = self._append_version(
                existing,
                document=draft.html,
                digest=digest,
                size=size,
                source="turn",
                session_id=session_id,
                turn_id=turn_id,
                message_id=message_id,
                dedupe=True,
            )
            self._save(manifest)
            return ArtifactMutation(
                artifact=self._to_value(existing),
                created=False,
                changed=version is not None,
            )

    def versions(self, artifact_id: str) -> tuple[ArtifactVersion, ...]:
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            return tuple(
                self._version_value(record, item)
                for item in sorted(
                    record.history, key=lambda entry: entry.number, reverse=True
                )
            )

    def version_content(self, artifact_id: str, version_id: str) -> str:
        version_id = _validate_version_id(version_id)
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            version = self._find_version(record, version_id)
            try:
                return self._version_path(record, version).read_text(
                    encoding="utf-8"
                )
            except OSError as exc:
                raise ArtifactNotFound("artifact version is unavailable") from exc

    def restore(self, artifact_id: str, version_id: str) -> Artifact:
        version_id = _validate_version_id(version_id)
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            source = self._find_version(record, version_id)
            try:
                document = self._version_path(record, source).read_text(
                    encoding="utf-8"
                )
            except OSError as exc:
                raise ArtifactNotFound("artifact version is unavailable") from exc
            digest = sha256_text(document)
            size = len(document.encode("utf-8"))
            self._append_version(
                record,
                document=document,
                digest=digest,
                size=size,
                source="restore",
                session_id=record.session_id,
                turn_id=record.turn_id,
                message_id=record.message_id,
                dedupe=False,
            )
            self._save(manifest)
            return self._to_value(record)

    def verify(self, artifact_id: str) -> ArtifactVerification:
        with self._lock:
            manifest = self._load_or_refresh()
            record = self._find(manifest, _validate_id(artifact_id))
            current = self._current_version(record)
            if current is None:
                raise ArtifactNotFound("artifact has no versions")
            try:
                content = self._read_current(record)
            except ArtifactNotFound:
                raise
            digest = sha256_text(content)
            size = len(content.encode("utf-8"))
            return ArtifactVerification(
                artifact_id=record.id,
                version_id=current.version_id,
                ok=digest == current.sha256 and size == current.size_bytes,
                sha256=digest,
                expected_sha256=current.sha256,
                size_bytes=size,
            )

    # -- internals ---------------------------------------------------------

    def _directory(self, artifact_id: str) -> Path:
        return self._root / _validate_id(artifact_id)

    def _manifest_path(self) -> Path:
        return self._root / _MANIFEST

    def _index_path(self, record: _Record) -> Path:
        return self._directory(record.id) / _INDEX

    def _version_path(self, record: _Record, version: _Version) -> Path:
        name = version.path_name
        if Path(name).name != name or name.startswith("."):
            raise InvalidInput("invalid artifact version file")
        return self._directory(record.id) / _VERSIONS / name

    def _load(self) -> _Manifest:
        path = self._manifest_path()
        if not path.is_file():
            return _Manifest()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return _Manifest()
        if isinstance(raw, list):
            entries: object = raw
            extra: dict[str, object] = {}
        elif isinstance(raw, dict):
            entries = raw.get("artifacts")
            extra = {
                key: value
                for key, value in raw.items()
                if key not in {"schema", "artifacts"}
            }
        else:
            return _Manifest()
        if not isinstance(entries, list):
            return _Manifest(extra=extra)
        manifest = _Manifest(extra=extra)
        for item in entries:
            record = self._record_from_json(item)
            if record is not None:
                self._ensure_history(record)
                manifest.records.append(record)
        return manifest

    def _load_or_refresh(self) -> _Manifest:
        manifest = self._load()
        if manifest.records or not self._root.is_dir():
            return manifest
        records = self._refresh_from_disk()
        return _Manifest(records=records, extra=manifest.extra)

    def _save(self, manifest: _Manifest) -> None:
        records = sorted(
            manifest.records,
            key=lambda item: (item.updated_at, item.created_at),
            reverse=True,
        )
        payload = dict(manifest.extra)
        payload["schema"] = _MANIFEST_SCHEMA
        payload["artifacts"] = [self._record_to_json(item) for item in records]
        try:
            self._root.mkdir(parents=True, exist_ok=True)
            text = json.dumps(payload, ensure_ascii=False, indent=2)
            _atomic_write_text(self._manifest_path(), text + "\n")
        except OSError as exc:
            raise ArtifactUnavailable("could not write artifact manifest") from exc

    def _record_to_json(self, record: _Record) -> dict[str, object]:
        payload = dict(record.extra)
        payload.update(
            {
                "id": record.id,
                "artifactId": record.id,
                "title": record.title,
                "description": record.description,
                "path": str(self._index_path(record)),
                "createdAt": record.created_at,
                "updatedAt": record.updated_at,
                "lastOpenedAt": record.last_opened_at,
                "versions": [
                    item.created_at
                    for item in record.history
                    if item.version_id != record.current
                ],
                "current": record.current,
                "revision": record.current,
                "history": [
                    self._version_to_json(record, item)
                    for item in sorted(record.history, key=lambda entry: entry.number)
                ],
                "sessionId": record.session_id,
                "turnId": record.turn_id,
                "messageId": record.message_id,
                "kind": record.kind,
                "sizeBytes": self._current_size(record),
                "mcpTools": list(record.mcp_tools),
                "allowExternal": record.allow_external,
            }
        )
        return payload

    def _version_to_json(
        self, record: _Record, version: _Version
    ) -> dict[str, object]:
        payload = dict(version.extra)
        payload.update(
            {
                "versionId": version.version_id,
                "version": version.number,
                "uri": _uri(record.id, version.version_id),
                "mimeType": MIME_TYPE,
                "sha256": version.sha256,
                "title": record.title,
                "createdAt": version.created_at,
                "immutable": True,
                "entry": ENTRY,
                "csp": dict(DEFAULT_CSP),
                "permissions": dict(DEFAULT_PERMISSIONS),
                "displayModes": list(DISPLAY_MODES),
                "sizeBytes": version.size_bytes,
                "source": version.source,
                "sessionId": version.session_id,
                "turnId": version.turn_id,
                "messageId": version.message_id,
            }
        )
        if version.file_name:
            payload["fileName"] = version.file_name
        return payload

    def _record_from_json(self, raw: object) -> _Record | None:
        if not isinstance(raw, dict):
            return None
        artifact_id = raw.get("id") or raw.get("artifactId")
        if not isinstance(artifact_id, str) or not artifact_id:
            return None
        try:
            artifact_id = _validate_id(artifact_id)
        except InvalidInput:
            return None
        created = _as_int(raw.get("createdAt"))
        updated = _as_int(raw.get("updatedAt")) or created
        history_raw = raw.get("history")
        history: list[_Version] = []
        if isinstance(history_raw, list):
            for item in history_raw:
                version = self._version_from_json(item)
                if version is not None:
                    history.append(version)
        current = raw.get("current")
        if not isinstance(current, str) or _VERSION_ID.fullmatch(current) is None:
            current = max(history, key=lambda item: item.number).version_id if history else "v1"
        history.sort(key=lambda item: item.number)
        return _Record(
            id=artifact_id,
            title=str(raw.get("title") or "Artifact"),
            description=str(raw.get("description") or ""),
            created_at=created,
            updated_at=updated,
            last_opened_at=_as_optional_int(raw.get("lastOpenedAt")),
            current=current,
            history=history,
            session_id=_as_optional_str(raw.get("sessionId")),
            turn_id=_as_optional_str(raw.get("turnId")),
            message_id=_as_optional_str(raw.get("messageId")),
            kind=str(raw.get("kind") or "html"),
            mcp_tools=_as_tool_names(raw.get("mcpTools")),
            allow_external=raw.get("allowExternal") is True,
            extra={
                key: value
                for key, value in raw.items()
                if key not in _RECORD_KNOWN
            },
        )

    def _version_from_json(self, raw: object) -> _Version | None:
        if not isinstance(raw, dict):
            return None
        version_id = raw.get("versionId")
        if not isinstance(version_id, str):
            number = _as_int(raw.get("version"))
            version_id = f"v{number}" if number > 0 else ""
        if _VERSION_ID.fullmatch(version_id) is None:
            return None
        file_name = raw.get("fileName")
        if not isinstance(file_name, str) or Path(file_name).name != file_name:
            file_name = ""
        return _Version(
            version_id=version_id,
            created_at=_as_int(raw.get("createdAt")),
            sha256=str(raw.get("sha256") or ""),
            size_bytes=_as_int(raw.get("sizeBytes")),
            source=str(raw.get("source") or "manual"),
            session_id=_as_optional_str(raw.get("sessionId")),
            turn_id=_as_optional_str(raw.get("turnId")),
            message_id=_as_optional_str(raw.get("messageId")),
            file_name=file_name,
            extra={
                key: value
                for key, value in raw.items()
                if key not in _VERSION_KNOWN
            },
        )

    def _ensure_history(self, record: _Record) -> None:
        if record.history:
            if any(item.version_id == record.current for item in record.history):
                return
            record.current = max(record.history, key=lambda item: item.number).version_id
            return

        directory = self._directory(record.id)
        versions_dir = directory / _VERSIONS
        modern: list[tuple[int, Path]] = []
        legacy: list[tuple[int, Path]] = []
        if versions_dir.is_dir():
            for entry in sorted(versions_dir.iterdir()):
                if not entry.is_file() or entry.suffix.lower() != ".html":
                    continue
                match = _VERSION_ID.fullmatch(entry.stem)
                if match is not None:
                    modern.append((int(match.group(1)), entry))
                elif _LEGACY_VERSION.fullmatch(entry.stem):
                    legacy.append((int(entry.stem), entry))

        history: list[_Version] = []
        next_number = max((number for number, _ in modern), default=0) + 1
        numbered: list[tuple[int, Path, bool]] = [
            (number, path, False) for number, path in modern
        ]
        for offset, (_, legacy_path) in enumerate(sorted(legacy)):
            numbered.append((next_number + offset, legacy_path, True))

        for number, path, is_legacy in sorted(numbered):
            try:
                content = path.read_text(encoding="utf-8")
                created_at = int(path.stat().st_mtime * 1000)
            except (OSError, UnicodeDecodeError):
                continue
            version_id = f"v{number}"
            history.append(
                _Version(
                    version_id=version_id,
                    created_at=created_at,
                    sha256=sha256_text(content),
                    size_bytes=len(content.encode("utf-8")),
                    source="legacy",
                    file_name=path.name if is_legacy else "",
                )
            )
        if not history:
            index = directory / _INDEX
            if not index.is_file():
                return
            try:
                content = index.read_text(encoding="utf-8")
                created_at = int(index.stat().st_mtime * 1000)
            except (OSError, UnicodeDecodeError):
                return
            history.append(
                _Version(
                    version_id="v1",
                    created_at=created_at,
                    sha256=sha256_text(content),
                    size_bytes=len(content.encode("utf-8")),
                    source="legacy",
                )
            )
        history.sort(key=lambda item: item.number)
        record.history = history
        record.current = history[-1].version_id

    def _refresh_from_disk(self) -> RecordList:
        if not self._root.is_dir():
            return []
        records: list[_Record] = []
        try:
            directories = [item for item in self._root.iterdir() if item.is_dir()]
        except OSError:
            return []
        for directory in sorted(directories):
            try:
                artifact_id = _validate_id(directory.name)
            except InvalidInput:
                continue
            index = directory / _INDEX
            if not index.is_file():
                continue
            try:
                html = index.read_text(encoding="utf-8")
                stat = index.stat()
            except (OSError, UnicodeDecodeError):
                continue
            meta = extract_meta(html)
            created = int(stat.st_mtime * 1000)
            record = _Record(
                id=artifact_id,
                title=str(meta.get("name") or artifact_id),
                description=str(meta.get("description") or ""),
                created_at=created,
                updated_at=created,
            )
            self._ensure_history(record)
            records.append(record)
        return records

    def _find(self, manifest: _Manifest, artifact_id: str) -> _Record:
        for record in manifest.records:
            if record.id == artifact_id:
                return record
        raise ArtifactNotFound(f"artifact not found: {artifact_id}")

    def _find_materialized_record(
        self,
        records: Sequence[_Record],
        *,
        title: str,
        session_id: str | None,
    ) -> _Record | None:
        if session_id is not None:
            for record in records:
                if record.title == title and record.session_id == session_id:
                    return record
            return None
        for record in records:
            if record.title == title:
                return record
        return None

    def _find_version(self, record: _Record, version_id: str) -> _Version:
        for version in record.history:
            if version.version_id == version_id:
                return version
        raise ArtifactNotFound(f"artifact version not found: {version_id}")

    def _new_record(
        self,
        manifest: _Manifest,
        *,
        title: str,
        description: str,
        document: str,
        digest: str,
        size: int,
        source: str,
        session_id: str | None,
        turn_id: str | None,
        message_id: str | None,
        mcp_tools: tuple[str, ...] = (),
        allow_external: bool = False,
    ) -> _Record:
        now = self._clock.now_ms()
        artifact_id = _unique_id(manifest.records, _slugify(title))
        record = _Record(
            id=artifact_id,
            title=title,
            description=description,
            created_at=now,
            updated_at=now,
            session_id=session_id,
            turn_id=turn_id,
            message_id=message_id,
            mcp_tools=tuple(mcp_tools),
            allow_external=allow_external,
        )
        version = _Version(
            version_id="v1",
            created_at=now,
            sha256=digest,
            size_bytes=size,
            source=source,
            session_id=session_id,
            turn_id=turn_id,
            message_id=message_id,
        )
        self._write_version(record, version, document)
        self._write_index(record, document)
        record.history = [version]
        record.current = version.version_id
        manifest.records.append(record)
        return record

    def _append_version(
        self,
        record: _Record,
        *,
        document: str,
        digest: str,
        size: int,
        source: str,
        session_id: str | None,
        turn_id: str | None,
        message_id: str | None,
        dedupe: bool = True,
    ) -> _Version | None:
        current = self._current_version(record)
        if dedupe and current is not None and current.sha256 == digest:
            record.description = record.description or ""
            return None

        now = self._clock.now_ms()
        number = max((item.number for item in record.history), default=0) + 1
        while self._directory(record.id).joinpath(
            _VERSIONS, f"v{number}.html"
        ).exists():
            number += 1
        version = _Version(
            version_id=f"v{number}",
            created_at=now,
            sha256=digest,
            size_bytes=size,
            source=source,
            session_id=session_id,
            turn_id=turn_id,
            message_id=message_id,
        )
        self._write_version(record, version, document)
        self._write_index(record, document)
        record.history.append(version)
        record.current = version.version_id
        record.updated_at = now
        if session_id is not None:
            record.session_id = session_id
        if turn_id is not None:
            record.turn_id = turn_id
        if message_id is not None:
            record.message_id = message_id
        return version

    def _write_version(
        self, record: _Record, version: _Version, document: str
    ) -> None:
        try:
            _atomic_write_text(self._version_path(record, version), document)
        except OSError as exc:
            raise ArtifactUnavailable("could not write artifact version") from exc

    def _write_index(self, record: _Record, document: str) -> None:
        try:
            _atomic_write_text(self._index_path(record), document)
        except OSError as exc:
            raise ArtifactUnavailable("could not write artifact") from exc

    def _read_current(self, record: _Record) -> str:
        try:
            return self._index_path(record).read_text(encoding="utf-8")
        except OSError as exc:
            raise ArtifactNotFound("artifact content is unavailable") from exc

    def _current_version(self, record: _Record) -> _Version | None:
        for version in record.history:
            if version.version_id == record.current:
                return version
        return record.history[-1] if record.history else None

    def _current_size(self, record: _Record) -> int:
        current = self._current_version(record)
        return current.size_bytes if current is not None else 0

    def _version_value(
        self, record: _Record, version: _Version
    ) -> ArtifactVersion:
        return ArtifactVersion(
            version_id=version.version_id,
            created_at=version.created_at,
            sha256=version.sha256,
            size_bytes=version.size_bytes,
            source=version.source,
            session_id=version.session_id,
            turn_id=version.turn_id,
            message_id=version.message_id,
            immutable=True,
            uri=_uri(record.id, version.version_id),
            mime_type=MIME_TYPE,
            entry=ENTRY,
        )

    def _to_value(self, record: _Record) -> Artifact:
        current = self._current_version(record)
        version_refs = tuple(
            self._version_value(record, item)
            for item in sorted(
                record.history, key=lambda entry: entry.number, reverse=True
            )
        )
        versions = tuple(
            item.created_at
            for item in sorted(record.history, key=lambda entry: entry.number)
            if current is None or item.version_id != current.version_id
        )
        return Artifact(
            id=record.id,
            title=record.title,
            description=record.description,
            created_at=record.created_at,
            updated_at=record.updated_at,
            last_opened_at=record.last_opened_at,
            versions=versions,
            content_url=f"/api/artifacts/{record.id}/content",
            thumbnail_url=None,
            kind=record.kind,
            session_id=record.session_id,
            turn_id=record.turn_id,
            message_id=record.message_id,
            revision=current.version_id if current is not None else "v1",
            version_refs=version_refs,
            size_bytes=current.size_bytes if current is not None else 0,
            mcp_tools=record.mcp_tools,
            allow_external=record.allow_external,
        )

    @staticmethod
    def _extract_safely(source: Path, destination: Path) -> None:
        try:
            with zipfile.ZipFile(source) as archive:
                members = archive.infolist()
                if len(members) > _MAX_ZIP_ENTRIES:
                    raise InvalidInput("artifact archive has too many entries")
                if sum(item.file_size for item in members) > _MAX_ZIP_BYTES:
                    raise InvalidInput("artifact archive is too large")
                for item in members:
                    name = item.filename
                    candidate = Path(name)
                    if (
                        candidate.is_absolute()
                        or ".." in candidate.parts
                        or (candidate.parts and ":" in candidate.parts[0])
                    ):
                        raise InvalidInput("artifact archive contains an unsafe path")
                    target = (destination / candidate).resolve()
                    if not target.is_relative_to(destination.resolve()):
                        raise InvalidInput("artifact archive contains an unsafe path")
                archive.extractall(destination)
        except zipfile.BadZipFile as exc:
            raise InvalidInput("artifact archive is not a valid zip file") from exc
        except OSError as exc:
            raise ArtifactUnavailable("could not read artifact archive") from exc

    @staticmethod
    def _find_index(directory: Path) -> Path | None:
        candidates = [
            item
            for item in directory.rglob("*")
            if item.is_file() and item.name.lower() == _INDEX
        ]
        if not candidates:
            return None
        return min(candidates, key=lambda item: len(item.relative_to(directory).parts))


def _unique_id(records: Sequence[_Record], base: str) -> str:
    taken = {item.id for item in records}
    if base not in taken:
        return base
    suffix_number = 2
    while True:
        suffix = f"-{suffix_number}"
        candidate = base[: _MAX_ID_CHARS - len(suffix)] + suffix
        if candidate not in taken:
            return candidate
        suffix_number += 1


def _as_int(value: object) -> int:
    return int(value) if isinstance(value, (int, float)) else 0


def _as_optional_int(value: object) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def _as_optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _as_tool_names(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    names: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        name = item.strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    return tuple(names)


def _target_path(raw: str) -> Path:
    cleaned = raw.strip()
    if not cleaned or "\x00" in cleaned:
        raise InvalidInput("a target path is required")
    target = Path(cleaned).expanduser()
    if target.is_dir():
        raise InvalidInput("target path is a directory")
    return target


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
