/**
 * Typed renderer client for the preview IPC bridge.
 *
 * The wire types below mirror `desktop/preview-contract.ts`.  The two files are
 * deliberately separate because AutoAgent's desktop and frontend are separate
 * TypeScript projects; keep the public shapes and validators in sync (the patch
 * plan proposes a CI check).  All responses and push events are validated at
 * runtime before they reach React state.
 */

const MAX_URL_LENGTH = 2048;
const MAX_BOUNDS_EDGE = 8192;
const TAB_ID = /^[a-z0-9-]{1,64}$/;

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewLoadError {
  code: number;
  description: string;
  url: string;
}

export interface PreviewTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
  bounds: PreviewBounds;
  partition: string;
  error: PreviewLoadError | null;
  crashed: boolean;
}

export type PreviewConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

export interface PreviewConsoleEntry {
  tabId: string;
  level: PreviewConsoleLevel;
  message: string;
  sourceId: string;
  lineNumber: number;
  timestamp: number;
}

export interface PreviewScreenshot {
  dataUrl: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  byteLength: number;
  changed: boolean;
  capturedAt: number;
}

export type PreviewDownloadState =
  | 'denied'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

export type PreviewEvent =
  | { type: 'state'; state: PreviewTabState }
  | { type: 'closed'; tabId: string }
  | { type: 'console'; entry: PreviewConsoleEntry }
  | {
      type: 'blocked-navigation';
      tabId: string;
      url: string;
      reason: 'scheme' | 'origin' | 'shape';
    }
  | { type: 'external-open'; tabId: string; url: string }
  | {
      type: 'download';
      tabId: string | null;
      filename: string;
      state: PreviewDownloadState;
      receivedBytes: number;
      totalBytes: number;
    };

export interface PreviewCreateRequest {
  url?: string;
  bounds?: PreviewBounds;
  show?: boolean;
  title?: string;
}

export interface PreviewBridge {
  create(request?: PreviewCreateRequest): Promise<PreviewTabState>;
  close(tabId: string): Promise<boolean>;
  list(): Promise<PreviewTabState[]>;
  getState(tabId: string): Promise<PreviewTabState>;
  show(tabId: string): Promise<PreviewTabState>;
  hide(tabId: string): Promise<PreviewTabState>;
  focus(tabId: string): Promise<PreviewTabState>;
  setBounds(tabId: string, bounds: PreviewBounds): Promise<PreviewTabState>;
  navigate(tabId: string, url: string): Promise<PreviewTabState>;
  back(tabId: string): Promise<PreviewTabState>;
  forward(tabId: string): Promise<PreviewTabState>;
  reload(tabId: string): Promise<PreviewTabState>;
  screenshot(tabId: string, ifChanged?: boolean): Promise<PreviewScreenshot | null>;
  logs(
    tabId: string,
    query?: { limit?: number; since?: number },
  ): Promise<PreviewConsoleEntry[]>;
  openExternal(tabId: string, url: string): Promise<boolean>;
  onEvent(handler: (event: PreviewEvent) => void): () => void;
}

declare global {
  interface Window {
    autoagentPreview?: PreviewBridge;
  }
}

export type PreviewClientErrorCode =
  | 'unavailable'
  | 'invalid-input'
  | 'invalid-response'
  | 'ipc-error';

export class PreviewClientError extends Error {
  readonly code: PreviewClientErrorCode;

  constructor(code: PreviewClientErrorCode, message: string) {
    super(message);
    this.name = 'PreviewClientError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBounds(value: unknown): value is PreviewBounds {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.width >= 0 &&
    value.height >= 0 &&
    value.width <= MAX_BOUNDS_EDGE &&
    value.height <= MAX_BOUNDS_EDGE
  );
}

function isLoadError(value: unknown): value is PreviewLoadError {
  return (
    isRecord(value) &&
    isFiniteNumber(value.code) &&
    typeof value.description === 'string' &&
    typeof value.url === 'string'
  );
}

