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
134,860,224 bytes
sha256 9ff5311e8043e5a58b233afe13ad64ac37eb5e5fe60128fe3619c15160ec49b1
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

## Verification (independent)

- Backend: **199 pytest**, ruff, mypy (74 files), import-linter (2 contracts).
- Frontend: **51 Vitest**, `tsc --noEmit`, Vite build.
- Desktop: 23 smoke checks (port/token/health/log/shutdown).
- Packaged: hash reproduced exactly; one setuid `chrome-sandbox` 4755; vendor
  file 644; `--runtime-check` reports `engineMode=matebot`,
  `matebotVendorExists=true`; CSP and immutable asset caching; fake SSE turn;
  clean shutdown/no orphan.
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

```bash
cd /home/tars/yysapp/AutoAgent

# unified pipeline
make help
make doctor
make setup
make check          # lint + backend/frontend/desktop tests
make build          # SPA + Electron shell
make package        # check + Nuitka backend + .deb
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
  are byte-identical.
- Route count is 42 (the architecture's ≤30 was a guideline).
- The Feishu bridge code is vendored. The desktop currently owns the long
  connection; running the bridge as a supervised packaged service is a
  follow-up.

## Rollback

- Development: `AUTOAGENT_LEGACY=1`.
- Package: reinstall the previous `.deb`; user data under `$HOME` is untouched.
