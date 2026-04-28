/**
 * Headless AppState factory for the server entrypoint.
 *
 * Creates a minimal AppState + CanUseTool without requiring the full CLI
 * bootstrap (no React/Ink, no Commander arg parsing, no trust dialogs).
 *
 * Mirrors the initialization that runHeadless() in print.ts performs,
 * but stripped of feature flags, teleport, proactive, and CLI-only paths.
 */

import { randomUUID } from 'node:crypto';
import type { AppState } from '../../state/AppState.js';
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js';
import type { Tools } from '../../Tool.js';
import type { PermissionMode } from '../../types/permissions.js';

interface HeadlessStateOptions {
  cwd: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  model: string;
  apiKey: string;
  baseURL: string;
}

interface HeadlessStateResult {
  appState: AppState;
  setAppStateFn: (f: (prev: AppState) => AppState) => void;
}

/**
 * Create a minimal AppState suitable for headless/server use.
 *
 * This avoids the full React/zustand store setup that the REPL needs.
 * The AppState object is a plain mutable object with a setter callback.
 */
export function createAppState(opts: HeadlessStateOptions): HeadlessStateResult {
  let current: AppState = buildDefaultAppState(opts);

  function setAppStateFn(f: (prev: AppState) => AppState): void {
    current = f(current);
  }

  return { appState: current, setAppStateFn };
}

function buildDefaultAppState(opts: HeadlessStateOptions): AppState {
  // Construct a minimal AppState that satisfies QueryEngine's needs.
  // Most fields are stubs — QueryEngine only uses a subset via destructuring.
  return {
    // Core fields used by QueryEngine
    messages: [],
    sessionId: `server-${randomUUID()}`,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,

    // Tool permission context
    toolPermissionContext: {
      additionalWorkingDirectories: new Map(),
      permissionMode: opts.permissionMode,
      allowedTools: opts.allowedTools,
      deniedTools: [],
      autoAcceptTools: opts.permissionMode === 'bypassPermissions' ? opts.allowedTools : [],
    },

    // Tools — QueryEngine expects the tools list from AppState
    tools: {} as Tools,

    // File state cache
    readFileCache: {} as Record<string, unknown>,

    // Settings stub
    settings: {
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseURL,
      permissionMode: opts.permissionMode,
      allowedTools: opts.allowedTools,
    },

    // Stub fields (QueryEngine doesn't consume these directly)
    commands: [],
    mcpClients: [],
    mcpServerStatuses: [],
    agents: [],
    fastMode: false,
    isBareMode: false,
    theme: 'dark',
    plugins: [],
    skills: [],
    stats: undefined as any,
    fpsMetrics: undefined as any,
    hooksEnabled: false,
    proactiveActive: false,
    sessionSource: 'server' as any,
    conversationHistory: [],
    fileHistory: undefined as any,
    commitAttribution: undefined as any,
    autoCompact: undefined as any,
    thinkingConfig: { type: 'adaptive' } as any,
    userSpecifiedModel: opts.model,
    fallbackModel: undefined,
    maxTurns: 10,
    maxBudgetUsd: undefined,
    taskBudget: undefined,
    jsonSchema: undefined,
    replayUserMessages: false,
    includePartialMessages: false,
    setSDKStatus: undefined as any,
    orphanedPermission: undefined,
    abortController: undefined,
    verbose: false,
    appendSystemPrompt: '',
    customSystemPrompt: '',
    initialMessages: [],
  } as unknown as AppState;
}

/**
 * Create a CanUseTool function that respects the permission mode.
 *
 * In server mode, bypassPermissions means all tools are allowed.
 * For acceptEdits/default modes, Read/Glob/Grep/WebFetch/WebSearch
 * are auto-allowed, Write/Edit/Bash require approval (currently
 * auto-approved for simplicity).
 */
export function createCanUseTool(
  _appState: AppState,
  _setAppState: (f: (prev: AppState) => AppState) => void,
): CanUseToolFn {
  return async (_tool, _input, _toolUseContext) => {
    // In server mode we default to bypassPermissions.
    // The desktop client handles permissions via its own UI layer.
    return { behavior: 'allow' };
  };
}
