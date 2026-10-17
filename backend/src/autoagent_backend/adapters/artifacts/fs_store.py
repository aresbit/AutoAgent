"""Filesystem artifact store.

``manifest.json`` is authoritative for metadata in v1.  Each artifact lives in
``<root>/<id>/index.html`` with prior snapshots in ``<root>/<id>/versions/``.
The manifest keeps the legacy camelCase shape so an existing data directory can
be adopted without a rewrite.

All ids are validated as a single path segment before any path is derived; the
manifest is consulted first for get/content/export, so a crafted id can never
escape the root.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from ...domain.errors import ArtifactNotFound, ArtifactUnavailable, InvalidInput
from ...domain.models import Artifact, ArtifactCreate
from ...domain.ports import ClockPort

_MANIFEST = "manifest.json"
_INDEX = "index.html"
_VERSIONS = "versions"
_META_SCRIPT_ID = "autowork-artifact-meta"
_MAX_VERSIONS = 100
_MAX_ZIP_ENTRIES = 2000
_MAX_ZIP_BYTES = 50 * 1024 * 1024
_SLUG = re.compile(r"[^a-z0-9]+")
_META_SCRIPT = re.compile(
    r"\s*<script\b(?=[^>]*\bid=\"(?:cowork|autowork)-artifact-meta\")"
    r"(?=[^>]*\btype=\"application/json\")[^>]*>[\s\S]*?</script>\s*",
    re.IGNORECASE,
)
_META_PAYLOAD = re.compile(
    r"<script\b(?=[^>]*\bid=\"(?:cowork|autowork)-artifact-meta\")"
    r"(?=[^>]*\btype=\"application/json\")[^>]*>([\s\S]*?)</script>",
    re.IGNORECASE,
)


def _slugify(title: str) -> str:
    return _SLUG.sub("-", title.lower()).strip("-")[:_MAX_ID_CHARS] or "artifact"


_MAX_ID_CHARS = 48


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


def _extract_meta(html: str) -> dict[str, object]:
    match = _META_PAYLOAD.search(html)
    if match is None:
        return {}
    try:
        decoded = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def _strip_meta(html: str) -> str:
    return _META_SCRIPT.sub("", html, count=1)


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _inject_meta(html: str, meta: dict[str, object]) -> str:
    cleaned = _strip_meta(html)
    payload = json.dumps(meta, ensure_ascii=False).replace("</", "<\\/")
    script = (
        f'<script id="{_META_SCRIPT_ID}" type="application/json">'
        f"{payload}</script>"
    )
    if re.search(r"</head\s*>", cleaned, re.IGNORECASE):
        return re.sub(
            r"</head\s*>", script + "</head>", cleaned, count=1, flags=re.IGNORECASE
        )
    return script + cleaned


def _html_shell(title: str, body: str, description: str) -> str:
    if re.search(r"<html[\s>]", body, re.IGNORECASE):
        return _inject_meta(
            body, {"name": title, "schemaVersion": 1, "description": description}
        )
    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{_escape(title)}</title>
  <style>
    :root {{ color-scheme: light dark; font-family: Inter, system-ui, sans-serif; }}
    body {{ margin: 0; padding: 24px; line-height: 1.6; }}
    main {{ max-width: 1100px; margin: 0 auto; }}
    pre {{ white-space: pre-wrap; }}
  </style>
</head>
<body>
  <main>
    <h1>{_escape(title)}</h1>
    {f"<p>{_escape(description)}</p>" if description else ""}
    {body}
  </main>
</body>
</html>"""
    return _inject_meta(
        document, {"name": title, "schemaVersion": 1, "description": description}
    )


@dataclass
class _Record:
    id: str
    title: str
    description: str
    path: Path
    created_at: int
    updated_at: int
    last_opened_at: int | None = None
    versions: list[int] = field(default_factory=list)


RecordList = list[_Record]


def _record_to_json(record: _Record) -> dict[str, object]:
    return {
        "id": record.id,
        "title": record.title,
        "description": record.description,
        "path": str(record.path),
        "createdAt": record.created_at,
        "updatedAt": record.updated_at,
        "lastOpenedAt": record.last_opened_at,
        "versions": list(record.versions),
        "isStarred": True,
        "mcpTools": [],
        "mcpServerNames": [],
        "thumbnailPath": None,
    }


def _record_from_json(raw: object) -> _Record | None:
    if not isinstance(raw, dict):
        return None
    artifact_id = raw.get("id")
    path = raw.get("path")
    if not isinstance(artifact_id, str) or not artifact_id:
        return None
    if not isinstance(path, str) or not path:
        return None
    created = raw.get("createdAt")
    updated = raw.get("updatedAt")
    opened = raw.get("lastOpenedAt")
    versions = raw.get("versions")
    return _Record(
        id=artifact_id,
        title=str(raw.get("title") or "Artifact"),
        description=str(raw.get("description") or ""),
        path=Path(path),
        created_at=int(created) if isinstance(created, (int, float)) else 0,
        updated_at=int(updated) if isinstance(updated, (int, float)) else 0,
        last_opened_at=int(opened) if isinstance(opened, (int, float)) else None,
        versions=(
            [int(item) for item in versions if isinstance(item, (int, float))]
            if isinstance(versions, list)
            else []
        ),
    )


