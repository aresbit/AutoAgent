# Integrated terminal for AutoAgent — reference design

Status: **reference implementation only**. Nothing under `/home/tars/yysapp/AutoAgent`
was modified. This directory contains a runnable PTY manager, a FastAPI router,
tests, and React/TypeScript client code that can be moved into AutoAgent.

Target increment: **M5+ terminal panel**. The design follows the existing
AutoAgent conventions in `docs/matebot-modernization/architecture.md` and
`api-contract-v1.md`: loopback-only backend, launch token/cookie auth, typed
boundary DTOs, no shell interpolation, adapters hidden behind a small surface.

---

## 1. Architecture

```
┌────────────────────────── Electron / renderer ──────────────────────────┐
│  React 19 (Vite, CSR only)                                              │
│                                                                         │
│  TerminalPane.tsx                                                       │
│   ┌──────────────────────────────┐    ┌──────────────────────────────┐  │
│   │ xterm.js Terminal            │    │ status bar: state · cwd ·     │  │
│   │ + FitAddon                   │    │ shell · exit code             │  │
│   └──────────────┬───────────────┘    └──────────────────────────────┘  │
│                  │ onData (UTF-8 text)      ▲ term.write(data)          │
│                  ▼                           │                          │
│  terminalClient.ts: typed frames, runtime validation, early-input       │
│  buffer, one socket, no base64                                          │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ WebSocket (ws://127.0.0.1:<port>)
                               │ /api/sessions/{sessionId}/terminals/{tabId}/ws
                               │ same-origin; cookie or Bearer/query token
┌──────────────────────────────▼──────────────────────────────────────────┐
│ FastAPI (uvicorn, 127.0.0.1 only)                                       │
│                                                                         │
│  api/routes/terminals.py                                                │
│    · origin + launch-token gate (WebSocket bypasses HTTP middleware)    │
│    · one WebSocket attachment per tab                                   │
│    · frame validation, size/rate limits, incremental UTF-8 decoding     │
│    · REST: list / create / delete tabs                                  │
│                                                                         │
│  adapters/terminal/manager.py   (stdlib only: no FastAPI/Pydantic)      │
│    TerminalManager                                                      │
│      └─ TerminalSession                                                 │
│           os.openpty() → fork → setsid() → TIOCSCTTY → execvpe()         │
│           TIOCSWINSZ resize · non-blocking master · add_reader           │
│           bounded asyncio.Queue · 1 MiB ring buffer · killpg             │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ PTY master/slave
                               ▼
                     $SHELL -l  (bash | zsh | sh allowlist)
                     argv list, shell=False, minimal env, contained cwd
```

### Why WebSocket instead of SSE + POST

A terminal is **full-duplex and keystroke-latency sensitive**. WebSocket gives:

- one ordered connection for input, output, resize, exit, and control frames;
- no HTTP request per keystroke; no head-of-line coupling with other API calls;
- server push for output floods and exits, with TCP backpressure;
- a natural place to enforce one-attachment and frame-rate limits.

SSE + POST would require `POST /input` for every keystroke/resize/close plus an
SSE stream for output. That adds round trips and ordering ambiguity (an input
POST racing an SSE echo), doubles the auth/CSRF surface, and is much worse on
high-latency or CPU-contended machines.

**Choose the SSE fallback only when** a customer proxy/WAF strips `Upgrade`,
or when the terminal must be strictly read-only (CI logs). A fallback design is:
SSE for output with `Last-Event-ID` carrying an output sequence, and
`POST /terminals/{tab}/input`, `POST /resize`, `POST /close` for control.
Keep `seq` on both transports so the UI logic is shared. Do not build it in v1.

---

## 2. Wire protocol

Transport: JSON **text** frames. PTY output is decoded as UTF-8 with
`errors="replace"`; multi-byte code points split across `read()` boundaries are
preserved by an incremental decoder. Base64 is **not** used: a terminal is text,
and base64 would inflate output by 33 %. If a future feature needs raw binary
(e.g. file transfer), add an explicit `data.b64` frame variant rather than
changing `data`.

