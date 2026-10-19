/**
 * Typed client for AutoAgent's MCP status/log/approval surface.
 *
 * Design notes
 * - `EventSource` cannot send the launch token, so /api/events is consumed
 *   with fetch + an incremental SSE parser (same rationale as api/events.ts).
 * - Every payload is parsed from `unknown`; the client never trusts a shape and
 *   never uses `any`.
 * - The stream reconnects with capped exponential backoff; the returned
 *   unsubscribe function aborts the in-flight request immediately.
 *
 * Reference only: copy next to `src/features/mcp/` when applying PATCH_PLAN.
 */

export type McpConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "disabled"
  | "closed";

export type McpLogLevel = "debug" | "info" | "warning" | "error" | "stderr";

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpToolStatus {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  readonly inputSchema: Record<string, unknown> | null;
  readonly outputSchema: Record<string, unknown> | null;
  readonly annotations: McpToolAnnotations;
}

export interface McpServerStatus {
  readonly name: string;
  readonly state: McpConnectionState;
  readonly connected: boolean;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly lastError: string | null;
  readonly protocolVersion: string | null;
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  readonly instructions: string | null;
  readonly sessionId: string | null;
  readonly pid: number | null;
  readonly reconnectAttempts: number;
  readonly nextRetryInMs: number | null;
  readonly updatedAt: number;
}

export interface McpLogEntry {
  readonly server: string;
  readonly level: McpLogLevel;
  readonly message: string;
  readonly ts: number;
}

export type McpApprovalRisk =
  | "read_only"
  | "write"
  | "destructive"
  | "open_world"
  | "unknown";

export type McpApprovalDecision = "allow" | "deny";
export type McpApprovalScope = "once" | "session";

export interface McpApprovalRequest {
  readonly callId: string;
  readonly server: string;
  readonly tool: string;
  readonly risk: McpApprovalRisk;
  readonly code: string;
  readonly reason: string;
}

export interface McpApprovalResult {
  readonly ok: boolean;
}

export type McpStatusEvent =
  | {
      readonly type: "mcp.status";
      readonly server: string;
      readonly status: McpServerStatus;
    }
  | {
      readonly type: "mcp.log";
      readonly server: string;
      readonly entry: McpLogEntry;
    }
  | {
      readonly type: "mcp.tools_changed";
      readonly server: string;
      readonly tools: readonly McpToolStatus[];
    }
  | {
      readonly type: "mcp.approval_required";
      readonly approval: McpApprovalRequest;
    }
  | {
      readonly type: "mcp.server_changed";
      readonly server: string;
    };

export type McpStreamState = "connecting" | "open" | "closed";

export interface McpStatusClientOptions {
  readonly baseUrl?: string;
  /** Launch token fallback; cookie auth still works when this returns null. */
  readonly getToken?: () => string | null;
  readonly fetchImpl?: typeof fetch;
  readonly reconnectInitialMs?: number;
  readonly reconnectMaxMs?: number;
}

export class McpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "McpStatusError";
  }
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseSseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  flush(): SseFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const block = this.buffer;
    this.buffer = "";
    const frame = parseSseBlock(block);
    return frame ? [frame] : [];
  }
}

