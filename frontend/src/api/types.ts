export type PermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions";
export type ThinkingMode = "" | "adaptive" | "enabled" | "disabled";
export type Effort = "" | "low" | "medium" | "high" | "max";
export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface LayoutView {
  leftOpen: boolean;
  leftWidth: number;
  rightOpen: boolean;
  rightWidth: number;
}

export type EngineModelSource =
  | "override"
  | "claude-settings"
  | "env"
  | "autoagent"
  | "default";

export interface EngineProfileView {
  preset: "bundled" | "custom" | "matebot";
  version: string | null;
  mode?: string | null;
  cli?: string | null;
  model?: string | null;
  modelSource?: EngineModelSource;
  configPath?: string | null;
}

export interface SettingsView {
  providerId: string;
  model: string;
  fallbackModel: string | null;
  baseURL: string | null;
  apiKeyConfigured: boolean;
  cwd: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  effort: Effort;
  maxThinkingTokens: number | null;
  maxTurns: number;
  maxBudgetUsd: number | null;
  taskBudget: number | null;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  appendSystemPrompt: string;
  layout: LayoutView;
  engine: EngineProfileView;
}

export interface SettingsPatch {
  providerId?: string;
  model?: string;
  fallbackModel?: string | null;
  baseURL?: string | null;
  apiKey?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  effort?: Effort;
  maxThinkingTokens?: number | null;
  maxTurns?: number;
  maxBudgetUsd?: number | null;
  taskBudget?: number | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  appendSystemPrompt?: string;
  layout?: LayoutView;
}

export interface ProviderView {
  id: string;
  name: string;
  apiType: "anthropic-messages" | "codex-completions" | null;
  baseURL: string | null;
  models: string[];
  allowCustomModels: boolean;
}

export interface ProviderCatalogView {
  builtin: ProviderView[];
  custom: ProviderView[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface MessageView {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  meta: Record<string, unknown> | null;
}

export interface SessionView {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: MessageView[];
}

export interface TurnRequest {
  sessionId: string;
  text: string;
  overrides?: SettingsPatch | null;
}

export interface TurnStatusView {
  turnId: string;
  sessionId: string;
  state: "running" | "completed" | "cancelled" | "failed";
  stopReason: "end_turn" | "max_turns" | "cancelled" | null;
  assistantMessageId: string | null;
  error: string | null;
}

export type EngineState = "idle" | "starting" | "busy" | "error";

export interface EngineStatusView {
  state: EngineState;
  mode: "local" | "matebot";
  activeTurns: number;
  version: string | null;
  lastError: string | null;
}

export interface EngineConfigView {
  configPath: string;
  model: string;
  baseURL: string | null;
  apiKeyConfigured: boolean;
  apiKeyHelper: string | null;
  engine: Record<string, unknown>;
}

export interface EngineConfigPatch {
  model?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyHelper?: string;
}

export interface SkillView {
  name: string;
  description: string;
  source: "system" | "project";
  enabled: boolean;
  path?: string | null;
}

export interface SkillDirView {
  path: string;
  source: "system" | "project";
  exists: boolean;
}

export interface SkillCatalogView {
  skills: SkillView[];
  dirs: SkillDirView[];
}

export interface SkillDiscoveryItem {
  id: string;
  name: string;
  path: string;
  description?: string;
}

export interface SkillDiscoverResponse {
  items: SkillDiscoveryItem[];
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  target: string;
  enabled: boolean;
  autoRun: boolean;
  toolCount: number | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  autoRun: boolean;
}

export interface McpToolView {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

export interface McpDiscoveryResult {
  id: string;
  name: string;
  displayId?: string;
  status: string;
  durationMs: number;
  tools: McpToolView[];
  error?: string | null;
}

export interface McpDiscoverResponse {
  results: McpDiscoveryResult[];
}

export interface McpToolInvokeRequest {
  server?: string | null;
  tool: string;
  args: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolInvokeResult {
  content?: McpContentBlock[];
  isError?: boolean;
  error?: string | null;
  [key: string]: unknown;
}

export interface ArtifactVersionView {
  versionId: string;
  createdAt: number;
  sha256: string;
  sizeBytes: number | null;
  current: boolean;
  source?: string;
  immutable?: boolean;
}

export interface ArtifactView {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  versions: number[];
  contentUrl: string;
  thumbnailUrl: string | null;
  kind?: string;
  sessionId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
  revision?: string;
  versionCount?: number;
  sizeBytes?: number;
  versionRefs?: ArtifactVersionView[];
}

/** A short-lived URL for the backend-served artifact frame document. */
export interface FrameTokenView {
  url: string;
  expiresAt: number;
}

export interface ArtifactCreateInput {
  title?: string;
  description?: string;
  html: string;
}

export interface ArtifactExportResponse {
  path: string;
}

export interface BranchView {
  name: string;
  isRemote: boolean;
  current?: boolean;
}

export interface ChangedFileView {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed" | "copied" | "type_changed" | "unknown";
  additions: number;
  deletions: number;
}

export interface FileDiffView {
  path: string;
  patch: string;
  original: string | null;
  current: string | null;
}

export interface WorkspaceStatusView {
  workDir: string;
  isGitRepo: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  branches: BranchView[];
  files: ChangedFileView[];
  warnings: string[];
}

export interface BootstrapView {
  apiVersion: "1";
  settings: SettingsView;
  providers: ProviderCatalogView;
  sessions: SessionSummary[];
  mcpServers: McpServerView[];
  skills: SkillView[];
  artifacts: ArtifactView[];
  workspace: WorkspaceStatusView;
  engine: EngineStatusView;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface TurnEventBase {
  turnId: string;
  sessionId: string;
  seq: number;
  ts: number;
}

export type TurnStreamEvent =
  | (TurnEventBase & { type: "turn.started"; model?: string })
  | (TurnEventBase & {
      type: "message.delta";
      channel: "text" | "thinking";
      text: string;
    })
  | (TurnEventBase & {
      type: "message.completed";
      messageId: string;
      text: string;
    })
  | (TurnEventBase & {
      type: "tool.start";
      tool: { ref: string; name?: string; input?: Record<string, unknown> };
    })
  | (TurnEventBase & {
      type: "tool.result";
      tool: { ref: string; name?: string; ok: boolean };
      text?: string;
    })
  | (TurnEventBase & {
      type: "usage";
      usage: { inputTokens?: number; outputTokens?: number };
    })
  | (TurnEventBase & {
      type: "turn.completed";
      stopReason: "end_turn" | "max_turns" | "cancelled";
    })
  | (TurnEventBase & {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
    });

export interface ApiErrorShape {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
}

export interface LiveTool {
  ref: string;
  name?: string;
  input?: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result?: string;
}
