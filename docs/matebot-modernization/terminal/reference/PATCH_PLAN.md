# AutoAgent patch plan — integrated terminal

This plan turns the reference files in this directory into an AutoAgent
increment. It is written for the AutoAgent backend/frontend agent; **the
builder did not edit AutoAgent**. Paths are relative to `/home/tars/yysapp/AutoAgent`.

Design constraints inherited from `docs/matebot-modernization/`:

- loopback-only FastAPI; the launch token is the only auth secret;
- `domain/` and `application/` stay framework-free;
- adapters are constructed only in `composition.py`;
- HTTP handlers parse, delegate and serialize; no subprocess calls in routes;
- no shell interpolation, no generic exec bridge;
- no new SQLite migration.

The terminal manager is an **adapter** (stdlib only). The route is the only
FastAPI-aware layer.

---

## Phase T0 — MVP (behind a flag, ~1–2 days)

### T0.1 Backend

1. **Add the adapter package**

   ```
   backend/src/autoagent_backend/adapters/terminal/__init__.py   (new, empty)
   backend/src/autoagent_backend/adapters/terminal/manager.py    (copy)
   ```

   Copy `research/terminal-integration/backend/terminal_manager.py` unchanged.
   It imports only the standard library. Keep `KEY_SEPARATOR = "::"`.

2. **Add the route**

   ```
   backend/src/autoagent_backend/api/routes/terminals.py        (copy)
   ```

   Copy `research/terminal-integration/backend/terminal_router.py`. Its primary
   import already matches the destination:

   ```python
   from ...adapters.terminal.manager import (
       KEY_SEPARATOR, TerminalClosed, TerminalError, TerminalManager,
       TerminalSession,
   )
   from ..deps import TOKEN_COOKIE, get_container
   from ..schemas import ApiModel, DeleteResponse
   from ...composition import Container
   from ...domain.errors import DomainError, InvalidInput, NotFound
   from ...domain.models import Session
   ```

   The sibling-module `except ImportError` fallback exists only so this
   reference directory can be copied without the package tree. It is harmless
   but may be removed in the AutoAgent copy.

   DTOs are route-local in T0 (`TerminalCreateRequest`, `TerminalView`,
   `TerminalListView`) to keep the patch reviewable. T1 may move them into
   `api/schemas.py` for convention.

3. **Wire the composition root** — `backend/src/autoagent_backend/composition.py`

   Add the import and a cwd guard. The guard resolves symlinks and accepts
   only the configured workspace, `default_cwd`, and the data directory:

   ```python
   from pathlib import Path
   from .adapters.terminal.manager import TerminalManager

   def _terminal_cwd_guard(config: BootConfig, settings: object) -> Callable[[str], bool]:
       roots = [config.default_cwd.resolve(), config.paths.data_dir.resolve()]
       try:
           configured = settings.read().cwd  # SettingsPort
       except Exception:
           configured = None
       if configured:
           roots.append(Path(configured).expanduser().resolve())

       def allowed(candidate: str) -> bool:
           path = Path(candidate).resolve()
           return any(path == root or path.is_relative_to(root) for root in roots)

       return allowed
   ```

   In `Container`, add:

   ```python
   terminal_manager: TerminalManager
   ```

   In `build_container`, after `settings_store` and before constructing
   `Container`:

   ```python
   terminal_manager = TerminalManager(
       is_cwd_allowed=_terminal_cwd_guard(config, settings_store),
       max_sessions=config.max_terminals if hasattr(config, "max_terminals") else 12,
       default_cwd=str(config.default_cwd),
   )
   ```

   Pass `terminal_manager=terminal_manager` to `Container(...)` and register a
   last-resort synchronous closer:

   ```python
   container.closers.append(terminal_manager.shutdown_now)
   ```

   `Container.close()` is synchronous, so `shutdown_now` (SIGKILL + reap) is the
   correct hook. The async `TerminalManager.shutdown()` is used by the WS layer
   only if you add an explicit lifespan shutdown.

