# Safe workspace file browser/editor — reference design

Status: **reference implementation only**. Nothing in `/home/tars/yysapp/AutoAgent`
was modified. All paths below are under
`/home/tars/yysapp/claude-desktop/research/fs-integration/`.

Inspired by the Claude Desktop file experience, but scoped to AutoAgent's
existing trust model: a loopback FastAPI backend, a launch-token/origin gate, an
Electron shell that exposes only fixed native channels, and one configured
workspace root.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ React 19 / Vite / TS (AutoAgent SPA)                                │
│  FileBrowser.tsx ── useFileTree.ts ── fileClient.ts                 │
│        │ tree state, lazy expansion, dirty guard, virtual rows      │
│        └── fetch/XHR with launch token or cookie, AbortSignal        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP, loopback only
┌──────────────────────────────▼──────────────────────────────────────┐
│ FastAPI (app.py security_middleware: origin + launch token)         │
│  api/routes/file_router.py                                          │
│    DTO validation, size/line caps, Range parsing, streaming         │
│    └── Depends(get_file_service)                                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ in-process, synchronous
┌──────────────────────────────▼──────────────────────────────────────┐
│ SafeFileService (stdlib-only adapter)                               │
│  root_resolver(root_id) ──► approved absolute root                  │
│  is_allowed_root(path) ───► allowlist decision                      │
│  canonicalise → lstat walk → O_NOFOLLOW → atomic replace            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ os / pathlib only (no shell)
┌──────────────────────────────▼──────────────────────────────────────┐
│ Workspace filesystem                                                │
│  root id "workspace" → settings.cwd / boot default_cwd              │
│  (T1) root id "session:<id>" → optional session-scoped root         │
└─────────────────────────────────────────────────────────────────────┘

Reveal (desktop only):
SPA → preload `shell.revealInWorkspace({root, path})`
    → Electron main → authenticated loopback call to backend
    → SafeFileService.absolute_path (validated)
    → shell.showItemInFolder(absolute)
