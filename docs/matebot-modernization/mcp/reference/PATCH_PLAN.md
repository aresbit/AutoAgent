# PATCH_PLAN — AutoAgent MCP persistent runtime

This is an application plan, not an applied patch. Nothing under
`/home/tars/yysapp/AutoAgent` was modified. The reference sources live in this
directory and pass their own checks (see `VERIFICATION.md`).

## 0. Decision summary

1. Replace the short-lived `DefaultMcpConnectionFactory` usage in
   `SqliteMcpRegistry` with a `ManagedMcpRegistry` that keeps one
   `McpConnectionManager` session per server.
2. Keep HTTP contracts additive. Existing CRUD/discover/invoke payloads keep
   working; status/log/reconnect/resources/prompts/approval routes are new.
3. Introduce policy decisions before every `tools/call`, defaulting to `ask`
   for destructive and open-world tools.
4. Do not copy opencc `mcpfs` into the backend. Keep the backend manager for
   UI/direct calls (T0/T1); in T2 make opencc the single connection owner for
   engine turns and mirror enabled specs into its MCP configuration.
5. No CSP work. No DXT, MCP Apps, OAuth/DCR, WebSocket or elicitation in v1.

## 1. Files to add (exact destination paths)

| Destination | Source | Notes |
|---|---|---|
| `backend/src/autoagent_backend/adapters/mcp/transports.py` | `backend/transports.py` | stdlib only; no changes needed except optional project logging |
| `backend/src/autoagent_backend/adapters/mcp/connection_manager.py` | `backend/connection_manager.py` | change `from approval import …` / `from transports import …` to `from .approval import …` / `from .transports import …` |
| `backend/src/autoagent_backend/adapters/mcp/approval.py` | `backend/approval.py` | no imports outside stdlib |
| `backend/src/autoagent_backend/adapters/mcp/managed_registry.py` | new adapter | implements `McpRegistryPort`; owns SQLite reads/writes + manager |
| `backend/tests/unit/test_mcp_manager.py` | `backend/test_mcp_manager.py` | adjust imports to the package path |
| `backend/tests/integration/test_mcp_runtime.py` | new | FastAPI contract coverage for §3 routes |
| `frontend/src/features/mcp/mcpStatusClient.ts` | `frontend/mcpStatusClient.ts` | reference client |
| `frontend/src/features/mcp/McpStatusPanel.tsx` | `frontend/McpStatusPanel.tsx` | reference panel |

## 2. Files to modify

### 2.1 Domain

`backend/src/autoagent_backend/domain/models.py`

- Extend `McpTool` with `title`, `output_schema`, `annotations`
  (`ToolAnnotations` value object) while preserving the existing three fields.
- Add frozen value objects: `McpServerStatus`, `McpLogEntry`, `McpResource`,
  `McpPrompt`, `McpPromptArgument`, `McpToolResult`, `McpApprovalRequest`,
  `McpApprovalDecision`.
- Keep `McpDiscovery` wire-compatible; map manager status to it.

`backend/src/autoagent_backend/domain/ports.py`

- Extend `McpRegistryPort`:

```python
class McpRegistryPort(Protocol):
    def list(self) -> Sequence[McpServer]: ...
    def upsert(...) -> McpServer: ...
    def remove(self, name: str) -> None: ...
    def set_enabled(self, name: str, enabled: bool) -> McpServer: ...
    def discover(...) -> Sequence[McpDiscovery]: ...
    def invoke(..., approval: ApprovalContext | None = None) -> McpInvocationResult: ...
    def status(self, name: str | None = None) -> Sequence[McpServerStatus]: ...
    def reconnect(self, name: str) -> McpServerStatus: ...
    def logs(self, name: str, limit: int) -> Sequence[McpLogEntry]: ...
    def list_resources(self, name: str) -> Sequence[McpResource]: ...
    def read_resource(self, name: str, uri: str) -> Mapping[str, object]: ...
    def list_prompts(self, name: str) -> Sequence[McpPrompt]: ...
    def get_prompt(self, name: str, prompt: str, args: Mapping[str, str]) -> Mapping[str, object]: ...
```

Preconditions/postconditions: names follow `_validate_name`; disabled servers
raise `McpUnavailable`; connection details, argv, env and headers never cross
the port.

`backend/src/autoagent_backend/domain/errors.py`

