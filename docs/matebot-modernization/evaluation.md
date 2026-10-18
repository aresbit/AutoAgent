# M7 Independent Evaluation — AutoAgent / MateBot Modernization

Date: 2026-10-17
Evaluator: Verifier (independent, adversarial)
Repo: `/home/tars/yysapp/AutoAgent` (branch `master`, HEAD `356445c` + implementation working tree)
Candidate artifact: `release/autoagent_0.8.0_amd64.deb`

## Verdict

**PASS on every required P0 gate (A–I). No P0 findings.**

One M7 milestone gate fails outside the P0 list: the packaged `AUTOAGENT_LEGACY=1`
rollback path is broken (P1). The artifact is safe to deliver for the modern
Electron/backend/SPA path, but the rollback defect should be fixed before legacy
removal, and the packaged "fake engine" demo mode should either be documented as
development-only or given an explicit override.

| Check | Result |
|---|---|
| A. Quality gates (backend + frontend + boundaries) | **PASS** |
| B. Reproducible build | **PARTIAL** (builds succeed; not byte-identical; payload semantics identical) |
| C. Deb audit | **PASS** |
| D. Packaged backend runtime + 9-event SSE | **PASS** |
| E. `--matebot` real-subprocess proof + persistent child | **PASS** |
| F. Parent-death watchdog | **PASS** |
| G. X11 GUI (session/message/panels/screenshot/no orphan) | **PASS** (fake mode deviation, see G) |
| H. Wayland GUI (`--ozone-platform=wayland`, 0 context loss) | **PASS** |
| I. Deep interface / security | **PASS** with P2 notes |
| J. Root install/upgrade/remove | **NOT VERIFIED** (no sudo; limitation) |
| M7 gate 8: rollback drill | **FAIL (P1)** |

Environment: Ubuntu 24.04, x86_64, Python 3.12.3 + uv, Bun 1.3.13, Node 18.19.1,
Electron 41.3.0, X11 `DISPLAY=:1` (1920x1080), gnome-shell 46.2 nested Wayland.
No sudo was used. All source/packaging/frontend/service code was left untouched;
only generated build outputs were produced by the mandated build commands.

---

## A. Quality gates

| Command | Result | Evidence |
|---|---|---|
| `cd backend && uv run pytest -q` | **PASS** | `145 passed, 1 warning in 6.99s` (Starlette/httpx deprecation warning only) |
| `uv run ruff check src tests` | **PASS** | `All checks passed!` |
| `uv run mypy src` | **PASS** | `Success: no issues found in 68 source files` |
| `uv run lint-imports` | **PASS** | `Analyzed 102 files, 431 dependencies`; `domain and application are framework-free KEPT`; `layer order KEPT`; `Contracts: 2 kept, 0 broken` |
| `cd frontend && bun run typecheck` | **PASS** | `tsc --noEmit`, exit 0 |
| `bun run test` | **PASS** | `Test Files 5 passed (5)`, `Tests 40 passed (40)`, `Duration 2.59s` |
| `bun run build` | **PASS** | `2346 modules transformed`; `built in 2.54s`; `bun run build ... 5.324 total` |

Boundary/leak checks:
- `grep -rn "shell=True|os.system" backend/src desktop/src frontend/src` → **no hits**.
- Subprocess uses argv arrays (`Popen([command, *args])`, `subprocess.run(argv, shell=False)`).
- `api/schemas.py` contains no `argv`, `pid`, `signal`, `content_block`, `tool_use`, `resume`, raw frame, or raw SQL fields. The only `sessionId` occurrences are the business session identifier; `command`/`path` occurrences are business inputs for MCP-server configuration, skills and workspace, not CLI/DB representations.
- `frontend/src` contains no `claudeCommand`, `extraCliArgs`, `sessionId` (engine), `stream_event`, `content_block`, `session_id`.
- SSE golden/raw check: forbidden strings (raw frame names, argv, pid) are absent (asserted by tests and observed wire payloads below).

Repository status after evaluation matches the starting state (the same four
modified files and untracked implementation directories); no source was edited.

## B. Reproducible build

| Command | Exit | Time | Output |
|---|---|---|---|
| `bash scripts/build-backend.sh` | 0 | **2:49.60** (1485.32s user) | Nuitka standalone backend; self-check ran a fake-engine turn and reported `backend stopped, no orphan` / `OK` |
| `bash scripts/build-deb.sh` | 0 | **3:42.51** (1765.81s user) | `release/autoagent_0.8.0_amd64.deb` + `.sha256` |

Hashes (original candidate → rebuild):

