# AutoAgent MCP integration research

Reference implementation and migration plan for replacing AutoAgent's
short-lived MCP sessions with persistent, observable, policy-governed sessions,
without adopting Claude Desktop's DXT/MCP Apps/OAuth surface.

Everything under this directory is unfiled research. No AutoAgent source was
modified. Paths below are absolute where they matter for verification.

## 1. Current state (read from source)

| Area | Current behavior | Gap |
|---|---|---|
| `backend/src/autoagent_backend/adapters/mcp/client.py` | One connection per discovery/invocation: `initialize`, `tools/list`, optional `tools/call`, `finally: close()` | No connection reuse; repeated process spawn and init latency; server-side state cannot survive between calls |
| Protocol | Hard-coded `2024-11-05` | No `2025-03-26`/`2025-06-18` negotiation; no Streamable HTTP semantics |
| stdio | `Popen([command, *args])`, stdin/stdout newline JSON, `stderr=DEVNULL`, full `os.environ` inherited | No process-group kill (helpers leak), no stderr/logs, no env scrub, no notification dispatch |
| HTTP | POST per message, captures `Mcp-Session-Id`, parses a whole SSE body | No `MCP-Protocol-Version` header; no GET notification stream; no 404 session-expiry handling; `sse` transport is incorrectly routed to the same POST client instead of the legacy endpoint handshake |
| Registry `mcp_store.py` | Connection per `discover`/`invoke`; loops candidates on invoke | No pooling, cache, health, retry/backoff, concurrency cap, cancellation, status |
| Domain | `McpServerSpec`, `McpServer`, `McpTool(name, description, input_schema)` | No annotations, output schema, resources, prompts, status, logs, approval |
| API `api/routes/mcp.py` | CRUD, enable/disable, discover, `POST /api/tools/invoke` | No status/health, reconnect, logs, resources/prompts, approval; all handlers are synchronous and may block the FastAPI threadpool for up to 30 s |
| Frontend `McpPanel.tsx` | Server CRUD, optimistic enable/disable, last-discovery tool suggestions, one-shot invoke dialog | No live connection state, logs drawer, reconnect, reconnection countdown, approval prompt; `toolCount` is never populated by the backend view |
| Events | `/api/events` carries `artifacts.changed`, `engine.status`, `sessions.changed` | No MCP status/log/tool-change/approval events |
| Engine integration | The MateBot/opencc engine does not consume `mcp_servers` rows; AutoAgent turns expose no MCP tools | The registry is a standalone UI + direct-invoke feature, not an agent tool source |
| Security | Launch-token/cookie auth at the HTTP boundary; env/header values are hidden from DTOs | No tool approval policy, no destructive-tool guard, no command/URL allowlist, secrets stored as plaintext JSON in SQLite, no output size cap |

The architecture document already promises "connection pooling, JSON-RPC
framing, retry policy" in `architecture.md`; the code does not implement it.
This proposal closes that gap.

## 2. Target architecture

```
 SQLite mcp_servers (configuration, secrets)
          │
          ▼
 McpService ────────────── approval policy ────── UI consent
          │                       │
          ▼                       ▼
 McpConnectionManager  (one persistent session per server)
   ├─ tool/resource/prompt cache + list_changed invalidation
   ├─ health loop: ping → backoff reconnect
   ├─ per-server semaphore, timeout, cancellation
   ├─ status + ring-buffer logs + event callbacks
   └─ transports:
        StdioTransport            (argv, scrubbed env, process group kill)
        StreamableHttpTransport   (POST, session id, version, SSE responses, GET notifications)
        LegacySseTransport        (endpoint event + message stream)
          │
          ▼
 EventBus /api/events  →  McpStatusClient / McpStatusPanel
```

Key properties:

- **One owner per server.** The manager holds at most one live transport per
  server. `tools/list` is fetched once and cached; `notifications/tools/list_changed`
  clears the cache and refreshes on a worker thread.
- **Lazy connect, explicit lifecycle.** A server connects on first discovery or
  call, stays connected, and is closed by disable/remove/container shutdown.
- **Failures are observable.** Each server has a state machine
  (`idle → connecting → connected → reconnecting/error → closed`) plus a last
  error, reconnect attempt count, next retry, protocol/server version, session
  id and pid.
