# AutoAgent integration patch plan

This plan applies the reference implementation in this directory to
`/home/tars/yysapp/AutoAgent`. **No AutoAgent file has been modified.** All
reference code lives under
`/home/tars/yysapp/claude-desktop/research/fs-integration/`.

The design follows the conventions in
`docs/matebot-modernization/architecture.md`:

- `application/` and `domain/` stay framework-free.
- `adapters/` own operating-system I/O; `composition.py` is the only place that
  constructs a concrete adapter.
- `api/` parses, delegates and serialises; the SPA sees HTTP DTOs only.
- The SPA never receives absolute server paths.
- `static_api.router` remains the last included router.

---

## 0. Inventory of reference files

| Reference file | Destination | Change kind |
|---|---|---|
| `backend/file_service.py` | `backend/src/autoagent_backend/adapters/files/safe_file_service.py` | new |
| `backend/file_router.py` | `backend/src/autoagent_backend/api/routes/file_router.py` | new |
| `backend/test_file_service.py` | `backend/tests/unit/test_file_service.py` | new (adjust import) |
| `frontend/fileClient.ts` | `frontend/src/features/files/fileClient.ts` | new |
| `frontend/useFileTree.ts` | `frontend/src/features/files/useFileTree.ts` | new |
| `frontend/FileBrowser.tsx` | `frontend/src/features/files/FileBrowser.tsx` | new |
| `frontend/check/*` | **not copied** | out-of-tree tsc harness only |

New package marker: `backend/src/autoagent_backend/adapters/files/__init__.py`
(empty docstring).

---

## 1. Backend patches

### 1.1 `adapters/files/safe_file_service.py` (new)

Copy `backend/file_service.py` unchanged. It imports only the standard library
and passes the import-linter "domain and application are framework-free"
contract trivially (it is in `adapters/`).

If the team prefers one service module in `application/`, keep the code
unchanged but register a port; do **not** move raw `os.open` calls into
`application/`.

### 1.2 `api/routes/file_router.py` (new)

Copy `backend/file_router.py`, then change only the imports:

```python
# before (reference copy, same directory)
from .file_service import (...)

# after (package layout)
from ...adapters.files.safe_file_service import (
    DirListing,
    FileBytes,
    FileEntry,
    FileServiceError,
    FileStat,
    FileText,
    SafeFileService,
    WriteResult,
)
```

Keep `from ..deps import get_container`. Do not import the concrete service in
`deps.py` at runtime; use `TYPE_CHECKING` there.

**Dependency warning (verified):** AutoAgent's backend does not depend on
`python-multipart`. Declaring FastAPI `Form`/`File`/`UploadFile` parameters
raises `RuntimeError: Form data requires "python-multipart" to be installed`
while the router module is being imported, which would break the whole app. The
reference router therefore uploads a **raw `application/octet-stream` body**
with query parameters. If multipart is required later, add `python-multipart` to
`pyproject.toml` and regenerate `uv.lock` first.

Optional refactor: move the DTO classes (`FileEntryView` … `RevealResponse`) to
`api/schemas.py` to match the existing single-boundary-DTO convention. Keep
`extra="forbid"` and camelCase field names.

### 1.3 `api/deps.py`

Add a getter next to the existing ones:

```python
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..adapters.files.safe_file_service import SafeFileService


def get_file_service(request: Request) -> SafeFileService:
    return get_container(request).file_service
```

The module-level auth gate (`authorize_request`) is unchanged. The router's
`_require_loopback` dependency adds a defence-in-depth peer check.

### 1.4 `composition.py`

Add a `Container` field:

```python
from .adapters.files.safe_file_service import SafeFileService

@dataclass(slots=True)
class Container:
    ...
    file_service: SafeFileService
```

Construct exactly one instance after `settings_store` exists:

```python
def _workspace_root(root_id: str) -> Path | None:
    if root_id != "workspace":
        return None
    configured = settings_store.read().cwd.strip()
    return (Path(configured) if configured else config.default_cwd).expanduser()


def _is_allowed_workspace(candidate: Path) -> bool:
    configured = settings_store.read().cwd.strip()
    root = (Path(configured) if configured else config.default_cwd).expanduser()
    try:
        return candidate == root.resolve()
    except OSError:
        return False


file_service = SafeFileService(
    _workspace_root,
    _is_allowed_workspace,
    default_root_id="workspace",
    # T1: is_writable_root=... for session roots
    max_read_bytes=config.file_max_read_bytes,
    max_write_bytes=config.file_max_write_bytes,
)
```

Pass `file_service=file_service` to the `Container(...)` call.

Important: `BootConfig.default_cwd` defaults to `Path.home()`. T0 must prefer
the user's configured `settings.cwd`. If it is empty, prompt for a workspace
through a native dialog and persist it; do not silently expose the whole home
directory.