function parseSseBlock(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const STATES: ReadonlySet<string> = new Set<McpConnectionState>([
  "idle",
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "disabled",
  "closed",
]);

const LEVELS: ReadonlySet<string> = new Set<McpLogLevel>([
  "debug",
  "info",
  "warning",
  "error",
  "stderr",
]);

const RISKS: ReadonlySet<string> = new Set<McpApprovalRisk>([
  "read_only",
  "write",
  "destructive",
  "open_world",
  "unknown",
]);

function asState(value: unknown): McpConnectionState {
  return typeof value === "string" && STATES.has(value)
    ? (value as McpConnectionState)
    : "idle";
}

function asLevel(value: unknown): McpLogLevel {
  return typeof value === "string" && LEVELS.has(value)
    ? (value as McpLogLevel)
    : "info";
}

function asRisk(value: unknown): McpApprovalRisk {
  return typeof value === "string" && RISKS.has(value)
    ? (value as McpApprovalRisk)
    : "unknown";
}

function asSchema(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asAnnotations(value: unknown): McpToolAnnotations {
  const raw = isRecord(value) ? value : {};
  return {
    readOnlyHint: asBoolean(raw.readOnlyHint),
    destructiveHint: asBoolean(raw.destructiveHint, true),
    idempotentHint: asBoolean(raw.idempotentHint),
    openWorldHint: asBoolean(raw.openWorldHint, true),
  };
}

export function parseTool(value: unknown): McpToolStatus | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  return {
    name,
    title: asNullableString(value.title),
    description: asString(value.description),
    inputSchema: asSchema(value.inputSchema),
    outputSchema: asSchema(value.outputSchema),
    annotations: asAnnotations(value.annotations),
  };
}

export function parseServerStatus(value: unknown): McpServerStatus | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  return {
    name,
    state: asState(value.state),
    connected: asBoolean(value.connected, value.state === "connected"),
    toolCount: asNumber(value.toolCount),
    resourceCount: asNumber(value.resourceCount),
    promptCount: asNumber(value.promptCount),
    lastError: asNullableString(value.lastError),
    protocolVersion: asNullableString(value.protocolVersion),
    serverName: asNullableString(value.serverName),
    serverVersion: asNullableString(value.serverVersion),
    instructions: asNullableString(value.instructions),
    sessionId: asNullableString(value.sessionId),
    pid: asNullableNumber(value.pid),
    reconnectAttempts: asNumber(value.reconnectAttempts),
    nextRetryInMs: asNullableNumber(value.nextRetryInMs),
    updatedAt: asNumber(value.updatedAt),
  };
}

export function parseLogEntry(value: unknown): McpLogEntry | null {
  if (!isRecord(value)) return null;
  const server = asString(value.server);
  if (!server) return null;
  return {
    server,
    level: asLevel(value.level),
    message: asString(value.message),
    ts: asNumber(value.ts),
  };
}

export function parseApproval(value: unknown): McpApprovalRequest | null {
  if (!isRecord(value)) return null;
  const server = asString(value.server);
  const tool = asString(value.tool);
  if (!server || !tool) return null;
  return {
    callId: asString(value.callId, `${server}:${tool}`),
    server,
    tool,
    risk: asRisk(value.risk),
    code: asString(value.code, "consent_required"),
    reason: asString(value.reason, "This tool requires approval."),
  };
}

function parseEventFrame(frame: SseFrame): McpStatusEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  if (frame.event === "mcp.status") {
    const status = parseServerStatus(payload.status);
    return status ? { type: "mcp.status", server: status.name, status } : null;
  }
  if (frame.event === "mcp.log") {
    const entry = parseLogEntry(payload.entry);
    return entry ? { type: "mcp.log", server: entry.server, entry } : null;
  }
  if (frame.event === "mcp.tools_changed") {
    const server = asString(payload.server);
    if (!server) return null;
    const rawTools = Array.isArray(payload.tools) ? payload.tools : [];
    const tools: McpToolStatus[] = [];
    for (const raw of rawTools) {
      const tool = parseTool(raw);
      if (tool) tools.push(tool);
    }
    return { type: "mcp.tools_changed", server, tools };
  }
  if (frame.event === "mcp.approval_required") {
    const approval = parseApproval(payload.approval ?? payload);
    return approval ? { type: "mcp.approval_required", approval } : null;
  }
  if (frame.event === "mcp.server_changed") {
    const server = asString(payload.server);
    return server ? { type: "mcp.server_changed", server } : null;
  }
  return null;
}

export class McpStatusClient {
  private readonly baseUrl: string;
  private readonly getToken: (() => string | null) | null;
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;

  constructor(options: McpStatusClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.getToken = options.getToken ?? null;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.reconnectInitialMs = Math.max(options.reconnectInitialMs ?? 1_000, 100);
    this.reconnectMaxMs = Math.max(
      options.reconnectMaxMs ?? 30_000,
      this.reconnectInitialMs,
    );
  }

