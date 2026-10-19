import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function respond(body: unknown, init?: ResponseInit): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      calls.push({ url: String(input), init: requestInit });
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      });
    }),
  );
  return calls;
}

function bodyOf(call: Call): unknown {
  return call.init?.body ? JSON.parse(String(call.init.body)) : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("skills API", () => {
  it("reads the catalog with the workspace query", async () => {
    const calls = respond({ skills: [], dirs: [] });
    await api.skillCatalog("/workspace/app");
    expect(calls[0].url).toBe("/api/skills?cwd=%2Fworkspace%2Fapp");
    expect(calls[0].init?.method).toBeUndefined();
  });

  it("uses named enable and disable commands", async () => {
    const enableCalls = respond({ skills: [] });
    await api.enableSkill("apple design", "/skills/apple");
    expect(enableCalls[0].url).toBe("/api/skills/apple%20design/enable");
    expect(enableCalls[0].init?.method).toBe("POST");
    expect(bodyOf(enableCalls[0])).toEqual({ path: "/skills/apple" });

    const disableCalls = respond({ skills: [] });
    await api.disableSkill("schema-audit");
    expect(disableCalls[0].url).toBe("/api/skills/schema-audit/disable");
    expect(bodyOf(disableCalls[0])).toEqual({});
  });

  it("posts discovery input", async () => {
    const calls = respond({ items: [] });
    await api.discoverSkills({ cwd: "/workspace", query: "pdf" });
    expect(calls[0].url).toBe("/api/skills/discover");
    expect(bodyOf(calls[0])).toEqual({ cwd: "/workspace", query: "pdf" });
  });
});

describe("MCP API", () => {
  it("lists servers and unwraps the envelope", async () => {
    respond({ servers: [{ id: "fs", name: "fs" }] });
    await expect(api.mcpServers()).resolves.toEqual([{ id: "fs", name: "fs" }]);
  });

  it("upserts with the server definition and toggles by name", async () => {
    const upsertCalls = respond({ id: "fs", name: "fs" });
    await api.upsertMcpServer("fs", {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: {},
      url: null,
      headers: {},
      enabled: true,
      autoRun: false,
    });
    expect(upsertCalls[0].url).toBe("/api/mcp/servers/fs");
    expect(upsertCalls[0].init?.method).toBe("PUT");
    expect(bodyOf(upsertCalls[0])).toMatchObject({ name: "fs", command: "npx" });

    const toggleCalls = respond({ id: "fs" });
    await api.disableMcpServer("fs");
    expect(toggleCalls[0].url).toBe("/api/mcp/servers/fs/disable");

    const deleteCalls = respond({ deleted: true });
    await api.deleteMcpServer("fs");
    expect(deleteCalls[0].init?.method).toBe("DELETE");
  });

  it("discovers and invokes tools", async () => {
    const discoverCalls = respond({ results: [] });
    await api.discoverMcp({ enabledOnly: false });
    expect(bodyOf(discoverCalls[0])).toEqual({ enabledOnly: false });

    const invokeCalls = respond({ content: [] });
    await api.invokeTool({ server: "fs", tool: "read_file", args: { path: "a" } });
    expect(invokeCalls[0].url).toBe("/api/tools/invoke");
    expect(bodyOf(invokeCalls[0])).toEqual({
      server: "fs",
      tool: "read_file",
      args: { path: "a" },
    });
  });
});

describe("workspace API", () => {
  it("reads status, diff and posts branch/init commands", async () => {
    const statusCalls = respond({ workDir: "/w" });
    await api.workspaceStatus("/w", "main");
    expect(statusCalls[0].url).toBe("/api/workspace?workDir=%2Fw&base=main");

    const diffCalls = respond({ path: "a.ts", patch: "" });
    await api.workspaceDiff("a.ts", "/w");
    expect(diffCalls[0].url).toBe("/api/workspace/diff?path=a.ts&workDir=%2Fw");

    const switchCalls = respond({ workDir: "/w" });
    await api.switchBranch("main", "/w");
    expect(switchCalls[0].url).toBe("/api/workspace/branches/switch");
    expect(bodyOf(switchCalls[0])).toEqual({ branch: "main", workDir: "/w" });

    const initCalls = respond({ workDir: "/w" });
    await api.initWorkspace();
    expect(initCalls[0].url).toBe("/api/workspace/init");
    expect(bodyOf(initCalls[0])).toEqual({});
  });
});

describe("artifacts API", () => {
  it("unwraps the list and reads raw content", async () => {
    const listCalls = respond({ artifacts: [{ id: "a1" }] });
    await expect(api.artifacts()).resolves.toEqual([{ id: "a1" }]);
    expect(listCalls[0].url).toBe("/api/artifacts");

    const contentCalls = respond("<!doctype html><p>hi</p>");
    await expect(api.artifactContent("a1")).resolves.toBe("<!doctype html><p>hi</p>");
    expect(contentCalls[0].url).toBe("/api/artifacts/a1/content");
  });

  it("exports and imports by path", async () => {
    const exportCalls = respond({ path: "/tmp/a.zip" });
    await expect(api.exportArtifact("a1", "/tmp/a.zip")).resolves.toEqual({
      path: "/tmp/a.zip",
    });
    expect(bodyOf(exportCalls[0])).toEqual({ targetPath: "/tmp/a.zip" });

    const importCalls = respond({ id: "a2" });
    await api.importArtifact("/tmp/a.zip");
    expect(importCalls[0].url).toBe("/api/artifacts/import");
    expect(bodyOf(importCalls[0])).toEqual({ zipPath: "/tmp/a.zip" });
  });

  it("marks an artifact opened and fetches one artifact", async () => {
    const openCalls = respond({ id: "a1" });
    await api.markArtifactOpened("a1");
    expect(openCalls[0].url).toBe("/api/artifacts/a1/open");
    expect(openCalls[0].init?.method).toBe("POST");

    respond({ id: "a1" });
    await api.artifact("a1");
  });

  it("requests a short-lived frame token for a version", async () => {
    const calls = respond({
      url: "/api/artifacts/a1/frame?token=abc",
      expiresAt: 1_700_000_060_000,
    });
    await expect(api.artifactFrameToken("a1", "v2")).resolves.toEqual({
      url: "/api/artifacts/a1/frame?token=abc",
      expiresAt: 1_700_000_060_000,
    });
    expect(calls[0].url).toBe("/api/artifacts/a1/frame-token");
    expect(calls[0].init?.method).toBe("POST");
    expect(bodyOf(calls[0])).toEqual({ version: "v2" });

    const noVersionCalls = respond({ url: "/api/artifacts/a1/frame?token=abc", expiresAt: 1 });
    await api.artifactFrameToken("a1");
    expect(bodyOf(noVersionCalls[0])).toEqual({});
  });

  it("lists and restores artifact versions", async () => {
    const versionsCalls = respond({
      versions: [
        {
          versionId: "v2",
          createdAt: 3,
          sha256: "ccc",
          sizeBytes: 4,
          source: "turn",
          immutable: true,
        },
        { versionId: "v1", createdAt: 2, sha256: "bbb", sizeBytes: 3 },
      ],
    });
    await expect(api.artifactVersions("a1")).resolves.toMatchObject([
      { versionId: "v2", sha256: "ccc", current: true },
      { versionId: "v1", sha256: "bbb", current: false },
    ]);
    expect(versionsCalls[0].url).toBe("/api/artifacts/a1/versions");

    const restoreCalls = respond({ id: "a1" });
    await api.restoreArtifactVersion("a1", "v1");
    expect(restoreCalls[0].url).toBe("/api/artifacts/a1/versions/v1/restore");
    expect(restoreCalls[0].init?.method).toBe("POST");
  });

  it("updates tool capabilities, calls a tool and reads a version diff", async () => {
    const capabilityCalls = respond({ id: "a1", mcpTools: ["search"] });
    await expect(
      api.updateArtifactCapabilities("a1", ["search"]),
    ).resolves.toMatchObject({ mcpTools: ["search"] });
    expect(capabilityCalls[0].url).toBe("/api/artifacts/a1/capabilities");
    expect(capabilityCalls[0].init?.method).toBe("PUT");
    expect(bodyOf(capabilityCalls[0])).toEqual({ mcpTools: ["search"] });

    const callCalls = respond({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
      isError: false,
    });
    await expect(
      api.artifactToolCall("a1", {
        name: "search",
        arguments: { query: "hello" },
        consent: true,
        requestId: "r1",
      }),
    ).resolves.toMatchObject({ isError: false });
    expect(callCalls[0].url).toBe("/api/artifacts/a1/tools/call");
    expect(callCalls[0].init?.method).toBe("POST");
    expect(bodyOf(callCalls[0])).toEqual({
      name: "search",
      arguments: { query: "hello" },
      consent: true,
      requestId: "r1",
    });

    const diffCalls = respond({ from: "v1", to: "v2", patch: "@@", truncated: true });
    await expect(api.artifactDiff("a1", "v1", "v2")).resolves.toEqual({
      from: "v1",
      to: "v2",
      patch: "@@",
      truncated: true,
    });
    expect(diffCalls[0].url).toBe("/api/artifacts/a1/diff?from=v1&to=v2");
  });
});

describe("engine config API", () => {
  it("reads the fallback config", async () => {
    const calls = respond({
      configPath: "~/.autoagent/settings.json",
      model: "",
      baseURL: null,
      apiKeyConfigured: false,
      apiKeyHelper: null,
      engine: {},
    });
    await api.engineConfig();
    expect(calls[0].url).toBe("/api/engine/config");
    expect(calls[0].init?.method).toBeUndefined();
  });

  it("saves the fallback config with a PUT patch", async () => {
    const calls = respond({ configPath: "~/.autoagent/settings.json" });
    await api.updateEngineConfig({
      model: "",
      baseURL: "",
      apiKey: "sk-test",
      apiKeyHelper: "",
    });
    expect(calls[0].url).toBe("/api/engine/config");
    expect(calls[0].init?.method).toBe("PUT");
    expect(bodyOf(calls[0])).toEqual({
      model: "",
      baseURL: "",
      apiKey: "sk-test",
      apiKeyHelper: "",
    });
  });
});

describe("API errors", () => {
  it("maps a JSON error body to ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "Missing." } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(api.artifact("missing")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Missing.",
      retryable: false,
    });
  });
});
