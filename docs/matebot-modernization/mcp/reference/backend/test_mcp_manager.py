"""Reference tests for the persistent MCP connection manager.

The suite uses real loopback I/O and a real child process.  It intentionally
does not depend on FastAPI, Pydantic or the AutoAgent package so it can run
from this research directory:

    cd research/mcp-integration/backend && pytest -q test_mcp_manager.py

Covered: initialize, tool cache, call, reconnect, HTTP session ids, streamable
SSE responses, legacy SSE, timeout, cancellation, list_changed invalidation,
resources/prompts and destructive-tool approval.
"""

from __future__ import annotations

import json
import queue
import sys
import textwrap
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from approval import (  # noqa: E402
    ApprovalContext,
    ApprovalEngine,
    Rule,
    ServerApprovalPolicy,
)
from connection_manager import (  # noqa: E402
    McpApprovalDenied,
    McpApprovalRequired,
    McpConnectionManager,
    McpTimeout,
    McpUnavailable,
    ServerSpec,
)
from transports import McpCancelled  # noqa: E402

FAKE_STDIO = r"""
import json
import os
import sys
import threading
import time

STATE_DIR = os.environ.get("FAKE_STATE_DIR", ".")
write_lock = threading.Lock()
state = {"extra": False}

def send(payload):
    with write_lock:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()

def record(name):
    with open(os.path.join(STATE_DIR, name), "a", encoding="utf-8") as handle:
        handle.write(str(os.getpid()) + "\n")

def bump(name):
    path = os.path.join(STATE_DIR, name)
    try:
        with open(path, encoding="utf-8") as handle:
            value = int(handle.read().strip() or "0")
    except (OSError, ValueError):
        value = 0
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(str(value + 1))

TOOLS = [
    {"name": "echo", "description": "Echo input", "inputSchema": {"type": "object"},
     "annotations": {"readOnlyHint": True}},
    {"name": "read_thing", "description": "Read", "inputSchema": {"type": "object"},
     "annotations": {"readOnlyHint": True}},
    {"name": "write_file", "description": "Write", "inputSchema": {"type": "object"},
     "annotations": {"destructiveHint": True, "openWorldHint": False}},
    {"name": "notify", "description": "Notify", "inputSchema": {"type": "object"},
     "annotations": {"destructiveHint": False, "openWorldHint": False}},
    {"name": "slow", "description": "Slow", "inputSchema": {"type": "object"},
     "annotations": {"readOnlyHint": True}},
    {"name": "die", "description": "Die", "inputSchema": {"type": "object"},
     "annotations": {"readOnlyHint": True}},
    {"name": "stderr", "description": "Stderr", "inputSchema": {"type": "object"},
     "annotations": {"readOnlyHint": True}},
    {"name": "structured", "description": "Structured", "inputSchema": {"type": "object"},
     "outputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}},
]

def handle(message):
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if method == "initialize":
        result = {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {"listChanged": True}, "resources": {}, "prompts": {}},
            "serverInfo": {"name": "fake-stdio", "version": "1.2.3"},
            "instructions": "fake instructions",
        }
    elif method == "tools/list":
        tools = list(TOOLS)
        if state["extra"]:
            tools.append({"name": "extra", "description": "Added later",
                          "inputSchema": {"type": "object"},
                          "annotations": {"readOnlyHint": True}})
        result = {"tools": tools}
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "slow":
            time.sleep(float(args.get("seconds", 2.0)))
            result = {"content": [{"type": "text", "text": "slow done"}], "isError": False}
        elif name == "die":
            os._exit(7)
        elif name == "notify":
            state["extra"] = True
            send({"jsonrpc": "2.0", "method": "notifications/tools/list_changed", "params": {}})
            result = {"content": [{"type": "text", "text": "notified"}], "isError": False}
        elif name == "stderr":
            sys.stderr.write("hello from stderr\n")
            sys.stderr.flush()
            result = {"content": [{"type": "text", "text": "stderr done"}], "isError": False}
        elif name == "structured":
            result = {"content": [{"type": "text", "text": "{}"}],
                      "structuredContent": {"ok": True}, "isError": False}
        elif name == "write_file":
            result = {"content": [{"type": "text", "text": "written"}], "isError": False}
        else:
            result = {"content": [{"type": "text", "text": f"echo:{args}"}],
                      "isError": False}
    elif method == "resources/list":
        result = {"resources": [
            {"uri": "file:///note.txt", "name": "note", "mimeType": "text/plain"}
        ]}
    elif method == "resources/read":
        result = {"contents": [{"uri": params.get("uri"), "mimeType": "text/plain",
                                "text": "hello resource"}]}
    elif method == "prompts/list":
        result = {"prompts": [{"name": "summarize", "description": "Summarize",
                               "arguments": [{"name": "text", "required": True}]}]}
    elif method == "prompts/get":
        result = {"description": "Summarize", "messages": [
            {"role": "user", "content": {"type": "text", "text": "prompt:" + json.dumps(params)}}
        ]}
    elif method == "ping":
        result = {}
    else:
        send({"jsonrpc": "2.0", "id": request_id,
              "error": {"code": -32601, "message": "method not found"}})
        return
    send({"jsonrpc": "2.0", "id": request_id, "result": result})

def main():
    record("instances")
    fail_once = os.path.join(STATE_DIR, "fail_once")
    if os.path.exists(fail_once):
        os.remove(fail_once)
        os._exit(3)
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            message = json.loads(stripped)
        except ValueError:
            continue
        if "id" not in message:
            continue
        if message.get("method") == "tools/list":
            bump("tools_list_count")
        threading.Thread(target=handle, args=(message,), daemon=True).start()

main()
"""


