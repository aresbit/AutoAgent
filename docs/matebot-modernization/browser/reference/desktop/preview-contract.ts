/**
 * Shared preview contract: channel names, wire types and runtime validators.
 *
 * This module is intentionally free of Electron and Node imports so the same
 * file can be bundled into the Electron main process, the sandboxed preload and
 * (after copying) the Vite renderer.  Every value that crosses the IPC boundary
 * is validated again in `preview-ipc.ts`; the helpers here are the single
 * definition of "valid" so the preload, renderer and tests cannot drift.
 */

export const PREVIEW_SCHEME = 'autoagent-preview' as const;

/**
 * Dedicated persistent partition.  Cookies, localStorage, cache and service
 * workers in previewed pages never share a session with the AutoAgent SPA.
 */
export const PREVIEW_PARTITION = 'persist:autoagent-preview' as const;

/** Single push channel; the payload is a `PreviewEvent` discriminated union. */
export const PREVIEW_EVENT_CHANNEL = 'preview:event' as const;

export const PREVIEW_CHANNELS = Object.freeze({
  create: 'preview:create',
  close: 'preview:close',
  list: 'preview:list',
  getState: 'preview:get-state',
  show: 'preview:show',
  hide: 'preview:hide',
  focus: 'preview:focus',
  setBounds: 'preview:set-bounds',
  navigate: 'preview:navigate',
  back: 'preview:back',
  forward: 'preview:forward',
  reload: 'preview:reload',
  screenshot: 'preview:screenshot',
  logs: 'preview:logs',
  openExternal: 'preview:open-external',
} as const);

export type PreviewChannel = (typeof PREVIEW_CHANNELS)[keyof typeof PREVIEW_CHANNELS];

export const PREVIEW_LIMITS = Object.freeze({
  /** Hard cap on live WebContentsViews. */
  maxTabs: 12,
  /** URLs longer than this are rejected before parsing. */
  maxUrlLength: 2048,
  /** Opaque tab ids are UUIDs; the cap leaves room for a future scheme. */
  maxTabIdLength: 64,
  /** Bounds are CSS pixels relative to the BrowserWindow content area. */
  maxBoundsEdge: 8192,
  /** Per-tab console ring buffer. */
  maxConsoleEntries: 500,
  /** Console messages are truncated before crossing IPC. */
  maxConsoleMessageLength: 8192,
  /** A PNG screenshot larger than this is rejected instead of sent. */
  maxScreenshotBytes: 12 * 1024 * 1024,
  /** Page titles are truncated defensively. */
  maxTitleLength: 300,
  /** Downloads are denied above this size when the size is known. */
  maxDownloadBytes: 512 * 1024 * 1024,
} as const);

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
  /** `data:image/png;base64,...`; only ever rendered inside the trusted SPA. */
  dataUrl: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  byteLength: number;
  /** False when `ifChanged` was requested and the pixels were identical. */
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

export interface PreviewTabRequest {
  tabId: string;
}

export interface PreviewSetBoundsRequest {
  tabId: string;
  bounds: PreviewBounds;
}

export interface PreviewNavigateRequest {
  tabId: string;
  url: string;
}

export interface PreviewScreenshotRequest {
  tabId: string;
  ifChanged?: boolean;
}

export interface PreviewLogsRequest {
  tabId: string;
  limit?: number;
  since?: number;
}

export interface PreviewOpenExternalRequest {
  tabId: string;
  url: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPreviewBounds(value: unknown): value is PreviewBounds {
  if (!isRecord(value)) return false;
  const { x, y, width, height } = value;
  return (
    isFiniteNumber(x) &&
    isFiniteNumber(y) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height) &&
    x >= 0 &&
    y >= 0 &&
    width >= 0 &&
    height >= 0 &&
    x <= PREVIEW_LIMITS.maxBoundsEdge &&
    y <= PREVIEW_LIMITS.maxBoundsEdge &&
    width <= PREVIEW_LIMITS.maxBoundsEdge &&
    height <= PREVIEW_LIMITS.maxBoundsEdge
  );
}

export function isPreviewLoadError(value: unknown): value is PreviewLoadError {
  if (!isRecord(value)) return false;
  return (
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
    isPreviewBounds(value.bounds) &&
    typeof value.partition === 'string' &&
    (value.error === null || isPreviewLoadError(value.error)) &&
    typeof value.crashed === 'boolean'
  );
}

export function isPreviewConsoleEntry(value: unknown): value is PreviewConsoleEntry {
  if (!isRecord(value)) return false;
  return (
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

export function isPreviewEvent(value: unknown): value is PreviewEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'state':
      return isPreviewTabState(value.state);
    case 'closed':
      return typeof value.tabId === 'string' && value.tabId.length > 0;
    case 'console':
      return isPreviewConsoleEntry(value.entry);
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
