import { ApiError } from "./errors";
import type {
  ArtifactCreateInput,
  ArtifactVersionView,
  ArtifactView,
  BootstrapView,
  EngineConfigPatch,
  EngineConfigView,
  EngineStatusView,
  FileDiffView,
  FrameTokenView,
  McpDiscoverResponse,
  McpServerInput,
  McpServerView,
  McpToolInvokeRequest,
  McpToolInvokeResult,
  McpToolView,
  ProviderCatalogView,
  SessionSummary,
  SessionView,
  SettingsPatch,
  SettingsView,
  SkillCatalogView,
  SkillDirView,
  SkillDiscoverResponse,
  SkillView,
  TurnRequest,
  TurnStreamEvent,
  WorkspaceStatusView,
} from "./types";

const now = () => Date.now();
const uid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `mock-${Math.random().toString(36).slice(2)}`;

const providers: ProviderCatalogView = {
  builtin: [
    {
      id: "matebot",
      name: "MateBot (OpenCC)",
      apiType: null,
      baseURL: null,
      models: [],
      allowCustomModels: true,
    },
  ],
  custom: [],
};

const settings: SettingsView = {
  providerId: "matebot",
  model: "",
  fallbackModel: null,
  baseURL: null,
  apiKeyConfigured: false,
  cwd: "/workspace/autoagent",
  permissionMode: "bypassPermissions",
  thinkingMode: "adaptive",
  effort: "medium",
  maxThinkingTokens: null,
  maxTurns: 40,
  maxBudgetUsd: 5,
  taskBudget: 2,
  allowedTools: [],
  disallowedTools: [],
  addDirs: [],
  appendSystemPrompt: "",
  layout: { leftOpen: true, leftWidth: 288, rightOpen: true, rightWidth: 360 },
  engine: {
    preset: "matebot",
    version: "opencc-matebot",
    mode: "matebot",
    cli: "/opt/autoagent/bin/opencc",
    model: "claude-sonnet-4-6",
    modelSource: "claude-settings",
    configPath: "~/.claude/settings.json",
  },
};

const engine: EngineStatusView = {
  state: "idle",
  mode: "matebot",
  activeTurns: 0,
  version: "opencc-matebot",
  lastError: null,
};

let engineConfig: EngineConfigView = {
  configPath: "~/.autoagent/settings.json",
  model: "",
  baseURL: null,
  apiKeyConfigured: false,
  apiKeyHelper: "",
  engine: structuredClone(settings.engine) as unknown as Record<string, unknown>,
};

const skillDirs: SkillDirView[] = [
  { path: "/home/agent/.claude/skills", source: "system", exists: true },
  { path: "/home/agent/.codex/skills", source: "system", exists: false },
  { path: "/home/agent/.autoagent/skills", source: "system", exists: true },
  { path: "/workspace/autoagent/.claude/skills", source: "project", exists: true },
  { path: "/workspace/autoagent/.autoagent/skills", source: "project", exists: true },
];

const skills: SkillView[] = [
  {
    name: "apple-design",
    description: "Apple interface design and fluid motion for the web.",
    source: "system",
    enabled: true,
    path: "/home/agent/.claude/skills/apple-design",
  },
  {
    name: "elegant-claude-skill",
    description: "Claude Design System interaction physics and component patterns.",
    source: "system",
    enabled: true,
    path: "/home/agent/.claude/skills/elegant-claude-skill",
  },
  {
    name: "modern-python-skill",
    description: "Modern Python typing, testing and architecture.",
    source: "system",
    enabled: false,
    path: "/home/agent/.claude/skills/modern-python-skill",
  },
  {
    name: "release-notes",
    description: "Draft release notes from the changelog and merged pull requests.",
    source: "project",
    enabled: true,
    path: "/workspace/autoagent/.autoagent/skills/release-notes",
  },
  {
    name: "schema-audit",
    description: "Inspect SQLite schema drift before a migration.",
    source: "project",
    enabled: false,
    path: "/workspace/autoagent/.claude/skills/schema-audit",
  },
];

