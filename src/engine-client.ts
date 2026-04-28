/**
 * Engine client — spawns cli.js (opencc) as a child process for each query.
 *
 * Uses cli.js print mode (-p) with stream-json output. Session state is
 * persisted to disk by cli.js and resumed with --continue for multi-turn.
 *
 * Each query() call spawns a fresh cli.js process. There is no persistent
 * subprocess — this avoids the infinite state-stub bugs of the old
 * headless-engine approach.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

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
  signal?: AbortSignal;
}

export class EngineClient {
  private enginePath: string;
  private _ready: boolean = false;

  constructor(enginePath: string) {
    this.enginePath = enginePath;
  }

  /** Verify the engine bundle exists. Call once at startup. */
  start(): void {
    if (!existsSync(this.enginePath)) {
      throw new Error(`Engine not found: ${this.enginePath}`);
    }
    this._ready = true;
    console.error('[engine] ready (cli.js print mode, stateless)');
  }

  /** Wait for engine to be ready */
  async waitReady(): Promise<void> {
    if (!this._ready) {
      throw new Error('Engine not started — call start() first');
    }
  }

  /** Extract text from messages for the CLI prompt */
  private extractPrompt(params: EngineQueryParams): string {
    const msgs = params.messages || [];
    if (msgs.length === 0) return '';
    const last = msgs[msgs.length - 1];
    if (!last) return '';
    if (typeof last.content === 'string') return last.content;
    if (Array.isArray(last.content)) {
      return last.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n');
    }
    return '';
  }

  /**
   * Run a query by spawning cli.js in print mode.
   *
   * cli.js -p reads the prompt via stdin, runs through the full QueryEngine
   * with proper AppState initialization, and writes stream-json to stdout.
   */
  async *query(params: EngineQueryParams): AsyncGenerator<StreamEvent> {
    const prompt = this.extractPrompt(params);
    if (!prompt.trim()) {
      throw new Error('Empty prompt');
    }

    const args = [this.enginePath, '-p', '--output-format', 'stream-json', '--verbose'];
    if (params.appendSystemPrompt) {
      args.push('--append-system-prompt', params.appendSystemPrompt);
    }
    if (params.model) {
      args.push('--model', params.model);
    }
    if (params.maxTurns) {
      args.push('--max-turns', String(params.maxTurns));
    }

    const proc = spawn('bun', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RED_TEAM_MODE: '0',
        RTM: '0',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      } as Record<string, string>,
      cwd: params.cwd || process.cwd(),
    });

    // Write prompt to stdin and close
    proc.stdin!.write(prompt + '\n');
    proc.stdin!.end();

    // Handle abort — kill the child process
    const onAbort = () => {
      proc.kill('SIGTERM');
      // Force kill after 2s if still alive
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    };
    if (params.signal) {
      if (params.signal.aborted) {
        proc.kill('SIGTERM');
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Collect stderr for error reporting
    let stderrText = '';
    proc.stderr?.on('data', (data: Buffer) => {
      stderrText += data.toString();
    });

    const rl = createInterface({ input: proc.stdout! });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: any;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (msg.type === 'result') {
          yield { type: msg.type, event: msg };
          break;
        }

        if (msg.type === 'error') {
          yield { type: 'error', error: msg.error || 'Unknown error' };
          break;
        }

        // Pass through all other event types
        yield { type: msg.type || 'unknown', event: msg };
      }
    } finally {
      if (params.signal) {
        params.signal.removeEventListener('abort', onAbort);
      }
    }

    // Drain remaining stdout to avoid EPIPE
    await new Promise<void>((resolve) => {
      proc.stdout?.resume();
      proc.on('close', (code) => {
        if (code !== 0 && stderrText.trim()) {
          console.error('[engine] cli.js exit', code, stderrText.slice(-500));
        }
        resolve();
      });
    });
  }

  /** No-op — each query is a fresh process */
  async stop(): Promise<void> {}
}

/** Resolve the path to the cli.js bundle */
export function resolveEnginePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // In dev: packages/opencc/dist/cli.js
  return join(__dirname, '..', 'packages', 'opencc', 'dist', 'cli.js');
}
