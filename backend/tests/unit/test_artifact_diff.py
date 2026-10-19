"""Unit tests for the pure artifact version differ."""

from __future__ import annotations

from autoagent_backend.application.artifact_diff import (
    MAX_PATCH_BYTES,
    build_artifact_diff,
)


def test_same_version_returns_empty_patch() -> None:
    diff = build_artifact_diff("v1", "same", "v1", "different")
    assert diff.patch == ""
    assert diff.truncated is False


def test_changed_content_returns_unified_patch() -> None:
    diff = build_artifact_diff(
        "v1", "<h1>one</h1>\n<p>x</p>", "v2", "<h1>two</h1>\n<p>x</p>"
    )
    assert diff.from_version == "v1"
    assert diff.to_version == "v2"
    assert diff.truncated is False
    assert "--- v1" in diff.patch
    assert "+++ v2" in diff.patch
    assert "-<h1>one</h1>" in diff.patch
    assert "+<h1>two</h1>" in diff.patch


def test_identical_content_across_versions_is_empty() -> None:
    diff = build_artifact_diff("v1", "same", "v2", "same")
    assert diff.patch == ""
    assert diff.truncated is False


def test_patch_is_capped_at_the_byte_limit() -> None:
    diff = build_artifact_diff(
        "v1",
        "<p>old</p>\n",
        "v2",
        "<p>new</p>\n" * 20_000,
        max_bytes=1024,
    )
    assert diff.truncated is True
    assert len(diff.patch.encode("utf-8")) <= 1024


def test_default_cap_is_256_kib() -> None:
    assert MAX_PATCH_BYTES == 256 * 1024
