# Delivery — AutoAgent MateBot Modernization

Date: 2026-10-17

## Result

AutoAgent is now a maxwire-style desktop app:

```
Electron thin shell
  └─ Python FastAPI backend (deep ports, SQLite, SSE, static SPA)
       ├─ MateBotEngine → vendored OpenccSession
       │     opencc --print --verbose --input-format stream-json
       │            --output-format stream-json --matebot ...
       └─ EngineConfigResolver
             desktop override → ~/.claude/settings.json
             → ~/.autoagent/settings.json → process env → default
```

The modern app and the legacy app share one repository. `AUTOAGENT_LEGACY=1`
runs the untouched legacy entry in development; in the package it fails fast
with a reinstall instruction.

## Final artifact

```
release/autoagent_0.8.0_amd64.deb
135,456,008 bytes
sha256 5802e841e40fab4008b28af32c955f3220ac0cdc7fba08d72c4550df80832923
```

Self-contained layout:

```
/opt/autoagent/
  backend/                 Nuitka standalone backend (no system Python)
  frontend/dist/           React SPA
  desktop/                 Electron + resources/app/{entry,main,preload}
  engine/                  bun + opencc-dist/cli.js (--matebot)
  vendor/matebot/          vendored OpenccSession and MateBot core
/usr/bin/autoagent         Wayland-aware launcher, no --no-sandbox
```

## Vendored code

- `vendor/matebot/` — MateBot core at upstream `c0deb163` (bridge,
  `opencc_backend.py` / `OpenccSession`, session store, Feishu modules, docs).
  Excluded: `.git`, upstream `vendor/opencc`, `workspace/`, `skills/`, caches,
  `uv.lock`. Update with the rsync command in `vendor/README.md`.
- `vendor/opencc -> packages/opencc` — the vendored OpenCC harness source; the
  built CLI is `packages/opencc/dist/cli.js` and exposes `--matebot`. Update it
  with the selective three-way merge in `opencc-delta.md`.

## Engine

- Default engine mode: `matebot`.
- `MateBotEngine` loads the vendored `OpenccSession` by path (importlib), keeps
  one persistent child per conversation, persists/resumes the opaque session
  ref, cancels with SIGINT, enforces max-4 LRU, and recreates after death.
- Verified argv:
  `--print --verbose --input-format stream-json --output-format stream-json
  --include-partial-messages --include-hook-events
  --dangerously-skip-permissions --matebot`.
- Verified: one spawn / one PID serves two consecutive turns; SSE maps
  `turn.started → message.delta → tool.start/result → usage →
  message.completed → turn.completed`.
- `SubprocessEngine` remains as a fallback; `FakeEngine` is test/demo only.

## Integrated terminal (T0)

- Backend: `adapters/terminal/manager.py` (stdlib PTY, shell/cwd allowlist,
  process-group kill, PDEATHSIG, 1 MiB replay ring) and
  `api/routes/terminals.py` (REST + WebSocket, cookie/token/Origin gate,
  per-session tabs). `websockets` is a backend dependency and a Nuitka include.
- Frontend: `features/terminal/` (`TerminalPane`, `terminalClient`,
  `useTerminalTabs`, `TerminalPanel`); a Terminal tab in the right panel.
  xterm is lazy-loaded; the panel authenticates the WS with the HttpOnly cookie.
- CSP: `connect-src 'self' ws://127.0.0.1:*`; deleting a session destroys its
  PTYs.
- Verified: 263 backend tests (17 manager + 2 integration), frontend
  typecheck/build, live WS (`printf hello` → output, `exit` code 0), packaged
  backend WS, and a GUI end-to-end screenshot
  (`frontend/screenshots/m5-terminal.png`).
- Limitation: `fork()` in multi-threaded uvicorn is the top architectural risk;
  T1 should move to a subprocess PTY broker. T0 has no bottom dock, search,
  OSC 133, or disk logs.

## Workspace files (F0)

- Backend: `adapters/files/safe_file_service.py` (stdlib only) and
  `api/routes/file_router.py`, registered before the static catch-all and
  gated by `AUTOAGENT_FILES`. Composition builds exactly one service over the
  configured workspace (`settings.cwd`, falling back to `default_cwd`).
- Path model: root id + POSIX relative path. Absolute paths, drive letters,
  UNC, backslashes, NUL, `.`/`..` are rejected; every component is
  `lstat`-walked and symlinks (including the final one) are refused. Reads use
  `O_NOFOLLOW`; writes are temp + fsync + `os.replace` with optional SHA-256
  compare-and-swap; read/write/copy/scan limits are enforced in the adapter.
- Uploads are raw `application/octet-stream`; `/api/files/upload` is the only
  path exempt from the 1 MiB JSON body cap and streams against
  `file_max_write_bytes`. No `python-multipart` dependency.
- Frontend: `features/files/` (`fileClient`, `useFileTree`, `FileBrowser`) and
  a Files tab in the right panel.