4. **Register the router** — `backend/src/autoagent_backend/app.py`

   ```python
   from .api.routes import (..., terminals, ...)
   ...
   app.include_router(terminals.router)
   # Last: the SPA catch-all must never shadow /api/*.
   app.include_router(static_api.router)
   ```

   HTTP middleware (`authorize_request`) automatically covers the REST routes.
   It does **not** cover WebSockets; the router performs its own gate.

   Optional graceful-await before `active.close()` in lifespan:

   ```python
   if active is not None:
       await active.terminal_manager.shutdown(grace_s=0.5)
       active.close()
   ```

   This is idempotent with `shutdown_now`; either path is safe. Do not block the
   event loop with `shutdown_now` while many terminals are alive if you can
   await `shutdown`.

5. **Allow same-origin WebSockets in CSP** — `backend/src/autoagent_backend/api/static.py`

   Current policy contains `connect-src 'self'`. Chromium usually matches
   same-origin `ws://` under `'self'`, but be explicit and deterministic:

   ```python
   CONTENT_SECURITY_POLICY = (
       ...
       "connect-src 'self' ws://127.0.0.1:*; "
       ...
   )
   ```

   This only broadens the connection target to loopback. Never add `ws:` for all
   hosts.

6. **Delete terminals with their conversation** —
   `backend/src/autoagent_backend/api/routes/sessions.py`

   Make `delete_session` async and inject the container:

   ```python
   from fastapi import APIRouter, Body, Depends, Query
   from ...composition import Container
   from ..deps import get_container, get_session_service

   @router.delete("/api/sessions/{session_id}", response_model=DeleteResponse)
   async def delete_session(
       session_id: str,
       service: SessionService = Depends(get_session_service),
       container: Container = Depends(get_container),
   ) -> DeleteResponse:
       service.delete(session_id)
       await container.terminal_manager.destroy_owner(session_id)
       return DeleteResponse(deleted=True)
   ```

   `destroy_owner` owns the `"::"` key format; the HTTP layer never builds it.

7. **Optional config flag** — `backend/src/autoagent_backend/config.py`

   Add to `BootConfig`:

   ```python
   terminals_enabled: bool = True
   max_terminals: int = 12
   ```

   Parse `AUTOAGENT_TERMINALS` (`_parse_bool`) and `AUTOAGENT_MAX_TERMINALS`
   (`_parse_int`). In `app.py`, include the router only when enabled, or have
   `_require_manager` return 503 when disabled. This is the rollback switch.

### T0.2 Frontend

1. **Dependencies** — `frontend/package.json`

   ```json
   "@xterm/xterm": "^5.5.0",
   "@xterm/addon-fit": "^0.10.0"
   ```

   Do not add `@xterm/addon-webgl` or `@xterm/addon-search` in T0.

2. **Feature folder** — `frontend/src/features/terminal/`

   ```
   terminalClient.ts      (copy)
   TerminalPane.tsx       (copy)
   useTerminalTabs.ts     (copy)
   TerminalPanel.tsx      (new: compose hook + REST + tabs)
   ```

   `TerminalPane.tsx` dynamic-imports xterm, the fit addon and the xterm CSS,
   so there is no SSR path and no CSS side effect at module load.

3. **Token access** — `frontend/src/api/client.ts`

   `launchToken` is module-private. Add:

   ```ts
   export function getLaunchToken(): string | null {
     return launchToken;
   }

   /** Exchange the launch token for the HttpOnly cookie (preferred for WS). */
   export async function ensureSessionCookie(): Promise<void> {
     if (!launchToken) return;
     await request<{ ok: boolean; apiVersion: string }>("/api/auth/session", {
       method: "POST",
     });
   }
   ```

   In `main.tsx`, after `initLaunchToken()`, call
   `void ensureSessionCookie().catch(() => undefined)`. The WS then authenticates
   via the cookie and no token appears in the URL/logs. If the exchange is not
   ready in T0, pass `getLaunchToken()` into `TerminalPane` and accept the
   query-parameter risk (documented in README §5).

