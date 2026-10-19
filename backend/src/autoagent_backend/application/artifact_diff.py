"""Pure unified diff between two immutable artifact versions.

The result is bounded so a pathological document cannot make the HTTP response
unbounded.  Truncation happens on UTF-8 byte boundaries; the flag lets the
client distinguish a complete patch from a truncated one.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass

MAX_PATCH_BYTES = 256 * 1024


@dataclass(frozen=True, slots=True)
class ArtifactDiff:
    from_version: str
    to_version: str
    patch: str
    truncated: bool = False


def build_artifact_diff(
    from_version: str,
    from_text: str,
    to_version: str,
    to_text: str,
    *,
    max_bytes: int = MAX_PATCH_BYTES,
) -> ArtifactDiff:
    """Return a unified diff, capped at ``max_bytes`` UTF-8 bytes.

    Post: identical versions (or identical content) produce an empty patch with
          ``truncated=False``.  Otherwise ``truncated`` is true exactly when
          the patch was cut to fit the cap.
    """

    if from_version == to_version:
        return ArtifactDiff(from_version, to_version, "")

    lines = difflib.unified_diff(
        from_text.splitlines(),
        to_text.splitlines(),
        fromfile=from_version,
        tofile=to_version,
        lineterm="",
    )
    patch = "\n".join(lines)
    encoded = patch.encode("utf-8")
    if len(encoded) <= max_bytes:
        return ArtifactDiff(from_version, to_version, patch)
    truncated = encoded[:max_bytes].decode("utf-8", errors="ignore")
    return ArtifactDiff(from_version, to_version, truncated, truncated=True)
