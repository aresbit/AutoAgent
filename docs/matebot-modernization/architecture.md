# AutoAgent / MateBot Modernization — Architecture (v1)

Status: **as built** (updated 2026-10-17 to match the implemented design).
Owner: Blueprint (architecture)
Date: 2026-10-17
Inputs: `recon-matebot.md`, `api-contract-v1.md`, `legacy-inventory.md`,
`maxwire-model.md`, `opencc-delta.md`, `config-precedence.md`, `evaluation.md`,
and the implemented `backend/`, `frontend/`, `desktop/` and `vendor/` trees.

Evidence notation: `file:line` cites the repository; `[recon §n]` cites
`recon-matebot.md`; `[contract §n]` cites `api-contract-v1.md`; `[delta §n]`
cites `opencc-delta.md`; `[eval §n]` cites `evaluation.md`.

---

## 1. Decision summary

| Area | Decision |
|---|---|
| Desktop shape | Electron thin shell + local Python backend + static React SPA (MaxWire model) |
| Backend stack | **FastAPI + uvicorn + Pydantic v2**, application core framework-independent |
| Engine default | **`MateBotEngine`**: loads `vendor/matebot/opencc_backend.py` `OpenccSession` by path via `importlib`; one persistent `--matebot` child per session; **one process per conversation** |
| Engine fallbacks | `SubprocessEngine` (direct argv/NDJSON adapter), `FakeEngine` (tests/demos; refused when packaged) |
| Engine transport | NDJSON `stream-json` over stdin/stdout; stderr ring buffer + log |
| Persistence | SQLite (WAL) as the single writer, `autoagent-v2.db`; legacy JSON/SQLite read-only for import |
| Paths | Backend default data dir `~/.autoagent` (`AUTOAGENT_DATA_DIR` override); desktop userData `${XDG_CONFIG_HOME:-~/.config}/autoagent`; engine config `~/.autoagent/settings.json` (`AUTOAGENT_CONFIG_DIR` override) |
| Configuration | Desktop override > Claude `settings.json` > AutoAgent `settings.json` > process env > default; see §7.5 and `config-precedence.md` |
| Frontend | React 19 + TypeScript + Vite + Tailwind 3.4.19 + shadcn/ui + Claude Design System tokens |
| Security | Loopback only, per-launch token, HttpOnly cookie, Origin check, no shell interpolation |
| Permission policy | **Exactly one permission source**; v1 supports `bypassPermissions` only, mapped to `--dangerously-skip-permissions` alone |
| Rollback | `AUTOAGENT_LEGACY=1` loads the untouched legacy Electron entry and makes no calls to the new backend. The **packaged** rollback is currently broken ([eval §Findings P1]); fix before legacy deletion |
| Legacy removal | Only after the M7 independent evaluation passes; see `evaluation.md` |

---

## 2. Stack decision: FastAPI vs stdlib `http.server`

### 2.1 Comparison

| Criterion | FastAPI + uvicorn + Pydantic v2 | stdlib `ThreadingHTTPServer` | Evidence / consequence |
|---|---|---|---|
| SSE | First-class `StreamingResponse`; disconnect via generator close; ASGI lifespan for shutdown | Possible, but chunked framing, disconnect detection and thread shutdown are hand-written | `[contract §5]`; MaxWire's stdlib handler is an if/elif chain (`maxwire/webapp/server.py:3377-3379, 4158`) |
| Typed DTOs | Pydantic models *are* the executable contract; 422 before the handler; OpenAPI feeds the TS client | Manual `dict` validation and serialization; the contract would be duplicated in code and tests | `[contract §3]`; ch09 "规范即类型" (`ch09:95-105, 159-192`) |
| Testability | `TestClient`/`httpx.ASGITransport` against the real adapter; services remain pure and injectable | `http.client` against a live socket, or test handler methods directly; more glue | ch09 layered + DI (`ch09:255-373`) |
| Nuitka / packaging | **Proven**: `scripts/build-backend.sh` produces a standalone Nuitka backend; the binary is not byte-reproducible ([eval §B]) | Trivial to freeze; no third-party imports | Full packaging result: `backend/build/autoagent-backend`; non-determinism is a recorded deviation |
| Dependency surface | Packages pinned by `backend/uv.lock` (`fastapi`, `starlette`, `pydantic`, `pydantic-core`, `anyio`, `uvicorn`, `h11`, `click`, `typing-extensions`, `annotated-types`, `idna`, `sniffio`, …) | Zero third-party dependencies | `uv sync --frozen` is the install path; Python 3.12.3 / uv 0.11.28 |
| MaxWire fidelity | Preserves the *shape* (thin shell, health probe, port negotiation, SPA) but not the exact stdlib implementation | Exact implementation family | `maxwire-model.md` §1–§5 |

### 2.2 Recommendation

**Use FastAPI + uvicorn + Pydantic v2.** The backend is the only place that pays
this cost, and the application core does not import FastAPI (enforced by the
checklist in §11). The API contract is already written as Pydantic DTOs
(`api-contract-v1.md` §3); implementing it with stdlib would mean hand-writing
the same validation, serialization, error mapping and SSE framing, then keeping
two copies of the contract in sync. FastAPI's typed boundary and OpenAPI output
also let the frontend generate its client types instead of hand-mirroring JSON.

This is a deliberate, evidence-backed deviation from MaxWire's stdlib backend.
MaxWire optimises for zero dependencies on locked-down factory machines; this
project optimises for a typed, layered, testable domain and a contract that two
teams can implement in parallel.

### 2.3 Consequences (accepted)

1. `backend/pyproject.toml` + `uv.lock` are committed; `uv sync --frozen` is the
   only install path. Exact versions are pinned at M1, not floated.
2. FastAPI/uvicorn/Pydantic are **adapter-layer** dependencies only. A CI rule
   fails the build if `domain/` or `application/` imports them.
3. The SSE generator is a **sync generator** returned in `StreamingResponse`;
   Starlette iterates it in a worker thread. Cancellation and disconnect are
   handled by closing the generator, never by cancelling the engine turn.
4. M6 proved Nuitka can package the stack (`scripts/build-backend.sh`); the
   backend binary is not byte-reproducible because of Nuitka/C compilation
   non-determinism. Payload semantics are verified ([eval §B]). The fallback
   (embedded CPython under `/opt/autoagent/backend`) remains documented but is
   not used.
5. Dependency and packaging cost is visible in the risk register (§13.2).

---

## 3. Process and window lifecycle

### 3.1 Process diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Electron main (thin shell, desktop/src/main.ts)                              │
│  single-instance lock · data dir · port scan · token · spawn · health · log  │
│  BrowserWindow(sandbox:true, contextIsolation:true) · native IPC allowlist    │
└───────────────┬───────────────────────────────────────────────┬──────────────┘
                │ spawn(argv array, env)                        │ loadURL
                │ SIGTERM / heartbeat write                     │ http://127.0.0.1:<port>/?token=…
                v                                               v
┌──────────────────────────────────────────┐        ┌──────────────────────────┐
│ Python backend (FastAPI + uvicorn)       │  HTTP  │ React SPA (static dist)  │
│  /api/health (no I/O, token-exempt)      │<──────>│  fetch + ReadableStream  │
│  /api/auth/session                       │  SSE   │  native bridge (preload) │
│  domain services · ports · adapters      │        └──────────────────────────┘
│  MateBotEngine (default EnginePort)      │
│    └─ vendored OpenccSession (importlib) │
│  SQLite (sole writer)                    │
└───────────────┬──────────────────────────┘
                │ one persistent child per conversation, owned by OpenccSession
                │ NDJSON stream-json stdin/stdout, stderr ring buffer
                v
