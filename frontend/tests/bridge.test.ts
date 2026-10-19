import { describe, expect, it, vi } from "vitest";
import type { ArtifactToolCallResult } from "@/api/types";
import {
  ArtifactToolBridge,
  MAX_TOOL_CALLS_PER_TURN,
  RPC_CALL_FAILED,
  RPC_DENIED,
  RPC_METHOD_NOT_FOUND,
  RPC_TIMEOUT,
  TOOL_CALL_TIMEOUT_MS,
  parseFrameMessage,
  parseToolCallRequest,
  rpcError,
  rpcResult,
  type JsonRpcResponse,
  type ParsedToolCall,
} from "@/features/artifacts/bridge";

const call = (overrides: Partial<ParsedToolCall> = {}): ParsedToolCall => ({
  id: 1,
  method: "tools/call",
  name: "search",
  args: { query: "release" },
  ...overrides,
});

function collector(): { responses: JsonRpcResponse[]; respond: (m: JsonRpcResponse) => void } {
  const responses: JsonRpcResponse[] = [];
  return { responses, respond: (message) => responses.push(message) };
}

const okResult: ArtifactToolCallResult = {
  content: [{ type: "text", text: "found" }],
  structuredContent: { hits: 1 },
  isError: false,
};

describe("JSON-RPC request parsing", () => {
  it("accepts a tools/call request and defaults missing arguments", () => {
    expect(
      parseToolCallRequest({
        jsonrpc: "2.0",
        id: "r-1",
        method: "tools/call",
        params: { name: "  search  " },
      }),
    ).toEqual({ id: "r-1", method: "tools/call", name: "search", args: {} });
  });

  it("rejects wrong versions, methods, ids, params and argument shapes", () => {
    const base = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: {} },
    };
    expect(parseToolCallRequest(null)).toBeNull();
    expect(parseToolCallRequest({ ...base, jsonrpc: "1.0" })).toBeNull();
    expect(parseToolCallRequest({ ...base, method: "tools/list" })).toBeNull();
    expect(parseToolCallRequest({ ...base, id: true })).toBeNull();
    expect(parseToolCallRequest({ ...base, id: undefined })).toBeNull();
    expect(parseToolCallRequest({ ...base, params: null })).toBeNull();
    expect(parseToolCallRequest({ ...base, params: { name: "" } })).toBeNull();
    expect(
      parseToolCallRequest({ ...base, params: { name: "search", arguments: [1, 2] } }),
    ).toBeNull();
  });

  it("ignores resize reporter and unrelated messages", () => {
    expect(
      parseToolCallRequest({ type: "autoagent:artifact-resize", height: 200 }),
    ).toBeNull();
    expect(parseToolCallRequest({ hello: "world" })).toBeNull();
  });
});

describe("frame source validation", () => {
  it("only accepts messages whose source is a registered frame window", () => {
    const frameWindow = { name: "artifact-window" } as unknown as Window;
    const otherWindow = { name: "other-window" } as unknown as Window;
    const frame = {
      current: { contentWindow: frameWindow } as unknown as HTMLIFrameElement,
    };
    const payload = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search" },
    };

    expect(
      parseFrameMessage(
        { source: frameWindow as unknown as MessageEventSource, data: payload },
        [frame],
      ),
    ).toMatchObject({ request: { id: 7, name: "search" }, frameWindow });

    expect(
      parseFrameMessage(
        { source: otherWindow as unknown as MessageEventSource, data: payload },
        [frame],
      ),
    ).toBeNull();

    // The iframe element itself is not a valid source.
    expect(
      parseFrameMessage(
        {
          source: frame.current as unknown as MessageEventSource,
          data: payload,
        },
        [frame],
      ),
    ).toBeNull();
  });
});

describe("RPC response helpers", () => {
  it("builds matching result and error envelopes", () => {
    expect(rpcResult("a", { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: "a",
      result: { ok: true },
    });
    expect(rpcError(1, RPC_DENIED, "no")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: RPC_DENIED, message: "no" },
    });
  });
});

