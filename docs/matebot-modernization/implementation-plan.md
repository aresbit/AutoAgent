# AutoAgent / MateBot Modernization — Implementation Plan

Status: **as built** (updated 2026-10-17 to match the implemented design).
Owner: Blueprint (planning)
Date: 2026-10-17
Companion: `architecture.md` (decisions), `api-contract-v1.md` (frozen surface),
`opencc-delta.md` (opencc merge procedure), `config-precedence.md`,
`evaluation.md` (M7 result).

Owner labels below are **roles**, not personal names. The coordinator maps them
to teammates in the PM tool. A file has exactly one owner at a time.

---

## 1. Assumptions and gates

### 1.1 Verified environment

| Tool | Version / status | Evidence |
|---|---|---|
| Ubuntu | 24.04 (target) | user constraint; evaluation ran on 24.04 |
| Python | 3.12.3 | `python3 --version` |
| uv | 0.11.28 | `uv --version`; `backend/uv.lock` committed |
| Bun | 1.3.13 | `bun --version` |
| Node | 18.19.1 | `node --version` |
| FastAPI | installed via `uv sync --frozen` | `[eval §A]` |
| Nuitka | installed as a build dependency; standalone backend built | `scripts/build-backend.sh`; `[eval §B]` |

### 1.2 Gates that apply to every milestone

1. `AUTOAGENT_LEGACY=1` still starts the untouched legacy app in development.
   **Known P1:** the packaged legacy entry is missing `main.js`, so the packaged
   rollback fails ([eval §Findings P1]); fix before legacy deletion.
2. No source under `src/` is deleted before the M7 evaluation and the packaged
   rollback fix.
3. Contract changes are additive and go through `api-contract-v1.md`; no
   milestone invents a business DTO ad hoc.
4. Every new adapter has a unit test with a fake and an integration test with
   the real dependency.
5. Every new endpoint has a token/Origin test and a 4xx-path test.
6. `backend/` framework-import rule and the deep-interface checklist
   (`architecture.md` §11) pass.
7. The default engine mode is `matebot`; `subprocess` is the fallback and
   `fake` is for tests/demos only (refused when `AUTOAGENT_PACKAGED=1`).

---

## 2. Milestones

### M1 — opencc sync + backend skeleton/health

**Goal:** the vendored engine exposes `--matebot`, `vendor/matebot` is pinned
and loadable, and a FastAPI backend starts, answers a side-effect-free health
probe, and has the layering skeleton in place.

**Dependencies:** none. This is the first lane.

**Owner:** `opencc-eng` (engine merge/build + vendoring) + `backend-core`
(skeleton).

**File-level tasks**

| Owner | Files | Task |
|---|---|---|
| opencc-eng | `/home/tars/yysapp/AutoAgent/packages/opencc/**`, root `bun.lock`, root `package.json` | Perform the selective three-way merge from `opencc-delta.md` §7. Preserve the 19 local deviations, port `SelfImprovingTool` storage to `LearnTool`, adopt upstream build/deps, decide the MemoryTool patch explicitly. Do not blind-replace the subtree. |
| opencc-eng | `packages/opencc/dist/cli.js` | Rebuild; verify `--matebot`, `--input-format`, `--output-format`, `--include-partial-messages`, `--resume`, `--append-system-prompt`. |
| opencc-eng | `vendor/matebot/**`, `vendor/opencc` (symlink), `vendor/README.md` | Vendor MateBot core code at `c0deb163` with the exclusion rsync in `vendor/README.md`; symlink `vendor/opencc -> ../packages/opencc`; record the upstream commit. Do not edit vendored files in place. |
| backend-core | `backend/pyproject.toml`, `backend/uv.lock` | Create a uv project. Runtime deps: `fastapi`, `uvicorn`, `pydantic>=2`. Dev deps: `pytest`, `httpx`, `ruff`, `mypy`, `lint-imports`, and `nuitka` for M6. Pin exact versions in the lock. |
| backend-core | `backend/src/autoagent_backend/__main__.py`, `config.py`, `paths.py`, `watchdog.py`, `logging_setup.py` | CLI fast paths (`--version`, `--runtime-check`, `--health-check`), env parsing, data/state/runtime/log paths, vendored-MateBot path resolution, rotating log handlers with a redaction filter. |
| backend-core | `backend/src/autoagent_backend/app.py`, `composition.py`, `errors.py` | App factory, lifespan, container, domain-error→HTTP mapper. Engine mode selection: `matebot` (default) / `subprocess` / `fake`. |
| backend-core | `backend/src/autoagent_backend/api/routes/health.py`, `api/deps.py` | `/api/health` returns the §3.4 shape from in-memory state; no DB, engine or network I/O. |
| backend-core | `backend/src/autoagent_backend/domain/models.py`, `domain/errors.py` | Minimal frozen value objects and domain exception base. |
| backend-core | `backend/tests/unit/test_config.py`, `tests/integration/test_health.py`, `tests/integration/test_config_defaults.py` | Health works with failing DB/engine fakes; paths are stable; token exemption; `engine=matebot` default. |
| backend-core | `backend/tests/test_import_boundaries.py` or `pyproject.toml` lint-imports config | Enforce the framework-free core rule. |

**Acceptance commands**

