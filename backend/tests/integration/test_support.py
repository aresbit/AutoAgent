"""GET /api/support/bundle returns a redacted zip."""

from __future__ import annotations

import io
import json
import zipfile

from fastapi.testclient import TestClient


def test_support_bundle_is_authenticated_and_redacted(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    unauthorised = client.get("/api/support/bundle")
    assert unauthorised.status_code == 401

    response = client.get("/api/support/bundle", headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert "attachment; filename=" in response.headers["content-disposition"]
    assert response.content

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        assert {"manifest.json", "health.json", "settings.json"} <= names
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["redacted"] is True
        text = "\n".join(
            archive.read(name).decode("utf-8", errors="replace")
            for name in names
            if name.endswith((".json", ".log"))
        )
    # The launch token is registered as a secret and never appears.
    token = auth_headers["Authorization"].removeprefix("Bearer ")
    assert token not in text
