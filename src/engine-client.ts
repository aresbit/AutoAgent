/**
 * Headless-engine client — spawns the opencc headless engine as a child
 * process and communicates via JSON-RPC over stdin/stdout (JSON lines).
 *
 * The engine is started once at app launch and reused for all queries.
 * This is the same architecture Claude Code Desktop uses.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  messages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;
}

export interface EngineToolResult {
  name: string;
  description: string;
  inputSchema: unknown;
}

export class EngineClient {
  private proc: ChildProcess | null = null;
  private enginePath: string;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  private rl: ReturnType<typeof createInterface> | null = null;
  private ready: Promise<void>;
  private _resolveReady!: () => void;

  constructor(enginePath: string) {
    this.enginePath = enginePath;
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
  }

  /** Start the engine subprocess. Call once at app startup. */
  start(): void {
    if (this.proc) return;

    // Spawn with bun
    this.proc = spawn('bun', [this.enginePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RED_TEAM_MODE: '0',
        RTM: '0',
        INTERFACE_TYPE: 'stdio',
        // Forward API keys
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      },
    });

    this.rl = createInterface({ input: this.proc.stdout! });

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Skip red team banner lines
      if (trimmed.startsWith('=') || trimmed.includes('🔴') || trimmed.includes('RED TEAM')) {
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      const pending = this.pending.get(msg.id);
      if (!pending) return;

      if (msg.type === 'done' || msg.type === 'error' || msg.type === 'result') {
        // Final response — resolve the promise
        this.pending.delete(msg.id);
        if (msg.type === 'error') {
          pending.reject(new Error(msg.error || 'Unknown engine error'));
        } else {
          pending.resolve(msg);
        }
      } else {
        // Intermediate event — resolve with the event, keep promise open
        // The caller reads events from an async iterator
        pending.resolve(msg);
      }
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text && !text.startsWith('=') && !text.includes('🔴')) {
        console.error('[engine]', text);
      }
    });

    this.proc.on('exit', (code: number | null) => {
      console.error(`[engine] exited with code ${code}`);
      this.proc = null;
      // Reject all pending
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Engine exited with code ${code}`));
        this.pending.delete(id);
      }
    });

    this._resolveReady();
  }

  /** Wait for engine to be ready */
  async waitReady(): Promise<void> {
    return this.ready;
  }

  /** Send a JSON-RPC request and get a single response */
  private async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.ready;
    if (!this.proc) throw new Error('Engine not started');

    const id = crypto.randomUUID();
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(payload);
      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Engine request ${method} timed out`));
        }
      }, 300_000);
    });
  }

  /**
   * Run an agent query and yield stream events.
   *
   * Because the engine sends one JSON line per event, and our request()
   * resolves for each event, we use a pull-based loop:
   * each yield calls request() again to get the next event.
   */
  async *query(params: EngineQueryParams): AsyncGenerator<StreamEvent> {
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ id, method: 'query', params }) + '\n';

    if (!this.proc || !this.proc.stdin) {
      throw new Error('Engine not started');
    }

    // Write the query request
    this.proc.stdin.write(payload);

    // Read events until 'done' or 'error'
    while (true) {
      const event = await new Promise<any>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error('Engine query timed out'));
          }
        }, 300_000);
      });

      if (event.type === 'done') {
        return;
      }
      if (event.type === 'error') {
        throw new Error(event.error || 'Unknown engine error');
      }

      // Yield intermediate events (stream_event or event)
      if (event.type === 'event') {
        yield { type: event.event?.type || 'unknown', event: event.event };
      } else {
        yield event;
      }
    }
  }

  /** List available tools */
  async listTools(): Promise<EngineToolResult[]> {
    const result = await this.request('listTools');
    return result.result?.tools || [];
  }

  /** Check if engine is alive */
  async ping(): Promise<boolean> {
    try {
      const result = await this.request('ping');
      return result.type === 'pong';
    } catch {
      return false;
    }
  }

  /** Stop the engine */
  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

/** Resolve the path to the headless engine bundle */
export function resolveEnginePath(): string {
  // In development: relative path to opencc dist
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', '..', 'chatwise', 'opencc', 'dist', 'headless-engine.js');
}