- Verified: 31 adapter tests, 8 HTTP integration tests (containment, symlink,
  CAS 409, 413, 206 Range, raw upload, mutation routes), `ruff`, `mypy`,
  import-linter, `tsc`.

## Browser preview (P0)

- Desktop: `native/preview-manager.ts` owns one `WebContentsView` per tab in
  the dedicated `persist:autoagent-preview` partition; no preload, no Node
  integration. `native/preview-ipc.ts` validates sender + payload for a fixed
  channel set; `native/preview-protocol.ts` serves `autoagent-preview://` with
  `realpath` containment, hidden-segment denial, MIME/CSP and a 64 MiB cap.
  `preload.ts` exposes `window.autoagentPreview` (no generic invoke/fs/exec).
- Policy: https origins must match `AUTOAGENT_PREVIEW_ORIGINS` (empty by
  default); window-open, permissions and downloads are denied; the workspace
  is registered under the opaque id `workspace` (from `settings.cwd`, or
  `AUTOAGENT_PREVIEW_ROOT`). `AUTOAGENT_PREVIEW=0` fails closed.
- Frontend: `features/preview/` (`previewClient`, `PreviewPane`) and a Preview
  tab that reports when the native bridge is unavailable (browser/mock mode).
- Verified: `tsc`, desktop build, 6 protocol tests (scheme, grammar, MIME/CSP,
  symlink escape, hidden files, HEAD), 12 existing contract tests, smoke.

## MCP runtime (T0)

- Backend: `adapters/mcp/{transports,connection_manager,approval}.py` provide
  one persistent session per server (stdio, Streamable HTTP, legacy SSE),
  tool caching with `list_changed` invalidation, timeouts/cancellation,
  exponential backoff and a health loop.
- `SqliteMcpRegistry` keeps the SQLite registry as the source of truth and
  delegates discovery/invocation/status to the runtime;
  `AUTOAGENT_MCP_PERSISTENT=0` restores the old short-lived client unchanged.
- Approval: destructive/open-world tools return `403 MCP_APPROVAL_REQUIRED`
  with UI-safe details; `POST /api/mcp/approvals` records once/session consent
  in process memory (never persisted) and the retry carries the approval
  context. Read-only tools run without prompting.
- New routes: status (all/one), reconnect, logs, tools, resources/read,
  prompts/get and approvals. Existing CRUD/discover/invoke payloads remain
  compatible; `mcp.status`, `mcp.log`, `mcp.tools_changed`,
  `mcp.server_changed` and `mcp.approval_required` flow through `/api/events`.
- Frontend: `McpStatusPanel` (state, counts, last error, reconnect, logs
  drawer, approve/deny) under the server list, plus an approval prompt in the
  invoke dialog that retries after consent.
- Verified: 14 manager/transport tests (real loopback + child process),
  4 HTTP integration tests (persistent pid, kill/reconnect, resources/prompts,
  approval once/session, disable), 108 frontend tests, ruff, mypy,
  import-linter, `tsc`.
- Not in T0: engine turns still do not consume these servers (T2), OAuth/DCR,
  MCP Apps `ui://`, secret keyring, and live log streaming into the drawer.

## Configuration

See `config-precedence.md`. Summary:

1. Desktop override (`Settings.model`, passed as `--model`).
2. `~/.claude/settings.json` / `settings.local.json`
   (`env.ANTHROPIC_MODEL`, top-level `model`, credentials, base URL).
3. `~/.autoagent/settings.json` (frontend-editable fallback; atomic write,
   0600 file / 0700 parent; `AUTOAGENT_CONFIG_DIR` override).
4. Process environment.
5. OpenCC/MateBot default.

The API never returns `apiKey`; only `apiKeyConfigured` / `credentialSource`.
The desktop Settings panel shows the effective model and its source, an app
override, and the AutoAgent fallback editor.

The Settings panel is the single place for runtime selection:

- **Harness** (`engineHarness`): `opencc` (default, `--matebot`) or
  `claude-code` (same vendored CLI without `--matebot`). `HarnessEngine`
  routes each turn to the selected adapter; a running turn keeps its harness.
- **API source** (`apiCredentialSource`): `auto` (Claude settings → AutoAgent →
  env), `claude`, `autoagent` (the custom config editor below), or `env`.
  Switching re-exports the selected source to the engine child immediately.
- The separate Engine tab was removed; live state, active turns, last error,
  CLI and version now live in the Settings Engine section.

## Verification (independent)

- Backend: **333 pytest**, ruff, mypy (89 files), import-linter (2 contracts).
- Frontend: **108 Vitest**, `tsc --noEmit`, Vite build.
- Desktop: 23 smoke checks (port/token/health/log/shutdown) plus 18 Node tests
  (artifact and preview protocol contracts).
- Files: 31 adapter tests + 8 HTTP integration tests (root containment,
  symlink refusal, CAS, 413, 206 Range, raw upload, mutations).
- Preview: 6 protocol tests (scheme, URL grammar, MIME/CSP, symlink escape,
  hidden files, HEAD); manager/IPC sender checks are typechecked and bundled.
