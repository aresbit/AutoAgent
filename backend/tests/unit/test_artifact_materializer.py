"""Unit tests for the pure ``artifact-html`` materializer."""

from __future__ import annotations

from autoagent_backend.application.artifact_materializer import (
    MAX_ARTIFACTS_PER_TURN,
    build_artifact_document,
    materialize_artifacts,
    sha256_text,
    strip_meta,
)


def _fence(body: str) -> str:
    return f"```artifact-html\n{body}\n```\n"


def test_frontmatter_title_and_description() -> None:
    result = materialize_artifacts(
        _fence('---\ntitle: "Report"\ndescription: "Demo"\n---\n<h1>Hi</h1>')
    )
    assert result.warnings == ()
    artifact = result.artifacts[0]
    assert artifact.title == "Report"
    assert artifact.description == "Demo"
    assert "<h1>Hi</h1>" in artifact.html
    assert artifact.sha256 == sha256_text(artifact.html)
    assert artifact.size_bytes == len(artifact.html.encode("utf-8"))


def test_document_carries_csp_and_metadata() -> None:
    result = materialize_artifacts(_fence("<p>body</p>"))
    html = result.artifacts[0].html
    assert html.startswith("<!doctype html>")
    assert 'data-autoagent-csp="1"' in html
    assert 'id="autowork-artifact-meta"' in html
    assert '"schemaVersion": 1' in html


def test_existing_document_gets_exactly_one_injected_tag_pair() -> None:
    document = build_artifact_document(
        "T", "<html><head></head><body>x</body></html>", "d"
    )
    rebuilt = build_artifact_document("T", document, "d")
    assert rebuilt.count('data-autoagent-csp="1"') == 1
    assert rebuilt.count('id="autowork-artifact-meta"') == 1


def test_meta_is_stripped_by_helper() -> None:
    document = build_artifact_document("T", "<p>x</p>", "")
    assert "autowork-artifact-meta" in document
    assert "autowork-artifact-meta" not in strip_meta(document)


def test_multiple_blocks_and_extra_block_limit() -> None:
    body = "".join(_fence(f"<p>{index}</p>") for index in range(3))
    result = materialize_artifacts(body)
    assert len(result.artifacts) == 3
    assert result.warnings == ()

    limited = materialize_artifacts(
        "".join(_fence(f"<p>{index}</p>") for index in range(5)),
        max_artifacts=2,
    )
    assert len(limited.artifacts) == 2
    assert "at most 2 per turn" in limited.warnings[0]


def test_rejects_empty_oversized_and_external_resources() -> None:
    empty = materialize_artifacts(_fence("   "))
    assert empty.artifacts == ()
    assert "empty" in empty.warnings[0]

    oversized = materialize_artifacts(_fence("<p>" + "x" * 500 + "</p>"), max_bytes=100)
    assert oversized.artifacts == ()
    assert "exceeds 100" in oversized.warnings[0]

    external = materialize_artifacts(
        _fence('<img src="https://cdn.example/x.png">')
    )
    assert external.artifacts == ()
    assert "external resources" in external.warnings[0]

    css = materialize_artifacts(_fence("<style>@import 'x.css';</style>"))
    assert css.artifacts == ()
    assert "external resources" in css.warnings[0]


def test_ignores_other_fences_and_unclosed_blocks() -> None:
    text = "```html\n<h1>not an artifact</h1>\n```\n```artifact-html\n<p>open"
    result = materialize_artifacts(text)
    assert result.artifacts == ()
    assert result.warnings == ()


def test_default_limits_are_exposed() -> None:
    assert MAX_ARTIFACTS_PER_TURN >= 1