| Artifact | Original | Rebuild |
|---|---|---|
| `.deb` SHA256 | `7043e2f3f9daa4f55162755cacd7d1c04a04518c2d8c5b974c08ecf1f75cf30d` | `1f2859327ef567612c402ef829e3128d91fb4828556e993bdb07d4f52668bd6a` |
| `.deb` bytes | 133,076,616 | 133,073,320 |
| Backend binary | `7c5065ac…` | `9f9904a7…` |
| `engine/opencc-dist/cli.js` | `f9b0cda0…` | `f9b0cda0…` (identical) |
| `engine/bun` | `d3f18713…` | `d3f18713…` (identical) |
| `frontend/dist/*` (all files) | — | byte-identical |
| `desktop/resources/app/{entry,main}.js`, `preload.cjs` | — | byte-identical |

- `diff <(dpkg-deb -c old) <(dpkg-deb -c new)` → **empty**; control fields and
  all maintainer scripts are identical.
- Conclusion: **not byte-reproducible**, limited to the Nuitka-compiled backend
  binary (C/timestamp/ordering non-determinism). Payload semantics are
  equivalent. The rebuilt backend was re-verified: `--version` 0.1.0,
  `--runtime-check` `ok:true`, 9-event fake SSE, and `--matebot` subprocess proof
  all pass. Do not fail the build solely on the hash difference.

## C. Deb audit

Archive: 119 entries, `Version: 0.8.0`, `Architecture: amd64`, `Installed-Size: 486767`.

- Setuid entries: **exactly one** — `-rwsr-xr-x root/root 15248 ./opt/autoagent/desktop/chrome-sandbox` (4755).
- Forbidden payload: **no** `node_modules`, **no** `.git`, **no** `.map` entries.
- `Depends`: Electron/runtime shared libraries and `xdg-utils` only. **No** node,
  npm, python, gcc, make, or other build-tool dependency.
- Locales: exactly `en-US.pak` and `zh-CN.pak`.
- Required paths all present:
  - `/opt/autoagent/backend/autoagent-backend` (59,950,016 bytes, executable)
  - `/opt/autoagent/frontend/dist/index.html` + 5 hashed assets
  - `/opt/autoagent/engine/bun` (101,774,424 bytes, executable)
  - `/opt/autoagent/engine/opencc-dist/cli.js` (26,423,966 bytes)
  - `/opt/autoagent/desktop/resources/app/{entry.js,main.js,preload.cjs}`
  - `/opt/autoagent/desktop/electron`
- Launcher: no `--no-sandbox`; Wayland is chosen only when `WAYLAND_DISPLAY`
  resolves to a live socket (`-S` check), otherwise X11, and it exits if neither
  is available. It exports `AUTOAGENT_APP_DIR`, `AUTOAGENT_PACKAGED=1`,
  `AUTOAGENT_ENGINE_DIR`, `AUTOAGENT_BUN_PATH`, `AUTOAGENT_OPENCC_CLI_PATH`,
  `AUTOAGENT_FRONTEND_DIST`.
- `bun engine/opencc-dist/cli.js --help | grep -- --matebot` → present, with
  `--input-format`, `--output-format`, `--include-partial-messages`.
- `grep -c OPENCC_MATEBOT engine/opencc-dist/cli.js` → **1** (single minified line).

## D. Packaged backend runtime

Extracted to a temp tree. Both the original and rebuilt debs were tested.

- `autoagent-backend --version` → `autoagent-backend 0.1.0`, exit 0.
- `--runtime-check` with packaged `AUTOAGENT_BUN_PATH` / `AUTOAGENT_OPENCC_CLI_PATH`
  → `ok: true`, resolved bun and cli to the packaged engine, exit 0.
- Backend with `AUTOAGENT_ENGINE=fake`, packaged `AUTOAGENT_FRONTEND_DIST`, token:
  - bind: `LISTEN 127.0.0.1:18787` only.
  - `/api/health` → `{"ok":true,"app":"autoagent","apiVersion":"1",...,"db":"ok","engine":"idle","state":"ok"}`.
  - `/` → 200, `text/html`, 1193 bytes.
  - `/assets/index-DU3GpnQW.js` → 200, `text/javascript`, 398,839 bytes.
  - Fake turn SSE → **9 events** in order:
    `turn.started, message.delta, message.delta, message.delta, tool.start,
    tool.result, usage, message.completed, turn.completed`
    (channels `text/thinking/text`; seq 1..9; stopReason `end_turn`).
  - Wire payload contains only business fields (`turnId`, `sessionId`, `seq`,
    `ts`, text/usage/tool); no raw frame/argv/PID/engine session id.