The absolute path never enters renderer JSON.
```

Why this shape:

- `SafeFileService` is framework-free so it can be unit-tested without
  FastAPI/pydantic and reused from a future CLI or MCP tool.
- The router is the only place that knows HTTP status codes, DTOs, raw request
  streaming, Range and streaming responses.
- Composition (`composition.py`, integration phase) constructs the one service
  instance and injects the root policy. Routes never derive roots themselves.

### Workspace-relative paths

Clients send `{root: "workspace", path: "src/App.tsx"}`. They never send
`/home/alice/project/src/App.tsx`.

Why:

1. **Capability confinement.** A relative path cannot name a different volume,
   home directory, or `~/.ssh`; only the injected root resolver can widen scope.
2. **Portability.** The same request works when the workspace moves, when the
   backend runs for a session root, or when tests use `tmp_path`.
3. **No path disclosure.** Absolute paths leak usernames and layout in logs,
   telemetry, screenshots and error bodies. DTOs expose only the root id and the
   relative path.
4. **Auditability.** A root id + relative path is a stable, reviewable grant
   boundary. An arbitrary absolute path is not.

Absolute paths are allowed only when **explicitly approved**:

- A native open/save dialog returns an absolute path; that is a user grant and
  must be turned into a new named root (or a one-shot grant) by the caller.
- `SafeFileService.absolute_path()` exists solely for the desktop reveal hook.
  It validates the path exactly like a read and returns the absolute form to the
  native process, never to the SPA/HTTP response.
- The service rejects any absolute client path before touching the filesystem
  (`_split`), including POSIX `/…`, Windows `C:…`, backslashes, `..`, NUL and
  newline/control separators.

### Root resolver and approval injection

```python
service = SafeFileService(
    root_resolver,                 # root_id -> Path | None
    is_allowed_root,               # canonical Path -> bool
    is_writable_root=...,          # optional root_id -> bool (session read-only)
    max_read_bytes=2 * 1024 * 1024,
    max_write_bytes=1024 * 1024,
)
```

The resolver is the only place that maps a root id to a filesystem location.
`is_allowed_root` is a second, independent check performed on the **canonical**
path (`resolve(strict=True)`), so a symlinked root that points outside the
allowlist is rejected. Approval policy stays with the caller:

- T0: only the configured workspace cwd.
- T1: session roots if a session records one; mark read-only sessions via
  `is_writable_root`.
- Native-dialog grants: create a short-lived named root after the dialog; do not
  accept the returned absolute path directly over HTTP.

---

## 2. HTTP API

All routes are under the existing global auth middleware (origin + launch token
or cookie). The router additionally requires a loopback peer. Errors follow
AutoAgent's `{"ok": false, "code": "...", "error": "..."}` convention when the
integration handler is registered; the reference router translates
`FileServiceError` to `HTTPException(status, message)`.

| Method | Path | Input | Output / status | Notes |
|---|---|---|---|---|
| GET | `/api/files` | `root`, `path=""`, `hidden=false`, `cursor`, `limit=200` | `FileListResponse`; 200, 403, 404, 413 | Dirs first, casefold sort. Opaque cursor. Temp files omitted. 50k scan cap. |
| GET | `/api/files/stat` | `root`, `path=""` | `FileStatView`; 200, 403, 404 | `lstat`; symlinks described, not followed. |
| GET | `/api/files/content` | `root`, `path`, `mode=text\|bytes`, `maxLines=20000`, optional `Range` | text: `FileTextView` JSON; bytes: `application/octet-stream`; 200/206, 403, 404, 413, 416 | Text is UTF-8; binary flag/NUL detection. Partial bytes omit SHA-256. |
| PUT | `/api/files/content` | `{root, path, text, expectedSha256?}` | `WriteResponse`; 200, 409 (`HASH_MISMATCH`), 413 | Atomic compare-and-swap. Body is JSON text; binary uses upload. |
| POST | `/api/files/create` | `{root, path, text="", overwrite=false}` | `WriteResponse`; 200, 409 | `O_CREAT|O_EXCL` unless overwrite. |
| POST | `/api/files/mkdir` | `{root, path, parents=false}` | `FileStatView`; 200, 409 | Parent chain is walked with `lstat`; symlinks rejected. |
| POST | `/api/files/rename` | `{root, fromPath, toPath, overwrite=false}` | `FileStatView`; 200, 409 | Same root/filesystem. `EXDEV` → 409. |
| POST | `/api/files/delete` | `{root, path}` | `{deleted: true}`; 200, 404, 409 | Files, symlinks, **empty** dirs only. No recursive delete. |
| POST | `/api/files/copy` | `{root, fromPath, toPath, overwrite=false}` | `FileStatView`; 200, 409, 413 | Files or trees; symlinks abort; entry/byte/depth caps. |
| POST | `/api/files/move` | same as copy | `FileStatView`; 200, 409 | Alias of rename for files/empty-or-nonempty dirs; no cross-device fallback. |
| GET | `/api/files/download` | `root`, `path` | streamed bytes; `Content-Disposition: attachment`; 200, 403, 404 | `O_NOFOLLOW`; closes the stream on disconnect. |
| POST | `/api/files/upload` | raw `application/octet-stream` body; query `root`, `path`, `overwrite` | `WriteResponse`; 200, 409, 413 | Spools to a temp file, then streams through the atomic writer. No `python-multipart` dependency. See the 1 MiB middleware caveat. |
| GET | `/api/files/thumbnail` | `root`, `path` | raster image bytes; 200, 403, 404, 413, 415 | Raster-only; **SVG refused** (active content). Private cache. |
| POST | `/api/files/reveal` | `{root, path}` | `{revealed, root, path}`; 200, 501 | Delegates to an injected desktop hook. Absolute path is never returned. |

DTO field names are camelCase to match the existing `api/schemas.py` boundary
(`workDir`, `isGitRepo`, `mtimeMs`, `nextCursor`). Request models use
`extra="forbid"`.

### Range semantics

Only a single `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range is
supported. Multiple ranges, malformed values, and ranges on an empty file return
416 with `Content-Range: bytes */size`. Text mode rejects `Range` with 400.

---

## 3. Security model

### Root allowlist

- Root ids are opaque strings. The client never supplies an absolute path.
- `_root()` resolves the root with `strict=True` and checks the **canonical**
  path with `is_allowed_root`.