- **Calls are never silently retried.** Only idempotent reads (`initialize`,
  `tools/list`, `resources/list`, `resources/read`, `prompts/list`,
  `prompts/get`, `ping`) use the one-retry path. `tools/call` is sent at most
  once because tools may not be idempotent.
- **Policy before I/O.** Destructive/open-world tools are classified from MCP
  annotations before acquiring a concurrency slot.

## 3. API and event contract

Existing endpoints stay wire-compatible. Additions are additive and camelCase.

### 3.1 Status and lifecycle

| Method | Path | Response |
|---|---|---|
| `GET` | `/api/mcp/status` | `{servers: McpServerStatusView[]}` |
| `GET` | `/api/mcp/servers/{name}/status` | `McpServerStatusView` |
| `POST` | `/api/mcp/servers/{name}/reconnect` | `McpServerStatusView` |
| `GET` | `/api/mcp/servers/{name}/logs?limit=200` | `{entries: McpLogView[]}` |
| `POST` | `/api/mcp/servers/{name}/approvals` | `{ok: true}` (or the global route below) |

`McpServerStatusView`:

```json
{
  "name": "github",
  "state": "connected",
  "connected": true,
  "toolCount": 17,
  "resourceCount": 0,
  "promptCount": 0,
  "lastError": null,
  "protocolVersion": "2025-06-18",
  "serverName": "github-mcp",
  "serverVersion": "1.4.0",
  "instructions": "…",
  "sessionId": "…",
  "pid": 4242,
  "reconnectAttempts": 0,
  "nextRetryInMs": null,
  "updatedAt": 1760000000000
}
```

`McpLogView`: `{server, level: "debug"|"info"|"warning"|"error"|"stderr", message, ts}`.
Logs must pass the same redaction as errors; env/header values are never logged.

