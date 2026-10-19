import type {
  ArtifactToolCallInput,
  ArtifactToolCallResult,
} from "@/api/types";

/**
 * Host side of the artifact JSON-RPC bridge.
 *
 * The sandboxed frame only ever sees `window.autoagent.callTool(name, args)`.
 * It posts a JSON-RPC 2.0 `tools/call` request to the parent, which enforces
 * the artifact allowlist, asks for consent and forwards the call to the local
 * backend with the launch token. The token never enters the frame.
 */

export const MAX_TOOL_CALLS_PER_TURN = 20;
export const TOOL_CALL_TIMEOUT_MS = 30_000;

export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_CALL_FAILED = -32000;
export const RPC_TIMEOUT = -32001;
export const RPC_DENIED = -32002;

export type ConsentDecision = "once" | "always" | "deny";

export interface ParsedToolCall {
  id: string | number;
  method: "tools/call";
  name: string;
  args: Record<string, unknown>;
}

export interface JsonRpcResult {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcResult | JsonRpcError;

export interface ArtifactToolBridgeOptions {
  /**
   * Tools the artifact may call. A getter keeps the allowlist current when
   * "Always allow" persists a new capability without recreating the bridge
   * (which would forget per-turn quotas and in-memory grants).
   */
  allowedTools: readonly string[] | (() => readonly string[]);
  callTool: (input: ArtifactToolCallInput) => Promise<ArtifactToolCallResult>;
  requestConsent: (request: ParsedToolCall) => Promise<ConsentDecision>;
  /** Called after the user chose "Always allow" and the grant was persisted. */
  alwaysAllow?: (tool: string) => Promise<void> | void;
  maxCalls?: number;
  timeoutMs?: number;
  randomId?: () => string;
}

export type BridgeResponder = (message: JsonRpcResponse) => void;

export interface FrameRef {
  current: HTMLIFrameElement | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept only a JSON-RPC 2.0 request for `tools/call`. Notifications,
 * responses, resize messages and malformed payloads are ignored.
 */
export function parseToolCallRequest(data: unknown): ParsedToolCall | null {
  if (!isRecord(data)) return null;
  if (data.jsonrpc !== "2.0") return null;
  if (data.method !== "tools/call") return null;
  const id = data.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const params = data.params;
  if (!isRecord(params)) return null;
  const name = params.name;
  if (typeof name !== "string" || !name.trim()) return null;
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && !isRecord(rawArgs)) return null;
  return {
    id,
    method: "tools/call",
    name: name.trim(),
    args: isRecord(rawArgs) ? rawArgs : {},
  };
}

/**
 * A message is actionable only when it came from one of the artifact frames.
 * `event.origin` is opaque ("null") because the frames run without
 * `allow-same-origin`, so the window identity is the security boundary.
 */
export function parseFrameMessage(
  event: Pick<MessageEvent, "source" | "data">,
  frames: readonly FrameRef[],
): { request: ParsedToolCall; frameWindow: Window } | null {
  // `event.source` is the frame's WindowProxy, never the iframe element.
  const frameWindow = frames
    .map((frame) => frame.current?.contentWindow ?? null)
    .find((candidate): candidate is Window => candidate !== null && event.source === candidate);
  if (!frameWindow) return null;
  const request = parseToolCallRequest(event.data);
  return request ? { request, frameWindow } : null;
}

export function rpcResult(id: string | number, result: unknown): JsonRpcResult {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Post to an opaque-origin frame; the target origin necessarily is `*`. */
export function sendToFrame(target: Window | null | undefined, message: unknown): boolean {
  if (!target) return false;
  target.postMessage(message, "*");
  return true;
}

function timeoutError(): Error {
  const error = new Error("The tool call timed out.");
  error.name = "TimeoutError";
  return error;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class ArtifactToolBridge {
  private calls = 0;
  private alwaysAllowed = new Set<string>();
  private readonly options: Required<
    Pick<ArtifactToolBridgeOptions, "allowedTools" | "callTool" | "requestConsent">
  > &
    ArtifactToolBridgeOptions;

  constructor(options: ArtifactToolBridgeOptions) {
    this.options = options;
  }

  /** Reset the per-turn quota. Consent grants survive until the bridge dies. */
  beginTurn(): void {
    this.calls = 0;
  }

  get callCount(): number {
    return this.calls;
  }

  allows(name: string): boolean {
    const allowed =
      typeof this.options.allowedTools === "function"
        ? this.options.allowedTools()
        : this.options.allowedTools;
    // Strict allowlist: an artifact that declared no tools may call none.
    return allowed.includes(name);
  }

  /** Handle one parsed request and always answer the frame exactly once. */
  async handle(request: ParsedToolCall, respond: BridgeResponder): Promise<void> {
    if (!this.allows(request.name)) {
      respond(
        rpcError(
          request.id,
          RPC_METHOD_NOT_FOUND,
          `Tool "${request.name}" is not in this artifact's allowlist.`,
        ),
      );
      return;
    }

    const maxCalls = this.options.maxCalls ?? MAX_TOOL_CALLS_PER_TURN;
    if (this.calls >= maxCalls) {
      respond(
        rpcError(
          request.id,
          RPC_CALL_FAILED,
          `Tool call quota exceeded (${maxCalls} per turn).`,
        ),
      );
      return;
    }

    try {
      if (!this.alwaysAllowed.has(request.name)) {
        const decision = await this.options.requestConsent(request);
        if (decision === "deny") {
          respond(rpcError(request.id, RPC_DENIED, "The tool call was denied."));
          return;
        }
        if (decision === "always") {
          await this.options.alwaysAllow?.(request.name);
          this.alwaysAllowed.add(request.name);
        }
      }

      // Re-check after the await: the user may have answered a slow prompt
      // after other calls consumed the quota.
      if (this.calls >= maxCalls) {
        respond(
          rpcError(
            request.id,
            RPC_CALL_FAILED,
            `Tool call quota exceeded (${maxCalls} per turn).`,
          ),
        );
        return;
      }

      this.calls += 1;
      const timeoutMs = this.options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS;
      const requestId =
        this.options.randomId?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await withTimeout(
        this.options.callTool({
          name: request.name,
          arguments: request.args,
          consent: true,
          requestId,
        }),
        timeoutMs,
      );
      respond(
        rpcResult(request.id, {
          content: result.content,
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
          isError: result.isError === true,
        }),
      );
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      respond(
        rpcError(
          request.id,
          timedOut ? RPC_TIMEOUT : RPC_CALL_FAILED,
          timedOut
            ? `The tool call timed out after ${this.options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS}ms.`
            : error instanceof Error && error.message
              ? error.message
              : "The tool call failed.",
        ),
      );
    }
  }
}