```bash
cd /home/tars/yysapp/AutoAgent

# Engine
bun install
(cd packages/opencc && bun run build)
bun packages/opencc/dist/cli.js --version
bun packages/opencc/dist/cli.js --help | grep -E -- '--matebot|--input-format|--output-format'
grep -c 'OPENCC_MATEBOT' packages/opencc/dist/cli.js

# Vendored MateBot
test -f vendor/matebot/opencc_backend.py
test -L vendor/opencc
grep -n 'class OpenccSession' vendor/matebot/opencc_backend.py
git ls-files -s vendor/opencc 2>/dev/null || true

# Backend
cd backend
uv sync --frozen
uv run python -m autoagent_backend --version
uv run pytest -q
uv run ruff check src tests
uv run mypy src
uv run lint-imports

# Runtime resolution: default engine is matebot; vendor is found
AUTOAGENT_MATEBOT_VENDOR_DIR="$PWD/../vendor/matebot" \
AUTOAGENT_BUN_PATH="$(command -v bun)" \
AUTOAGENT_OPENCC_CLI_PATH="$PWD/../packages/opencc/dist/cli.js" \
uv run python -m autoagent_backend --runtime-check | python3 -m json.tool

# Health (no I/O)
uv run python -m autoagent_backend --port 8787 --data-dir /tmp/autoagent-m1 &
sleep 1
curl -fsS http://127.0.0.1:8787/api/health | python3 -m json.tool
kill %1
```

Expected: `--matebot` appears in help; `--runtime-check` reports
`"engineMode": "matebot"` and `"matebotVendorExists": true`; health returns
`ok:true`, `app:"autoagent"`, non-empty `bootId`, and answers in well under a
second; the core import test fails if anyone imports FastAPI from
`domain/`/`application/`.

**Artifacts**

- Rebuilt `packages/opencc/dist/cli.js` with coordinator assets.
- `backend/uv.lock`.
- A recorded `opencc-delta` checklist result (which of the 19 deviations were
  kept, dropped, or ported).
- Health fixture JSON.

**Rollback**

- `git revert` the opencc merge commit; keep the previous `dist/cli.js` as a
  build artifact backup until M2 passes.
- The backend is not wired into Electron yet, so no user-facing rollback is
  needed.
- If the merge blocks, the old `dist/cli.js` still serves the legacy path; do not
  start M2 before `--matebot` is verified.

---

### M2 — persistent `EnginePort` + SSE turn + persistence

**Goal:** the default `MateBotEngine` owns one persistent vendored
`OpenccSession` per application session, with the full turn state machine over
SSE, cancel, process-death recovery, max-4 LRU and SQLite persistence. A
`SubprocessEngine` fallback and a `FakeEngine` remain available.

**Dependencies:** M1 (engine `--matebot`, vendored module, backend skeleton).

**Owners:** `backend-engine` (MateBotEngine + vendored loader + stream/resume),
`backend-core` (domain/services/API), `backend-adapters` (SQLite/config),
`cartographer` (DTO/contract review).

**File-level tasks**

| Owner | Files | Task |
|---|---|---|
| backend-core | `domain/ports.py`, `domain/events.py`, `domain/values.py`, `domain/models.py` | Declare `EnginePort`, `SessionStorePort`, `TurnStorePort`, `EngineRefStorePort`, `SettingsPort`, `AutoAgentConfigPort`, `EngineConfigPort`, `ClockPort`; domain events; `EngineSessionRef`, `CallRef`; frozen models. Docstrings with pre/post/raises. |
| backend-engine | `adapters/engine/matebot_engine.py` | **Default `EnginePort`.** Load `vendor/matebot/opencc_backend.py` by path via `importlib`; cache per resolved path; wrap `OpenccSession` in a `SessionLike` Protocol; one session per application session; max-4 LRU; cancel synthesis; ref read/write via `EngineRefStorePort`; child-close → `ENGINE_EXITED` / cancelled. |
| backend-engine | `adapters/engine/argv.py` | Single permission/flag mapping. v1: `--dangerously-skip-permissions` alone. Unit test asserts mutual exclusion. |
| backend-engine | `adapters/engine/process.py`, `stream_json.py`, `resume.py`, `subprocess_engine.py` | **Fallback** direct adapter: argv arrays, env scrub, reader threads, stderr ring buffer, NDJSON parser, resume gates (25 MiB / 14 days), interrupt/terminate/kill. |
| backend-engine | `adapters/engine/fake_engine.py`, `failing_engine.py` | `fake` is for tests/demos only (refused when `AUTOAGENT_PACKAGED=1`); `FailingEngine` degrades boot when the vendored module cannot load. |
| backend-adapters | `adapters/claude_settings.py`, `autoagent_config.py`, `engine_config.py`; `application/engine_config_service.py` | Read Claude and AutoAgent config; implement the precedence chain from `config-precedence.md`; apply AutoAgent-sourced base URL/token to the child; never return secrets. |
| backend-core | `application/turn_service.py`, `application/session_service.py` | Per-session lock; idempotent `turnId`; append user message; `TurnRunner`; persist result; never cancel on subscriber disconnect. |
| backend-core | `composition.py` | Select engine: `matebot` (default), `subprocess`, `fake`; construct `MateBotEngine(session_factory=..., refs=sessions, max_sessions=AUTOAGENT_MAX_ENGINES)`; refuse `fake` in packaged mode. |
| backend-adapters | `adapters/persistence/sqlite.py`, `migrations.py`, `session_store.py` | WAL, busy timeout, one connection per operation, schema migrations, engines ref column (`SessionStorePort` + `TurnStorePort` + `EngineRefStorePort`). |
| backend-core | `api/schemas.py`, `api/errors.py`, `api/sse.py`, `api/routes/auth.py`, `sessions.py`, `turns.py`, `engine_config.py` | DTOs, single error mapper, SSE framing/heartbeat/seq, token→cookie exchange, turn endpoints, engine-config endpoints. |
| backend-adapters | `adapters/persistence/settings_store.py`, `legacy_import.py` | Settings document with unknown fields; first-run legacy import with marker, UUID validation, no deletes. |
| backend-core | `tests/unit/test_turn_service.py`, `test_matebot_engine.py`, `test_argv.py`, `test_resume.py`, `test_engine_config_resolver.py`, `test_claude_settings.py`, `test_autoagent_config.py`; `tests/golden/**`; `tests/integration/test_turns_api.py`, `test_matebot_engine.py`, `test_engine_process.py` | Fakes for every state; vendored-module loading; LRU/capacity; cancel synthesis; death/recreate; config precedence; golden stream-json; SSE assertion; kill-at-each-state fault tests. |