### 1.5 `config.py`

Add immutable limits (T0 can hard-code the same values):

```python
FILE_MAX_READ_BYTES = 2 * 1024 * 1024
FILE_MAX_WRITE_BYTES = 1024 * 1024

@dataclass(frozen=True, slots=True)
class BootConfig:
    ...
    file_max_read_bytes: int = FILE_MAX_READ_BYTES
    file_max_write_bytes: int = FILE_MAX_WRITE_BYTES
```

Parse `AUTOAGENT_FILE_MAX_READ_BYTES` / `AUTOAGENT_FILE_MAX_WRITE_BYTES` in
`config_from_env` with the same validation style as `_parse_int`.

### 1.6 `app.py`

```python
from .api.routes import (
    ...,
    file_router,
)
...
app.include_router(workspace.router)
app.include_router(file_router.router)   # add here
app.include_router(artifacts.router)
...
# static_api.router stays last
```

Registration order matters: the SPA catch-all in `static.py` must never shadow
`/api/files/*`.

### 1.7 `api/deps.py` — body-size cap for uploads

`MAX_BODY_BYTES = 1024 * 1024` currently rejects **every** `/api/*` body over
1 MiB before routing. Change the check to be path-aware:

```python
_STREAMED_UPLOAD_PATHS = {"/api/files/upload"}
...
limit = (
    None
    if path in _STREAMED_UPLOAD_PATHS
    else MAX_BODY_BYTES
)
if limit is not None and length is not None:
    ...
```

The service enforces `max_write_bytes` while streaming, so an absent/lying
`Content-Length` cannot exceed the cap. Keep the 1 MiB cap for JSON
`PUT /api/files/content`; text bodies are small.

Alternative: compare upload `Content-Length` against
`config.file_max_write_bytes` instead of skipping the check. Either way, do not
raise the global cap for all `/api/*` routes. The router also counts streamed
bytes and returns 413 before the service cap is reached.

### 1.8 `errors.py` (recommended)

Preserve stable `code` values for direct service callers:

```python
from .adapters.files.safe_file_service import FileServiceError

@app.exception_handler(FileServiceError)
async def handle_file_error(
    request: Request, exc: FileServiceError
) -> JSONResponse:
    del request
    return error_response(exc.status, exc.code, exc.message)
```

`file_router.py` already converts via `_call`, so this is defence in depth.

### 1.9 Tests

- Unit: copy `test_file_service.py` to
  `backend/tests/unit/test_file_service.py` and replace the `sys.path` bootstrap
  with:
  ```python
  from autoagent_backend.adapters.files.safe_file_service import (...)
  ```
- Integration (T1): add
  `backend/tests/integration/test_file_routes.py` using `TestClient`:
  ```python
  app = create_app(config)
  with TestClient(app) as client:
      ...
  ```
  The `_require_loopback` dependency sees `testclient`; override it in the test:
  ```python
  app.dependency_overrides[_require_loopback] = lambda: None
  ```
  or construct the app's `app.state.file_service` with a `tmp_path` root and
  patch `request.client.host` via an ASGI wrapper. Cover 400 `..`, 403 symlink,
  404 missing, 409 hash mismatch, 413 oversize, 206 Range, raw streaming upload.

---

## 2. Frontend patches

### 2.1 `frontend/src/features/files/` (new)

Copy the three reference modules:

- `fileClient.ts`
- `useFileTree.ts`
- `FileBrowser.tsx`

The `@/` imports resolve to the real AutoAgent modules; the reference
`frontend/check/stubs` directory is **not** part of the integration.

### 2.2 `frontend/src/api/client.ts`

`initLaunchToken()` currently stores the token privately and does not return it.
Either:

```ts
export function initLaunchToken(): string | null {
  ...
  if (!token) return null;
  launchToken = token;
  ...
  return token;
}
```

or export a read-only getter:

```ts
export function launchTokenValue(): string | null {
  return launchToken;
}
```

### 2.3 `frontend/src/main.tsx`

```ts
import { ensureSessionCookie, initLaunchToken } from "./api/client";
import { setFileAuthToken } from "./features/files/fileClient";

const token = initLaunchToken();
setFileAuthToken(token);
void ensureSessionCookie().catch(() => undefined);
```

The backend also accepts the `autoagent_token` cookie, so the file client works
without this when the cookie is already set. The explicit token covers the
query-parameter bootstrap path.

### 2.4 `frontend/src/app/Shell.tsx`

Imports:

```ts
import { FolderOpen } from "lucide-react";
import { FileBrowser } from "@/features/files/FileBrowser";
import { FileClient } from "@/features/files/fileClient";
```

Create one client at module scope (or in `Workspace` and pass it down):

