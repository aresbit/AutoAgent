import { ApiError } from "./errors";
import { normalizeArtifactVersions } from "./artifacts";
import { mockApi } from "./mock";
import { SSEParser } from "./sse";
import type {
  ApiErrorShape,
  ArtifactCreateInput,
  ArtifactExportResponse,
  ArtifactVersionView,
  ArtifactView,
  BootstrapView,
  FrameTokenView,
  EngineConfigPatch,
  EngineConfigView,
  EngineStatusView,
  FileDiffView,
  McpDiscoverResponse,
  McpServerInput,
  McpServerView,
  McpToolInvokeRequest,
  McpToolInvokeResult,
  ProviderCatalogView,
  SessionSummary,
  SessionView,
  SettingsPatch,
  SettingsView,
  SkillCatalogView,
  SkillDiscoverResponse,
  SkillView,
  TurnRequest,
  TurnStatusView,
  TurnStreamEvent,
  WorkspaceStatusView,
} from "./types";

export type * from "./types";
export { ApiError } from "./errors";

export interface ServerEvent {
  name: string;
  data: Record<string, unknown>;
}

const base = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";
const useMock =
  import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_MOCK === "true";

let launchToken: string | null = null;

export function initLaunchToken(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  launchToken = token;
  url.searchParams.delete("token");
  const query = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
}

export function hasLaunchToken(): boolean {
  return launchToken !== null || useMock;
}

function headersFor(init?: HeadersInit, body?: BodyInit | null): Headers {
  const headers = new Headers(init);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (launchToken) headers.set("authorization", `Bearer ${launchToken}`);
  return headers;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const nested = (record.error ?? record) as Record<string, unknown>;
  let message = "";
  if (typeof nested.message === "string") message = nested.message;
  else if (typeof nested.detail === "string") message = nested.detail;
  else if (Array.isArray(nested.detail)) message = "The request could not be validated.";
  if (!message) message = response.statusText || "The request failed.";
  const code =
    typeof nested.code === "string" ? nested.code : `HTTP_${response.status}`;
  const retryable =
    typeof nested.retryable === "boolean"
      ? nested.retryable
      : response.status === 429 || response.status >= 500;
  const shape: ApiErrorShape = { status: response.status, code, message, retryable };
  return new ApiError(shape);
}