### 3.2 Tools, resources and prompts

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/api/mcp/servers/{name}/tools?refresh=false` | — | `{tools: McpToolView[]}` |
| `GET` | `/api/mcp/servers/{name}/resources?refresh=false` | — | `{resources: McpResourceView[]}` |
| `POST` | `/api/mcp/servers/{name}/resources/read` | `{uri}` | raw `resources/read` result |
| `GET` | `/api/mcp/servers/{name}/prompts?refresh=false` | — | `{prompts: McpPromptView[]}` |
| `POST` | `/api/mcp/servers/{name}/prompts/get` | `{name, args}` | raw `prompts/get` result |

`McpToolView` extends today's shape with optional `title`, `outputSchema` and
`annotations: {readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`.
The existing `POST /api/mcp/discover` keeps returning the same envelope and
populates it from the manager cache.

### 3.3 Invocation and approval

`POST /api/tools/invoke` keeps `{server?, tool, args}` and adds optional
`approval: {scope: "once"|"session", approvedTools?: string[], approvedServers?: string[]}`
or an opaque `approvalToken`. When the policy returns `ask`, the endpoint
returns `403` with:

```json
{
  "code": "MCP_APPROVAL_REQUIRED",
  "message": "github/create_issue: destructive tool requires explicit approval.",
  "details": {
    "server": "github",
    "tool": "create_issue",
    "risk": "destructive",
    "code": "consent_required",
    "reason": "…",
    "callId": "opaque-correlation-id"
  }
}
```

The UI answers `POST /api/mcp/approvals` with
`{server, tool, decision: "allow"|"deny", scope: "once"|"session", callId?}`.
The application layer stores consent (process/session scoped) and the caller
retries the same invocation. The manager itself is stateless about consent.

New error codes: `MCP_APPROVAL_REQUIRED` (403), `MCP_APPROVAL_DENIED` (403),
`MCP_CAPABILITY_UNAVAILABLE` (400), `MCP_TIMEOUT` (504). Reuse
`MCP_UNAVAILABLE` (502), `MCP_TOOL_NOT_FOUND` (404),
`MCP_SERVER_NOT_FOUND` (404) and `INVALID_INPUT` (400).

### 3.4 Events

Publish through the existing `EventBus` and `/api/events` (SSE event name = type;
the `type` key is stripped by `stream_bus_sse`):

| Event | Data |
|---|---|
| `mcp.status` | `{server, status: McpServerStatusView}` |
| `mcp.log` | `{server, entry: McpLogView}` |
| `mcp.tools_changed` | `{server, tools: McpToolView[]}` |
| `mcp.approval_required` | `{approval: McpApprovalRequestView}` |
| `mcp.server_changed` | `{server}` (CRUD/enable/disable hint) |

The manager already emits the first three. The application service should add
`mcp.approval_required` when it converts `McpApprovalRequired` into a 403, and
`mcp.server_changed` on upsert/delete/toggle.

## 4. Security model

1. **Process execution is the main risk.** A stdio server is arbitrary code.
   AutoAgent must show the exact argv (already does) and obtain explicit
   confirmation before first launch, or enforce a user-maintained command
   allowlist. The manager accepts an argv vector and never uses `shell=True`.
2. **Environment scrub.** Inherit only a small allowlist (`PATH`, `HOME`,
   `LANG`, `LC_*`, `TMPDIR`, `USER`, Windows equivalents). Do not inherit
   loader hooks (`LD_PRELOAD`, `PYTHONPATH`, `NODE_OPTIONS`, `BASH_ENV`, …).
   Explicit per-server `env` is passed through because the user owns it.
3. **Process group kill.** POSIX children start in a new session and are
   terminated with `SIGTERM` then `SIGKILL` on the process group; helper
   processes cannot outlive the server.
4. **Transport validation.** HTTP/SSE URLs must be `http`/`https` with a host.
   User headers are rejected if they contain CR/LF or try to set
   `Content-Type`, `Accept`, `Mcp-Session-Id` or `MCP-Protocol-Version`.
5. **Secrets stay out of observability.** `env` and `headers` are never in
   status, logs, events, errors or DTOs. Error text is collapsed and truncated.
   Current storage is plaintext JSON in SQLite; T2 should move secret values to
   the OS keyring or an encrypted store.
6. **Approval defaults.** No annotations ⇒ `destructive=true`,
   `openWorld=true`, `readOnly=false`. Default policy is `ask`; read-only tools
   are auto-allowed. Deny rules beat allow rules. Consent is exact
   `server/tool` or exact server, never a substring.
7. **SSRF and redirects.** Local MCP servers legitimately target loopback, so a
   blanket private-IP ban is wrong. T1 should add an explicit per-server
   host allowlist for non-loopback URLs, disable automatic redirects (or
   revalidate the redirect target), and cap response size.
8. **Concurrency and abuse.** Per-server bounded concurrency, connect/call
   timeouts and cancellation protect the backend from a hung server. The HTTP
   layer already requires the launch token or cookie. A compromised local
   process can still invoke the API; that is the existing trust boundary.
9. **No OAuth in v1.** Remote OAuth/DCR adds redirect handling, token storage
   and refresh races. Until then, remote servers must be reachable with
   user-supplied static headers, or be fronted by a local proxy.

## 5. opencc `mcpfs`: concepts and boundary

Vendor `opencc/src/services/mcpfs/` (HEAD) is a **projection + sandbox gateway**,
not a backend connection manager:

- `projection.ts` fingerprints opencc's live connections and writes one typed
  binding per tool under `~/.claude/mcp-fs/servers/<server>/`; the directory is
  a function of the connections and is rewritten on connect or
  `tools/list_changed`.
- `gateway.ts` exposes a loopback, per-CodeAct-run token. Sandbox code sends one
  JSON line and the host executes `tools/call`, `resources/list`,
  `resources/read`, `prompts/get` on the connection opencc already holds.
- `approval.ts` scans imports/`callMCPTool("server","tool")` literals, asks once
  per run for non-read-only tools, and the gateway re-decides every call so a
  dynamically named tool cannot slip through.
- `runtime.ts` is the generated stdlib-only sandbox client.
- `schema.ts` maps JSON Schema to typed TypeScript/Python bindings.

What to reuse conceptually: annotation-based risk, exact-reference approval,
tool metadata projection, and the idea that the connection owner is the process
that already holds auth and server-side state.

**Recommendation (boundary):**

- **T0/T1: the AutoAgent backend keeps its own manager.** It is the connection
  owner for UI discovery, status, logs, direct invocation and any future
  non-opencc engine. This is the only way to provide the status/approval API
  without changing opencc.
- **T2: the opencc/MateBot engine remains the owner for model and CodeAct
  calls.** Its MCP clients already live in the engine process and carry the
  server state/auth that turns need. The backend should **synchronize enabled
  server specs into the engine's MCP configuration** (the same source opencc's
  MCP manager reads) and must not open a second competing connection to the same
  server during a run. Backend status in that mode should be fed from engine
  connection events, not from a duplicate manager.
- **Do not forward UI direct-invokes to the mcpfs gateway.** The gateway is
  scoped to one CodeAct run by a random token and is not a control plane; the
  backend is outside that run. Forwarding would require a new engine control
  RPC. If that RPC is added, a single `McpRuntime` port can switch between
  backend-owned and engine-owned connections without changing the API.
- Copying `projection.ts` into AutoAgent would duplicate typed-binding logic
  that belongs to opencc. AutoAgent only needs the metadata (annotations,
  schemas) for approval and UI.

## 6. Integration map

| File | Change | Tier |
|---|---|---|
| `backend/src/autoagent_backend/adapters/mcp/transports.py` | **new**: copy `backend/transports.py` (stdlib only) | T0 |
| `backend/src/autoagent_backend/adapters/mcp/connection_manager.py` | **new**: copy `backend/connection_manager.py`; change imports to relative | T0 |
| `backend/src/autoagent_backend/adapters/mcp/approval.py` | **new**: copy `backend/approval.py` | T0 |
| `backend/src/autoagent_backend/adapters/mcp/client.py` | Deprecate; keep `DefaultMcpConnectionFactory` facades for tests/rollback | T0 |
| `backend/src/autoagent_backend/adapters/mcp/mcp_store.py` | Split persistence from runtime; become `SqliteMcpRepository` + delegate to manager | T0 |
| `backend/src/autoagent_backend/domain/models.py` | Add tool annotations/output schema, status, log, resource, prompt, approval values | T0/T1 |
| `backend/src/autoagent_backend/domain/ports.py` | `McpRegistryPort` gains `status`, `reconnect`, `logs`, `list_resources`, `read_resource`, `list_prompts`, `get_prompt`, approval-aware `invoke` | T0/T1 |
| `backend/src/autoagent_backend/domain/errors.py` | Add `McpApprovalRequired`, `McpApprovalDenied`, `McpCapabilityUnavailable`, `McpTimeout` | T0 |
| `backend/src/autoagent_backend/application/mcp_service.py` | Status/log/reconnect/resources/prompts/approval use cases; map events | T0/T1 |
| `backend/src/autoagent_backend/api/routes/mcp.py` | New routes from §3; create/cancel call ids if supporting cancellation | T0/T1 |
| `backend/src/autoagent_backend/api/schemas.py` | Add views/converters; keep existing `McpServerView` fields | T0 |
| `backend/src/autoagent_backend/api/routes/events.py` | No change; the app service publishes MCP payloads to `EventBus` | T0 |
| `backend/src/autoagent_backend/composition.py` | Construct manager, register persisted specs, inject into service, append `manager.shutdown` to closers | T0 |
| `backend/src/autoagent_backend/config.py` | Optional `AUTOAGENT_MCP_PERSISTENT` / health interval / policy defaults | T0/T1 |
| `frontend/src/features/mcp/mcpStatusClient.ts` | Copy reference client | T0 |
| `frontend/src/features/mcp/McpStatusPanel.tsx` | Copy reference panel; render inside `McpPanel` | T0 |
| `frontend/src/features/mcp/McpPanel.tsx` | Add status panel, approval retry path, tool metadata badges | T0/T1 |
| `frontend/src/features/mcp/logic.ts` | Add risk labels and approval helpers | T1 |
| `frontend/src/api/types.ts`, `client.ts`, `events.ts` | Re-export status types; invalidate `["mcp"]` on `mcp.*` events | T0/T1 |
| `backend/tests/unit/test_mcp_manager.py` | Copy `backend/test_mcp_manager.py`; add FastAPI contract tests | T0 |
| Engine config sync (`adapters/engine/*` or config writer) | Mirror enabled specs into opencc's MCP config for turn/CodeAct use | T2 |

CSP changes are **not** required: this design has no embedded frame, no MCP App
UI resource and no remote content document.

## 7. Phases and acceptance

### T0 — persistent sessions and observability (1–2 days)

Scope: transports, manager, approval engine, composition wiring, status/log/
reconnect routes, frontend status panel, tests.

Acceptance:

- Two consecutive `POST /api/tools/invoke` calls on one stdio server use one
  child process (test asserts one pid/one instance).
- A stdio server killed mid-call yields `MCP_UNAVAILABLE`; the next call
  reconnects and succeeds; status exposes `attempt` and `lastError`.
- Streamable HTTP sends `Mcp-Session-Id` and `MCP-Protocol-Version` after
  `initialize`, parses both JSON and SSE responses, and reconnects on 404
  session expiry.
- `tools/list` is fetched once; `notifications/tools/list_changed` invalidates
  and refreshes it.
- Destructive tool without consent returns 403 `MCP_APPROVAL_REQUIRED`; approval
  + retry succeeds; deny rule returns `MCP_APPROVAL_DENIED`.
- Timeout and cancellation leave the session usable; `notifications/cancelled`
  is sent.
- Resources/prompts list/read/get work over all three transports.
- `pytest`, `ruff`, `mypy --strict` and `tsc --noEmit` pass (see
  `VERIFICATION.md`).

### T1 — UX, policy and hardening (2–3 days)

Scope: logs drawer over SSE, approval persistence, resources/prompts UI,
output/response caps, redirect/SSRF policy, secret storage, background health
loop enabled by default, richer tool badges.

Acceptance: health loop flips a killed server to `error`, reconnects within the
backoff window, and emits state transitions; every approval decision is
auditable; no secret value appears in logs/events/DTOs; a 10 MB tool response is
rejected or truncated by policy rather than buffered unboundedly.

### T2 — engine and opencc integration (3–5 days)

Scope: sync enabled specs to the engine MCP configuration; one connection owner
per server; if opencc exposes a control RPC, add `EngineMcpRuntime`; map engine
connection state into the same status event contract; optional OAuth.

Acceptance: a turn can call a registered MCP tool and CodeAct can import its
mcpfs projection; only one process/session exists per server; disabling a server
revokes it for the next turn; backend status matches engine state.

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Callback re-entrancy deadlock | Request times out while the reader is blocked | Separate `connect_lock`, cache lock and `log_lock`; notification handling on a worker thread (found and fixed in this reference) |
| Blocking FastAPI | Sync routes occupy the threadpool for up to 30 s | Keep manager calls in sync handlers (threadpool) or make routes async and run manager work in `anyio.to_thread`; never hold the app loop |
| Orphan stdio children | Resource leak | Process group kill + container shutdown hook + tests |
| Session expiry races | Duplicate calls | Retry only idempotent reads; surface 404 as reconnect and let the caller retry non-idempotent calls |
| Two connection owners | Divergent state/auth, duplicate server processes | T0/T1 backend-only; T2 explicitly hands ownership to the engine and syncs config |
| SQLite plaintext secrets | Local credential exposure | T2 keyring/encrypted store; keep secrets out of DTOs now |
| Legacy SSE implementation drift | Server compatibility | Keep it capability-gated and tested; prefer Streamable HTTP when the URL supports it |
| opencc API changes | Duplicated logic | Isolate behind `McpRuntime`; only depend on mcpfs metadata/approval concepts, not its internals |
| Tool output size | Memory exhaustion | Add `max_result_bytes` in T1; MCP has no universal limit |

## 9. What not to copy from Claude Desktop (v1)

- **DXT** extension packaging, signing, installation and permission manifests.
- **MCP Apps / UI resources**: iframe sandbox, CSP nonce/frame tokens, UI
  resource bridge. AutoAgent artifacts already have their own model; MCP Apps
  would require a separate security review.
- **Full OAuth/DCR/token refresh** and remote `claude.ai` proxy transports.
- **WebSocket transport**, XAA/identity-provider flows, elicitation, sampling
  and roots.
- Claude Desktop's large reconnect/analytics state machine. The reference
  manager is deliberately small, framework-free and testable with stdlib fakes.

## 10. Verification

Commands and exact results are recorded in `VERIFICATION.md`. The reference
suite is self-contained and does not import AutoAgent, FastAPI or Pydantic.
