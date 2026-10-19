# Patch plan — integrate the preview pane into AutoAgent

This plan is written against the actual tree at `/home/tars/yysapp/AutoAgent`
(Electron 41.3.0, FastAPI backend, React 19 + Vite). Nothing in this plan has
been applied. All new code is in `/home/tars/yysapp/claude-desktop/research/browser-integration/`.
Line numbers were captured while inspecting the tree; re-locate by symbol if the
file has changed since (the tree is being edited concurrently by other work).

Guiding rules from `docs/matebot-modernization/architecture.md`:

- the main process owns OS capabilities and policy; the SPA gets only typed DTOs;
- no generic IPC, no filesystem/exec bridges, no token in preview content;
- `extra="forbid"` on new request schemas;
- one adapter/feature per reason to change;
- no AutoAgent tests are claimed until they are actually run.

---

## 0. Feature flag and prerequisites

- Electron must remain `>= 30` for `WebContentsView`; the current pin (41.3.0)
  is sufficient. Do not add a deprecated `BrowserView` path.
- Gate the main-process wiring at runtime:

  ```ts
  const previewEnabled = process.env.AUTOAGENT_PREVIEW !== '0'
  ```

  A second, build-time flag hides the UI:

  ```
  VITE_PREVIEW=1   # frontend build
  ```

  Rollback is then a rebuild (hide tab) or a restart with
  `AUTOAGENT_PREVIEW=0` (fail closed).
- Default allowlist is empty. A preview with no local root and no allowlisted
  origin can only show `about:blank`.
- T0 reads the allowlist from `AUTOAGENT_PREVIEW_ORIGINS` (comma-separated bare
  https origins). The backend settings source in T1 supersedes it.
- The preview must not be created before `app.whenReady()`. The protocol scheme
  must be registered before ready (same constraint as `autoagent-artifact`).

---

## 1. T0 — files to add

Copy from this reference directory, adjusting imports for the target layout:

| Reference file | AutoAgent destination | Adjustment |
|---|---|---|
| `desktop/preview-contract.ts` | `desktop/src/native/preview-contract.ts` | none |
| `desktop/preview-manager.ts` | `desktop/src/native/preview-manager.ts` | none |
| `desktop/preview-ipc.ts` | `desktop/src/native/preview-ipc.ts` | none |
| `desktop/preview-protocol.ts` | `desktop/src/native/preview-protocol.ts` | none |
| `preload/preview-api.ts` | `desktop/src/preview-api.ts` | change `../desktop/preview-contract.js` to `./native/preview-contract.js` |
| `frontend/previewClient.ts` | `frontend/src/features/preview/previewClient.ts` | none; keep the mirrored types in sync |
| `frontend/PreviewPane.tsx` | `frontend/src/features/preview/PreviewPane.tsx` | replace the inline neutral palette with CDS/Tailwind tokens |
| `tsconfig.json` | not copied | reference-only typecheck config |

Do not copy `node_modules/` symlinks or `tsconfig.json` into AutoAgent.

The frontend and desktop contract are duplicated on purpose because the two
projects have separate `tsconfig.json` files. T0 adds a small check to CI:

```bash
# Compare the exported interface blocks and PREVIEW_LIMITS between
# desktop/src/native/preview-contract.ts and
# frontend/src/features/preview/previewClient.ts.
# A generated type package is the T2 alternative if drift becomes a problem.
```

---

## 2. T0 — exact modifications

### 2.1 `desktop/src/main.ts`

Add imports:

```ts
import { PreviewManager } from './native/preview-manager.js'
import { registerPreviewIpc, type PreviewIpcRegistration } from './native/preview-ipc.js'
import {
  PreviewRootRegistry,
  createPreviewProtocolHandler,
  registerPreviewScheme,
} from './native/preview-protocol.js'
```

Before `app.whenReady()` (next to the existing `registerArtifactScheme(protocol)`
at line 40):