┌──────────────────────────────────────────────────────────────────────────────┐
│ opencc child: <bun> <cli.js> --print --verbose --input-format stream-json     │
│   --output-format stream-json --include-partial-messages                     │
│   --include-hook-events --dangerously-skip-permissions --matebot             │
│   [--model …] [--append-system-prompt …] [--resume <engine ref>]             │
│   CLAUDE_CONFIG_DIR=<data>/.claude · cwd=<workspace> · stdio pipes           │
└──────────────────────────────────────────────────────────────────────────────┘
```

The child is **not** respawned per turn. The default `MateBotEngine` loads the
vendored `OpenccSession` by path (`vendor/matebot/opencc_backend.py`, via
`importlib`) and keeps one session object per application session id. The
vendored class owns spawn/readiness/stream-json/resume; the adapter owns the
per-session map, max-4 LRU, cancel synthesis, event translation and ref
persistence. The child is created on the first turn and kept alive; stdin is
never closed between turns. This is load-bearing for coordinator continuity
(`recon §5.5`; reference `MateBot/opencc_backend.py:10-15, 501-523`). The legacy
AutoAgent `EngineClient` closes stdin and kills the process after every query
(`src/engine-client.ts:366, 386`); that behavior is retired.

### 3.2 Boot sequence

1. Electron acquires the single-instance lock with 10 retries × 1.5 s. If all
   retries fail, log and quit (MaxWire pattern; `maxwire/desktop/main.cjs:303-320`).
2. Electron resolves its data directory **before** `app.whenReady()`:
   `AUTOAGENT_DATA_DIR` override, else Linux
   `${XDG_CONFIG_HOME:-~/.config}/autoagent`, macOS
   `~/Library/Application Support/autoagent`, Windows `%LOCALAPPDATA%\AutoAgent`.
   `app.setPath('userData', dataDir)` is called once. The backend has its **own**
   default data directory: `~/.autoagent` when started standalone
   (`backend/src/autoagent_backend/paths.py:90-113`). The desktop passes its
   resolved runtime root to the backend as `--data-dir` and sets
   `AUTOAGENT_STATE_DIR` for runtime/logs. The AutoAgent engine fallback config
   stays at `~/.autoagent/settings.json` via `AUTOAGENT_CONFIG_DIR` (the
   desktop sets it explicitly; `desktop/src/backend-manager.ts:220-221`).
   The legacy Windows `%TEMP%\autoagent-userdata` tree is **not** used in
   modern mode; first-run migration reads it if it exists.
3. Electron generates `bootId = randomUUID()` and a 32-byte token
   (`crypto.randomBytes(32).toString('hex')`).
4. Electron chooses a loopback port (§3.3).
5. Electron spawns the backend with an argv array and an env object. No shell,
   no string interpolation. Env:
   `AUTOAGENT_PORT`, `AUTOAGENT_BIND=127.0.0.1`, `AUTOAGENT_DATA_DIR`,
   `AUTOAGENT_STATE_DIR`, `AUTOAGENT_LOG_DIR`, `AUTOAGENT_API_TOKEN`,
   `AUTOAGENT_BOOT_ID`, `AUTOAGENT_DESKTOP_PID`,
   `AUTOAGENT_DESKTOP_HEARTBEAT`, `AUTOAGENT_ENGINE` (default `matebot`),
   `AUTOAGENT_CONFIG_DIR`, `AUTOAGENT_MATEBOT_VENDOR_DIR` (packaged),
   `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`.
6. Electron polls `GET /api/health` every 250 ms, up to 12 s. Acceptance:
   HTTP 200, `ok:true`, `app:"autoagent"`, `bootId` equals the value it passed,
   `db` is `"ok"`. A timeout raises an actionable error containing the log path.
7. Electron creates the `BrowserWindow` (`show:false`, `sandbox:true`,
   `contextIsolation:true`, `nodeIntegration:false`) and loads
   `http://127.0.0.1:<port>/?token=<token>`. The SPA reads the query parameter,
   calls `POST /api/auth/session` with `Authorization: Bearer`, receives an
   HttpOnly `SameSite=Strict` cookie, then removes `token` from the address bar
   with `history.replaceState` (`frontend/src/api/client.ts:43-52`).
8. `ready-to-show` fires; Electron shows the window. If the backend exits at any
   point, Electron shuts down rather than leaving a dead UI
   (`maxwire/desktop/main.cjs:155-162`).
9. `GET /api/bootstrap` loads the aggregate read model. The SPA renders the
   shell immediately and fills panels from that one response.
10. Engine configuration is resolved through the precedence chain in §7.5
    (`config-precedence.md`), and AutoAgent-sourced values are applied to the
    child environment before the first spawn.

### 3.3 Port negotiation

- Range: `8787..8802` (16 ports). Each candidate is probed with
  `GET /api/health`, 800 ms timeout (`maxwire/desktop/main.cjs:177-214`).
- Free → select.
- Reachable and `{app:"autoagent", ok:true}`:
  - If `<stateDir>/runtime/backend.pid` (or the legacy
    `<dataDir>/runtime/backend.pid` alternate) exists and names a live PID whose
    command line is the AutoAgent backend, terminate it (SIGTERM, wait 3 s,
    SIGKILL) and reuse the port. This prevents two backends writing the same
    SQLite file — the exact hazard MaxWire documents
    (`maxwire/desktop/main.cjs:199-205`).
  - If no trustworthy PID file exists, skip the port. Never kill an
    unverified process.
- Reachable and not ours → skip.
- All 16 occupied → fail with an actionable dialog/log; do not scan indefinitely.

The selected port is the single alignment point between window URL, backend
bind and artifact/content URLs.

### 3.4 Health and `bootId`

`GET /api/health` is token-exempt and performs **no I/O**:

```json
{
  "ok": true,
  "app": "autoagent",
  "apiVersion": "1",
  "version": "0.9.0",
  "bootId": "…",
  "uptimeMs": 1234,
  "db": "ok",
  "engine": "idle"
}
```

`db` and `engine` come from in-memory lifecycle snapshots (`initializing`,
`ok`, `error`), updated by background work. The endpoint must answer before DB
migration, engine probing, MCP connection or any model call. This follows the
MaxWire incident note (`maxwire/webapp/server.py:3659-3690`; `maxwire-model.md`
§2.9). `bootId` proves the responder is the child Electron just spawned, not a
stale process on a reused port.

The backend also supports side-effect-free CLI fast paths:
`--version`, `--runtime-check` and `--health-check <url>` (version + bootId
comparison). These are used by packaging and the launcher
(`maxwire/webapp/server.py:4088-4122`).

### 3.5 Logging

| Log | Location | Owner | Policy |
|---|---|---|---|
| Desktop | `${XDG_STATE_HOME:-~/.local/state}/autoagent/logs/desktop.log` | Electron | append, never inside the install dir; logging must never block startup/shutdown |
| Backend | `<state>/logs/backend.log` | Python `RotatingFileHandler` | 5 MB × 3, UTF-8, line format with timestamp/level/event |
| Engine | `<state>/logs/engine/<session-id>.log` | Backend | stderr ring buffer (40 lines) + lifecycle; raw stream-json only when `AUTOAGENT_DEBUG_ENGINE=1` |
| Migration | `<state>/logs/migration.log` | Backend | record counts, skipped records, no secrets |

Rules: never log API keys, Authorization headers, env dumps, full prompts or
full tool inputs by default. Log prompt length and a hash. The legacy
`engine.log` in `/tmp` (`src/engine-client.ts:16`) is retired in modern mode.

### 3.6 Shutdown and orphan cleanup

Shutdown is one idempotent path, entered from `before-quit`,
`window-all-closed` (non-macOS), `SIGTERM`, `SIGINT` and backend exit:

```
shuttingDown = true
  stop accepting new turns
  send SIGTERM to backend; wait up to 5 s
    backend: cancel active turns, close all MateBot/OpenccSession children
             (interrupt → grace → terminate/kill), close SQLite, stop uvicorn
    if still alive: SIGKILL
  remove heartbeat/pid files
  app.exit(code)
```

Orphan protection uses three independent mechanisms:

1. **Parent PID** `AUTOAGENT_DESKTOP_PID`: the backend watchdog exits when the
   Electron process is gone. Measured at 2.11 s in the evaluation ([eval §F]).
2. **Heartbeat file** `<dataDir>/runtime/desktop.heartbeat`, written by Electron
   every 2 s. The same watchdog exits when the file is missing or older than
   15 s (`backend/src/autoagent_backend/watchdog.py:29, 156-180`). This is
   cross-platform and avoids `os.kill(pid, 0)` differences on Windows.
3. **PID file** `<stateDir>/runtime/backend.pid` (legacy alternate:
   `<dataDir>/runtime/backend.pid`) with `{pid, port, bootId, startedAt,
   argvHash}`. The Electron port scanner and the `.deb` launcher use it for
   verified cleanup.

If Electron dies hard, the backend exits on the stale heartbeat, closing engine
stdin; the CLI sees EOF and exits. If the backend dies hard, Electron shuts down
and the window never outlives the service. The `.deb` launcher adds an
OS-level post-exit stop fallback (MaxWire launcher pattern;
`maxwire/packaging/linux/maxwire-app:31-33`), using the PID file.

---

## 4. Module layout

### 4.1 `backend/`

