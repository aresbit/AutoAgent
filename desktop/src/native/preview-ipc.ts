/**
 * Fixed preview IPC surface.
 *
 * Every handler:
 *   1. verifies the call came from the AutoAgent main window's top frame on the
 *      app origin (never from preview content or a subframe);
 *   2. validates the exact payload shape and per-field limits;
 *   3. returns either the typed result or an error whose message contains only
 *      a stable `preview:<code>` (never a URL, path or Electron message).
 *
 * There is no generic `invoke`/`send` channel.  Event push uses one channel
 * carrying the `PreviewEvent` union.
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  PREVIEW_CHANNELS,
  PREVIEW_EVENT_CHANNEL,
  PREVIEW_LIMITS,
  isPreviewBounds,
  isRecord,
  type PreviewBounds,
  type PreviewCreateRequest,
  type PreviewEvent,
} from './preview-contract.js';
import { PreviewError, PreviewManager, type PreviewLogDetail } from './preview-manager.js';

export interface PreviewIpcOptions {
  manager: PreviewManager;
  getWindow: () => BrowserWindow | null;
  /** Exact app origin, e.g. `http://127.0.0.1:43121`. */
  getAppOrigin: () => string | null;
  logger?: (event: string, detail?: PreviewLogDetail) => void;
}

export interface PreviewIpcRegistration {
  unregister(): void;
}

const TAB_ID = /^[a-z0-9-]{1,64}$/;

function badRequest(): never {
  throw new PreviewError('invalid-request');
}

function isControlFree(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function requireObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) badRequest();
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) badRequest();
  }
  return value;
}

function requireTabId(value: unknown): string {
  if (typeof value !== 'string' || !TAB_ID.test(value)) badRequest();
  return value;
}

function requireUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PREVIEW_LIMITS.maxUrlLength ||
    !isControlFree(value)
  ) {
    badRequest();
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') badRequest();
  return value;
}