class _FakeHttpState:
    def __init__(self) -> None:
        self.session_generation = 1
        self.expected_session = "session-abc"
        self.seen_headers: list[dict[str, str]] = []
        self.legacy_queue: queue.Queue[dict[str, object]] = queue.Queue()
        self.stop = threading.Event()


class FakeHttpHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: FakeHttpServer

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    # -- helpers -----------------------------------------------------------

    def _body(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _json(self, status: int, payload: dict[str, object]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _result(self, message: dict[str, object]) -> dict[str, object]:
        method = message.get("method")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        if method == "initialize":
            return {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": "fake-http", "version": "2.0"},
            }
        if method == "tools/list":
            return {
                "tools": [
                    {
                        "name": "echo",
                        "inputSchema": {"type": "object"},
                        "annotations": {"readOnlyHint": True},
                    },
                    {
                        "name": "streamed",
                        "inputSchema": {"type": "object"},
                        "annotations": {"readOnlyHint": True},
                    },
                ]
            }
        if method == "tools/call":
            name = params.get("name")
            return {"content": [{"type": "text", "text": f"http:{name}"}], "isError": False}
        if method == "ping":
            return {}
        return {}

    # -- routes ------------------------------------------------------------

    def do_POST(self) -> None:
        message = self._body()
        if self.path.startswith("/messages"):
            self._legacy_post(message)
            return
        if not self.path.startswith("/mcp"):
            self._json(404, {"error": {"message": "not found"}})
            return
        method = message.get("method")
        request_id = message.get("id")
        if "id" not in message:
            self._json(202, {})
            return
        if method == "initialize":
            self.server.state.session_generation += 0
            session = self.server.state.expected_session
            encoded = json.dumps(
                {"jsonrpc": "2.0", "id": request_id, "result": self._result(message)}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Mcp-Session-Id", session)
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        session = self.headers.get("Mcp-Session-Id")
        self.server.state.seen_headers.append(
            {
                "session": session or "",
                "protocol": self.headers.get("MCP-Protocol-Version", ""),
                "accept": self.headers.get("Accept", ""),
            }
        )
        if session != self.server.state.expected_session:
            self._json(404, {"error": {"message": "session expired"}})
            return
        if method == "tools/call" and isinstance(message.get("params"), dict):
            params = message["params"]
            if isinstance(params, dict) and params.get("name") == "streamed":
                frame_1 = (
                    "event: message\n"
                    'data: {"jsonrpc":"2.0","method":"notifications/message",'
                    '"params":{"level":"info","data":"stream notice"}}\n\n'
                )
                frame_2 = (
                    "event: message\n"
                    "data: "
                    + json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "result": self._result(message),
                        }
                    )
                    + "\n\n"
                )
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(frame_1.encode("utf-8"))
                self.wfile.flush()
                self.wfile.write(frame_2.encode("utf-8"))
                self.wfile.flush()
                self.close_connection = True
                return
        self._json(200, {"jsonrpc": "2.0", "id": request_id, "result": self._result(message)})

    def do_GET(self) -> None:
        if self.path.startswith("/sse"):
            self._legacy_stream()
            return
        self._json(405, {"error": {"message": "no notification stream"}})

    # -- legacy SSE --------------------------------------------------------

    def _legacy_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(b"event: endpoint\ndata: /messages?session=legacy-1\n\n")
        self.wfile.flush()
        queue = self.server.state.legacy_queue
        while not self.server.state.stop.is_set():
            try:
                item = queue.get(timeout=0.05)
            except Exception:
                continue
            self.wfile.write(("event: message\ndata: " + json.dumps(item) + "\n\n").encode("utf-8"))
            self.wfile.flush()
        self.close_connection = True

    def _legacy_post(self, message: dict[str, object]) -> None:
        if "id" in message:
            self.server.state.legacy_queue.put(
                {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": self._result(message),
                }
            )
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()


class FakeHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), FakeHttpHandler)
        self.state = _FakeHttpState()

    @property
    def url(self) -> str:
        host, port = self.server_address[:2]
        return f"http://{host}:{port}"