Every server frame carries `seq` (monotonic per connection, starting at 1).

### Client → server

| `type` | Fields | Rules |
|---|---|---|
| `init` | `cols:int`, `rows:int`, `replay:bool=true` | **Mandatory first frame.** `1..1000`. Updates winsize; replay adds the ring snapshot. |
| `input` | `data:string` | UTF-8 text, ≤ 64 KiB per frame. Token-bucket limited (120 burst / 240 per s). |
| `resize` | `cols:int`, `rows:int` | `1..1000`; applied with `TIOCSWINSZ`. |
| `close` | — | Terminates the whole process group. Server sends `exit` then closes. |
| `ping` | — | Server replies `pong`; use every 25 s. |

### Server → client

| `type` | Fields | Meaning |
|---|---|---|
| `ready` | `tabId`, `sessionId`, `shell`, `cwd`, `cols`, `rows`, `state`, `exitCode`, `replayBytes` | Client may now send live input. Replay data follows if requested. |
| `data` | `data:string`, `replay?:bool` | PTY output. `replay=true` is the ring snapshot; live chunks omit it. |
| `exit` | `code:int\|null`, `signal:int\|null` | Exactly one per attach, after all output. Negative `code` is a signal (`-SIGTERM`); `signal` is the same signal number. |
| `error` | `code:string`, `message:string` | Non-fatal unless followed by a 4xxx close. |
| `pong` | `ts:int` | Epoch milliseconds. |

Example:

```json
{"type":"init","cols":100,"rows":30,"replay":true}
{"type":"ready","tabId":"9f…","sessionId":"s1","shell":"/bin/bash","cwd":"/home/me/project","cols":100,"rows":30,"state":"running","exitCode":null,"replayBytes":1745,"seq":1}
{"type":"data","data":"total 8\r\n","seq":2}
{"type":"exit","code":0,"signal":null,"seq":3}
```

### Close codes

| Code | Reason | Client action |
|---|---|---|
| `1000` | normal / server done | reconnect only if no `exit` was seen |
| `1011` | backend/internal failure | reconnect with backoff |
| `4400` | bad first frame / invalid size | show error, do not loop |
| `4401` | missing/invalid launch token | show auth error, do not loop |
| `4403` | origin rejected | show error, do not loop |
| `4404` | session/tab not found (deleted or backend restarted) | remove or recreate tab |
| `4409` | already attached in another view | show "already open" |
| `4429` | input rate limit | show error; back off |

---

## 3. Session/tab key model

- A **conversation** is `sessionId` (SQLite session id).
- A **tab** is `tabId`, generated server-side as a 32-char UUID hex.
- The manager key is `f"{sessionId}::{tabId}"` (`KEY_SEPARATOR` exported by the
  manager). HTTP clients never construct this string.
- `GET    /api/sessions/{sessionId}/terminals` lists tabs, including exited tabs
  whose scrollback is still replayable.
- `POST   /api/sessions/{sessionId}/terminals` spawns immediately and returns
  `{tabId, shell, cwd, cols, rows, state, exitCode, createdAt}`.
- `DELETE /api/sessions/{sessionId}/terminals/{tabId}` closes the process group
  and removes the tab.
- One WebSocket attachment per tab. A second concurrent viewer receives `4409`.
- Deleting a conversation must call `TerminalManager.destroy_owner(sessionId)`.

The PTY is **not** tied to the WebSocket lifetime. Unmount/refresh/reconnect
detaches, the process keeps running, and the next `init` with `replay=true`
receives up to 1 MiB of recent output. Only `close`, `DELETE`, session deletion,
or backend shutdown terminate it.

---

## 4. Lifecycle and state machine

Manager/tab:

```
                 POST create
   (no tab) ─────────────────▶ starting ── first output / 50 ms ──▶ running
                                   │                                  │
                                   │ exec/PTY failure                 │ child exits
                                   ▼                                  ▼
                               failed (no tab) ◀── HTTP error      exited
                                                                      │
                                      WS replay/list until DELETE ◀───┘
                                                                      │
                                                        DELETE / shutdown
                                                                      ▼
                                                                 destroyed
```

WebSocket attachment:

```
 detached ── init + auth ──▶ attached ── client close/DELETE/shutdown ──▶ detached/404
     ▲                            │
     └──── disconnect/timeout ────┘      (PTY keeps running; `exit` is queued)
```

Renderer connection state (implemented in `TerminalPane.tsx`):

```
 idle → connecting → ready
                   ↘ (close, non-fatal) → reconnecting → connecting …
                   ↘ (exit)             → closed
                   ↘ (4xxx / protocol)  → error
```

Reconnect uses exponential backoff (500 ms → 10 s, ±250 ms jitter). It is
suppressed after `exit`, after a fatal 4xxx close, and on unmount.

---

## 5. Security

| Control | Implementation |
|---|---|
| Network | Backend already binds `127.0.0.1`; `config_from_env` refuses other hosts. No CORS. |
| HTTP auth | Existing `authorize_request` middleware: exact `Origin`, launch token (Bearer or HttpOnly cookie), 1 MiB body cap. |
| WebSocket auth | **Middleware does not run for WS.** Router checks `Origin == config.origin` when present and compares the token in constant time (`hmac.compare_digest`). Sources: cookie, `Authorization`, then query. Reject before `accept()`. |
| Token handling | Prefer `POST /api/auth/session` cookie exchange. The query fallback is for tests/initial integration; uvicorn access logs can record query strings, so do not make it the default. |
| Shell allowlist | Resolve `Path(...).resolve(strict=True)` and require membership in `/bin|/usr/bin` `{bash,zsh,sh}`. `$SHELL` is used only if allowlisted; an explicit disallowed shell is a 400. No `fish`, `nu`, arbitrary binaries. |
| Cwd containment | Caller-provided `is_cwd_allowed`; composition wires the configured workspace, `default_cwd`, and data dir as roots. Resolve symlinks first; reject missing/denied paths. |
| No shell interpolation | `argv` lists only; child uses `os.execvpe`; `shell=True` is never used. The API never accepts an argv, only an allowlisted shell path. |
| Env scrub | Keep only `PATH`, `HOME`, `TERM`, `COLORTERM`, `LANG`, `LC_ALL`. Force `TERM=xterm-256color`. Drop `LD_PRELOAD`, `NODE_OPTIONS`, all `ANTHROPIC_*`, cloud credentials, etc. Clients cannot pass env. |
| Limits | 4 tabs/conversation, 12 global, 128 KiB raw frame, 64 KiB input, 1 MiB write, 16 bad frames, 5 rate-limit strikes, one attachment. |
| Backpressure | 256-item output queue; when full the PTY reader is paused and the kernel buffer blocks the child. 1 MiB ring buffer for replay (not a scrollback log). Input writes retry with a 5 s cap. |
| Process cleanup | Child calls `setsid()`; close sends `SIGHUP → SIGTERM → SIGKILL` to `killpg(pid)`. Linux also sets `PR_SET_PDEATHSIG=SIGTERM` so a hard backend crash does not orphan shells. `Container.close` reaps synchronously. |
| Error hygiene | Manager error messages contain no paths, argv, env, or PIDs. HTTP mapping returns `{ok:false, code, error}` through the existing mapper. |
| CSP | `connect-src 'self'` usually permits same-origin `ws://` in Chromium, but be explicit for deterministic behavior: add `ws://127.0.0.1:*`. Verify in Electron. |

Residual risks are listed in §8.

---

## 6. Integration map (AutoAgent files)

Do **not** edit these from this reference directory; this is the patch plan.

### Backend

