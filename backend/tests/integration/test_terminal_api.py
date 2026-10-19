"""Terminal REST + WebSocket integration tests."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _session(client: TestClient, auth_headers: dict[str, str]) -> str:
    response = client.post(
        "/api/sessions", headers=auth_headers, json={"title": "terminal"}
    )
    assert response.status_code in {200, 201}, response.text
    return str(response.json()["id"])


def _terminal(
    client: TestClient, auth_headers: dict[str, str], session_id: str
) -> dict[str, object]:
    response = client.post(
        f"/api/sessions/{session_id}/terminals",
        headers=auth_headers,
        json={"cols": 80, "rows": 24},
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()


def test_terminal_crud_and_guards(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    session_id = _session(client, auth_headers)
    created = _terminal(client, auth_headers, session_id)
    tab_id = str(created["tabId"])

    listed = client.get(
        f"/api/sessions/{session_id}/terminals", headers=auth_headers
    )
    assert listed.status_code == 200
    assert any(item["tabId"] == tab_id for item in listed.json()["terminals"])

    bad_shell = client.post(
        f"/api/sessions/{session_id}/terminals",
        headers=auth_headers,
        json={"shell": "/bin/true"},
    )
    assert bad_shell.status_code == 400
    assert bad_shell.json()["code"] == "INVALID_SHELL"

    bad_cwd = client.post(
        f"/api/sessions/{session_id}/terminals",
        headers=auth_headers,
        json={"cwd": "/etc"},
    )
    assert bad_cwd.status_code == 400
    assert bad_cwd.json()["code"] == "CWD_NOT_ALLOWED"

    deleted_tab = client.delete(
        f"/api/sessions/{session_id}/terminals/{tab_id}", headers=auth_headers
    )
    assert deleted_tab.status_code == 200
    assert deleted_tab.json()["deleted"] is True

    # Deleting the conversation also destroys any remaining terminals.
    _terminal(client, auth_headers, session_id)
    deleted_session = client.delete(
        f"/api/sessions/{session_id}", headers=auth_headers
    )
    assert deleted_session.status_code == 200


def test_terminal_websocket_roundtrip(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    session_id = _session(client, auth_headers)
    created = _terminal(client, auth_headers, session_id)
    tab_id = str(created["tabId"])
    token = auth_headers["Authorization"].removeprefix("Bearer ")

    with client.websocket_connect(
        f"/api/sessions/{session_id}/terminals/{tab_id}/ws?token={token}"
    ) as websocket:
        websocket.send_json({"type": "init", "cols": 80, "rows": 24, "replay": False})
        ready = websocket.receive_json()
        assert ready["type"] == "ready"
        assert ready["tabId"] == tab_id

        websocket.send_json({"type": "input", "data": "printf hello\n"})
        found = False
        for _ in range(80):
            frame = websocket.receive_json()
            if "hello" in str(frame.get("data") or ""):
                found = True
                break
            assert frame["type"] != "error", frame
        assert found

        websocket.send_json({"type": "input", "data": "exit\n"})
        for _ in range(80):
            frame = websocket.receive_json()
            if frame["type"] == "exit":
                assert frame["code"] == 0
                break

    client.delete(f"/api/sessions/{session_id}", headers=auth_headers)