4. **Panel composition** — `TerminalPanel.tsx`

   POST first, then add the server id to the hook. This keeps local and backend
   tab ids identical and avoids an id-remapping pass.

   ```tsx
   const tabs = useTerminalTabs(sessionId, { defaultCwd: workspace.cwd });
   const [busy, setBusy] = useState(false);

   async function createTab() {
     if (!sessionId || busy) return;
     setBusy(true);
     try {
       const view = await api.createTerminal(sessionId, {
         cwd: workspace.cwd,
         cols: 80,
         rows: 24,
       });
       tabs.create({ id: view.tabId, cwd: view.cwd, shell: view.shell });
     } finally {
       setBusy(false);
     }
   }

   async function closeTab(tabId: string) {
     tabs.close(tabId);
     await api.deleteTerminal(sessionId, tabId).catch(() => undefined);
   }
   ```

   Render:

   ```tsx
   <TerminalPane
     key={tabs.activeTab.id}
     sessionId={sessionId}
     tabId={tabs.activeTab.id}
     cwd={tabs.activeTab.cwd}
     shell={tabs.activeTab.shell ?? "/bin/bash"}
     token={getLaunchToken()}
     onExit={(code) => {/* status only; tab remains for replay */}}
   />
   ```

   `useTerminalTabs.create` accepts `{id?, cwd?, shell?, title?}`. Use the
   server `view.tabId` and `view.cwd`/`view.shell`.

5. **Placement** — `frontend/src/app/Shell.tsx`

   T0: add a right-panel tab next to `workspace`/`artifacts`:

   ```tsx
   <TabsTrigger value="terminal" className="justify-center px-1">
     <TerminalSquare size={14} strokeWidth={2} aria-hidden />
   </TabsTrigger>
   ...
   <TabsContent value="terminal" className="min-h-0 flex-1">
     {activeId ? (
       <TerminalPanel sessionId={activeId} workspace={workspace} />
     ) : null}
   </TabsContent>
   ```

   T1: move the panel to a bottom dock/split pane (`SplitPane` already exists in
   `features/artifacts`). Preserve the 4 px drag dead zone and Esc revert.

6. **Reconcile persisted tabs on mount** — `TerminalPanel.tsx`

   Call `GET /api/sessions/{id}/terminals` and compare with
   `tabs.tabs.map(t => t.id)`:

   - backend id exists → keep the tab (attach replays scrollback);
   - backend id missing → drop it or create a replacement (backend restart or
     deletion). Never attach to a stale id (`4404`).

7. **API client types** — `frontend/src/api/client.ts` + `types.ts`

   Add:

   ```ts
   createTerminal(sessionId, input): Promise<TerminalView>
   listTerminals(sessionId): Promise<{ terminals: TerminalView[] }>
   deleteTerminal(sessionId, tabId): Promise<{ deleted: boolean }>
   ```

   Use the existing `request<T>` helper so Bearer/cookie handling is shared.
   `TerminalView` fields: `tabId`, `sessionId`, `shell`, `cwd`, `cols`, `rows`,
   `state`, `exitCode`, `createdAt`.

### T0.3 Tests

Backend:

- Copy `backend/test_terminal_manager.py` to
  `backend/tests/unit/test_terminal_manager.py`, changing the import to
  `from autoagent_backend.adapters.terminal.manager import ...`.
- Add `backend/tests/integration/test_terminal_ws.py` covering:
  1. missing token → 403/4401;
  2. wrong `Origin` → 403/4403;
  3. POST create → WS init → `printf hello` → exit 0;
  4. reconnect with `replay:true` replays `hello` and the exit frame;
  5. DELETE removes the tab and `GET` returns `[]`;
  6. session DELETE closes its tabs (`destroy_owner`);
  7. second concurrent WS → 4409;
  8. sixth tab → 429.
- Keep the manager tests independent of FastAPI (they are stdlib+pytest only).

Frontend (Vitest):

- `terminalClient.test.ts`: `parseServerFrame` accept/reject cases, unknown frame
  returns `null`, early input buffering/flush with a fake `WebSocket`, fatal
  close codes do not reconnect.
- `useTerminalTabs.test.ts` (optional): create/select/close ordering and
  per-session switching.

### T0.4 Acceptance criteria

Backend:

- [ ] `POST /api/sessions/{id}/terminals` returns 201 with `tabId` and spawns a
      shell; `GET` lists it; `DELETE` closes the process group.
- [ ] WS `init → ready → data → exit` works for `printf hello`.
- [ ] Missing token and wrong Origin are rejected before accept.
- [ ] `shell=/tmp/evil` → 400; `cwd` outside roots → 400; sixth tab → 429.
- [ ] `env` in the shell contains no secrets/`LD_PRELOAD`; `TERM` is
      `xterm-256color`.
