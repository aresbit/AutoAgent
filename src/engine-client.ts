/**
 * Engine client - persistent Claude Code CLI stream-json transport.
 *
 * This intentionally reuses Claude Code's `claude -p` stream-json pathway
 * instead of maintaining a separate desktop-only agent loop. The CLI owns
 * tools, MCP, permissions, compaction, partial streaming, and session state.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveRipgrepBinaryPath } from './runtime-paths.js';

const LOG_FILE = join(tmpdir(), 'autoagent-userdata', 'engine.log');

function ensureLogDir(): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
  } catch {}
}

function logToFile(...args: unknown[]): void {
  try {
    ensureLogDir();
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const line = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
    appendFileSync(LOG_FILE, `[${ts}] ${line}\n`);
  } catch {}
}

function resolveSpawnCwd(cwd?: string): string {
  if (cwd && existsSync(cwd)) return cwd;
  return process.cwd();
}

function tokenizeCliArgs(value?: string): string[] {
  if (!value?.trim()) return [];
  const matches = value.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g) || [];
  return matches.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function splitCommand(command?: string): { executable: string; args: string[] } {
  const tokens = tokenizeCliArgs(command);
  return {
    executable: tokens[0] || 'opencc',
    args: tokens.slice(1),
  };
}

function shouldSpawnViaShell(executable: string): boolean {
  if (process.platform !== 'win32') return false;
  return /\.(bat|cmd)$/i.test(executable);
}

function buildSpawnCommand(
  split: { executable: string; args: string[] },
  args: string[],
): { command: string; args: string[]; shell: boolean } {
  if (!shouldSpawnViaShell(split.executable)) {
    return {
      command: split.executable,
      args: [...split.args, ...args],
      shell: false,
    };
  }

  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/c', split.executable, ...split.args, ...args],
    shell: false,
  };
}

const supportedFlagsCache = new Map<string, Set<string>>();

function pushOption(args: string[], flag: string, value?: string | number | null): void {
  if (value === undefined || value === null || value === '') return;
  args.push(flag, String(value));
}

function pushListOption(args: string[], flag: string, values?: string[]): void {
  if (!values?.length) return;
  args.push(flag, values.join(','));
}

function parseSupportedFlags(helpText: string): Set<string> {
  const supported = new Set<string>();
  for (const line of helpText.split(/\r?\n/)) {
    const matches = line.match(/--[a-zA-Z0-9][a-zA-Z0-9-]*/g);
    if (!matches) continue;
    for (const flag of matches) supported.add(flag);
  }
  return supported;
}

async function detectSupportedFlags(split: { executable: string; args: string[] }, cwd?: string): Promise<Set<string> | null> {
  const cacheKey = [split.executable, ...split.args].join('\u0000');
  const cached = supportedFlagsCache.get(cacheKey);
  if (cached) return cached;

  const spawnCommand = buildSpawnCommand(split, ['--help']);

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: resolveSpawnCwd(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: spawnCommand.shell,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', () => resolve({ code: null, stdout, stderr }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (!text) {
    logToFile('flag detection failed: empty help output for', split.executable);
    return null;
  }

  const parsed = parseSupportedFlags(text);
  supportedFlagsCache.set(cacheKey, parsed);
  logToFile('detected supported flags count=', parsed.size, 'for', split.executable);
  return parsed;
}

function pushSupportedOption(args: string[], supportedFlags: Set<string> | null, flag: string, value?: string | number | null): void {
  if (supportedFlags && !supportedFlags.has(flag)) return;
  pushOption(args, flag, value);
}

function pushSupportedListOption(args: string[], supportedFlags: Set<string> | null, flag: string, values?: string[]): void {
  if (supportedFlags && !supportedFlags.has(flag)) return;
  pushListOption(args, flag, values);
}

function pushSupportedBoolean(args: string[], supportedFlags: Set<string> | null, flag: string, enabled?: boolean): void {
  if (!enabled) return;
  if (supportedFlags && !supportedFlags.has(flag)) return;
  args.push(flag);
}

function resolveFallbackModel(params: EngineQueryParams): string | undefined {
  const fallback = params.fallbackModel?.trim();
  const model = params.model?.trim();
  if (!fallback) return undefined;
  if (model && fallback === model) return undefined;
  return fallback;
}

export interface StreamEvent {
  type: string;
  event?: any;
  error?: string;
}

