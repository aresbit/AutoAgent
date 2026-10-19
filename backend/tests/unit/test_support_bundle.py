"""Support bundle content and redaction."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from autoagent_backend.application.support_bundle import (
    SupportBundleInputs,
    SupportBundleService,
)
from autoagent_backend.domain.models import (
    McpServer,
    McpServerSpec,
    McpServerStatus,
    ModelResolution,
    Settings,
)


def _inputs(tmp_path: Path) -> SupportBundleInputs:
    backend_log = tmp_path / "backend.log"
    backend_log.write_text(
        "start ok\nAuthorization: Bearer super-secret-token\nANTHROPIC_API_KEY=sk-live-123\n",
        encoding="utf-8",
    )
    return SupportBundleInputs(
        app_name="autoagent",
        version="0.1.0",
        api_version="1",
        boot_id="boot-1234",
        generated_at_ms=1760000000000,
        lifecycle_state="ok",
        db_state="ok",
        engine_state="idle",
        engine_mode="matebot",
        engine_version="2.1.888",
        engine_last_error=None,
        settings=Settings(
            cwd="/home/user/work",
            model="desktop-model",
            engine_harness="claude-code",
            api_credential_source="autoagent",
            api_key="should-never-appear",
        ),
        model=ModelResolution(
            model="desktop-model",
            source="override",
            credential_source="autoagent",
            base_url_source="autoagent",
        ),
        counts=(3, 42, 7),
        mcp_servers=(
            McpServer(
                name="github",
                spec=McpServerSpec(transport="stdio", command="github-mcp"),
                enabled=True,
            ),
        ),
        mcp_statuses=(
            McpServerStatus(name="github", state="connected", tool_count=17),
        ),
        data_dir=tmp_path / "data",
        state_dir=tmp_path / "state",
        log_dir=tmp_path / "logs",
        db_path=tmp_path / "data" / "autoagent-v2.db",
        backend_log=backend_log,
        desktop_log=None,
        secrets=("super-secret-token",),
    )


def _read(payload: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return {name: archive.read(name).decode("utf-8") for name in archive.namelist()}


def test_bundle_contains_only_redacted_sections(tmp_path: Path) -> None:
    payload = SupportBundleService().build(_inputs(tmp_path))
    files = _read(payload)

    assert set(files) >= {
        "manifest.json",
        "health.json",
        "settings.json",
        "sessions.json",
        "mcp.json",
        "diagnostics.json",
        "logs/backend.log",
    }
    manifest = json.loads(files["manifest.json"])
    assert manifest["redacted"] is True
    assert "message bodies" in manifest["excludes"]

    settings = json.loads(files["settings.json"])
    assert settings["apiKeyConfigured"] is True
    assert "apiKey" not in settings
    assert "should-never-appear" not in files["settings.json"]

    counts = json.loads(files["sessions.json"])
    assert counts == {"sessions": 3, "messages": 42, "turns": 7}

    mcp = json.loads(files["mcp.json"])
    assert mcp["servers"][0]["name"] == "github"
    assert "command" not in mcp["servers"][0]

    combined = "\n".join(files.values())
    assert "super-secret-token" not in combined
    assert "sk-live-123" not in combined
    assert "[REDACTED]" in files["logs/backend.log"]


def test_bundle_has_no_desktop_log_when_absent(tmp_path: Path) -> None:
    files = _read(SupportBundleService().build(_inputs(tmp_path)))
    assert "logs/desktop.log" not in files