function parseBounds(value: unknown): PreviewBounds {
  if (!isPreviewBounds(value)) badRequest();
  if (
    !Number.isInteger(value.x) ||
    !Number.isInteger(value.y) ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height)
  ) {
    badRequest();
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function parseCreate(value: unknown): PreviewCreateRequest {
  if (value === undefined || value === null) return {};
  const record = requireObject(value, ['url', 'bounds', 'show', 'title']);
  const request: PreviewCreateRequest = {};
  if (record.url !== undefined) request.url = requireUrl(record.url);
  if (record.bounds !== undefined) request.bounds = parseBounds(record.bounds);
  if (record.show !== undefined) {
    const show = optionalBoolean(record.show);
    if (show !== undefined) request.show = show;
  }
  if (record.title !== undefined) {
    if (typeof record.title !== 'string') badRequest();
    const title = record.title.trim();
    if (title.length > 0) request.title = title.slice(0, PREVIEW_LIMITS.maxTitleLength);
  }
  return request;
}

function parseTabRequest(value: unknown): { tabId: string } {
  const record = requireObject(value, ['tabId']);
  return { tabId: requireTabId(record.tabId) };
}

function parseSetBounds(value: unknown): { tabId: string; bounds: PreviewBounds } {
  const record = requireObject(value, ['tabId', 'bounds']);
  return { tabId: requireTabId(record.tabId), bounds: parseBounds(record.bounds) };
}

function parseNavigate(value: unknown): { tabId: string; url: string } {
  const record = requireObject(value, ['tabId', 'url']);
  return { tabId: requireTabId(record.tabId), url: requireUrl(record.url) };
}

function parseScreenshot(value: unknown): { tabId: string; ifChanged: boolean } {
  const record = requireObject(value, ['tabId', 'ifChanged']);
  return {
    tabId: requireTabId(record.tabId),
    ifChanged: optionalBoolean(record.ifChanged) === true,
  };
}

function parseLogs(value: unknown): { tabId: string; limit?: number; since?: number } {
  const record = requireObject(value, ['tabId', 'limit', 'since']);
  const tabId = requireTabId(record.tabId);
  let limit: number | undefined;
  let since: number | undefined;
  if (record.limit !== undefined) {
    if (
      typeof record.limit !== 'number' ||
      !Number.isInteger(record.limit) ||
      record.limit < 1 ||
      record.limit > PREVIEW_LIMITS.maxConsoleEntries
    ) {
      badRequest();
    }
    limit = record.limit;
  }
  if (record.since !== undefined) {
    if (typeof record.since !== 'number' || !Number.isFinite(record.since) || record.since < 0) {
      badRequest();
    }
    since = record.since;
  }
  return { tabId, limit, since };
}

function toPublicError(error: unknown): Error {
  if (error instanceof PreviewError) return new Error(error.message);
  return new Error('preview:internal-error');
}

export function registerPreviewIpc(options: PreviewIpcOptions): PreviewIpcRegistration {
  const { manager } = options;

  function assertTrustedSender(event: IpcMainInvokeEvent): void {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) throw new PreviewError('untrusted-sender');
    if (event.sender !== window.webContents) throw new PreviewError('untrusted-sender');

    const frame = event.senderFrame;
    if (!frame || frame !== window.webContents.mainFrame || frame.parent !== null) {
      throw new PreviewError('untrusted-sender');
    }

    const expected = options.getAppOrigin();
    if (!expected) throw new PreviewError('untrusted-sender');
    let actual: string;
    try {
      actual = new URL(frame.url).origin;
    } catch {
      throw new PreviewError('untrusted-sender');
    }
    if (actual !== expected) throw new PreviewError('untrusted-sender');
  }

  function register(
    channel: string,
    handler: (payload: unknown) => unknown | Promise<unknown>,
  ): void {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      try {
        assertTrustedSender(event);
        return await handler(payload);
      } catch (error) {
        const safe = toPublicError(error);
        options.logger?.('preview.ipc.error', {
          channel,
          code: safe.message,
        });
        throw safe;
      }
    });
  }

  register(PREVIEW_CHANNELS.create, (payload) => manager.create(parseCreate(payload)));
  register(PREVIEW_CHANNELS.close, (payload) => manager.close(parseTabRequest(payload).tabId));
  register(PREVIEW_CHANNELS.list, () => manager.list());
  register(PREVIEW_CHANNELS.getState, (payload) => {
    return manager.getState(parseTabRequest(payload).tabId);
  });
  register(PREVIEW_CHANNELS.show, (payload) => manager.show(parseTabRequest(payload).tabId));
  register(PREVIEW_CHANNELS.hide, (payload) => manager.hide(parseTabRequest(payload).tabId));
  register(PREVIEW_CHANNELS.focus, (payload) => manager.focus(parseTabRequest(payload).tabId));
  register(PREVIEW_CHANNELS.setBounds, (payload) => {
    const { tabId, bounds } = parseSetBounds(payload);
    return manager.setBounds(tabId, bounds);
  });
  register(PREVIEW_CHANNELS.navigate, (payload) => {
    const { tabId, url } = parseNavigate(payload);
    return manager.navigate(tabId, url);
  });
  register(PREVIEW_CHANNELS.back, (payload) => manager.back(parseTabRequest(payload).tabId));
  register(PREVIEW_CHANNELS.forward, (payload) => {
    return manager.forward(parseTabRequest(payload).tabId);
  });
  register(PREVIEW_CHANNELS.reload, (payload) => manager.reload(parseTabRequest(payload).tabId));
  register(PREVIEW_CHANNELS.screenshot, (payload) => {
    const { tabId, ifChanged } = parseScreenshot(payload);
    return manager.captureScreenshot(tabId, ifChanged);
  });
  register(PREVIEW_CHANNELS.logs, (payload) => {
    const { tabId, limit, since } = parseLogs(payload);
    return manager.getConsoleLogs(tabId, { limit, since });
  });
  register(PREVIEW_CHANNELS.openExternal, async (payload) => {
    const { tabId, url } = parseNavigate(payload);
    return manager.openExternal(tabId, url);
  });

  const unsubscribe = manager.subscribe((event: PreviewEvent) => {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(PREVIEW_EVENT_CHANNEL, event);
  });

  let registered = true;
  return {
    unregister(): void {
      if (!registered) return;
      registered = false;
      unsubscribe();
      for (const channel of Object.values(PREVIEW_CHANNELS)) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