```python
class McpApprovalRequired(Forbidden):
    code = "MCP_APPROVAL_REQUIRED"
    # attach decision details in the service/renderer, not in the message

class McpApprovalDenied(Forbidden):
    code = "MCP_APPROVAL_DENIED"

class McpCapabilityUnavailable(InvalidInput):
    code = "MCP_CAPABILITY_UNAVAILABLE"

class McpTimeout(McpUnavailable):
    code = "MCP_TIMEOUT"
    status_code = 504
```

### 2.2 Adapter / persistence

`backend/src/autoagent_backend/adapters/mcp/mcp_store.py`

Option A (recommended, low risk): keep `SqliteMcpRegistry` as the persistence
and public port implementation, and replace its `_connections` usage:

- Rename the class to `ManagedMcpRegistry` (or keep the name and add a runtime
  dependency).
- `discover(name)` calls `manager.list_tools(name)` / `manager.connect(name)`.
- `invoke(...)` calls `manager.call_tool(name, tool, args, approval=context)`.
- `upsert/remove/set_enabled` also call `manager.register/unregister/set_enabled`
  so config and runtime never drift.
- Boot: construct manager, iterate persisted rows, `manager.register(spec,
  enabled=row.enabled)`.

Option B (cleaner separation): `SqliteMcpRepository` for rows and
`ManagedMcpRegistry` for the port. Do this if the team wants to delete the
connection factory outright.

`backend/src/autoagent_backend/adapters/mcp/client.py`

- Mark deprecated. Keep the module and `DefaultMcpConnectionFactory` for the
  feature flag and existing tests.
- Do not delete until T2 because `tests/fixtures/panels.py` injects the factory.

### 2.3 Application

`backend/src/autoagent_backend/application/mcp_service.py`

- Add use cases mirroring §3: status, reconnect, logs, tools, resources, prompts,
  approval decision.
- Translate manager exceptions:
  - `McpApprovalRequired` → domain `McpApprovalRequired` with decision details.
  - `McpApprovalDenied` → domain `McpApprovalDenied`.
  - `McpUnavailable` → domain `McpUnavailable`.
  - `McpTimeout` → domain `McpTimeout`.
- On `McpApprovalRequired`, publish `mcp.approval_required` (with a call id) to
  the event bus before raising.
- Maintain consent for `scope="once"` / `"session"` in process memory keyed by
  server/tool. Never persist consent across restarts in v1.
- On CRUD/toggle success, publish `mcp.server_changed`.

`backend/src/autoagent_backend/application/bootstrap_service.py`

- If the bootstrap read model includes MCP servers, it can keep reading the
  registry; status is separate and should not block boot.

### 2.4 API

`backend/src/autoagent_backend/api/schemas.py`

- Add `McpServerStatusView`, `McpLogView`, `McpResourceView`, `McpPromptView`,
  `McpApprovalDecisionInput`, `McpApprovalRequiredDetails`.
- Extend `McpToolView` with optional `title`, `outputSchema`, `annotations`.
- Converters must drop pid/session id only if the product decides those are too
  sensitive; the reference UI uses them, and they contain no argv/env.

`backend/src/autoagent_backend/api/routes/mcp.py`

Add routes from README §3. Keep the existing routes and response envelopes.
Important FastAPI details:

- Sync handlers are acceptable because the manager blocks; FastAPI runs them in
  the threadpool. Alternatively make them `async def` and wrap every manager
  call in `await anyio.to_thread.run_sync(...)`; never call the manager directly
  on the event loop.
- `GET /api/mcp/status` must not connect servers; it returns the last known
  state. `POST /api/mcp/servers/{name}/reconnect` is the explicit connect.
- Bound `limit` for logs (default 200, max 1000).
- Return 403 with `details` for `MCP_APPROVAL_REQUIRED`.

### 2.5 Composition

`backend/src/autoagent_backend/composition.py`

```python
from .adapters.mcp.approval import ApprovalEngine, ServerApprovalPolicy
from .adapters.mcp.connection_manager import McpConnectionManager

# after migrate() and before Container construction:
mcp_runtime = McpConnectionManager(
    approval_engine=ApprovalEngine(
        default_policy=ServerApprovalPolicy(mode="ask", allow_read_only=True)
    ),
    event_callback=event_bus.publish,
)
mcp_registry = SqliteMcpRegistry(
    db, clock, runtime=mcp_runtime, connections=mcp_connections  # factory = rollback
)
for server in mcp_registry.list():
    mcp_runtime.register(server.spec, enabled=server.enabled)
mcp_runtime.start_background(interval=30.0)
container.closers.append(mcp_runtime.shutdown)
```

