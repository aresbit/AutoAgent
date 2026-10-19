/**
 * Sandboxed preload bridge for the preview pane.
 *
 * Exposes a fixed, typed API on `window.autoagentPreview`.  It never exposes
 * `ipcRenderer`, `invoke`, `send`, filesystem, shell or Node primitives.
 *
 * The main process validates every payload again in `preview-ipc.ts`; the
 * checks here only fail fast on obvious caller mistakes and keep malformed
 * values out of the structured-clone boundary.
 *
 * This preload is loaded by the AutoAgent SPA window only.  Preview content
 * pages are created with no preload at all.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  PREVIEW_CHANNELS,
  PREVIEW_EVENT_CHANNEL,
  PREVIEW_LIMITS,
  isPreviewEvent,
  type PreviewBounds,
  type PreviewConsoleEntry,
  type PreviewCreateRequest,
  type PreviewEvent,
  type PreviewScreenshot,
  type PreviewTabState,
} from '../desktop/preview-contract.js';

const TAB_ID = /^[a-z0-9-]{1,64}$/;

function assertTabId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TAB_ID.test(value)) {
    throw new TypeError('preview tab id is not valid');
  }
}

function assertUrl(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PREVIEW_LIMITS.maxUrlLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('preview url is not valid');
  }
}

function assertBounds(value: unknown): asserts value is PreviewBounds {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('preview bounds are not valid');
  }
  const bounds = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const field = bounds[key];
    if (
      typeof field !== 'number' ||
      !Number.isFinite(field) ||
      !Number.isInteger(field) ||
      field < 0 ||
      field > PREVIEW_LIMITS.maxBoundsEdge
    ) {
      throw new TypeError('preview bounds are not valid');
    }
  }
}

function assertCreateRequest(value: PreviewCreateRequest): void {
  if (value.url !== undefined) assertUrl(value.url);
  if (value.bounds !== undefined) assertBounds(value.bounds);
  if (value.show !== undefined && typeof value.show !== 'boolean') {
    throw new TypeError('preview show flag is not valid');
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new TypeError('preview title is not valid');
  }
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  return (await ipcRenderer.invoke(channel, payload)) as T;
}

function subscribe(handler: (event: PreviewEvent) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => {
    // Drop anything that does not match the contract instead of trusting main
    // blindly; keeps the renderer on one validated shape.
    if (isPreviewEvent(payload)) handler(payload);
  };
  ipcRenderer.on(PREVIEW_EVENT_CHANNEL, listener);
  return () => {
    ipcRenderer.off(PREVIEW_EVENT_CHANNEL, listener);
  };
}

const api = Object.freeze({
  create(request: PreviewCreateRequest = {}): Promise<PreviewTabState> {
    assertCreateRequest(request);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.create, request);
  },

  close(tabId: string): Promise<boolean> {
    assertTabId(tabId);
    return invoke<boolean>(PREVIEW_CHANNELS.close, { tabId });
  },

  list(): Promise<PreviewTabState[]> {
    return invoke<PreviewTabState[]>(PREVIEW_CHANNELS.list);
  },

  getState(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.getState, { tabId });
  },

  show(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.show, { tabId });
  },

  hide(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.hide, { tabId });
  },

  focus(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.focus, { tabId });
  },

  setBounds(tabId: string, bounds: PreviewBounds): Promise<PreviewTabState> {
    assertTabId(tabId);
    assertBounds(bounds);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.setBounds, { tabId, bounds });
  },

  navigate(tabId: string, url: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    assertUrl(url);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.navigate, { tabId, url });
  },

  back(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.back, { tabId });
  },

  forward(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.forward, { tabId });
  },

  reload(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return invoke<PreviewTabState>(PREVIEW_CHANNELS.reload, { tabId });
  },

  screenshot(tabId: string, ifChanged = false): Promise<PreviewScreenshot | null> {
    assertTabId(tabId);
    if (typeof ifChanged !== 'boolean') {
      throw new TypeError('preview ifChanged flag is not valid');
    }
    return invoke<PreviewScreenshot | null>(PREVIEW_CHANNELS.screenshot, { tabId, ifChanged });
  },

  logs(
    tabId: string,
    query: { limit?: number; since?: number } = {},
  ): Promise<PreviewConsoleEntry[]> {
    assertTabId(tabId);
    if (query.limit !== undefined) {
      if (
        !Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > PREVIEW_LIMITS.maxConsoleEntries
      ) {
        throw new TypeError('preview log limit is not valid');
      }
    }
    if (query.since !== undefined) {
      if (!Number.isFinite(query.since) || query.since < 0) {
        throw new TypeError('preview log cursor is not valid');
      }
    }
    return invoke<PreviewConsoleEntry[]>(PREVIEW_CHANNELS.logs, { tabId, ...query });
  },

  openExternal(tabId: string, url: string): Promise<boolean> {
    assertTabId(tabId);
    assertUrl(url);
    return invoke<boolean>(PREVIEW_CHANNELS.openExternal, { tabId, url });
  },

  onEvent(handler: (event: PreviewEvent) => void): () => void {
    if (typeof handler !== 'function') {
      throw new TypeError('preview event handler must be a function');
    }
    return subscribe(handler);
  },
});

contextBridge.exposeInMainWorld('autoagentPreview', api);

export type PreviewBridgeApi = typeof api;
