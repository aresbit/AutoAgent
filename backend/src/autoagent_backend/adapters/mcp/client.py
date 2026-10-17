"""Minimal MCP client transports.

The backend deliberately does not depend on the official Python SDK.  Each
connection is one short-lived session: ``initialize``, ``tools/list`` and, when
needed, ``tools/call``.  The registry owns when to connect and always closes the
connection (including killing a stdio child) in a ``finally`` block.

Both transports speak JSON-RPC 2.0.  The stdio frame format is newline-delimited
JSON, which is what MCP requires.  HTTP/SSE servers receive a JSON-RPC POST; a
``text/event-stream`` response is parsed for the matching ``data:`` frame.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Protocol

from ...domain.errors import McpUnavailable
from ...domain.models import McpServerSpec, McpTool

_PROTOCOL_VERSION = "2024-11-05"
_CLIENT_INFO = {"name": "autoagent-backend", "version": "0.1.0"}
_DEFAULT_INIT_TIMEOUT = 10.0
_DEFAULT_CALL_TIMEOUT = 30.0
_MAX_ERROR_CHARS = 300


class McpConnection(Protocol):
    """One live MCP session; callers must call ``close``."""

    def initialize(self) -> None: ...

    def list_tools(self) -> tuple[McpTool, ...]: ...

    def call_tool(self, name: str, arguments: dict[str, object]) -> object: ...

    def close(self) -> None: ...


class McpConnectionFactory(Protocol):
    """Creates a session for a server spec (tests inject a fake)."""

    def __call__(self, spec: McpServerSpec) -> McpConnection: ...


def _sanitize(message: object) -> str:
    text = str(message).strip().replace("\n", " ")
    return text[:_MAX_ERROR_CHARS] or "MCP request failed"


class _JsonRpcError(McpUnavailable):
    pass


class _BaseJsonRpc:
    def __init__(self, timeout: float) -> None:
        self._timeout = timeout
        self._next_id = 1

    def _new_id(self) -> int:
        value = self._next_id
        self._next_id += 1
        return value

    def _exchange(self, payload: Mapping[str, object]) -> object:
        raise NotImplementedError

    def _request(self, method: str, params: Mapping[str, object]) -> dict[str, object]:
        request_id = self._new_id()
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params),
        }
        response = self._exchange(payload)
        if not isinstance(response, dict):
            raise _JsonRpcError("MCP server returned a malformed response")
        error = response.get("error")
        if isinstance(error, dict):
            raise _JsonRpcError(_sanitize(error.get("message", "MCP request failed")))
        if response.get("id") not in (request_id, None):
            raise _JsonRpcError("MCP response id did not match the request")
        return response

    def _notify(self, method: str, params: Mapping[str, object]) -> None:
        self._exchange(
            {"jsonrpc": "2.0", "method": method, "params": dict(params)}
        )

    def initialize(self) -> None:
        self._request(
            "initialize",
            {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": _CLIENT_INFO,
            },
        )
        self._notify("notifications/initialized", {})

    def list_tools(self) -> tuple[McpTool, ...]:
        response = self._request("tools/list", {})
        result = response.get("result")
        raw_tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(raw_tools, list):
            return ()
        tools: list[McpTool] = []
        for raw in raw_tools:
            if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
                continue
            schema = raw.get("inputSchema")
            tools.append(
                McpTool(
                    name=raw["name"],
                    description=str(raw.get("description") or ""),
                    input_schema=schema if isinstance(schema, dict) else None,
                )
            )
        return tuple(tools)

    def call_tool(self, name: str, arguments: dict[str, object]) -> object:
        response = self._request(
            "tools/call", {"name": name, "arguments": arguments}
        )
        return response.get("result")


class StdioMcpConnection(_BaseJsonRpc):
    """Newline-delimited JSON-RPC over a child process' stdin/stdout."""

    def __init__(
        self,
        spec: McpServerSpec,
        *,
        init_timeout: float = _DEFAULT_INIT_TIMEOUT,
        call_timeout: float = _DEFAULT_CALL_TIMEOUT,
    ) -> None:
        super().__init__(call_timeout)
        self._spec = spec
        self._init_timeout = init_timeout
        self._process: subprocess.Popen[str] | None = None
        self._messages: queue.Queue[dict[str, object] | None] = queue.Queue()
        self._reader: threading.Thread | None = None
        self._closed = False

    def _start(self) -> None:
        if self._process is not None:
            return
        command = (self._spec.command or "").strip()
        if not command:
            raise McpUnavailable("stdio MCP server has no command")
        environment = os.environ.copy()
        environment.update(self._spec.env)
        try:
            self._process = subprocess.Popen(
                [command, *self._spec.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                env=environment,
            )
        except OSError as exc:
            raise McpUnavailable("could not start MCP server") from exc
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()

    def _read_stdout(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            self._messages.put(None)
            return
        try:
            for line in process.stdout:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    decoded = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, dict):
                    self._messages.put(decoded)
        except (OSError, ValueError):
            pass
        finally:
            self._messages.put(None)

    def _exchange(self, payload: Mapping[str, object]) -> object:
        self._start()
        assert self._process is not None and self._process.stdin is not None
        if self._closed:
            raise McpUnavailable("MCP connection is closed")
        try:
            self._process.stdin.write(json.dumps(payload) + "\n")
            self._process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise McpUnavailable("MCP server closed the connection") from exc
        if "id" not in payload:
            return None
        timeout = self._init_timeout if payload.get("method") == "initialize" else self._timeout
        while True:
            try:
                message = self._messages.get(timeout=timeout)
            except queue.Empty as exc:
                raise McpUnavailable("MCP server timed out") from exc
            if message is None:
                raise McpUnavailable("MCP server exited")
            if message.get("id") == payload.get("id"):
                return message

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self._process
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=2.0)
                except subprocess.TimeoutExpired:  # pragma: no cover - defensive
                    pass
        if self._reader is not None:
            self._reader.join(timeout=2.0)
        self._process = None


