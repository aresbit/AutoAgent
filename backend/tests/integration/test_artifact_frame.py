"""M5.1: CSP-independent artifact frame endpoint and scoped tokens."""

from __future__ import annotations

import hashlib
import hmac
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from autoagent_backend.api.routes.artifact_frame import (
    FRAME_CSP,
    FRAME_TOKEN_TTL_S,
    RESIZE_REPORTER,
)

from ..fixtures.panels import AUTH, TOKEN, panel_client


def _create(
    client: TestClient, title: str = "Demo Art", html: str = "<h1>Hi</h1>"
) -> dict[str, object]:
    response = client.post(
        "/api/artifacts",
        headers=AUTH,
        json={"title": title, "description": "demo", "html": html},
    )
    assert response.status_code == 200, response.text
    payload: dict[str, object] = response.json()
    return payload


def _sign(artifact_id: str, version: str, exp: int, secret: str = TOKEN) -> str:
    message = f"{artifact_id}:{version}:{exp}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def _frame_url(artifact_id: str, version: str, exp: int, sig: str) -> str:
    return (
        f"/api/artifacts/{artifact_id}/frame"
        f"?version={version}&exp={exp}&sig={sig}"
    )


def _injected(document: str) -> str:
    return document.replace("</body>", RESIZE_REPORTER + "</body>", 1)


def test_frame_token_issues_scoped_url_and_serves_artifact(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, container, _):
        created = _create(client)
        artifact_id = str(created["id"])

        before = int(time.time())
        issued = client.post(
            f"/api/artifacts/{artifact_id}/frame-token", headers=AUTH, json={}
        )
        after = int(time.time())

        assert issued.status_code == 200, issued.text
        payload = issued.json()
        exp = payload["expiresAt"]
        assert isinstance(exp, int)
        assert before + FRAME_TOKEN_TTL_S <= exp <= after + FRAME_TOKEN_TTL_S

        parsed = urlsplit(payload["url"])
        assert parsed.path == f"/api/artifacts/{artifact_id}/frame"
        query = parse_qs(parsed.query)
        assert query["version"] == ["v1"]
        assert query["exp"] == [str(exp)]
        assert query["sig"] == [_sign(artifact_id, "v1", exp)]
        assert len(query["sig"][0]) == 64
        assert TOKEN not in payload["url"]

        # No bearer token, no cookie: the scoped signature is the only auth.
        response = client.get(payload["url"])
        assert response.status_code == 200, response.text
        assert response.headers["content-security-policy"] == FRAME_CSP
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["referrer-policy"] == "no-referrer"
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["content-type"].startswith("text/html")

        stored = container.artifact_service.version_content(artifact_id, "v1")
        assert response.text == _injected(stored)
        assert response.text.count(RESIZE_REPORTER) == 1
        assert TOKEN not in response.text


def test_frame_token_defaults_to_current_and_pins_version(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, container, _):
        first = _create(client, html="<h1>V1</h1>")
        artifact_id = str(first["id"])
        _create(client, html="<h1>V2</h1>")

        current = client.post(
            f"/api/artifacts/{artifact_id}/frame-token", headers=AUTH, json={}
        )
        assert current.status_code == 200, current.text
        current_query = parse_qs(urlsplit(current.json()["url"]).query)
        assert current_query["version"] == ["v2"]

        current_frame = client.get(current.json()["url"])
        assert current_frame.status_code == 200
        stored_current = container.artifact_service.version_content(
            artifact_id, "v2"
        )
        assert current_frame.text == _injected(stored_current)
        assert "V2" in current_frame.text

        pinned = client.post(
            f"/api/artifacts/{artifact_id}/frame-token",
            headers=AUTH,
            json={"version": "v1"},
        )
        assert pinned.status_code == 200, pinned.text
        pinned_query = parse_qs(urlsplit(pinned.json()["url"]).query)
        assert pinned_query["version"] == ["v1"]

        pinned_frame = client.get(pinned.json()["url"])
        assert pinned_frame.status_code == 200
        stored_pinned = container.artifact_service.version_content(
            artifact_id, "v1"
        )
        assert pinned_frame.text == _injected(stored_pinned)
        assert "V1" in pinned_frame.text
        assert "V2" not in pinned_frame.text


