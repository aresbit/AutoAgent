"""M1: framework-free core, enforced independently of lint-imports."""

from __future__ import annotations

import ast
from pathlib import Path

FORBIDDEN = {
    "fastapi",
    "starlette",
    "pydantic",
    "sqlite3",
    "subprocess",
    "httpx",
    "requests",
}
PACKAGE = Path(__file__).resolve().parents[1] / "src" / "autoagent_backend"


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.add(node.module.split(".")[0])
    return found


def test_domain_and_application_are_framework_free() -> None:
    violations: list[str] = []
    for directory in ("domain", "application"):
        for path in sorted((PACKAGE / directory).rglob("*.py")):
            for module in _imports(path) & FORBIDDEN:
                violations.append(f"{path.relative_to(PACKAGE)} imports {module}")
    assert not violations, "\n".join(violations)


def test_application_does_not_import_adapters_or_api() -> None:
    violations: list[str] = []
    for path in sorted((PACKAGE / "application").rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        if "autoagent_backend.adapters" in source or "autoagent_backend.api" in source:
            violations.append(str(path.relative_to(PACKAGE)))
    assert not violations, "\n".join(violations)


def test_only_composition_constructs_concrete_adapters() -> None:
    constructors = (
        "SqliteSessionStore(",
        "SubprocessEngine(",
        "GitCliWorkspace(",
        "FilesystemSkillCatalog(",
        "SqliteMcpRegistry(",
        "FilesystemArtifactStore(",
    )
    offenders: list[str] = []
    adapter_modules = {
        "composition.py",
        "session_store.py",
        "subprocess_engine.py",
        "git_cli.py",
        "fs_catalog.py",
        "mcp_store.py",
        "fs_store.py",
    }
    for path in sorted((PACKAGE).rglob("*.py")):
        if path.name in adapter_modules:
            continue
        source = path.read_text(encoding="utf-8")
        for constructor in constructors:
            if constructor in source:
                offenders.append(f"{path.relative_to(PACKAGE)}: {constructor}")
    assert not offenders, "\n".join(offenders)
