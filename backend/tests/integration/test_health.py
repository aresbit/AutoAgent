"""M1/M2: health must be side-effect free; token and origin gates."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from autoagent_backend.app import create_app
from autoagent_backend.config import BootConfig, config_from_env
from autoagent_backend.domain.errors import EngineUnavailable

TOKEN = "test-token"


def test_health_is_token_exempt_and_reports_shape(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["app"] == "autoagent"
    assert payload["apiVersion"] == "1"
    assert payload["version"]
    assert payload["bootId"]
    assert isinstance(payload["uptimeMs"], int)
    assert payload["db"] == "ok"
    assert payload["engine"] in {"idle", "starting", "busy", "error"}
    assert payload["state"] in {"ok", "initializing", "degraded"}


def test_health_does_not_touch_failing_adapters(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AUTOAGENT_ENGINE", "subprocess")

    def explode(*_args: object, **_kwargs: object) -> object:
        raise EngineUnavailable("no engine")

    monkeypatch.setattr(
        "autoagent_backend.composition.build_subprocess_engine", explode
    )
    blocked = tmp_path / "blocked"
    blocked.write_text("not a directory", encoding="utf-8")
    config = config_from_env(data_dir=blocked, port=8787)

    with TestClient(create_app(config)) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is True
        assert payload["db"] == "error"
        assert payload["engine"] == "error"
        assert payload["state"] == "degraded"


def test_business_routes_require_a_token(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    assert client.get("/api/sessions").status_code == 401
    assert (
        client.get(
            "/api/sessions", headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )
    assert client.get("/api/sessions", headers=auth_headers).status_code == 200


def test_origin_is_enforced(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    evil = client.post(
        "/api/sessions",
        headers={**auth_headers, "Origin": "http://evil.example"},
        json={"title": "x"},
    )
    assert evil.status_code == 403

    allowed = client.post(
        "/api/sessions",
        headers={**auth_headers, "Origin": "http://127.0.0.1:8787"},
        json={"title": "x"},
    )
    assert allowed.status_code == 200

    no_origin = client.post(
        "/api/sessions", headers=auth_headers, json={"title": "y"}
    )
    assert no_origin.status_code == 200


def test_bearer_exchange_sets_httponly_cookie(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post("/api/auth/session", headers=auth_headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "apiVersion": "1"}
    cookie = response.headers.get("set-cookie", "")
    assert "autoagent_token=" in cookie
    assert "HttpOnly" in cookie
    assert "SameSite=strict" in cookie

    # The client now has the cookie and no Authorization header.
    assert client.get("/api/sessions").status_code == 200


def test_validation_errors_are_wrapped(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post(
        "/api/sessions", headers=auth_headers, json={"unknown": True}
    )
    assert response.status_code == 422
    payload = response.json()
    assert payload["ok"] is False
    assert payload["code"] == "VALIDATION_ERROR"


def test_missing_token_configuration_rejects_business_routes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AUTOAGENT_API_TOKEN", raising=False)
    config: BootConfig = config_from_env(data_dir=tmp_path / "data", port=8788)
    with TestClient(create_app(config)) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/sessions").status_code == 401


def test_unknown_route_is_wrapped(client: TestClient) -> None:
    response = client.get("/api/nope", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code == 404
    assert response.json()["ok"] is False
    assert response.json()["code"] == "NOT_FOUND"