- `AUTOAGENT_PACKAGED=1 AUTOAGENT_ENGINE=fake` is rejected at startup:
  `AUTOAGENT_ENGINE=fake is refused in packaged mode` (exit 2). This is by design
  and is the reason check G used the scripted-subprocess path (see G).

## E. `--matebot` real-subprocess proof

Wrapper executable recorded argv and delegated to
`backend/tests/fixtures/fake_cli.js`; `AUTOAGENT_ENGINE=subprocess`, packaged bun,
wrapper as `AUTOAGENT_OPENCC_CLI_PATH`. Two turns in one session.

- Recorded argv (both deb builds identical shape):
  `--print --verbose --input-format stream-json --output-format stream-json
  --include-partial-messages --include-hook-events
  --dangerously-skip-permissions --matebot --model claude-sonnet-4-6`
- All required flags present: `--matebot`, `--print`, `--input-format stream-json`,
  `--output-format stream-json`, `--include-partial-messages`.
- Exactly **one permission source**: `--dangerously-skip-permissions` present,
  `--permission-mode` absent.
- Persistence: **1 spawn for 2 turns**, unique PID set `[742967]` (rebuilt:
  `[762323]`). Replies: `echo:turn1`, `echo:turn2`.
- Both turns completed and no engine/backend processes remained after shutdown.

## F. Parent-death watchdog

Packaged backend, `AUTOAGENT_ENGINE=fake`, fresh data dirs.

- Case 1 (`AUTOAGENT_DESKTOP_PID` → disposable `sleep 300`, then `SIGKILL`):
  backend exited in **2.11 s**, exit status 143.
- Case 2 (heartbeat file aged 60 s, timeout 15 s):
  backend exited within **0.0 s** of the health probe; log:
  `desktop heartbeat is missing or older than 15.0s; shutting down`; exit 143.

## G. GUI — X11

Extracted deb, packaged launcher, `DISPLAY=:1`, fresh `XDG_CONFIG_HOME` /
`XDG_STATE_HOME` / data dirs, `AUTOAGENT_APP_DIR` set to the extracted tree.

- Sandbox caveat: the extracted `chrome-sandbox` is owned by `tars` (the package
  listing proves root:root 4755), so this test used the test-only `--no-sandbox`
  flag. This does not validate the installed setuid path.
- Deviation: `AUTOAGENT_ENGINE=fake` is refused when `AUTOAGENT_PACKAGED=1`
  (launcher sets it), so the GUI was driven with the **real packaged subprocess
  engine pointed at the scripted fake CLI**. This still exercises the complete
  Electron → health → SPA → HTTP/SSE → persistent child path with no model call.
- Window: `xwininfo` showed `AutoAgent` `1200x870`; CDP page title `AutoAgent`,
  URL `http://127.0.0.1:8787/`.
- Created a session ("New session"), typed `hello gui`, sent it, and observed the
  assistant reply **`echo:hello gui`** in the transcript.
- Panels exercised (mouse-down activation as Radix expects):
  - Skills: loaded catalog, `7/141` enabled/total.
  - MCP: `0/0`, empty-state and "Add server" rendered.
  - Workspace: `/home/tars`, `no repository`, clean tree and empty diff.
  - Artifacts: empty state, import/preview/storage copy rendered.
  - No panel showed an error state.
- Screenshots captured via CDP `Page.captureScreenshot`:
  `chat.png` (73 KB) and `panels.png` (56 KB) in the temp evidence dir.
- Console: no JS exceptions; one Electron warning that the renderer lacks a
  Content-Security-Policy (see P2).
- Graceful quit (`SIGTERM` to Electron): shutdown log shows
  `backend.shutdown.begin` → `backend.terminate SIGTERM` → `backend.shutdown.done`
  and `app.shutdown.done`; Electron, backend and engine wrapper all gone;
  **no orphan**.

## H. GUI — Wayland

Nested `gnome-shell --nested --wayland --no-x11 --sm-disable` under
`dbus-run-session`, isolated `XDG_RUNTIME_DIR` (0700). App launched with
`WAYLAND_DISPLAY=wayland-0`, `XDG_RUNTIME_DIR` set, and **`DISPLAY` unset**
(same test-only `--no-sandbox`).

- `wayland-0` socket created and detected.
- Electron main argv:
  `/tmp/.../desktop/electron --ozone-platform=wayland .../resources/app --no-sandbox --remote-debugging-port=9224`
  → `ozone_wayland=1`.
- Child environment: `DISPLAY` absent (count 0), `WAYLAND_DISPLAY=wayland-0`.
- `app.ready=1`, `window.load=1`, `backend.health.ok=1`; CDP target title
  `AutoAgent`.
- GPU context-lost count: **0 before, 0 after 10 s, delta 0** (app log and
  nested-shell log).
