import { describe, expect, it } from "vitest";
import { mockApi } from "@/api/mock";

describe("mock mode", () => {
  it("defaults to the MateBot (OpenCC) provider", async () => {
    const bootstrap = await mockApi.bootstrap();
    expect(bootstrap.settings.providerId).toBe("matebot");
    expect(bootstrap.settings.model).toBe("");
    expect(bootstrap.settings.engine).toMatchObject({
      preset: "matebot",
      mode: "matebot",
      model: "claude-sonnet-4-6",
      modelSource: "claude-settings",
      configPath: "~/.claude/settings.json",
    });
    expect(bootstrap.providers.builtin).toHaveLength(1);
    expect(bootstrap.providers.builtin[0]).toMatchObject({
      id: "matebot",
      name: "MateBot (OpenCC)",
      apiType: null,
    });
    expect(JSON.stringify(bootstrap.providers)).not.toContain("Anthropic");
  });

  it("serves and updates the AutoAgent fallback config", async () => {
    const initial = await mockApi.engineConfig();
    expect(initial.configPath).toBe("~/.autoagent/settings.json");
    expect(initial.apiKeyConfigured).toBe(false);

    const saved = await mockApi.updateEngineConfig({
      model: "fallback-model",
      baseURL: "https://gateway.test",
      apiKey: "sk-test",
      apiKeyHelper: "pass show autoagent",
    });
    expect(saved).toMatchObject({
      model: "fallback-model",
      baseURL: "https://gateway.test",
      apiKeyConfigured: true,
      apiKeyHelper: "pass show autoagent",
    });

    const cleared = await mockApi.updateEngineConfig({ model: "", baseURL: "" });
    expect(cleared.model).toBe("");
    expect(cleared.baseURL).toBeNull();
  });

  it("serves seeded skills and toggles them", async () => {
    const catalog = await mockApi.skillCatalog("/workspace/autoagent");
    expect(catalog.skills.length).toBeGreaterThan(0);
    expect(catalog.dirs.some((dir) => dir.source === "project")).toBe(true);
    const name = catalog.skills[0].name;
    const enabled = catalog.skills[0].enabled;
    const next = await mockApi.disableSkill(name);
    expect(next.skills.find((skill) => skill.name === name)?.enabled).toBe(false);
    if (enabled) await mockApi.enableSkill(name);
  });

  it("serves MCP discovery and invocation", async () => {
    const servers = await mockApi.mcpServers();
    expect(servers.length).toBeGreaterThan(0);
    const discovery = await mockApi.discoverMcp({ enabledOnly: false });
    expect(discovery.results.some((result) => result.tools.length > 0)).toBe(true);
    const result = await mockApi.invokeTool({
      server: servers[0].name,
      tool: "read_file",
      args: { path: "a" },
    });
    expect(result.isError).toBe(false);
  });

  it("serves workspace status, diffs and artifacts", async () => {
    const status = await mockApi.workspaceStatus();
    expect(status.files.length).toBeGreaterThan(0);
    const diff = await mockApi.workspaceDiff(status.files[0].path);
    expect(diff.path).toBe(status.files[0].path);
    const artifacts = await mockApi.artifacts();
    expect(artifacts.length).toBeGreaterThan(0);
    const html = await mockApi.artifactContent(artifacts[0].id);
    expect(html).toContain("<!doctype html>");
  });
});
