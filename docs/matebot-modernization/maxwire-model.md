# MaxWire Desktop Model — Patterns Worth Copying

Reference: `/home/tars/yysapp/maxwire`, files
`desktop/main.cjs`, `desktop/layout.cjs`, `desktop/updater.cjs`,
`packaging/linux/maxwire-app`, `webapp/server.py`.
This document extracts **architecture and operational patterns only**; MaxWire's
manufacturing domain logic is intentionally excluded.

---

## 1. Overall shape

```
Electron main (thin)                  Python stdlib backend              SPA
─────────────────────                 ─────────────────────             ────
single-instance lock                  ThreadingHTTPServer               static dist/ (index.html)
port negotiation ───────────────►     /api/health                       /api/* JSON
spawn backend manager                 /api/auth/{login,session,logout}
health probe loop ───────────────►    session cookie (12h)
loadURL(http://127.0.0.1:port) ───►   sqlite (WAL, local-first)  ◄────── polling
log to XDG state dir                  SPA fallback
shutdown/cleanup                      update check (desktop)
```

The renderer has **no preload bridge and no `nodeIntegration`**; it is a normal web
page talking HTTP to the local backend (`desktop/main.cjs:266-297`). That is the
single most important structural lesson for AutoAgent.

---

## 2. `desktop/main.cjs` — lifecycle patterns

### 2.1 Single-instance lock with retries

`main.cjs:21-28`, `303-320`, `380-385`.

- 10 retries × 1.5 s.
- Rationale (documented in-source): after an update the old instance is still
  shutting down; immediately calling `app.quit()` makes the app appear to vanish.
- Only after exhausting retries does it log and quit.
- `second-instance` restores/shows/focuses the existing window (`322-329`).

AutoAgent currently has a one-shot lock (`main.ts:2721-2733`). Copy the retry loop.

### 2.2 Port selection and health probing

`main.cjs:30-41`, `123-131`, `166-234`.

- Base port 8091, scan 9 ports on Windows; Linux uses config/default 8081.
- `probePort()` GETs `/api/health` with an 800 ms timeout and treats
  `{ok:true}` as “this is our own service”. Own-but-occupied ports are **reused**,
  not skipped, to avoid two backends writing the same SQLite DB (`199-205`).
- `waitForHealth(timeoutMs=12000)` polls every 250 ms.
- The chosen port is passed to the child as `MAXWIRE_PORT` and is the single
  alignment point between window URL and backend (`36-41`, `137-148`).
- If the backend manager exits, the desktop calls `shutdown()` (`155-162`) — the
  window must not survive a dead backend.

For AutoAgent: choose a free loopback port on **every** platform (not only Windows),
pass it via env, and probe a no-I/O `/api/health`.

### 2.3 Backend spawn and environment

`main.cjs:123-164`.

```js
backendProcess = spawn(executable, [], {
  cwd: packageRoot,
  env: {
    ...process.env,
    MAXWIRE_HOME: packageRoot,
    MAXWIRE_NO_BROWSER: "1",
    MAXWIRE_DESKTOP_PID: String(process.pid),
    MAXWIRE_PORT: String(serverPort),
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
  },
  windowsHide: true,
  detached: false,
  stdio: "ignore",
});
```

Things to copy: explicit port, unbuffered UTF-8, parent PID (for orphan cleanup),
`windowsHide`, `stdio:"ignore"` with logging inside the backend, and a child `exit`
handler that shuts the desktop down.

### 2.4 Window loading

`main.cjs:266-297`.

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload.
- `show:false` + `ready-to-show`.
- `setWindowOpenHandler` only allows `https://` to the external browser.
- `will-navigate` is denied unless it targets the local app URL (`290-292`).
- `did-fail-load` logs; no file:///data: fallback chain. A dead backend fails loudly
  (by design).