  private headers(accept: string, body = false): Headers {
    const headers = new Headers({ accept });
    if (body) headers.set("content-type", "application/json");
    const token = this.getToken?.() ?? null;
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers("application/json", Boolean(init.body)),
        credentials: "include",
      });
    } catch (error) {
      throw new McpStatusError(
        error instanceof Error ? error.message : "The local service could not be reached.",
        0,
        "NETWORK_ERROR",
      );
    }
    if (!response.ok) {
      let message = response.statusText || "The MCP request failed.";
      let code = `HTTP_${response.status}`;
      try {
        const body: unknown = await response.json();
        if (isRecord(body)) {
          if (typeof body.message === "string") message = body.message;
          if (typeof body.code === "string") code = body.code;
          const nested = body.error;
          if (isRecord(nested)) {
            if (typeof nested.message === "string") message = nested.message;
            if (typeof nested.code === "string") code = nested.code;
          }
        }
      } catch {
        // Keep the status text.
      }
      throw new McpStatusError(message, response.status, code);
    }
    if (response.status === 204) return parse(undefined);
    return parse(await response.json());
  }

  async listServers(): Promise<readonly McpServerStatus[]> {
    return this.request("/api/mcp/status", { method: "GET" }, (value) => {
      if (!isRecord(value) || !Array.isArray(value.servers)) return [];
      const servers: McpServerStatus[] = [];
      for (const raw of value.servers) {
        const status = parseServerStatus(raw);
        if (status) servers.push(status);
      }
      return servers;
    });
  }

  async server(name: string): Promise<McpServerStatus> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/status`,
      { method: "GET" },
      (value) => {
        const status = parseServerStatus(value);
        if (!status) {
          throw new McpStatusError("Malformed MCP status response.", 0, "PROTOCOL_ERROR");
        }
        return status;
      },
    );
  }

  async reconnect(name: string): Promise<McpServerStatus> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/reconnect`,
      { method: "POST" },
      (value) => {
        const status = parseServerStatus(value);
        if (!status) {
          throw new McpStatusError("Malformed MCP status response.", 0, "PROTOCOL_ERROR");
        }
        return status;
      },
    );
  }

  async logs(name: string, limit = 200): Promise<readonly McpLogEntry[]> {
    const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(limit, 1000))) });
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/logs?${query.toString()}`,
      { method: "GET" },
      (value) => {
        if (!isRecord(value) || !Array.isArray(value.entries)) return [];
        const entries: McpLogEntry[] = [];
        for (const raw of value.entries) {
          const entry = parseLogEntry(raw);
          if (entry) entries.push(entry);
        }
        return entries;
      },
    );
  }

  async decideApproval(
    server: string,
    tool: string,
    decision: McpApprovalDecision,
    scope: McpApprovalScope = "once",
    callId?: string,
  ): Promise<McpApprovalResult> {
    return this.request(
      "/api/mcp/approvals",
      {
        method: "POST",
        body: JSON.stringify({ server, tool, decision, scope, callId }),
      },
      (value) => ({ ok: isRecord(value) ? asBoolean(value.ok, true) : true }),
    );
  }

  /**
   * Subscribe to `/api/events` (or a dedicated `/api/mcp/events`), filtering
   * MCP events. Returns an unsubscribe function that aborts the stream.
   */
  subscribe(
    onEvent: (event: McpStatusEvent) => void,
    onState?: (state: McpStreamState) => void,
    path = "/api/events",
  ): () => void {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const schedule = (): void => {
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(
        this.reconnectMaxMs,
        this.reconnectInitialMs * 2 ** Math.min(attempt, 8),
      );
      timer = setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (stopped) return;
      onState?.("connecting");
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "GET",
          headers: this.headers("text/event-stream"),
          credentials: "include",
          signal: controller.signal,
        });
      } catch {
        if (!stopped) {
          onState?.("connecting");
          schedule();
        }
        return;
      }
      if (!response.ok || !response.body) {
        if (!stopped) {
          onState?.("connecting");
          schedule();
        }
        return;
      }
      onState?.("open");
      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const dispatch = (frames: readonly SseFrame[]): void => {
        for (const frame of frames) {
          if (frame.event === "heartbeat" || frame.event === "message") continue;
          const event = parseEventFrame(frame);
          if (event) onEvent(event);
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          dispatch(parser.push(decoder.decode(value, { stream: true })));
        }
        dispatch(parser.flush());
      } catch {
        // Abort or network drop; decided below.
      } finally {
        reader.releaseLock();
      }
      if (!stopped) {
        onState?.("connecting");
        schedule();
      }
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      onState?.("closed");
    };
  }
}