const mcpServers: McpServerView[] = [
  {
    id: "filesystem",
    name: "filesystem",
    transport: "stdio",
    target: "npx -y @modelcontextprotocol/server-filesystem /workspace",
    enabled: true,
    autoRun: true,
    toolCount: 5,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    env: {},
    url: null,
    headers: {},
  },
  {
    id: "linear",
    name: "linear",
    transport: "http",
    target: "https://mcp.linear.app/sse",
    enabled: false,
    autoRun: false,
    toolCount: null,
    command: null,
    args: [],
    env: {},
    url: "https://mcp.linear.app/sse",
    headers: {},
  },
  {
    id: "playwright",
    name: "playwright",
    transport: "stdio",
    target: "npx -y @playwright/mcp",
    enabled: true,
    autoRun: false,
    toolCount: 12,
    command: "npx",
    args: ["-y", "@playwright/mcp"],
    env: {},
    url: null,
    headers: {},
  },
];

const artifactBodies: Record<string, string> = {
  "artifact-release": [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>Release notes</title>",
    "<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 24px;color:#222;line-height:1.6}h1{font-size:28px}code{background:#f2f2f0;padding:2px 5px;border-radius:4px}</style>",
    "</head><body><h1>Release notes</h1>",
    "<p>Three fixes landed in this build.</p>",
    "<ul><li>Skill toggles move directories atomically.</li><li>Workspace status is one aggregate.</li><li>Artifact preview stays sandboxed.</li></ul>",
    "<p>Run <code>bun run test</code> before packaging.</p></body></html>",
  ].join(""),
  "artifact-dashboard": [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>Turn metrics</title>",
    "<style>body{font-family:system-ui,sans-serif;margin:0;padding:32px;background:#fafaf8;color:#1b1b1a}h1{font-size:22px}.row{display:flex;gap:16px;margin-top:24px}.tile{flex:1;background:#fff;border:1px solid #e6e4df;border-radius:12px;padding:18px}.value{font-size:32px;font-variant-numeric:tabular-nums}</style>",
    "</head><body><h1>Turn metrics</h1><div class=\"row\">",
    "<div class=\"tile\"><div>Completed</div><div class=\"value\">128</div></div>",
    "<div class=\"tile\"><div>Cancelled</div><div class=\"value\">4</div></div>",
    "<div class=\"tile\"><div>Median latency</div><div class=\"value\">2.4s</div></div>",
    "</div></body></html>",
  ].join(""),
};

const artifactVersionShas: Record<string, string[]> = {
  "artifact-release": [
    "9f2c1d7a4b8e6053c1a94f2d7e6b0a3c5d8f1e2a4b6c7d9e0f1a2b3c4d5e6f70",
    "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
  ],
  "artifact-dashboard": [
    "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2",
  ],
};

const artifacts: ArtifactView[] = [
  {
    id: "artifact-release",
    title: "Release notes",
    description: "Parity panel summary for the v1.1 build.",
    createdAt: now() - 1000 * 60 * 60 * 26,
    updatedAt: now() - 1000 * 60 * 90,
    lastOpenedAt: now() - 1000 * 60 * 60 * 3,
    versions: [now() - 1000 * 60 * 60 * 26, now() - 1000 * 60 * 90],
    contentUrl: "/api/artifacts/artifact-release/content",
    thumbnailUrl: null,
    revision: "v2",
    versionCount: 2,
  },
  {
    id: "artifact-dashboard",
    title: "Turn metrics",
    description: "A compact status page for the turn engine.",
    createdAt: now() - 1000 * 60 * 60 * 50,
    updatedAt: now() - 1000 * 60 * 60 * 8,
    lastOpenedAt: null,
    versions: [now() - 1000 * 60 * 60 * 50],
    contentUrl: "/api/artifacts/artifact-dashboard/content",
    thumbnailUrl: null,
    revision: "v1",
    versionCount: 1,
  },
];

let workspaceState: WorkspaceStatusView = {
  workDir: settings.cwd,
  isGitRepo: true,
  additions: 184,
  deletions: 36,
  changedFiles: 4,
  branches: [
    { name: "main", isRemote: false, current: true },
    { name: "feat/parity-panels", isRemote: false, current: false },
    { name: "origin/main", isRemote: true, current: false },
  ],
  files: [
    { path: "frontend/src/features/skills/SkillsPanel.tsx", status: "added", additions: 96, deletions: 0 },
    { path: "frontend/src/api/client.ts", status: "modified", additions: 64, deletions: 2 },
    { path: "frontend/src/app/Shell.tsx", status: "modified", additions: 24, deletions: 30 },
    { path: "backend/src/autoagent_backend/adapters/workspace.py", status: "deleted", additions: 0, deletions: 4 },
  ],
  warnings: ["Branch feat/parity-panels has no upstream."],
};