class HttpMcpConnection(_BaseJsonRpc):
    """JSON-RPC over HTTP (streamable HTTP endpoint, including ``sse``)."""

    def __init__(
        self,
        spec: McpServerSpec,
        *,
        init_timeout: float = _DEFAULT_INIT_TIMEOUT,
        call_timeout: float = _DEFAULT_CALL_TIMEOUT,
    ) -> None:
        super().__init__(call_timeout)
        self._spec = spec
        self._init_timeout = init_timeout
        self._session_id: str | None = None

    def _exchange(self, payload: Mapping[str, object]) -> object:
        url = (self._spec.url or "").strip()
        if not url:
            raise McpUnavailable("MCP server has no URL")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            **self._spec.headers,
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        timeout = (
            self._init_timeout if payload.get("method") == "initialize" else self._timeout
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                session = response.headers.get("Mcp-Session-Id")
                if session:
                    self._session_id = session
                body = response.read()
                content_type = response.headers.get("Content-Type", "")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise McpUnavailable("MCP HTTP request failed") from exc
        if not body:
            return None
        text = body.decode("utf-8", errors="replace")
        if "text/event-stream" in content_type.lower():
            return self._parse_event_stream(text, payload.get("id"))
        try:
            decoded = json.loads(text)
        except json.JSONDecodeError as exc:
            raise McpUnavailable("MCP HTTP response was not JSON") from exc
        return decoded

    @staticmethod
    def _parse_event_stream(text: str, request_id: object) -> object:
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            try:
                decoded = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if isinstance(decoded, dict) and (
                request_id is None or decoded.get("id") == request_id
            ):
                return decoded
        return None

    def close(self) -> None:
        self._session_id = None


class DefaultMcpConnectionFactory:
    """Selects the transport declared by the spec."""

    def __init__(
        self,
        *,
        init_timeout: float = _DEFAULT_INIT_TIMEOUT,
        call_timeout: float = _DEFAULT_CALL_TIMEOUT,
    ) -> None:
        self._init_timeout = init_timeout
        self._call_timeout = call_timeout

    def __call__(self, spec: McpServerSpec) -> McpConnection:
        if spec.transport == "stdio":
            return StdioMcpConnection(
                spec,
                init_timeout=self._init_timeout,
                call_timeout=self._call_timeout,
            )
        return HttpMcpConnection(
            spec,
            init_timeout=self._init_timeout,
            call_timeout=self._call_timeout,
        )