export interface EngineQueryParams {
  claudeCommand?: string;
  claudeConfigDir?: string;
  model?: string;
  fallbackModel?: string;
  agentName?: string;
  thinkingMode?: string;
  maxThinkingTokens?: number | null;
  thinkingDisplay?: string;
  effort?: string;
  maxBudgetUsd?: number | null;
  taskBudget?: number | null;
  maxTurns?: number;
  cwd?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  resumeSessionAt?: string;
  sessionId?: string;
  continueSession?: boolean;
  forkSession?: boolean;
  noSessionPersistence?: boolean;
  apiKey?: string;
  baseURL?: string;
  providerId?: string;
  apiType?: string;
  permissionMode?: string;
  permissionPromptTool?: string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string;
  betas?: string[];
  jsonSchema?: string;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  settingSources?: string;
  addDirs?: string[];
  pluginDir?: string;
  managedSettings?: string;
  channels?: string[];
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  assistant?: boolean;
  debug?: boolean;
  debugFile?: string;
  verbose?: boolean;
  extraCliArgs?: string;
  messages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;
  signal?: AbortSignal;
}

type Listener = (message: any) => void;

const DEFAULT_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'];

function extractPrompt(params: EngineQueryParams): string {
  const msgs = params.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

function mapCliMessage(message: any): StreamEvent | null {
  if (!message || typeof message !== 'object') return null;

  if (message.type === 'stream_event') {
    const event = message.event;
    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      return { type: 'tool_start', event, error: undefined };
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return { type: 'text_delta', event: { ...message, delta: event.delta.text || '' } };
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      return { type: 'text_delta', event: { ...message, delta: event.delta.thinking || '' } };
    }
    return { type: 'stream_event', event: message };
  }

  if (message.type === 'assistant') {
    return { type: 'assistant', event: message };
  }

  if (message.type === 'user') {
    const content = message.content ?? message.message?.content;
    if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) {
      return { type: 'tool_result', event: message };
    }
    return { type: 'user', event: message };
  }

  if (message.type === 'result') {
    if (message.is_error) return { type: 'error', error: String(message.result || message.subtype || 'Agent failed'), event: message };
    return { type: 'result', event: message };
  }

  if (message.type === 'system' && message.subtype === 'error') {
    return { type: 'error', error: String(message.message || message.error || 'System error'), event: message };
  }

  return { type: message.type, event: message };
}

export class EngineClient {
  private proc: ChildProcess | null = null;
  private listeners = new Set<Listener>();
  private stderrBuffer = '';
  private _onSpawnError: ((err: Error) => void) | null = null;

  start(): void {
    // PATH-based command resolution happens at spawn time.
  }

  async waitReady(): Promise<void> {
    // The stream-json path initializes when the process is spawned for a query.
  }

