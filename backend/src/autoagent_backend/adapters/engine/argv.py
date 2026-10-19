"""The single source of engine CLI flags.

There is exactly one permission source. In v1 the only supported policy is full
access, which maps to ``--dangerously-skip-permissions`` and never to
``--permission-mode``. A prompted policy is modelled but requires a permission
broker and is rejected by the settings layer.
"""

from __future__ import annotations

import os
import shutil
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from ...domain.errors import EngineUnavailable
from ...domain.models import Settings
from ...paths import repo_root

# Flags every persistent MateBot child must carry (recon §5.2).
REQUIRED_FLAGS: tuple[str, ...] = (
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--include-hook-events",
    "--matebot",
)

FULL_ACCESS_FLAG = "--dangerously-skip-permissions"
PERMISSION_MODE_FLAG = "--permission-mode"


class PermissionKind(StrEnum):
    FULL_ACCESS = "full_access"
    PROMPTED = "prompted"


@dataclass(frozen=True, slots=True)
class PermissionPolicy:
    kind: PermissionKind = PermissionKind.FULL_ACCESS
    mode: str | None = None

    def __post_init__(self) -> None:
        if self.kind is PermissionKind.PROMPTED and not self.mode:
            raise ValueError("prompted permission policy requires a mode")


FULL_ACCESS = PermissionPolicy(PermissionKind.FULL_ACCESS)


def permission_args(policy: PermissionPolicy) -> tuple[str, ...]:
    """Map a policy to argv flags.

    Post: returns exactly one permission source. ``FULL_ACCESS`` yields only
          ``--dangerously-skip-permissions``; ``PROMPTED`` yields only
          ``--permission-mode <mode>``. The two never appear together.
    """

    if policy.kind is PermissionKind.FULL_ACCESS:
        return (FULL_ACCESS_FLAG,)
    assert policy.mode is not None
    return (PERMISSION_MODE_FLAG, policy.mode)


@dataclass(frozen=True, slots=True)
class EngineCommand:
    bun_path: Path
    cli_path: Path
    cwd: Path
    model: str | None = None
    append_system_prompt: str | None = None
    resume: str | None = None
    add_dirs: tuple[str, ...] = ()
    permission: PermissionPolicy = field(default_factory=lambda: FULL_ACCESS)
    extra_args: tuple[str, ...] = ()
    matebot: bool = True


def build_argv(command: EngineCommand) -> list[str]:
    """Build the exact child argv array (never a shell string).

    Post: every element is a separate argument; user-controlled values occupy
          their own element. ``--matebot`` is present for the opencc harness and
          absent for the plain claude-code harness.
    """

    argv: list[str] = [
        str(command.bun_path),
        str(command.cli_path),
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--include-hook-events",
    ]
    argv.extend(permission_args(command.permission))
    if command.matebot:
        argv.append("--matebot")
    if command.model:
        argv.extend(("--model", command.model))
    if command.append_system_prompt:
        argv.extend(("--append-system-prompt", command.append_system_prompt))
    for directory in command.add_dirs:
        argv.extend(("--add-dir", directory))
    if command.resume:
        argv.extend(("--resume", command.resume))
    argv.extend(command.extra_args)
    return argv


def command_for_settings(
    *,
    settings: Settings,
    bun_path: Path,
    cli_path: Path,
    cwd: Path,
    resume: str | None,
    matebot: bool = True,
) -> EngineCommand:
    return EngineCommand(
        bun_path=bun_path,
        cli_path=cli_path,
        cwd=cwd,
        model=settings.model or None,
        append_system_prompt=settings.append_system_prompt or None,
        resume=resume,
        add_dirs=settings.add_dirs,
        permission=FULL_ACCESS,
        matebot=matebot,
    )


def resolve_bun(explicit: str | Path | None = None) -> Path:
    """Locate the Bun executable.

    Raises: ``EngineUnavailable`` listing the locations that were tried.
    """

    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_path = os.environ.get("AUTOAGENT_BUN_PATH", "").strip()
    if env_path:
        candidates.append(Path(env_path).expanduser())
    which = shutil.which("bun")
    if which:
        candidates.append(Path(which))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    tried = ", ".join(str(candidate) for candidate in candidates) or "none"
    raise EngineUnavailable(f"bun executable not found (tried: {tried})")


def resolve_cli(explicit: str | Path | None = None) -> Path:
    """Locate the vendored opencc CLI.

    Order: explicit -> ``AUTOAGENT_OPENCC_CLI_PATH`` -> repository build ->
    user installs. Raises ``EngineUnavailable`` listing every candidate.
    """

    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_path = os.environ.get("AUTOAGENT_OPENCC_CLI_PATH", "").strip()
    if env_path:
        candidates.append(Path(env_path).expanduser())
    candidates.extend(
        (
            repo_root() / "packages" / "opencc" / "dist" / "cli.js",
            repo_root() / "vendor" / "opencc" / "dist" / "cli.js",
            Path.home() / ".local" / "share" / "opencc" / "cli.js",
            Path.home() / ".opencc" / "cli.js",
        )
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    tried = ", ".join(str(candidate) for candidate in candidates)
    raise EngineUnavailable(f"opencc CLI not found (tried: {tried})")


def valid_engine_ref(value: str | None) -> str | None:
    """Normalize an engine session ref, rejecting non-UUID values."""

    if not value:
        return None
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        return None
