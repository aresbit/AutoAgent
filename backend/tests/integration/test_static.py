"""Static SPA serving: index, hashed assets, fallback and traversal safety."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.api.static import (
    ASSET_CACHE,
    CONTENT_SECURITY_POLICY,
    INDEX_CACHE,
    UNAVAILABLE_MESSAGE,
    content_type_for,
    resolve_asset,
)
from autoagent_backend.app import create_app
from autoagent_backend.config import config_from_env

TOKEN = "test-token"
FRONTEND_DIST = Path(__file__).resolve().parents[3] / "frontend" / "dist"

pytestmark = pytest.mark.skipif(
    not (FRONTEND_DIST / "index.html").is_file(),
    reason="frontend/dist has not been built",
)


def test_index_is_served_without_a_token(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert 'id="root"' in response.text
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == INDEX_CACHE

    # The token is a client-side query/fragment concern; it must not gate the SPA.
    assert client.get("/?token=abc").status_code == 200


def test_index_and_fallback_set_content_security_policy(
    client: TestClient,
) -> None:
    index = client.get("/")
    policy = index.headers.get("content-security-policy")
    assert policy is not None
    assert "default-src 'self'" in policy
    assert policy == CONTENT_SECURITY_POLICY
    assert index.headers["cache-control"] == INDEX_CACHE

    fallback = client.get("/deep/client/route")
    assert fallback.status_code == 200
    assert fallback.headers.get("content-security-policy") == CONTENT_SECURITY_POLICY
    assert fallback.headers["cache-control"] == INDEX_CACHE


def test_hashed_assets_are_immutable_and_typed(client: TestClient) -> None:
    assets = sorted((FRONTEND_DIST / "assets").iterdir())
    assert assets, "the build must contain at least one asset"
    asset = next(
        (item for item in assets if item.suffix in {".js", ".css"}),
        assets[0],
    )

    response = client.get(f"/assets/{asset.name}")
    assert response.status_code == 200
    assert response.content == asset.read_bytes()
    assert response.headers["cache-control"] == ASSET_CACHE
    content_type = response.headers["content-type"]
    if asset.suffix == ".js":
        assert content_type.startswith("text/javascript")
    elif asset.suffix == ".css":
        assert content_type.startswith("text/css")
    assert content_type_for(asset) == response.headers["content-type"]


def test_head_requests_are_supported(client: TestClient) -> None:
    index = client.head("/")
    assert index.status_code == 200
    assert index.content == b""
    assert index.headers["content-type"].startswith("text/html")
    assert index.headers["cache-control"] == INDEX_CACHE

    fallback = client.head("/deep/link")
    assert fallback.status_code == 200
    assert fallback.content == b""
    assert fallback.headers["cache-control"] == INDEX_CACHE

    assets = sorted((FRONTEND_DIST / "assets").iterdir())
    asset = next((item for item in assets if item.suffix == ".js"), assets[0])
    head_asset = client.head(f"/assets/{asset.name}")
    assert head_asset.status_code == 200
    assert head_asset.content == b""
    assert head_asset.headers["cache-control"] == ASSET_CACHE
    assert "content-type" in head_asset.headers


def test_unknown_spa_routes_return_index(client: TestClient) -> None:
    response = client.get("/chat/some/deep/link")
    assert response.status_code == 200
    assert 'id="root"' in response.text
    assert response.headers["cache-control"] == INDEX_CACHE


def test_api_precedence_is_preserved(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    unauthorized = client.get("/api/bootstrap")
    assert unauthorized.status_code == 401
    assert unauthorized.json()["code"] == "UNAUTHORIZED"

    unknown = client.get("/api/does-not-exist", headers=auth_headers)
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "NOT_FOUND"
    assert not unknown.headers["content-type"].startswith("text/html")


def test_asset_traversal_is_rejected(client: TestClient) -> None:
    encoded = client.get("/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd")
    assert encoded.status_code == 404
    assert encoded.json()["code"] == "NOT_FOUND"

    root = FRONTEND_DIST / "assets"
    assert resolve_asset(FRONTEND_DIST, "../index.html") is None
    assert resolve_asset(FRONTEND_DIST, "../../etc/passwd") is None
    assert resolve_asset(FRONTEND_DIST, str(root / ".." / "index.html")) is None


def test_missing_dist_returns_clear_503(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = tmp_path / "missing-dist"
    monkeypatch.setenv("AUTOAGENT_FRONTEND_DIST", str(missing))
    config = config_from_env(data_dir=tmp_path / "data", port=8787)
    assert config.frontend_dist == missing.resolve()

    with TestClient(create_app(config)) as client:
        index = client.get("/")
        assert index.status_code == 503
        assert index.json()["code"] == "STATIC_UNAVAILABLE"
        assert index.json()["error"] == UNAVAILABLE_MESSAGE

        asset = client.get("/assets/app.js")
        assert asset.status_code == 503
        assert asset.json()["code"] == "STATIC_UNAVAILABLE"


def test_dist_existing_without_index_returns_503(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty = tmp_path / "empty-dist"
    empty.mkdir()
    monkeypatch.setenv("AUTOAGENT_FRONTEND_DIST", str(empty))
    config = config_from_env(data_dir=tmp_path / "data", port=8787)

    with TestClient(create_app(config)) as client:
        response = client.get("/")
        assert response.status_code == 503
        assert response.json()["code"] == "STATIC_UNAVAILABLE"