  async stop(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        this.proc?.kill('SIGKILL');
      } catch {}
    }, 2000).unref();
  }

  async *query(params: EngineQueryParams): AsyncGenerator<StreamEvent> {
    const prompt = extractPrompt(params);
    if (!prompt.trim()) throw new Error('Empty prompt');

    logToFile('query() called, prompt_len=', prompt.length, 'resumeSessionId=', params.resumeSessionId || 'none');
    logToFile('model=', params.model, 'maxTurns=', params.maxTurns);

    const eventQueue: StreamEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let terminal = false;

    const prevHandler = this._onSpawnError;
    this._onSpawnError = (err) => {
      eventQueue.push({ type: 'error', error: `Engine spawn failed: ${err.message}` });
      terminal = true;
      resolveNext?.();
    };

    await this.spawnCliProcess(params);
    this._onSpawnError = prevHandler;

    let sawResult = false;
    const proc = this.proc;

    const listener: Listener = (message) => {
      this.handleControlRequest(message);
      const mapped = mapCliMessage(message);
      if (!mapped) return;
      eventQueue.push(mapped);
      if (mapped.type === 'result') sawResult = true;
      if (mapped.type === 'result' || mapped.type === 'error' || mapped.type === 'interrupted') terminal = true;
      resolveNext?.();
    };
    this.listeners.add(listener);

    const onClose = (code: number | null) => {
      if (sawResult || terminal) return;
      eventQueue.push({ type: 'error', error: `Engine process exited before result (code ${code ?? 'unknown'})` });
      terminal = true;
      resolveNext?.();
    };
    proc?.once('close', onClose);

    const onAbort = () => {
      eventQueue.push({ type: 'interrupted', event: { aborted: true } });
      terminal = true;
      this.proc?.kill('SIGINT');
      resolveNext?.();
    };

    if (params.signal) {
      if (params.signal.aborted) return;
      params.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      this.writeUserMessage(prompt);
      this.proc?.stdin?.end();
      logToFile('User message written, stdin closed');
      while (true) {
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          if (event.type !== 'text_delta') logToFile('yield event type=', event.type);
          yield event;
          if (event.type === 'result' || event.type === 'error' || event.type === 'interrupted') return;
        }
        if (terminal) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        resolveNext = null;
      }
    } finally {
      logToFile('query() finally block - cleaning up');
      this.listeners.delete(listener);
      proc?.off('close', onClose);
      if (params.signal) params.signal.removeEventListener('abort', onAbort);
      await this.stop();
    }
  }

  private async spawnCliProcess(params: EngineQueryParams): Promise<void> {
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGTERM');

    const split = splitCommand(params.claudeCommand);
    const supportedFlags = await detectSupportedFlags(split, params.cwd);
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ];

    pushSupportedBoolean(args, supportedFlags, '--verbose', params.verbose !== false);
    pushSupportedBoolean(args, supportedFlags, '--include-partial-messages', params.includePartialMessages !== false);
    pushSupportedBoolean(args, supportedFlags, '--include-hook-events', params.includeHookEvents);
    pushSupportedBoolean(args, supportedFlags, '--debug', params.debug);

    pushSupportedOption(args, supportedFlags, '--debug-file', params.debugFile);
    pushSupportedOption(args, supportedFlags, '--thinking', params.thinkingMode);
    pushSupportedOption(args, supportedFlags, '--max-thinking-tokens', params.maxThinkingTokens);
    pushSupportedOption(args, supportedFlags, '--thinking-display', params.thinkingDisplay);
    pushSupportedOption(args, supportedFlags, '--effort', params.effort);
    pushSupportedOption(args, supportedFlags, '--max-budget-usd', params.maxBudgetUsd);
    pushSupportedOption(args, supportedFlags, '--task-budget', params.taskBudget);
    pushSupportedOption(args, supportedFlags, '--model', params.model || 'sonnet');
    pushSupportedOption(args, supportedFlags, '--fallback-model', resolveFallbackModel(params));
    pushSupportedOption(args, supportedFlags, '--agent', params.agentName);
    pushSupportedOption(args, supportedFlags, '--max-turns', params.maxTurns || 1024);
    pushSupportedOption(args, supportedFlags, '--json-schema', params.jsonSchema);
    pushSupportedOption(args, supportedFlags, '--permission-mode', params.permissionMode || 'default');
    pushSupportedOption(args, supportedFlags, '--permission-prompt-tool', params.permissionPromptTool);

    pushSupportedBoolean(args, supportedFlags, '--dangerously-skip-permissions', params.permissionMode === 'bypassPermissions');
    pushSupportedBoolean(args, supportedFlags, '--allow-dangerously-skip-permissions', params.allowDangerouslySkipPermissions);

    pushSupportedListOption(args, supportedFlags, '--allowedTools', params.allowedTools?.length ? params.allowedTools : DEFAULT_TOOLS);
    pushSupportedListOption(args, supportedFlags, '--disallowedTools', params.disallowedTools);
    pushSupportedOption(args, supportedFlags, '--tools', params.tools);
    pushSupportedListOption(args, supportedFlags, '--betas', params.betas);
    pushSupportedListOption(args, supportedFlags, '--mcp-config', params.mcpConfig);
    pushSupportedOption(args, supportedFlags, '--setting-sources', params.settingSources);
    pushSupportedListOption(args, supportedFlags, '--add-dir', params.addDirs);
    pushSupportedOption(args, supportedFlags, '--plugin-dir', params.pluginDir);
    pushSupportedOption(args, supportedFlags, '--managed-settings', params.managedSettings);
    pushSupportedListOption(args, supportedFlags, '--channels', params.channels);
    pushSupportedOption(args, supportedFlags, '--session-id', params.sessionId);
    pushSupportedBoolean(args, supportedFlags, '--fork-session', params.forkSession);
    pushSupportedBoolean(args, supportedFlags, '--continue', params.continueSession && !params.resumeSessionId);
    pushSupportedOption(args, supportedFlags, '--resume', params.resumeSessionId);
    pushSupportedOption(args, supportedFlags, '--resume-session-at', params.resumeSessionAt);
    pushSupportedBoolean(args, supportedFlags, '--no-session-persistence', params.noSessionPersistence);
    pushSupportedBoolean(args, supportedFlags, '--strict-mcp-config', params.strictMcpConfig);
    pushSupportedBoolean(args, supportedFlags, '--assistant', params.assistant);
    args.push(...tokenizeCliArgs(params.extraCliArgs));

    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES: '1',
      CLAUDE_CONFIG_DIR: params.claudeConfigDir?.trim() || join(homedir(), '.autoagent'),
    };
    const bundledRipgrep = resolveRipgrepBinaryPath();
    if (bundledRipgrep) env.AUTOAGENT_RG_PATH = bundledRipgrep;
    if (params.apiKey) env.ANTHROPIC_API_KEY = params.apiKey;
    if (params.baseURL) env.ANTHROPIC_BASE_URL = normalizeAnthropicBaseURL(params.baseURL);
    if (params.model) {
      env.ANTHROPIC_MODEL = params.model;
      env.ANTHROPIC_CUSTOM_MODEL_OPTION = params.model;
    }

    const spawnCommand = buildSpawnCommand(split, args);

    this.proc = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: resolveSpawnCwd(params.cwd),
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: spawnCommand.shell,
    });
    this.stderrBuffer = '';

    logToFile('Spawning opencc command=', split.executable);
    logToFile('CLAUDE_CONFIG_DIR=', env.CLAUDE_CONFIG_DIR);
    logToFile('ANTHROPIC_API_KEY set=', !!env.ANTHROPIC_API_KEY, 'len=', (env.ANTHROPIC_API_KEY || '').length);
    logToFile('ANTHROPIC_BASE_URL=', env.ANTHROPIC_BASE_URL);
    logToFile('spawnCommand=', spawnCommand.command);
    logToFile('spawnShell=', spawnCommand.shell);
    logToFile('spawnArgs=', spawnCommand.args);
    logToFile('supportedFlagsDetected=', supportedFlags ? [...supportedFlags].sort().join(',') : 'unknown');
    logToFile('args=', args);
    logToFile('CWD=', resolveSpawnCwd(params.cwd));
    console.error(`[engine] Spawning: ${spawnCommand.command} ${spawnCommand.args.join(' ')}`);

    this.proc.on('error', (err: Error) => {
      console.error(`[engine] Process spawn error: ${err.message}`);
      logToFile('Process spawn error:', err.message);
      this._onSpawnError?.(err);
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > 8192) this.stderrBuffer = this.stderrBuffer.slice(-8192);
      console.error('[engine:cli]', text.trimEnd());
      logToFile('[stderr]', text.trimEnd());
    });

    this.proc.on('close', (code) => {
      console.error(`[engine] cli process exited with code ${code}`);
      logToFile('cli process exited with code', code);
    });

    const rl = createInterface({ input: this.proc.stdout! });
    void this.readLoop(rl);
    console.error(`[engine] claude stream-json process spawned (pid: ${this.proc.pid})`);
    logToFile('claude stream-json process spawned (pid:', this.proc.pid, ')');
    this.writeInitializeRequest(params);
  }

  private writeUserMessage(prompt: string): void {
    if (!this.proc?.stdin) throw new Error('Engine process not running');
    const uuid = crypto.randomUUID();
    this.proc.stdin.write(JSON.stringify({
      type: 'user',
      content: prompt,
      uuid,
      session_id: '',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    }) + '\n');
  }

  private writeInitializeRequest(params: EngineQueryParams): void {
    if (!this.proc?.stdin) throw new Error('Engine process not running');
    const appendSystemPrompt = params.appendSystemPrompt?.trim();
    if (!appendSystemPrompt) return;
    const requestId = crypto.randomUUID();
    this.proc.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'initialize',
        appendSystemPrompt,
      },
    }) + '\n');
    logToFile('Initialize request written, appendSystemPrompt_len=', appendSystemPrompt.length);
  }

  private handleControlRequest(message: any): void {
    if (message?.type !== 'control_request' || !this.proc?.stdin) return;
    if (message.request?.subtype !== 'can_use_tool') return;
    this.proc.stdin.write(JSON.stringify({
      type: 'control_response',
      response: {
        request_id: message.request_id,
        subtype: 'success',
        response: {
          behavior: 'allow',
          updatedInput: message.request.input,
          toolUseID: message.request.tool_use_id,
        },
      },
    }) + '\n');
  }

  private async readLoop(lines: AsyncIterable<string>): Promise<void> {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed);
        for (const listener of this.listeners) listener(message);
      } catch {
        console.error('[engine] ignored non-json stdout:', trimmed.slice(0, 200));
      }
    }
  }
}

function normalizeAnthropicBaseURL(baseURL: string): string {
  return baseURL.replace(/\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '');
}
