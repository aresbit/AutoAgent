# Browser / preview pane for AutoAgent — reference design

Status: **reference implementation only**. Nothing under `/home/tars/yysapp/AutoAgent`
was modified. This directory contains a main-process manager, a custom protocol,
typed IPC + preload, and a React 19 pane that can be moved into AutoAgent.

Target increment: **T0 preview pane**, with T1/T2 explicitly deferred. The design
follows the conventions in `docs/matebot-modernization/architecture.md`:
loopback-only backend, launch token in the main process, typed boundaries,
small surfaces and no generic bridges.

---

## 1. Architecture

```
┌──────────────────────────── AutoAgent renderer (SPA) ────────────────────────────┐
│ React 19                                                                          │
│                                                                                   │
│  PreviewPane.tsx                                                                  │
│   ┌───────────────────────────────────────────────────────────────────────────┐   │
│   │ tab strip · Back/Forward/Reload · address · Screenshot · Open · Logs      │   │
│   ├───────────────────────────────────────────────────────────────────────────┤   │
│   │ <div ref=viewport>                                          (empty in DOM) │   │
│   │        ▲ ResizeObserver → bounds (CSS px)                                  │   │
│   └────────┼──────────────────────────────────────────────────────────────────┘   │
│            │                                                                       │
│  previewClient.ts — validates every response/event, no generic IPC                │
└────────────┼───────────────────────────────────────────────────────────────────────┘
             │ contextBridge window.autoagentPreview (preload/preview-api.ts)
             │ ipcRenderer.invoke on fixed channels + one preview:event push channel
┌────────────▼───────────────────────────────────────────────────────────────────────┐
│ Electron main                                                                      │
│                                                                                    │
│  preview-ipc.ts                                                                    │
│    · sender = main window webContents + main frame + app origin                    │
│    · exact-key payload validation, bounds/URL/tab-id limits                        │
│    · errors reduced to preview:<code>                                              │
│                                                                                    │
│  preview-manager.ts                                                                │
│    Map<tabId, WebContentsView>                                                     │
│    session.fromPartition('persist:autoagent-preview')                              │
│    navigation policy · permissions · downloads · capturePage · console ring        │
│                                                                                    │
│  preview-protocol.ts          (optional, local files)                              │
│    autoagent-preview://<opaque-root-id>/<path>                                     │
│    realpath containment · MIME allowlist · CSP                                     │
└────────────┬───────────────────────────────────────────────────────────────────────┘
             │ one WebContentsView per tab, positioned over the viewport
┌────────────▼───────────────────────────────────────────────────────────────────────┐
│ Target content (untrusted)                                                         │
│   · separate renderer process per tab (Chromium site isolation)                    │
│   · dedicated persistent partition (cookies/storage/cache)                         │
│   · no preload, no Node, sandbox + contextIsolation                                │
│   · allowlisted https origins or autoagent-preview:// local roots                  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Invariants**

1. The renderer never receives `ipcRenderer`, a path, a filesystem primitive or a
   generic "invoke" function.
2. The preview content never receives the AutoAgent preload, the launch token, or
   the SPA origin.
3. All policy lives in the main process. The renderer can request, but cannot
   decide, a navigation, permission, download or external open.
4. Every IPC handler validates the sender and the payload before touching a view.

---

## 2. Why `WebContentsView` instead of an `<iframe>`

| Concern | `<iframe>` in the SPA | `WebContentsView` |
|---|---|---|
| Process isolation | Frame may share a process with the host depending on site isolation and scheme; a renderer exploit is closer to the SPA | Separate renderer process per view; still Chromium, but outside the host document |
| Host DOM access | With `allow-same-origin` the frame shares origin/storage; without it many sites break | No shared DOM, no host globals, no host CSS |
| `X-Frame-Options` / `frame-ancestors` | Many real sites refuse to be framed | Top-level navigation, so framing headers do not apply |
| Cookies/session | Shares the SPA session; `SameSite` and third-party policies interfere | Dedicated partition with its own cookie jar |
| Navigation control | `sandbox`/CSP only; cannot inspect or veto every redirect reliably | `will-navigate`, `will-redirect`, `setWindowOpenHandler` |
| Permissions | Browser prompt policy applies to the whole SPA origin | Per-session permission handlers, deny by default |
| Screenshots | Not possible directly; requires CDP or `html2canvas` hacks | `webContents.capturePage()` |
| Print/export | No | `webContents.printToPDF()` (T1) |
| Console | Not accessible without CDP | `console-message` event |
| Downloads | Browser default | `will-download`, explicit policy |
| Local HTML | `srcDoc` is convenient | Custom privileged scheme with path containment |
| Layout | Natural in-flow, auto-height | Manual bounds; native view renders above DOM |

AutoAgent already has the right tool for **inline artifact rendering**:
`frontend/src/features/artifacts/ArtifactFrame.tsx` uses
`sandbox="allow-scripts allow-forms"` (no `allow-same-origin`), injects a strict
CSP, and uses `srcDoc` plus a `postMessage` resize reporter. It cannot navigate
to real sites or share cookies, which is the point.

Use the iframe (keep ArtifactFrame) when:

- the content is a self-contained HTML artifact with no network or cookies;
- the pane should auto-size to content height;
- the surface is inside a scrolling transcript and must be a DOM element;
- there is no need for screenshots, downloads, history or a real origin.

Use `WebContentsView` (this design) when:

- the content is a real site or a multi-file local app;
- cookies, redirects, permissions or downloads matter;
- the pane needs history, console logs, screenshots or popout;
- the content must never be able to reach the SPA's DOM or storage.

`BrowserView` is the deprecated predecessor; Electron 41 has `WebContentsView`.
A `BrowserWindow`-based fallback (frameless child window positioned over the
pane) is possible for very old Electron versions but is **not implemented** here;
the manager requires `WebContentsView`.

---

## 3. Tier model and Claude Desktop mapping

### T0 — v1 (this reference)

- Local HTML/artifacts via `autoagent-preview://` or a single allowlisted HTTPS origin.
- Create/close; navigate; back/forward/reload; show/hide/focus; bounds.
- `capturePage` screenshot (with `ifChanged` hash); console ring buffer.
- External links: popups denied and surfaced to the renderer; explicit
  "Open in system browser" only for allowlisted URLs.
