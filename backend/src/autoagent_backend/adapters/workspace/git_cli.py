"""Git CLI workspace adapter.

Every invocation uses an argv array with ``shell=False`` (the default) and a
timeout.  Parsing of ``--name-status``/``--numstat``/``--format`` stays here; the
application only sees one ``WorkspaceStatus`` value.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from ...domain.errors import InvalidInput, WorkspaceUnavailable
from ...domain.models import Branch, ChangedFile, FileDiff, WorkspaceStatus

_TIMEOUT_SECONDS = 10.0
_MAX_DETAIL_CHARS = 200


class GitCliWorkspace:
    """Implements ``WorkspacePort`` by invoking the ``git`` executable."""

    def __init__(self, default_work_dir: str, *, timeout: float = _TIMEOUT_SECONDS) -> None:
        self._default = default_work_dir
        self._timeout = timeout

    # -- port --------------------------------------------------------------

    def status(
        self, work_dir: str | None = None, base: str | None = None
    ) -> WorkspaceStatus:
        root = self._root(work_dir)
        if not root.is_dir():
            return WorkspaceStatus(
                work_dir=str(root),
                is_git_repo=False,
                warnings=("working directory does not exist",),
            )
        inside = self._run(["git", "rev-parse", "--is-inside-work-tree"], root)
        is_git = inside.returncode == 0 and inside.stdout.strip() == "true"
        if not is_git:
            return WorkspaceStatus(work_dir=str(root), is_git_repo=False)

        warnings: list[str] = []
        diff_target = [_revision(base)] if base else []

        branches_result = self._run(
            ["git", "branch", "--all", "--format=%(refname:short)"], root
        )
        status_result = self._run(
            [
                "git",
                "diff",
                "--name-status",
                "--find-renames",
                *diff_target,
                "--",
            ],
            root,
        )
        numstat_result = self._run(
            [
                "git",
                "diff",
                "--numstat",
                "--find-renames",
                *diff_target,
                "--",
            ],
            root,
        )
        for label, result in (
            ("branches", branches_result),
            ("changed files", status_result),
            ("diff stat", numstat_result),
        ):
            if result.returncode != 0:
                warnings.append(f"git {label} failed: {_detail(result.stderr)}")

        branches = _parse_branches(branches_result.stdout)
        counts = _parse_numstat(numstat_result.stdout)
        files = _parse_name_status(status_result.stdout, counts)
        return WorkspaceStatus(
            work_dir=str(root),
            is_git_repo=True,
            additions=sum(item.additions for item in files),
            deletions=sum(item.deletions for item in files),
            changed_files=len(files),
            branches=branches,
            files=files,
            warnings=tuple(warnings),
        )

    def diff(self, path: str, work_dir: str | None = None) -> FileDiff:
        relative = _relative_path(path)
        root = self._root(work_dir)
        if not root.is_dir():
            raise WorkspaceUnavailable("working directory does not exist")
        inside = self._run(["git", "rev-parse", "--is-inside-work-tree"], root)
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            raise WorkspaceUnavailable("not a git repository")

        patch = self._run(["git", "diff", "--", relative], root)
        if patch.returncode != 0:
            raise WorkspaceUnavailable("git diff failed")
        head = self._run(["git", "show", f"HEAD:{relative}"], root)
        original = head.stdout if head.returncode == 0 else None
        current_path = root / relative
        try:
            current = current_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            current = None
        return FileDiff(
            path=relative, patch=patch.stdout, original=original, current=current
        )

    def switch_branch(self, branch: str, work_dir: str | None = None) -> None:
        target = _branch_name(branch)
        root = self._root(work_dir)
        if not root.is_dir():
            raise WorkspaceUnavailable("working directory does not exist")
        result = self._run(["git", "switch", target], root)
        if result.returncode != 0:
            raise WorkspaceUnavailable("failed to switch branch")

    def init(self, work_dir: str | None = None) -> None:
        root = self._root(work_dir)
        if not root.is_dir():
            raise InvalidInput("working directory does not exist")
        result = self._run(["git", "init"], root)
        if result.returncode != 0:
            raise WorkspaceUnavailable("failed to initialize repository")

    # -- internals ---------------------------------------------------------

    def _root(self, work_dir: str | None) -> Path:
        raw = work_dir or self._default
        if not str(raw).strip():
            raise InvalidInput("a working directory is required")
        return Path(raw).expanduser()

    def _run(self, argv: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                argv,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                timeout=self._timeout,
                check=False,
                shell=False,
            )
        except FileNotFoundError as exc:
            raise WorkspaceUnavailable("git is not installed") from exc
        except subprocess.TimeoutExpired as exc:
            raise WorkspaceUnavailable("git command timed out") from exc
        except OSError as exc:
            raise WorkspaceUnavailable("git could not be executed") from exc


def _detail(stderr: str) -> str:
    line = (stderr or "").strip().splitlines()
    return (line[0] if line else "unknown error")[:_MAX_DETAIL_CHARS]


def _relative_path(path: str) -> str:
    cleaned = path.strip()
    if (
        not cleaned
        or "\x00" in cleaned
        or "\\" in cleaned
        or cleaned.startswith("/")
        or any(part in {"", ".", ".."} for part in cleaned.split("/"))
    ):
        raise InvalidInput("invalid file path")
    return cleaned


def _branch_name(branch: str) -> str:
    cleaned = branch.strip()
    if not cleaned or cleaned.startswith("-") or any(
        char in cleaned for char in ("\x00", "\n", "\r", " ")
    ):
        raise InvalidInput("invalid branch name")
    return cleaned


def _revision(base: str) -> str:
    cleaned = base.strip()
    if (
        not cleaned
        or cleaned.startswith("-")
        or "\x00" in cleaned
        or "\n" in cleaned
        or "\r" in cleaned
    ):
        raise InvalidInput("invalid base revision")
    return cleaned


def _parse_branches(output: str) -> tuple[Branch, ...]:
    branches: list[Branch] = []
    seen: set[str] = set()
    for raw in output.splitlines():
        name = raw.strip().replace("origin/HEAD -> ", "")
        if not name or name in seen or name.endswith("/HEAD"):
            continue
        seen.add(name)
        branches.append(Branch(name=name, is_remote="/" in name))
    return tuple(branches)


def _parse_name_status(
    output: str, counts: dict[str, tuple[int, int]]
) -> tuple[ChangedFile, ...]:
    files: list[ChangedFile] = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        raw_status = parts[0]
        first = parts[1]
        current = parts[2] if len(parts) > 2 else first
        additions, deletions = counts.get(current, (0, 0))
        files.append(
            ChangedFile(
                path=current,
                status=_normalize_status(raw_status),
                additions=additions,
                deletions=deletions,
            )
        )
    return tuple(files)


def _parse_numstat(output: str) -> dict[str, tuple[int, int]]:
    counts: dict[str, tuple[int, int]] = {}
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        additions = int(parts[0]) if parts[0].isdigit() else 0
        deletions = int(parts[1]) if parts[1].isdigit() else 0
        current = parts[2]
        counts[current] = (additions, deletions)
        for key in _rename_keys(current):
            counts.setdefault(key, (additions, deletions))
    return counts


def _rename_keys(path: str) -> list[str]:
    if " => " not in path:
        return []
    if "{" in path and "}" in path:
        prefix, rest = path.split("{", 1)
        body, suffix = rest.split("}", 1)
        old, _, new = body.partition(" => ")
        return [f"{prefix}{old}{suffix}", f"{prefix}{new}{suffix}"]
    old, _, new = path.partition(" => ")
    return [old, new]


def _normalize_status(raw: str) -> str:
    first = raw[:1]
    return {
        "A": "added",
        "D": "deleted",
        "R": "renamed",
        "C": "copied",
        "T": "type_changed",
        "M": "modified",
    }.get(first, "unknown")
