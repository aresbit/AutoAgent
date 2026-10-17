"""Filesystem skill catalog.

Scan order (later entries win on a name collision):

1. user ``.claude/skills`` (active), user ``.autoagent/skills`` (active)
2. the same user directories' ``.disabled`` folders
3. project ``.claude/skills`` (active), project ``.autoagent/skills`` (active)
4. the same project directories' ``.disabled`` folders

Project skills therefore override user skills, and an explicit project-level
disable overrides a user-level copy. Enable/disable move the resolved entry into
(or out of) the sibling ``.disabled`` directory on the same filesystem, so the
operation is a rename rather than a copy whenever possible.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from ...domain.errors import InvalidInput, SkillNotFound, WorkspaceUnavailable
from ...domain.models import (
    Skill,
    SkillCatalogData,
    SkillDirectory,
    SkillMatch,
    SkillSource,
)

_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.DOTALL)
_DESCRIPTION_LINE = re.compile(r"^description:\s*(.+?)\s*$", re.MULTILINE)
_DISCOVER_ROOT_SEGMENTS = {
    "skill",
    "skills",
    ".codex",
    ".agents",
    ".claude",
    ".autoagent",
}
_DISCOVER_LIMIT = 250
_PRUNE_DIRS = {"node_modules", ".git", "dist", "build", "__pycache__"}


@dataclass(frozen=True, slots=True)
class _Located:
    skill: Skill
    path: Path
    base_dir: Path
    disabled: bool
    is_file: bool


def _validate_name(name: str) -> str:
    cleaned = name.strip()
    if (
        not cleaned
        or cleaned in {".", ".."}
        or "/" in cleaned
        or "\\" in cleaned
        or cleaned.startswith(".")
    ):
        raise InvalidInput("invalid skill name")
    return cleaned


def extract_description(content: str) -> str:
    """Return the frontmatter description or the first prose line (max 120)."""

    frontmatter = _FRONTMATTER.match(content)
    if frontmatter is not None:
        match = _DESCRIPTION_LINE.search(frontmatter.group(1))
        if match is not None:
            return match.group(1).strip().strip("'\"")
    body = _FRONTMATTER.sub("", content, count=1) if frontmatter else content
    for line in body.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped[:120]
    return ""


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _move(src: Path, dst: Path) -> None:
    """Move ``src`` to ``dst`` using a rename on the same filesystem."""

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists() or dst.is_symlink():
            _remove(dst)
        try:
            os.replace(src, dst)
        except OSError:
            # Cross-device fallback; still replaces the destination.
            if dst.exists() or dst.is_symlink():
                _remove(dst)
            shutil.move(str(src), str(dst))
    except OSError as exc:
        raise WorkspaceUnavailable("could not move skill directory") from exc


def _copy(src: Path, dst: Path) -> None:
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists() or dst.is_symlink():
            _remove(dst)
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    except OSError as exc:
        raise WorkspaceUnavailable("could not copy skill") from exc


class FilesystemSkillCatalog:
    """Implements ``SkillCatalogPort`` over the well-known skill directories."""

    def __init__(
        self,
        *,
        home_dir: Path | str,
        default_cwd: str | None = None,
        discover_limit: int = _DISCOVER_LIMIT,
    ) -> None:
        self._home = Path(home_dir).expanduser()
        self._default_cwd = default_cwd
        self._discover_limit = discover_limit

    # -- public port -------------------------------------------------------

    def catalog(self, cwd: str | None = None) -> SkillCatalogData:
        root = self._workspace(cwd)
        dirs = self._directories(root)
        located = self._scan(dirs)
        skills = tuple(item.skill for item in located.values())
        return SkillCatalogData(
            skills=skills,
            dirs=tuple(
                SkillDirectory(path=str(path), source=source, exists=path.is_dir())
                for path, source, _disabled in dirs
            ),
        )

    def enable(
        self, name: str, path: str | None = None, cwd: str | None = None
    ) -> SkillCatalogData:
        target = _validate_name(name)
        root = self._workspace(cwd)
        located = self._scan(self._directories(root)).get(target)
        if located is not None and not located.disabled:
            return self.catalog(str(root))
        if located is not None:
            active_base = (
                located.base_dir.parent if located.disabled else located.base_dir
            )
            destination = active_base / located.path.name
            _move(located.path, destination)
            return self.catalog(str(root))
        if path is None:
            raise SkillNotFound(f"skill not found: {target}")
        source = Path(path).expanduser()
        if not source.exists():
            raise InvalidInput("skill path does not exist")
        if not source.is_dir() and source.suffix.lower() != ".md":
            raise InvalidInput("skill path must be a directory or markdown file")
        base = root / ".autoagent" / "skills"
        destination = base / (target if source.is_dir() else f"{target}.md")
        _copy(source, destination)
        return self.catalog(str(root))

    def disable(self, name: str, cwd: str | None = None) -> SkillCatalogData:
        target = _validate_name(name)
        root = self._workspace(cwd)
        located = self._scan(self._directories(root)).get(target)
        if located is None:
            raise SkillNotFound(f"skill not found: {target}")
        if located.disabled:
            return self.catalog(str(root))
        destination = located.base_dir / ".disabled" / located.path.name
        _move(located.path, destination)
        return self.catalog(str(root))

    def discover(
        self, cwd: str | None = None, query: str | None = None
    ) -> tuple[SkillMatch, ...]:
        root = self._workspace(cwd)
        if not root.is_dir():
            return ()
        needle = (query or "").strip().lower()
        matches: list[SkillMatch] = []
        for directory, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(
                name
                for name in dirnames
                if name in _DISCOVER_ROOT_SEGMENTS
                or (not name.startswith(".") and name not in _PRUNE_DIRS)
            )
            current = Path(directory)
            for filename in sorted(filenames):
                candidate = current / filename
                try:
                    relative = candidate.relative_to(root).as_posix()
                except ValueError:  # pragma: no cover - os.walk root invariant
                    continue
                lower_parts = {part.lower() for part in relative.split("/")[:-1]}
                is_skill_md = filename.lower() == "skill.md"
                if not is_skill_md and not (lower_parts & _DISCOVER_ROOT_SEGMENTS):
                    continue
                if needle and needle not in relative.lower():
                    continue
                name = current.name if is_skill_md else candidate.stem
                matches.append(
                    SkillMatch(id=relative, name=name, path=str(candidate.resolve()))
                )
                if len(matches) >= self._discover_limit:
                    return tuple(matches)
        return tuple(matches)

    # -- internals ---------------------------------------------------------

    def _workspace(self, cwd: str | None) -> Path:
        raw = cwd or self._default_cwd
        if raw is None or not str(raw).strip():
            raise InvalidInput("a workspace directory is required")
        return Path(raw).expanduser()

    def _directories(
        self, root: Path
    ) -> tuple[tuple[Path, SkillSource, bool], ...]:
        user: tuple[tuple[Path, SkillSource], ...] = (
            (self._home / ".claude" / "skills", "system"),
            (self._home / ".autoagent" / "skills", "system"),
        )
        project: tuple[tuple[Path, SkillSource], ...] = (
            (root / ".claude" / "skills", "project"),
            (root / ".autoagent" / "skills", "project"),
        )
        ordered: list[tuple[Path, SkillSource, bool]] = []
        for entries in (user, project):
            for path, source in entries:
                ordered.append((path, source, False))
            for path, source in entries:
                ordered.append((path / ".disabled", source, True))
        return tuple(ordered)

    def _scan(
        self, dirs: tuple[tuple[Path, SkillSource, bool], ...]
    ) -> dict[str, _Located]:
        found: dict[str, _Located] = {}
        for base, source, disabled in dirs:
            if not base.is_dir():
                continue
            try:
                entries = sorted(base.iterdir(), key=lambda entry: entry.name)
            except OSError:
                continue
            for entry in entries:
                if entry.name == ".disabled" or entry.name.startswith("."):
                    continue
                located = self._read_entry(entry, base, source, disabled)
                if located is not None:
                    found[located.skill.name] = located
        return found

    def _read_entry(
        self, entry: Path, base: Path, source: SkillSource, disabled: bool
    ) -> _Located | None:
        if entry.is_dir():
            markdown = self._skill_markdown(entry)
            if markdown is None:
                return None
            try:
                content = markdown.read_text(encoding="utf-8")
            except OSError:
                return None
            name = entry.name
            path = entry
            is_file = False
        elif entry.is_file() and entry.suffix.lower() == ".md":
            try:
                content = entry.read_text(encoding="utf-8")
            except OSError:
                return None
            name = base.parent.name if entry.name.lower() == "skill.md" else entry.stem
            path = entry
            is_file = True
        else:
            return None
        description = extract_description(content)
        return _Located(
            skill=Skill(
                name=name,
                description=description or f"Skill: {name}",
                source=source,
                enabled=not disabled,
            ),
            path=path,
            base_dir=base,
            disabled=disabled,
            is_file=is_file,
        )

    @staticmethod
    def _skill_markdown(directory: Path) -> Path | None:
        for candidate in ("SKILL.md", "skill.md"):
            path = directory / candidate
            if path.is_file():
                return path
        return None
