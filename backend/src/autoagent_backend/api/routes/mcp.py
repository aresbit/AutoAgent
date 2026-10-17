"""MCP server and tool-invocation endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from ...application.mcp_service import McpService
from ...domain.errors import InvalidInput
from ..deps import get_mcp_service
from ..schemas import (
    DeleteResponse,
    McpDiscoverRequest,
    McpDiscoverView,
    McpServerInput,
    McpServerListView,
    McpServerView,
    ToolInvokeRequest,
    ToolInvokeView,
    to_domain_mcp_spec,
    to_mcp_discovery_view,
    to_mcp_server_view,
)

router = APIRouter()


@router.get("/api/mcp/servers", response_model=McpServerListView)
def list_servers(
    service: McpService = Depends(get_mcp_service),
) -> McpServerListView:
    return McpServerListView(
        servers=[to_mcp_server_view(server) for server in service.list()]
    )


@router.put("/api/mcp/servers/{name}", response_model=McpServerView)
def upsert_server(
    name: str,
    body: McpServerInput,
    service: McpService = Depends(get_mcp_service),
) -> McpServerView:
    if body.name.strip() != name.strip():
        raise InvalidInput("path name and body name must match")
    server = service.upsert(
        name,
        to_domain_mcp_spec(body),
        enabled=body.enabled,
        auto_run=body.autoRun,
    )
    return to_mcp_server_view(server)


@router.delete("/api/mcp/servers/{name}", response_model=DeleteResponse)
def delete_server(
    name: str,
    service: McpService = Depends(get_mcp_service),
) -> DeleteResponse:
    service.remove(name)
    return DeleteResponse(deleted=True)


@router.post("/api/mcp/servers/{name}/enable", response_model=McpServerView)
def enable_server(
    name: str,
    service: McpService = Depends(get_mcp_service),
) -> McpServerView:
    return to_mcp_server_view(service.enable(name))


@router.post("/api/mcp/servers/{name}/disable", response_model=McpServerView)
def disable_server(
    name: str,
    service: McpService = Depends(get_mcp_service),
) -> McpServerView:
    return to_mcp_server_view(service.disable(name))


@router.post("/api/mcp/discover", response_model=McpDiscoverView)
def discover_tools(
    body: McpDiscoverRequest | None = Body(default=None),
    service: McpService = Depends(get_mcp_service),
) -> McpDiscoverView:
    name = body.name if body is not None else None
    enabled_only = body.enabledOnly if body is not None else True
    return McpDiscoverView(
        results=[
            to_mcp_discovery_view(result)
            for result in service.discover(name, enabled_only)
        ]
    )


@router.post("/api/tools/invoke", response_model=ToolInvokeView)
def invoke_tool(
    body: ToolInvokeRequest,
    service: McpService = Depends(get_mcp_service),
) -> ToolInvokeView:
    return ToolInvokeView(
        result=service.invoke(body.server, body.tool, body.args).result
    )