```ts
const fileClient = new FileClient();
```

Add a tab trigger after Workspace:

```tsx
<TabsTrigger value="files" className="justify-center px-1">
  <FolderOpen size={12.5} strokeWidth={2} />
  Files
</TabsTrigger>
```

Add the content after the Workspace content:

```tsx
<TabsContent
  value="files"
  className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
>
  <FileBrowser
    client={fileClient}
    root="workspace"
    rootLabel={workspace.workDir}
  />
</TabsContent>
```

The existing `workspace` tab (git status/diff) remains unchanged. The tab list
uses `grid-cols-4`; eight tabs wrap to two rows without further changes.

### 2.5 `frontend/src/lib/native.ts` (T1)

Extend `NativeBridge` with the scoped shell operation:

```ts
interface NativeBridge {
  ...
  shell: {
    openExternal: (url: string) => Promise<boolean>;
    showItemInFolder: (path: string) => Promise<boolean>; // native-dialog grants
    revealInWorkspace: (request: {
      root: string;
      path: string;
    }) => Promise<boolean>; // T1
  };
}

export async function revealInWorkspace(
  request: { root: string; path: string },
): Promise<boolean | null> {
  const bridge = nativeBridge();
  if (!bridge) return null;
  return bridge.shell.revealInWorkspace(request);
}
```

### 2.6 Desktop reveal bridge (T1)

Current state:

- `desktop/src/preload.ts` exposes `shell.showItemInFolder(path)`.
- `desktop/src/native/shell.ts` implements `native:shell:show-item` with only a
  non-empty-string check. It accepts any absolute path from the renderer.
- `desktop/src/backend-manager.ts` owns the launch token and backend process.

Do **not** use `showItemInFolder` for workspace paths, because the renderer
would need the absolute path. Add a scoped channel:

```ts
// desktop/src/native/shell.ts
export function registerShell(resolve: (request: WorkspaceRevealRequest) => Promise<string>): void {
  ipcMain.handle('native:shell:reveal-workspace', async (_event, raw: unknown) => {
    const request = validateRevealRequest(raw); // {root: string, path: string}
    const absolute = await resolve(request);
    shell.showItemInFolder(absolute);
    return true;
  });
}
```

`main.ts` supplies `resolve` by calling a **desktop-only** backend endpoint:

```
POST /api/files/resolve        (T1, desktop secret required)
body: { root, path }
200:  { path: "/absolute/validated/path" }
403/404: validation failure
```

Generate a separate `AUTOAGENT_DESKTOP_SECRET` in the desktop process, pass it
to the backend environment, and require an `x-autoagent-desktop` header on that
endpoint. The renderer has the launch token, so the launch token alone is not
sufficient for a path-disclosing endpoint.

Then:

```ts
// desktop/src/preload.ts
shell: {
  ...
  revealInWorkspace: (request) =>
    ipcRenderer.invoke('native:shell:reveal-workspace', request),
}
```

The backend's `POST /api/files/reveal` remains the browser-build fallback and
returns 501 when no hook is installed. Do not wire it to a renderer-controlled
absolute path.

---

## 3. Phases and acceptance

### T0 — read/preview/edit in one workspace

Scope:

- `safe_file_service.py`, `file_router.py`, deps getter, composition field,
  config limits, app registration, body-cap exemption for upload.
- `fileClient.ts`, `useFileTree.ts`, `FileBrowser.tsx`, Files tab, token
  bootstrap.
- Reveal button may return 501 in T0.

Acceptance:

- [ ] `GET /api/files?root=workspace&path=` lists the configured cwd.
- [ ] `GET /api/files/content` returns UTF-8 text + SHA-256; binary is flagged.
- [ ] `PUT /api/files/content` is atomic; stale hash → 409, bytes unchanged.
- [ ] `..`, absolute, drive-qualified, backslash, NUL → 400.
- [ ] Symlink component → 403; `stat` shows `kind: "symlink"`; delete leaves the
      target.
- [ ] Unknown root id / non-allowlisted canonical root → 403.
- [ ] Oversize read/write → 413.
- [ ] No DTO or error body contains an absolute path.
- [ ] No `subprocess`/`shell=True`/string interpolation added.
- [ ] SPA: lazy expansion, breadcrumb, hidden toggle, filter, create/rename/
      delete/upload/download, dirty guard, keyboard navigation, abortable loads.
- [ ] `ruff`, `py_compile`, pytest (unit + route integration), and
      `tsc --noEmit` pass in the AutoAgent tree.

### T1 — desktop reveal, larger uploads, session roots

Scope:

- Desktop-only resolve endpoint + secret; `registerShell(resolve)`;
  preload/native.ts `revealInWorkspace`.