**Acceptance commands**

```bash
cd /home/tars/yysapp/AutoAgent/backend
uv run pytest -q tests/unit tests/integration tests/golden

# Default engine is MateBotEngine; vendored module resolves
AUTOAGENT_ENGINE=matebot \
AUTOAGENT_MATEBOT_VENDOR_DIR="$PWD/../vendor/matebot" \
AUTOAGENT_BUN_PATH="$(command -v bun)" \
AUTOAGENT_OPENCC_CLI_PATH="$PWD/../packages/opencc/dist/cli.js" \
uv run python -m autoagent_backend --runtime-check | python3 -m json.tool

# Fallback engine with a scripted CLI (no model call)
AUTOAGENT_ENGINE=subprocess \
AUTOAGENT_BUN_PATH="$(command -v bun)" \
AUTOAGENT_OPENCC_CLI_PATH="$PWD/tests/fixtures/fake_cli.js" \
AUTOAGENT_API_TOKEN=test-token \
  uv run python -m autoagent_backend --port 8788 --data-dir /tmp/autoagent-m2-subprocess &

# Fake engine end-to-end (no model call)
AUTOAGENT_ENGINE=fake AUTOAGENT_API_TOKEN=test-token \
  uv run python -m autoagent_backend --port 8787 --data-dir /tmp/autoagent-m2 &
TOKEN=test-token
SID=$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"m2"}' http://127.0.0.1:8787/api/sessions | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
TID=$(python3 -c 'import uuid;print(uuid.uuid4())')
curl -N -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"text\":\"hello\"}" \
  http://127.0.0.1:8787/api/turns/$TID/stream
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/turns/$TID
kill %1

# Real MateBot engine smoke (scratch config dir under the data dir, one turn)
AUTOAGENT_ENGINE=matebot AUTOAGENT_MATEBOT_VENDOR_DIR="$PWD/../vendor/matebot" \
AUTOAGENT_BUN_PATH="$(command -v bun)" \
AUTOAGENT_OPENCC_CLI_PATH="$PWD/../packages/opencc/dist/cli.js" \
  uv run python -m autoagent_backend --port 8789 --data-dir /tmp/autoagent-m2-real &
# send one turn through the API, then kill the child and confirm ENGINE_EXITED
```

Expected: default `engineMode` is `matebot` and `matebotVendorExists` is true;
the fallback passes the same turn suite; text/thinking/tool/usage/completion
events; cancel terminal event; `ENGINE_EXITED` on kill; next turn recreates and
succeeds; no raw frames on the wire; only `127.0.0.1` listening.

**Artifacts**

- Golden stream-json fixtures (`tests/golden/fixtures/*.jsonl`) and expected
  domain-event/SSE outputs.
- A turn-state diagram test report, including LRU/capacity and death/recreate.
- `autoagent-v2.db` schema and migration fixture.
- `--runtime-check` output showing `engineMode: matebot` and
  `matebotVendorExists: true`.

**Rollback**

- Backend is still not the default desktop path; the legacy app is unaffected.
- Switch `AUTOAGENT_ENGINE=subprocess` to bypass the vendored module, or
  `AUTOAGENT_ENGINE=fake` for CI/demos.
- If the vendored module cannot load, `FailingEngine` surfaces the error in
  `/api/engine/status` rather than crashing the backend.

---

### M3 — Electron thin shell + dev run

**Goal:** Electron starts the backend, waits for health, loads
`http://127.0.0.1:<port>/`, and owns shutdown/orphan cleanup. The legacy entry
remains one env var away.

**Dependencies:** M1 (health), M2 (turns) for a usable dev app. The shell can be
built in parallel with M2 against `/api/health` and a mock bootstrap.

**Owner:** `desktop-shell`.

**File-level tasks**

| Owner | Files | Task |
|---|---|---|
| desktop-shell | `desktop/src/entry.ts` | `AUTOAGENT_LEGACY === '1'` imports `../../src/main.js`; otherwise `./main.js`. |
| desktop-shell | `desktop/src/main.ts`, `backend-manager.ts`, `paths.ts`, `logging.ts` | Single-instance retries, XDG desktop data dir (`${XDG_CONFIG_HOME:-~/.config}/autoagent`), port scan, token, spawn (`--data-dir` + `AUTOAGENT_STATE_DIR`), `AUTOAGENT_CONFIG_DIR=~/.autoagent`, `bootId`, health wait, heartbeat, PID verification, backend-exit shutdown, async startup error dialog with timeout. |
| desktop-shell | `desktop/src/window.ts` | `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`; load URL with `?token=…`; the SPA removes it with `history.replaceState`; navigation policy; renderer recovery. |
| desktop-shell | `desktop/src/preload.ts`, `desktop/src/native/*.ts` | Native-only allowlist; no generic invoke/send; no business methods. |
| desktop-shell | `scripts/build-desktop.mjs`, root `package.json` | Add `build:modern`, `dev:modern`, `dev:legacy`; keep the legacy bundle target; `main` points at the entry bundle. |
| desktop-shell | `scripts/smoke-desktop.sh` (new) | Start modern, curl health, assert loopback, close, assert backend gone. |
| desktop-shell | `packaging/deb/usr/bin/autoagent` (coordinate with packaging) | Keep the Wayland socket check; add post-exit backend stop fallback via PID file. |