- [ ] `close`/DELETE leaves no process group (`os.killpg(pgid, 0)` raises
      `ProcessLookupError`).
- [ ] Existing backend tests and import-boundary contracts pass; `ruff` clean.

Frontend:

- [ ] Pane renders prompt, echoes input, handles Ctrl-C and exit.
- [ ] Resize updates `stty size`; reconnect replays without duplicate text.
- [ ] Unmount disposes terminal, addons, observers, timers and socket.
- [ ] `tsc --noEmit` passes; no `any`, no `dangerouslySetInnerHTML`.

Operational:

- [ ] `AUTOAGENT_TERMINALS=0` (if added) hides the panel and returns 503 from the
      routes.
- [ ] No new SQLite migration; no Electron change.

---

## Phase T1 — hardening and polish

1. **Cookie-only auth by default.** Call `ensureSessionCookie()` at boot; keep
   the query fallback for tests only. Confirm uvicorn access logs never contain
   tokens (they log the path/query; use the cookie path in production).
2. **Robust cwd guard.** Include the workspace switch path: `WorkspaceService`
   changes `settings.cwd`; the guard already reads settings per spawn. Reject
   `cwd` values that resolve outside all roots, including symlinked escapes.
3. **Orphan reaper on macOS.** Write `{pid, pgid, startedAt}` to a runtime file
   per tab; at startup, verify the process start time (to avoid PID reuse) and
   kill stale groups. Linux already has `PR_SET_PDEATHSIG`.
4. **Tab reconciliation + stale id cleanup** on panel mount (T0.6).
5. **Limits/config.** `AUTOAGENT_MAX_TERMINALS` global, per-conversation limit
   (4), input rate, queue size, ring size. Log counts, not content.
6. **Observability.** Log `terminal.spawned`, `terminal.exited`,
   `terminal.killed`, `terminal.attach_rejected` with session/tab ids and exit
   codes. Never log input/output or env.
7. **Theme tokens.** Add `--term-black … --term-bright-white` to
   `frontend/src/cds/theme.css` (light and dark) and keep the component reading
   CSS variables. This removes the remaining literal fallback palette from
   feature code, matching the CDS rule.
8. **Bottom dock.** Move the terminal from the right panel to a resizable bottom
   pane; persist its height in `settings.layout` only if the layout schema is
   extended (requires a migration/validation change — otherwise keep it in
   memory).
9. **Search addon** (`@xterm/addon-search`) and copy/paste behavior:
   - Cmd/Ctrl+C copies selection, otherwise sends SIGINT (xterm's default
     `onData` already distinguishes selection copy in the renderer context);
   - Cmd/Ctrl+V uses the browser clipboard event; never use `document.execCommand`.
10. **Integration tests** in CI: PTY tests run on Linux/macOS; skip on Windows.
    Add a WS test that floods output and asserts the UI queue stays bounded.
11. **Accessibility:** confirm xterm's textarea has an `aria-label`, the status
    bar is `aria-live="polite"`, and focus returns to the terminal after tab
    selection.

T1 acceptance: all T0 checks plus cookie-only auth, stale-tab reconciliation,
no orphan processes after `kill -9` of the backend (Linux), and bundle-size
budget (`xterm` chunk < ~350 KB gzip) verified in `vite build`.

---

## Phase T2 — optional, async

- **Persistent scrollback logs** (segmented, redacted, retention policy). This
  is a privacy decision; do not add silently.
- **OSC 133 shell integration** (prompt/command marks) for “run in terminal”
  agent actions and command correlation.
- **WebGL addon** with context-loss fallback; only if profiling shows canvas is
  insufficient.
- **Multi-attach** (broadcast output to N viewers). Requires a fan-out design
  and is not needed for a single-window desktop app.
- **SSH/WSL/remote shells.** Out of v1: they add credential storage, host-key
  verification and a remote process lifecycle. Treat as a separate feature.

---

## File-level checklist

Backend (new):