export function isPreviewTabState(value: unknown): value is PreviewTabState {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.loading === 'boolean' &&
    typeof value.canGoBack === 'boolean' &&
    typeof value.canGoForward === 'boolean' &&
    typeof value.visible === 'boolean' &&
    isBounds(value.bounds) &&
    typeof value.partition === 'string' &&
    (value.error === null || isLoadError(value.error)) &&
    typeof value.crashed === 'boolean'
  );
}

export function isPreviewScreenshot(value: unknown): value is PreviewScreenshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.dataUrl === 'string' &&
    value.dataUrl.startsWith('data:image/png;base64,') &&
    value.mimeType === 'image/png' &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isFiniteNumber(value.byteLength) &&
    typeof value.changed === 'boolean' &&
    isFiniteNumber(value.capturedAt)
  );
}

function isConsoleEntry(value: unknown): value is PreviewConsoleEntry {
  return (
    isRecord(value) &&
    typeof value.tabId === 'string' &&
    (value.level === 'debug' ||
      value.level === 'info' ||
      value.level === 'warning' ||
      value.level === 'error') &&
    typeof value.message === 'string' &&
    typeof value.sourceId === 'string' &&
    isFiniteNumber(value.lineNumber) &&
    isFiniteNumber(value.timestamp)
  );
}

export function isPreviewEvent(value: unknown): value is PreviewEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'state':
      return isPreviewTabState(value.state);
    case 'closed':
      return typeof value.tabId === 'string' && value.tabId.length > 0;
    case 'console':
      return isConsoleEntry(value.entry);
    case 'blocked-navigation':
      return (
        typeof value.tabId === 'string' &&
        typeof value.url === 'string' &&
        (value.reason === 'scheme' || value.reason === 'origin' || value.reason === 'shape')
      );
    case 'external-open':
      return typeof value.tabId === 'string' && typeof value.url === 'string';
    case 'download':
      return (
        (value.tabId === null || typeof value.tabId === 'string') &&
        typeof value.filename === 'string' &&
        (value.state === 'denied' ||
          value.state === 'started' ||
          value.state === 'completed' ||
          value.state === 'cancelled' ||
          value.state === 'interrupted') &&
        isFiniteNumber(value.receivedBytes) &&
        isFiniteNumber(value.totalBytes)
      );
    default:
      return false;
  }
}

/** Round a DOMRect-like value and clamp it to the IPC limits. */
export function normalizePreviewBounds(input: PreviewBounds): PreviewBounds {
  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(Math.round(value), 0), MAX_BOUNDS_EDGE);
  };
  return {
    x: clamp(input.x),
    y: clamp(input.y),
    width: clamp(input.width),
    height: clamp(input.height),
  };
}

/** Early syntax check only; the main process owns the origin allowlist. */
export function isPreviewAddress(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'autoagent-preview:';
  } catch {
    return false;
  }
}

function assertTabId(tabId: string): void {
  if (!TAB_ID.test(tabId)) {
    throw new PreviewClientError('invalid-input', 'preview tab id is not valid');
  }
}

function toClientError(error: unknown): PreviewClientError {
  if (error instanceof PreviewClientError) return error;
  if (error instanceof Error) {
    const match = /preview:[a-z][a-z-]*/.exec(error.message);
    return new PreviewClientError('ipc-error', match?.[0] ?? 'preview:unknown-error');
  }
  return new PreviewClientError('ipc-error', 'preview:unknown-error');
}

/**
 * Thin validated facade.  Construct with `createPreviewClient()`; returns null
 * in a plain browser (Vite dev in a tab) where the native bridge is absent.
 */
export class PreviewClient {
  private readonly bridge: PreviewBridge;

  constructor(bridge: PreviewBridge) {
    this.bridge = bridge;
  }

  static isAvailable(): boolean {
    return typeof window !== 'undefined' && window.autoagentPreview !== undefined;
  }