- Packaged: hash reproduced exactly; one setuid `chrome-sandbox` 4755; vendor
  file 644; `--runtime-check` reports `engineMode=matebot`,
  `matebotVendorExists=true`; CSP and immutable asset caching; fake SSE turn;
  clean shutdown/no orphan.
- Ubuntu 22.04 compatibility: the packaged ELF floor is **GLIBC_2.34** and the
  control declares `libc6 (>= 2.35)` (22.04 ships 2.35). The backend is the
  portable CPython 3.12 runtime (GLIBC_2.17), not a host-linked Nuitka binary.
  `make smoke` re-measures the floor from the extracted package and fails if
  the control over-promises.
- Config precedence: verified with an empty Claude config (AutoAgent source,
  600/700, secret absent) and the real Claude config (`claude-settings`,
  `YF95AXVV/deepseek-flash[1M]`).
- GUI: X11 and nested Wayland; Settings shows MateBot (OpenCC), the effective
  model source, and the fallback config; no "Anthropic"; 0 console errors.

Full report: `evaluation.md` (including the post-fix re-check).

## Build / run

A single `Makefile` is the unified entry point (adapted from the
`modern-c-makefile` skill): `help`, `doctor`, `setup`, `lint`, `test`, `check`,
`build`, `package`, `smoke`, `artifact`, `dev`, `clean`, `distclean`, `install`.
`make package` runs `make check` first.

### glibc baseline and Ubuntu 22.04

The build targets **glibc 2.35** (Ubuntu 22.04) by default
(`AUTOAGENT_TARGET_GLIBC`). A Nuitka standalone binary links against the build
host's glibc; building on 24.04 (2.39) produces a binary that cannot load on
22.04. `scripts/build-backend.sh` therefore selects the portable embedded
CPython runtime whenever the host glibc is newer than the target:

- The portable runtime is python-build-standalone (GLIBC 2.17) plus the locked
  runtime distributions copied from the project venv or installed from the
  registry. It is self-contained, larger (~113 MiB uncompressed) and slower on
  a cold start than Nuitka.
- `scripts/glibc-baseline.py` scans every packaged ELF and reports the highest
  GLIBC symbol version. `build-backend.sh`, `build-deb.sh` and
  `smoke-packaged.sh` all fail when the measured floor exceeds the declared
  one, so the control file can never over-promise.
- Force a mode with `--portable` / `--nuitka`; override the safety check with
  `AUTOAGENT_ALLOW_NEWER_GLIBC=1` (the control file then declares the measured
  floor).
- Builds without network egress use `AUTOAGENT_OFFLINE=1`: bun installs from
  its cache and the backend copies the runtime from `backend/.venv`.

```bash
# Ubuntu 22.04-compatible package on a newer build host
AUTOAGENT_OFFLINE=1 make package
python3 scripts/glibc-baseline.py backend/build --max 2.35
```

```bash
cd /home/tars/yysapp/AutoAgent

# unified pipeline
make help
make doctor
make setup
make check          # lint + backend/frontend/desktop tests
make build          # SPA + Electron shell
make package        # check + backend + .deb
make smoke          # packaged X11/Wayland/API smoke
make artifact       # path, size, SHA256

# backend
cd backend && uv sync --frozen
uv run pytest -q && uv run ruff check src tests && uv run mypy src && uv run lint-imports

# frontend
cd ../frontend && bun install && bun run typecheck && bun run test && bun run build

# desktop
cd ../desktop && node build.mjs && node test/smoke.mjs

# install (requires root)
sudo apt install ./release/autoagent_0.8.0_amd64.deb
autoagent
```

## Limitations / next steps

- Root-only `dpkg -i` / upgrade / remove and the installed setuid sandbox are
  unverified (no sudo on the build host).
- No real-model call was made in evaluation; the engine was exercised with a
  scripted CLI. Run one real `--matebot` turn and a long soak on a disposable
  machine.
- Nuitka full rebuilds vary by tens of bytes (build-id); packaging-only rebuilds
  are byte-identical. On hosts newer than the glibc target the default is the
  portable runtime, which is larger and starts more slowly.
- Route count is 69 (the architecture's ≤30 was a guideline); 14 of them are
  the reviewed file-browser surface.
- The Feishu bridge code is vendored. The desktop currently owns the long
  connection; running the bridge as a supervised packaged service is a
  follow-up.
- Files T0 exposes one root (`workspace`). Native reveal, larger streamed
  uploads above the write cap and per-session roots remain T1.
- Preview T0 has no local file→preview handoff, no downloads, no popout, and
  its origin allowlist is empty by default. Local content is served only from
  the registered `workspace` root via `autoagent-preview://workspace/...`.

## Rollback

- Development: `AUTOAGENT_LEGACY=1`.
- Files: `AUTOAGENT_FILES=0` omits the file routes.
- Preview: `AUTOAGENT_PREVIEW=0` fails closed at startup.
- Package: reinstall the previous `.deb`; user data under `$HOME` is untouched.