| Action | Path | Change |
|---|---|---|
| New | `backend/src/autoagent_backend/adapters/terminal/__init__.py` | Empty package marker. |
| New | `backend/src/autoagent_backend/adapters/terminal/manager.py` | Copy `backend/terminal_manager.py` unchanged. |
| New | `backend/src/autoagent_backend/api/routes/terminals.py` | Copy `backend/terminal_router.py`. Its primary import is already `...adapters.terminal.manager`; the sibling fallback is only for this reference directory. |
| Modify | `backend/src/autoagent_backend/composition.py` | Import `TerminalManager`; add `terminal_manager: TerminalManager` to `Container`; construct it with the cwd guard; append `terminal_manager.shutdown_now` to `closers`. |
| Modify | `backend/src/autoagent_backend/app.py` | `from .api.routes import terminals`; `app.include_router(terminals.router)` before the static catch-all. Optionally `await active.terminal_manager.shutdown()` in lifespan `finally` before `active.close()`. |
| Modify | `backend/src/autoagent_backend/api/static.py` | Add `ws://127.0.0.1:*` to `connect-src` in `CONTENT_SECURITY_POLICY`. |
| Modify | `backend/src/autoagent_backend/api/routes/sessions.py` | Make `delete_session` async; after `service.delete`, `await container.terminal_manager.destroy_owner(session_id)`. Inject the container with `Depends(get_container)`. |
| Optional | `backend/src/autoagent_backend/api/deps.py` | Add `get_terminal_manager(request)` for route symmetry. The reference router reads the container directly. |
| Optional | `backend/src/autoagent_backend/config.py` | Add `terminal_enabled: bool = True` and `max_terminals: int = 12` from `AUTOAGENT_TERMINALS` / `AUTOAGENT_MAX_TERMINALS` for a kill switch. |
| New tests | `backend/tests/unit/test_terminal_manager.py` | Copy `backend/test_terminal_manager.py` (adjust import to `autoagent_backend.adapters.terminal.manager`). |
| New tests | `backend/tests/integration/test_terminal_ws.py` | WS auth/origin/init/input/exit/replay/delete. See the verification notes below. |

Composition sketch:

```python
from .adapters.terminal.manager import TerminalManager

def _terminal_allowed(config, settings):
    roots = [config.default_cwd.resolve(), config.paths.data_dir.resolve()]
    configured = settings.read().cwd
    if configured:
        roots.append(Path(configured).expanduser().resolve())

    def allowed(candidate: str) -> bool:
        path = Path(candidate).resolve()
        return any(path == root or path.is_relative_to(root) for root in roots)

    return allowed

terminal_manager = TerminalManager(
    is_cwd_allowed=_terminal_allowed(config, settings_store),
    max_sessions=config.max_terminals,
    default_cwd=str(config.default_cwd),
)
```

### Frontend

| Action | Path | Change |
|---|---|---|
| Modify | `frontend/package.json` | Add `@xterm/xterm` `^5.5.0` and `@xterm/addon-fit` `^0.10.0`. (`@xterm/addon-webgl` and `@xterm/addon-search` are T2.) |
| New | `frontend/src/features/terminal/terminalClient.ts` | Copy from this directory. |
| New | `frontend/src/features/terminal/TerminalPane.tsx` | Copy from this directory. |
| New | `frontend/src/features/terminal/useTerminalTabs.ts` | Copy from this directory. |
| New | `frontend/src/features/terminal/TerminalPanel.tsx` | Compose the hook + REST calls + tabs + `<TerminalPane>`; not included here to keep the reference small. |
| Modify | `frontend/src/api/client.ts` | Export `getLaunchToken(): string | null` (the module already keeps `launchToken`) and/or add `ensureSessionCookie()` that POSTs `/api/auth/session` once at boot. Prefer cookie auth for WS. |
| Modify | `frontend/src/app/Shell.tsx` | Add a `terminal` tab to the right-panel `TabsList` in T0 (place it beside `workspace`/`artifacts`); bottom dock/split pane is T1. |
| Modify | `frontend/src/styles/index.css` | Optional: `@import "@xterm/xterm/css/xterm.css";`. The reference component already dynamic-imports the CSS. |
| New tests | `frontend/tests/terminalClient.test.ts` | Vitest: frame validation, early-input buffer, close-code policy (mock `WebSocket`). |