  private async guard<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      throw toClientError(error);
    }
  }

  private expectState(value: unknown): PreviewTabState {
    if (!isPreviewTabState(value)) {
      throw new PreviewClientError('invalid-response', 'preview state response is invalid');
    }
    return value;
  }

  async create(request: PreviewCreateRequest = {}): Promise<PreviewTabState> {
    if (request.url !== undefined && !isPreviewAddress(request.url)) {
      throw new PreviewClientError('invalid-input', 'preview url is not valid');
    }
    if (request.bounds !== undefined) request = { ...request, bounds: normalizePreviewBounds(request.bounds) };
    return this.expectState(await this.guard(this.bridge.create(request)));
  }

  async close(tabId: string): Promise<boolean> {
    assertTabId(tabId);
    const closed = await this.guard(this.bridge.close(tabId));
    if (typeof closed !== 'boolean') {
      throw new PreviewClientError('invalid-response', 'preview close response is invalid');
    }
    return closed;
  }

  async list(): Promise<PreviewTabState[]> {
    const states = await this.guard(this.bridge.list());
    if (!Array.isArray(states) || !states.every(isPreviewTabState)) {
      throw new PreviewClientError('invalid-response', 'preview list response is invalid');
    }
    return states;
  }

  async getState(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(await this.guard(this.bridge.getState(tabId)));
  }

  async show(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(await this.guard(this.bridge.show(tabId)));
  }

  async hide(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(await this.guard(this.bridge.hide(tabId)));
  }

  async focus(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(await this.guard(this.bridge.focus(tabId)));
  }

  async setBounds(tabId: string, bounds: PreviewBounds): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(
      await this.guard(this.bridge.setBounds(tabId, normalizePreviewBounds(bounds))),
    );
  }

  async navigate(tabId: string, url: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    if (!isPreviewAddress(url)) {
      throw new PreviewClientError('invalid-input', 'preview url is not valid');
    }
    return this.expectState(await this.guard(this.bridge.navigate(tabId, url)));
  }

  async back(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(await this.guard(this.bridge.back(tabId)));
  }

  async forward(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(await this.guard(this.bridge.forward(tabId)));
  }

  async reload(tabId: string): Promise<PreviewTabState> {
    assertTabId(tabId);
    return this.expectState(await this.guard(this.bridge.reload(tabId)));
  }

  async screenshot(tabId: string, ifChanged = false): Promise<PreviewScreenshot | null> {
    assertTabId(tabId);
    const shot = await this.guard(this.bridge.screenshot(tabId, ifChanged));
    if (shot !== null && !isPreviewScreenshot(shot)) {
      throw new PreviewClientError('invalid-response', 'preview screenshot response is invalid');
    }
    return shot;
  }

  async logs(
    tabId: string,
    query: { limit?: number; since?: number } = {},
  ): Promise<PreviewConsoleEntry[]> {
    assertTabId(tabId);
    const entries = await this.guard(this.bridge.logs(tabId, query));
    if (!Array.isArray(entries) || !entries.every(isConsoleEntry)) {
      throw new PreviewClientError('invalid-response', 'preview logs response is invalid');
    }
    return entries;
  }

  async openExternal(tabId: string, url: string): Promise<boolean> {
    assertTabId(tabId);
    if (!isPreviewAddress(url)) {
      throw new PreviewClientError('invalid-input', 'preview url is not valid');
    }
    const opened = await this.guard(this.bridge.openExternal(tabId, url));
    if (typeof opened !== 'boolean') {
      throw new PreviewClientError('invalid-response', 'preview open response is invalid');
    }
    return opened;
  }

  /**
   * Subscribe to tabs/logs/blocked-navigation events.  Invalid payloads are
   * dropped and a throwing consumer cannot break the IPC listener.
   */
  onEvent(handler: (event: PreviewEvent) => void): () => void {
    return this.bridge.onEvent((event) => {
      if (!isPreviewEvent(event)) return;
      try {
        handler(event);
      } catch {
        // Renderer callbacks must not tear down the bridge.
      }
    });
  }
}

export function createPreviewClient(): PreviewClient | null {
  if (typeof window === 'undefined' || !window.autoagentPreview) return null;
  return new PreviewClient(window.autoagentPreview);
}