- Graceful quit: Electron and backend both gone; `orphan_count=0`.

## I. Deep interface / security

- SPA/DTO boundary: business DTOs only; no CLI argv/flags, raw stream frames,
  SQL rows, PIDs or signals. The only `command`/`path` fields are user-facing MCP
  server configuration and skill/workspace paths.
- Auth: unauthenticated `GET /api/sessions` → **401**; wrong token → **401**;
  `/api/health` without token → **200**; static `/`, `/assets/*` token-free
  → **200**; wrong `Origin` → **403** (including static root).
- Loopback: `ss -ltnp` shows `127.0.0.1:<port>` only; `--host 0.0.0.0` is refused
  with exit 2 (`refusing to bind '0.0.0.0': the backend is loopback-only`).
- Path traversal: `/assets/..%2F..%2F..%2Fetc%2Fpasswd` and encoded variants →
  **404**; artifact id traversal paths without token → **401** (auth enforced
  first); artifact store validates ids as a single path segment, checks zip
  member `resolve()` containment, and boxes all filesystem work behind the
  manifest.
- Unknown API route → JSON 404 (`application/json`), not SPA fallback.
- No `shell=True`, no shell string interpolation in engine/MCP/git adapters.
- Electron: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`,
  navigation restricted to the app origin, webviews denied, preload exposes only
  fixed native channels (no generic invoke/exec/filesystem/business methods).

## Findings

### P0
None.

### P1
1. **Packaged rollback is broken (M7 gate 8).** `AUTOAGENT_LEGACY=1` makes
   `desktop/resources/app/entry.js` import `../../src/main.js`, then
   `../../dist/main.js`, which resolve to
   `/opt/autoagent/desktop/{src,dist}/main.js` — neither exists in the deb.
   Empirically: `ERR_MODULE_NOT_FOUND`, no window, process stayed alive until
   killed by `timeout` (exit 124). The legacy bundle is present in the repo
   (`dist/main.js`) but not in the packaged app tree.
   **RESOLVED in the post-fix re-check:** packaged `AUTOAGENT_LEGACY=1` now
   prints `Legacy mode is not shipped in this package. To roll back, reinstall
   the previous .deb.` and exits 1 promptly. The hang is gone; in-package
   rollback is intentionally unsupported (see post-fix section).
2. **Packaged fake-engine mode is unavailable.** With `AUTOAGENT_PACKAGED=1`,
   `AUTOAGENT_ENGINE=fake` exits 2 by design. Consequently the evaluator's
   packaged GUI fake-mode requirement cannot be executed literally; the GUI was
   verified with a scripted subprocess instead. If a packaged demo/CI mode is
   required, an explicit documented override is needed.

### P2
3. **Build is not byte-reproducible** (backend binary only; payload list, control
   and all non-backend assets are identical). Semantic equivalence verified.
4. **Route count 36 > 30** — architecture §11 item 1's literal pass criterion.
   Routes are use-case endpoints, not IPC channels. (Post-fix re-check: now 42
   route decorators after the engine-config endpoints; still above the literal
   threshold.)
5. **No Content-Security-Policy** in the SPA; Electron emits its insecure-CSP
   warning in the packaged renderer. Not a P0, but worth adding a restrictive CSP.
   **RESOLVED in the post-fix re-check:** the backend now serves
   `Content-Security-Policy: default-src 'self'; script-src 'self'; ...;
   object-src 'none'; base-uri 'self'; form-action 'none'`, and the packaged
   renderer no longer emits the Electron warning.

## Limitations / not verified

- **Root-only operations were not run** (no sudo): real `dpkg -i` install,
  upgrade over the legacy package, remove/purge, postinst sandbox verification,
  and desktop/icon cache updates are unverified. The archive metadata was
  audited statically (`dpkg-deb -c/-I`) and extraction-based tests were used.
- The setuid sandbox path was not exercised at runtime (extracted ownership);
  all GUI launches used the test-only `--no-sandbox`. The package mode is proven
  by archive metadata and postinst logic.
- No real model/API call was made; the engine was exercised with the scripted
  `fake_cli.js` and the fake engine. Real `opencc --matebot` behavior beyond
  argv/help was not exercised.
- 8-hour/200-turn soak, migration from real legacy Linux/Windows trees, crash
  fault-injection across every turn state, and resume gates were covered by the
  project's tests but not re-run as long-duration acceptance runs in this
  evaluation.
- An installed `/opt/autoagent` instance was already running on the host; it was
  left untouched. GUI tests used isolated temp roots.

## Handoff

- **Verdict: PASS on all required P0 gates A–I.** Artifact is safe to deliver
  for the modern path. P0: none.
- **P1 action before legacy deletion:** ship the legacy entry in the packaged
  app tree (or make `AUTOAGENT_LEGACY=1` an explicit documented unsupported
  path) so M7 gate 8 passes. Document or override packaged fake-engine mode if
  demos/CI need it.
- **P2 follow-ups:** determinism of the Nuitka binary, route-count gate
  reconciliation, and a restrictive CSP.
- **Unverified before claiming install-grade release:** real root install/
  upgrade/remove and the installed setuid sandbox launch (requires sudo), plus a
  real-model engine smoke and the long soak. Run those on a disposable machine.
- Evidence dirs used during evaluation were temporary; no processes were left
  running (`pgrep` for the extracted deb, backend and engine wrapper returned
  none after cleanup).

---

# Post-fix re-check (MateBot engine / config / vendor / UI)

Date: 2026-10-17 (second evaluation pass)
Artifact: `/home/tars/yysapp/AutoAgent/release/autoagent_0.8.0_amd64.deb`

## Artifact identity reproduced

- Provided size: **133,336,468 bytes**; measured: **133,336,468 bytes**.
- Provided SHA256 `b0933a6b402d973bbaa16c78fe4532681b4522e8aa0384e9719f9bb2479a3a35`;
  computed SHA256: **identical** (`sha256sum` and the `.sha256` sidecar agree).

## Results by requested item

### 1. Deb audit — PASS

- 194 archive entries; **exactly one** setuid entry:
  `-rwsr-xr-x root/root 15248 ./opt/autoagent/desktop/chrome-sandbox` (4755).
- No `node_modules`, `.map`, or `.git` entries.
- `vendor/matebot/opencc_backend.py` present, archive mode **0644**, 32,201 bytes.
- Key paths present: `backend/autoagent-backend` (60,392,928 bytes),
  `frontend/dist/index.html`, `engine/bun` (101,774,424), `opencc-dist/cli.js`
  (26,423,966), `desktop/electron`, `desktop/resources/app/{entry.js,main.js,preload.cjs}`.
- Locales: only `en-US.pak`, `zh-CN.pak`. No forbidden Depends.
- Launcher exports `AUTOAGENT_MATEBOT_VENDOR_DIR` (default
  `$APP_DIR/vendor/matebot`) and does **not** export `AUTOAGENT_ENGINE`.
- No `--no-sandbox` in the launcher; Wayland only with a live socket; X11
  fallback retained.

### 2. Packaged `--runtime-check` — PASS

```
"engineMode": "matebot",
"engine": {
  "mode": "matebot",
  "matebotVendor": "/tmp/<extract>/opt/autoagent/vendor/matebot/opencc_backend.py",
  "matebotVendorExists": true,
  "bun": ".../engine/bun",
  "cli": ".../engine/opencc-dist/cli.js"
}
```
exit 0. The path suffix is exactly `/vendor/matebot/opencc_backend.py`.

### 3. Config precedence and secret handling — PASS

Case A (`CLAUDE_CONFIG_DIR=<empty temp>`, `AUTOAGENT_CONFIG_DIR=<temp>/autoagent`):
- `GET /api/engine/config` → top-level `configPath` =
  `<temp>/autoagent/settings.json`.
- `PUT` with `model` / `baseURL` / `apiKey` → `engine.modelSource` =
  **`autoagent`**, `engine.credentialSource` = **`autoagent`**,
  `apiKeyConfigured` = **true**; `engine.configPath` and `autoagentConfigPath`
  both the AutoAgent file.
- File mode **600**, created parent mode **700**; body contains `model`,
  `baseURL`, `apiKey`.
- A unique test secret (`sk-recheck-secret-…`) did **not** appear in any HTTP
  response, stdout/stderr, or log file (only inside the 0600 settings file).

Case B (real `~/.claude/settings.json`, `CLAUDE_CONFIG_DIR` unset):
- `engine.modelSource` = **`claude-settings`**
- `engine.model` = **`YF95AXVV/deepseek-flash[1M]`**
- `engine.configPath` = **`/home/tars/.claude/settings.json`**
- `engine.credentialSource` = `claude-settings`; no credential values serialized.

### 4. Packaged `--matebot` subprocess proof — PASS

`AUTOAGENT_ENGINE=matebot`, packaged bun/vendor, scripted wrapper as the CLI.
Two turns in one session:
- Recorded argv:
  `--print --verbose --input-format stream-json --output-format stream-json
  --include-partial-messages --include-hook-events
  --dangerously-skip-permissions --matebot`
- `--matebot`, `--print`, stream-json input/output, and
  `--dangerously-skip-permissions` all present; no `--permission-mode`.
- **1 spawn, 1 PID (`928596`) across 2 turns**; replies `echo:turn1`,
  `echo:turn2`; no backend or engine orphan after shutdown.

### 5. GUI X11 — PASS

Extracted deb + packaged launcher + test-only `--no-sandbox`; fresh
`XDG_CONFIG_HOME` / `XDG_STATE_HOME` / data dirs; `AUTOAGENT_CONFIG_DIR` temp;
`CLAUDE_CONFIG_DIR` unset; scripted CLI to avoid model calls.

- Window `AutoAgent` 1440x900; CDP page loaded at `http://127.0.0.1:8788/`.
  (Port 8787 was held by a pre-existing unrelated backend; the app correctly
  detected the foreign listener and failed over to 8788.)