```
backend/
  pyproject.toml                     # uv project, pinned deps, pytest config
  uv.lock                            # committed
  src/autoagent_backend/
    __main__.py                      # CLI: --host --port --data-dir --version
                                     #      --runtime-check --health-check
    app.py                           # FastAPI app factory + lifespan
    composition.py                   # the ONLY place concrete adapters are built
    config.py                        # BootConfig: env, paths, limits, version
    paths.py                         # data/state/runtime/log paths (one rule)
    watchdog.py                      # parent-PID + heartbeat watchdog
    logging_setup.py                 # rotating handlers, redaction filter
    errors.py                        # domain exception base + HTTP mapper
    domain/
      models.py                      # frozen slots dataclasses: Session, Message,
                                     #   Turn, Settings, WorkspaceStatus, Artifact…
      events.py                      # TurnStarted, TextDelta, …, TurnFailed
      ports.py                       # EnginePort, SessionStorePort,
                                     #   EngineRefStorePort, SettingsPort,
                                     #   WorkspacePort, SkillCatalogPort,
                                     #   McpRegistryPort, ArtifactStorePort
      values.py                      # EngineSessionRef NewType, CallRef, ids
    application/
      bootstrap_service.py
      session_service.py
      turn_service.py
      settings_service.py
      skill_service.py
      mcp_service.py
      workspace_service.py
      artifact_service.py
      engine_config_service.py       # GET/PUT /api/engine/config
    adapters/
      engine/
        matebot_engine.py            # DEFAULT EnginePort: loads vendored
                                     #   OpenccSession by path, max-4 LRU,
                                     #   cancel synthesis, ref persistence
        subprocess_engine.py         # fallback EnginePort (direct argv/NDJSON)
        fake_engine.py               # tests/demos; refused when packaged
        failing_engine.py            # boot-time degradation for status/errors
        argv.py                      # typed permission/flag mapping (single source)
        process.py                   # spawn, reader threads, kill escalation
        stream_json.py               # frames -> DomainEvent
        resume.py                    # 25 MiB / 14 day gates (SubprocessEngine)
      claude_settings.py             # reads ~/.claude/settings.json(.local)
      autoagent_config.py            # reads/writes ~/.autoagent/settings.json
      engine_config.py               # precedence resolver + env application
      persistence/
        sqlite.py                    # connection policy, WAL, transactions
        migrations.py                # schema_migrations
        session_store.py
        settings_store.py
        legacy_import.py             # read-only import, marker, idempotent
      workspace/git_cli.py
      skills/fs_catalog.py
      mcp/client.py
      artifacts/fs_store.py
    api/
      deps.py                        # Depends -> app.state.container
      schemas.py                     # Pydantic request/response DTOs
      errors.py                      # single exception handler
      sse.py                         # SSE framing, seq, heartbeat
      static.py                      # SPA static + fallback, cache, CSP
      routes/
        health.py auth.py bootstrap.py sessions.py turns.py settings.py
        engine_config.py skills.py mcp.py workspace.py artifacts.py events.py
  tests/
    unit/                            # services with fakes; argv; events
    integration/                     # sqlite, fs, git, static, auth
    golden/                          # stream-json fixtures -> events -> SSE
    fixtures/
```

Rules:

- `domain/` has no imports from `fastapi`, `sqlite3`, `subprocess`, `httpx`,
  `pydantic`.
- `application/` imports only `domain/` and receives ports by constructor.
- `adapters/` imports domain types and standard library / third-party clients.
- `api/` is the only FastAPI-aware layer; handlers parse, delegate, serialize.
- `composition.py` is the only module that constructs concrete adapters.
- No module-level mutable business state; process state lives in adapters and is
  passed in.

### 4.2 `frontend/`

```
frontend/
  package.json
  vite.config.ts                     # Node 18-compatible Vite major
  tsconfig.json
  tailwind.config.ts
  components.json                    # shadcn/ui
  index.html
  src/
    main.tsx
    app/
      App.tsx
      Shell.tsx                      # three-pane layout
      providers.tsx                  # query client, theme, motion config
    api/
      client.ts                      # typed fetch, token/cookie, errors
      sse.ts                         # POST fetch + ReadableStream parser
      types.ts                       # generated from OpenAPI at build time
      queries.ts                     # TanStack Query hooks
    cds/                             # Claude Design System
      theme.css                      # tokens, warm-gray surfaces, terracotta
      motion/presets.ts              # SPRING_PRESS/REVEAL/FEEDBACK/SNAP/THUMB
      atoms/                         # Button, Field, Dialog, Tabs, Tooltip…
      stream/                        # Composer, MessageBubbles,
                                     #   ThinkingAccordion, ToolDecisionCard
      artifacts/                     # CodeBlock, DiffViewer, SplitPane
      hooks/                         # useScrollPinning, useRovingFocus, useBackoff
      index.ts                       # the only public component entry
    features/
      sessions/ chat/ settings/ skills/ mcp/ workspace/ artifacts/
    lib/
    styles/
```

Rules:

- The SPA depends only on `BootstrapView`, `SessionView`, `SettingsView`,
  `TurnRequest`, the SSE wire schema and generated types. It never types against
  legacy `main.ts` interfaces.
- All colors, radii, shadows and easings come from `cds/theme.css` and the
  Tailwind theme; no raw hex values in feature code.
- Motion uses the five spring presets; no `transition: all`, no `ease-linear`,
  no infinite spinner for "thinking".
- Required interaction guards: IME composition guard on every Enter-submit
  field; scroll pinning with a 40 px bottom zone and 120 px "jump to latest";
  `prefers-reduced-motion`; 4 px drag dead zone with Esc revert; double-ring
  focus; tabular numerals.
- `tsc --noEmit`, unit tests and `cds_audit.py` are CI gates.

Design foundations, made explicit so they are reviewable:

| Foundation | Implementation |
|---|---|
| Material | Warm-gray surface ladder (1–3 % luminance steps), translucent sidebar/panel (`backdrop-filter: blur(...)` + a solid fallback), hairline 0.5 px borders on 2× displays, soft single shadow; no border-inside-border |
| Depth | Sidebar/right panel are material layers; dialogs/sheets float above a scrim; artifact previews use a bounded nested surface, never a full-page iframe |
| Motion | Springs animate from the *current* presentation value and are interruptible; pointer-down feedback (not click); 1:1 drag tracking with `setPointerCapture`; X/Y springs decomposed; momentum only when the gesture carried it; opening 260 ms, closing 140 ms |
| Typography | Optical sizing, deliberate tracking/leading, tabular numerals for counts/costs/latency; monospace only for code and ids |
| Feedback | Press scale on pointer-down, breathing dots for queued work, flowing text for generation, one terracotta accent per view, short check decay on success |
| Restraint | One accent color; scarcity of emphasis; no decorative gradients; no spinner where a state can be shown |

### 4.3 `desktop/`

```
desktop/
  src/
    entry.ts                         # AUTOAGENT_LEGACY switch, then imports one main
    main.ts                          # modern lifecycle
    backend-manager.ts               # port scan, token, spawn, health, heartbeat,
                                     #   PID verification, shutdown
    window.ts                        # BrowserWindow, navigation policy, recovery
    preload.ts                       # native-only allowlist
    native/
      dialogs.ts clipboard.ts shell.ts notifications.ts theme.ts artifact.ts
    logging.ts
    paths.ts
  build/                             # icons, runtime assets
```

`entry.ts`:

```ts
if (process.env.AUTOAGENT_LEGACY === '1') {
  await import('../../src/main.js');   // untouched legacy entry
} else {
  await import('./main.js');
}
```

Only one main module ever runs. Legacy mode preserves the old `%TEMP%`
Windows userData behavior, the old renderer server and the old IPC surface.
Modern mode never imports legacy business modules.

Preload policy: expose only OS-native capabilities that a browser cannot perform
(`[contract §4.9]`): window controls, native open/save/message/confirm dialogs,
context menus, clipboard image/text, `shell.openExternal`,
`showItemInFolder`, notifications, accent color, theme, artifact child window,
navigation history, single-instance focus. No generic `invoke`/`send`, no
business methods, no filesystem/SQL/exec/fetch bridges
(`src/preload.ts:6-21, 77-90` is the anti-pattern).

### 4.4 Repository-level build layout

```
dist/
  desktop/{entry,main}.js            # modern Electron main
  desktop/preload.cjs
  frontend/dist/                     # SPA
  legacy/main.js, preload.cjs, client/  # until parity
backend/build/autoagent-backend      # Nuitka output
packages/opencc/dist/cli.js          # engine CLI (built)
vendor/matebot/opencc_backend.py     # vendored MateBot core (loaded by path)
vendor/opencc -> ../packages/opencc  # symlink, source only
```

`package.json` `main` points at the tiny `entry.js` bundle. `scripts/build-desktop.mjs`
builds the frontend and modern main; `scripts/build-backend.sh` produces the
Nuitka tree; `scripts/build-deb.sh` stages `/opt/autoagent/{desktop,backend,
engine,frontend,vendor/matebot}`. The `.deb` launcher exports
`AUTOAGENT_MATEBOT_VENDOR_DIR=$APP_DIR/vendor/matebot`.

### 4.5 Vendored sources and update procedure

| Source | Upstream | Contents | Update |
|---|---|---|---|
| `vendor/matebot/` | MateBot `c0deb163e8a4b5319a8dce7e15f5fc6188cafb88` (2026-10-06) | Canonical MateBot bridge + `opencc_backend.py` `OpenccSession`, `session_store.py`, core modules; **core code only** (no `.git`, `vendor/opencc`, workspace, skills, caches, logs, `uv.lock`) | `rsync -a --delete` with the exclusions in `vendor/README.md`, then record the new commit in `vendor/README.md` |
| `vendor/opencc` | symlink to `packages/opencc` | Vendored OpenCC harness source; built CLI at `packages/opencc/dist/cli.js` | Selective three-way merge (`opencc-delta.md`); never replace the subtree |
| `packages/opencc/dist/cli.js` | built from `packages/opencc` | `--matebot` CLI | `cd packages/opencc && bun run build` |

Exact update command (from `vendor/README.md:16-24`):

```bash
cd /home/tars/yysapp/AutoAgent
rsync -a --delete \
  --exclude='.git' --exclude='vendor' --exclude='workspace' --exclude='skills' \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='.venv' --exclude='uv.lock' \
  --exclude='*.log' --exclude='.pytest_cache' --exclude='.ruff_cache' \
  /home/tars/yysapp/MateBot/ vendor/matebot/
```

The backend never edits the vendored file. It loads it by path with
`importlib.util.spec_from_file_location` and caches the module per resolved path
(`backend/src/autoagent_backend/adapters/engine/matebot_engine.py:506-541`).
Packaging copies Python sources only; Nuitka does not bundle them.