- Deny-by-default permissions and downloads.
- Cleanup on window close and `before-quit`.

### T1 — next

- Multi-tab persistence across pane hide/show (the manager already supports
  multiple tabs; persistence and restoration are UI/settings work).
- Download allowlist with a native save dialog; progress events.
- Popout: reparent a view into a second `BrowserWindow`, or create a dedicated
  manager for that window.
- PDF export through `printToPDF` (the counterpart of Claude Desktop's
  DesignPdf path).
- Clear preview browsing data (`session.clearStorageData` / `clearCache`).
- Address editing with a UI for the allowlist (backend endpoint below).
- Keyboard shortcuts and better focus/accessibility integration.

### T2 — explicit non-goals for v1

- Remote browser / CDP transport.
- Chrome extension bridge, native messaging host, Chrome login import.
- Framebuffer/VNC preview.
- Remote browser tools (`callRemoteBrowserTool` / `listRemoteBrowserTools`).
- Live stream (`armPreviewLiveStream`).

### Claude Desktop API mapping

Reference service surface (per the verified seeds): **Launch** (108 methods),
**BrowserNavigation** (3), **ChromeExtension** (7), **FramebufferPreview** (11),
plus a separate Rust/tokio Chrome native host and `claude-browser-shim.js`.

| Claude Desktop method | T0 equivalent here | Notes |
|---|---|---|
| `openPreviewTab` | `preview:create` | Returns a tab id and state |
| `closePreviewTab` / `closeAllPreviewTabs` | `preview:close` + pane cleanup | Closing all loops over owned ids |
| `navigatePreview` / `navigatePreviewFromModel` | `preview:navigate` | Model-originated calls must use the same allowlist |
| `loadHtmlPreview` / `loadHtmlPreviewContent` | `autoagent-preview://` root | Local root + `index.html`; no `data:` or `srcdoc` |
| `pickHtmlFile` | Native dialog + `registry.add` | Main process only; path never reaches renderer |
| `getPreviewTabs` / `getPreviewNavState` / `getPreviewUrl` | `preview:list` / state events | Redundant state; state is pushed |
| `goBack` / `goForward` / `refreshPreview` | `preview:back/forward/reload` | |
| `capturePreviewScreenshot(IfChanged)` | `preview:screenshot` | SHA-256 dedupe; `null` when unchanged |
| `previewConsoleLogs` | `preview:logs` + console events | Bounded ring buffer |
| `previewSnapshot` | `snapshot()` in the manager | URL/title/history/bounds/error |
| `exportPreview` | T1 `printToPDF` | |
| `openPreviewInBrowser` / `openExternalLinkInPreview` | `preview:open-external` | Allowlisted origins only |
| `addPreviewAllowedOrigin` / `clear` / `get` | `allowedOrigins` config | Backend/settings in T1; startup config in T0 |
| `detectServerCandidates` | T2 | Port scanning is out of scope |
| `callRemoteBrowserTool` / `listRemoteBrowserTools` | T2 | |
| `importChromeLogins` | T2 | Credential handling is out of scope |
| `clearPreviewBrowsingData` | T1 | |
| `armPreviewLiveStream` | T2 | |
| BrowserNavigation (3) | `back` / `forward` / `reload` | |
| ChromeExtension (7) | not copied | Native host + extension bridge |
| FramebufferPreview (11) | not copied | VNC-style path |