- Settings text verified: `MateBot`, `MateBot (OpenCC)`, `opencc --matebot`,
  `Effective model`, `YF95AXVV/deepseek-flash[1M]`,
  `from ~/.claude/settings.json`, `Config: /home/tars/.claude/settings.json`,
  `AUTOAGENT FALLBACK CONFIG`, `File: /tmp/<temp>/autoagent/settings.json`,
  fallback Model/Base URL/API key/API key helper fields and explanation.
- No `Anthropic` string anywhere in the page text.
- Console errors: **0**, page exceptions: **0** (zero warnings as well).
- Screenshot captured via CDP: 1440x900 PNG, 86 KB.
- Graceful quit: backend exited, renderer/electron gone, port 8788 closed,
  **no orphan** (`backend.shutdown.done`, `app.shutdown.done`).

### 6. Nested Wayland — PASS

Nested gnome-shell 46.2, isolated `XDG_RUNTIME_DIR`, `DISPLAY` unset for the app:
- Electron argv contains **`--ozone-platform=wayland`** (count 1).
- Child env: `DISPLAY` absent (count 0), `WAYLAND_DISPLAY=wayland-0`.
- `app.ready=1`, `window.load=1`, CDP target `AutoAgent`.
- GPU context-lost count over 10 s: **0 → 0 (delta 0)**.
- Graceful quit: electron and backend gone; `orphan_count=0`.

