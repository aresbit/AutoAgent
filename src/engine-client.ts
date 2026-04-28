/**
 * Engine client — persistent JSON-RPC connection to cli.js --server.
 *
 * Spawns a single long-running `bun cli.js --server` process on start().
 * Communicates via newline-delimited JSON-RPC over stdio.
 * Each chat conversation maps to a server-side "thread" (QueryEngine instance).
 * Each user message within a thread is a "turn" (agent loop invocation).
 *
 * This replaces the old per-query subprocess model (cli.js -p).
 * Thread state (messages, context, tools, file cache) persists in-memory
 * within the server process across turns.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
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
  apiKey?: string;
  baseURL?: string;
  providerId?: string;
  messages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;
  signal?: AbortSignal;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Extract the last user prompt from messages array. */
function extractPrompt(params: EngineQueryParams): string {
  const msgs = params.messages || [];
  if (msgs.length === 0) return '';
  const last = msgs[msgs.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

export class EngineClient {
  private enginePath: string;
  private proc: ChildProcess | null = null;
  private _ready = false;
  private requestId = 0;
  private pending = new Map<number | string, PendingRequest>();
  private notificationHandlers = new Map<string, Array<(params: any) => void>>();
  private threadId: string | null = null; // single-thread mode (simplified from multi-thread)
  private stderrBuffer = '';
  private shutdownPromise: Promise<void> | null = null;

  constructor(enginePath: string) {
    this.enginePath = enginePath;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Spawn the server process and establish JSON-RPC connection. */
  start(): void {
    if (!existsSync(this.enginePath)) {
      throw new Error(`Engine not found: ${this.enginePath}`);
    }

    // Auto-detect bun: bundled (installed) or system PATH
    const bunExe = existsSync(join(dirname(this.enginePath), 'bun'))
      ? join(dirname(this.enginePath), 'bun')
      : 'bun';

    const args = [this.enginePath, '--server'];

    this.proc = spawn(bunExe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(homedir(), '.autoagent'),
      } as Record<string, string>,
    });

    // Collect stderr for debugging
    this.proc.stderr?.on('data', (data: Buffer) => {
      this.stderrBuffer += data.toString();
      // Keep only last 4KB of stderr
      if (this.stderrBuffer.length > 4096) {
        this.stderrBuffer = this.stderrBuffer.slice(-4096);
      }
      console.error('[engine:server]', data.toString().trimEnd());
    });

    // Handle process exit
    this.proc.on('close', (code) => {
      console.error(`[engine] server process exited with code ${code}`);
      this._ready = false;
      // Reject all pending requests
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`Engine process exited (code ${code})`));
      }
      this.pending.clear();
    });

    // Read JSON-RPC responses and notifications from stdout
    const rl = createInterface({ input: this.proc.stdout! });
    void this.readLoop(rl);

    console.error('[engine] server process spawned (pid: ' + this.proc.pid + ')');
  }

  /** Wait for handshake to complete. */
  async waitReady(): Promise<void> {
    if (this._ready) return;

    await this.call('initialize', {
      clientInfo: {
        name: 'AutoAgentDesktop',
        title: 'AutoAgent Desktop',
        version: '0.2.0',
      },
    });

    // Send initialized notification (no id = notification)
    this.sendNotification('initialized', {});

    this._ready = true;
    console.error('[engine] server handshake complete');
  }

  /** Gracefully shut down the engine process. */
  async stop(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;

    try {
      await this.call('shutdown', {});
    } catch {
      // Force kill if graceful shutdown fails
    }

    this._ready = false;
    this.proc.kill('SIGTERM');

    // Force kill after 2s
    setTimeout(() => {
      try {
        this.proc?.kill('SIGKILL');
      } catch {}
    }, 2000);
  }

  // ==========================================================================
  // Thread API
  // ==========================================================================

  /** Create or get the active thread. Returns threadId. */
  async ensureThread(params: EngineQueryParams): Promise<string> {
    if (this.threadId) return this.threadId; // reuse existing thread for multi-turn

    const result = (await this.call('thread/start', {
      model: params.model || 'claude-sonnet-4-6',
      cwd: params.cwd || process.cwd(),
      maxTurns: params.maxTurns || 10,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
      appendSystemPrompt: params.appendSystemPrompt || '',
      apiKey: params.apiKey || '',
      baseURL: params.baseURL || '',
      providerId: params.providerId || 'anthropic',
    })) as { thread: { id: string } };

    this.threadId = result.thread.id;
    return this.threadId;
  }

  // ==========================================================================
  // Query API (backward-compatible with old StreamEvent interface)
  // ==========================================================================

  /**
   * Run a query against the persistent engine.
   *
   * On first call, creates a thread. Subsequent calls on the same EngineClient
   * reuse the thread for multi-turn conversation (context persists).
   *
   * Pass `signal` to abort a running turn via `turn/interrupt`.
   */
  async *query(params: EngineQueryParams): AsyncGenerator<StreamEvent> {
    if (!this._ready) {
      throw new Error('Engine not ready — call waitReady() first');
    }

    const prompt = extractPrompt(params);
    if (!prompt.trim()) {
      throw new Error('Empty prompt');
    }

    const threadId = await this.ensureThread(params);

    // Set up abort handler
    const onAbort = () => {
      void this.call('turn/interrupt', { threadId }).catch(() => {});
    };
    if (params.signal) {
      if (params.signal.aborted) {
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Buffer for streaming deltas
    const eventQueue: StreamEvent[] = [];
    let resolveNext: (() => void) | null = null;

    // Subscribe to notifications for this turn
    const unsub = this.onNotification((method, nparams) => {
      if (nparams?.threadId !== threadId) return; // ignore other threads

      switch (method) {
        case 'turn/started':
          eventQueue.push({ type: 'turn_started', event: nparams });
          break;

        case 'item/started':
          eventQueue.push({
            type: nparams?.item?.type === 'agentMessage' ? 'assistant' : 'tool_start',
            event: nparams,
          });
          break;

        case 'item/agentMessage/delta':
          eventQueue.push({ type: 'text_delta', event: nparams });
          break;

        case 'item/completed':
          eventQueue.push({
            type: nparams?.item?.type === 'agentMessage' ? 'assistant' : 'tool_result',
            event: nparams,
          });
          break;

        case 'turn/completed': {
          const turn = nparams?.turn as any;
          if (turn?.status === 'completed') {
            eventQueue.push({ type: 'result', event: nparams });
          } else if (turn?.status === 'interrupted') {
            eventQueue.push({ type: 'interrupted', event: nparams });
          } else if (turn?.status === 'failed') {
            eventQueue.push({
              type: 'error',
              error: turn?.error?.message || 'Turn failed',
              event: nparams,
            });
          }
          break;
        }

        case 'thread/status/changed':
          // Internal state change — not forwarded
          break;

        default:
          // Forward unknown notifications as generic events
          eventQueue.push({ type: method, event: nparams });
      }

      resolveNext?.();
    });

    try {
      // Fire turn/start — server sends acknowledgment + begins async agent loop
      await this.call('turn/start', {
        threadId,
        input: prompt,
      });

      // Yield events as they arrive
      while (true) {
        // Drain buffered events
        while (eventQueue.length > 0) {
          const ev = eventQueue.shift()!;

          // Check for terminal events
          if (ev.type === 'result' || ev.type === 'interrupted' || ev.type === 'error') {
            yield ev;
            return;
          }
          yield ev;
        }

        // Wait for more events
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });

        // Check if we got a terminal event after resolve
        if (eventQueue.length === 0) continue;
      }
    } finally {
      unsub();
      if (params.signal) {
        params.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  // ==========================================================================
  // JSON-RPC Transport
  // ==========================================================================

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc?.stdin) {
      throw new Error('Engine process not running');
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const payload = JSON.stringify({ id, method, params }) + '\n';
      this.proc!.stdin!.write(payload);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private async readLoop(rl: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: JsonRpcResponse | JsonRpcNotification;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if ('id' in msg && msg.id !== undefined && msg.id !== null) {
          // Response to a pending request
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if ('error' in msg && msg.error) {
              pending.reject(new Error(msg.error.message || 'JSON-RPC error'));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if ('method' in msg) {
          // Notification — dispatch to handlers
          const handlers = this.notificationHandlers.get(msg.method);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(msg.params);
              } catch (err) {
                console.error('[engine] notification handler error:', err);
              }
            }
          }
        }
      }
    } catch (err) {
      if (!this.shutdownPromise) {
        console.error('[engine] read loop error:', err);
      }
    }
  }

  private onNotification(handler: (method: string, params: any) => void): () => void {
    // Register a wildcard handler for turn-specific notifications
    const wrapper = (params: any) => {
      // We need the method name — store last method
      // Actually, we can't get the method from the wrapper directly.
      // Instead, we register per-method handlers internally.
    };

    // Better approach: register handler for each notification method we care about
    const methods = [
      'turn/started', 'turn/completed',
      'item/started', 'item/completed',
      'item/agentMessage/delta', 'item/commandExecution/outputDelta',
      'thread/status/changed', 'thread/started',
    ];

    const handlers = new Map<string, (params: any) => void>();
    for (const method of methods) {
      const h = (params: any) => handler(method, params);
      handlers.set(method, h);
      this.addNotificationHandler(method, h);
    }

    return () => {
      for (const [method, h] of handlers) {
        this.removeNotificationHandler(method, h);
      }
    };
  }

  private addNotificationHandler(method: string, handler: (params: any) => void): void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = [];
      this.notificationHandlers.set(method, handlers);
    }
    handlers.push(handler);
  }

  private removeNotificationHandler(method: string, handler: (params: any) => void): void {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }
}

/** Resolve the path to the cli.js bundle. */
export function resolveEnginePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // Installed: /usr/lib/autoagent/cli.js (same dir as main.js)
  const installed = join(__dirname, 'cli.js');
  if (existsSync(installed)) return installed;
  // Dev: packages/opencc/dist/cli.js
  return join(__dirname, '..', 'packages', 'opencc', 'dist', 'cli.js');
}
