/**
 * Engine client — persistent Claude Code/OpenCC CLI stream-json transport.
 *
 * This intentionally reuses the mature `cli.js -p` Agent SDK path instead of
 * maintaining a separate desktop-only agent loop. The CLI owns tools, MCP,
 * permissions, compaction, partial streaming, and session state.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export interface StreamEvent {
  type: string;
  event?: any;
  error?: string;
}

export interface EngineQueryParams {
  model?: string;
  maxTurns?: number;
  cwd?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  apiKey?: string;
  baseURL?: string;
  providerId?: string;
  apiType?: string;
  allowedTools?: string[];
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

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        if (block?.type === 'tool_result') return extractContentText(block.content);
        if (typeof block?.content === 'string') return block.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && 'text' in (content as any)) return String((content as any).text);
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

  constructor(private readonly enginePath: string) {}

  start(): void {
    if (!existsSync(this.enginePath)) throw new Error(`Engine not found: ${this.enginePath}`);
  }

  async waitReady(): Promise<void> {
    // The stream-json CLI path initializes when the process is spawned for the
    // first query. Keeping this method preserves the desktop caller contract.
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

    this.spawnCliProcess(params);

    const eventQueue: StreamEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let terminal = false;
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
      while (true) {
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
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
      this.listeners.delete(listener);
      proc?.off('close', onClose);
      if (params.signal) params.signal.removeEventListener('abort', onAbort);
      await this.stop();
    }
  }

  private spawnCliProcess(params: EngineQueryParams): void {
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGTERM');

    const bunExe = existsSync(join(dirname(this.enginePath), 'bun')) ? join(dirname(this.enginePath), 'bun') : 'bun';
    const args = [
      this.enginePath,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--model',
      params.model || 'deepseek-v4-pro[1m]',
      '--max-turns',
      String(params.maxTurns || 1024),
      '--permission-mode',
      'bypassPermissions',
    ];
    if (params.resumeSessionId) args.push('--resume', params.resumeSessionId);

    const allowedTools = params.allowedTools?.length ? params.allowedTools : DEFAULT_TOOLS;
    args.push('--allowedTools', allowedTools.join(','));
    if (params.appendSystemPrompt?.trim()) args.push('--append-system-prompt', params.appendSystemPrompt);

    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      CLAUDE_CONFIG_DIR: join(homedir(), '.autoagent'),
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES: '1',
    };
    if (params.apiKey) env.ANTHROPIC_API_KEY = params.apiKey;
    if (params.baseURL) env.ANTHROPIC_BASE_URL = normalizeAnthropicBaseURL(params.baseURL);
    if (params.model) {
      env.ANTHROPIC_MODEL = params.model;
      env.ANTHROPIC_CUSTOM_MODEL_OPTION = params.model;
    }

    this.proc = spawn(bunExe, args, {
      cwd: params.cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.stderrBuffer = '';

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.stderrBuffer += data.toString();
      if (this.stderrBuffer.length > 8192) this.stderrBuffer = this.stderrBuffer.slice(-8192);
      console.error('[engine:cli]', data.toString().trimEnd());
    });

    this.proc.on('close', (code) => {
      console.error(`[engine] cli process exited with code ${code}`);
    });

    const rl = createInterface({ input: this.proc.stdout! });
    void this.readLoop(rl);
    console.error(`[engine] cli stream-json process spawned (pid: ${this.proc.pid})`);
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

export function resolveEnginePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const installed = join(__dirname, 'cli.js');
  if (existsSync(installed)) return installed;
  return join(__dirname, '..', 'packages', 'opencc', 'dist', 'cli.js');
}