---

## 5. Ports and adapters

### 5.1 Rules

- Ports are `typing.Protocol`, with docstrings stating preconditions,
  postconditions and raised domain errors.
- Target ≤ 7 methods per port. If a port grows, split by reason to change.
- Methods return frozen domain values or tuples; never rows, dicts, PIDs,
  frames, paths or mutable internals.
- The application layer knows only ports. The SPA knows only HTTP DTOs. There is
  no 1:1 mapping from legacy IPC channels to endpoints.

### 5.2 Port table

| Port | Methods | Adapter(s) | Hidden representation |
|---|---|---|---|
| `EnginePort` | `start_turn(request) -> TurnHandle`; `stream(handle) -> Iterator[DomainEvent]`; `cancel(handle) -> None`; `status() -> EngineStatus`; `session_ref(session_id) -> EngineSessionRef \| None`; `close(session_id) -> None` | **`HarnessEngine`** routing to **`MateBotEngine` (opencc)** and `SubprocessEngine(matebot=False)` (claude-code); `FakeEngine` / `FailingEngine` | CLI resolution, argv, `--matebot`, `--resume`, env scrubbing, readiness queue, resume gates, interrupt→terminate/kill, stream-json frames, tool ids, spawn retries, max-4 LRU, death/recreate, per-turn harness routing |
| `SessionStorePort` | `list(limit)`; `get(id)`; `create(title)`; `rename(id,title)`; `delete(id)`; `branch(id,title)`; `append_message(id, NewMessage)`; `record_turn(id, TurnResult)` | `SqliteSessionStore` | tables/columns, JSON meta, ordering, transactions, WAL, migrations |
| `TurnStorePort` | `begin_turn`; `finish_turn`; `get_turn`; `running_turn_for_session`; `fail_orphaned_turns` | `SqliteSessionStore` (same adapter, separate seam) | `turns` rows, idempotency, one-running-turn-per-session, orphan recovery |
| `EngineRefStorePort` | `get_ref(session_id)`; `set_ref(session_id, ref \| None)` | `SqliteSessionStore` (same adapter, separate seam) | `sessions.engine_session_ref` column, UUID validation, clear-on-invalid policy; keeps engine-resume state out of the session CRUD surface |
| `SettingsPort` | `read() -> Settings`; `update(patch) -> Settings`; `provider(id)`; `providers()` | `SqliteSettingsStore` | settings document layout, defaults, unknown-field preservation, permission-mode validation |
| `AutoAgentConfigPort` | `config_path`; `read() -> AutoAgentConfig`; `update(patch)` | `AutoAgentConfigStore` | `~/.autoagent/settings.json` (`AUTOAGENT_CONFIG_DIR`), atomic 0600 write, secret masking |
| `EngineConfigPort` | `resolve(override, preference) -> ModelResolution`; `apply_environment(preference)` | `EngineConfigResolver` | precedence chain, Claude/AutoAgent/env sources, explicit source pinning, source labels, child env application; never returns secret values |
| `WorkspacePort` | `status(work_dir)`; `diff(path, work_dir)`; `switch_branch(branch, work_dir)`; `init(work_dir)` | `GitCliWorkspace` | `git` invocation, timeouts, `--numstat`/`--name-status` parsing, `HEAD:` reads, error aggregation |
| `SkillCatalogPort` | `catalog(cwd)`; `enable(name, path)`; `disable(name)`; `discover(cwd, query)` | `FilesystemSkillCatalog` | skill dirs (`.autoagent/skills`, `.claude/skills`), atomic directory moves into `.disabled`, source precedence |
| `McpRegistryPort` | `list()`; `upsert`; `remove`; `set_enabled`; `discover(name?, enabledOnly, refresh)`; `invoke(server, tool, args, approval)`; `status(name?)`; `reconnect(name)`; `logs(name, limit)`; `tools(name, refresh)`; `list_resources`; `read_resource`; `list_prompts`; `get_prompt` | `SqliteMcpRegistry` over `McpConnectionManager` (persistent); `DefaultMcpConnectionFactory` (rollback, `AUTOAGENT_MCP_PERSISTENT=0`) | `mcp_servers` table, JSON config, stdio/Streamable HTTP/legacy SSE transports, one session per server, tool cache + `list_changed`, backoff/health loop, approval engine, log ring, JSON-RPC framing |
| `ArtifactStorePort` | `list()`; `get(id)`; `create(input)`; `content(id)`; `mark_opened(id)`; `export(id, target)`; `import(zip_path)` | `FilesystemArtifactStore` | `manifest.json`, `<id>/index.html`, `versions/<ms>.html`, thumbnails, zip layout, path derivation |
| `ClockPort` (optional) | `now_ms()` | `SystemClock`, `FakeClock` | wall clock; makes turn timing and resume-age tests deterministic |

`EnginePort` is the only port that owns subprocesses. `MateBotPort` from the
earlier contract is **folded into `EnginePort`**: the local coordinator is a
subprocess protocol, not a separate network transport. `HarnessEngine` is the
default adapter and routes each turn to the setting selected in the UI:
`MateBotEngine` (vendored `OpenccSession`, `--matebot`) or
`SubprocessEngine(matebot=False)` (the same opencc CLI without the MateBot
coordinator). `SubprocessEngine` also remains the `AUTOAGENT_ENGINE=subprocess`
development fallback and the adapter used by the evaluation with a scripted
CLI. If remote workers are added later, a separate `RemoteWorkerPort` can be
introduced without changing `TurnService`.

### 5.3 Value objects and DTO boundary

- Domain values are `@dataclass(frozen=True, slots=True)`; ids are `NewType`.
- `EngineSessionRef = NewType("EngineSessionRef", str)`; it is stored in
  `sessions.engine_session_ref`, passed from `EngineRefStorePort` to
  `EnginePort`, and **never** placed in a request/response DTO or SSE payload.
- `CallRef` is a server-minted opaque correlation id for tool calls. The raw
  `tool_use` id is kept in a per-turn map inside the adapter and is not
  serialized.
- Pydantic DTOs live only in `api/schemas.py`; `to_view()` functions convert
  domain values explicitly. Domain objects never serialize directly.
- Unknown request fields are rejected (`model_config = ConfigDict(extra="forbid")`).

---

## 6. Turn domain model and state machine

### 6.1 States

```
IDLE ──start_turn──► STARTING ──system/init──► STREAMING ──result success──► COMPLETED
                         │                        │
                         │ spawn error/timeout    ├─result error──────────► FAILED
                         └───────────────────────►┤
                                                  ├─process exit no result► FAILED
                                                  ├─cancel───────────────► CANCELLED
                                                  └─remote/transport error► FAILED
```

`CANCELLING` is an internal sub-state of `STREAMING` (cancel requested, waiting
for the child to acknowledge). The public `TurnStatusView.state` uses
`running | completed | cancelled | failed` (`[contract §3]`).

### 6.2 Transition contract

| From | Trigger | To | Side effects |
|---|---|---|---|
| IDLE | `start_turn(turnId, sessionId, text)` | STARTING | acquire per-session lock; append user message; persist turn row `running` |
| STARTING | child emits `system/init` | STREAMING | emit `turn.started` with model; start draining events |
| STARTING | spawn/init error or 60 s timeout | FAILED | `TurnFailed(code="ENGINE_UNAVAILABLE"\|"ENGINE_INIT_TIMEOUT")`; persist system message |
| STREAMING | `result` non-error | COMPLETED | publish `engine_session_ref`; persist assistant text; materialize artifacts; emit `message.completed`, `turn.completed` |
| STREAMING | `result` with `is_error` | FAILED | `TurnFailed(code="ENGINE_RESULT_ERROR")`; sanitize message |
| STREAMING | child exits before `result` | FAILED | `TurnFailed(code="ENGINE_EXITED", retryable=true)`; session object is dropped |
| STREAMING | `cancel(turn_id)` | CANCELLING → CANCELLED | `OpenccSession.send_interrupt()`; wait the grace deadline; synthesize `TurnCompleted(stopReason="cancelled")`; close the child so the next turn resumes from the persisted ref |
| any | backend shutdown | CANCELLED | `close_all()` cancels active turns and closes every session |
| terminal | duplicate `run` with same turnId | unchanged | 409 `TURN_ALREADY_FINISHED` (client reads `GET /api/turns/{id}`) |
| STARTING/STREAMING | second turn for same session | unchanged | 409 `TURN_IN_PROGRESS` |

### 6.3 Cancel semantics

- `cancel` is idempotent: calling it twice is a no-op.
- `MateBotEngine.cancel` calls `OpenccSession.send_interrupt()` (SIGINT; the
  vendored reference behavior). It waits up to `cancel_grace_s` (default 3 s)
  for the CLI to emit a terminal `result`.
- If the child has not finished by the deadline, the adapter synthesizes
  `TurnCompleted(stop_reason="cancelled")` and closes the child so the next turn
  resumes from the persisted ref on a fresh process
  (`backend/src/autoagent_backend/adapters/engine/matebot_engine.py:175-221`).
- The turn's terminal event is always `turn.completed` with
  `stopReason:"cancelled"`, even if the process died during cancellation.
- Client disconnect does **not** cancel. `TurnRunner` keeps draining and
  persists the result; only an explicit cancel or shutdown cancels.