- A root must be absolute, exist, and be a directory. Relative roots are
  rejected to avoid cwd-dependent surprises.
- Optional `is_writable_root` enforces read-only roots (useful for session
  snapshots) before every mutation.
- `root_resolver` and both predicates are injected; the service contains no
  global allowlist and no environment lookups.

### Canonicalisation and traversal

- Reject: NUL, `\n`, `\r`, backslash, leading `/`, drive letters (`C:`), empty
  segments, `.`, `..`, segments >255 chars, paths >4096 chars.
- `Path.resolve(strict=False/True)` canonicalises; `os.path.commonpath` proves
  containment. `ValueError` from `commonpath` (different drives) is a 403.
- Resolution is repeated with an `lstat` walk to narrow replacement races.

### Symlinks

- Default policy: **no symlink is followed for reads or writes**, at any
  component, including the final one.
- `stat` describes a symlink via `lstat` (`kind: "symlink"`) without following
  it. The UI shows it as non-openable.
- `delete` unlinks the symlink itself, never its target.
- `copy` aborts on any symlink in the source tree.
- Optional `follow_symlinks` exists only on `stat`; enabling it requires the
  fully resolved target to remain inside the root.
- Repositories containing tracked symlinks will show them but cannot open them.
  This is deliberate; a later opt-in can allow in-root links after a review.

### TOCTOU

Mitigations implemented:

1. Resolve, then re-walk with `lstat` before opening.
2. Open with `O_NOFOLLOW` (and `O_CLOEXEC`) on the final component.
3. `fstat` the descriptor and require a regular file.
4. On Linux, read `/proc/self/fd/N` and require the opened target to be inside
   the root.
5. For writes, the parent is canonicalised and the final component is checked
   again immediately before `os.replace`.
6. Editing clients send `expectedSha256`; a mismatch returns 409 without
   touching the file.

Residual risk: a same-user process can still swap an **intermediate** directory
between the walk and `open`. Closing that fully requires `openat2` with
`RESOLVE_BENEATH`/`RESOLVE_NO_SYMLINKS` (Linux) or equivalent directory-fd
walking on other platforms. Until then, the threat model is "local UI mistakes
and compromised renderer", not "malicious same-uid process". A compromised
renderer already shares the user's OS account.

### Atomic writes

1. `tempfile.mkstemp(prefix=".autoagent-tmp-", dir=<same directory>)`.
2. Write, flush, `fsync(fd)`; preserve the old mode (new files are `0600`).
3. Re-check the target is not a symlink.
4. `os.replace(temp, target)` (atomic on POSIX and Windows for files).
5. Best-effort `fsync` of the parent directory.
6. On any failure, unlink the temp file; temp names are always hidden from
   listings.

Concurrent edits are detected with SHA-256 compare-and-swap. Hash checking and
replacement are not a single kernel transaction, but the window is small and a
client that omits `expectedSha256` explicitly accepts last-writer-wins.

### Size and resource limits

| Limit | Default | Enforced by |
|---|---|---|
| Text/byte read | 2 MiB | `max_read_bytes` |
| Text write / upload | 1 MiB | `max_write_bytes` (aligns with the current 1 MiB `MAX_BODY_BYTES`) |
| Thumbnail | 2 MiB | `max_thumbnail_bytes` |
| Preview lines | 20,000 | `max_lines`; truncation disables editing |
| Directory scan | 50,000 entries | `max_scan_entries` → 413 |
| Copy | 10,000 entries / 256 MiB / depth 64 | `max_copy_*` → 413 |