### 7. Resolutions and remaining limitations

- **P1 legacy hang — RESOLVED.** Packaged `AUTOAGENT_LEGACY=1` now exits
  promptly (exit 1, under the 12 s timeout, no hanging process) with:
  `Legacy mode is not shipped in this package. To roll back, reinstall the
  previous .deb.` In-package legacy execution is intentionally unsupported;
  rollback now means reinstalling the previous package.
- **P2 CSP — RESOLVED.** `/` now returns
  `content-security-policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data:; connect-src 'self'; frame-src 'self' data:;
  object-src 'none'; base-uri 'self'; form-action 'none'`.
  The Electron insecure-CSP warning is gone.
- **P2 Nuitka determinism — REMAINS.** Not re-tested for this build; no evidence
  that backend builds became byte-identical.
- **P2 route count — REMAINS.** Now 42 route decorators, still above the
  architecture §11 literal limit of 30.
- **Root-only install/upgrade/remove and installed setuid sandbox — NOT
  VERIFIED** (no sudo). Extraction-based tests and archive metadata used.
- No real model/API call was made in the re-check; the scripted CLI and fake
  engine were used. Both X11 and nested Wayland GUI paths were executed (so this
  is not an X11-only smoke).

## Post-fix verdict

**PASS. No P0 or P1 findings.** The hash is reproduced, all seven requested
re-check items pass, the previous legacy-hang P1 and CSP P2 are resolved, and
the new MateBot engine, vendor loading, config precedence, secret handling and
Settings UI are verified. Remaining limitations are environmental/root-only
verification and the pre-existing P2 items (Nuitka non-determinism, route
count).

---

# M5.1 Artifacts — security-focused re-check

Date: 2026-10-17 (third evaluation pass)
Artifact: `/home/tars/yysapp/AutoAgent/release/autoagent_0.8.0_amd64.deb`
Frontend bundle: `assets/index-B0bBiUq7.js` (the stale `DDOWgkAc` bundle was not
required and is not referenced by the packaged `index.html`).

## Verdict

**P0 artifact security loop: PASS. No P0 findings.**

One new **P1 functional defect** was found: inline scripts inside
`srcdoc` artifact frames are blocked by the parent page's CSP
(`script-src 'self'`, inherited by `srcdoc`), so interactive artifacts and the
host resize reporter never execute. The security properties (network blocked,
opaque origin, no token, no same-origin/top-navigation/popup/modal access) all
hold — in fact more strongly than intended — but the artifact feature is
functionally incomplete and logs CSP errors inside the preview. One **P2 UI
defect** (version count in the artifact list) is also noted.