@pytest.fixture
def stdio_spec(tmp_path: Path) -> ServerSpec:
    script = tmp_path / "fake_stdio.py"
    script.write_text(textwrap.dedent(FAKE_STDIO), encoding="utf-8")
    return ServerSpec(
        name="stdio",
        command=sys.executable,
        args=(str(script),),
        env={"FAKE_STATE_DIR": str(tmp_path)},
        connect_timeout=3.0,
        call_timeout=2.0,
    )


@pytest.fixture
def permissive_engine() -> ApprovalEngine:
    return ApprovalEngine(
        default_policy=ServerApprovalPolicy(
            mode="auto", allow_destructive=True, allow_open_world=True
        )
    )


@pytest.fixture
def manager(
    stdio_spec: ServerSpec, permissive_engine: ApprovalEngine
) -> Iterator[McpConnectionManager]:
    events: list[dict[str, object]] = []
    statuses: list[object] = []
    instance = McpConnectionManager(
        [stdio_spec],
        approval_engine=permissive_engine,
        event_callback=events.append,
        status_callback=statuses.append,
        backoff_initial=0.01,
        backoff_max=0.05,
    )
    instance.events = events  # type: ignore[attr-defined]
    instance.status_snapshots = statuses  # type: ignore[attr-defined]
    try:
        yield instance
    finally:
        instance.shutdown()


@pytest.fixture
def http_server() -> Iterator[FakeHttpServer]:
    server = FakeHttpServer()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.state.stop.set()
        server.shutdown()
        server.server_close()