```
backend/src/autoagent_backend/adapters/terminal/__init__.py
backend/src/autoagent_backend/adapters/terminal/manager.py
backend/src/autoagent_backend/api/routes/terminals.py
backend/tests/unit/test_terminal_manager.py
backend/tests/integration/test_terminal_ws.py
```

Backend (modify):

```
backend/src/autoagent_backend/composition.py       # Container field, construct, closer
backend/src/autoagent_backend/app.py               # include_router; optional await shutdown
backend/src/autoagent_backend/api/static.py        # CSP connect-src ws loopback
backend/src/autoagent_backend/api/routes/sessions.py  # async delete + destroy_owner
backend/src/autoagent_backend/config.py            # optional flags (T0.7)
backend/src/autoagent_backend/api/deps.py          # optional get_terminal_manager
```

Frontend (new):

```
frontend/src/features/terminal/terminalClient.ts
frontend/src/features/terminal/TerminalPane.tsx
frontend/src/features/terminal/useTerminalTabs.ts
frontend/src/features/terminal/TerminalPanel.tsx
frontend/tests/terminalClient.test.ts
```

Frontend (modify):

```
frontend/package.json                 # @xterm/xterm, @xterm/addon-fit
frontend/src/app/Shell.tsx            # panel tab / bottom dock
frontend/src/api/client.ts            # getLaunchToken/ensureSessionCookie + REST methods
frontend/src/api/types.ts             # TerminalView types
frontend/src/main.tsx                 # ensureSessionCookie (T1)
frontend/src/styles/index.css         # optional xterm CSS import
```

Desktop: **no changes**.

---

## Verification commands

Reference directory (what the builder ran):

```bash
cd /home/tars/yysapp/claude-desktop/research/terminal-integration/backend
/home/tars/yysapp/AutoAgent/backend/.venv/bin/python -m py_compile \
  terminal_manager.py terminal_router.py test_terminal_manager.py
/home/tars/yysapp/AutoAgent/backend/.venv/bin/python -m pytest -q test_terminal_manager.py
/home/tars/yysapp/AutoAgent/backend/.venv/bin/ruff check \
  --select E,F,I,UP,B,SIM,RUF --ignore B008,SIM105 \
  --line-length 100 --target-version py312 \
  terminal_manager.py terminal_router.py test_terminal_manager.py
```

AutoAgent after patching:

```bash
cd /home/tars/yysapp/AutoAgent/backend
uv run pytest -q
uv run ruff check
uv run lint-imports          # if invoked by the Makefile
```

Frontend:

```bash
cd /home/tars/yysapp/AutoAgent/frontend
bun add @xterm/xterm @xterm/addon-fit
bun run typecheck
bun run test
bun run build
```

The reference frontend files were typechecked under strict options with
temporary stubs for the two xterm packages (they are not installed yet). Re-run
against the real packages after `bun add`.

---

## What NOT to copy from Claude Desktop

1. **Separate node-pty utility process and its IPC protocol.** Not needed in a
   Python backend; it adds a second auth boundary and a second lifecycle.
2. **`spawn/write/resize/kill/read-scrollback` IPC frames.** Replace with one
   WebSocket protocol and REST tab resources.
3. **Segmented scrollback logs, grep, and a 40 s watchdog.** A 1 MiB ring plus
   WS ping/idle timeout is enough for v1.
4. **Renderer-main tab event bus and a main-process tab registry.** Tabs are
   backend resources addressed by REST.
5. **OSC 133 shell integration, SSH, WSL, and remote shells.** Out of scope for
   v1.
6. **WebGL/Search addons at launch.** Add after the canvas path is stable.
7. **Token in a WebSocket query string as the primary auth path.** Use the
   HttpOnly cookie; keep the query only for tests and early integration.

---

## Rollback

1. Set `AUTOAGENT_TERMINALS=0` (T0.7) or remove
   `app.include_router(terminals.router)`.
2. Revert the `Container` field/construction and the session-delete hook.
3. Remove `@xterm/xterm` and `@xterm/addon-fit`; remove the feature folder and
   the Shell tab.
4. Revert the CSP `connect-src` addition.

No database migration, no on-disk terminal state, and no desktop change means
rollback is a pure code revert. Running shells are owned by the manager and are
reaped on backend shutdown; if a hard crash leaves one behind on macOS, kill it
manually until the T1 orphan reaper lands.
