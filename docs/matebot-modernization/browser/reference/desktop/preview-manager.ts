/**
 * Main-process preview tab manager.
 *
 * One `WebContentsView` per tab, all sharing a dedicated persistent partition.
 * The manager owns every security decision: navigation allowlist, window-open
 * denial, permission denial, download policy, bounds clamping and cleanup.
 *
 * The target content is never given a preload, never receives `nodeIntegration`
 * and never sees the AutoAgent bridge.  The renderer only talks to this class
 * through the fixed IPC surface in `preview-ipc.ts`.
 */

import {
  app,
  BrowserWindow,
  session,
  shell,
  WebContentsView,
  type DownloadItem,
  type Session,
  type WebContents,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PREVIEW_LIMITS,
  PREVIEW_PARTITION,
  PREVIEW_SCHEME,
  type PreviewBounds,
  type PreviewConsoleEntry,
  type PreviewConsoleLevel,
  type PreviewCreateRequest,
  type PreviewEvent,
  type PreviewLoadError,
  type PreviewScreenshot,
  type PreviewTabState,
} from './preview-contract.js';
import { parsePreviewUrl } from './preview-protocol.js';

/** Structured logger hook; never pass URLs with credentials or page content. */
export type PreviewLogDetail = Readonly<
  Record<string, string | number | boolean | null>
>;
export type PreviewLogger = (event: string, detail?: PreviewLogDetail) => void;

export type BlockReason = 'scheme' | 'origin' | 'shape';
export type NavigationCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: BlockReason };

export interface PreviewManagerOptions {
  getWindow: () => BrowserWindow | null;
  /** Defaults to `PREVIEW_PARTITION`. */
  partition?: string;
  /**
   * Exact origins allowed to load. Only `https:` is accepted unless
   * `allowInsecureHttp` is explicitly enabled for loopback development.
   */
  allowedOrigins?: readonly string[];
  /** Test/dev only: permit `http:` loopback origins. Default false. */
  allowInsecureHttp?: boolean;
  /** Permit `autoagent-preview://` URLs. Default true. */
  allowPreviewScheme?: boolean;
  /**
   * Electron permissions granted to preview pages. Empty by default (deny all).
   * Every grant still requires the requesting origin to be allowlisted.
   */
  allowedPermissions?: readonly string[];
  /** Downloads are denied unless this is true and `downloadsDir` is set. */
  allowDownloads?: boolean;
  downloadsDir?: string;
  /**
   * Handler for `autoagent-preview://`.  Protocol handlers are scoped to a
   * Session, so the manager installs it on the preview partition (not the
   * default session).  Required before `autoagent-preview://` navigation works.
   */
  protocolHandler?: (request: Request) => Promise<Response>;
  logger?: PreviewLogger;
  maxTabs?: number;
}

export class PreviewError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`preview:${code}`);
    this.name = 'PreviewError';
    this.code = code;
  }
}

interface TabRecord {
  id: string;
  view: WebContentsView;
  webContentsId: number;
  title: string;
  loading: boolean;
  visible: boolean;
  bounds: PreviewBounds;
  error: PreviewLoadError | null;
  crashed: boolean;
  logs: PreviewConsoleEntry[];
  listeners: Array<() => void>;
  lastScreenshotHash: string | null;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Parse an origin allowlist at startup.  Anything that is not a bare https
 * origin is a configuration error, not a runtime surprise.
 */
export function normalizeAllowedOrigins(
  raw: readonly string[],
  allowInsecureHttp = false,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of raw) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('preview allowlist entry is not a URL');
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error('preview allowlist entry must not contain credentials');
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error('preview allowlist entries must be origins without a path');
    }
    if (url.protocol === 'https:') {
      origins.add(url.origin);
      continue;
    }
    if (allowInsecureHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
      origins.add(url.origin);
      continue;
    }
    throw new Error('preview allowlist entries must use https');
  }
  return origins;
}

