import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactToolCallResult } from "@/api/types";
import {
  ArtifactToolBridge,
  MAX_TOOL_CALLS_PER_TURN,
  RPC_CALL_FAILED,
  RPC_DENIED,
  RPC_METHOD_NOT_FOUND,
  RPC_TIMEOUT,
  parseFrameMessage,
  parseToolCallRequest,
  rpcResult,
  type FrameRef,
  type JsonRpcResponse,
} from "@/features/artifacts/bridge";
import { DiffViewer } from "@/features/artifacts/DiffViewer";
import { SplitShield, clampSplit } from "@/features/artifacts/SplitPane";

function frameRef(window: unknown): FrameRef {
  return {
    current: { contentWindow: window } as unknown as HTMLIFrameElement,
  };
}

function request(
  id: string | number,
  name: string,
  args: Record<string, unknown> = { q: "x" },
) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

const okResult: ArtifactToolCallResult = {
  content: [{ type: "text", text: "done" }],
  structuredContent: { ok: true },
  isError: false,
};

function harness(
  options: Partial<ConstructorParameters<typeof ArtifactToolBridge>[0]> = {},
) {
  const responses: JsonRpcResponse[] = [];
  const callTool = vi.fn(async () => okResult);
  const requestConsent = vi.fn(async () => "once" as const);
  const alwaysAllow = vi.fn(async () => undefined);
  const bridge = new ArtifactToolBridge({
    allowedTools: ["search"],
    callTool,
    requestConsent,
    alwaysAllow,
    randomId: () => "req-1",
    ...options,
  });
  const respond = (message: JsonRpcResponse) => responses.push(message);
  return { bridge, callTool, requestConsent, alwaysAllow, responses, respond };
}

describe("artifact JSON-RPC parsing", () => {
  it("accepts only a 2.0 tools/call request with an id and object arguments", () => {
    expect(parseToolCallRequest(request(1, "search"))).toEqual({
      id: 1,
      method: "tools/call",
      name: "search",
      args: { q: "x" },
    });
    expect(parseToolCallRequest(request("abc", "search", undefined))).toMatchObject({
      id: "abc",
      args: {},
    });
    expect(parseToolCallRequest({ ...request(1, "search"), jsonrpc: "1.0" })).toBeNull();
    expect(parseToolCallRequest({ ...request(1, "search"), method: "ping" })).toBeNull();
    expect(parseToolCallRequest({ ...request(1, "search"), id: undefined })).toBeNull();
    expect(parseToolCallRequest(request(1, ""))).toBeNull();
    expect(
      parseToolCallRequest(request(1, "search", "not-an-object" as unknown as Record<string, unknown>)),
    ).toBeNull();
    expect(parseToolCallRequest({ type: "autoagent:artifact-resize", height: 10 })).toBeNull();
  });

  it("accepts messages only from one of the artifact frame windows", () => {
    const frameWindow = { id: "frame" } as unknown as MessageEventSource;
    const otherWindow = { id: "other" } as unknown as MessageEventSource;
    const frames = [frameRef(frameWindow)];
    const data = request(1, "search");

    expect(parseFrameMessage({ source: frameWindow, data }, frames)).toMatchObject({
      request: { id: 1, name: "search" },
      frameWindow,
    });
    expect(parseFrameMessage({ source: otherWindow, data }, frames)).toBeNull();
    expect(parseFrameMessage({ source: null, data }, frames)).toBeNull();
    expect(
      parseFrameMessage({ source: frameWindow, data: { method: "tools/call" } }, frames),
    ).toBeNull();
  });
});