The global `security_middleware` checks `Content-Length` against 1 MiB for every
`/api/*` request. Uploads above 1 MiB are rejected **before the route**. The
integration must exempt `/api/files/upload` from that check and rely on the
service cap (plus the router's own chunk counter), or compare its
`Content-Length` against the file limit. Do not raise the global cap for all
routes.

Uploads use a **raw body**, not multipart. AutoAgent does not depend on
`python-multipart`; declaring FastAPI `Form`/`File` parameters makes the entire
router fail at import/registration time. If multipart is later preferred, add
`python-multipart` to `pyproject.toml` and `uv.lock` first. The reference router
deliberately avoids it.

### Binary detection and MIME

- Binary when a NUL byte is present or strict UTF-8 decoding fails. The editor
  receives `binary: true, text: null` and offers download instead.
- MIME is `mimetypes.guess_type`, defaulting to `text/plain`/octet-stream.
- Bytes responses are served as `application/octet-stream` with the detected
  MIME in `X-File-Mime`, plus `X-Content-Type-Options: nosniff`.
- Downloads are `attachment`.
- Thumbnails allow only raster images. `image/svg+xml` is refused because SVG
  can execute script when navigated/embedded; if SVG preview is ever required,
  render it in a sandboxed iframe without `allow-same-origin`, never as a raw
  image response.
- Encoding is UTF-8 only. No BOM conversion, no transcoding, no chardet.

### No shell, no interpolation

The service imports no `subprocess`, `os.system`, `eval`, or `exec`.
`file_router.py` never builds a shell command. Git operations remain in
`GitCliWorkspace` with argv arrays and `shell=False`. Reveal is delegated to the
Electron process, which accepts only a validated absolute path.

### Authorization and loopback

- `app.py`'s `security_middleware` already enforces the Origin and launch token
  (Bearer or launch cookie) for every `/api/*` route.
- The router's `_require_loopback` dependency rejects non-loopback peers as
  defence in depth; the server itself binds `127.0.0.1` (`config.py`).
- No new auth token is introduced. If a desktop-only reveal/resolve endpoint is
  added, give it a separate desktop-secret header so the renderer cannot call
  it directly.

---

## 4. Integration steps (summary)

Full file-by-file plan and phases: [`PATCH_PLAN.md`](./PATCH_PLAN.md).

### Backend

1. `backend/src/autoagent_backend/adapters/files/__init__.py` (new).
2. `.../adapters/files/safe_file_service.py` ← `backend/file_service.py`.
3. `backend/src/autoagent_backend/api/routes/file_router.py` ←
   `backend/file_router.py`; change the service import to
   `from ...adapters.files.safe_file_service import ...`.
4. `api/deps.py`: add `get_file_service(request)` returning
   `get_container(request).file_service`.
5. `composition.py`: add `file_service: SafeFileService` to `Container`, build it
   with the workspace resolver/allowlist, and pass it to services/route deps.
   This is the only construction site (architecture rule).
6. `app.py`: `app.include_router(file_router.router)` **before**
   `static_api.router`; keep the SPA catch-all last.
7. `api/deps.py` / `config.py`: make the 1 MiB body cap path-aware for
   `/api/files/upload` and `PUT /api/files/content`; add config limits (T1).
8. `errors.py`: optionally register a `FileServiceError` handler to preserve
   stable `code` values. The reference router already maps them to status codes.
9. Move DTOs to `api/schemas.py` if the team prefers one boundary module; keep
   field names camelCase.

Composition sketch (T0):

```python
def _workspace_root(root_id: str) -> Path | None:
    if root_id != "workspace":
        return None
    return Path(settings_store.read().cwd or config.default_cwd).expanduser()

allowed = {Path(config.default_cwd).resolve()}
# If settings.cwd is set, use exactly that root and do not silently fall back
# to the home directory.
file_service = SafeFileService(
    _workspace_root,
    lambda candidate: candidate in allowed,
    max_read_bytes=config.file_max_read_bytes,
    max_write_bytes=config.file_max_write_bytes,
)
```

`BootConfig.default_cwd` currently defaults to `Path.home()`; allowing it means
the whole home directory is browsable. T0 must prefer an explicitly configured
`settings.cwd` and prompt through a native dialog when it is unset. Do not ship
"home is the workspace" as an unstated default.

### Frontend

1. `frontend/src/features/files/fileClient.ts` ← `frontend/fileClient.ts`.
2. `frontend/src/features/files/useFileTree.ts` ← `frontend/useFileTree.ts`.
3. `frontend/src/features/files/FileBrowser.tsx` ← `frontend/FileBrowser.tsx`.
4. `api/client.ts`: export a launch-token getter (or call
   `setFileAuthToken(token)` from `initLaunchToken`). The backend also accepts
   the cookie, so the normal desktop flow works without an export.
5. `app/Shell.tsx`: add a `files` tab (`TabsTrigger` + `TabsContent`) and render
   `<FileBrowser client={fileClient} root="workspace" rootLabel={workspace.workDir} />`.
   The existing `Workspace` (git) tab stays unchanged.
6. `lib/native.ts` (T1): add `shell.showItemInFolder(path)` and the scoped
   `revealInWorkspace({root, path})` bridge to the `NativeBridge` interface.
7. `desktop/src/native/shell.ts` (T1): add a fixed `native:shell:reveal`
   handler. Electron main validates the request, calls the backend's
   desktop-only resolve/reveal endpoint with the launch token, then
   `shell.showItemInFolder`. Do not expose a generic path-based channel to the
   renderer.
8. `frontend/src/cds/index.ts`: no changes; the reference uses existing Button,
   Dialog, Field, Input, Badge, EmptyState, ErrorState and Skeleton.

The reference `FileBrowser` imports `@/cds` and `@/features/panels/Chrome`.
`frontend/check/stubs/` exists only so the out-of-tree copy can be typechecked;
do not copy the stubs into AutoAgent.

---

## 5. Acceptance criteria

### T0 — safe read/preview/edit

- [ ] `GET /api/files` lists the configured workspace; `hidden` toggles dotfiles;
      cursor pagination returns every entry exactly once.
- [ ] `GET /api/files/content` returns UTF-8 text with a whole-file SHA-256;
      binary files report `binary: true` and are not editable.
- [ ] `PUT /api/files/content` is atomic; a stale `expectedSha256` returns 409
      and leaves bytes unchanged.
- [ ] `..`, absolute paths, drive-qualified paths, backslashes and NUL are 400.
- [ ] A symlink anywhere in the path is 403; `stat` still describes it; deleting
      it leaves the target intact.
- [ ] Root ids outside the allowlist are 403.
- [ ] Files larger than the read/write caps are 413.
- [ ] No success or error DTO contains an absolute path (`rg '"/'` on fixtures).
- [ ] The SPA tab opens files, saves with the hash guard, blocks switching with
      unsaved changes, and cancels in-flight reads.
- [ ] `python -m pytest`, `ruff`, `py_compile`, and `tsc --noEmit` pass as
      reported below.

### T1 — desktop and larger files

- [ ] Reveal works from the file toolbar through Electron main; the renderer
      never receives an absolute path.
- [ ] Uploads above 1 MiB work through a path-specific body cap and progress.
- [ ] Session roots are read-only unless explicitly writable.
- [ ] Copy/move/delete UI refreshes parents and clears selection safely.
- [ ] Linux `O_NOFOLLOW` and `/proc/self/fd` checks are covered by an integration
      test on the real package layout.

### T2 — polish

- [ ] Server-side search/index (bounded) or clearly documented loaded-only
      filtering.
- [ ] File watching or mtime-based stale banner.
- [ ] Optional in-root symlink follow mode after an explicit user setting.
- [ ] Audit log of mutations (root id, relative path, operation, result) without
      absolute paths.
- [ ] Recursive delete is either absent or goes through OS trash with a separate
      consent step.

---

## 6. Risks and open questions

1. **Default root is home.** `BootConfig.default_cwd` defaults to `Path.home()`.
   Restrict T0 to `settings.cwd`; otherwise the feature browses the whole home
   directory.
2. **1 MiB middleware cap.** Upload fails before the router until the cap is made
   path-aware. Also, do not declare FastAPI `Form`/`File` parameters: the
   backend does not depend on `python-multipart`, and doing so breaks router
   registration at import time. Use the reference raw-body upload.
3. **TOCTOU residual.** Intermediate-directory swaps are not fully preventable
   without `openat2`. Document the same-uid threat model.
4. **Symlink-heavy repositories.** Tracked symlinks are visible but not
   openable. Some monorepos rely on links; gather feedback before enabling
   in-root following.
5. **No file watching.** External edits show a 409 on save (hash guard) but the
   tree and preview can be stale until refresh.
6. **UTF-8 only.** Latin-1/UTF-16 files are reported as binary. Add explicit
   encoding selection only with a round-trip-safe design.
7. **Truncated previews.** The server marks `truncated`; the UI disables editing.
   Never allow saving a truncated buffer.
8. **Delete is immediate.** There is no trash integration. A future recursive
   delete needs its own consent contract.
9. **Upload collision.** The UI surfaces 409; there is no overwrite prompt yet.
10. **Accessibility under virtualisation.** The active row is force-rendered and
    `aria-activedescendant` is maintained, but screen-reader coverage should be
    tested with VoiceOver/NVDA/Orca.
11. **Electron reveal bridge.** `native:shell:show-item` accepts arbitrary
    absolute paths today. The integration must add a scoped request and keep the
    absolute path in the main process.
12. **No generic file API in the current contract.** `architecture.md` §8.6
    explicitly says "no generic file read/write endpoints". This design is a
    deliberate, reviewed expansion; update that section and the threat model
    before merging.

---

## 7. What not to copy from Claude Desktop

- Google Drive / cloud export and OAuth connectors.
- VM/container mounts, remote filesystem providers, and host↔guest bridges.
- A full-disk or full-home index; the browser is root-scoped and lazy.
- macOS TCC/Full Disk Access prompts and protected-folder bypasses.
- Any "pick any absolute path" API. Paths enter only through a native dialog
  grant converted into a named root.
- Silent auto-save. AutoAgent keeps explicit save plus a dirty guard and a
  server-side compare-and-swap.
- Remote sync/edit conflict UI. Out of scope for a loopback workspace browser.
- Broad Electron preload APIs (`fs`, generic `invoke`, `exec`). The preload
  stays a fixed allowlist of channels.

---

## 8. Reference checks actually run

Environment: `/home/tars/yysapp/AutoAgent/backend/.venv` (Python 3.12.3,
pytest 9.1.1, ruff 0.17.1) and
`/home/tars/yysapp/AutoAgent/frontend/node_modules/.bin/tsc` (TypeScript 5.9.3).

```bash
cd /home/tars/yysapp/claude-desktop/research/fs-integration/backend
python -m py_compile file_service.py file_router.py test_file_service.py
python -m pytest -q test_file_service.py
ruff check --isolated --line-length 100 --target-version py312 \
  --select E,F,I,UP,B,SIM,RUF --ignore B008,SIM105 \
  file_service.py file_router.py test_file_service.py

cd /home/tars/yysapp/claude-desktop/research/fs-integration/frontend/check
../../../AutoAgent/frontend/node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Observed results:

- `py_compile`: success (exit 0, no output).
- `pytest`: `31 passed in 0.23s`.
- `ruff`: `All checks passed!`.
- `tsc --noEmit`: exit 0, no diagnostics (using the stub `@/` modules).
- Router smoke test (temporary `/tmp` package, FastAPI `TestClient`, no
  AutoAgent files): `router smoke OK`, covering list/read/write, 400 traversal,
  403 symlink/unknown root, 409 hash mismatch, 404, 206 Range, raw upload,
  413 oversize upload, and reveal without absolute-path disclosure.

Not run, and therefore not claimed:

- AutoAgent's own test suites, mypy/import-linter on the integrated tree, or a
  real FastAPI app through `app.py` (the smoke test uses an isolated temporary
  package with the reference router/service).
- Any Electron/reveal integration; no AutoAgent or desktop file was modified.
- Performance or fuzzing beyond the listed unit cases and smoke test.

---

## 9. Files

```
research/fs-integration/
├── README.md
├── PATCH_PLAN.md
├── backend/
│   ├── file_service.py          # stdlib-only SafeFileService
│   ├── file_router.py           # FastAPI APIRouter + DTOs
│   └── test_file_service.py     # 31 pytest cases
└── frontend/
    ├── FileBrowser.tsx          # tree + editor + dialogs + virtual rows
    ├── fileClient.ts            # typed fetch/XHR client, abort, SHA-256
    ├── useFileTree.ts           # lazy tree, pagination, cancellation
    └── check/                   # out-of-tree tsc harness (not shipped)
        ├── tsconfig.json
        └── stubs/
```