Claude Desktop's implementation choices that this design mirrors: a dedicated
partition per preview, permission handlers, navigation allowlists,
`capturePage` screenshots, `printToPDF` export, and a `WebContentsView`-based
surface. It does **not** mirror the Chrome native host, extension import,
framebuffer or remote browser services in v1.

---

## 4. State model

```ts
interface PreviewTabState {
  id: string;                 // opaque UUID; the renderer's only handle
  url: string;                // current committed URL
  title: string;              // page-title-updated, truncated
  loading: boolean;           // did-start/stop-loading
  canGoBack: boolean;         // webContents.canGoBack()
  canGoForward: boolean;      // webContents.canGoForward()
  visible: boolean;           // manager intent (view may be zero-sized)
  bounds: { x, y, width, height }; // CSS px relative to window content
  partition: string;          // persist:autoagent-preview
  error: { code, description, url } | null; // did-fail-load (main frame)
  crashed: boolean;           // render-process-gone
}
```

The manager also keeps, outside the IPC state:

- a per-tab console ring buffer (500 entries, messages truncated to 8 KiB);
- the last screenshot SHA-256 per tab (for `ifChanged`);
- the listener cleanup list per tab;
- the `webContents.id → tabId` map used to bind permissions and downloads.

Events are pushed on one channel as a union:

- `state` — a full snapshot after any change;
- `closed` — the tab disappeared (including renderer-initiated destruction);
- `console` — one console entry;
- `blocked-navigation` — a navigation was vetoed with `scheme|origin|shape`;
- `external-open` — the page called `window.open`/`target=_blank`; the view was denied;
- `download` — denied/started/completed/cancelled/interrupted.

Full snapshots keep the renderer simple and avoid a second delta protocol.

---

## 5. Security model

### 5.1 Session isolation

- `partition: 'persist:autoagent-preview'` (constant `PREVIEW_PARTITION`).
- Preview cookies, localStorage, IndexedDB, service workers and cache never
  share a session with the SPA.
- The SPA origin (`http://127.0.0.1:<port>`) is never reachable from a preview
  because `http:` is denied by the navigation policy unless explicitly enabled
  for loopback development. This prevents a previewed page from calling the
  backend with ambient credentials.