- Shutdown uses `close_all()`, which emits cancelled for active turns and then
  closes every session; `OpenccSession.close()` closes stdin, terminates, and
  kills after its grace period (`vendor/matebot/opencc_backend.py:355-374`).

### 6.4 Process-death recovery

Responsibility is split between the vendored session and the adapter:

| Layer | Owns |
|---|---|
| Vendored `OpenccSession` (`vendor/matebot/opencc_backend.py`) | spawn, readiness wait (`system/init`), stream-json framing, resume gates, doomed-resume retry, process revival on `send()` |
| `MateBotEngine` (`adapters/engine/matebot_engine.py`) | per-session map, max-4 LRU, cancel synthesis, event translation, ref persistence, mapping child close to a terminal domain event |

The vendored state machine (`recon §5.8`) remains:

```
UNSPAWNED ──start/send──► SPAWNING ──Popen ok──► WAIT_INIT ──init──► READY
     ▲                        │                    │                  │
     │                        └─error──► FAILED_SPAWN                  │
     │                                                                  │
     └──────────── next turn revives with persisted ref ◄──────────────┘
```

- **Doomed resume:** if the child was started with `--resume`, emits no
  assistant output, and exits non-zero in under 25 s, the vendored session
  clears the ref, retries **once** without `--resume`, and re-queues the last
  prompt. No error is surfaced for the first attempt.
- **Later death:** if the process dies outside that window, `_handle_close`
  clears `runtime.session`, marks the active turn
  `TurnFailed(code="ENGINE_EXITED", retryable=True)`, and stores the message.
  The next `start_turn` creates a fresh `OpenccSession`; if the persisted ref is
  still valid it resumes, otherwise it starts a new transcript
  (`matebot_engine.py:436-472`).
- **Cancel wins:** if `cancel_requested` is set when the child closes, the
  adapter emits `TurnCompleted(cancelled)` instead of `ENGINE_EXITED`.
- **Resume gates:** refuse `--resume` when the transcript is missing, not a
  regular file, ≥ 25 MiB, or the transcript's first record is ≥ 14 days old
  (`recon §5.6`; reference `opencc_backend.py:84-191`). A refused ref is cleared
  and logged; the turn proceeds fresh rather than failing.
- **Idle eviction:** at most 4 live sessions (`AUTOAGENT_MAX_ENGINES`, default
  4). Above that, the least-recently-used **idle** session is closed and its ref
  survives. If all 4 are busy, `EngineUnavailable("MateBot session capacity
  reached")` is raised (`matebot_engine.py:338-357`). This is a resource guard,
  not a correctness mechanism.

### 6.5 Domain events

```python
@dataclass(frozen=True, slots=True)
class TurnStarted:   turn_id: str; session_id: str; model: str | None
@dataclass(frozen=True, slots=True)
class TextDelta:     turn_id: str; text: str
@dataclass(frozen=True, slots=True)
class ThinkingDelta: turn_id: str; text: str
@dataclass(frozen=True, slots=True)
class ToolStarted:   turn_id: str; call_ref: str; name: str | None; input: dict | None
@dataclass(frozen=True, slots=True)
class ToolFinished:  turn_id: str; call_ref: str; name: str | None; ok: bool; text: str | None
@dataclass(frozen=True, slots=True)
class UsageReported: turn_id: str; input_tokens: int | None; output_tokens: int | None
@dataclass(frozen=True, slots=True)
class TurnCompleted: turn_id: str; session_id: str; stop_reason: str; text: str
@dataclass(frozen=True, slots=True)
class TurnFailed:    turn_id: str; session_id: str; code: str; message: str; retryable: bool
```

Internal-only events (`EngineRefUpdated`, `EngineStateChanged`) never cross the
HTTP boundary and are not part of the union above.

### 6.6 SSE projection

`api/sse.py` assigns `seq` (monotonic from 1 per turn) and `ts` (epoch ms), then
emits:

| SSE `event` | Data | Source |
|---|---|---|
| `turn.started` | `{turnId,sessionId,seq,ts,model?}` | `TurnStarted` |
| `message.delta` | `{turnId,sessionId,seq,ts,channel:"text"\|"thinking",text}` | `TextDelta`/`ThinkingDelta` |
| `message.completed` | `{turnId,sessionId,seq,ts,messageId,text}` | `TurnCompleted` |
| `tool.start` | `{turnId,sessionId,seq,ts,tool:{ref,name?,input?}}` | `ToolStarted` |
| `tool.result` | `{turnId,sessionId,seq,ts,tool:{ref,name?,ok},text?}` | `ToolFinished` |
| `usage` | `{turnId,sessionId,seq,ts,usage:{inputTokens?,outputTokens?}}` | `UsageReported` |
| `turn.completed` | `{turnId,sessionId,seq,ts,stopReason}` | `TurnCompleted` |
| `error` | `{turnId,sessionId,seq,ts,code,message,retryable}` | `TurnFailed` |
| `heartbeat` | `{ts}` | transport, every 15 s |

Projection rules from stream-json:

| stream-json frame | Domain event | Notes |
|---|---|---|
| `system/init` | `TurnStarted` | extract `model`; `session_id` is kept internal as the engine ref |
| `stream_event content_block_delta text_delta` | `TextDelta` | |
| `stream_event content_block_delta thinking_delta` | `ThinkingDelta` | legacy showed thinking as text (`src/engine-client.ts:255-257`); v1 distinguishes it |
| `stream_event content_block_start tool_use` | `ToolStarted` | mint `call_ref`; store raw `tool_use` id in the internal map |
| `user` with `tool_result` | `ToolFinished` | correlate through the internal map |
| `assistant` | authoritative text snapshot | replaces accumulated deltas at completion (`src/main.ts:1943-1945`) |
| `result` | `UsageReported` + `TurnCompleted`/`TurnFailed` | publish engine ref only on non-error result |
| `control_request can_use_tool` | — | must not occur in v1's bypass policy; if it does, log and fail the turn with `PERMISSION_UNEXPECTED` |
| other `system/*`, `rate_limit_event`, `auth_status`, hook/task frames | ignored (debug log) | no raw surfaces |

Sanitization: `tool.input` and `tool.result.text` are size-capped (16 KiB input,
64 KiB result) and keys matching `token|key|secret|password|authorization` are
redacted. `error.message` is sanitized (no argv, env, traceback or paths).

### 6.7 Idempotency and concurrency

- `turnId` is a client-generated UUID and the idempotency key. `TurnService`
  checks the `turns` row before touching the engine.
- One active turn per session. A per-session lock is acquired before the engine
  is called; a second request returns `409 TURN_IN_PROGRESS`.
- Retry of a terminal `turnId` returns `409 TURN_ALREADY_FINISHED`; the client
  reads `GET /api/turns/{id}` for the terminal snapshot. Delta replay is not
  part of v1.
- `TurnRunner` drains the engine independently of SSE subscribers. A subscriber
  that disconnects does not stall the engine or lose persistence. The journal is
  bounded (10 000 events / 2 MB) and exists for terminal recovery and debugging,
  not for replay.

---

## 7. Persistence

### 7.1 SQLite vs JSON

**Choose SQLite** for all domain state except artifact content and the artifact
manifest:

| Concern | SQLite | JSON files (legacy) |
|---|---|---|
| Atomic multi-record writes | transactions | rename-per-file, cross-file inconsistency |
| Concurrent read while streaming | WAL readers | ad-hoc |
| Query/ordering | indexes, SQL | in-memory scans (`src/main.ts:979-988`) |
| Migration | `schema_migrations` | ad-hoc field merging |
| Failure recovery | WAL + `busy_timeout` | partial writes |
| Legacy compatibility | read-only import | already the source |

Connection policy (MaxWire pattern, `maxwire/webapp/server.py:979-990`):
one connection per operation, `timeout=10`, `PRAGMA journal_mode=WAL`,
`PRAGMA busy_timeout=10000`, `PRAGMA synchronous=NORMAL`,
`PRAGMA foreign_keys=ON`. The backend is the **sole writer**. Electron never
opens the DB. Legacy mode never opens the v2 DB.

Database path: `<dataDir>/autoagent-v2.db`. When the backend runs standalone,
`<dataDir>` defaults to `~/.autoagent` (`AUTOAGENT_DATA_DIR` override;
`backend/src/autoagent_backend/paths.py:90-113`). The desktop keeps its own
userData at `${XDG_CONFIG_HOME:-~/.config}/autoagent` and passes its resolved
runtime root as `--data-dir` when spawning the backend. The AutoAgent engine
fallback config is **not** in the database: it is
`~/.autoagent/settings.json` (`AUTOAGENT_CONFIG_DIR` override).

### 7.2 Schema ownership

`adapters/persistence/migrations.py` owns the schema. Conceptual tables:

```
schema_migrations(version INTEGER PK, applied_at INTEGER)
sessions(id TEXT PK, title TEXT, created_at INTEGER, updated_at INTEGER,
         engine_session_ref TEXT NULL, engine_ref_updated_at INTEGER NULL,
         deleted_at INTEGER NULL, meta_json TEXT)
messages(id TEXT PK, session_id TEXT FK, turn_id TEXT NULL, role TEXT,
         text TEXT, created_at INTEGER, meta_json TEXT)
turns(id TEXT PK, session_id TEXT FK, state TEXT, stop_reason TEXT NULL,
      error_code TEXT NULL, error_message TEXT NULL, attempt INTEGER,
      started_at INTEGER, finished_at INTEGER NULL)
settings(id INTEGER PK CHECK(id=1), document TEXT, schema_version INTEGER,
         updated_at INTEGER)
mcp_servers(name TEXT PK, spec_json TEXT, enabled INTEGER, auto_run INTEGER,
            created_at INTEGER, updated_at INTEGER)
skills(name TEXT PK, source TEXT, enabled INTEGER, updated_at INTEGER)
kv(key TEXT PK, value TEXT)
```

- `settings.document` stores the normalized aggregate plus unknown fields, so
  unknown-field preservation is a storage concern, not a DTO concern.
- Message ordering is `(created_at, id)` and is owned by the store. There is no
  public message-write endpoint (`[contract §4.2]`).
- Artifacts remain filesystem-authoritative in v1: `manifest.json`,
  `<id>/index.html`, `versions/<ms>.html`, `thumbnail.png`
  (`src/main.ts:395-417`). `ArtifactStorePort` wraps that layout; no DB table is
  required until v1.1.

### 7.3 Migration from legacy

Read-only sources (`[contract §9.1]`). `<desktopDataDir>` is the legacy Electron
userData root (`${XDG_CONFIG_HOME:-~/.config}/autoagent` on Linux,
`%LOCALAPPDATA%\AutoAgent` on Windows, `~/Library/Application Support/autoagent`
on macOS); it is **not** necessarily the backend's default `~/.autoagent`.

| Data | Legacy path | Import through |
|---|---|---|
| Settings | `<desktopDataDir>/settings.json` | `SettingsPort.update` normalization |
| Sessions/messages | `<desktopDataDir>/sessions/<id>.json` | `SessionStorePort` + `EngineRefStorePort` |
| MCP servers | `<desktopDataDir>/chatwise.db` `tool` table | `McpRegistryPort` |
| Enabled skills | `<desktopDataDir>/skills.json` | `SkillCatalogPort` |
| Artifacts | `<desktopDataDir>/artifacts/manifest.json` + dirs | left in place; `ArtifactStorePort` reads them |
| Files | `<desktopDataDir>/files/` | left in place |

Procedure:

1. Resolve the backend data dir (`--data-dir`, `AUTOAGENT_DATA_DIR`, else
   `~/.autoagent`) and the desktop data dir. On Windows, if the stable desktop
   dir does not exist and `%TEMP%\autoagent-userdata` does, copy the legacy tree
   first (temp can be cleaned by the OS).
2. Open `autoagent-v2.db`; run schema migrations.
3. If `kv('legacy_migrated_at')` exists, stop (idempotent).
4. Import in one transaction per domain; collect counts and skipped records;
   never delete or mutate legacy files.
5. Preserve `claudeSessionId` as `engine_session_ref` after validating it is a
   UUID; invalid refs are dropped with a log line.
6. Write the marker and a migration summary to `migration.log`.

Rollback: set `AUTOAGENT_LEGACY=1`; legacy files are untouched. Do not delete
the v2 DB on rollback. **Known issue:** the packaged legacy entry is missing
its `main.js`, so the packaged rollback currently fails
([eval §Findings P1]); this must be fixed before legacy removal.

### 7.4 `engine_session_ref`

- Opaque to the SPA, opaque to services except `TurnService`.
- Stored as a string column, wrapped in `NewType` in code. `EngineRefStorePort`
  is the only read/write seam.
- Published only after a clean non-error `result` (`recon §5.6`), never from a
  failed or interrupted first spawn.
- Cleared when a resume gate rejects it or when the user branches a session
  (branches start fresh; the legacy branch code must not copy the ref —
  `legacy-inventory.md §2.2`).
- Never logged at info level; never returned in any DTO.

### 7.5 Engine configuration precedence

Full detail and the API shape live in `config-precedence.md`; this is the
normative summary implemented by `adapters/engine_config.py`.

**Model (highest first):**

1. Desktop app override (`Settings.model`, passed to opencc as `--model` for
   desktop sessions only) — source `override`.
2. `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` → `env.ANTHROPIC_MODEL` —
   source `claude-settings`.
3. Same file → top-level `model` — source `claude-settings`.
4. `~/.autoagent/settings.json` → `model` (`AUTOAGENT_CONFIG_DIR` override) —
   source `autoagent`.
5. Process `ANTHROPIC_MODEL` — source `env`.
6. OpenCC/MateBot default — source `default`.

**Credentials and base URL (highest first):**

1. Claude `settings.json` / `settings.local.json`
   (`env.ANTHROPIC_AUTH_TOKEN`, `env.ANTHROPIC_API_KEY`, `apiKeyHelper`,
   `env.ANTHROPIC_BASE_URL`) — source `claude-settings`.
2. `~/.autoagent/settings.json` (`apiKey` / `apiKeyHelper`, `baseURL`) — source
   `autoagent`.
3. Process environment (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`) — source `env`.
4. None.

**Rules:**

- Claude settings always win; the backend never overwrites them.
- Only AutoAgent-sourced values are applied to the engine child's environment
  (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`) before spawn; previous process
  values are restored when the AutoAgent config is cleared.
- The API (`GET/PUT /api/engine/config`) returns `model`, `baseURL`,
  `apiKeyConfigured`, `apiKeyHelperConfigured` and `path`; it **never** returns
  a key. Writes are atomic and mode `0600`; logs redact credentials.
- A desktop override does not mutate either settings file unless the user saves
  the AutoAgent fallback through `PUT /api/engine/config`.

---

## 8. Security boundary

### 8.1 Network

- Bind `127.0.0.1` only. `--host 0.0.0.0` is refused at startup with exit 2;
  `localhost` is normalized to `127.0.0.1` (`backend/src/autoagent_backend/config.py:99-106`).
- No CORS headers. Reject requests whose `Origin` is present and not exactly
  `http://127.0.0.1:<port>` — including static requests
  (`backend/src/autoagent_backend/api/deps.py:83-94`).
- Token-exempt paths: `/api/health` and the static SPA (`/`, `/assets/*`). The
  static page must load before the SPA can read the token. Every other
  `/api/*` request requires the launch token ([eval §I]).
- Body limit 1 MiB; turn text limit 100 000 characters
  (`[contract §3]`); JSON only.

### 8.2 Launch token and cookie

- Electron generates a 32-byte random token per launch; it is passed to the
  backend in the environment and never written to disk.
- The SPA receives it as a **query parameter** (`?token=…`) in the URL that
  Electron loads (`desktop/src/backend-manager.ts:111-114`). The SPA reads it,
  removes it from the address bar with `history.replaceState`, and keeps it in
  memory (`frontend/src/api/client.ts:43-52`).
- `POST /api/auth/session` exchanges the Bearer token for an HttpOnly,
  `SameSite=Strict`, `Path=/` cookie (no `Secure` because the origin is HTTP
  loopback). All `/api/*` accept either the cookie or `Authorization: Bearer`.
- Token comparison uses `hmac.compare_digest`.
- Electron must never expose the token to the renderer through a preload
  bridge; the SPA only reads it from its own URL.
- Logs redact the token; the logger registers it as a secret at startup.

### 8.3 No shell interpolation

- All child processes use argv arrays with `shell=False`.
- The engine is invoked as `<bun executable> <cli.js> <args...>`. No `.cmd`
  wrapper, no `cmd.exe /c`, no quoting layer.
- User-controlled values (`model`, `appendSystemPrompt`, `addDirs`, `env`
  values) are individual argv elements or environment entries. They are never
  concatenated into a command string.
- The legacy `claudeCommand` setting and `splitCommand`/`tokenizeCliArgs`
  (`src/engine-client.ts:38-55`) do not exist in the modern backend. The
  command is resolved from typed paths (`bun`, `cli.js`) with explicit env
  overrides (`AUTOAGENT_BUN_PATH`, `AUTOAGENT_OPENCC_CLI_PATH`).

### 8.4 Permission flag source (resolved)

The **legacy** code had three conflicting sources (all retired in the modern
adapter):

1. `resolveDefaultOpenccCommandValue()` embeds `--dangerously-skip-permissions`
   in the command value (`src/runtime-paths.ts:124-127`).
2. `EngineClient` always appends `--permission-mode <value>`, falling back to
   `default` when the setting is empty (`src/engine-client.ts:420`).
3. It also appends `--dangerously-skip-permissions` when
   `permissionMode === 'bypassPermissions'` (`src/engine-client.ts:423`), and
   the default setting is `bypassPermissions` (`src/main.ts:866`).

So the default spawn today can carry both `--dangerously-skip-permissions` and
`--permission-mode default`. That is ambiguous and must not ship.

**Resolution:**

- The modern engine adapter owns **all** permission flags. The command value
  contains no flags.
- A single typed mapping in `adapters/engine/argv.py`:
  - `PermissionPolicy.FULL_ACCESS` → exactly `--dangerously-skip-permissions`;
    **no** `--permission-mode`.
  - `PermissionPolicy.PROMPTED(mode)` → exactly `--permission-mode <mode>`;
    **no** bypass flag. This variant requires a future `PermissionBrokerPort`
    to answer `can_use_tool`; it is not implemented in v1.