describe("artifact tool bridge", () => {
  it("rejects a tool that is not in the allowlist before asking for consent", async () => {
    const { bridge, callTool, requestConsent, responses, respond } = harness();
    await bridge.handle(
      { id: 1, method: "tools/call", name: "shell", args: {} },
      respond,
    );
    expect(responses[0]).toMatchObject({
      error: { code: RPC_METHOD_NOT_FOUND },
    });
    expect(requestConsent).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("asks for consent once per tool and forwards with consent:true", async () => {
    const { bridge, callTool, requestConsent, responses, respond } = harness();
    await bridge.handle({ id: 1, method: "tools/call", name: "search", args: { q: "a" } }, respond);

    expect(requestConsent).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { q: "a" },
      consent: true,
      requestId: "req-1",
    });
    expect(responses[0]).toEqual(
      rpcResult(1, {
        content: okResult.content,
        structuredContent: okResult.structuredContent,
        isError: false,
      }),
    );

    // "Allow once" does not grant the tool for subsequent calls.
    await bridge.handle({ id: 2, method: "tools/call", name: "search", args: {} }, respond);
    expect(requestConsent).toHaveBeenCalledTimes(2);
  });

  it("remembers Always allow and persists the capability through the callback", async () => {
    const requestConsent = vi.fn(async () => "always" as const);
    const { bridge, alwaysAllow, respond } = harness({ requestConsent });

    await bridge.handle({ id: 1, method: "tools/call", name: "search", args: {} }, respond);
    await bridge.handle({ id: 2, method: "tools/call", name: "search", args: {} }, respond);

    expect(alwaysAllow).toHaveBeenCalledWith("search");
    expect(requestConsent).toHaveBeenCalledTimes(1);
  });

  it("denies without forwarding when the user rejects the prompt", async () => {
    const requestConsent = vi.fn(async () => "deny" as const);
    const { bridge, callTool, responses, respond } = harness({ requestConsent });

    await bridge.handle({ id: 7, method: "tools/call", name: "search", args: {} }, respond);

    expect(responses[0]).toMatchObject({ id: 7, error: { code: RPC_DENIED } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("enforces the per-turn call quota and resets on beginTurn", async () => {
    const { bridge, callTool, responses, respond } = harness({ maxCalls: 2 });

    for (let id = 1; id <= 2; id += 1) {
      await bridge.handle({ id, method: "tools/call", name: "search", args: {} }, respond);
    }
    await bridge.handle({ id: 3, method: "tools/call", name: "search", args: {} }, respond);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(responses[2]).toMatchObject({ error: { code: RPC_CALL_FAILED } });

    bridge.beginTurn();
    await bridge.handle({ id: 4, method: "tools/call", name: "search", args: {} }, respond);
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(bridge.callCount).toBe(1);
  });

  it("caps the default quota at 20 calls", async () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(20);
    const { bridge, callTool, responses, respond } = harness({ maxCalls: MAX_TOOL_CALLS_PER_TURN });
    for (let id = 0; id < MAX_TOOL_CALLS_PER_TURN; id += 1) {
      await bridge.handle({ id, method: "tools/call", name: "search", args: {} }, respond);
    }
    await bridge.handle({ id: 99, method: "tools/call", name: "search", args: {} }, respond);
    expect(callTool).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN);
    expect(responses).toHaveLength(MAX_TOOL_CALLS_PER_TURN + 1);
    expect(responses[MAX_TOOL_CALLS_PER_TURN]).toMatchObject({
      error: { code: RPC_CALL_FAILED },
    });
  });

  it("returns a JSON-RPC timeout error when the backend is too slow", async () => {
    const callTool = vi.fn(
      () => new Promise<ArtifactToolCallResult>(() => undefined),
    );
    const { bridge, responses, respond } = harness({ callTool, timeoutMs: 10 });

    await bridge.handle({ id: 5, method: "tools/call", name: "search", args: {} }, respond);
    expect(responses[0]).toMatchObject({ id: 5, error: { code: RPC_TIMEOUT } });
  });

  it("relays backend failures as JSON-RPC errors", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("backend exploded");
    });
    const { bridge, responses, respond } = harness({ callTool });

    await bridge.handle({ id: 6, method: "tools/call", name: "search", args: {} }, respond);
    expect(responses[0]).toMatchObject({
      id: 6,
      error: { code: RPC_CALL_FAILED, message: "backend exploded" },
    });
  });
});

describe("artifact diff view", () => {
  it("renders colored additions/removals and the truncation notice", () => {
    const patch = [
      "--- v1",
      "+++ v2",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      " context",
    ].join("\n");
    const markup = renderToStaticMarkup(
      <DiffViewer patch={patch} truncated from="v1" to="v2" />,
    );
    expect(markup).toContain("v1 → v2");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).toContain("truncated");
    expect(markup).toContain('data-kind="add"');
    expect(markup).toContain('data-kind="remove"');
    expect(markup).toContain('data-kind="hunk"');
    expect(markup).toContain('data-kind="meta"');
    expect(markup).toContain("new line");
    expect(markup).toContain("old line");
  });

  it("handles an empty patch without a diff body", () => {
    const markup = renderToStaticMarkup(<DiffViewer patch="" />);
    expect(markup).toContain("no textual differences");
    expect(markup).not.toContain("truncated");
  });
});

describe("split pane shield", () => {
  it("renders the transparent shield only while dragging", () => {
    const active = renderToStaticMarkup(<SplitShield active />);
    expect(active).toContain('data-testid="split-shield"');
    expect(active).toContain("absolute inset-0");
    expect(renderToStaticMarkup(<SplitShield active={false} />)).toBe("");
  });

  it("clamps the divider to keep both panes usable", () => {
    expect(clampSplit(10)).toBe(20);
    expect(clampSplit(90)).toBe(80);
    expect(clampSplit(50)).toBe(50);
    expect(clampSplit(Number.NaN)).toBe(50);
  });
});