AutoAgent currently ships a renderer HTTP server that only serves static files
(`main.ts:1213-1253`) and has `sandbox:false` (`main.ts:2027`). The migration merges
that server into the Python backend and can turn `sandbox` on.

### 2.5 Logging

`main.cjs:53-74`.

- Linux: `${XDG_STATE_HOME:-~/.local/state}/maxwire/logs/desktop.log`.
- Windows: `%LOCALAPPDATA%\MaxWire\logs\desktop.log` via `layout.stateHome()`.
- Log writes are wrapped in try/catch; logging must never prevent startup/shutdown.
- Never inside the versioned install directory (updates rotate/delete it, `54-59`).

AutoAgent already writes to `${XDG_STATE_HOME:-~/.local/state}/autoagent/logs/desktop.log`
(`RUNTIME_PATHS.md:210`), but `engine.log` still goes to `/tmp`
(`engine-client.ts:16`). Move engine logs to the same state dir.

### 2.6 Shutdown

`main.cjs:254-264`, `369-377`.

- Idempotent `shuttingDown` flag.
- Windows: `taskkill /PID <pid> /T /F`, plus image-name fallback for known orphan
  processes (`101-121`).
- Linux: `maxwire stop` control script.
- `window-all-closed`, `before-quit` (preventDefault + async cleanup), `SIGTERM`,
  `SIGINT` all funnel into `shutdown()`.
- The Linux launcher also runs `maxwire stop` after Electron exits as an OS-level
  fallback (`packaging/linux/maxwire-app:31-33`).

Copy this for the Python child: one idempotent cleanup path, signal handlers, and a
launcher-level fallback.

### 2.7 Startup failure handling

`main.cjs:344-365`.

- Do **not** use blocking `dialog.showErrorBox` (documented incident: unattended
  machine hung for hours).
- Use async `dialog.showMessageBox` raced against a 60 s timeout, then
  `shutdown(1)`.
- Always log the failure with a path to the log file.

### 2.8 Update checks

`desktop/updater.cjs`; wired at `main.cjs:336-343`.

- Check on startup and every 6 h; failures only log.
- Decoupled from job execution.
- Not required for AutoAgent v1, but the “never let update machinery block work”
  rule is worth keeping.

### 2.9 Version-aware health check

`webapp/server.py:4102-4122`.

`--health-check <url>` compares the running `boot_version` with the version on
disk, so a stale process on a reused port is detected and restarted. AutoAgent
should return `version` and `bootId` in `/api/health` and adopt the same check.

---

## 3. `desktop/layout.cjs` — path layout

`desktop/layout.cjs:28-70`.

- `currentAppDir()` = `dirname(process.execPath)`, never a hard-coded install path.
- `installRoot()` handles both `app-<version>` and flat layouts.
- `versionDir(version)` must match the installer's derivation.
- `stateHome()` = `%LOCALAPPDATA%\MaxWire`; mutable state (DB/logs/pid/spool) lives
  **outside** the rotating version directory.
- Cross-language constants (`APP_DIR_PREFIX`, `STATE_DIR_NAME`) are asserted by
  tests against the installer and the Python launcher.

For AutoAgent: define one JS/Python-shared rule:

```
state/data root  = AUTOAGENT_DATA_DIR (explicit override)
                   else platform default (Electron userData today)
versioned app    = /opt/autoagent (Linux), Program Files-ish (Windows)
logs             = <state>/logs
```

Do not write mutable data under `/opt/autoagent` or `%TEMP%` (current Windows bug,
`AutoAgent/src/main.ts:321-323`).

---

## 4. `packaging/linux/maxwire-app` — launcher

`packaging/linux/maxwire-app:1-36`.

- `set -u`, signal forwarding, wait for Electron.
- Chooses `--ozone-platform=wayland` only when `WAYLAND_DISPLAY` is set.
- After Electron exits, runs a control-script stop as an OS-level cleanup fallback.
- Exit code preserved (unless killed by a signal).