- v1 supports `FULL_ACCESS` only, matching the current default and the MateBot
  reference (`recon §5.2`, `opencc_backend.py` uses
  `--dangerously-skip-permissions`). `SettingsService.update` rejects
  `default|acceptEdits|auto` with `400 PERMISSION_MODE_UNSUPPORTED` and a clear
  message. The broader literal in `api-contract-v1.md` is reserved for v1.1.
- A unit test asserts the argv never contains both flags. The packaged
  evaluation recorded exactly `--dangerously-skip-permissions` and **no**
  `--permission-mode` ([eval §E]).
- Rationale: the coordinator needs the full tool pool (`recon §3.1`), the
  product is a local single-user desktop app, and a half-implemented permission
  prompt would be a silent bypass. The explicit rejection is safer than a
  misleading setting.

### 8.5 Child environment and secrets

- The vendored `OpenccSession` owns the child environment: it inherits the
  parent, removes `CLAUDE_SESSION_ID`, `CLAUDECODE` and
  `CLAUDE_CODE_ENTRYPOINT`, and sets `FORCE_COLOR=0`
  (`vendor/matebot/opencc_backend.py:437-442`). The backend sets
  `CLAUDE_CONFIG_DIR=<dataDir>/.claude` and passes the resolved bun/CLI paths to
  the session factory.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are
  applied as environment variables, never argv. They are never returned by the
  API or logged.
- The backend does **not** currently set `OPENCC_ACTOR_NETWORKING=0`; the
  vendored session inherits it. Treat actor inbox exposure as a residual
  hardening item if actor networking is enabled in the vendored runtime.
- The modern shell exposes no environment dump and no `getShellEnv`; the legacy
  bridge is retired with the legacy entry.

### 8.6 Filesystem and artifacts

- The SPA never receives absolute server paths. Artifacts are addressed by id
  and served via `/api/artifacts/{id}/content`.
- Path arguments (`workDir`, artifact export/import targets) are validated:
  resolve, then require the result to be inside an allowed root (`dataDir` or
  the configured workspace) unless it came from a native dialog grant.
- No generic file read/write/remove/zip endpoints. No generic SQL or exec
  bridges (`[contract §4.10]`).
- Artifact iframe: `sandbox` without `allow-same-origin` when scripts are
  allowed; `postMessage` origin checks; a transparent shield during split-pane
  drags.

**Reviewed exception — workspace file browser (T0).** `GET /api/files*` and the
mutation routes in `api/routes/file_router.py` are a *root-scoped*, non-generic
surface. The threat model:

- Clients send a root id (`workspace` only in T0) plus a POSIX relative path.
  Absolute paths, drive letters, UNC prefixes, backslashes, NUL, `.`/`..` and
  over-long segments are rejected with `INVALID_PATH`.
- `SafeFileService` resolves the root through an injected resolver and requires
  the canonical path to equal the configured workspace. Every component is
  `lstat`-walked; symlinks are refused (`SYMLINK_NOT_ALLOWED`), including the
  final component. Opens use `O_NOFOLLOW` and revalidate after resolution.
- Writes are same-directory temp + fsync + `os.replace`; `expectedSha256`
  provides compare-and-swap and a mismatch returns `HASH_MISMATCH` with the
  original bytes untouched.
- Read/write/line/scan/copy caps are enforced in the adapter. The 1 MiB body
  cap is exempted only for `/api/files/upload`; that route streams and counts
  bytes against `file_max_write_bytes` and returns 413 before writing.
- No DTO or error body contains an absolute path. The `reveal` route returns
  501 unless a desktop-only hook is installed; T0 does not wire one.
- Uploads are raw `application/octet-stream`; no `python-multipart` dependency
  and no `File`/`Form` parameters (declaring them would break router import).
- Feature gate: `AUTOAGENT_FILES=0` omits the router; limits are
  `AUTOAGENT_FILE_MAX_READ_BYTES` / `AUTOAGENT_FILE_MAX_WRITE_BYTES`.

**Reviewed exception — browser preview (T0).** The desktop exposes a fixed
preview IPC surface (`window.autoagentPreview`) backed by one
`WebContentsView` per tab:

- Preview pages have no preload, no Node integration and a dedicated
  `persist:autoagent-preview` partition. They never see the launch token or the
  AutoAgent bridge.
- Navigation is allowlisted by exact `https:` origin from
  `AUTOAGENT_PREVIEW_ORIGINS`; the allowlist is empty by default. Window-open,
  permissions and downloads are denied. `autoagent-preview://` serves only
  explicitly registered roots with `realpath` containment, hidden-segment
  denial, MIME restrictions, 64 MiB cap and a restrictive CSP.
- Every IPC payload is revalidated in the main process and the sender must be
  the main window's top frame on the app origin. Errors carry a stable
  `preview:<code>`, never a URL or filesystem path.
- Rollback: `AUTOAGENT_PREVIEW=0` fails closed at startup; the Preview tab then
  reports that the bridge is unavailable.

**MCP runtime (T0).** One `McpConnectionManager` owns at most one live transport
per registered server; the SQLite registry remains the user-facing source.

- stdio children are executed as an argv vector with a scrubbed environment,
  started in their own process group and killed as a group. HTTP/SSE URLs must
  be http(s); user headers cannot set transport-owned headers.
- Tool calls pass through `ApprovalEngine` (default `ask` with read-only tools
  allowed). A destructive/open-world call returns 403 `MCP_APPROVAL_REQUIRED`
  with no argv/env in the details; `POST /api/mcp/approvals` records process-
  local consent (never persisted) and the caller retries.
- Status/log/event DTOs never contain env, headers or raw protocol frames.
  Logs are capped and redacted. `mcp.*` events are advisory invalidations.
- Connect/call/health timeouts, tool-cache invalidation on
  `notifications/tools/list_changed`, and exponential backoff are enforced in
  the adapter. `AUTOAGENT_MCP_PERSISTENT=0` restores the short-lived client.
- Engine turns do **not** yet consume these servers (T2); the backend manager
  is for UI/direct calls only.

**Event envelope (P0).** `GET /api/events` keeps the SSE event name and wraps
each payload as `{v, seq, ts, essential, data}`. `seq` is monotonic per
response; `essential` classifies state invalidations and approvals as
must-deliver. Each subscriber has a bounded queue: essential events evict the
oldest entry, non-essential status/log chatter is dropped, and unknown types
default to essential (fail-closed).

**Startup, quit and support (P0).** The desktop records a startup timeline
(module → backend spawn/ready → window → renderer first paint) and emits one
`app.startup` line; the renderer signals via the fixed `native:renderer:ready`
channel with a 5 s timeout. Shutdown runs named phases with a 75 s budget,
emits `app.quit_summary` and persists the previous summary for the next boot.
`GET /api/support/bundle` builds a redacted zip (manifest, health, settings,
aggregate counts, MCP metadata, log tails); message bodies, API keys,
environment values and MCP headers are excluded and the launch token is
registered as a redaction secret.

---

## 9. Concurrency and threading model

| Work | Thread | Notes |
|---|---|---|
| HTTP request handling | uvicorn event loop + Starlette threadpool for sync `def` endpoints | no blocking I/O on the event loop |
| Turn runner | one dedicated thread per active turn | drains `EnginePort.stream`, writes the journal, persists terminal state |
| Engine stdout | owned by the vendored `OpenccSession` reader thread | NDJSON parse; invokes `on_event` callbacks |
| Engine stderr | vendored `OpenccSession` reader thread | 40-line ring buffer; adapter logs redacted lines |
| MateBot adapter | callback threads from the vendored session | `_handle_frame`/`_handle_close` guarded by an `RLock`; events go to a per-turn queue |
| SQLite | one short-lived connection per operation | WAL; never hold a transaction while streaming |
| SSE writer | Starlette threadpool iterating a sync generator | reads journal by seq; 15 s heartbeat |
| Heartbeat watchdog | one daemon thread | checks parent PID + heartbeat every 2 s, exits after 15 s stale |

Rules: no shared mutable list/dict without a lock; services are synchronous and
re-entrant; `TurnRunner` owns the per-turn state; `TurnService` owns the
per-session lock map.

---

## 10. Observability

- Structured log lines: `ts level logger event key=value...`; no secrets.
- Metrics exposed as log summaries in v1 (active turns, engine processes, DB
  size, last migrate count). A `/api/diagnostics` endpoint is not public.
- Turn audit fields persisted: `turnId`, state, stop reason, error code,
  attempt, timings, usage tokens/cost when available. Raw frames are not
  persisted.
- Debug mode `AUTOAGENT_DEBUG_ENGINE=1` writes raw frames to the engine log with
  a prominent warning; never enable it in packaged defaults.

---

## 11. Deep-interface compliance checklist

Each item is a merge gate with a concrete pass/fail command.