### 5.2 Renderer hardening

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
  `nodeIntegrationInSubFrames: false`, `webviewTag: false`, `webSecurity: true`,
  `allowRunningInsecureContent: false`, `plugins: false`, `disableDialogs: true`,
  `navigateOnDragDrop: false`.
- **No `preload`** is set on the view. The target document gets no bridge at all.
- `will-attach-webview` is prevented.
- DevTools are off unless `AUTOAGENT_PREVIEW_DEVTOOLS=1` (developer build only).

### 5.3 Navigation policy

`checkNavigation()` is the single policy function:

- only `https:` and (when enabled) `autoagent-preview://`;
- exact origin match against the allowlist, no path/wildcard matching in v1;
- credentials in URLs are rejected;
- `http:`, `file:`, `data:`, `blob:`, `javascript:`, `about:` and custom schemes
  are denied for user/model navigation;
- `will-navigate` and `will-redirect` both veto disallowed main-frame loads;
- `setWindowOpenHandler` always returns `{ action: 'deny' }` and emits an
  `external-open` event. The page cannot cause an automatic OS browser launch.
- `open-external` is an explicit renderer call and still requires an allowlisted
  origin; a page script cannot invoke it.

Subframes are not granted host privileges. Cross-origin frames a page creates
remain unprivileged and share the preview partition; T1 can add a
`will-frame-navigate` policy if a deployment needs stricter egress control.

The navigation allowlist does **not** restrict subresource requests. A
previewed page can still `fetch`, load images or beacon to arbitrary origins
(subject to normal CORS rules). It has no AutoAgent cookies, no launch token and
no host DOM, so the data it can send is limited to content it already has. A
strict egress proxy or Chromium network policy is a T2 deployment decision, not
part of this reference.

### 5.4 Permissions

- Both `setPermissionRequestHandler` and `setPermissionCheckHandler` deny unless
  the permission is in the explicit `allowedPermissions` set **and** the
  requesting origin is allowlisted.
- The handler also verifies the `webContents` belongs to a managed preview tab.
- Default set is empty. Granting `media`, `geolocation`, `notifications`,
  `clipboard-read`, `openExternal` etc. is an explicit deployment decision.

### 5.5 Downloads

- Denied by default (`item.cancel()`).
- When enabled: the URL must pass the navigation allowlist, the declared size
  must be below 512 MiB, the filename is sanitized (path separators, control
  characters, Windows-reserved characters, leading dots removed), and the target
  is a unique path inside `downloadsDir`.
- Downloads never auto-open. A future native save dialog should replace the
  fixed directory.

### 5.6 Custom scheme and local files

- `autoagent-preview://<rootId>/<path>`; `rootId` is an opaque UUID registered by
  the main process. The renderer never sends a filesystem path.
- `file://` is never enabled.
- Path handling: reject encoded separators, `.`/`..`, colons (Windows drive/ADS),
  NUL/control characters; decode per segment; deny hidden segments unless the
  root explicitly allows them.
- The handler resolves both root and file with `realpath` and requires the file
  to remain strictly inside the root, so symlinks cannot escape. Directory URLs
  map to `index.html` after the same containment check.
- Files are capped at 64 MiB and served with `nosniff`,
  `cross-origin-resource-policy: same-origin`, `no-store` and a restrictive CSP.
  Unknown extensions are `application/octet-stream`.

### 5.7 Certificate and proxy policy

- `setCertificateVerifyProc((_req, callback) => callback(-3))` uses Chromium's
  own verification result; invalid certificates are never trusted and the app
  never passes `--ignore-certificate-errors`.
- The preview uses the system proxy configuration. There is no renderer-facing
  proxy/PAC setter. A deployment that needs a fixed proxy should call
  `session.setProxy` in the main process before creating tabs.

### 5.8 IPC boundary

- Every handler checks `event.sender === mainWindow.webContents`, that the
  sender frame is the main frame, that it has no parent, and that its origin is
  the exact app origin. Preview content cannot call these channels.
- Payload objects reject unknown keys. Tab ids, URLs, bounds, log limits and
  timestamps are range-checked.