**Acceptance commands**

```bash
cd /home/tars/yysapp/AutoAgent
bun install
bun run build:desktop
bun run dev:modern
# manual/instrumented checks:
#  - window URL origin is http://127.0.0.1:<port>
#  - ss -ltnp | grep <port> shows 127.0.0.1 only
#  - curl without token -> 401; /api/health -> 200
#  - kill -9 the backend -> Electron exits
#  - close Electron -> backend pid is gone within 5 s
AUTOAGENT_LEGACY=1 bun run dev:legacy
# legacy window, legacy IPC, legacy data paths still work (development only;
# the packaged legacy bundle is currently a P1 finding — see evaluation.md)
```

Expected: no Python is spawned in legacy mode; no legacy IPC is registered in
modern mode; the log contains the chosen port, bootId and shutdown reason; the
address bar no longer contains `token` after boot.

**Artifacts**

- `dist/desktop/main.js`, `dist/desktop/preload.cjs`, `dist/entry.js`.
- `scripts/smoke-desktop.sh` output.
- A short lifecycle trace in `docs/matebot-modernization/` if the coordinator
  asks for one.

**Rollback**

- `AUTOAGENT_LEGACY=1` (one env var) — the primary rollback.
- Revert the root `package.json` `main` change; the old `dist/main.js` remains
  built.

---

### M4 — modern frontend chat UI

**Goal:** replace the monolithic `src/renderer/app.tsx` with a React + TS +
Tailwind + shadcn/ui SPA using CDS tokens and motion, covering sessions,
streaming chat, cancel and core settings.

**Dependencies:** M2 (turn SSE), M3 (shell). The frontend can start at M2 with
the frozen contract and a mock server.

**Owner:** `frontend-chat`.

**File-level tasks**

