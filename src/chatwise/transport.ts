import { BrowserWindow, MessageChannelMain, type IpcMain, type WebContents, net } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  electronExecEventChannel,
  electronExecRequestChannel,
  electronFetchAbortChannel,
  electronFetchPrefix,
  electronFetchRequestChannel,
} from './protocol.js';

type ExecRequest =
  | { type: 'spawn'; id: string; command: string; args?: string[]; options?: { cwd?: string; env?: Record<string, string>; shell?: boolean } }
  | { type: 'stdin:write'; id: string; data?: ArrayBuffer | Uint8Array | number[] | string }
  | { type: 'stdin:end'; id: string; data?: ArrayBuffer | Uint8Array | number[] | string }
  | { type: 'kill'; id: string; signal?: NodeJS.Signals | number };

const execChildren = new Map<string, { child: ChildProcessWithoutNullStreams; sender: WebContents }>();

export function registerElectronFetchIpc(ipcMain: IpcMain): void {
  ipcMain.on(electronFetchRequestChannel, async (event, request: { id: string; url: string; init?: RequestInit }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;

    const { port1, port2 } = new MessageChannelMain();
    window.webContents.postMessage(`${electronFetchPrefix}${request.id}`, null, [port2]);
    const abortChannel = electronFetchAbortChannel(request.id);
    const controller = new AbortController();
    const abort = () => controller.abort();
    ipcMain.once(abortChannel, abort);

    try {
      const { body, ...init } = request.init || {};
      const response = await net.fetch(request.url, { ...init, body: body as any, signal: controller.signal });
      port1.postMessage({
        type: 'response',
        status: response.status,
        statusText: response.statusText,
        headers: Array.from((response.headers as any).entries()),
      });

      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (value) port1.postMessage({ type: 'chunk', value });
          if (done) break;
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        port1.postMessage({ type: 'error', error: '__aborted__' });
      } else {
        port1.postMessage({
          type: 'error',
          error: { message: error?.message || String(error), name: error?.name, stack: error?.stack, code: error?.code },
        });
      }
    } finally {
      ipcMain.removeListener(abortChannel, abort);
      port1.postMessage({ type: 'end' });
      port1.close();
      port2.close();
    }
  });
}

export function registerElectronExecIpc(ipcMain: IpcMain): void {
  ipcMain.on(electronExecRequestChannel, (event, request: ExecRequest) => {
    if (request.type === 'spawn') {
      spawnExecChild(event.sender, request);
      return;
    }

    const record = execChildren.get(request.id);
    if (!record) return;

    if (request.type === 'stdin:write') {
      record.child.stdin.write(toBuffer(request.data));
      return;
    }
    if (request.type === 'stdin:end') {
      if (request.data !== undefined) record.child.stdin.end(toBuffer(request.data));
      else record.child.stdin.end();
      return;
    }
    if (request.type === 'kill') {
      record.child.kill(request.signal as NodeJS.Signals | undefined);
    }
  });
}

function spawnExecChild(
  sender: WebContents,
  request: Extract<ExecRequest, { type: 'spawn' }>,
): void {
  const child = spawn(request.command, request.args || [], {
    cwd: request.options?.cwd,
    env: { ...process.env, ...(request.options?.env || {}) },
    shell: request.options?.shell || false,
  });
  execChildren.set(request.id, { child, sender });

  child.on('spawn', () => {
    sender.send(electronExecEventChannel, { type: 'spawn', id: request.id, pid: child.pid });
  });
  child.stdout.on('data', (data) => {
    sender.send(electronExecEventChannel, { type: 'stdout', id: request.id, data: Uint8Array.from(Buffer.from(data)) });
  });
  child.stderr.on('data', (data) => {
    sender.send(electronExecEventChannel, { type: 'stderr', id: request.id, data: Uint8Array.from(Buffer.from(data)) });
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    sender.send(electronExecEventChannel, {
      type: 'error',
      id: request.id,
      error: { message: error.message, name: error.name, stack: error.stack, code: error.code },
    });
  });
  child.on('close', (code, signal) => {
    execChildren.delete(request.id);
    sender.send(electronExecEventChannel, { type: 'close', id: request.id, code, signal });
  });
}

function toBuffer(data: ArrayBuffer | Uint8Array | number[] | string | undefined): Buffer {
  if (data === undefined) return Buffer.alloc(0);
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  return Buffer.from(data);
}

export function killElectronExecChildren(): void {
  for (const { child } of execChildren.values()) child.kill();
  execChildren.clear();
}