- Bounds are clamped to the window content area; the renderer cannot position a
  view outside the window or exceed 8192 px per edge.
- Errors become `Error('preview:<stable-code>')`; URLs, paths and Electron
  messages are not echoed to the renderer.
- There is no generic `invoke`/`send`; `preload/preview-api.ts` exposes only the
  methods listed in section 6.

### 5.9 Data leakage

- Console logs and screenshots can contain user data. They are sent only to the
  trusted SPA, never persisted by the manager. The pane's screenshot strip keeps
  the PNG in memory and offers an explicit download.
- The console ring buffer is bounded (500 entries × 8 KiB per tab).
- Titles and URLs are truncated. Logging hooks take structured fields, not page
  content.
- The partition persists by design; T1 must add "clear preview browsing data".

---

## 6. IPC surface

Channels are constants in `desktop/preview-contract.ts`.

| Channel | Payload | Result |
|---|---|---|
| `preview:create` | `{ url?, bounds?, show?, title? }` | `PreviewTabState` |
| `preview:close` | `{ tabId }` | `boolean` |
| `preview:list` | none | `PreviewTabState[]` |
| `preview:get-state` | `{ tabId }` | `PreviewTabState` |
| `preview:show` / `hide` / `focus` | `{ tabId }` | `PreviewTabState` |
| `preview:set-bounds` | `{ tabId, bounds }` | `PreviewTabState` |
| `preview:navigate` | `{ tabId, url }` | `PreviewTabState` |
| `preview:back` / `forward` / `reload` | `{ tabId }` | `PreviewTabState` |
| `preview:screenshot` | `{ tabId, ifChanged? }` | `PreviewScreenshot \| null` |
| `preview:logs` | `{ tabId, limit?, since? }` | `PreviewConsoleEntry[]` |
| `preview:open-external` | `{ tabId, url }` | `boolean` |
| `preview:event` (push) | `PreviewEvent` | — |

No handler accepts a filesystem path, arbitrary bounds, a permission name, a
download path or a session/partition override from the renderer.

---

## 7. Integration map to AutoAgent

| AutoAgent file | Change |
|---|---|
| `desktop/src/main.ts` | Import `registerPreviewScheme`; call it before `app.whenReady()` (next to `registerArtifactScheme`, line 40). After `createMainWindow`, build the protocol handler and pass it to `PreviewManager` (the handler is installed on the preview partition, because Electron protocol handlers are session-scoped). Create `PreviewManager` and `registerPreviewIpc`. In `shutdown()` call `preview.dispose()`; `dispose()` unhandles the scheme and clears the session hooks. |
| `desktop/src/window.ts` | No policy change. Export/derive `appOrigin(port)` for the IPC sender check. `createMainWindow` already uses safe `webPreferences`. |
| `desktop/src/preload.ts` | Import the preview API object and add `preview` to the exposed `api` object. Keep the fixed-channel policy; do not add a generic bridge. |
| `desktop/src/native/preview-contract.ts` | New. Shared types + validators. |
| `desktop/src/native/preview-manager.ts` | New. Main-process tabs. |
| `desktop/src/native/preview-ipc.ts` | New. Sender + payload validation. |
| `desktop/src/native/preview-protocol.ts` | New. `autoagent-preview://` handler + root registry. |
| `desktop/src/native/preview-api.ts` or `desktop/src/preview-api.ts` | New. Preload bridge implementation, imported by `preload.ts` (or fold it into `preload.ts`). |
| `desktop/build.mjs` | No new entry for the manager; it is bundled into `main.js` if imported. If the preload bridge stays a separate module, it is bundled into `preload.cjs`. Add `preview-protocol.js` to the test-build list if the project wants a Node-only protocol test (mirrors `artifact-protocol.js`). |
| `desktop/tsconfig.json` | Nothing if the files live under `src/`. |
| `frontend/src/features/preview/PreviewPane.tsx` | New. Copy and replace the inline styles with CDS/Tailwind tokens. |
| `frontend/src/features/preview/previewClient.ts` | New. Keep the runtime validators; mirror the contract. |
| `frontend/src/app/Shell.tsx` | Add a seventh `TabsTrigger value="preview"` and `TabsContent`; render `PreviewPane`. The tab list currently uses `grid-cols-3` (lines 395–398) — move to a 4-column/flex-wrap layout. Decide whether preview replaces the Artifacts tab or sits beside it. |
| `frontend/src/lib/native.ts` | Optional: the preview client declares `Window.autoagentPreview` itself, so no edit is required if `PreviewPane` owns the declaration. If types are centralized, add the bridge there. |
| `backend/src/autoagent_backend/api/static.py` | No CSP change required: `img-src 'self' data: blob:` already permits screenshot previews, and `WebContentsView` is not subject to the SPA CSP. Do not add `unsafe-eval`. |
| `backend` settings/route (optional T0, required T1) | Add `preview.allowed_origins` (list of bare https origins, max 50), `preview.allow_downloads` and `preview.allowed_permissions`; expose `GET /api/preview/config` under the existing auth. The desktop fails closed (empty allowlist) if the request fails. |
| Native file dialog | `pickHtmlFile` is a main-process action: use the existing `native:dialog:open` result in main, then `registry.add(directory)` and return the opaque root id/URL. Never return the path to the renderer. |

