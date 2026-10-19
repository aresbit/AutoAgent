"""MCP server and tool-invocation endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query

from ...application.mcp_service import McpService
from ...domain.errors import InvalidInput
from ..deps import get_mcp_service
from ..schemas import (
    DeleteResponse,
    McpApprovalDecisionInput,
    McpDiscoverRequest,
    McpDiscoverView,
    McpLogListView,
    McpPromptGetRequest,
    McpPromptListView,
    McpPromptResultView,
    McpResourceListView,
    McpResourceReadRequest,
    McpResourceResultView,
    McpServerInput,
    McpServerListView,
    McpServerStatusView,
    McpServerView,
    McpStatusListView,
    McpToolView,
    ToolInvokeRequest,
    ToolInvokeView,
    to_domain_mcp_approval,
    to_domain_mcp_spec,
    to_mcp_discovery_view,
    to_mcp_log_view,
    to_mcp_prompt_view,
    to_mcp_resource_view,
    to_mcp_server_view,
    to_mcp_status_view,
    to_mcp_tool_view,
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
    refresh = body.refresh if body is not None else False
    return McpDiscoverView(
        results=[
            to_mcp_discovery_view(result)
            for result in service.discover(name, enabled_only, refresh=refresh)
        ]
    )


@router.post("/api/tools/invoke", response_model=ToolInvokeView)
def invoke_tool(
    body: ToolInvokeRequest,
    service: McpService = Depends(get_mcp_service),
) -> ToolInvokeView:
    return ToolInvokeView(
        result=service.invoke(
            body.server,
            body.tool,
            body.args,
            approval=to_domain_mcp_approval(body.approval),
        ).result
    )


@router.get("/api/mcp/status", response_model=McpStatusListView)
def mcp_status(
    service: McpService = Depends(get_mcp_service),
) -> McpStatusListView:
    return McpStatusListView(
        servers=[to_mcp_status_view(status) for status in service.status()]
    )


@router.get(
    "/api/mcp/servers/{name}/status", response_model=McpServerStatusView
)
def mcp_server_status(
    name: str,
    service: McpService = Depends(get_mcp_service),
) -> McpServerStatusView:
    return to_mcp_status_view(service.status(name)[0])


@router.post(
    "/api/mcp/servers/{name}/reconnect", response_model=McpServerStatusView
)
def reconnect_server(
    name: str,
    service: McpService = Depends(get_mcp_service),
) -> McpServerStatusView:
    return to_mcp_status_view(service.reconnect(name))


@router.get("/api/mcp/servers/{name}/logs", response_model=McpLogListView)
def mcp_logs(
    name: str,
    limit: int = Query(default=200, ge=1, le=1000),
    service: McpService = Depends(get_mcp_service),
) -> McpLogListView:
    return McpLogListView(
        entries=[to_mcp_log_view(entry) for entry in service.logs(name, limit)]
    )


@router.get(
    "/api/mcp/servers/{name}/tools", response_model=list[McpToolView]
)
def mcp_tools(
    name: str,
    refresh: bool = Query(default=False),
    service: McpService = Depends(get_mcp_service),
) -> list[McpToolView]:
    return [
        to_mcp_tool_view(tool) for tool in service.tools(name, refresh=refresh)
    ]


@router.get(
    "/api/mcp/servers/{name}/resources", response_model=McpResourceListView
)
def mcp_resources(
    name: str,
    refresh: bool = Query(default=False),
    service: McpService = Depends(get_mcp_service),
) -> McpResourceListView:
    return McpResourceListView(
        resources=[
            to_mcp_resource_view(resource)
            for resource in service.list_resources(name, refresh=refresh)
        ]
    )


@router.post(
    "/api/mcp/servers/{name}/resources/read",
    response_model=McpResourceResultView,
)
def mcp_read_resource(
    name: str,
    body: McpResourceReadRequest,
    service: McpService = Depends(get_mcp_service),
) -> McpResourceResultView:
    return McpResourceResultView(result=service.read_resource(name, body.uri))


@router.get(
    "/api/mcp/servers/{name}/prompts", response_model=McpPromptListView
)
def mcp_prompts(
    name: str,
    refresh: bool = Query(default=False),
    service: McpService = Depends(get_mcp_service),
) -> McpPromptListView:
    return McpPromptListView(
        prompts=[
            to_mcp_prompt_view(prompt)
            for prompt in service.list_prompts(name, refresh=refresh)
        ]
    )


@router.post(
    "/api/mcp/servers/{name}/prompts/get",
    response_model=McpPromptResultView,
)
def mcp_get_prompt(
    name: str,
    body: McpPromptGetRequest,
    service: McpService = Depends(get_mcp_service),
) -> McpPromptResultView:
    return McpPromptResultView(
        result=service.get_prompt(name, body.name, body.args)
    )


@router.post("/api/mcp/approvals")
def decide_mcp_approval(
    body: McpApprovalDecisionInput,
    service: McpService = Depends(get_mcp_service),
) -> dict[str, bool]:
    service.decide(body.server, body.tool, body.decision, body.scope)
    return {"ok": True}