| Owner | Files | Task |
|---|---|---|
| frontend-chat | `frontend/package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `components.json`, `index.html` | Vite major compatible with Node 18 (pin it; Vite 5 is the safe default), React 19, Tailwind 3.4.19, shadcn/ui, `motion`, TanStack Query, Vitest. |
| frontend-chat | `src/api/client.ts`, `sse.ts`, `types.ts`, `queries.ts` | Typed fetch, `?token=` capture + `history.replaceState` + token→cookie exchange, SSE parser (`fetch` + `ReadableStream`), generated types from OpenAPI, error mapping. |
| frontend-chat | `src/cds/theme.css`, `motion/presets.ts`, `atoms/**`, `stream/**`, `hooks/**`, `index.ts` | CDS tokens, five spring presets, material/depth/typography foundations (`architecture.md` §4.2), Composer (IME guard), MessageBubbles, ThinkingAccordion, ToolDecisionCard, scroll pinning, reduced motion, focus rings. |
| frontend-chat | `src/app/App.tsx`, `Shell.tsx`, `providers.tsx` | Three-pane shell, session sidebar, chat transcript, right panel, resizable dividers with 4 px dead zone/Esc revert, layout persistence. |
| frontend-chat | `src/features/sessions/**`, `chat/**`, `settings/**` | List/create/select/delete; stream rendering; stop; core settings (provider, model, base URL, masked key, workspace, permission, budgets, turns, tools, layout). The permission control shows full access only in v1; other modes are rejected by the backend. |
| frontend-chat | `src/features/settings/engine-config.tsx` | Show the effective model + source badge (`override`, `claude-settings`, `autoagent`, `env`, `default`), an optional per-app override, and the AutoAgent fallback editor backed by `GET/PUT /api/engine/config`; never render a key. |
| frontend-chat | `src/features/chat/markdown.tsx` | Markdown/GFM, sanitized HTML, code blocks, inline `artifact-html`. |
| frontend-chat | `frontend/tests/**` | Pure-function tests (SSE parser, layout clamping, IME guard), component tests. |
| frontend-chat | `scripts/build-desktop.mjs` (coordinate) | Build frontend and copy `frontend/dist` → `dist/client`. |

**Acceptance commands**

```bash
cd /home/tars/yysapp/AutoAgent/frontend
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
python3 /home/tars/.claude/skills/elegant-claude-skill/scripts/cds_audit.py src

cd ..
bun run build:modern
bun run dev:modern
# e2e: create session -> send -> see text/thinking/tool -> cancel -> reload
```

Expected: no `window.autoagent` business calls; no raw colors in features; no
infinite spinner; IME Enter does not submit; streaming scroll is not stolen;
light/dark screenshots reviewed.

**Artifacts**

- `frontend/dist`.
- Screenshots (light/dark) for sessions, chat streaming, settings, empty/error.
- `tsc`/Vitest/CDS audit logs.

**Rollback**

- Serve the legacy `dist/client` when `AUTOAGENT_LEGACY=1` (already the case).
- Keep the frontend build behind `build:modern`; legacy build path unchanged.

---

### M5 — parity panels (skills / MCP / workspace / artifacts)

**Goal:** full v1.1 parity so the legacy IPC surface can eventually be deleted.

**Dependencies:** M2 (ports/persistence), M4 (UI shell).

**Owners:** `backend-adapters`, `frontend-panels`, `cartographer`.

**File-level tasks**

| Owner | Files | Task |
|---|---|---|
| backend-adapters | `adapters/skills/fs_catalog.py`, `application/skill_service.py`, `api/routes/skills.py` | Catalog/discover/enable/disable; atomic `.disabled` moves; source precedence; return the new catalog. |
| backend-adapters | `adapters/mcp/client.py`, `adapters/persistence/mcp_store.py`, `application/mcp_service.py`, `api/routes/mcp.py` | Server CRUD, enable/disable, discovery, invocation; hide transports and JSON-RPC; timeouts and child cleanup. |
| backend-adapters | `adapters/workspace/git_cli.py`, `application/workspace_service.py`, `api/routes/workspace.py` | Status/diff/branch/init; timeouts; no shell interpolation; one status aggregate. |
| backend-adapters | `adapters/artifacts/fs_store.py`, `application/artifact_service.py`, `api/routes/artifacts.py` | List/get/create/content/export/import; keep `manifest.json` authoritative in v1; path validation. |
| frontend-panels | `frontend/src/features/skills/**`, `mcp/**`, `workspace/**`, `artifacts/**` | Panels matching M4 design; native dialogs only for import/export/open. |
| cartographer | `api-contract-v1.md` (additive only) | Record any contract clarification; no breaking DTO changes. |
| backend-adapters | `backend/tests/integration/{test_skills,test_mcp,test_workspace,test_artifacts}.py` | Fixture-based tests; no live network for MCP (fake transport). |

**Acceptance commands**

```bash
cd /home/tars/yysapp/AutoAgent/backend
uv run pytest -q tests/integration

cd ../frontend
bun run typecheck && bun run test && bun run build

cd ..
bun run dev:modern
# parity matrix:
#  skills scan/toggle + source dirs
#  MCP list/save/toggle/delete/discover
#  git stat/branches/changed files/diff/branch switch/init
#  artifacts list/open/export/import/versions
```

**Artifacts**

- A parity matrix table mapping every legacy `D` channel
  (`api-contract-v1.md` §7) to its endpoint and UI location.
- Fixture data for each panel.

**Rollback**

- Panels can be feature-flagged in the SPA; the backend routes can ship disabled
  in the router.
- Legacy mode still exposes the old IPC panels until the matrix is complete.

---

### M6 — packaging (Nuitka/uv) + `.deb` + X11/Wayland

**Goal:** a self-contained `.deb` that runs the modern shell, backend and engine
on Ubuntu 24.04 under X11 and Wayland.

**Dependencies:** M3, M4; M5 for a complete app but not for the packaging spike.

**Owners:** `packaging` (lead), `backend-core` (Nuitka includes), `desktop-shell`
(paths/launcher).

**File-level tasks**

| Owner | Files | Task |
|---|---|---|
| packaging | `backend/pyproject.toml` | Add Nuitka as a build dependency; pin it. |
| packaging | `scripts/build-backend.sh` | `nuitka --standalone` for `autoagent_backend/__main__.py` with explicit includes for `uvicorn`, `fastapi`, `pydantic`, `pydantic_core`, `starlette`, `anyio`; verify `--version`, `--runtime-check` (must report `matebotVendorExists`), `--health-check` and a fake turn. Vendored MateBot is **not** bundled; it is loaded by path at runtime. |
| packaging | `scripts/build-desktop.mjs` | Build `frontend/dist` and the modern main/preload; keep the legacy bundle until M7 and the packaged rollback fix. |
| packaging | `scripts/build-deb.sh` | Stage `/opt/autoagent/{desktop,backend,engine,frontend,vendor/matebot}`; preflight `vendor/matebot/opencc_backend.py`; run the staged backend `--runtime-check`; keep the reproducibility and `flock` guarantees. |
| packaging | `packaging/deb/**` | Control deps; launcher exports `AUTOAGENT_MATEBOT_VENDOR_DIR=$APP_DIR/vendor/matebot` and **does not** set `AUTOAGENT_ENGINE` (backend defaults to `matebot`); Wayland socket check; post-exit stop fallback; desktop file; icons. |
| desktop-shell | `desktop/src/paths.ts`, `backend-manager.ts` | Resolve packaged paths: `/opt/autoagent/backend/autoagent-backend`, `/opt/autoagent/engine/bun`, `/opt/autoagent/engine/opencc-dist/cli.js`, `/opt/autoagent/vendor/matebot`; dev fallbacks. |
| packaging | `scripts/smoke-packaged.sh` | Install into a disposable tree, start under X11 and Wayland, health, one turn (fake or scripted subprocess), shutdown, orphan check; assert the vendored module exists and `--runtime-check` reports it. |

**Acceptance commands**

```bash
cd /home/tars/yysapp/AutoAgent
uv run --project backend nuitka --version
bash scripts/build-backend.sh
backend/build/autoagent-backend --version
AUTOAGENT_MATEBOT_VENDOR_DIR="$PWD/vendor/matebot" \
AUTOAGENT_BUN_PATH="$(command -v bun)" \
AUTOAGENT_OPENCC_CLI_PATH="$PWD/packages/opencc/dist/cli.js" \
  backend/build/autoagent-backend --runtime-check | python3 -m json.tool

bash scripts/build-deb.sh
dpkg-deb -c release/autoagent_*.deb | grep -E 'opt/autoagent/(backend|engine|desktop|frontend|vendor/matebot)'
bash scripts/smoke-packaged.sh

# On a clean Ubuntu 24.04 VM/container:
sudo dpkg -i release/autoagent_*.deb
autoagent            # X11 (DISPLAY set)
autoagent            # Wayland (WAYLAND_DISPLAY set, socket present)
# verify: health, one turn, close, no orphan backend
```

Expected: no network install at runtime; backend binary starts without a system
Python; `--runtime-check` reports `"engineMode": "matebot"` and
`"matebotVendorExists": true`; SSE streams under the packaged binary; the
launcher falls back to X11 when the Wayland socket is missing; no orphan
process after exit. The backend binary is **not byte-reproducible**; compare
payload lists and semantics instead ([eval §B]).

**Artifacts**

- `backend/build/autoagent-backend` (+ its lib tree).
- `release/autoagent_<version>_amd64.deb`.
- Staged `/opt/autoagent/vendor/matebot/` Python sources.
- Packaging smoke logs for X11 and Wayland.
- A size/startup measurement (backend binary, deb, cold start) for the record.

**Rollback**

- Ship the previous `.deb`.
- If Nuitka fails, publish the embedded-Python variant under the same layout;
  the API and desktop are unchanged.
- **Known P1:** the packaged `AUTOAGENT_LEGACY=1` entry currently lacks the
  legacy `main.js` ([eval §Findings P1]). Do not claim packaged rollback is
  working until the legacy bundle is shipped in the app tree.

---

### M7 — independent evaluation

**Goal:** an independent evaluator, not the implementers, proves the system is
correct, secure and at parity before legacy deletion.

**Dependencies:** M1–M6.

**Owner:** `evaluator` (independent). Implementers may fix findings but may not
mark the milestone.

**Status:** completed 2026-10-17. The independent report is
`evaluation.md` (signed by Verifier). Result: **PASS on P0 gates A–I**; one P1
(packaged legacy rollback) and P2 follow-ups (Nuitka non-determinism, 36-route
gate reconciliation). Root install/upgrade/remove, real-model smoke and the
long soak remain unverified.

**File-level tasks**

| Owner | Files | Task |
|---|---|---|
| evaluator | `docs/matebot-modernization/evaluation.md` | Findings, evidence, pass/fail per check, residual risks. |
| evaluator | `backend/tests/e2e/**` | Scenario tests: first run/migration, sessions, stream, cancel, kill, settings, panels, shutdown. |
| evaluator | `scripts/eval/**` | Security probes (unauth, wrong Origin, token replay, traversal), argv inspection, loopback check, orphan check. |
| evaluator | fixtures under `backend/tests/fixtures/**` | Migration fixtures for Linux and the Windows temp tree. |

**Evaluation gates and result**

| Gate | Result |
|---|---|
| 1. Deep-interface checklist (`architecture.md` §11) | PASS (route-count budget reconciled in §11.1) |
| 2. Parity matrix (`api-contract-v1.md` §10) | PASS |
| 3. Security: unauth/wrong-origin/traversal/argv; no secrets in logs | PASS |
| 4. Lifecycle: backend death, close, stale cleanup, heartbeat | PASS |
| 5. Engine: persistent child, `--matebot`, cancel, death/recreate | PASS (scripted CLI; no live model) |
| 6. Migration idempotency and legacy preservation | Covered by tests; not re-run as a long acceptance |
| 7. Soak (8 h / 200 turns) | **NOT VERIFIED** |
| 8. Rollback drill | **FAIL (P1)** — packaged legacy entry missing `main.js` |
| 9. Packaged app on X11 and Wayland | PASS |

**Acceptance commands**

```bash
cd /home/tars/yysapp/AutoAgent
uv run --project backend pytest -q backend/tests
bash scripts/smoke-packaged.sh
bash scripts/eval/security.sh
bash scripts/eval/lifecycle.sh
bash scripts/eval/soak.sh --turns 200        # still required
AUTOAGENT_LEGACY=1 bun run dev:legacy        # development sign-off
# packaged rollback: blocked by the P1 finding until the legacy bundle ships
```

**Artifacts**

- `evaluation.md` with the signed pass/fail table.
- Security/lifecycle logs and temporary GUI screenshots.
- Migration fixture results.

**Rollback / exit criteria**

- The modern path is safe to deliver (P0: none).
- **Do not delete legacy source** until: the packaged `AUTOAGENT_LEGACY=1` path
  is fixed and re-tested; a root `dpkg -i`/upgrade/remove run passes on a
  disposable Ubuntu 24.04 machine; and the real-model smoke + soak are recorded.
- `AUTOAGENT_LEGACY=1` remains the development rollback.

---

## 3. Parallelization map

```
M1  opencc-eng (merge + vendor) ──┐
    backend-core (skeleton) ───────┤
                                   v
M2  backend-core ─── backend-engine (MateBotEngine) ─── backend-adapters ─── cartographer
                                   │
M3  desktop-shell ─────────────────┤ (can start against /api/health + mock bootstrap)
M4  frontend-chat ─────────────────┤ (can start at M2 with the frozen contract)
M5  backend-adapters ─── frontend-panels ─── cartographer
M6  packaging ─── desktop-shell ─── backend-core (Nuitka)
M7  evaluator (independent)
```

**Start order recommendations**

- Day 1: opencc-eng starts the merge and vendors MateBot; backend-core starts
  the skeleton against the frozen contract; desktop-shell prototypes the backend
  manager against a stub health server.
- After M2's SSE contract is green: frontend-chat and backend-adapters run in
  parallel.
- After M3: packaging finalises Nuitka on the full app.
- M7 starts only when M1–M6 are green; the evaluator owns new test files and the
  report. M7 is now complete (see `evaluation.md`).

**Contract-first parallel work:** frontend can use a mock server implementing
`GET /api/health`, `GET /api/bootstrap`, `POST /api/sessions`, and
`POST /api/turns/{id}/stream` with the golden SSE fixtures. This keeps M4 from
blocking on M2.

---

## 4. File-ownership boundaries

One writer per path. PRs outside a lane require the owner's review.

| Lane | Owned paths | May read |
|---|---|---|
| opencc | `packages/opencc/**`, `vendor/matebot/**`, `vendor/opencc` symlink, `vendor/README.md`, root `bun.lock` (coordinated), opencc-related root `package.json` deps | everything |
| backend-core | `backend/src/autoagent_backend/{domain,application,api}/**`, `backend/src/autoagent_backend/{app,composition,config,paths,watchdog,logging_setup,errors}.py`, `backend/tests/{unit,golden}/**` | `frontend/src/api/types.ts`, contract |
| backend-engine | `backend/src/autoagent_backend/adapters/engine/**`, `backend/src/autoagent_backend/adapters/{claude_settings,autoagent_config,engine_config}.py`, engine-related tests | `domain/**`, `vendor/matebot/**` (read-only) |
| backend-adapters | `backend/src/autoagent_backend/adapters/{persistence,workspace,skills,mcp,artifacts}/**`, integration tests | `domain/**` |
| desktop-shell | `desktop/**`, `scripts/build-desktop.mjs`, `scripts/smoke-desktop.sh` | `dist/`, backend health |
| frontend-chat | `frontend/**` except panel feature dirs, `frontend/package.json`, `bun.lock` (frontend, if separate) | generated types, contract |
| frontend-panels | `frontend/src/features/{skills,mcp,workspace,artifacts}/**` | `frontend/src/cds/**` |
| packaging | `scripts/build-deb.sh`, `scripts/build-backend.sh`, `scripts/smoke-packaged.sh`, `packaging/**` | all build outputs |
| evaluator | `docs/.../evaluation.md`, `backend/tests/e2e/**`, `scripts/eval/**`, new fixtures | everything (read-only on source) |
| blueprint/cartographer | `docs/matebot-modernization/**` | everything |

Shared, change-controlled files:

- Root `package.json` and `bun.lock`: desktop-shell is the writer; opencc and
  packaging request changes through it.
- `backend/pyproject.toml` and `backend/uv.lock`: backend-core is the writer;
  packaging requests the Nuitka dev dependency.
- `vendor/matebot/**`: opencc lane only, updated by rsync; never edited in place.
- `api-contract-v1.md`: cartographer is the writer; additive changes only.
- `src/**` (legacy): frozen. No modern milestone edits it. It is deleted only
  after the deletion rule in §5.5 passes.

---

## 5. v1 scope freeze and what remains legacy

### 5.1 v1.0 (M1–M4 + migration) — must ship

1. Health, bootstrap, engine status.
2. Session list/create/select/delete.
3. Turn stream with text, thinking, tool, usage, completion and error events.
4. Turn cancel.
5. Markdown/GFM, sanitized HTML, code blocks, inline `artifact-html`.
6. Core `SettingsView` read/write (provider, model, base URL, masked key,
   workspace, permission, budgets, turns, tools, layout) plus the engine
   configuration view/override from `config-precedence.md`.
7. Native directory picker and standard desktop integrations.
8. First-run migration, including the Windows `%TEMP%` rescue.
9. `AUTOAGENT_LEGACY=1` verified in **development** (packaged path P1 open).

### 5.2 v1 parity (M5) — required before legacy deletion

- Skills catalog and enable/disable.
- MCP server management, discovery and invocation.
- Workspace status/diff/branch/init.
- Artifact list/open/content/export/import.
- Session branching.
- Autowork/MateBot ask (if retained).

### 5.3 Remains legacy until the deletion rule passes

- `src/main.ts`, `src/engine-client.ts`, `src/preload.ts`,
  `src/renderer/**`, `src/chatwise/**`, `src/providers/**`, `src/db/**`,
  `src/autowork/**`.
- All legacy IPC channels, including native capabilities that the modern shell
  has not yet re-homed.
- The legacy renderer static server and `%TEMP%` Windows data path.
- Windows packaging.

### 5.4 Explicitly dropped

- Generic SQL/file/exec/fetch IPC.
- Engine argv/config-dir exposure.
- No-op stub channels.
- Scheduled-task placeholder.
- ChatWise tables other than `tool`.
- `src/db/*`, `src/providers/factory.ts`.

### 5.5 Deletion rule

Delete a legacy file only when:

1. The parity matrix row is green.
2. `AUTOAGENT_LEGACY=1` no longer needs that file (or the legacy bundle is
   explicitly retired in the same release).
3. The M7 evaluation report is signed (`evaluation.md`).
4. The packaged `AUTOAGENT_LEGACY=1` rollback P1 is fixed and re-tested.
5. A root `dpkg -i` / upgrade / remove run and a real-model smoke + soak are
   recorded (currently unverified).

---

## 6. CI and test strategy

| Layer | Test | Gate |
|---|---|---|
| Domain/services | pytest with `FakeEngine`, `InMemorySessionStore`, `FakeClock` | every PR |
| Engine adapter | golden stream-json → domain events; vendored `OpenccSession` load; LRU/capacity; argv mutual-exclusion; resume gates; kill/cancel fault injection | every PR touching `adapters/engine` or `vendor/matebot` |
| API | `TestClient`/`httpx` status, DTO, auth, Origin, SSE projection | every PR |
| Persistence | SQLite fixture, migration idempotency, corrupt-record skip | every PR |
| Frontend | `tsc --noEmit`, Vitest pure functions, `cds_audit.py` | every PR |
| Static boundaries | import-linter (framework-free core), deep-interface checklist grep | every PR |
| Security | unauth/wrong-Origin/traversal/argv/loopback | every release |
| Lifecycle | kill/restart/orphan/heartbeat | every release |
| Packaging | packaged binary + `.deb` under X11/Wayland | M6/M7 |
| Evaluation | independent report | M7 |

No test may depend on a live model call. The real-engine smoke tests use a
scratch `CLAUDE_CONFIG_DIR` and are opt-in (`AUTOAGENT_RUN_ENGINE_SMOKE=1`).

---

## 7. Handoff

### 7.1 Chosen stack

FastAPI + uvicorn + Pydantic v2 for the HTTP adapter; a framework-independent
typed core; SQLite (WAL) as the single writer; **`MateBotEngine` as the default
`EnginePort`**, loading the vendored `vendor/matebot/opencc_backend.py`
`OpenccSession` by path and keeping one persistent `--matebot` child per
conversation (`SubprocessEngine` fallback, `FakeEngine` tests); React +
TypeScript + Vite + Tailwind + shadcn/ui with CDS tokens; Electron as a thin OS
shell with a native-only preload.

### 7.2 Module layout (one line each)

- `backend/src/autoagent_backend/domain` — pure models, events, ports.
- `backend/src/autoagent_backend/application` — use-case services.
- `backend/src/autoagent_backend/adapters` — MateBot/subprocess engines,
  config resolution, SQLite, git, skills, MCP, artifacts.
- `backend/src/autoagent_backend/api` — FastAPI routes, DTOs, SSE, auth.
- `frontend/src` — `api/`, `cds/`, `features/`, `app/`.
- `desktop/src` — entry switch, lifecycle, backend manager, minimal preload.
- `vendor/matebot` — read-only vendored MateBot core; `vendor/opencc` →
  `packages/opencc` symlink.

### 7.3 M1–M3 exact first steps

**M1, step 1 (opencc-eng):**

```bash
cd /home/tars/yysapp/AutoAgent
git status --short
# Stop if packages/opencc has uncommitted changes; snapshot first.
git -C /home/tars/yysapp/MateBot/vendor/opencc diff > /tmp/matebot-memorytool.patch
git -C /home/tars/yysapp/MateBot/vendor/opencc archive f04b76d | tar -x -C /tmp/oc-base
git -C /home/tars/yysapp/MateBot/vendor/opencc archive 4c83c36 | tar -x -C /tmp/oc-theirs
```

Then follow `opencc-delta.md` §7 exactly. Do not replace the subtree.

**M1, step 2 (backend-core):**

```bash
cd /home/tars/yysapp/AutoAgent
mkdir -p backend/src/autoagent_backend backend/tests
# write pyproject.toml with fastapi/uvicorn/pydantic + pytest/httpx/ruff/mypy/lint-imports
cd backend
uv lock
uv sync
uv run python -m autoagent_backend --version
uv run python -m autoagent_backend --port 8787 --data-dir /tmp/autoagent-m1
curl -fsS http://127.0.0.1:8787/api/health
```

**M2, step 1 (backend-engine):** write `argv.py` and its test first — the
permission flag policy is a correctness boundary. Then implement
`matebot_engine.py` against a fake `SessionLike` (session factory injection) and
the golden fixtures: LRU/capacity, cancel synthesis, ref persistence,
death/recreate. Then wire the real vendored `OpenccSession`; keep
`subprocess_engine.py` green as the fallback.

**M2, step 2 (backend-core):** write `TurnService` against `FakeEngine` and the
golden SSE fixtures; make cancel, idempotency and process death pass before
touching the real child. Add the precedence resolver tests
(`test_engine_config_resolver.py`) before wiring `/api/engine/config`.

**M3, step 1 (desktop-shell):** build `backend-manager.ts` against the M1 health
endpoint; log port, bootId, PID and health attempts. Load a blank page first,
then the SPA. Pass `--data-dir` + `AUTOAGENT_STATE_DIR`, keep
`AUTOAGENT_CONFIG_DIR=~/.autoagent`, and load the token as `?token=`. Add the
legacy switch before writing any native IPC.

### 7.4 Top 5 residual risks (post-evaluation)

1. **Packaged legacy rollback (P1).** The `.deb` does not contain the legacy
   `main.js`, so `AUTOAGENT_LEGACY=1` fails. Fix before legacy deletion.
2. **Nuitka non-determinism.** The backend binary hash differs across builds;
   verify `--runtime-check` and a fake turn instead of gating on the hash.
3. **No root install test.** `dpkg -i`/upgrade/remove and the setuid sandbox are
   unverified; run on a disposable Ubuntu 24.04 machine.
4. **Vendored-session coupling.** An rsync update can change the
   `OpenccSession` surface. Keep `SessionLike`, adapter tests and the
   `--matebot` smoke test.
5. **Long-run and real-model behavior.** The 8 h/200-turn soak and a live-model
   turn were not run; also review actor networking if enabled.