T0 can avoid backend work by reading a comma-separated
`AUTOAGENT_PREVIEW_ORIGINS` environment variable at startup. The backend
endpoint is the recommended T1 source of truth because it can be changed without
a restart and is already auth-gated.

---

## 8. Acceptance criteria

### T0 functional

- [ ] Open a local directory with `index.html`; relative CSS/JS/images load; no
      `file://` URL appears in the view.
- [ ] Open an allowlisted HTTPS site; Back/Forward/Reload reflect real history.
- [ ] Navigate to a non-allowlisted origin in the address bar: it is rejected and
      the current page is unchanged.
- [ ] A page that calls `window.open` produces an `external-open` notice and no
      new window.
- [ ] "Open" launches the current allowlisted URL in the system browser.
- [ ] Screenshot returns a PNG; a second immediate `ifChanged` capture returns
      `null`.
- [ ] Console messages appear in the drawer and are capped.
- [ ] Closing a tab removes the native view; closing the pane closes every tab.
- [ ] Hiding the pane (`display:none` or 0×0 bounds) hides the view; showing it
      restores the same page and history.
- [ ] App quit with open tabs leaves no renderer process behind.

### T0 security

- [ ] Preview content cannot call any `preview:*` channel (sender is a
      `WebContentsView`, not the main window).
- [ ] `window.require`, `process`, `Buffer` and `window.autoagentNative` are
      absent inside the preview.
- [ ] Camera/geolocation/notifications/clipboard requests are denied.
- [ ] Downloads are cancelled by default.
- [ ] A symlink inside a preview root pointing outside the root returns 403.
- [ ] `autoagent-preview://root/a%2fb` and encoded `..` segments are rejected.
- [ ] Redirect to a non-allowlisted origin is vetoed.
- [ ] No `nodeIntegration`, `webviewTag`, remote module or `eval` in the added
      code paths.

### T1 functional

- [ ] Tabs survive hiding the pane and app restart (restoration policy).
- [ ] Download allowlist, progress, cancel and native save dialog.
- [ ] Popout window and PDF export.
- [ ] Clear preview browsing data.
- [ ] Allowlist UI backed by the settings endpoint.

### Tests to add (not run here)

- Node-only unit tests for `parsePreviewUrl`, `previewUrl`,
  `PreviewRootRegistry`, the protocol handler, `normalizeAllowedOrigins`,
  `checkNavigation`, `sanitizeFilename`, and the IPC parsers.
- An Electron smoke test that creates a `WebContentsView`, loads a local page,
  captures a screenshot, and asserts cleanup after `dispose()`.
- A negative test that invokes IPC from a preview webContents and expects
  `preview:untrusted-sender`.

