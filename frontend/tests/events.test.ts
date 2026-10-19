import { describe, expect, it, vi } from "vitest";
import { handleGlobalEvent, type QueryInvalidator } from "@/api/events";
import type { ServerEvent } from "@/api/client";

function invalidator() {
  const invalidateQueries = vi.fn();
  const client: QueryInvalidator = { invalidateQueries };
  return { client, invalidateQueries };
}

describe("cross-cutting event refresh", () => {
  it("refreshes artifacts and the active session on artifacts.changed", () => {
    const { client, invalidateQueries } = invalidator();
    const event: ServerEvent = { name: "artifacts.changed", data: { id: "a1" } };
    const keys = handleGlobalEvent(event, { sessionId: "s1", client });

    expect(keys).toEqual([
      ["artifacts"],
      ["artifact-content"],
      ["artifact-versions"],
      ["session", "s1"],
    ]);
    expect(invalidateQueries).toHaveBeenCalledTimes(4);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["artifacts"] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["session", "s1"],
    });
  });

  it("does not touch sessions when none is active", () => {
    const { client, invalidateQueries } = invalidator();
    handleGlobalEvent(
      { name: "artifacts.changed", data: {} },
      { sessionId: null, client },
    );
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
  });

  it("handles engine and session events and ignores unknown ones", () => {
    const { client, invalidateQueries } = invalidator();
    handleGlobalEvent({ name: "engine.status", data: {} }, { sessionId: "s1", client });
    handleGlobalEvent({ name: "sessions.changed", data: {} }, { sessionId: "s1", client });
    handleGlobalEvent({ name: "heartbeat", data: {} }, { sessionId: "s1", client });

    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ["engine"] });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ["sessions"] });
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("refreshes MCP lists and approval state", () => {
    const { client, invalidateQueries } = invalidator();
    handleGlobalEvent(
      { name: "mcp.status", data: { server: "github" } },
      { sessionId: null, client },
    );
    handleGlobalEvent(
      { name: "mcp.approval_required", data: {} },
      { sessionId: null, client },
    );

    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ["mcp"] });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ["mcp-status"],
    });
    expect(invalidateQueries).toHaveBeenNthCalledWith(3, {
      queryKey: ["mcp-approvals"],
    });
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
  });
});