def test_expired_tampered_and_wrong_artifact_tokens_are_rejected(
    tmp_path: Path,
) -> None:
    with panel_client(tmp_path) as (client, _, _):
        first = _create(client)
        second = _create(client, title="Other Art")
        artifact_id = str(first["id"])
        other_id = str(second["id"])
        now = int(time.time())

        expired = _frame_url(
            artifact_id, "v1", now - 10, _sign(artifact_id, "v1", now - 10)
        )
        assert client.get(expired).status_code == 401

        valid_exp = now + 60
        signature = _sign(artifact_id, "v1", valid_exp)
        tampered = signature[:-1] + ("0" if signature[-1] != "0" else "1")
        assert (
            client.get(_frame_url(artifact_id, "v1", valid_exp, tampered)).status_code
            == 401
        )

        # A signature minted for another artifact must not authorize this one.
        wrong = _sign(other_id, "v1", valid_exp)
        assert (
            client.get(_frame_url(artifact_id, "v1", valid_exp, wrong)).status_code
            == 401
        )

        # A signature bound to a different version is likewise rejected.
        other_version = _sign(artifact_id, "v2", valid_exp)
        assert (
            client.get(
                _frame_url(artifact_id, "v1", valid_exp, other_version)
            ).status_code
            == 401
        )


def test_frame_path_is_token_exempt_but_frame_token_is_not(
    tmp_path: Path,
) -> None:
    with panel_client(tmp_path) as (client, _, _):
        created = _create(client)
        artifact_id = str(created["id"])

        # Issuing a token remains bearer-protected: the middleware rejects it.
        unauthenticated = client.post(
            f"/api/artifacts/{artifact_id}/frame-token", json={}
        )
        assert unauthenticated.status_code == 401
        assert unauthenticated.headers.get("www-authenticate") == "Bearer"

        issued = client.post(
            f"/api/artifacts/{artifact_id}/frame-token", headers=AUTH, json={}
        )
        assert issued.status_code == 200
        frame = client.get(issued.json()["url"])
        assert frame.status_code == 200

        # The frame path reaches the route without bearer auth (the route
        # rejects the bad signature itself), so no WWW-Authenticate header.
        rejected = client.get(
            _frame_url(artifact_id, "v1", int(time.time()) + 60, "0" * 64)
        )
        assert rejected.status_code == 401
        assert rejected.headers.get("www-authenticate") is None

        # Other artifact routes are still bearer-protected.
        assert client.get(f"/api/artifacts/{artifact_id}/content").status_code == 401


def test_frame_head_is_token_exempt_and_returns_headers(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, _, _):
        created = _create(client)
        artifact_id = str(created["id"])
        issued = client.post(
            f"/api/artifacts/{artifact_id}/frame-token", headers=AUTH, json={}
        )
        assert issued.status_code == 200

        response = client.head(issued.json()["url"])
        assert response.status_code == 200
        assert response.headers["content-security-policy"] == FRAME_CSP
        assert response.headers["cache-control"] == "no-store"


def test_frame_and_token_404_for_unknown_artifact_or_version(tmp_path: Path) -> None:
    with panel_client(tmp_path) as (client, _, _):
        created = _create(client)
        artifact_id = str(created["id"])
        exp = int(time.time()) + 60

        missing_artifact = client.post(
            "/api/artifacts/nope/frame-token", headers=AUTH, json={}
        )
        assert missing_artifact.status_code == 404
        assert missing_artifact.json()["code"] == "ARTIFACT_NOT_FOUND"

        missing_version = client.post(
            f"/api/artifacts/{artifact_id}/frame-token",
            headers=AUTH,
            json={"version": "v99"},
        )
        assert missing_version.status_code == 404

        signed_missing_artifact = _frame_url(
            "nope", "v1", exp, _sign("nope", "v1", exp)
        )
        assert client.get(signed_missing_artifact).status_code == 404

        signed_missing_version = _frame_url(
            artifact_id, "v99", exp, _sign(artifact_id, "v99", exp)
        )
        assert client.get(signed_missing_version).status_code == 404