function networkError(error: unknown): ApiError {
  return new ApiError({
    status: 0,
    code: "NETWORK_ERROR",
    message:
      error instanceof Error && error.message
        ? error.message
        : "The local service could not be reached.",
    retryable: true,
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: headersFor(init.headers, init.body),
      credentials: "include",
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await errorFromResponse(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: headersFor({ accept: "text/html" }, init.body),
      credentials: "include",
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await errorFromResponse(response);
  return await response.text();
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function streamTurnRequest(
  turnId: string,
  body: TurnRequest,
  onEvent: (event: TurnStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/turns/${encodeURIComponent(turnId)}/stream`, {
      method: "POST",
      headers: headersFor({ accept: "text/event-stream" }, JSON.stringify(body)),
      body: JSON.stringify(body),
      credentials: "include",
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError(error);
  }
  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) {
    throw new ApiError({
      status: 0,
      code: "STREAM_UNAVAILABLE",
      message: "The stream could not be opened.",
      retryable: true,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const dispatch = (frames: ReturnType<SSEParser["push"]>) => {
    for (const frame of frames) {
      if (frame.event === "heartbeat") continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      onEvent({ type: frame.event, ...data } as TurnStreamEvent);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      dispatch(parser.push(decoder.decode(value, { stream: true })));
    }
    dispatch(parser.flush());
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError(error);
  } finally {
    reader.releaseLock();
  }
}

async function streamEventsRequest(
  onEvent: (event: ServerEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/events`, {
      method: "GET",
      headers: headersFor({ accept: "text/event-stream" }),
      credentials: "include",
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError(error);
  }
  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) {
    throw new ApiError({
      status: 0,
      code: "STREAM_UNAVAILABLE",
      message: "The event stream could not be opened.",
      retryable: true,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  const dispatch = (frames: ReturnType<SSEParser["push"]>) => {
    for (const frame of frames) {
      if (frame.event === "heartbeat" || frame.event === "message") continue;
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(frame.data);
        if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      onEvent({ name: frame.event, data });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      dispatch(parser.push(decoder.decode(value, { stream: true })));
    }
    dispatch(parser.flush());
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError(error);
  } finally {
    reader.releaseLock();
  }
}

function idleUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const api = {
  bootstrap(): Promise<BootstrapView> {
    return useMock ? mockApi.bootstrap() : request<BootstrapView>("/api/bootstrap");
  },

  listSessions(limit = 50): Promise<SessionSummary[]> {
    return useMock
      ? mockApi.sessions()
      : request<{ sessions: SessionSummary[] }>(`/api/sessions?limit=${limit}`).then(
          (result) => result.sessions,
        );
  },

  getSession(id: string): Promise<SessionView> {
    return useMock
      ? mockApi.session(id)
      : request<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);
  },

  createSession(title?: string): Promise<SessionView> {
    return useMock
      ? mockApi.createSession(title)
      : request<SessionView>("/api/sessions", {
          method: "POST",
          body: JSON.stringify(title === undefined ? {} : { title }),
        });
  },

  renameSession(id: string, title: string): Promise<SessionView> {
    return useMock
      ? mockApi.renameSession(id, title)
      : request<SessionView>(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        });
  },

  deleteSession(id: string): Promise<{ deleted: true }> {
    return useMock
      ? mockApi.deleteSession(id)
      : request<{ deleted: true }>(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
  },

  branchSession(id: string, title?: string): Promise<SessionView> {
    return useMock
      ? mockApi.branchSession(id, title)
      : request<SessionView>(`/api/sessions/${encodeURIComponent(id)}/branch`, {
          method: "POST",
          body: JSON.stringify(title === undefined ? {} : { title }),
        });
  },

  updateSettings(patch: SettingsPatch): Promise<SettingsView> {
    return useMock
      ? mockApi.updateSettings(patch)
      : request<SettingsView>("/api/settings", {
          method: "PUT",
          body: JSON.stringify(patch),
        });
  },

  providers(): Promise<ProviderCatalogView> {
    return useMock
      ? mockApi.bootstrap().then((view) => view.providers)
      : request<ProviderCatalogView>("/api/providers");
  },

  engineStatus(): Promise<EngineStatusView> {
    return useMock ? mockApi.engineStatus() : request<EngineStatusView>("/api/engine/status");
  },

  engineConfig(): Promise<EngineConfigView> {
    return useMock
      ? mockApi.engineConfig()
      : request<EngineConfigView>("/api/engine/config");
  },

  updateEngineConfig(patch: EngineConfigPatch): Promise<EngineConfigView> {
    return useMock
      ? mockApi.updateEngineConfig(patch)
      : request<EngineConfigView>("/api/engine/config", {
          method: "PUT",
          body: JSON.stringify(patch),
        });
  },

  skillCatalog(cwd?: string): Promise<SkillCatalogView> {
    return useMock
      ? mockApi.skillCatalog(cwd)
      : request<SkillCatalogView>(`/api/skills${query({ cwd })}`);
  },

  enableSkill(name: string, path?: string | null): Promise<{ skills: SkillView[] }> {
    return useMock
      ? mockApi.enableSkill(name, path)
      : request<{ skills: SkillView[] }>(
          `/api/skills/${encodeURIComponent(name)}/enable`,
          { method: "POST", body: JSON.stringify(path ? { path } : {}) },
        );
  },

  disableSkill(name: string): Promise<{ skills: SkillView[] }> {
    return useMock
      ? mockApi.disableSkill(name)
      : request<{ skills: SkillView[] }>(
          `/api/skills/${encodeURIComponent(name)}/disable`,
          { method: "POST", body: "{}" },
        );
  },

  discoverSkills(input: { cwd: string; query?: string }): Promise<SkillDiscoverResponse> {
    return useMock
      ? mockApi.discoverSkills(input)
      : request<SkillDiscoverResponse>("/api/skills/discover", {
          method: "POST",
          body: JSON.stringify(input),
        });
  },

  mcpServers(): Promise<McpServerView[]> {
    return useMock
      ? mockApi.mcpServers()
      : request<{ servers: McpServerView[] }>("/api/mcp/servers").then(
          (result) => result.servers,
        );
  },

  upsertMcpServer(name: string, input: McpServerInput): Promise<McpServerView> {
    return useMock
      ? mockApi.upsertMcpServer(name, input)
      : request<McpServerView>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify(input),
        });
  },

  deleteMcpServer(name: string): Promise<{ deleted: true }> {
    return useMock
      ? mockApi.deleteMcpServer(name)
      : request<{ deleted: true }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
  },

  enableMcpServer(name: string): Promise<McpServerView> {
    return useMock
      ? mockApi.enableMcpServer(name)
      : request<McpServerView>(
          `/api/mcp/servers/${encodeURIComponent(name)}/enable`,
          { method: "POST", body: "{}" },
        );
  },

  disableMcpServer(name: string): Promise<McpServerView> {
    return useMock
      ? mockApi.disableMcpServer(name)
      : request<McpServerView>(
          `/api/mcp/servers/${encodeURIComponent(name)}/disable`,
          { method: "POST", body: "{}" },
        );
  },

  discoverMcp(input: { name?: string; enabledOnly?: boolean } = {}): Promise<McpDiscoverResponse> {
    return useMock
      ? mockApi.discoverMcp(input)
      : request<McpDiscoverResponse>("/api/mcp/discover", {
          method: "POST",
          body: JSON.stringify(input),
        });
  },

  invokeTool(input: McpToolInvokeRequest): Promise<McpToolInvokeResult> {
    return useMock
      ? mockApi.invokeTool(input)
      : request<McpToolInvokeResult>("/api/tools/invoke", {
          method: "POST",
          body: JSON.stringify(input),
        });
  },

  workspaceStatus(workDir?: string, base?: string): Promise<WorkspaceStatusView> {
    return useMock
      ? mockApi.workspaceStatus(workDir)
      : request<WorkspaceStatusView>(`/api/workspace${query({ workDir, base })}`);
  },

  workspaceDiff(path: string, workDir?: string): Promise<FileDiffView> {
    return useMock
      ? mockApi.workspaceDiff(path, workDir)
      : request<FileDiffView>(`/api/workspace/diff${query({ path, workDir })}`);
  },

  switchBranch(branch: string, workDir?: string): Promise<WorkspaceStatusView> {
    return useMock
      ? mockApi.switchBranch(branch, workDir)
      : request<WorkspaceStatusView>("/api/workspace/branches/switch", {
          method: "POST",
          body: JSON.stringify(workDir ? { branch, workDir } : { branch }),
        });
  },

  initWorkspace(workDir?: string): Promise<WorkspaceStatusView> {
    return useMock
      ? mockApi.initWorkspace(workDir)
      : request<WorkspaceStatusView>("/api/workspace/init", {
          method: "POST",
          body: JSON.stringify(workDir ? { workDir } : {}),
        });
  },

  artifacts(): Promise<ArtifactView[]> {
    return useMock
      ? mockApi.artifacts()
      : request<{ artifacts: ArtifactView[] }>("/api/artifacts").then(
          (result) => result.artifacts,
        );
  },

  artifact(id: string): Promise<ArtifactView> {
    return useMock
      ? mockApi.artifact(id)
      : request<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}`);
  },

  artifactContent(id: string): Promise<string> {
    return useMock
      ? mockApi.artifactContent(id)
      : requestText(`/api/artifacts/${encodeURIComponent(id)}/content`);
  },

  artifactVersions(id: string): Promise<ArtifactVersionView[]> {
    return useMock
      ? mockApi.artifactVersions(id)
      : request<unknown>(`/api/artifacts/${encodeURIComponent(id)}/versions`).then(
          normalizeArtifactVersions,
        );
  },

  artifactFrameToken(id: string, version?: string): Promise<FrameTokenView> {
    return useMock
      ? mockApi.artifactFrameToken(id, version)
      : request<FrameTokenView>(
          `/api/artifacts/${encodeURIComponent(id)}/frame-token`,
          { method: "POST", body: JSON.stringify(version ? { version } : {}) },
        );
  },

  restoreArtifactVersion(id: string, versionId: string): Promise<ArtifactView> {
    return useMock
      ? mockApi.restoreArtifactVersion(id, versionId)
      : request<ArtifactView>(
          `/api/artifacts/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
          { method: "POST", body: "{}" },
        );
  },

  streamEvents(
    onEvent: (event: ServerEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return useMock ? idleUntilAborted(signal) : streamEventsRequest(onEvent, signal);
  },

  createArtifact(input: ArtifactCreateInput): Promise<ArtifactView> {
    return useMock
      ? mockApi.createArtifact(input)
      : request<ArtifactView>("/api/artifacts", {
          method: "POST",
          body: JSON.stringify(input),
        });
  },

  markArtifactOpened(id: string): Promise<ArtifactView> {
    return useMock
      ? mockApi.markArtifactOpened(id)
      : request<ArtifactView>(`/api/artifacts/${encodeURIComponent(id)}/open`, {
          method: "POST",
          body: "{}",
        });
  },

  exportArtifact(id: string, targetPath: string): Promise<ArtifactExportResponse> {
    return useMock
      ? mockApi.exportArtifact(id, targetPath)
      : request<ArtifactExportResponse>(
          `/api/artifacts/${encodeURIComponent(id)}/export`,
          { method: "POST", body: JSON.stringify({ targetPath }) },
        );
  },

  importArtifact(zipPath: string): Promise<ArtifactView> {
    return useMock
      ? mockApi.importArtifact(zipPath)
      : request<ArtifactView>("/api/artifacts/import", {
          method: "POST",
          body: JSON.stringify({ zipPath }),
        });
  },

  cancelTurn(turnId: string): Promise<{ cancelling: true }> {
    return useMock
      ? mockApi.cancelTurn(turnId)
      : request<{ cancelling: true }>(
          `/api/turns/${encodeURIComponent(turnId)}/cancel`,
          { method: "POST", body: "{}" },
        );
  },

  turnStatus(turnId: string): Promise<TurnStatusView> {
    return useMock
      ? Promise.resolve({
          turnId,
          sessionId: "",
          state: "completed",
          stopReason: "end_turn",
          assistantMessageId: null,
          error: null,
        })
      : request<TurnStatusView>(`/api/turns/${encodeURIComponent(turnId)}`);
  },

  streamTurn(
    turnId: string,
    body: TurnRequest,
    onEvent: (event: TurnStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return useMock
      ? mockApi.streamTurn(turnId, body, onEvent, signal)
      : streamTurnRequest(turnId, body, onEvent, signal);
  },
};

export function newTurnId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