| # | Criterion | Pass | Fail |
|---|---|---|---|
| 1 | Endpoints express use cases, not IPC channels | **36 business routes** (42 registrations including health, auth, events and engine config); no route named after a legacy channel; no `/db`, `/exec`, `/file` | one endpoint per legacy channel or any generic bridge |
| 2 | No representation leakage in DTOs | grep `backend/src/**/api/schemas.py` for `session_id`, `argv`, `pid`, `command`, `path`, `content_block`, `tool_use`, `resume`, `signal` → no hits (business `command`/`path` fields for MCP/workspace are allowed and reviewed) | any hit |
| 3 | Services framework-free | import-linter rule: `application/` and `domain/` may not import `fastapi`, `starlette`, `pydantic`, `sqlite3`, `subprocess`, `httpx`, `requests` | any import |
| 4 | Single composition root | `rg "MateBotEngine\(|SubprocessEngine\(|SqliteSessionStore\(|GitCliWorkspace\(" backend/src` only in `composition.py` | adapter constructed in a service or route |
| 5 | Ports are small and specified | every `Protocol` has a docstring with pre/post/raises; **≤ 8 methods** (implemented maximum: `SessionStorePort`, 8) | missing docstring or > 8 methods |
| 6 | No mutable internals returned | domain signatures use tuples/frozen dataclasses; `@dataclass(frozen=True, slots=True)` | returns `list`/`dict` internals or mutable rows |
| 7 | Services unit-testable with fakes | each service has a unit test using `FakeEngine`/`InMemorySessionStore`; no subprocess/DB required | unit test needs a real engine or DB |
| 8 | Adapter translation is golden-tested | recorded stream-json fixtures → exact domain-event list; SSE projection → exact JSON | any untested frame mapping |
| 9 | One error mapper | all 4xx/5xx JSON is `{ok:false,code,error}`; no traceback/argv/SQL | handler-specific error shapes |
| 10 | Auth boundary | unauth `GET /api/sessions` → 401; `/api/health` → 200; static `/` → 200; wrong-origin → 403 | any unauthenticated business route |
| 11 | Turn concurrency | two concurrent `POST /api/turns` for one session → one 200 stream, one 409 | both start |
| 12 | Cancel contract | an engine that ignores the interrupt still yields `turn.completed(cancelled)` within the deadline | stream hangs or ends in failure |
| 13 | Process death | kill child mid-turn → `error ENGINE_EXITED`; next turn recreates and succeeds | stream truncates silently or adapter stays dead |
| 14 | Resume gates | fixtures at 25 MiB and 14 days clear the ref and start fresh | oversized/old transcript is resumed |
| 15 | No raw frames on the wire | network capture contains no `raw`, `event`, `session_id`, `content_block`, `tool_use` fields | any raw field |
| 16 | Frontend has no business IPC | `rg "window.autoagent" frontend/src` → no business calls; only the fixed native allowlist | chat/settings calls through preload |
| 17 | One permission source | argv test: never both `--dangerously-skip-permissions` and `--permission-mode` | both present |
| 18 | Loopback only | `ss -ltnp` shows `127.0.0.1:<port>` only; `--host 0.0.0.0` exits 2 | `0.0.0.0` or `::` |
| 19 | Health is side-effect free | health test with DB/engine fakes that raise on any call still returns 200 | health touches DB/engine/network |
| 20 | Legacy isolation | `AUTOAGENT_LEGACY=1` starts no Python and no v2 DB writes. **Packaged** legacy rollback is a known P1 failure ([eval §Findings P1]) | legacy mode spawns the backend, or packaged rollback is claimed without the legacy bundle |

### 11.1 Implemented deviations

| Deviation | Evidence | Disposition |
|---|---|---|
| **Nuitka backend binary is not byte-reproducible** | Rebuild hashes differ; payload list, control fields and all non-backend assets are identical ([eval §B]) | Accepted. Do not fail a release on the backend hash alone; verify `--runtime-check` and a fake turn on the rebuilt binary |
| **36 business routes** (42 registrations) exceed the original `≤ 30` criterion | `evaluation.md` P2; routes are use-case endpoints, not IPC mirrors | Accepted after review; the checklist now uses 36 as the business-route budget and forbids generic bridges |
| **No root install/upgrade/remove test** | Evaluation ran without sudo; `dpkg -i`, postinst sandbox verification and desktop cache updates were not exercised ([eval §Limitations]) | Unverified release gate. Run on a disposable Ubuntu 24.04 machine before claiming install-grade release |
| **Packaged `AUTOAGENT_LEGACY=1` rollback is broken** | `entry.js` resolves legacy `main.js` outside the packaged tree; `ERR_MODULE_NOT_FOUND` ([eval §Findings P1]) | Must be fixed before legacy deletion; the modern path is unaffected |
| **Packaged fake-engine mode is refused** | `AUTOAGENT_ENGINE=fake` exits 2 when `AUTOAGENT_PACKAGED=1`; the GUI was verified with a scripted subprocess ([eval §G]) | Intentional; add an explicit override only if packaged demos/CI require it |

---

## 12. Decision ledger

| Decision | Principle | Evidence |
|---|---|---|
| FastAPI + Pydantic for the HTTP adapter | Specification as types; single framework boundary | `ch09:95-105, 159-192, 255-262`; `api-contract-v1.md` §3 |
| Framework-independent application core | Dependency inversion; adapters depend on abstractions | `ch08:53-71, 417-457`; `ch09:255-373` |
| `MateBotEngine` as the default `EnginePort` | Reuse the proven vendored long-connection implementation instead of reimplementing spawn/resume; adapter isolates it | `vendor/matebot/opencc_backend.py`; `adapters/engine/matebot_engine.py:1-7`; Adapter pattern `ch08:417-457` |
| One persistent engine child per conversation | Coordinator continuity; resume avoids transcript replay | `recon §5.5, §8.2`; `opencc_backend.py:10-15`; `MateBotEngine` LRU |
| `SubprocessEngine` kept as fallback | The vendored session can be unavailable; a direct argv adapter preserves function and enables scripted evaluation | `adapters/engine/subprocess_engine.py`; `[eval §E]` |
| Vendored sources loaded by path, never edited | Provenance and updateability; importlib keeps packaging simple | `vendor/README.md`; `matebot_engine.py:506-541` |
| One `TurnRunner` per active turn | SSE disconnect must not corrupt persistence | `api-contract-v1.md` §4.3 |
| SQLite single writer | Atomicity, WAL concurrency, one migrator | `maxwire/webapp/server.py:979-990`; `api-contract-v1.md` §9 |
| Opaque `engine_session_ref` | Representation hiding; resume strategy is free to change | `ch05:26-35, 343-412`; `api-contract-v1.md` §2.1 |
| Token + HttpOnly cookie | Local HTTP still needs an auth boundary; content URLs need cookies | `[eval §I]`; `api-contract-v1.md` §11 |
| Configuration precedence | Behave like the OpenCC CLI when the user already has Claude config; AutoAgent is a fallback | `config-precedence.md`; `adapters/engine_config.py:1-13` |
| One permission flag policy | Ambiguous flags currently conflict; security posture must be explicit | `[eval §E]`; `src/runtime-paths.ts:124-127`; `src/engine-client.ts:420-423`; `src/main.ts:866` |
| Legacy fallback | Rollback must be one env var until parity | `api-contract-v1.md` §8.3, §12; packaged rollback P1 in `evaluation.md` |
| CDS tokens + springs | User requires Apple-grade motion and Claude design language | `apple-design`; `elegant-claude-skill` |

---

## 13. Risks and non-goals

### 13.1 Non-goals for v1

- Remote worker hosting (`matebot-worker` server) is not part of the desktop.
- Feishu/Telegram bridges are unrelated transports.
- Prompted permission modes are deferred; only full access is supported.
- Delta replay after SSE disconnect is deferred; terminal snapshots recover.
- Windows packaging is deferred; the legacy Windows path remains until then.
- ChatWise tables other than `tool` are not migrated (`legacy-inventory.md` §5).

### 13.2 Residual risks (post-evaluation)

1. **Packaged legacy rollback is broken (P1).** `entry.js` resolves the legacy
   `main.js` outside the packaged tree. The modern path is unaffected, but the
   one-env rollback is not usable from the `.deb` until the legacy bundle is
   shipped ([eval §Findings P1]). Fix before legacy deletion.
2. **Nuitka non-determinism.** The backend binary hash differs across builds;
   all other payloads and semantics match ([eval §B]). Verify `--runtime-check`
   and a fake turn on every rebuilt binary; do not gate releases on the hash.
3. **No root install test.** `dpkg -i`, postinst sandbox verification and
   upgrade from the legacy package are unverified because the evaluation had no
   sudo ([eval §Limitations]). Run on a disposable Ubuntu 24.04 machine before
   an install-grade release.
4. **Vendored-session coupling.** `MateBotEngine` depends on the
   `OpenccSession` surface (`send`, `send_interrupt`, `close`, callbacks).
   An rsync update can change that surface. Mitigation: the `SessionLike`
   Protocol and the adapter tests; always run the `--matebot` smoke test after
   updating `vendor/matebot`.
5. **Capacity and long-run behavior.** Max-4 LRU is enforced, but the 8-hour/
   200-turn soak and a real-model engine smoke were not run in the independent
   evaluation ([eval §Limitations]). Run both before claiming long-run
   stability.
6. **Actor networking and real-model behavior.** The backend inherits
   `OPENCC_ACTOR_NETWORKING`; the evaluation used a scripted CLI, not a live
   model. Harden actor networking if enabled and run one real-model turn in the
   release checklist.
