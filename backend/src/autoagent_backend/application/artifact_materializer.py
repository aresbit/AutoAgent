"""Pure ``artifact-html`` materializer.

The assistant reply is untrusted text.  This module only parses, validates and
canonicalizes fenced ``artifact-html`` blocks; it never touches the filesystem
or any external service.  The returned ``MaterializedArtifact`` values are
immutable and contain the exact document (including the CSP and metadata tags)
that the store persists, so their ``sha256`` is the content hash of the stored
version.

A block may carry a tiny dependency-free frontmatter subset::

    ```artifact-html
    ---
    title: Quarterly report
    description: Interactive dashboard
    ---
    <div>...</div>
    ```

Limits are enforced per turn: at most ``max_artifacts`` blocks and at most
``max_bytes`` UTF-8 bytes per stored document.  Rejected blocks produce a
warning instead of failing the turn.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass

from ..domain.models import ArtifactDraft
from .artifact_capabilities import filter_tool_names

MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_ARTIFACTS_PER_TURN = 10

ENTRY = "index.html"
MIME_TYPE = "text/html;profile=mcp-app"
DISPLAY_MODES: tuple[str, ...] = ("inline", "fullscreen")
DEFAULT_CSP: dict[str, list[str]] = {
    "connectDomains": [],
    "resourceDomains": [],
    "frameDomains": [],
}
DEFAULT_PERMISSIONS: dict[str, bool] = {}

META_SCRIPT_ID = "autowork-artifact-meta"
CSP_META_ATTR = 'data-autoagent-csp="1"'
CSP_POLICY = (
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; "
    "script-src 'unsafe-inline'; font-src data:; connect-src 'none'; "
    "form-action 'none'; base-uri 'none'"
)

_FENCE = re.compile(
    r"^[ \t]*```artifact-html[ \t]*\r?\n(?P<body>.*?)^[ \t]*```[ \t]*$",
    re.MULTILINE | re.DOTALL | re.IGNORECASE,
)
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
_CSP_META = re.compile(
    r"\s*<meta\b(?=[^>]*\bdata-autoagent-csp=\"1\")[^>]*>\s*",
    re.IGNORECASE,
)
_HEAD_CLOSE = re.compile(r"</head\s*>", re.IGNORECASE)
_HTML_OPEN = re.compile(r"<html[\s>]", re.IGNORECASE)

# Resource-loading attributes only.  Ordinary navigation links (``<a href>``)
# are left alone; the CSP blocks navigation and resolves them as inert.
_EXTERNAL_RESOURCE = re.compile(
    r"<(?:script|link|img|iframe|source|video|audio|object|embed)\b"
    r"[^>]*\b(?:src|href|data)\s*=\s*['\"]\s*(?:https?:)?//",
    re.IGNORECASE,
)
_CSS_IMPORT = re.compile(r"@import\b", re.IGNORECASE)
_CSS_EXTERNAL_URL = re.compile(
    r"url\(\s*['\"]?\s*(?:https?:)?//", re.IGNORECASE
)


@dataclass(frozen=True, slots=True)
class MaterializationResult:
    artifacts: tuple[ArtifactDraft, ...] = ()
    warnings: tuple[str, ...] = ()


# Readable alias for callers that think in terms of the materializer.
MaterializedArtifact = ArtifactDraft


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def materialize_artifacts(
    text: str,
    *,
    max_artifacts: int = MAX_ARTIFACTS_PER_TURN,
    max_bytes: int = MAX_ARTIFACT_BYTES,
) -> MaterializationResult:
    """Parse ``artifact-html`` fences from ``text``.

    Post: every returned value is self-contained, within ``max_bytes`` and the
          tuple has at most ``max_artifacts`` items.  Rejected blocks are
          reported through ``warnings`` and never raise.
    """

    warnings: list[str] = []
    artifacts: list[ArtifactDraft] = []
    for match in _FENCE.finditer(text):
        if len(artifacts) >= max_artifacts:
            warnings.append(
                f"ignored extra artifact block(s): at most {max_artifacts} per turn"
            )
            break

        body = match.group("body")
        meta, fragment = _split_frontmatter(body)
        fragment = fragment.strip()
        if not fragment:
            warnings.append("ignored an empty artifact block")
            continue
        if not _is_self_contained(fragment):
            warnings.append("ignored an artifact that references external resources")
            continue

        raw_title = meta.get("title")
        raw_description = meta.get("description")
        title = (raw_title if isinstance(raw_title, str) else "Artifact").strip()[:200]
        title = title or "Artifact"
        description = (
            raw_description if isinstance(raw_description, str) else ""
        ).strip()[:2000]
        raw_tools = meta.get("mcpTools")
        tools, rejected = filter_tool_names(
            raw_tools if isinstance(raw_tools, (list, tuple)) else ()
        )
        if rejected:
            warnings.append(
                "ignored invalid mcpTools entr"
                f"{'y' if len(rejected) == 1 else 'ies'}: {', '.join(rejected)}"
            )
        document = build_artifact_document(title, fragment, description)
        size = len(document.encode("utf-8"))
        if size > max_bytes:
            warnings.append(
                f"ignored artifact {title!r}: {size} bytes exceeds {max_bytes}"
            )
            continue
        artifacts.append(
            MaterializedArtifact(
                html=document,
                title=title,
                description=description,
                sha256=sha256_text(document),
                size_bytes=size,
                mcp_tools=tools,
            )
        )
    return MaterializationResult(tuple(artifacts), tuple(warnings))


def build_artifact_document(title: str, body: str, description: str = "") -> str:
    """Return a self-contained HTML document with metadata and CSP tags."""

    cleaned = _strip_meta(_CSP_META.sub("", body, count=1))
    meta = {
        "name": title,
        "schemaVersion": 1,
        "description": description,
    }
    if _HTML_OPEN.search(cleaned):
        return _inject_tags(cleaned, meta)
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
    return _inject_tags(document, meta)


def extract_meta(html: str) -> dict[str, object]:
    match = _META_PAYLOAD.search(html)
    if match is None:
        return {}
    try:
        decoded = json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}
    return decoded if isinstance(decoded, dict) else {}


def strip_meta(html: str) -> str:
    return _strip_meta(html)


def _strip_meta(html: str) -> str:
    return _META_SCRIPT.sub("", html, count=1)


def _inject_tags(html: str, meta: dict[str, object]) -> str:
    payload = json.dumps(meta, ensure_ascii=False).replace("</", "<\\/")
    script = (
        f'<script id="{META_SCRIPT_ID}" type="application/json">'
        f"{payload}</script>"
    )
    csp = (
        f'<meta {CSP_META_ATTR} http-equiv="Content-Security-Policy" '
        f'content="{CSP_POLICY}">'
    )
    tags = f"{csp}{script}"
    if _HEAD_CLOSE.search(html):
        return _HEAD_CLOSE.sub(tags + "</head>", html, count=1)
    return tags + html


def _split_frontmatter(body: str) -> tuple[dict[str, object], str]:
    lines = body.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, body
    for index in range(1, len(lines)):
        if lines[index].strip() != "---":
            continue
        values: dict[str, object] = {}
        position = 1
        while position < index:
            line = lines[position]
            position += 1
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            key = key.strip().lower()
            value = value.strip()
            if key in {"title", "description"}:
                values[key] = _unquote(value)
            elif key in {"mcptools", "mcp_tools"}:
                if value:
                    tools = _parse_inline_tools(value)
                else:
                    tools = []
                    while position < index and lines[position].strip().startswith("-"):
                        tools.append(_unquote(lines[position].strip()[1:].strip()))
                        position += 1
                values["mcpTools"] = tuple(item for item in tools if item)
        return values, "\n".join(lines[index + 1 :])
    return {}, body


def _parse_inline_tools(value: str) -> list[str]:
    text = value.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [_unquote(item.strip()) for item in text.split(",") if item.strip()]


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _is_self_contained(fragment: str) -> bool:
    return not (
        _EXTERNAL_RESOURCE.search(fragment)
        or _CSS_IMPORT.search(fragment)
        or _CSS_EXTERNAL_URL.search(fragment)
    )


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