---

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Chromium 0-day in remote content | Renderer compromise | Keep Electron patched; sandbox; no preload; no Node; dedicated partition; allowlist |
| Bounds/DPI mismatch | View drifts from the pane | Report CSS px from `getBoundingClientRect`; manager clamps; lock renderer zoom or convert with `webContents.getZoomFactor()` in T1; test on HiDPI and Wayland |
| Native view covers DOM | Dialogs/overlays under the view are invisible | Keep all chrome outside the viewport; hide the view before showing modal UI; use a separate `BrowserWindow` for blocking dialogs |
| Focus/accessibility | Keyboard users can tab "into" an opaque native surface | Explicit focus transfer, focus rings on chrome, a visible "focus preview" action; audit with a screen reader in T1 |
| Persistent cookies/private data | Privacy leakage across sessions | Dedicated partition, clear-data action in T1, no SPA cookies |
| Allowlist drift | Sites redirect to login/CDN origins | Allow exact origins; surface blocked events; T1 settings UI; consider `will-frame-navigate` policy |
| Console/screenshot leakage | Sensitive data in memory or user downloads | Bounded buffers, no disk persistence by the manager, explicit download only |
| IPC event flood | Renderer jank from chatty console pages | Per-tab ring buffer exists; T1 adds batching/throttling |
| `capturePage` on hidden/occluded views | Blank or stale screenshots | Capture only the active tab; show/focus or document the limitation; test per platform |
| Local file server scope creep | Path disclosure | Opaque roots, `realpath` containment, no file://, no directory listing, MIME allowlist |
| Multi-tab z-order | Two visible views overlap | The pane hides the previous tab before showing the next; manager re-adds the shown view on top |
| Electron API churn | `WebContentsView`/event signatures change | Pin Electron 41.x; typecheck is part of the build; no deprecated `BrowserView` |

---

## 10. Verification performed for this reference

- `tsc --noEmit -p research/browser-integration/tsconfig.json` with the real
  Electron 41.3.0, React 19 `@types/react` and Node type declarations from
  AutoAgent's `node_modules`: **exit 0**.
- A Bun smoke test of the Electron-free protocol module verified:
  - parse of a valid URL → `{ rootId: 'testroot', segments: ['index.html'] }`;
  - `file:///etc/passwd` → `null`;
  - encoded slash `a%2fb` → `null`;
  - encoded dot traversal `%2e%2e` → `null`;
  - HTML served as `text/html` with the restrictive CSP;
  - CSS served as `text/css`;
  - missing file → 404;
  - symlink escaping the root → 403.
- A Bun smoke test of the policy functions (Electron module stubbed at import
  time) verified:
  - allowlist normalization to exact origins, including default-port collapse;
  - `https://example.com/a` and `autoagent-preview://root/index.html` allowed;
  - `http://`, `javascript:`, `file:` → `scheme`; a non-allowlisted origin →
    `origin`; embedded credentials and encoded-dot preview URLs → `shape`;
  - an `http://127.0.0.1` origin is rejected unless insecure dev mode is on;
  - `sanitizeFilename('../../etc/pa:ss\\wd?.txt')` → `wd_.txt`.
- No AutoAgent tests were run, no AutoAgent files were modified, and no Electron
  runtime test was run (the manager requires a running Electron app).

---

## 11. File map

```
research/browser-integration/
  README.md                       this document
  PATCH_PLAN.md                   exact AutoAgent edits, phases, rollback
  tsconfig.json                   reference-only typecheck config
  node_modules/                   symlinks to AutoAgent type packages (tsc only)
  desktop/
    preview-contract.ts           types, channel names, validators
    preview-manager.ts            WebContentsView tabs + policy + screenshot/logs
    preview-ipc.ts                sender/payload validation, channel registration
    preview-protocol.ts           autoagent-preview:// registry + handler
  preload/
    preview-api.ts                contextBridge surface (fixed methods only)
  frontend/
    previewClient.ts              typed validated client + event subscription
    PreviewPane.tsx               React 19 pane
```
