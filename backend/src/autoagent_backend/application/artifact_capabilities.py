"""Artifact capability validation helpers.

MCP tool allowlists are intentionally narrow: a tool name is a stable,
transport-agnostic identifier.  The helpers here are pure so both the HTTP
boundary and the artifact materializer share one rule set.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from ..domain.errors import InvalidInput

MAX_TOOL_NAME_CHARS = 200
MAX_TOOLS = 256

# Tool names are used only as allowlist keys.  Reject whitespace, control
# characters and path separators so a name can never be mistaken for a path or
# split across a transport boundary.
_TOOL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$")


def normalize_tool_names(values: Iterable[object]) -> tuple[str, ...]:
    """Return a validated, order-preserving, deduplicated tool allowlist.

    Raises: ``InvalidInput`` for a non-string, empty, over-long or malformed
            name, or for more than ``MAX_TOOLS`` entries.
    """

    names: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            raise InvalidInput("MCP tool names must be strings")
        name = raw.strip()
        if _TOOL_NAME.fullmatch(name) is None:
            raise InvalidInput(f"invalid MCP tool name: {name!r}")
        if name not in seen:
            seen.add(name)
            names.append(name)
    if len(names) > MAX_TOOLS:
        raise InvalidInput(f"at most {MAX_TOOLS} MCP tools are allowed")
    return tuple(names)


def filter_tool_names(
    values: Iterable[object],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Lenient variant for untrusted content (artifact frontmatter).

    Returns ``(accepted, rejected)``.  Invalid entries are dropped rather than
    failing the whole artifact block; callers surface them as warnings.
    """

    accepted: list[str] = []
    rejected: list[str] = []
    seen: set[str] = set()
    for raw in values:
        if not isinstance(raw, str):
            rejected.append(str(raw))
            continue
        name = raw.strip()
        if _TOOL_NAME.fullmatch(name) is None:
            rejected.append(name)
        elif name not in seen:
            seen.add(name)
            accepted.append(name)
        if len(accepted) >= MAX_TOOLS:
            break
    return tuple(accepted), tuple(rejected)