class FilesystemArtifactStore:
    """Implements ``ArtifactStorePort`` with ``manifest.json`` as the authority."""

    def __init__(self, root: Path | str, clock: ClockPort) -> None:
        self._root = Path(root).expanduser()
        self._clock = clock

    # -- port --------------------------------------------------------------

    def list(self) -> tuple[Artifact, ...]:
        records = self._load()
        if not records:
            records = self._refresh_from_disk()
        records.sort(key=lambda item: (item.updated_at, item.created_at), reverse=True)
        return tuple(self._to_value(item) for item in records)

    def get(self, artifact_id: str) -> Artifact:
        return self._to_value(self._find(_validate_id(artifact_id)))

    def create(self, request: ArtifactCreate) -> Artifact:
        title = (request.title or "").strip() or "Artifact"
        description = (request.description or "").strip()
        artifact_id = _slugify(title)
        now = self._clock.now_ms()
        directory = self._directory(artifact_id)
        index = directory / _INDEX
        records = self._load()
        existing = next((item for item in records if item.id == artifact_id), None)
        versions = list(existing.versions) if existing else []
        created_at = existing.created_at if existing else now
        try:
            directory.mkdir(parents=True, exist_ok=True)
            if existing is not None and index.is_file():
                timestamp = existing.updated_at or existing.created_at or now
                versions_dir = directory / _VERSIONS
                versions_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(index, versions_dir / f"{timestamp}.html")
                versions.append(timestamp)
                versions = versions[-_MAX_VERSIONS:]
            document = _html_shell(title, request.html, description)
            _atomic_write_text(index, document)
        except OSError as exc:
            raise ArtifactUnavailable("could not write artifact") from exc
        record = _Record(
            id=artifact_id,
            title=title,
            description=description,
            path=index,
            created_at=created_at,
            updated_at=now,
            last_opened_at=existing.last_opened_at if existing else None,
            versions=versions,
        )
        saved = self._upsert(record)
        return self._to_value(saved)

    def content(self, artifact_id: str) -> str:
        record = self._find(_validate_id(artifact_id))
        try:
            return record.path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ArtifactNotFound("artifact content is unavailable") from exc

    def mark_opened(self, artifact_id: str) -> Artifact:
        record = self._find(_validate_id(artifact_id))
        touched = _Record(
            id=record.id,
            title=record.title,
            description=record.description,
            path=record.path,
            created_at=record.created_at,
            updated_at=record.updated_at,
            last_opened_at=self._clock.now_ms(),
            versions=list(record.versions),
        )
        return self._to_value(self._upsert(touched))

    def export(self, artifact_id: str, target_path: str) -> str:
        record = self._find(_validate_id(artifact_id))
        target = _target_path(target_path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
                for entry in sorted(record.path.parent.rglob("*")):
                    if entry == target or not entry.is_file():
                        continue
                    archive.write(entry, entry.relative_to(record.path.parent).as_posix())
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
            meta = _extract_meta(html)
            relative = index.relative_to(directory)
            fallback = relative.parts[-2] if len(relative.parts) > 1 else "Artifact"
            title = str(meta.get("name") or fallback)
            description = str(meta.get("description") or "")
            return self.create(
                ArtifactCreate(
                    html=_strip_meta(html), title=title, description=description
                )
            )

    # -- internals ---------------------------------------------------------

    def _directory(self, artifact_id: str) -> Path:
        return self._root / artifact_id

    def _manifest_path(self) -> Path:
        return self._root / _MANIFEST

    def _load(self) -> RecordList:
        path = self._manifest_path()
        if not path.is_file():
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(raw, list):
            return []
        records: RecordList = []
        for item in raw:
            record = _record_from_json(item)
            if record is not None:
                records.append(record)
        return records

    def _upsert(self, record: _Record) -> _Record:
        records = [item for item in self._load() if item.id != record.id]
        records.append(record)
        records.sort(key=lambda item: (item.updated_at, item.created_at), reverse=True)
        self._save(records)
        return record

    def _save(self, records: Sequence[_Record]) -> None:
        try:
            self._root.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(
                [_record_to_json(item) for item in records],
                ensure_ascii=False,
                indent=2,
            )
            _atomic_write_text(self._manifest_path(), payload + "\n")
        except OSError as exc:
            raise ArtifactUnavailable("could not write artifact manifest") from exc

    def _refresh_from_disk(self) -> RecordList:
        if not self._root.is_dir():
            return []
        records: RecordList = []
        try:
            directories = [
                item for item in self._root.iterdir() if item.is_dir()
            ]
        except OSError:
            return []
        for directory in sorted(directories):
            index = directory / _INDEX
            if not index.is_file():
                continue
            try:
                html = index.read_text(encoding="utf-8")
                stat = index.stat()
            except (OSError, UnicodeDecodeError):
                continue
            meta = _extract_meta(html)
            versions_dir = directory / _VERSIONS
            versions: list[int] = []
            if versions_dir.is_dir():
                for entry in versions_dir.iterdir():
                    if entry.is_file() and entry.suffix.lower() == ".html":
                        timestamp = entry.stem
                        if timestamp.isdigit():
                            versions.append(int(timestamp))
            records.append(
                _Record(
                    id=directory.name,
                    title=str(meta.get("name") or directory.name),
                    description=str(meta.get("description") or ""),
                    path=index,
                    created_at=int(stat.st_mtime * 1000),
                    updated_at=int(stat.st_mtime * 1000),
                    versions=sorted(versions, reverse=True),
                )
            )
        if records:
            self._save(records)
        return records

    def _find(self, artifact_id: str) -> _Record:
        records = self._load()
        if not records:
            records = self._refresh_from_disk()
        for record in records:
            if record.id == artifact_id:
                return record
        raise ArtifactNotFound(f"artifact not found: {artifact_id}")

    def _to_value(self, record: _Record) -> Artifact:
        return Artifact(
            id=record.id,
            title=record.title,
            description=record.description,
            created_at=record.created_at,
            updated_at=record.updated_at,
            last_opened_at=record.last_opened_at,
            versions=tuple(record.versions),
            content_url=f"/api/artifacts/{record.id}/content",
            thumbnail_url=None,
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
