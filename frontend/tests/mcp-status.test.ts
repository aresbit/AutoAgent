import { describe, expect, it } from "vitest";
import {
  parseApproval,
  parseLogEntry,
  parseServerStatus,
  parseTool,
} from "@/features/mcp/mcpStatusClient";

const status = {
  name: "github",
  state: "connected",
  connected: true,
  toolCount: 17,
  resourceCount: 0,
  promptCount: 0,
  lastError: null,
  protocolVersion: "2025-06-18",
  serverName: "github-mcp",
  serverVersion: "1.4.0",
  instructions: "Use carefully",
  sessionId: "abc",
  pid: 4242,
  reconnectAttempts: 0,
  nextRetryInMs: null,
  updatedAt: 1760000000000,
};

describe("MCP status parsing", () => {
  it("accepts the server status contract", () => {
    const parsed = parseServerStatus(status);
    expect(parsed?.name).toBe("github");
    expect(parsed?.state).toBe("connected");
    expect(parsed?.toolCount).toBe(17);
    expect(parsed?.pid).toBe(4242);
  });

  it("rejects malformed or partial status payloads", () => {
    expect(parseServerStatus(null)).toBeNull();
    expect(parseServerStatus({})).toBeNull();
    expect(parseServerStatus({ ...status, name: "" })).toBeNull();
    expect(parseServerStatus({ ...status, toolCount: "17" })?.toolCount).toBe(0);
  });

  it("normalizes an unknown state instead of trusting it", () => {
    expect(parseServerStatus({ ...status, state: "bogus" })?.state).toBe("idle");
  });

  it("normalizes unknown states without throwing", () => {
    const parsed = parseServerStatus({ ...status, lastError: 42 });
    expect(parsed?.lastError).toBeNull();
  });
});

describe("MCP tool and log parsing", () => {
  it("accepts annotations and rejects nameless tools", () => {
    const tool = parseTool({
      name: "create_issue",
      description: "Create",
      inputSchema: { type: "object" },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
    expect(tool?.name).toBe("create_issue");
    expect(tool?.annotations.destructiveHint).toBe(true);
    expect(parseTool({ description: "no name" })).toBeNull();
  });

  it("accepts known log levels and defaults unknown ones", () => {
    expect(
      parseLogEntry({ server: "s", level: "error", message: "boom", ts: 1 })
        ?.level,
    ).toBe("error");
    expect(
      parseLogEntry({ server: "s", level: "weird", message: "m", ts: 2 })
        ?.level,
    ).toBe("info");
    expect(parseLogEntry({ level: "info" })).toBeNull();
  });
});

describe("MCP approval parsing", () => {
  it("parses the 403 details shape", () => {
    const approval = parseApproval({
      server: "github",
      tool: "create_issue",
      risk: "destructive",
      code: "consent_required",
      reason: "destructive tool requires explicit approval.",
      callId: "opaque",
    });
    expect(approval).toEqual({
      server: "github",
      tool: "create_issue",
      risk: "destructive",
      code: "consent_required",
      reason: "destructive tool requires explicit approval.",
      callId: "opaque",
    });
  });

  it("requires a server and a tool", () => {
    expect(parseApproval({ tool: "x" })).toBeNull();
    expect(parseApproval({ server: "x" })).toBeNull();
    expect(parseApproval("nope")).toBeNull();
  });
});