```ts
registerPreviewScheme(protocol)
```

Add module-level handles next to `artifactRegistry`:

```ts
let previewManager: PreviewManager | null = null
let previewIpc: PreviewIpcRegistration | null = null
let previewRoots: PreviewRootRegistry | null = null
```

Inside `boot()`, after `mainWindow = createMainWindow(...)` and before
`logger.info('app.ready', ...)`:

```ts
if (process.env.AUTOAGENT_PREVIEW !== '0') {
  previewRoots = new PreviewRootRegistry()
  const previewProtocol = createPreviewProtocolHandler({
    registry: previewRoots,
    onError: (event, detail) => logger.warn(event, { detail }),
  })
  previewManager = new PreviewManager({
    getWindow: () => mainWindow,
    allowedOrigins: parsePreviewOrigins(process.env.AUTOAGENT_PREVIEW_ORIGINS),
    protocolHandler: previewProtocol, // session-scoped, see below
    allowDownloads: process.env.AUTOAGENT_PREVIEW_DOWNLOADS === '1',
    downloadsDir: join(paths.dataDir, 'preview-downloads'),
    logger: (event, detail) => logger.info(event, detail ?? {}),
  })
  previewIpc = registerPreviewIpc({
    manager: previewManager,
    getWindow: () => mainWindow,
    getAppOrigin: () => appOrigin(handle.port),
    logger: (event, detail) => logger.warn(event, detail ?? {}),
  })
}
```

`appOrigin(port)` currently lives in `desktop/src/window.ts` as a private
function (line 25). Export it, or duplicate the one-line template literal in
`main.ts`. It must return exactly `http://127.0.0.1:<port>`.

`parsePreviewOrigins` should split on commas, trim, drop empty entries, and let
`normalizeAllowedOrigins` reject the rest. **Fail closed**: on a configuration
error, log `preview.config.invalid` and use `[]` rather than crashing the app.

In `shutdown()`, before destroying windows:

```ts
try {
  previewIpc?.unregister()
  previewIpc = null
} catch { /* best effort */ }
try {
  previewManager?.dispose()
  previewManager = null
  previewRoots?.clear()
  previewRoots = null
} catch { /* best effort */ }
```

`dispose()` removes child views, clears permission/download hooks and unhandles
`autoagent-preview` on the preview session. Do **not** call
`protocol.unhandle(PREVIEW_SCHEME)` on the default session: the handler was never
installed there.

Why the protocol handler is passed to the manager: Electron protocol handlers
are scoped to a `Session`. The preview uses
`session.fromPartition('persist:autoagent-preview')`, so a handler registered on
the default session would never see preview requests. This is the same reason
`native/artifact.ts` registers its handler per artifact partition
(`ensureProtocol`, lines 116–121).

### 2.2 `desktop/src/preload.ts`

Add one static side-effect import at the top:

```ts
import './preview-api.js'
```

`preview-api.ts` already calls
`contextBridge.exposeInMainWorld('autoagentPreview', api)`. Do not add the
preview methods to the `autoagentNative` object, and do not add a generic
`invoke` method. If the bundler tree-shakes the import, add the module to the
preload entry list in `desktop/build.mjs` explicitly.

The preview target never loads this preload: `PreviewManager` passes no
`preload` in `webPreferences`.

### 2.3 `frontend/src/app/Shell.tsx`

1. Import the pane and an icon:

   ```tsx
   import { Globe } from "lucide-react";
   import { PreviewPane } from "@/features/preview/PreviewPane";
   ```

2. Add a trigger. The current `TabsList` uses `grid grid-cols-3` with six
   triggers (lines 395–423); seven triggers need a different layout:

   ```tsx
   <TabsList
     label="Control panels"
     className="flex flex-1 flex-wrap gap-0.5 rounded-card p-0.5"
   >
     {/* existing triggers */}
     <TabsTrigger value="preview" className="justify-center px-1">
       <Globe size={12.5} strokeWidth={2} />
       Preview
     </TabsTrigger>
   </TabsList>
   ```