## 1. Hash and deb audit — PASS

- Size: **133,469,956 bytes** (matches).
- SHA256: **`7365dc1499ccb73af5e7eefd453f93db4529b96eb094d71a8b0d22d12f773880`**
  (reproduced exactly; `.sha256` sidecar agrees).
- Exactly one setuid entry: `-rwsr-xr-x root/root 15248
  ./opt/autoagent/desktop/chrome-sandbox`.
- `vendor/matebot/opencc_backend.py` present, archive mode **0644**.
- `frontend/dist/index.html` references **`assets/index-B0bBiUq7.js`**.
- Key backend/frontend/engine/desktop paths present.
- Launcher exports `AUTOAGENT_MATEBOT_VENDOR_DIR`; it does **not** export
  `AUTOAGENT_ENGINE` (only `AUTOAGENT_ENGINE_DIR`, a path variable).

## 2. Packaged artifact API — PASS

Extracted backend, `AUTOAGENT_ENGINE=fake`.

- `POST /api/artifacts` (new title) → `revision:"v1"`, `versionCount:1`.
- `POST /api/artifacts` (same title, new HTML) → `revision:"v2"`,
  `versionCount:2`.
- `GET /api/artifacts/{id}/versions` → `v2` and `v1`; both
  `immutable:true`, non-empty `sha256`, `uri` exactly
  `ui://<id>/v<N>/index.html`, `mimeType: text/html;profile=mcp-app`,
  `entry: index.html`.
- `GET .../versions/v1/content` → v1 HTML with the injected CSP meta.
- `POST .../versions/v1/restore` → creates **`v3`** (new version, `source:
  restore`, `versionCount:3`) and moves current to v3 with v1's content/hash;
  older v1/v2 remain immutable.
- `POST .../verify` → `{ok:true, version:"v3", sha256 == expectedSha256}`.
- Stored content contains
  `<meta data-autoagent-csp="1" ...>` with `default-src 'none'`,
  `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`.

Note: `ArtifactView.versions` remains the legacy timestamp array; the
authoritative IDs/hashes are in `versionRefs`/`versionCount` (see P2 UI bug).

## 3. TurnService materialization and SSE order — PASS

Packaged backend with `AUTOAGENT_ENGINE=matebot` and a scripted CLI that emits a
valid `artifact-html` block and a second block referencing an external image.

Observed SSE order:

```
turn.started
message.delta
usage
message.completed
artifact.created
turn.completed
```

- `turn.started` first; `message.delta` before `message.completed`;
  `artifact.created` after `message.completed` and before `turn.completed`.
- `turn.completed` exactly once; no `error` event.
- Artifact persisted and listed afterwards: `Recheck Artifact`, `v1`,
  `versionCount 1`, `sessionId`/`turnId`/`messageId` populated, `source: turn`,
  `immutable: true`, `uri: ui://recheck-artifact/v1/index.html`.
- The invalid external-resource block was rejected with a warning
  (`artifact materialization: ignored an artifact that references external
  resources`) and **did not fail the turn** — only the valid artifact was
  stored.
- Engine: one persistent child across the turn, no orphan.

## 4. Frontend security (source + GUI) — PASS on security / P1 functional finding

Source and built bundle:
- `ARTIFACT_SANDBOX = "allow-scripts allow-forms"` exactly; the built bundle
  contains no `allow-same-origin`, `allow-top-navigation`, `allow-modals`, or
  `allow-popups`.
- The injected artifact CSP contains `default-src 'none'`, `connect-src 'none'`,
  `form-action 'none'`, `base-uri 'none'`; the backend emits the same policy.
- No `EventSource` anywhere in `frontend/src` or the built bundle (`grep -c` → 0);
  `/api/events` uses authenticated `fetch` streaming.
- `openArtifactWindow`/`bridge.artifact.open` has no call site in the UI; the
  preload surface is frozen and native-only.

Running GUI (CDP evaluation inside the packaged `about:srcdoc` iframe):
- `origin: "null"` (opaque), sandbox attribute exactly
  `allow-scripts allow-forms`.
- `document.cookie` → `SecurityError`; `parent.location`, `parent.document`,
  `top.location`, and `localStorage` → `SecurityError`.
- `document.baseURI` → `http://127.0.0.1:<port>/` (no token); `referrer` empty;
  no launch token appears in the iframe document or URL.
- `fetch('/api/settings')` and absolute-origin fetch → **blocked**
  (`TypeError: Failed to fetch`; CSP logs
  `connect-src 'none'` / cross-origin denial).

UI integration:
- Chat artifact card renders (`data-testid="chat-artifact-card"`, title, size,
  Preview/Open panel).