/** Pure navigation policy, also used by tests and by the IPC validator. */
export function checkNavigation(
  raw: string,
  allowedOrigins: ReadonlySet<string>,
  allowPreviewScheme: boolean,
): NavigationCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PREVIEW_LIMITS.maxUrlLength) {
    return { allowed: false, reason: 'shape' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'shape' };
  }
  if (url.username !== '' || url.password !== '') {
    return { allowed: false, reason: 'shape' };
  }
  if (url.protocol === 'https:') {
    return allowedOrigins.has(url.origin)
      ? { allowed: true }
      : { allowed: false, reason: 'origin' };
  }
  if (url.protocol === 'autoagent-preview:') {
    if (!allowPreviewScheme) return { allowed: false, reason: 'scheme' };
    return parsePreviewUrl(raw) === null
      ? { allowed: false, reason: 'shape' }
      : { allowed: true };
  }
  return { allowed: false, reason: 'scheme' };
}

/** Filename policy for the optional download path. */
export function sanitizeFilename(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160);
  return cleaned.length > 0 ? cleaned : 'download';
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new PreviewError('invalid-bounds');
  return Math.min(Math.max(Math.round(value), min), max);
}

function sameBounds(a: PreviewBounds, b: PreviewBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export class PreviewManager {
  private readonly options: PreviewManagerOptions;
  private readonly partition: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly allowPreviewScheme: boolean;
  private readonly allowedPermissions: ReadonlySet<string>;
  private readonly allowDownloads: boolean;
  private readonly downloadsDir: string | null;
  private readonly maxTabs: number;
  private readonly tabs = new Map<string, TabRecord>();
  private readonly wcToTab = new Map<number, string>();
  private readonly subscribers = new Set<(event: PreviewEvent) => void>();
  private readonly boundWindows = new WeakSet<BrowserWindow>();
  private readonly beforeQuit: () => void;
  private previewSession: Session | null = null;
  private downloadListener:
    | ((event: Electron.Event, item: DownloadItem, webContents: WebContents) => void)
    | null = null;
  private disposed = false;

  constructor(options: PreviewManagerOptions) {
    if (!app.isReady()) {
      throw new Error('PreviewManager must be constructed after app.whenReady()');
    }
    this.options = options;
    this.partition = options.partition ?? PREVIEW_PARTITION;
    this.allowedOrigins = normalizeAllowedOrigins(
      options.allowedOrigins ?? [],
      options.allowInsecureHttp === true,
    );
    this.allowPreviewScheme = options.allowPreviewScheme !== false;
    this.allowedPermissions = new Set(options.allowedPermissions ?? []);
    this.allowDownloads = options.allowDownloads === true;
    this.downloadsDir = options.downloadsDir ?? null;
    this.maxTabs = Math.min(options.maxTabs ?? PREVIEW_LIMITS.maxTabs, PREVIEW_LIMITS.maxTabs);
    if (this.allowDownloads && !this.downloadsDir) {
      throw new Error('preview downloads require downloadsDir');
    }
    this.beforeQuit = () => this.dispose();
    app.on('before-quit', this.beforeQuit);
    this.ensureSession();
  }

  subscribe(listener: (event: PreviewEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  create(request: PreviewCreateRequest = {}): PreviewTabState {
    this.assertUsable();
    const window = this.requireWindow();
    if (this.tabs.size >= this.maxTabs) throw new PreviewError('too-many-tabs');

    const id = randomUUID();
    const bounds = request.bounds
      ? this.clampBounds(request.bounds)
      : { x: 0, y: 0, width: 0, height: 0 };
    const visible = request.show === true;

    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        plugins: false,
        spellcheck: false,
        devTools: process.env.AUTOAGENT_PREVIEW_DEVTOOLS === '1',
        // Deliberately no `preload`: the remote document gets no bridge.
      },
    });
    view.setBackgroundColor('#ffffff');

    const record: TabRecord = {
      id,
      view,
      webContentsId: view.webContents.id,
      title: request.title ?? 'Preview',
      loading: false,
      visible,
      bounds,
      error: null,
      crashed: false,
      logs: [],
      listeners: [],
      lastScreenshotHash: null,
    };

    this.tabs.set(id, record);
    this.wcToTab.set(record.webContentsId, id);
    this.bindWindow(window);

    try {
      window.contentView.addChildView(view);
    } catch (error) {
      this.tabs.delete(id);
      this.wcToTab.delete(record.webContentsId);
      try {
        view.webContents.close();
      } catch {
        // best effort
      }
      throw error;
    }

    try {
      this.bindTab(record);
      this.applyBounds(record);
      view.setVisible(visible);
      const initial = request.url ? this.assertNavigable(request.url) : 'about:blank';
      void view.webContents.loadURL(initial).catch(() => {
        // `did-fail-load` carries the structured error.
      });
    } catch (error) {
      this.tabs.delete(id);
      this.wcToTab.delete(record.webContentsId);
      this.destroyTab(record, false);
      throw error;
    }

    this.emitState(record);
    return this.snapshot(record);
  }

  close(tabId: string): boolean {
    this.assertUsable();
    const record = this.tabs.get(tabId);
    if (!record) return false;
    this.tabs.delete(tabId);
    this.wcToTab.delete(record.webContentsId);
    this.destroyTab(record, false);
    this.emit({ type: 'closed', tabId });
    return true;
  }

  list(): PreviewTabState[] {
    this.assertUsable();
    return [...this.tabs.values()].map((record) => this.snapshot(record));
  }

  getState(tabId: string): PreviewTabState {
    return this.snapshot(this.requireTab(tabId));
  }

  show(tabId: string): PreviewTabState {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const window = this.requireWindow();
    record.visible = true;
    // Re-adding an existing child reorders it to the top of the view stack.
    window.contentView.addChildView(record.view);
    this.applyBounds(record);
    record.view.setVisible(true);
    this.emitState(record);
    return this.snapshot(record);
  }

  hide(tabId: string): PreviewTabState {
    this.assertUsable();
    const record = this.requireTab(tabId);
    record.visible = false;
    record.view.setVisible(false);
    this.emitState(record);
    return this.snapshot(record);
  }

  focus(tabId: string): PreviewTabState {
    const state = this.show(tabId);
    this.requireTab(tabId).view.webContents.focus();
    return state;
  }

  setBounds(tabId: string, bounds: PreviewBounds): PreviewTabState {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const next = this.clampBounds(bounds);
    if (sameBounds(record.bounds, next)) return this.snapshot(record);
    record.bounds = next;
    this.applyBounds(record);
    this.emitState(record);
    return this.snapshot(record);
  }

  navigate(tabId: string, rawUrl: string): PreviewTabState {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const url = this.assertNavigable(rawUrl);
    record.error = null;
    void record.view.webContents.loadURL(url).catch(() => {
      // `did-fail-load` carries the structured error.
    });
    this.emitState(record);
    return this.snapshot(record);
  }

  back(tabId: string): PreviewTabState {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const wc = record.view.webContents;
    if (!wc.isDestroyed() && wc.canGoBack()) wc.goBack();
    this.emitState(record);
    return this.snapshot(record);
  }

  forward(tabId: string): PreviewTabState {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const wc = record.view.webContents;
    if (!wc.isDestroyed() && wc.canGoForward()) wc.goForward();
    this.emitState(record);
    return this.snapshot(record);
  }

  reload(tabId: string): PreviewTabState {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const wc = record.view.webContents;
    if (!wc.isDestroyed()) {
      record.error = null;
      wc.reload();
    }
    this.emitState(record);
    return this.snapshot(record);
  }

  /**
   * Capture the active surface as PNG.  `ifChanged` returns `null` when the
   * pixels hash identically to the previous successful capture for this tab.
   */
  async captureScreenshot(tabId: string, ifChanged = false): Promise<PreviewScreenshot | null> {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const wc = record.view.webContents;
    if (wc.isDestroyed()) throw new PreviewError('tab-destroyed');

    const image = await wc.capturePage();
    if (image.isEmpty()) throw new PreviewError('capture-empty');
    const png = image.toPNG();
    if (png.byteLength > PREVIEW_LIMITS.maxScreenshotBytes) {
      throw new PreviewError('screenshot-too-large');
    }

    const hash = createHash('sha256').update(png).digest('hex');
    const changed = record.lastScreenshotHash !== hash;
    if (ifChanged && !changed) return null;
    record.lastScreenshotHash = hash;

    const size = image.getSize();
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
      byteLength: png.byteLength,
      changed,
      capturedAt: Date.now(),
    };
  }

  getConsoleLogs(
    tabId: string,
    query: { limit?: number; since?: number } = {},
  ): PreviewConsoleEntry[] {
    this.assertUsable();
    const record = this.requireTab(tabId);
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? 200), 1),
      PREVIEW_LIMITS.maxConsoleEntries,
    );
    const since = Number.isFinite(query.since) ? (query.since as number) : 0;
    const filtered = since > 0 ? record.logs.filter((entry) => entry.timestamp >= since) : record.logs;
    return filtered.slice(-limit);
  }

  /** Explicit, user-initiated "open in browser"; never called from page script. */
  async openExternal(tabId: string, rawUrl: string): Promise<boolean> {
    this.assertUsable();
    this.requireTab(tabId);
    const url = this.assertNavigable(rawUrl);
    await shell.openExternal(url);
    return true;
  }

  clearConsoleLogs(tabId: string): void {
    this.assertUsable();
    this.requireTab(tabId).logs = [];
  }

  /** Remove every view and handler. Idempotent; called from app `before-quit`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    app.removeListener('before-quit', this.beforeQuit);
    for (const record of [...this.tabs.values()]) {
      this.destroyTab(record, false);
    }
    this.tabs.clear();
    this.wcToTab.clear();
    const previewSession = this.previewSession;
    if (previewSession) {
      try {
        previewSession.setPermissionRequestHandler(null);
        previewSession.setPermissionCheckHandler(null);
        previewSession.setCertificateVerifyProc(null);
      } catch {
        // The app may already be tearing the session down.
      }
      try {
        previewSession.protocol.unhandle(PREVIEW_SCHEME);
      } catch {
        // No handler was installed, or the session is already gone.
      }
      try {
        if (this.downloadListener) {
          previewSession.removeListener('will-download', this.downloadListener);
        }
      } catch {
        // best effort
      }
    }
    this.downloadListener = null;
    this.previewSession = null;
    this.subscribers.clear();
  }

  private ensureSession(): Session {
    if (this.previewSession) return this.previewSession;
    const previewSession = session.fromPartition(this.partition);
    this.previewSession = previewSession;

    previewSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      callback(this.permissionAllowed(wc, permission, details.requestingUrl));
    });
    previewSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      return this.permissionAllowed(wc, permission, requestingOrigin);
    });
    // -3 means "use Chromium's own result": never trust invalid certificates,
    // and never let a renderer override verification.
    previewSession.setCertificateVerifyProc((_request, callback) => callback(-3));

    this.downloadListener = (event, item, webContents) => {
      this.handleDownload(event, item, webContents);
    };
    previewSession.on('will-download', this.downloadListener);

    // Protocol handlers are session-scoped.  Install the local preview scheme
    // on this partition only; the SPA's default session never needs it.
    if (this.options.protocolHandler) {
      previewSession.protocol.handle(PREVIEW_SCHEME, this.options.protocolHandler);
    }
    return previewSession;
  }

  private permissionAllowed(
    webContents: WebContents | null,
    permission: string,
    requestingUrl: string | undefined,
  ): boolean {
    if (!webContents || webContents.isDestroyed()) return false;
    if (!this.wcToTab.has(webContents.id)) return false;
    if (!this.allowedPermissions.has(permission)) return false;
    if (!requestingUrl) return false;
    return checkNavigation(requestingUrl, this.allowedOrigins, this.allowPreviewScheme).allowed;
  }

  private handleDownload(
    _event: Electron.Event,
    item: DownloadItem,
    webContents: WebContents,
  ): void {
    const tabId = this.wcToTab.get(webContents.id) ?? null;
    const filename = sanitizeFilename(item.getFilename());
    const totalBytes = Math.max(item.getTotalBytes(), 0);

    const deny = (): void => {
      item.cancel();
      this.emit({
        type: 'download',
        tabId,
        filename,
        state: 'denied',
        receivedBytes: 0,
        totalBytes,
      });
    };

    if (!this.allowDownloads || !this.downloadsDir) {
      deny();
      return;
    }

    let allowed = false;
    try {
      allowed = checkNavigation(item.getURL(), this.allowedOrigins, this.allowPreviewScheme).allowed;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      deny();
      return;
    }
    if (totalBytes > PREVIEW_LIMITS.maxDownloadBytes) {
      deny();
      return;
    }

    const target = join(
      this.downloadsDir,
      `${Date.now()}-${randomUUID().slice(0, 8)}-${filename}`,
    );
    try {
      mkdirSync(this.downloadsDir, { recursive: true });
      item.setSavePath(target);
    } catch {
      deny();
      return;
    }

    this.emit({
      type: 'download',
      tabId,
      filename,
      state: 'started',
      receivedBytes: 0,
      totalBytes,
    });
    item.once('done', (_doneEvent, state) => {
      this.emit({
        type: 'download',
        tabId,
        filename,
        state:
          state === 'completed'
            ? 'completed'
            : state === 'cancelled'
              ? 'cancelled'
              : 'interrupted',
        receivedBytes: item.getReceivedBytes(),
        totalBytes,
      });
    });
  }

  private bindWindow(window: BrowserWindow): void {
    if (this.boundWindows.has(window)) return;
    this.boundWindows.add(window);
    window.once('closed', () => {
      if (!this.disposed) this.dispose();
    });
  }

  private bindTab(record: TabRecord): void {
    const wc = record.view.webContents;
    const add = (remove: () => void): void => {
      record.listeners.push(remove);
    };

    wc.setWindowOpenHandler((details) => {
      this.emit({
        type: 'external-open',
        tabId: record.id,
        url: details.url.slice(0, PREVIEW_LIMITS.maxUrlLength),
      });
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (event) => {
      event.preventDefault();
    });

    const onWillNavigate = (details: Electron.Event<Electron.WebContentsWillNavigateEventParams>): void => {
      if (!details.isMainFrame) return;
      if (checkNavigation(details.url, this.allowedOrigins, this.allowPreviewScheme).allowed) {
        return;
      }
      details.preventDefault();
      this.emitBlocked(record, details.url);
    };
    wc.on('will-navigate', onWillNavigate);
    add(() => wc.off('will-navigate', onWillNavigate));

    const onWillRedirect = (details: Electron.Event<Electron.WebContentsWillRedirectEventParams>): void => {
      if (!details.isMainFrame) return;
      if (checkNavigation(details.url, this.allowedOrigins, this.allowPreviewScheme).allowed) {
        return;
      }
      details.preventDefault();
      this.emitBlocked(record, details.url);
    };
    wc.on('will-redirect', onWillRedirect);
    add(() => wc.off('will-redirect', onWillRedirect));

    const onStartLoading = (): void => {
      record.loading = true;
      record.error = null;
      record.crashed = false;
      this.emitState(record);
    };
    wc.on('did-start-loading', onStartLoading);
    add(() => wc.off('did-start-loading', onStartLoading));

    const onStopLoading = (): void => {
      record.loading = false;
      this.emitState(record);
    };
    wc.on('did-stop-loading', onStopLoading);
    add(() => wc.off('did-stop-loading', onStopLoading));

    const onNavigate = (): void => {
      record.error = null;
      this.emitState(record);
    };
    wc.on('did-navigate', onNavigate);
    add(() => wc.off('did-navigate', onNavigate));

    const onNavigateInPage = (
      _event: Electron.Event,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) this.emitState(record);
    };
    wc.on('did-navigate-in-page', onNavigateInPage);
    add(() => wc.off('did-navigate-in-page', onNavigateInPage));

    const onTitle = (_event: Electron.Event, title: string): void => {
      const next = title.trim().slice(0, PREVIEW_LIMITS.maxTitleLength);
      if (next.length === 0 || next === record.title) return;
      record.title = next;
      this.emitState(record);
    };
    wc.on('page-title-updated', onTitle);
    add(() => wc.off('page-title-updated', onTitle));

    const onFailLoad = (
      _event: Electron.Event,
      code: number,
      description: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      // -3 is ERR_ABORTED, expected when a new navigation supersedes this one.
      if (!isMainFrame || code === -3) return;
      record.loading = false;
      record.error = {
        code,
        description: description.slice(0, 200),
        url: validatedUrl.slice(0, PREVIEW_LIMITS.maxUrlLength),
      };
      this.emitState(record);
    };
    wc.on('did-fail-load', onFailLoad);
    add(() => wc.off('did-fail-load', onFailLoad));

    const onConsole = (
      details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    ): void => {
      const entry: PreviewConsoleEntry = {
        tabId: record.id,
        level: details.level as PreviewConsoleLevel,
        message: details.message.slice(0, PREVIEW_LIMITS.maxConsoleMessageLength),
        sourceId: details.sourceId.slice(0, PREVIEW_LIMITS.maxUrlLength),
        lineNumber: details.lineNumber,
        timestamp: Date.now(),
      };
      record.logs.push(entry);
      if (record.logs.length > PREVIEW_LIMITS.maxConsoleEntries) {
        record.logs.splice(0, record.logs.length - PREVIEW_LIMITS.maxConsoleEntries);
      }
      this.emit({ type: 'console', entry });
    };
    wc.on('console-message', onConsole);
    add(() => wc.off('console-message', onConsole));

    const onRenderGone = (): void => {
      record.loading = false;
      record.crashed = true;
      this.emitState(record);
    };
    wc.on('render-process-gone', onRenderGone);
    add(() => wc.off('render-process-gone', onRenderGone));

    const onDestroyed = (): void => {
      const current = this.tabs.get(record.id);
      if (current && current.webContentsId === record.webContentsId) {
        this.tabs.delete(record.id);
        this.wcToTab.delete(record.webContentsId);
        this.detachListeners(record);
        this.emit({ type: 'closed', tabId: record.id });
      }
    };
    wc.once('destroyed', onDestroyed);
    add(() => wc.off('destroyed', onDestroyed));
  }

  private detachListeners(record: TabRecord): void {
    for (const remove of record.listeners.splice(0)) {
      try {
        remove();
      } catch {
        // best effort
      }
    }
  }

  private destroyTab(record: TabRecord, emitClosed: boolean): void {
    this.detachListeners(record);
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(record.view);
      } catch {
        // best effort
      }
    }
    try {
      record.view.setVisible(false);
    } catch {
      // best effort
    }
    try {
      if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    } catch {
      // best effort
    }
    if (emitClosed) this.emit({ type: 'closed', tabId: record.id });
  }

  private applyBounds(record: TabRecord): void {
    const { width, height } = record.bounds;
    if (width <= 0 || height <= 0) {
      record.view.setVisible(false);
      return;
    }
    record.view.setBounds(record.bounds);
    record.view.setVisible(record.visible);
  }

  private clampBounds(bounds: PreviewBounds): PreviewBounds {
    const window = this.requireWindow();
    const content = window.getContentBounds();
    const maxWidth = Math.max(Math.min(content.width, PREVIEW_LIMITS.maxBoundsEdge), 0);
    const maxHeight = Math.max(Math.min(content.height, PREVIEW_LIMITS.maxBoundsEdge), 0);
    const width = clampInt(bounds.width, 0, maxWidth);
    const height = clampInt(bounds.height, 0, maxHeight);
    const x = clampInt(bounds.x, 0, Math.max(content.width - width, 0));
    const y = clampInt(bounds.y, 0, Math.max(content.height - height, 0));
    return { x, y, width, height };
  }

  private assertNavigable(rawUrl: string): string {
    const check = checkNavigation(rawUrl, this.allowedOrigins, this.allowPreviewScheme);
    if (!check.allowed) throw new PreviewError(`blocked-${check.reason}`);
    return new URL(rawUrl).href;
  }

  private emitBlocked(record: TabRecord, url: string): void {
    const check = checkNavigation(url, this.allowedOrigins, this.allowPreviewScheme);
    this.emit({
      type: 'blocked-navigation',
      tabId: record.id,
      url: url.slice(0, PREVIEW_LIMITS.maxUrlLength),
      reason: check.allowed ? 'shape' : check.reason,
    });
  }

  private snapshot(record: TabRecord): PreviewTabState {
    const wc = record.view.webContents;
    let url = 'about:blank';
    let canGoBack = false;
    let canGoForward = false;
    try {
      if (!wc.isDestroyed()) {
        url = wc.getURL() || url;
        canGoBack = wc.canGoBack();
        canGoForward = wc.canGoForward();
      }
    } catch {
      // A destroyed webContents fails reads; the cached state is still useful.
    }
    return {
      id: record.id,
      url,
      title: record.title,
      loading: record.loading,
      canGoBack,
      canGoForward,
      visible: record.visible,
      bounds: { ...record.bounds },
      partition: this.partition,
      error: record.error ? { ...record.error } : null,
      crashed: record.crashed,
    };
  }

  private emitState(record: TabRecord): void {
    this.emit({ type: 'state', state: this.snapshot(record) });
  }

  private emit(event: PreviewEvent): void {
    if (this.disposed) return;
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.('preview.listener-error', {
          message: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  }

  private requireTab(tabId: string): TabRecord {
    this.assertUsable();
    const record = this.tabs.get(tabId);
    if (!record) throw new PreviewError('unknown-tab');
    return record;
  }

  private requireWindow(): BrowserWindow {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) throw new PreviewError('window-unavailable');
    return window;
  }

  private assertUsable(): void {
    if (this.disposed) throw new PreviewError('disposed');
  }
}