3. Add content:

   ```tsx
   <TabsContent
     value="preview"
     className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
   >
     <PreviewPane />
   </TabsContent>
   ```

   Keep the `data-[state=inactive]:hidden` class. When the tab is inactive, the
   viewport becomes 0×0, the ResizeObserver reports zero bounds and the manager
   hides the native view. Do not use a CSS transform or `visibility` instead of
   `display:none`; a native view is not clipped by the DOM.

4. Optional: put the pane behind `import.meta.env.VITE_PREVIEW === "1"` so a
   normal frontend build does not ship an unusable tab.

The right panel is narrow. T0 can show Preview as a full-width surface by
temporarily replacing the Artifacts tab; T1 should introduce a dedicated
"workbench" area with a larger minimum width. Do not shrink the tab labels into
unreadable text.

### 2.4 `desktop/build.mjs` (optional, only for protocol tests)

To mirror `artifact-protocol.js` as a Node-testable module:

```js
function buildPreviewProtocolForTests() {
  run([
    'build',
    join(src, 'native', 'preview-protocol.ts'),
    '--outfile', join(dist, 'preview-protocol.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
}
```

Call it next to `buildArtifactProtocolForTests()` and add the output to
`verify()`.

### 2.5 Local roots and `pickHtmlFile`

There is no new backend endpoint required to preview a local file:

1. renderer calls the existing `native:dialog:open` (or `autoagentNative.dialogs.openFile`);
2. main receives the path, resolves it, checks it is a file or directory under
   an allowed grant root;