`Container` should expose `mcp_runtime` (or only the port) for tests. The
registry must not register specs twice.

### 2.6 Frontend

`frontend/src/api/types.ts`

- Add `McpServerStatus`, `McpLogEntry`, `McpToolStatus`, approval types and the
  event union. Reuse camelCase field names from README §3.

`frontend/src/api/client.ts`

- Add methods:
  - `mcpStatus(): Promise<McpServerStatus[]>`
  - `mcpServerStatus(name)`
  - `reconnectMcpServer(name)`
  - `mcpLogs(name, limit)`
  - `readMcpResource(name, uri)`
  - `getMcpPrompt(name, prompt, args)`
  - `decideMcpApproval(input)`
- Keep existing methods unchanged.

`frontend/src/api/events.ts`

- On `mcp.status`, `mcp.tools_changed`, `mcp.server_changed`, invalidate
  `["mcp"]` and `["mcp-status"]`.

`frontend/src/features/mcp/mcpStatusClient.ts`

- Copy the reference client. It already parses `unknown`, uses authenticated
  fetch SSE, handles backoff and exposes typed events.

`frontend/src/features/mcp/McpStatusPanel.tsx`

- Copy the reference panel and render it inside `McpPanel` below the server
  list:

```tsx
const statusClient = useMemo(
  () => new McpStatusClient({ getToken: getLaunchToken }),
  [],
);

<McpStatusPanel
  client={statusClient}
  initialStatuses={serversQuery.data?.map(toStatusSeed) ?? []}
/>
```

- The panel is read-only with respect to server CRUD; it owns reconnect, logs
  and approval.
- To wire approval into the invoke dialog, catch `MCP_APPROVAL_REQUIRED` on
  `api.invokeTool`, store `details`, show the prompt, call
  `decideMcpApproval`, then retry the same invocation with
  `approval: {scope}`.

`frontend/src/features/mcp/logic.ts`

- Add `riskLabel(risk)` and `isMutableTool(tool)` helpers.

### 2.7 Tests

- Copy `backend/test_mcp_manager.py` to `backend/tests/unit/` and change imports
  to `autoagent_backend.adapters.mcp.*`.
- Add integration tests using the existing `panel_client` fixture with a fake
  runtime:
  - status/log/reconnect shapes and auth;
  - approve-and-retry flow (403 → approval → 200);
  - disabled server rejects invoke;
  - capability error for a server without resources;
  - `/api/events` emits `mcp.status` and `mcp.approval_required`.
- Add a frontend test for `parseServerStatus` on malformed input and for
  approval event parsing (Vitest).

## 3. Migration from short-lived connections

1. **Land the manager behind a flag.** `AUTOAGENT_MCP_PERSISTENT` (default `1`
   after T0 bake time; `0` selects `DefaultMcpConnectionFactory`). The registry
   accepts either `runtime` or `connections`.
2. **Boot registration.** After migrations, read persisted rows and register
   them in the manager. Do not connect during boot; `list()` must stay fast.
3. **Switch discovery.** `discover()` uses cached tools; `refresh=true` or the
   existing discover button forces `tools/list`.
4. **Switch invoke.** `invoke()` uses `call_tool`; the old candidate-loop remains
   only in the rollback path.
5. **Lifecycle.** Append `mcp_runtime.shutdown` to `Container.closers`; verify
   no child processes remain after `TestClient` exit.
6. **Delete the old path** after T1. Keep `client.py` one release as a facade.

Rollback:

- Set `AUTOAGENT_MCP_PERSISTENT=0`; the registry constructs
  `DefaultMcpConnectionFactory` and previous behavior returns without a data
  migration.
- The manager creates no new tables; SQLite schema is unchanged.
- The new API routes can stay: they report `state="idle"`/`connected` from a
  one-shot discovery or return 501 if the runtime is absent.

## 4. Tiers and acceptance

### T0 — persistent sessions, status, policy (must ship together)

Files: transports, manager, approval, managed registry, service/routes/schemas,
composition, status client/panel, tests.

Acceptance:

- [ ] One child process per stdio server across repeated invokes.
- [ ] Killed server → `MCP_UNAVAILABLE`; next call reconnects; status shows the
      attempt and last error.
- [ ] Streamable HTTP sends session/version headers and parses SSE responses.
- [ ] Legacy `sse` uses the endpoint handshake, not POST-to-SSE-URL.
- [ ] `tools/list` cache hit; `list_changed` invalidates and refreshes.
- [ ] Destructive tool returns 403 `MCP_APPROVAL_REQUIRED`; allow once/session
      works; deny/global rule returns `MCP_APPROVAL_DENIED`.
- [ ] Timeout/cancel leave the session usable; cancellation notification sent.
- [ ] Resources/prompts work; capability errors are explicit.
- [ ] `ruff`, `mypy --strict`, `pytest`, `tsc --noEmit` pass.

### T1 — UX and hardening

- Logs drawer receives live `mcp.log` events; logs are capped and redacted.
- Health loop enabled; backoff visible in the UI.
- Approval persistence (process/session), audit of decisions.
- Result-size cap, redirect/SSRF policy, secret storage via keyring.
- Resource/prompt browser (optional; API is ready).

Acceptance: kill/restart under load shows no leaked processes; no secret in
logs/events/DTOs; 10 MB result does not exhaust memory; all T0 tests still pass.

### T2 — engine/opencc ownership

- Mirror enabled specs into the engine MCP configuration for turns/CodeAct.
- Add `EngineMcpRuntime` if/when opencc exposes a control channel; map engine
  connection events into the same `mcp.status` shape.
- Ensure one owner per server (no duplicate stdio children).
- Optional OAuth for remote servers (only if a product requirement appears).

Acceptance: a turn invokes a registered MCP tool; CodeAct imports the mcpfs
projection; exactly one connection exists per server; disable takes effect on
the next turn; backend status matches engine state.

## 5. Consuming opencc `mcpfs` — exact boundary

**Keep the backend manager for T0/T1; make opencc the owner for engine calls in
T2.** Do not forward backend direct invokes to the mcpfs gateway.

- `mcpfs/gateway.ts` is a per-CodeAct-run loopback service authenticated by a
  random token in the sandbox environment. It is not reachable as a general
  backend control plane, and a backend connection would create a second
  connection to the same server.
- `mcpfs/projection.ts` is a materialized view of opencc's live connections.
  Copying it would duplicate code and tax the projection for backend UI needs.
- What the backend should consume:
  1. the same MCP server configuration source the engine reads (sync enabled
     specs);
  2. engine connection state/tool metadata, if opencc exposes it, mapped to
     `McpServerStatus` / `McpToolView`;
  3. the annotation and exact-reference approval semantics (already
     reimplemented in `backend/approval.py`).
- What the backend should expose to opencc: the persisted server specs and
  policy choices. The engine remains the process that owns auth, server-side
  state and per-run tokens.

## 6. What NOT to copy from Claude Desktop (v1)

- DXT packaging/signing/installation and permission manifests.
- MCP Apps / UI resources (iframe + CSP nonce + bridge).
- Full OAuth/DCR/token refresh, `claude.ai` proxy transports, XAA identity.
- WebSocket transport, elicitation, sampling, roots.
- The large analytics/telemetry and reconnect state machine; the reference
  manager is intentionally small and stdlib-only.
- Desktop-specific `~/.claude.json` config precedence. AutoAgent keeps its
  SQLite registry as the user-facing source until T2 decides otherwise.

## 7. Risks and owner actions

| Risk | Owner action |
|---|---|
| Deadlock between connect lock, log callback and reader thread | Keep the three-lock split in the reference (`connect_lock`, `lock`, `log_lock`); never call user callbacks while holding a lock that the reader needs |
| FastAPI thread exhaustion | Use the threadpool intentionally or `anyio.to_thread`; do not make blocking calls on the event loop |
| Orphan children | Close-on-container-shutdown, process-group kill, integration test that inspects `ps` |
| Session expiry on non-idempotent calls | Never auto-retry `tools/call`; return a clear retryable error and let the UI re-prompt |
| Two owners after T2 | Config sync plus a single runtime selector; assert one pid per server in integration tests |
| Secret leakage | Keyring in T1; redact values in logs/events; test with a sentinel token |
| opencc drift | Depend on mcpfs concepts, not internals; isolate engine RPC behind a port |