def _wait_for(predicate: Callable[[], bool], timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_stdio_initialize_list_call_and_cache(
    manager: McpConnectionManager, tmp_path: Path
) -> None:
    status = manager.connect("stdio")
    assert status.connected is True
    assert status.protocol_version == "2025-06-18"
    assert status.server_name == "fake-stdio"
    assert status.server_version == "1.2.3"
    assert status.pid is not None

    tools = manager.list_tools("stdio")
    names = {tool.name for tool in tools}
    assert {"echo", "write_file", "structured"} <= names
    assert manager.list_tools("stdio") == tools
    count_file = tmp_path / "tools_list_count"
    assert count_file.read_text(encoding="utf-8").strip() == "1"

    result = manager.call_tool("stdio", "echo", {"text": "hi"})
    assert result.is_error is False
    assert isinstance(result.content[0], dict)
    assert result.content[0]["text"].startswith("echo:")

    structured = manager.call_tool("stdio", "structured", {})
    assert structured.structured_content == {"ok": True}

    manager.list_tools("stdio", refresh=True)
    assert count_file.read_text(encoding="utf-8").strip() == "2"


def test_reconnect_after_server_exit(manager: McpConnectionManager, tmp_path: Path) -> None:
    manager.connect("stdio")
    with pytest.raises(McpUnavailable):
        manager.call_tool("stdio", "die", {})
    assert manager.status("stdio").state == "error"
    assert manager.status("stdio").last_error is not None

    manager.list_tools("stdio", refresh=True)
    status = manager.status("stdio")
    assert status.connected is True
    assert status.reconnect_attempts == 0
    instances = (tmp_path / "instances").read_text(encoding="utf-8").splitlines()
    assert len(instances) == 2


def test_reconnect_failure_then_backoff(
    stdio_spec: ServerSpec, tmp_path: Path, permissive_engine: ApprovalEngine
) -> None:
    (tmp_path / "fail_once").write_text("1", encoding="utf-8")
    manager = McpConnectionManager(
        [stdio_spec],
        approval_engine=permissive_engine,
        backoff_initial=0.5,
        backoff_max=1.0,
    )
    try:
        with pytest.raises(McpUnavailable):
            manager.list_tools("stdio")
        status = manager.status("stdio")
        assert status.state == "error"
        assert status.reconnect_attempts == 1
        assert status.next_retry_in_ms is not None
        assert manager.list_tools("stdio")[0].name
        assert manager.status("stdio").connected is True
    finally:
        manager.shutdown()


def test_health_check(manager: McpConnectionManager, permissive_engine: ApprovalEngine) -> None:
    manager.connect("stdio")
    assert manager.health_check("stdio") is True


def test_disabling_a_server_invalidates_cached_tools(
    manager: McpConnectionManager,
) -> None:
    manager.connect("stdio")
    assert manager.list_tools("stdio")
    manager.set_enabled("stdio", False)
    assert manager.status("stdio").state == "disabled"
    with pytest.raises(McpUnavailable):
        manager.list_tools("stdio")
    manager.set_enabled("stdio", True)
    assert manager.list_tools("stdio")


def test_timeout_does_not_kill_the_session(
    stdio_spec: ServerSpec, permissive_engine: ApprovalEngine
) -> None:
    spec = ServerSpec(
        name="stdio",
        command=stdio_spec.command,
        args=stdio_spec.args,
        env=stdio_spec.env,
        call_timeout=0.2,
        max_concurrency=4,
    )
    manager = McpConnectionManager([spec], approval_engine=permissive_engine)
    try:
        manager.connect("stdio")
        with pytest.raises(McpTimeout):
            manager.call_tool("stdio", "slow", {"seconds": 1.0})
        result = manager.call_tool("stdio", "echo", {"text": "after"})
        assert "after" in str(result.content[0])
        assert manager.status("stdio").connected is True
    finally:
        manager.shutdown()


def test_cancellation(
    manager: McpConnectionManager,
) -> None:
    manager.connect("stdio")
    cancel = threading.Event()
    captured: list[BaseException] = []

    def worker() -> None:
        try:
            manager.call_tool("stdio", "slow", {"seconds": 3.0}, cancel_event=cancel)
        except BaseException as exc:
            captured.append(exc)

    thread = threading.Thread(target=worker)
    thread.start()
    time.sleep(0.15)
    cancel.set()
    thread.join(timeout=2.0)
    assert captured and isinstance(captured[0], McpCancelled)
    result = manager.call_tool("stdio", "echo", {"text": "after-cancel"})
    assert "after-cancel" in str(result.content[0])
    assert manager.status("stdio").connected is True


def test_tools_list_changed_invalidates_cache(
    manager: McpConnectionManager,
) -> None:
    manager.connect("stdio")
    before = {tool.name for tool in manager.list_tools("stdio")}
    assert "extra" not in before

    manager.call_tool("stdio", "notify", {})

    def has_extra() -> bool:
        return "extra" in {tool.name for tool in manager.list_tools("stdio")}

    assert _wait_for(has_extra)
    event_types = [event.get("type") for event in manager.events]  # type: ignore[attr-defined]
    assert "mcp.tools_changed" in event_types


def test_resources_and_prompts(manager: McpConnectionManager) -> None:
    resources = manager.list_resources("stdio")
    assert resources[0].uri == "file:///note.txt"
    read = manager.read_resource("stdio", "file:///note.txt")
    contents = read["contents"]
    assert isinstance(contents, list)
    assert contents[0]["text"] == "hello resource"

    prompts = manager.list_prompts("stdio")
    assert prompts[0].name == "summarize"
    assert prompts[0].arguments[0].required is True
    prompt = manager.get_prompt("stdio", "summarize", {"text": "x"})
    assert isinstance(prompt["messages"], list)


def test_destructive_tool_requires_consent(
    stdio_spec: ServerSpec, permissive_engine: ApprovalEngine
) -> None:
    engine = ApprovalEngine(
        default_policy=ServerApprovalPolicy(
            mode="ask", allow_read_only=True, allow_destructive=False
        )
    )
    manager = McpConnectionManager([stdio_spec], approval_engine=engine)
    try:
        read = manager.call_tool("stdio", "read_thing", {})
        assert read.is_error is False

        with pytest.raises(McpApprovalRequired) as required:
            manager.call_tool("stdio", "write_file", {})
        assert required.value.decision.risk == "destructive"
        assert required.value.decision.code == "consent_required"

        result = manager.call_tool(
            "stdio",
            "write_file",
            {},
            approval=ApprovalContext(approved_tools=frozenset({"write_file"})),
        )
        assert result.is_error is False

        denied = ApprovalEngine(
            default_policy=ServerApprovalPolicy(mode="auto"),
            deny_rules=(Rule(server="*", tool="write_*", reason="no writes"),),
        )
        manager.approval = denied
        with pytest.raises(McpApprovalDenied) as denied_error:
            manager.call_tool("stdio", "write_file", {})
        assert denied_error.value.decision.code == "denied_by_rule"
    finally:
        manager.shutdown()


def test_http_streamable_session_and_sse_response(
    http_server: FakeHttpServer, permissive_engine: ApprovalEngine
) -> None:
    spec = ServerSpec(
        name="http",
        transport="http",
        url=f"{http_server.url}/mcp",
        notification_stream=False,
        call_timeout=3.0,
        connect_timeout=3.0,
    )
    manager = McpConnectionManager([spec], approval_engine=permissive_engine)
    try:
        status = manager.connect("http")
        assert status.session_id == "session-abc"
        assert status.server_name == "fake-http"

        tools = {tool.name for tool in manager.list_tools("http")}
        assert tools == {"echo", "streamed"}

        result = manager.call_tool("http", "echo", {"x": 1})
        assert "http:echo" in str(result.content[0])

        streamed = manager.call_tool("http", "streamed", {})
        assert "http:streamed" in str(streamed.content[0])

        seen = http_server.state.seen_headers
        assert seen
        assert all(item["protocol"] == "2025-06-18" for item in seen)
        assert all("text/event-stream" in item["accept"] for item in seen)
        assert all(item["session"] == "session-abc" for item in seen)
    finally:
        manager.shutdown()


def test_http_session_expiry_reconnects(
    http_server: FakeHttpServer, permissive_engine: ApprovalEngine
) -> None:
    spec = ServerSpec(
        name="http",
        transport="http",
        url=f"{http_server.url}/mcp",
        notification_stream=False,
        call_timeout=3.0,
        connect_timeout=3.0,
    )
    manager = McpConnectionManager([spec], approval_engine=permissive_engine)
    try:
        manager.connect("http")
        http_server.state.expected_session = "session-new"
        tools = manager.list_tools("http", refresh=True)
        assert {tool.name for tool in tools} == {"echo", "streamed"}
        assert manager.status("http").session_id == "session-new"
    finally:
        manager.shutdown()


def test_legacy_sse_transport(
    http_server: FakeHttpServer, permissive_engine: ApprovalEngine
) -> None:
    spec = ServerSpec(
        name="legacy",
        transport="sse",
        url=f"{http_server.url}/sse",
        connect_timeout=3.0,
        call_timeout=3.0,
    )
    manager = McpConnectionManager([spec], approval_engine=permissive_engine)
    try:
        status = manager.connect("legacy")
        assert status.connected is True
        assert status.session_id == "legacy-1"
        assert {tool.name for tool in manager.list_tools("legacy")} == {"echo", "streamed"}
        result = manager.call_tool("legacy", "echo", {})
        assert "http:echo" in str(result.content[0])
    finally:
        manager.shutdown()


def test_status_events_and_logs(manager: McpConnectionManager) -> None:
    manager.connect("stdio")
    manager.call_tool("stdio", "stderr", {})
    assert _wait_for(lambda: any(entry.level == "stderr" for entry in manager.logs("stdio")))
    events = manager.events  # type: ignore[attr-defined]
    status_events = [event for event in events if event.get("type") == "mcp.status"]
    assert status_events
    states = [
        event["status"]["state"] for event in status_events if isinstance(event.get("status"), dict)
    ]
    assert "connected" in states
    log_events = [event for event in events if event.get("type") == "mcp.log"]
    assert log_events