const workspaceDiffs: Record<string, FileDiffView> = {
  "frontend/src/features/skills/SkillsPanel.tsx": {
    path: "frontend/src/features/skills/SkillsPanel.tsx",
    patch: [
      "diff --git a/frontend/src/features/skills/SkillsPanel.tsx b/frontend/src/features/skills/SkillsPanel.tsx",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/frontend/src/features/skills/SkillsPanel.tsx",
      "@@ -0,0 +1,4 @@",
      "+export function SkillsPanel() {",
      "+  return <div>Catalog</div>;",
      "+}",
    ].join("\n"),
    original: null,
    current: "export function SkillsPanel() {\n  return <div>Catalog</div>;\n}\n",
  },
  "frontend/src/api/client.ts": {
    path: "frontend/src/api/client.ts",
    patch: [
      "diff --git a/frontend/src/api/client.ts b/frontend/src/api/client.ts",
      "--- a/frontend/src/api/client.ts",
      "+++ b/frontend/src/api/client.ts",
      "@@ -1,2 +1,3 @@",
      " const api = {",
      "+  skills() {},",
      " };",
    ].join("\n"),
    original: "const api = {\n};\n",
    current: "const api = {\n  skills() {},\n};\n",
  },
  "frontend/src/app/Shell.tsx": {
    path: "frontend/src/app/Shell.tsx",
    patch: [
      "diff --git a/frontend/src/app/Shell.tsx b/frontend/src/app/Shell.tsx",
      "--- a/frontend/src/app/Shell.tsx",
      "+++ b/frontend/src/app/Shell.tsx",
      "@@ -1,2 +1,2 @@",
      "-const tab = \"settings\";",
      "+const tab = \"workspace\";",
    ].join("\n"),
    original: "const tab = \"settings\";\n",
    current: "const tab = \"workspace\";\n",
  },
  "backend/src/autoagent_backend/adapters/workspace.py": {
    path: "backend/src/autoagent_backend/adapters/workspace.py",
    patch: [
      "diff --git a/backend/src/autoagent_backend/adapters/workspace.py b/backend/src/autoagent_backend/adapters/workspace.py",
      "deleted file mode 100644",
      "--- a/backend/src/autoagent_backend/adapters/workspace.py",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-def status(): ...",
      "-def diff(): ...",
    ].join("\n"),
    original: "def status(): ...\ndef diff(): ...\n",
    current: null,
  },
};

const t = now();
const sessions: SessionView[] = [
  {
    id: "seed-stream",
    title: "Turn stream integration",
    createdAt: t - 1000 * 60 * 42,
    updatedAt: t - 1000 * 60 * 5,
    messages: [
      {
        id: "seed-m1",
        role: "user",
        text: "How should the new chat UI consume the turn stream?",
        createdAt: t - 1000 * 60 * 42,
        meta: null,
      },
      {
        id: "seed-m2",
        role: "assistant",
        text: [
          "The stream is a projection of domain events, so the client never sees engine frames.",
          "",
          "**Client rules**",
          "",
          "- POST the turn request and read `ReadableStream`; `EventSource` cannot POST.",
          "- Append `message.delta` by channel, then replace the draft with `message.completed.text`.",
          "- Key retries by the client-generated `turnId` so a dropped connection cannot start a second turn.",
          "",
          "```ts",
          "for await (const frame of frames) {",
          "  if (frame.event === \"message.delta\") append(frame.data);",
          "}",
          "```",
          "",
          "| Event | UI effect |",
          "| --- | --- |",
          "| `message.delta` | append text or thinking |",
          "| `tool.start` | insert a running tool card |",
          "| `turn.completed` | finalize and refresh sessions |",
        ].join("\n"),
        createdAt: t - 1000 * 60 * 41,
        meta: null,
      },
    ],
  },
  {
    id: "seed-tokens",
    title: "Design token cleanup",
    createdAt: t - 1000 * 60 * 60 * 6,
    updatedAt: t - 1000 * 60 * 60 * 2,
    messages: [
      {
        id: "seed-m3",
        role: "user",
        text: "Can you check the surfaces for raw colors and nested borders?",
        createdAt: t - 1000 * 60 * 60 * 6,
        meta: null,
      },
      {
        id: "seed-m4",
        role: "assistant",
        text: [
          "I found two things worth changing.",
          "",
          "1. The settings form painted a border inside a bordered card. I replaced it with a single hairline inset so there is only one closed edge.",
          "2. Two counters used proportional digits. They now use `tabular-nums`.",
          "",
          "> Focus rings stay double: a background-colored gap plus the terracotta halo.",
        ].join("\n"),
        createdAt: t - 1000 * 60 * 60 * 2,
        meta: null,
      },
    ],
  },
  {
    id: "seed-preview",
    title: "Artifact preview",
    createdAt: t - 1000 * 60 * 60 * 24,
    updatedAt: t - 1000 * 60 * 60 * 23,
    messages: [
      {
        id: "seed-m5",
        role: "user",
        text: "Show me a tiny artifact page.",
        createdAt: t - 1000 * 60 * 60 * 24,
        meta: null,
      },
      {
        id: "seed-m6",
        role: "assistant",
        text: [
          "Here is a self-contained page. Preview it inside a sandbox that allows scripts but blocks same-origin access and network requests.",
          "",
          "```artifact-html",
          "<!doctype html>",
          "<html>",
          "  <body style=\"font-family: sans-serif; padding: 24px\">",
          "    <h1>Release notes</h1>",
          "    <p>Three fixes landed in this build.</p>",
          "  </body>",
          "</html>",
          "```",
        ].join("\n"),
        createdAt: t - 1000 * 60 * 60 * 23,
        meta: null,
      },
    ],
  },
];