AutoAgent's launcher (`packaging/deb/usr/bin/autoagent`) has the better Wayland
socket check (falls back to X11 if the socket is missing) and should be kept. Add
the post-exit backend-stop fallback.

---

## 5. `webapp/server.py` — stdlib backend patterns

### 5.1 Server and routing

- `ThreadingHTTPServer` with `protocol_version = 'HTTP/1.1'`
  (`server.py:3377-3379`, `4158`).
- One `Handler(BaseHTTPRequestHandler)` with explicit `do_GET` / `do_POST`
  (`3377`, `3454`, `3708`). Routing is an if/elif chain on exact paths; this is
  acceptable for a local single-user service and keeps zero dependencies.
- Query parsing via `urllib.parse.parse_qs`, bounded integer helper `_int`
  (`3456-3457`, `3701-3706`).
- Static files and SPA fallback in `_serve_static` (`3432-3452`): unquote, strip
  leading `/`, fall back to `index.html` only when the path has no extension,
  `realpath` + `commonpath` guard against traversal, `Cache-Control: no-cache`.
- Unknown GET paths fall through to static (`3691`).
- `log_message` suppresses health/board polling noise (`4009-4014`).
- `QuietThreadingHTTPServer` suppresses broken-pipe tracebacks (`4017-4043`).
- Windows gets exclusive binding via `SO_EXCLUSIVEADDRUSE` so “port in use” is
  detectable (`4020-4037`).

### 5.2 JSON and body helpers

`server.py:3381-3407`.

```python
def _json(self, obj, code=200, extra_headers=None):
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    self.send_response(code)
    self.send_header('Content-Type', 'application/json; charset=utf-8')
    self.send_header('Content-Length', str(len(data)))
    ...
```

- `_read_body` enforces `Content-Length`, `MAX_BODY_BYTES = 64 KiB`
  (`server.py:56`, `3391-3407`), validates UTF-8 JSON and requires an object.
- Error contract: `{ok:false, error:"..."}` with HTTP status. Successful responses
  are `{ok:true, ...payload}`.
- `do_GET` / `do_POST` wrap everything in try/except, log
  `[err] METHOD path: Type: message`, and return a 500 JSON body
  (`3692-3699`; POST has an equivalent block).

Copy: `_json`, `_read_body`, bounded input, top-level exception guard, quiet
polling logs. Do **not** copy the exact `{ok:...}` envelope if the frontend team
prefers typed HTTP errors, but pick one and freeze it.

### 5.3 Health endpoint

`server.py:3659-3690`.

- Returns `{ok:true, db:'ok', version, boot_version, ...}`.
- **Explicit contract: no network I/O** (documented incident: DNS hang made the
  desktop report “backend failed to start” while the service was healthy).
- Expensive subsystem states are served from in-memory snapshots refreshed by
  background threads (e.g. `STRUCT_LIGHT.status()`).
- The desktop probe only requires HTTP 200 for liveness (`main.cjs:216-225`).

For AutoAgent, `/api/health` must answer before DB init, engine probe, MCP
connection or any model call.

### 5.4 Authentication / sessions

`server.py:64-82`, `596-661`, `3409-3430`, `3459-3465`, `3718-3738`.

- Two independent layers:
  1. Optional machine token `X-MaxWire-Token` (`_authorized`).
  2. Browser login session cookie `maxwire_session`, 12 h TTL, `HttpOnly;
     SameSite=Lax`, PBKDF2-SHA256 password hashes, sessions stored in SQLite.
- `AUTH_EXEMPT_PATHS` for `/api/health`, `/api/auth/login`, `/api/auth/session`
  and the scan ingress.
- Every `/api/*` GET/POST checks the session after login/exempt paths.
- Cookie is set only on login; logout sends `Max-Age=0`.