describe("ArtifactToolBridge policy", () => {
  it("denies tools outside the allowlist without calling the backend", async () => {
    const callTool = vi.fn(async () => okResult);
    const requestConsent = vi.fn(async () => "once" as const);
    const bridge = new ArtifactToolBridge({
      allowedTools: ["other"],
      callTool,
      requestConsent,
    });
    const { responses, respond } = collector();

    await bridge.handle(call(), respond);

    expect(callTool).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: RPC_METHOD_NOT_FOUND },
    });
  });

  it("denies an empty allowlist", async () => {
    const callTool = vi.fn(async () => okResult);
    const bridge = new ArtifactToolBridge({
      allowedTools: [],
      callTool,
      requestConsent: async () => "once",
    });
    const { responses, respond } = collector();
    await bridge.handle(call(), respond);
    expect(callTool).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({ error: { code: RPC_METHOD_NOT_FOUND } });
  });

  it("asks for consent on every call until Always allows the tool", async () => {
    const requestConsent = vi.fn(
      async (): Promise<"once" | "always" | "deny"> => "once",
    );
    requestConsent.mockResolvedValueOnce("once").mockResolvedValueOnce("always");
    const callTool = vi.fn(async () => okResult);
    const tools = ["search"];
    const alwaysAllow = vi.fn(async (tool: string) => {
      if (!tools.includes(tool)) tools.push(tool);
    });
    const bridge = new ArtifactToolBridge({
      allowedTools: () => tools,
      callTool,
      requestConsent,
      alwaysAllow,
      randomId: () => "req",
    });

    const first = collector();
    await bridge.handle(call({ id: 1 }), first.respond);
    expect(requestConsent).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "search",
        consent: true,
        requestId: "req",
      }),
    );

    const second = collector();
    await bridge.handle(call({ id: 2 }), second.respond);
    expect(requestConsent).toHaveBeenCalledTimes(2);
    expect(alwaysAllow).toHaveBeenCalledWith("search");

    // Persisted "Always" survives even though a later call adds no prompt.
    const third = collector();
    await bridge.handle(call({ id: 3 }), third.respond);
    expect(requestConsent).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(3);
  });

  it("answers Deny with an error and never calls the backend", async () => {
    const callTool = vi.fn(async () => okResult);
    const bridge = new ArtifactToolBridge({
      allowedTools: ["search"],
      callTool,
      requestConsent: async () => "deny",
    });
    const { responses, respond } = collector();
    await bridge.handle(call(), respond);
    expect(callTool).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({ error: { code: RPC_DENIED } });
  });

  it("enforces the per-turn call quota and resets on beginTurn", async () => {
    const callTool = vi.fn(async () => okResult);
    const bridge = new ArtifactToolBridge({
      allowedTools: ["search"],
      callTool,
      requestConsent: async () => "always",
      maxCalls: 2,
    });

    await bridge.handle(call({ id: 1 }), () => undefined);
    await bridge.handle(call({ id: 2 }), () => undefined);
    const blocked = collector();
    await bridge.handle(call({ id: 3 }), blocked.respond);

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(bridge.callCount).toBe(2);
    expect(blocked.responses[0]).toMatchObject({
      error: { code: RPC_CALL_FAILED },
    });

    bridge.beginTurn();
    await bridge.handle(call({ id: 4 }), () => undefined);
    expect(callTool).toHaveBeenCalledTimes(3);
  });

  it("uses 20 calls as the default quota", async () => {
    const bridge = new ArtifactToolBridge({
      allowedTools: ["search"],
      callTool: async () => okResult,
      requestConsent: async () => "always",
    });
    for (let index = 0; index < MAX_TOOL_CALLS_PER_TURN; index += 1) {
      await bridge.handle(call({ id: index }), () => undefined);
    }
    const blocked = collector();
    await bridge.handle(call({ id: 99 }), blocked.respond);
    expect(blocked.responses[0]).toMatchObject({
      error: { code: RPC_CALL_FAILED },
    });
  });

  it("times out a slow call and reports a timeout error", async () => {
    const bridge = new ArtifactToolBridge({
      allowedTools: ["search"],
      callTool: () => new Promise(() => undefined),
      requestConsent: async () => "always",
      timeoutMs: 5,
    });
    const { responses, respond } = collector();
    await bridge.handle(call({ id: 3 }), respond);
    expect(TOOL_CALL_TIMEOUT_MS).toBe(30_000);
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      error: { code: RPC_TIMEOUT },
    });
  });

  it("maps backend results and failures to JSON-RPC", async () => {
    const success = new ArtifactToolBridge({
      allowedTools: ["search"],
      callTool: async () => okResult,
      requestConsent: async () => "always",
    });
    const ok = collector();
    await success.handle(call(), ok.respond);
    expect(ok.responses[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "found" }],
        structuredContent: { hits: 1 },
        isError: false,
      },
    });

    const failure = new ArtifactToolBridge({
      allowedTools: ["search"],
      callTool: async () => {
        throw new Error("backend exploded");
      },
      requestConsent: async () => "always",
    });
    const bad = collector();
    await failure.handle(call({ id: 9 }), bad.respond);
    expect(bad.responses[0]).toMatchObject({
      id: 9,
      error: { code: RPC_CALL_FAILED, message: "backend exploded" },
    });
  });
});