No Electron/desktop changes are required: the renderer opens a same-origin
`ws://127.0.0.1:<backend port>` connection, which the existing thin shell
already permits. If a custom session partition or enterprise policy blocks WS,
add the explicit CSP entry above.

### Reconnect / stale-tab reconciliation

On panel mount, call `GET /api/sessions/{id}/terminals` and reconcile with the
hook's persisted tabs:

- backend tab exists → keep it and attach (replay scrollback);
- backend tab missing (backend restart/delete) → either drop the tab or create a
  new tab and update the id; never attach to a stale key.

---

## 7. Testing and acceptance

### Commands actually run for this reference

```bash
cd research/terminal-integration/backend
/home/tars/yysapp/AutoAgent/backend/.venv/bin/python -m py_compile \
  terminal_manager.py terminal_router.py test_terminal_manager.py
/home/tars/yysapp/AutoAgent/backend/.venv/bin/python -m pytest -q test_terminal_manager.py
/home/tars/yysapp/AutoAgent/backend/.venv/bin/ruff check \
  --select E,F,I,UP,B,SIM,RUF --ignore B008,SIM105 \
  --line-length 100 --target-version py312 \
  terminal_manager.py terminal_router.py test_terminal_manager.py
```

Reference results at authoring time: `py_compile` OK, `17 passed`,
`ruff` clean. A scratch FastAPI app mirroring AutoAgent's import layout also
passed create → WS init → input → exit → reconnect replay → delete, plus
missing-token and wrong-Origin rejection (no AutoAgent files were touched).

### TypeScript

```bash
cd frontend
bun add @xterm/xterm @xterm/addon-fit   # or npm/pnpm
bun run typecheck                       # tsc --noEmit
bun run test                            # vitest
```

The reference `.ts/.tsx` files typechecked under the repo's strict options
(`strict`, `noUnusedLocals`, `noUnusedParameters`) with temporary local stubs
for `@xterm/xterm` and `@xterm/addon-fit`, because those packages are not
installed in AutoAgent yet. Re-run against the real packages after adding them.

### Manual acceptance

Functional:

1. Open a tab → prompt renders; `echo hello` round-trips.
2. Colors: `printf '\033[31mred\033[0m\n'`; `clear`, `ls --color`, `vim`/`less`
   (alternate screen) render correctly.
3. Resize the pane → `stty size` reports the new rows/cols.
4. `sleep 100`, press Ctrl-C → shell regains the prompt.
5. `exit` / Ctrl-D → status shows `exit 0`; no reconnect loop.
6. Switch tabs and back / refresh the pane → scrollback replays, no duplicate
   visible transcript, shell state preserved.
7. Close the tab → `sleep 100` in that tab is gone; `GET .../terminals` is empty.
8. Delete the conversation → `ps` shows no surviving shells for that session.

Security:

9. `curl` without a token → 401; WS without a token → 403/4401.
10. WS with `Origin: http://evil.example` → 403/4403.
11. Create with `shell=/bin/fish` → 400 `INVALID_SHELL`; `cwd=/` → 400
    `CWD_NOT_ALLOWED` (unless `/` is an approved root; it should not be).
12. In the shell: `echo "$LD_PRELOAD"; env | grep -E 'ANTHROPIC|AWS_'` → empty.
13. Sixth tab in one conversation → 429; second WS attach → 4409.
14. Paste 100 KB → `INPUT_TOO_LARGE`/frame error, connection stays usable.

Performance:

15. Local keystroke echo < ~100 ms (PTY + WS + xterm).
16. `yes` for 2 s → UI remains responsive; reader pauses; memory stays bounded
    by the queue + 1 MiB ring.