let engineActive = 0;
const cancelled = new Set<string>();
const transientFailures = new Set<string>();

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EmittableEvent = DistributiveOmit<TurnStreamEvent, "turnId" | "sessionId" | "seq" | "ts">;

function summary(session: SessionView): SessionSummary {
  const last = session.messages[session.messages.length - 1];
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    lastMessagePreview: last ? last.text.replace(/[#*`>\n]+/g, " ").trim().slice(0, 120) : null,
  };
}

function findSession(id: string): SessionView {
  const session = sessions.find((s) => s.id === id);
  if (!session) {
    throw new ApiError({ status: 404, code: "SESSION_NOT_FOUND", message: "Session not found.", retryable: false });
  }
  return session;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

const mcpServerTools: Record<string, McpToolView[]> = {
  filesystem: [
    { name: "read_file", description: "Read a file from the workspace.", inputSchema: { type: "object" } },
    { name: "write_file", description: "Write a file inside the workspace.", inputSchema: { type: "object" } },
    { name: "list_directory", description: "List a directory.", inputSchema: { type: "object" } },
    { name: "search_files", description: "Search file contents.", inputSchema: { type: "object" } },
    { name: "move_file", description: "Move or rename a file.", inputSchema: { type: "object" } },
  ],
  playwright: [
    { name: "open_page", description: "Open a URL in a browser page.", inputSchema: { type: "object" } },
    { name: "screenshot", description: "Capture the current page.", inputSchema: { type: "object" } },
    { name: "click", description: "Click an element.", inputSchema: { type: "object" } },
  ],
  linear: [
    { name: "list_issues", description: "List issues for a team.", inputSchema: { type: "object" } },
    { name: "create_issue", description: "Create a new issue.", inputSchema: { type: "object" } },
  ],
};

function mcpTarget(input: McpServerInput): string {
  if (input.transport === "stdio") {
    return [input.command ?? "", ...input.args].filter(Boolean).join(" ");
  }
  return input.url ?? "";
}

async function setMcpEnabled(name: string, enabled: boolean): Promise<McpServerView> {
  await sleep(140);
  const server = mcpServers.find((item) => item.id === name || item.name === name);
  if (!server) {
    throw new ApiError({ status: 404, code: "MCP_NOT_FOUND", message: "MCP server not found.", retryable: false });
  }
  server.enabled = enabled;
  return structuredClone(server);
}

function findArtifact(id: string): ArtifactView {
  const artifact = artifacts.find((item) => item.id === id);
  if (!artifact) {
    throw new ApiError({ status: 404, code: "ARTIFACT_NOT_FOUND", message: "Artifact not found.", retryable: false });
  }
  return artifact;
}

export const mockApi = {
  async bootstrap(): Promise<BootstrapView> {
    await sleep(240);
    return {
      apiVersion: "1",
      settings: structuredClone(settings),
      providers,
      sessions: sessions.map(summary).sort((a, b) => b.updatedAt - a.updatedAt),
      mcpServers: structuredClone(mcpServers),
      skills: structuredClone(skills),
      artifacts: structuredClone(artifacts),
      workspace: structuredClone(workspaceState),
      engine: { ...engine },
    };
  },

  async sessions(): Promise<SessionSummary[]> {
    await sleep(90);
    return sessions.map(summary).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async session(id: string): Promise<SessionView> {
    await sleep(120);
    return structuredClone(findSession(id));
  },

  async createSession(title?: string): Promise<SessionView> {
    await sleep(160);
    const timestamp = now();
    const session: SessionView = {
      id: uid(),
      title: title?.trim() || "New conversation",
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
    };
    sessions.unshift(session);
    return structuredClone(session);
  },

  async renameSession(id: string, title: string): Promise<SessionView> {
    await sleep(120);
    const session = findSession(id);
    session.title = title.trim() || session.title;
    session.updatedAt = now();
    return structuredClone(session);
  },

  async deleteSession(id: string): Promise<{ deleted: true }> {
    await sleep(120);
    const index = sessions.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new ApiError({ status: 404, code: "SESSION_NOT_FOUND", message: "Session not found.", retryable: false });
    }
    sessions.splice(index, 1);
    return { deleted: true };
  },

  async branchSession(id: string, title?: string): Promise<SessionView> {
    await sleep(180);
    const source = findSession(id);
    const timestamp = now();
    const session: SessionView = {
      id: uid(),
      title: title?.trim() || `${source.title} (branch)`,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: source.messages.map((m) => ({ ...m, id: uid(), createdAt: timestamp })),
    };
    sessions.unshift(session);
    return structuredClone(session);
  },

  async updateSettings(patch: SettingsPatch): Promise<SettingsView> {
    await sleep(140);
    if (patch.permissionMode && patch.permissionMode !== "bypassPermissions") {
      throw new ApiError({
        status: 422,
        code: "PERMISSION_MODE_UNSUPPORTED",
        message: "This build only supports full access.",
        retryable: false,
      });
    }
    const { apiKey, ...rest } = patch;
    Object.assign(settings, rest);
    if (apiKey) settings.apiKeyConfigured = true;
    return structuredClone(settings);
  },

  async engineStatus(): Promise<EngineStatusView> {
    await sleep(60);
    return { ...engine, activeTurns: engineActive };
  },

  async engineConfig(): Promise<EngineConfigView> {
    await sleep(110);
    return structuredClone(engineConfig);
  },

  async updateEngineConfig(patch: EngineConfigPatch): Promise<EngineConfigView> {
    await sleep(200);
    engineConfig = {
      ...engineConfig,
      model: patch.model === undefined ? engineConfig.model : patch.model,
      baseURL:
        patch.baseURL === undefined
          ? engineConfig.baseURL
          : patch.baseURL.trim() || null,
      apiKeyHelper:
        patch.apiKeyHelper === undefined
          ? engineConfig.apiKeyHelper
          : patch.apiKeyHelper.trim() || null,
      apiKeyConfigured:
        patch.apiKey === undefined
          ? engineConfig.apiKeyConfigured
          : patch.apiKey.trim().length > 0,
    };
    return structuredClone(engineConfig);
  },

  async skillCatalog(_cwd?: string): Promise<SkillCatalogView> {
    await sleep(110);
    return { skills: structuredClone(skills), dirs: structuredClone(skillDirs) };
  },

  async enableSkill(name: string, path?: string | null): Promise<{ skills: SkillView[] }> {
    await sleep(140);
    const skill = skills.find((item) => item.name === name);
    if (!skill) {
      throw new ApiError({ status: 404, code: "SKILL_NOT_FOUND", message: "Skill not found.", retryable: false });
    }
    skill.enabled = true;
    if (path) skill.path = path;
    return { skills: structuredClone(skills) };
  },

  async disableSkill(name: string): Promise<{ skills: SkillView[] }> {
    await sleep(140);
    const skill = skills.find((item) => item.name === name);
    if (!skill) {
      throw new ApiError({ status: 404, code: "SKILL_NOT_FOUND", message: "Skill not found.", retryable: false });
    }
    skill.enabled = false;
    return { skills: structuredClone(skills) };
  },

  async discoverSkills(input: { cwd: string; query?: string }): Promise<SkillDiscoverResponse> {
    await sleep(260);
    const needle = (input.query ?? "").trim().toLowerCase();
    return {
      items: skills
        .filter((skill) => !needle || skill.name.toLowerCase().includes(needle))
        .map((skill) => ({
          id: skill.path ?? skill.name,
          name: skill.name,
          path: skill.path ?? input.cwd,
          description: skill.description,
        })),
    };
  },

  async mcpServers(): Promise<McpServerView[]> {
    await sleep(90);
    return structuredClone(mcpServers);
  },

  async upsertMcpServer(name: string, input: McpServerInput): Promise<McpServerView> {
    await sleep(180);
    const view: McpServerView = {
      id: name,
      name: input.name || name,
      transport: input.transport,
      target: mcpTarget(input),
      enabled: input.enabled,
      autoRun: input.autoRun,
      toolCount: mcpServerTools[input.name || name]?.length ?? null,
      command: input.command,
      args: input.args,
      env: input.env,
      url: input.url,
      headers: input.headers,
    };
    const index = mcpServers.findIndex((server) => server.id === name || server.name === name);
    if (index === -1) mcpServers.push(view);
    else mcpServers[index] = view;
    return structuredClone(view);
  },

  async deleteMcpServer(name: string): Promise<{ deleted: true }> {
    await sleep(120);
    const index = mcpServers.findIndex((server) => server.id === name || server.name === name);
    if (index === -1) {
      throw new ApiError({ status: 404, code: "MCP_NOT_FOUND", message: "MCP server not found.", retryable: false });
    }
    mcpServers.splice(index, 1);
    return { deleted: true };
  },

  async enableMcpServer(name: string): Promise<McpServerView> {
    return setMcpEnabled(name, true);
  },

  async disableMcpServer(name: string): Promise<McpServerView> {
    return setMcpEnabled(name, false);
  },

  async discoverMcp(input: { name?: string; enabledOnly?: boolean } = {}): Promise<McpDiscoverResponse> {
    await sleep(460);
    return {
      results: mcpServers
        .filter((server) => (input.name ? server.name === input.name || server.id === input.name : true))
        .filter((server) => (input.name ? true : input.enabledOnly === false ? true : server.enabled))
        .map((server) => ({
          id: server.id,
          name: server.name,
          displayId: server.id,
          status: "connected",
          durationMs: 180 + Math.round(Math.random() * 240),
          tools: mcpServerTools[server.name] ?? [],
        })),
    };
  },

  async invokeTool(input: McpToolInvokeRequest): Promise<McpToolInvokeResult> {
    await sleep(520);
    if (!input.tool.trim()) {
      throw new ApiError({ status: 422, code: "TOOL_REQUIRED", message: "Choose a tool to invoke.", retryable: false });
    }
    return {
      isError: false,
      content: [
        {
          type: "text",
          text: `${input.tool} completed on ${input.server ?? "the default server"}.\n${JSON.stringify(input.args, null, 2)}`,
        },
      ],
    };
  },

  async workspaceStatus(_workDir?: string): Promise<WorkspaceStatusView> {
    await sleep(120);
    return structuredClone(workspaceState);
  },

  async workspaceDiff(path: string, _workDir?: string): Promise<FileDiffView> {
    await sleep(140);
    const diff = workspaceDiffs[path];
    if (!diff) {
      throw new ApiError({ status: 404, code: "DIFF_NOT_FOUND", message: "No diff for this file.", retryable: false });
    }
    return structuredClone(diff);
  },

  async switchBranch(branch: string, _workDir?: string): Promise<WorkspaceStatusView> {
    await sleep(260);
    if (!workspaceState.branches.some((item) => item.name === branch)) {
      throw new ApiError({ status: 404, code: "BRANCH_NOT_FOUND", message: "Branch not found.", retryable: false });
    }
    workspaceState = {
      ...workspaceState,
      branches: workspaceState.branches.map((item) => ({ ...item, current: item.name === branch })),
    };
    return structuredClone(workspaceState);
  },

  async initWorkspace(workDir?: string): Promise<WorkspaceStatusView> {
    await sleep(240);
    workspaceState = {
      ...workspaceState,
      workDir: workDir || workspaceState.workDir,
      isGitRepo: true,
      warnings: [],
    };
    return structuredClone(workspaceState);
  },

  async artifacts(): Promise<ArtifactView[]> {
    await sleep(100);
    return structuredClone(artifacts);
  },

  async artifact(id: string): Promise<ArtifactView> {
    await sleep(90);
    return structuredClone(findArtifact(id));
  },

  async artifactContent(id: string): Promise<string> {
    await sleep(120);
    findArtifact(id);
    return artifactBodies[id] ?? "<!doctype html><title>Artifact</title><p>No content.</p>";
  },

  async artifactVersions(id: string): Promise<ArtifactVersionView[]> {
    await sleep(90);
    const artifact = findArtifact(id);
    const shas = artifactVersionShas[id] ?? [];
    return [...artifact.versions]
      .sort((a, b) => b - a)
      .map((createdAt, index) => ({
        versionId: `v${artifact.versions.length - index}`,
        createdAt,
        sha256: shas[index] ?? "",
        sizeBytes: (artifactBodies[id] ?? "").length,
        source: index === 0 ? "turn" : "update",
        immutable: true,
        current: `v${artifact.versions.length - index}` === artifact.revision,
      }));
  },

  async artifactFrameToken(_id: string, _version?: string): Promise<FrameTokenView> {
    await sleep(60);
    // The static mock has no backend frame endpoint; callers fall back to srcDoc.
    throw new ApiError({
      status: 404,
      code: "FRAME_TOKEN_UNAVAILABLE",
      message: "The interactive frame endpoint is unavailable.",
      retryable: false,
    });
  },

  async restoreArtifactVersion(id: string, versionId: string): Promise<ArtifactView> {
    await sleep(220);
    const artifact = findArtifact(id);
    const valid = new Set(
      artifact.versions.map((_, index) => `v${artifact.versions.length - index}`),
    );
    if (!valid.has(versionId)) {
      throw new ApiError({
        status: 404,
        code: "VERSION_NOT_FOUND",
        message: "That artifact version no longer exists.",
        retryable: false,
      });
    }
    const timestamp = now();
    artifact.versions = [...artifact.versions, timestamp];
    artifact.updatedAt = timestamp;
    artifact.revision = `v${artifact.versions.length}`;
    artifact.versionCount = artifact.versions.length;
    return structuredClone(artifact);
  },

  async createArtifact(input: ArtifactCreateInput): Promise<ArtifactView> {
    await sleep(180);
    const timestamp = now();
    const id = `artifact-${uid().slice(0, 8)}`;
    const view: ArtifactView = {
      id,
      title: input.title?.trim() || "Untitled artifact",
      description: input.description?.trim() || "",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastOpenedAt: null,
      versions: [timestamp],
      contentUrl: `/api/artifacts/${id}/content`,
      thumbnailUrl: null,
      revision: "v1",
      versionCount: 1,
    };
    artifactBodies[id] = input.html;
    artifacts.unshift(view);
    return structuredClone(view);
  },

  async markArtifactOpened(id: string): Promise<ArtifactView> {
    await sleep(60);
    const artifact = findArtifact(id);
    artifact.lastOpenedAt = now();
    return structuredClone(artifact);
  },

  async exportArtifact(_id: string, targetPath: string): Promise<{ path: string }> {
    await sleep(220);
    if (!targetPath.trim()) {
      throw new ApiError({ status: 422, code: "PATH_REQUIRED", message: "Choose an export path.", retryable: false });
    }
    return { path: targetPath };
  },

  async importArtifact(zipPath: string): Promise<ArtifactView> {
    await sleep(300);
    if (!zipPath.trim()) {
      throw new ApiError({ status: 422, code: "PATH_REQUIRED", message: "Choose an archive to import.", retryable: false });
    }
    const name = zipPath.split("/").pop()?.replace(/\.zip$/i, "") || "Imported artifact";
    return this.createArtifact({
      title: name,
      description: `Imported from ${zipPath}`,
      html: "<!doctype html><title>Imported</title><p>Imported artifact preview.</p>",
    });
  },

  async cancelTurn(turnId: string): Promise<{ cancelling: true }> {
    cancelled.add(turnId);
    return { cancelling: true };
  },

  async streamTurn(
    turnId: string,
    request: TurnRequest,
    onEvent: (event: TurnStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const session = findSession(request.sessionId);
    const base = () => ({ turnId, sessionId: request.sessionId });
    let seq = 0;
    let text = "";
    let thinking = "";
    engineActive += 1;
    engine.state = "busy";
    engine.activeTurns = engineActive;
    try {
      const emit = (event: EmittableEvent) => {
        seq += 1;
        onEvent({ ...base(), seq, ts: now(), ...event } as TurnStreamEvent);
      };
      const stopped = () => cancelled.has(turnId);
      const finish = async (reason: "end_turn" | "cancelled") => {
        const messageId = uid();
        if (text.trim()) {
          session.messages.push({
            id: messageId,
            role: "assistant",
            text,
            createdAt: now(),
            meta: null,
          });
          session.updatedAt = now();
        }
        emit({ type: "message.completed", messageId, text });
        emit({ type: "turn.completed", stopReason: reason });
      };

      await sleep(220, signal);
      emit({ type: "turn.started", model: settings.model });
      await sleep(120, signal);

      const plan = thinkingPlan(request.text);
      for (const piece of chunks(plan, 9)) {
        if (stopped()) {
          await finish("cancelled");
          return;
        }
        thinking += piece;
        emit({ type: "message.delta", channel: "thinking", text: piece });
        await sleep(34, signal);
      }

      if (request.text.includes("/error") && !transientFailures.has(request.sessionId)) {
        transientFailures.add(request.sessionId);
        emit({
          type: "error",
          code: "ENGINE_EXITED",
          message: "The engine stopped before the turn completed.",
          retryable: true,
        });
        return;
      }

      const toolRef = uid();
      emit({
        type: "tool.start",
        tool: {
          ref: toolRef,
          name: "search",
          input: { query: request.text.slice(0, 72), scope: settings.cwd },
        },
      });
      await sleep(520, signal);
      emit({
        type: "tool.result",
        tool: { ref: toolRef, name: "search", ok: true },
        text: "3 matching files",
      });
      await sleep(180, signal);

      const reply = buildReply(request.text);
      for (const piece of chunks(reply, 11)) {
        if (stopped()) {
          await finish("cancelled");
          return;
        }
        text += piece;
        emit({ type: "message.delta", channel: "text", text: piece });
        await sleep(26, signal);
      }

      emit({ type: "usage", usage: { inputTokens: 1842, outputTokens: Math.max(64, Math.round(text.length / 4)) } });
      if (stopped()) {
        await finish("cancelled");
        return;
      }
      await finish("end_turn");
    } finally {
      engineActive = Math.max(0, engineActive - 1);
      engine.activeTurns = engineActive;
      engine.state = engineActive > 0 ? "busy" : "idle";
      cancelled.delete(turnId);
    }
  },
};

function chunks(value: string, size: number): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < value.length) {
    const step = size + Math.floor(Math.random() * 5);
    out.push(value.slice(index, index + step));
    index += step;
  }
  return out;
}

function thinkingPlan(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  return [
    `The request is: ${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""}.`,
    "First I will map it to the existing turn contract, then check which pieces the UI already renders.",
    "The risky part is streaming ownership: reply text, thinking text and tool cards all arrive on one connection, so they need one reducer and one cancel path.",
    "I will keep the final text authoritative and treat deltas as best effort.",
  ].join(" ");
}

function buildReply(prompt: string): string {
  const lower = prompt.toLowerCase();
  const preview = prompt.trim().replace(/\s+/g, " ").slice(0, 96);
  if (lower.includes("html")) {
    return [
      "Here is a compact artifact you can preview or read as source.",
      "",
      "```html",
      "<!doctype html>",
      "<html>",
      "  <body style=\"font-family: sans-serif; padding: 24px\">",
      "    <h1>Build status</h1>",
      "    <p>All turn-stream checks passed.</p>",
      "  </body>",
      "</html>",
      "```",
      "",
      "The preview iframe runs with an empty sandbox, so it cannot reach the app.",
    ].join("\n");
  }
  return [
    `Starting from “${preview}”, I would keep the change inside the turn boundary.`,
    "",
    "**What changes**",
    "",
    "- One reducer owns deltas, tool cards and completion.",
    "- The scroll container only follows output while the reader is within the bottom zone.",
    "- Cancelling stops the server turn first; the client keeps reading until the terminal event.",
    "",
    "```ts",
    "type Phase = \"idle\" | \"streaming\" | \"cancelling\";",
    "",
    "const next = event.type === \"turn.completed\" ? \"idle\" : phase;",
    "```",
    "",
    "**What I would verify**",
    "",
    "1. Type check and a production build.",
    "2. A disconnect followed by the same turn id does not duplicate the reply.",
    "3. Long output does not steal scroll while the reader is above the fold.",
    "",
    "I can take the first item next.",
  ].join("\n");
}