- Streaming upload above 1 MiB validated in the service.
- `session:<id>` roots with `is_writable_root`; persist or derive the root from
  the session settings.
- Route integration tests for raw streaming upload and Range.

Acceptance:

- [ ] Reveal shows the selected entry in the OS file manager; renderer JSON never
      contains an absolute path.
- [ ] A 20 MiB upload succeeds and a 20 MiB + 1 byte upload returns 413 without
      leaving a temp file.
- [ ] Read-only session roots reject PUT/POST/delete with 403.
- [ ] `openat2`/fd-containment tests run on Linux in CI.

### T2 — hardening and polish

Scope:

- Server-side bounded search or an explicit loaded-only filter label.
- File watching or an mtime stale banner; reload prompt on 409.
- Audit log (root id, relative path, operation, outcome, request id) with no
  absolute paths.
- Optional in-root symlink mode after an explicit setting and review.
- Recursive delete through OS trash with separate consent (or keep it absent).
- Accessibility audit with screen readers.

Acceptance:

- [ ] Mutation audit entries exist for every write/delete/rename/copy/move.
- [ ] Stale editor state is visible before save, not only after 409.
- [ ] Recursive operations have caps and a cancel path.
- [ ] Architecture §8.6 and the API contract document the new, reviewed
      surface area.

---

## 4. Exact regression commands (AutoAgent tree)

```bash
# backend
cd /home/tars/yysapp/AutoAgent/backend
.venv/bin/python -m pytest -q tests/unit/test_file_service.py
.venv/bin/python -m pytest -q tests/integration/test_file_routes.py   # T1
.venv/bin/ruff check src tests
.venv/bin/mypy
.venv/bin/lint-imports

# frontend
cd /home/tars/yysapp/AutoAgent/frontend
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run
node_modules/.bin/vite build

# desktop (T1)
cd /home/tars/yysapp/AutoAgent/desktop
bun x tsc --noEmit
```

Suggested structural greps:

```bash
rg "SafeFileService\(" backend/src            # only composition.py
rg "subprocess|shell=True|os\.system" backend/src/autoagent_backend/adapters/files
rg 'workDir|"/' backend/src/autoagent_backend/api/routes/file_router.py  # review paths
rg "showItemInFolder" frontend/src desktop/src
```

---

## 5. Security review checklist

- [ ] Client paths are relative; `_split` rejects absolute/drive/backslash/`..`.
- [ ] Root ids are mapped only by `root_resolver`; canonical roots are checked
      by `is_allowed_root`.
- [ ] Every read/open uses `O_NOFOLLOW`; every component is `lstat`-walked.
- [ ] Linux fd path is checked through `/proc/self/fd`.
- [ ] Writes use same-directory temp + fsync + `os.replace` + temp cleanup.
- [ ] `expectedSha256` mismatch is 409 and does not modify the file.
- [ ] Read/write/copy/scan/line caps are enforced server-side.
- [ ] Binary detection and UTF-8 decode failures do not reach the editor.
- [ ] SVG is refused by the thumbnail route; bytes/download are
      `nosniff` + `attachment`.
- [ ] The upload body-cap exemption is limited to the upload path.
- [ ] No `Form`/`File` parameters are added unless `python-multipart` is in the
      locked dependency set.
- [ ] The desktop resolve endpoint requires a main-process-only secret.
- [ ] No success/error DTO contains an absolute path.
- [ ] `static_api.router` remains the last router.
- [ ] Architecture §8.6 ("no generic file read/write endpoints") is updated to
      describe this reviewed exception and its threat model.

---

## 6. What not to copy from Claude Desktop

- Google Drive export, OAuth connectors, cloud sync.
- VM/container mounts and host↔guest filesystem bridges.
- A full-disk/full-home index; keep the tree root-scoped and lazy.
- macOS TCC/Full Disk Access flows and protected-folder bypasses.
- Any `pickAbsolutePath`/`readAbsolutePath` API. Paths enter only through a
  native dialog converted into a named, allowlisted root.
- Automatic background indexing or content upload.
- Silent auto-save and last-writer-wins. Keep explicit save, dirty guard and the
  hash compare-and-swap.
- Generic Electron `fs`/`invoke`/`exec` channels. Keep the fixed preload
  allowlist.
- Remote collaboration/conflict UI; out of scope for a loopback workspace
  browser.

---

## 7. Rollout and rollback

- Ship behind a setting/tab flag first (`files` tab hidden by default).
- The backend surface is additive; the only risky middleware change is the
  upload-path cap exemption. Keep it path-specific.
- Rollback: remove the `file_router` include and hide the tab; the service and
  DTOs can remain unused. No database migration is required.
- The reference implementation is stdlib-only, so there is no new Python
  dependency. The frontend adds no dependency (uses existing React, lucide and
  CDS components).