- "Open panel" switches to the Artifacts tab and opens the preview dialog.
- Versions list showed both snapshots; clicking **Restore** created a third
  version and moved the `current` badge to the restored content.
- An external restore (authenticated API) produced
  `event: artifacts.changed` / `{"reason":"restored","artifactIds":["recheck-artifact"]}`
  on `/api/events`, and the open versions dialog updated from 3 to 4 entries
  **without any manual refresh** — confirming the fetch-based SSE refresh path.
- No native `artifact.open` call; CDP target count stayed at the page + its
  sandboxed iframes (no child `BrowserWindow`).
- Parent page console errors: **0**; page exceptions: **0**.
  Expected CSP violation messages appear only inside the probe iframe (the
  probe deliberately attempts a blocked connection).

### P1 finding — artifact inline scripts are blocked by the inherited parent CSP

The parent document is served with
`Content-Security-Policy: ... script-src 'self'; ...` (no `'unsafe-inline'`).
`srcdoc` child documents inherit the parent's CSP, and CSP policies combine
conjunctively with the artifact's own `script-src 'unsafe-inline'`. Result:

- The artifact author script did not run (`window.__artReports` never received
  its postMessage; a CDP-injected inline script also did not execute).
- Chrome logs, for the packaged preview:
  `Executing inline script violates ... 'script-src 'self'' ... The action has
  been blocked.`
- The frontend-injected resize reporter (`data-autoagent-resize`) is inline and
  is blocked too, so iframes never auto-size.
- This contradicts the UI copy "scripts may run" and defeats the purpose of
  `allow-scripts` for interactive artifacts.

Security is not weakened (scripts are simply inert); this is a functional P1.
Likely fixes: serve artifact documents from a separate CSP-free/independent
origin (separate loopback port or a path/response without the parent CSP), or
use a frame mechanism that does not inherit the parent `script-src` while
keeping an opaque origin. Do not loosen the main app's `script-src` to
`'unsafe-inline'`.

### P2 finding — artifact list version count is wrong

`ArtifactsPanel.tsx` renders `artifact.versions.length` (the legacy timestamp
array, which only ever contains the first snapshot timestamp) instead of
`artifact.versionCount`. In the GUI, an artifact with 2, 3, and 4 immutable
versions continuously displayed **"1 version"**. The versions dialog itself was
correct.

## 5. X11 + nested Wayland regression — PASS

X11 (test-only `--no-sandbox`, as before):
- Window loaded; renderer globals: `process`, `require`, `module`, `Buffer` all
  `undefined`; `window.autoagentNative` exposes only the native allowlist.
- Artifact iframe sandbox exact; parent console errors 0; exceptions 0.
- Graceful quit: Electron, backend, and the engine child all exited; port
  closed; **no orphan** (backend shutdown completed in ~3.1 s).

Nested Wayland (gnome-shell 46.2, `DISPLAY` unset for the app):
- Electron argv contains `--ozone-platform=wayland` (count 1); child env has no
  `DISPLAY`; `WAYLAND_DISPLAY=wayland-0`.
- `app.ready=1`, `window.load=1`; CDP page loaded.
- GPU context-lost count over 10 s: **0 → 0 (delta 0)**.
- Graceful quit: no electron/backend orphans (`orphan_count=0`).

## 6. Deferred / remaining limitations

- Deferred P1 (as stated by the implementation): MCP bridge/consent,
  custom-protocol child window (the preload handler exists but has no UI call
  site), diff/split view, and artifact export UI. The export backend endpoint
  exists and is authenticated, but the UI path is not exercised in this P0 loop.
- Deferred P2: A2UI.
- P1 (new, above): interactive artifact scripts are blocked by CSP inheritance.
- P2 (new, above): artifact list shows a stale version count.
- Root-only install/upgrade/remove and the installed setuid sandbox remain
  unverified (no sudo); extraction-based tests were used.
- No real model/API call: the packaged MateBot engine was driven with a
  scripted stream-json CLI, and the artifact API used `AUTOAGENT_ENGINE=fake`.
- Environment note: a pre-existing unrelated backend held port 8787 during the
  run; the app correctly selected 8788. It was not touched.

## M5.1 final verdict

**P0 artifact security loop: PASS. The artifact is safe to ship from the
security standpoint tested here: opaque-origin sandbox, no same-origin/network/
popup/top-navigation, fetch blocked, launch token inaccessible, authenticated
version lifecycle correct, materialization cannot fail a turn, and
`/api/events` refresh works without EventSource.**

**Not complete:** the new P1 (inline artifact scripts never execute under the
inherited parent CSP) should be fixed before calling interactive artifacts
done; the P2 version-count display should also be corrected.