3. main calls `previewRoots.add(directory, { label })` and returns
   `preview://<rootId>/index.html` (or the selected file's relative path);
4. the renderer calls `preview.create({ url })`.

Never return the absolute path to the renderer. If the selected file is
`report.html`, add its parent directory and use `previewUrl(rootId, "report.html")`.
Reject paths outside the grant before calling `registry.add`.

### 2.6 CSP

No change is required in T0:

- `backend/src/autoagent_backend/api/static.py` already sets
  `img-src 'self' data: blob:`, which allows the screenshot strip.
- `frame-src 'self' data:` remains for `ArtifactFrame`; it does not apply to
  `WebContentsView`.
- The custom scheme handler sets its own CSP for HTML and SVG.
- Do not add `unsafe-eval` or `unsafe-inline` to `script-src` in the SPA CSP.
- Keep `ARTIFACT_CSP` in `frontend/src/features/artifacts/ArtifactFrame.tsx`
  unchanged.

---

## 3. T0 acceptance gate

Ship only when all of these pass on Linux/X11, Linux/Wayland and one HiDPI
display:

Functional:

1. Local directory with `index.html`, CSS, JS and an image renders; the address
   reads `autoagent-preview://...`, never `file://`.
2. Allowlisted HTTPS navigation, back/forward/reload, and title updates work.
3. Non-allowlisted navigation and redirects are vetoed; the current page stays.
4. `window.open` yields a notice and no new window.
5. Screenshot + `ifChanged` dedupe work; the PNG can be saved.
6. Console messages appear and stay bounded after 1,000 messages.
7. Closing the pane closes every tab; app quit leaves no preview renderer.
8. Pane hide/show restores the same URL and history.
9. Bounds track pane resizes, sidebar toggles, window resize/maximize and tab
   switches.

Security:

10. In the preview, evaluate from DevTools (if enabled in a dev build):
    `typeof require`, `typeof process`, `typeof window.autoagentNative` are
    `undefined`, and `window.autoagentPreview` is `undefined`.
11. A script in preview content cannot invoke `preview:*` (untrusted sender).
12. Camera/geolocation/notifications/clipboard prompts are denied.
13. Downloads are cancelled by default.
14. Symlink escape and encoded path tricks return 403/400.
15. `tsc --noEmit` passes for both desktop and frontend.

Add these tests (not run in this reference):

- Node-only: protocol parser/handler, `normalizeAllowedOrigins`,
  `checkNavigation`, `sanitizeFilename`, IPC parsers.
- Electron smoke: view creation, screenshot, cleanup; a negative IPC sender test.
- Frontend: `previewClient` validators and `PreviewPane` event reducer.

---

## 4. T1 — next increment

### 4.1 Backend preview configuration (recommended allowlist source)

Add to `backend/src/autoagent_backend/domain/models.py`:

```python
@dataclass(frozen=True, slots=True)
class PreviewSettings:
    allowed_origins: tuple[str, ...] = ()
    allow_downloads: bool = False
    allowed_permissions: tuple[str, ...] = ()
```

Add `preview: PreviewSettings = field(default_factory=PreviewSettings)` to
`Settings` and `preview: PreviewSettings | None = None` to `SettingsPatch`.

Add to `backend/src/autoagent_backend/api/schemas.py`:

```python
class PreviewSettingsInput(StrictModel):
    allowedOrigins: list[str] = Field(default_factory=list, max_length=50)
    allowDownloads: bool = False
    allowedPermissions: list[str] = Field(default_factory=list, max_length=20)
```

Validators: each origin must parse as a bare `https://host[:port]` origin
(no credentials, no path, no wildcard); each permission must be in a fixed
allowlist of Electron permission names. Convert to/from the domain type in
`to_settings_view` and `to_domain_patch`.

Add to `backend/src/autoagent_backend/api/routes/settings.py` (or a new
`preview.py` router included in `app.py`):

```python
@router.get("/api/preview/config")
def preview_config(container: Container = Depends(get_container)) -> dict:
    settings = container.settings_service.read()
    return {
        "origins": list(settings.preview.allowed_origins),
        "allowDownloads": settings.preview.allow_downloads,
        "allowedPermissions": list(settings.preview.allowed_permissions),
    }
```

The desktop fetches this once at boot with the bearer token, validates every
field again (never trust the backend response shape), and fails closed to `[]`.
This endpoint must stay behind the normal auth dependency; do not exempt it in
`api/deps.py`.

`adapters/persistence/settings_store.py` needs the new JSON keys in its
read/write mapping; unknown keys are preserved already, but the new typed fields
must round-trip.

### 4.2 Downloads

- Add a native save dialog in the `will-download` path instead of a fixed
  directory.
- Emit progress (`item.on('updated')`) with throttling; never send the path.
- Refuse executable MIME types or a configurable extension denylist.
- Add cancel (`item.cancel()`).

### 4.3 Popout

A `WebContentsView` can only have one parent. To pop out:

1. hide the view in the pane and `removeChildView` it;
2. create a `BrowserWindow` with a `contentView` and add the same view;
3. move the pane back by reversing the operation.

Document that the popout window must use the same partition and never gets the
AutoAgent preload. The `PreviewManager` needs a second window handle for bounds
and focus, or a separate manager instance. Do not duplicate the session handlers
for the same partition.

### 4.4 PDF, clear data, persistence

- `webContents.printToPDF({ printBackground: true })` → return base64 or write
  through a native save dialog. Enforce a size cap.
- `session.fromPartition(PREVIEW_PARTITION).clearStorageData()` +
  `clearCache()` exposed through a new fixed IPC channel with a confirmation.
- Tab restoration: persist `{ url, title, rootId }` only, never cookies or page
  content; restore on app start behind the same allowlist.

### 4.5 UX/accessibility

- Replace the inline palette with CDS tokens (`material`, `hairline-b`,
  `bg-panel`, `text-ink`, focus rings).
- Add a visible "Focus preview" action and return focus to the pane chrome on
  Escape.
- Ensure the address input has an IME composition guard if it ever submits on
  Enter in a composed state.
- Add keyboard shortcuts only when focus is in the preview chrome, not inside
  the native view.

---

## 5. T2 — explicitly not in this patch

Do not copy or port:

- **Chrome native messaging host** (Rust/tokio binary) and
  `claude-browser-shim.js`. It requires a separate process, host manifest,
  extension IDs and a trust model that AutoAgent does not need for T0/T1.
- **Chrome extension bridge** (BrowserExtension 7 methods) and
  **`importChromeLogins`**. Credential extraction (Keychain/DPAPI) is a large
  security surface.
- **FramebufferPreview / VNC/WebRTC streaming** and `armPreviewLiveStream`.
- **Remote browser / CDP transport**, `callRemoteBrowserTool`,
  `listRemoteBrowserTools`, `detectServerCandidates`.
- **DesignPdf** as a dependency. Use Electron's `printToPDF` when export is
  needed.
- Any `eval`, generic `ipcRenderer.invoke`, `nodeIntegration`, remote module, or
  preload injected into target content.

These can be revisited only with a separate threat model and explicit sign-off.

---

## 6. Rollback

1. **Runtime kill switch**: restart with `AUTOAGENT_PREVIEW=0`. Main skips
   manager/IPC/protocol registration; no preview renderer is created.
2. **UI rollback**: rebuild the frontend without `VITE_PREVIEW=1` (or remove the
   trigger/content from `Shell.tsx`).
3. **Source rollback**:
   - delete `desktop/src/native/preview-*.ts`, `desktop/src/preview-api.ts`;
   - remove the `registerPreviewScheme` call, boot wiring and shutdown calls in
     `main.ts`;
   - remove the side-effect import in `preload.ts`;
   - remove `features/preview/` and the Shell trigger/content.
4. **Data cleanup** (optional, not required for rollback):
   - `session.fromPartition(PREVIEW_PARTITION).clearStorageData()` +
     `clearCache()`;
   - the partition lives under Electron's userData
     (`<paths.dataDir>/Partitions/autoagent-preview`); deleting it while the app
     is stopped removes cookies and storage.
   - if T1 added backend settings fields, leaving them in the SQLite/JSON
     document is harmless; add a migration only if the schema is strict about
     unknown keys.
5. No database migration is required for T0. No existing route changes in T0.

---

## 7. Observability

Log structured events (no page content, no full URLs with queries, no tokens):

```
preview.tab.created      { tabId }
preview.tab.closed       { tabId, reason }
preview.navigation.blocked { tabId, reason }
preview.permission.denied  { permission }
preview.download.denied    { reason }
preview.renderer.gone      { tabId, reason, exitCode }
preview.capture.failed     { tabId, code }
preview.ipc.rejected       { channel, code }
```

Add rate limiting for `navigation.blocked` and `console` events. Alert on
`renderer.gone` frequency; it is the best signal of hostile preview content.

---

## 8. Review checklist (copy into the PR)

- [ ] No AutoAgent file outside the list above is touched.
- [ ] `desktop/src/native/preview-manager.ts` has no `preload` in the view's
      `webPreferences`.
- [ ] `nodeIntegration`, `webviewTag`, remote module and `eval` do not appear in
      the diff.
- [ ] Every new IPC handler calls `assertTrustedSender`.
- [ ] Every new request schema/parser rejects unknown keys and range-checks
      numbers.
- [ ] `normalizeAllowedOrigins` is called at startup and fails closed.
- [ ] The protocol handler is installed on `PREVIEW_PARTITION`, not the default
      session.
- [ ] `will-navigate`, `will-redirect`, `setWindowOpenHandler`,
      `will-attach-webview`, both permission handlers and `will-download` are
      bound.
- [ ] Cleanup runs on tab close, window close and `before-quit`.
- [ ] `tsc --noEmit` passes for `desktop/` and `frontend/`.
- [ ] New tests cover the pure policy modules and the negative IPC sender case.
- [ ] No claim of passing AutoAgent integration tests until they have run.
