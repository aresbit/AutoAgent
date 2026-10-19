#!/usr/bin/env python3
"""Report the highest GLIBC symbol version an ELF tree requires.

Usage:
  scripts/glibc-baseline.py <file-or-directory> [--max 2.35]

Prints one line: ``<version> <path>`` for the highest requirement found, or
``none`` when no ELF file references a versioned GLIBC symbol. With ``--max``
the script exits 1 when the requirement is newer than the given baseline.

Only ELF files are inspected; scripts, data and the embedded Python stdlib are
skipped. This is build-time evidence, not a runtime dependency resolver.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

_VERSION = re.compile(r"GLIBC_(\d+)\.(\d+)")


def _elf(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(4) == b"\x7fELF"
    except OSError:
        return False


def _requirement(path: Path) -> tuple[int, int] | None:
    try:
        result = subprocess.run(
            ["objdump", "-T", str(path)],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    found = _VERSION.findall(result.stdout)
    if not found:
        return None
    return max((int(major), int(minor)) for major, minor in found)


def _files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    return [
        path
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink()
    ]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    root = Path(argv[1])
    if not root.exists():
        print(f"glibc-baseline: no such path: {root}", file=sys.stderr)
        return 2
    baseline: tuple[int, int] | None = None
    if "--max" in argv:
        index = argv.index("--max")
        try:
            major, minor = argv[index + 1].split(".", 1)
            baseline = (int(major), int(minor))
        except (IndexError, ValueError):
            print("glibc-baseline: --max needs a version such as 2.35", file=sys.stderr)
            return 2

    worst: tuple[int, int] | None = None
    worst_path: Path | None = None
    for path in _files(root):
        if not _elf(path):
            continue
        requirement = _requirement(path)
        if requirement is None:
            continue
        if worst is None or requirement > worst:
            worst, worst_path = requirement, path

    if worst is None:
        print("none")
        return 0
    label = f"{worst[0]}.{worst[1]}"
    print(f"{label} {worst_path}")
    if baseline is not None and worst > baseline:
        print(
            f"glibc-baseline: {worst_path} requires GLIBC_{label}, "
            f"newer than the {baseline[0]}.{baseline[1]} target",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