17. 4 tabs idle < ~80 MB RSS beyond the base backend.

Acceptance gates for the AutoAgent increment: all functional and security
items pass; `pytest`, `ruff`, `tsc --noEmit`, and the existing import-boundary
tests are green; no new SQLite migration; no desktop change required.

---

## 8. Risks and rollback

| Risk | Mitigation |
|---|---|
| `fork()` from a multithreaded Python process (uvicorn/DB threads) can inherit held locks. | The child executes only `close/ioctl/dup2/chdir/prctl/execvpe` and never re-enters Python business code; this is the same class of operation `subprocess`/`pty` perform. If profiling shows stalls, replace `fork` with `subprocess.Popen(..., start_new_session=True)` plus `TIOCSCTTY`, keeping the same manager surface. |
| `EIO` on PTY close is normal. | Treated as EOF, not an exception; the reaper polls `waitpid(WNOHANG)` and drains remaining bytes before `exit`. |
| Orphaned shells after a backend crash. | Linux `PR_SET_PDEATHSIG`; `Container.close` SIGKILL + reap. On macOS hard crashes cannot use PDEATHSIG: rely on graceful shutdown and, in T1, a start-up reaper for a PID file. |
| Token in WS query appears in access logs. | Prefer the HttpOnly cookie exchange; keep query only as a fallback. Do not log query strings at info level. |
| CSP blocks WebSocket. | Explicit `connect-src ws://127.0.0.1:*`; verify in Electron. |
| xterm bundle size / WebGL context loss with many tabs. | Dynamic import; no WebGL in v1; dispose addons/terminal on unmount. |
| Stale localStorage tab ids after backend restart. | Reconcile with `GET /terminals` on mount (see §6). |
| Reconnect duplicates output. | `TerminalPane` calls `term.reset()` on `ready` before replay frames; replay and live data share one ordered stream. |
| Output floods pin the UI. | Bounded queue pauses the PTY reader (kernel backpressure); 64 KiB chunks; xterm `scrollback: 5000`. |
| Shell integration/OSC 133 absent. | Not required for v1; prompt/cwd display uses the tab metadata, not escape sequences. |

**Rollback:** no database migration and no desktop change, so rollback is
mechanical: set `AUTOAGENT_TERMINALS=0` (if the config flag lands), stop
including `terminals.router`, and remove the two `@xterm` packages. Existing
sessions/artifacts are unaffected. Processes are owned by the manager and die
with the backend; no on-disk state is written.

---

## 9. What we deliberately did not copy from Claude Desktop

Claude Desktop runs node-pty in a separate utility process with an IPC protocol
(`spawn/write/resize/kill/read-scrollback`, `spawned/data/exit/spawn-error`,
40 s watchdog, 64 KiB replay, segmented scrollback logs, OSC 133 shell
integration, SSH/WSL). For AutoAgent:

- **No separate utility process.** The FastAPI backend can own PTYs directly;
  node-pty exists because Electron's renderer cannot spawn processes. A Python
  adapter is simpler, has one auth boundary, and avoids a second protocol.
- **No segmented scrollback logs or grep endpoint in v1.** A 1 MiB in-memory
  ring covers reconnect; persistent logs are a privacy/retention decision, not
  a terminal requirement.
- **No SSH/WSL.** v1 runs the local allowlisted shell in an approved workspace.
- **No renderer-side tab event bus / main-process tab registry.** Tabs are
  ordinary backend resources addressed by REST.
- **No 40 s watchdog.** The WebSocket ping (25 s) plus server idle timeout
  (75 s) covers dead peers without killing idle shells.
- **No OSC 133 / prompt marks initially.** Add later if agent actions need to
  correlate commands with prompts.
- **No WebGL or search addon initially.** Canvas rendering and the FitAddon are
  enough; WebGL adds context-loss cases across many tabs.
