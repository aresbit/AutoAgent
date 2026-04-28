#!/usr/bin/env bun
/**
 * Headless JSON-RPC engine for embedding in desktop apps.
 *
 * Protocol (stdin/stdout JSON lines):
 *   REQUEST:  {"id":"uuid","method":"query","params":{...}}
 *   EVENT:    {"id":"uuid","type":"event","event":{...}}
 *   RESPONSE: {"id":"uuid","type":"done","result":{...}}
 *
 * Build: bun build src/entrypoints/headless-engine.ts --outdir dist --target bun
 */

// ---- Runtime polyfill (mirrors cli.tsx) ----
const feature = (_name: string) => false;
(globalThis as any).MACRO = {
  VERSION: '2.1.888', BUILD_TIME: new Date().toISOString(),
  FEEDBACK_CHANNEL: '', ISSUES_EXPLAINER: '',
  NATIVE_PACKAGE_URL: '', PACKAGE_URL: '', VERSION_CHANGELOG: '',
};
(globalThis as any).BUILD_TARGET = 'external';
(globalThis as any).BUILD_ENV = 'production';
process.env.COREPACK_ENABLE_AUTO_PIN = '0';
process.env.ENABLE_TOOL_SEARCH ??= 'true';
process.env.ENABLE_PROMPT_CACHING_1H ??= 'true';

// ---- Imports ----
import { createInterface } from 'node:readline';
import { query } from '../query.js';
import type { QueryParams } from '../query.js';
import { getSystemContext, getUserContext } from '../context.js';
import { getTools } from '../tools.js';
import type { CanUseToolFn } from '../hooks/useCanUseTool.js';
import { asSystemPrompt } from '../utils/systemPromptType.js';
import type { SystemPrompt } from '../utils/systemPromptType.js';
import { getSessionId } from '../bootstrap/state.js';
import { enableConfigs } from '../utils/config.js';
import type { Message } from '../types/message.js';
import type { ToolUseContext } from '../Tool.js';
import { getCwd } from '../utils/cwd.js';

// ---- Types ----
interface HeadlessRequest { id: string; method: string; params: Record<string, unknown>; }

// ---- Helpers ----
function respond(r: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(r) + '\n');
}

// ---- Tool context ----
function buildToolUseContext(cwd?: string): ToolUseContext {
  return {
    cwd: cwd || getCwd(),
    workDir: cwd || getCwd(),
    sessionId: getSessionId(),
    permissionMode: 'bypassPermissions',
    queryTracking: { depth: 0, chain: [] },
    async onToolUse() {},
  } as unknown as ToolUseContext;
}

// ---- System prompt builder ----
async function buildSystemPrompt(appendText?: string): Promise<SystemPrompt> {
  const userCtx = await getUserContext();
  const sysCtx = await getSystemContext();
  const parts: string[] = [];
  if (appendText) parts.push(appendText);
  for (const [key, value] of Object.entries({ ...userCtx, ...sysCtx })) {
    if (value && typeof value === 'string' && value.trim()) {
      parts.push(`<${key}>\n${value}\n</${key}>`);
    }
  }
  return asSystemPrompt(parts.join('\n\n'));
}

// ---- Can-use-tool (always allow for desktop) ----
const canUseTool: CanUseToolFn = async (_t, _i) => ({
  behavior: 'allow' as const,
  updatedInput: _i as Record<string, unknown>,
});

// ---- Handle query ----
async function* handleQuery(params: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
  const maxTurns = (params.maxTurns as number) || 30;
  const cwd = params.cwd as string | undefined;
  const appendSystemPrompt = params.appendSystemPrompt as string | undefined;
  const messages = (params.messages as Message[]) || [];
  const systemPrompt = await buildSystemPrompt(appendSystemPrompt);
  const qp: QueryParams = {
    messages, systemPrompt, userContext: {}, systemContext: {},
    canUseTool, toolUseContext: buildToolUseContext(cwd),
    querySource: 'headless' as any, maxTurns, deps: undefined,
  };
  try {
    for await (const ev of query(qp)) yield { type: 'event', event: ev };
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Main ----
async function main(): Promise<void> {
  enableConfigs();
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: HeadlessRequest;
    try { req = JSON.parse(trimmed); } catch { continue; }
    const { id, method, params } = req;
    try {
      switch (method) {
        case 'query':
          for await (const ev of handleQuery(params || {})) respond({ id, ...ev });
          respond({ id, type: 'done' }); break;
        case 'ping':
          respond({ id, type: 'pong' }); break;
        default:
          respond({ id, type: 'error', error: `Unknown method: ${method}` });
      }
    } catch (err) {
      respond({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
}
main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