For AutoAgent (single local user), a login screen is unnecessary. Copy the
**exemption discipline** and the token gate: a per-launch random token generated
by Electron, passed to Python and to the SPA, checked on every `/api/*` request.
Do not expose unauthenticated filesystem or engine control even on loopback.

### 5.5 SQLite

`server.py:979-990`.

```python
def db_connect():
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.execute('PRAGMA busy_timeout=10000')
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
```

- Connection per operation, short-lived; WAL with busy timeout.
- Schema migrations use `PRAGMA table_info` to add missing columns idempotently
  (`1196-1203`).
- Local-first: write SQLite first, do network reporting asynchronously with
  idempotency keys (module docstring `server.py:1-19`).

For AutoAgent: the backend will be the only writer. Use WAL + `busy_timeout` and
one connection per request/worker. Never let Electron and Python both write.

### 5.6 Startup / shutdown

`server.py:4088-4194`.

- Side-effect-free `--runtime-check` and `--version` fast paths.
- `--health-check` version comparison.
- Windows console handler ignores logoff/shutdown close events
  (`4124-4137`) — relevant if the backend runs as a persistent local service.
- `init_db()` then background daemon threads, then bind/listen.
- Bind failure prints an actionable message and returns non-zero
  (`4154-4166`) so the launcher can detect it.
- `serve_forever()` with `KeyboardInterrupt` and a `finally` that stops threads
  and shuts the server down.
- ASCII-only warning prefixes, because Windows stdout may be redirected under
  GBK (`4073-4085`).

This is directly applicable to the MateBot backend: `--version`,
`--health-check`, unbuffered logs, actionable bind errors, clean signal handling.

---

## 6. What not to copy

| MaxWire pattern | Why not |
|---|---|
| Login/password UI and user table | AutoAgent is a single-user local app; a launch token is enough. |
| Domain tables and reporting loops | Not applicable. |
| Polling every terminal/API view | The chat UI needs SSE; polling is acceptable only for status/health. |
| `config.json` with silently stale defaults | MaxWire's own comments document upgrade bugs caused by never refreshing config. Make AutoAgent's settings schema explicitly versioned. |
| Linux fixed port from config | AutoAgent should negotiate a free port on every platform and pass it to both sides. |
| Ignoring child stdout (`stdio:"ignore"`) | Fine for MaxWire's launcher, but AutoAgent's backend logs are needed for support; pipe them to the state log. |

---

## 7. Proposed thin-shell skeleton (AutoAgent)

```
Electron main
  acquire single-instance lock (retry 10×1.5s)
  dataDir = resolveAutoAgentDataDir()        // stable, never %TEMP%
  userData override = dataDir                // before app.whenReady
  whenReady:
    port = choosePort(base=8787, count=16, probe /api/health)
    spawn(python, backend/server.py,
          env={ AUTOAGENT_PORT, AUTOAGENT_DATA_DIR, AUTOAGENT_API_TOKEN,
                AUTOAGENT_DESKTOP_PID, PYTHONUNBUFFERED=1,
                PYTHONIOENCODING=utf-8 })
    waitForHealth(12s)
    createWindow({ preload: minimal.cjs, sandbox:true, contextIsolation:true })
    loadURL(`http://127.0.0.1:${port}/?token=${token}`)
    log every startup phase to <state>/logs/desktop.log
  on second-instance: restore/focus
  on before-quit/window-all-closed/SIGTERM/SIGINT: idempotent shutdown
  on backend exit: shutdown(1)
  startup failure: async dialog raced with 60s, then shutdown(1)
```

Minimal preload keeps only desktop-native capabilities the web platform cannot do:
window controls, native file dialogs, clipboard image/text, `shell.openExternal`,
`showItemInFolder`, notifications, theme, artifact child window, and navigation
history for artifact windows. Everything else is HTTP.

`AUTOAGENT_LEGACY=1` should make main.cjs load the old bundle/old renderer path
instead of the backend, so rollback is one env var.
