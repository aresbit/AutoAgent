# AutoAgent / MateBot API Contract v1

Status: proposal, revised for the **deep interface (deep module)** architecture
constraint. Frozen for parallel backend + frontend implementation.

Companion docs: `legacy-inventory.md` (source evidence) and `maxwire-model.md`
(reference patterns).

Architecture rule, adopted from the user and from
`software-design-skill/references/ch05_抽象数据类型.md`:

> The SPA sees only a narrow, stable, intention-revealing public surface. The
> implementation — SQLite schema, opencc/Claude CLI argv, flag probing, retries,
> resume logic, subprocess lifecycle and raw stream-json frames — is hidden behind
> ports and DTOs. **No representation may leak across the HTTP boundary.**

Consequences that override earlier drafts:

- There is **no one-endpoint-per-IPC-channel mapping**. Many legacy channels
  collapse into one domain operation and one endpoint.
- The SPA never sees `claudeCommand`, `claudeConfigDir`, `extraCliArgs`,
  `sessionId`, `forkSession`, `resumeSessionAt`, `noSessionPersistence`, SQL rows,
  PIDs, signals, or raw CLI events.
- Session/turn commands are expressed as intentions (`start a turn`,
  `enable a skill`), not mechanisms (`spawn`, `UPDATE tool SET …`).

---

## 1. Layering (DIP + pure services)

```
┌──────────────────────────────────────────────────────────────────────┐
│ HTTP adapter (FastAPI/Starlette, thin)                               │
│   Pydantic request/response DTOs · routing · status mapping · SSE     │
│   NO business logic, NO SQL, NO subprocess calls                     │
├──────────────────────────────────────────────────────────────────────┤
│ Application services (pure, synchronous, unit-testable)              │
│   BootstrapService · SessionService · TurnService · SettingsService   │
│   SkillService · McpService · ArtifactService · WorkspaceService      │
├──────────────────────────────────────────────────────────────────────┤
│ Ports (typing.Protocol) — the dependency-inversion seam               │
│   EnginePort · SessionStorePort · SettingsPort · WorkspacePort        │
│   MateBotPort · (SkillCatalogPort · McpRegistryPort · ArtifactStorePort)│
├──────────────────────────────────────────────────────────────────────┤
│ Infrastructure adapters                                             │
│   SqliteSessionStore · JsonSettingsStore · GitWorkspace                │
│   SubprocessEngine / MateBotEngine · FilesystemSkillCatalog            │
│   SqliteMcpRegistry · FilesystemArtifactStore                          │
├──────────────────────────────────────────────────────────────────────┤
│ Transports / OS                                                      │
│   child_process · stream-json · SQLite · git · filesystem · MateBot   │
└──────────────────────────────────────────────────────────────────────┘
```

Why this shape:

| Principle | Source | Applied here |
|---|---|---|
| Dependency Inversion: high-level and low-level modules both depend on abstractions | `ch08_设计模式.md:53-71` | `TurnService` depends on `EnginePort`, not on subprocess/stream-json. |
| Composition over inheritance | `ch08_设计模式.md:73-83` | Services hold ports; adapters are injected at the composition root. |
| Adapter translates incompatible interfaces | `ch08_设计模式.md:417-457` | `MateBotEngine` adapts the MateBot coordinator protocol to `EnginePort`. |
| Four-layer web architecture: domain / interface / infrastructure / presentation | `ch09_Python_Web应用开发.md:255-262` | The HTTP layer only parses, delegates and serializes. |
| Specification as types; DTOs at the boundary | `ch09_Python_Web应用开发.md:95-105`, `159-192`, `323-373` | Pydantic request/response models; explicit `to_view()` conversion. |
| ADT: clients depend on the abstract layer, never the representation | `ch05_抽象数据类型.md:14`, `151-188` | DTOs are the abstract value space; DB/CLI/stream-json are the hidden representation. |
| No representation exposure | `ch05_抽象数据类型.md:343-412` | Frozen DTOs / copies; no internal paths, rows or frames. |
| Immutable value objects | `ch05_抽象数据类型.md:258-326` | Domain dataclasses are `frozen=True, slots=True`. |
| Domain exception → HTTP exception in one mapping point | `ch09_Python_Web应用开发.md:194-255` | One exception mapper; handlers never stringify tracebacks. |

---

## 2. Ports (`typing.Protocol`)

Ports are deliberately small. Each docstring is the specification (pre/post
conditions and raised domain errors). They are **not** HTTP resources and their
methods are **not** endpoints.

### 2.1 Shared value objects

```python
from dataclasses import dataclass
from typing import Literal, Protocol, Iterator, Sequence


@dataclass(frozen=True, slots=True)
class StartTurnRequest:
    turn_id: str
    session_id: str
    text: str
    settings: "Settings"          # already normalized; never raw argv


@dataclass(frozen=True, slots=True)
class TurnHandle:
    turn_id: str
    session_id: str
    engine_session_ref: str | None   # opaque; NEVER the CLI --resume value


@dataclass(frozen=True, slots=True)
class TurnResult:
    text: str
    stop_reason: Literal["end_turn", "max_turns", "cancelled"]
```

`engine_session_ref` is intentionally opaque. The service uses it; the SPA never
sees it and never passes it back.

### 2.2 `EnginePort`

```python
class EnginePort(Protocol):
    """Start, stream, cancel and inspect agent turns.

    The implementation owns CLI resolution, flag probing, spawn, stdin/stdout
    protocol, retries, timeouts, session resume and kill escalation.

    Post: start_turn returns a handle whose turn_id equals request.turn_id or
          raises EngineUnavailable; it never partially starts.
    Post: stream yields DomainEvent values and terminates with exactly one of
          TurnCompleted or TurnFailed.
    Post: cancel is idempotent; after it returns, stream terminates with
          TurnCompleted(stop_reason="cancelled") within the cancel deadline.
    """

    def start_turn(self, request: StartTurnRequest) -> TurnHandle: ...
    def stream(self, handle: TurnHandle) -> Iterator["DomainEvent"]: ...
    def cancel(self, handle: TurnHandle) -> None: ...
    def status(self) -> "EngineStatus": ...
```

Hidden by this port: command tokenization, Windows `.cmd` wrapping, `--help` flag
probing, argv construction, environment variables, `--resume`/`--continue`/
`--fork-session`, transcript persistence heuristics, `SIGINT`→`SIGTERM`→`SIGKILL`,
process-close handling and stream-json parsing. These exist today in
`engine-client.ts:38-156`, `390-507` and `main.ts:1859-1948`.

### 2.3 `SessionStorePort`

```python
class SessionStorePort(Protocol):
    """Persistent conversation sessions and their messages.

    All methods return immutable domain objects, never rows or mutable lists.
    Raises SessionNotFound.
    """

    def list(self, limit: int | None = None) -> Sequence["Session"]: ...
    def get(self, session_id: str) -> "Session": ...
    def create(self, title: str | None = None) -> "Session": ...
    def rename(self, session_id: str, title: str) -> "Session": ...
    def delete(self, session_id: str) -> None: ...
    def branch(self, session_id: str, title: str | None = None) -> "Session": ...
    def append_message(self, session_id: str, message: "NewMessage") -> "Message": ...
    def record_turn(self, session_id: str, result: TurnResult) -> "Message": ...
```

Hidden: JSON files vs SQLite, table/column names, transaction boundaries, WAL,
migration versions, message ordering implementation. Current sources:
`main.ts:979-1028` (JSON) and `main.ts:1304-1461` (SQLite DDL).

### 2.4 `SettingsPort`

```python
class SettingsPort(Protocol):
    """Read/update the user-visible settings aggregate.

    read() returns a fully normalized Settings value. The port owns defaults,
    provider resolution, credential storage, .claude.json synchronization and
    unknown-field preservation. Raises InvalidSettings.
    """

    def read(self) -> "Settings": ...
    def update(self, patch: "SettingsPatch") -> "Settings": ...
    def provider(self, provider_id: str) -> "ProviderResolution": ...
```

Hidden: `settings.json` layout, `local-settings.json`, `.claude.json` writes
(`main.ts:2126-2162`), API-key normalization, `claudeCommand` recomputation
(`main.ts:938-941`), advanced CLI options.

### 2.5 `WorkspacePort`

```python
class WorkspacePort(Protocol):
    """Workspace inspection and git operations.

    work_dir=None means the configured workspace. All methods are read-only
    except switch_branch/init. Raises WorkspaceUnavailable.
    """

    def status(self, work_dir: str | None = None) -> "WorkspaceStatus": ...
    def diff(self, path: str, work_dir: str | None = None) -> "FileDiff": ...
    def switch_branch(self, branch: str, work_dir: str | None = None) -> None: ...
    def init(self, work_dir: str | None = None) -> None: ...
```

Hidden: git subprocess invocation, timeout policy, `--name-status`/`--numstat`
parsing, `HEAD:` reads, error aggregation. Current source:
`src/chatwise/git.ts:19-171`.

### 2.6 `MateBotPort`

`MateBotPort` is the **infrastructure seam** for the MateBot coordinator
(`opencc --matebot` / remote backend per T6). `MateBotEngine` implements this port
*and* `EnginePort`; the application layer only knows `EnginePort`. This is the
Adapter pattern applied deliberately: a separate abstraction is needed only
because the coordinator protocol (long-lived process, its own session and event
framing) differs from our domain language.

```python
class MateBotPort(Protocol):
    """Transport-level connection to the MateBot coordinator.

    Owns connection lifetime, framing, reconnection and heartbeats.
    It speaks coordinator messages; it does not expose them upward.
    """

    def connect(self) -> None: ...
    def start_turn(self, request: StartTurnRequest) -> TurnHandle: ...
    def stream(self, handle: TurnHandle) -> Iterator["CoordinatorEvent"]: ...
    def cancel(self, handle: TurnHandle) -> None: ...
    def status(self) -> "MateBotStatus": ...
    def close(self) -> None: ...
```

`MateBotEngine` translates `CoordinatorEvent` → `DomainEvent`. The SPA never sees
coordinator frames, session ids, socket URLs or process state.

### 2.7 Ancillary ports

The same discipline applies to the remaining domains; these may be added when the
corresponding v1.1 feature lands:

- `SkillCatalogPort` — scan, enable, disable; hides skill directory moves into
  `.disabled` (`main.ts:2408-2441`).
- `McpRegistryPort` — list/upsert/remove/discover/call; hides the `tool` table and
  MCP client lifecycle (`main.ts:1490-1744`).
- `ArtifactStorePort` — create/list/read/content/export/import; hides
  `manifest.json`, version files and zip implementation (`main.ts:395-748`).

### 2.8 Application services

| Service | Depends on | Responsibility |
|---|---|---|
| `BootstrapService` | Settings, SessionStore, McpRegistry, ArtifactStore, Engine | Assemble the single startup read model. |
| `SessionService` | SessionStore | CRUD and branching intentions. |
| `TurnService` | SessionStore, Engine, Settings, Workspace | One turn: append user message → delegate stream → persist result → materialize artifacts. |
| `SettingsService` | Settings, providers | Whole-aggregate read/update. |
| `SkillService` | Settings, SkillCatalog | Catalog + enable/disable. |
| `McpService` | McpRegistry, Tools | Server CRUD + discovery + invocation. |
| `ArtifactService` | ArtifactStore | Artifact lifecycle. |
| `WorkspaceService` | Workspace | Status/diff/branch/init. |

Services are plain classes with constructor injection; they do not import
FastAPI, SQLite, subprocess or Pydantic. Tests inject fakes. This follows
`ch09_Python_Web应用开发.md:341-373` (composition root + `Depends`) and
`ch08_设计模式.md:53-71` (DIP).

---

## 3. Boundary DTOs

DTOs are the **abstract value space** the SPA is allowed to depend on
(`ch05_抽象数据类型.md:26-35`). They are versioned by the URL prefix (`/api`) and
by additive evolution only.

### 3.1 Public DTOs

```python
class SettingsView(BaseModel):
    providerId: str
    model: str
    fallbackModel: str | None
    baseURL: str | None
    apiKeyConfigured: bool          # never the key itself
    cwd: str
    permissionMode: Literal["default", "acceptEdits", "auto", "bypassPermissions"]
    thinkingMode: Literal["", "adaptive", "enabled", "disabled"]
    effort: Literal["", "low", "medium", "high", "max"]
    maxThinkingTokens: int | None
    maxTurns: int
    maxBudgetUsd: float | None
    taskBudget: float | None
    allowedTools: list[str]
    disallowedTools: list[str]
    addDirs: list[str]
    appendSystemPrompt: str
    layout: LayoutView             # sidebar open/width, right panel open/width
    engine: EngineProfileView      # preset/version only

class EngineProfileView(BaseModel):
    preset: Literal["bundled", "custom"]     # no command line
    version: str | None

class SessionSummary(BaseModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int
    messageCount: int
    lastMessagePreview: str | None

class MessageView(BaseModel):
    id: str
    role: Literal["user", "assistant", "system", "tool"]
    text: str
    createdAt: int
    meta: dict[str, Any] | None   # domain metadata only

class SessionView(BaseModel):
    id: str
    title: str
    createdAt: int
    updatedAt: int
    messages: list[MessageView]

class TurnRequest(BaseModel):
    sessionId: str
    text: str = Field(min_length=1, max_length=100_000)
    # optional per-turn overrides of the safe SettingsView subset only
    overrides: SettingsPatch | None = None

class EngineStatusView(BaseModel):
    state: Literal["idle", "starting", "busy", "error"]
    mode: Literal["local", "matebot"]
    activeTurns: int
    version: str | None
    lastError: str | None          # sanitized, no argv/traceback

class McpServerView(BaseModel):
    id: str
    name: str
    transport: Literal["stdio", "http", "sse"]
    target: str                    # command summary or URL, never env values
    enabled: bool
    autoRun: bool
    toolCount: int | None

class SkillView(BaseModel):
    name: str
    description: str
    source: Literal["system", "project"]
    enabled: bool

class ArtifactView(BaseModel):
    id: str
    title: str
    description: str
    createdAt: int
    updatedAt: int
    lastOpenedAt: int | None
    versions: list[int]            # timestamps only
    contentUrl: str                # /api/artifacts/{id}/content
    thumbnailUrl: str | None

class WorkspaceStatusView(BaseModel):
    workDir: str
    isGitRepo: bool
    additions: int
    deletions: int
    changedFiles: int
    branches: list[BranchView]
    files: list[ChangedFileView]
    warnings: list[str]

class BootstrapView(BaseModel):
    apiVersion: Literal["1"]
    settings: SettingsView
    providers: ProviderCatalogView
    sessions: list[SessionSummary]
    mcpServers: list[McpServerView]
    skills: list[SkillView]
    artifacts: list[ArtifactView]
    workspace: WorkspaceStatusView
    engine: EngineStatusView

class SettingsPatch(BaseModel):
    """Partial update; every field optional. apiKey is write-only."""
    providerId: str | None = None
    model: str | None = None
    fallbackModel: str | None = None
    baseURL: str | None = None
    apiKey: str | None = None          # accepted, never echoed
    cwd: str | None = None
    permissionMode: str | None = None
    thinkingMode: str | None = None
    effort: str | None = None
    maxThinkingTokens: int | None = None
    maxTurns: int | None = None
    maxBudgetUsd: float | None = None
    taskBudget: float | None = None
    allowedTools: list[str] | None = None
    disallowedTools: list[str] | None = None
    addDirs: list[str] | None = None
    appendSystemPrompt: str | None = None
    layout: "LayoutView | None" = None

class LayoutView(BaseModel):
    leftOpen: bool
    leftWidth: int
    rightOpen: bool
    rightWidth: int

class ProviderCatalogView(BaseModel):
    builtin: list[ProviderView]
    custom: list[ProviderView]

class ProviderView(BaseModel):
    id: str
    name: str
    apiType: Literal["anthropic-messages", "codex-completions"] | None = None
    baseURL: str | None = None
    models: list[str] = []
    allowCustomModels: bool = False

class BranchView(BaseModel):
    name: str
    isRemote: bool

class ChangedFileView(BaseModel):
    path: str
    status: Literal["added", "deleted", "modified", "renamed", "copied", "type_changed", "unknown"]
    additions: int
    deletions: int

class FileDiffView(BaseModel):
    path: str
    patch: str
    original: str | None
    current: str | None

class TurnStatusView(BaseModel):
    turnId: str
    sessionId: str
    state: Literal["running", "completed", "cancelled", "failed"]
    stopReason: Literal["end_turn", "max_turns", "cancelled"] | None
    assistantMessageId: str | None
    error: str | None               # sanitized

class McpServerInput(BaseModel):
    """The user's server definition; this is domain data, not our process config."""
    name: str
    transport: Literal["stdio", "http", "sse"]
    command: str | None = None
    args: list[str] = []
    env: dict[str, str] = {}
    url: str | None = None
    headers: dict[str, str] = {}
    enabled: bool = True
    autoRun: bool = False
```

### 3.2 Explicitly hidden (never serialized)

| Hidden representation | Where it lives today | Why it must not cross the boundary |
|---|---|---|
| SQLite tables/rows/columns (`tool`, `chat`, `message`, `provider`, `kv`, `__migrations`) | `main.ts:1304-1461` | Clients would couple to schema; migrations would break them. |
| SQL strings and the generic `dbGet/dbAll/dbExecute` IPC | `main.ts:2502-2510` | Representation exposure and arbitrary-write vulnerability. |
| opencc/Claude executable, config dir, extra args | `main.ts:52-102`, `engine-client.ts:38-156`, `393-444` | CLI is an implementation detail that changes with versions. |
| Environment variables (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, `AUTOAGENT_RG_PATH`) | `engine-client.ts:446-459` | Secrets and deployment details. |
| `--resume`, `--continue`, `--fork-session`, `--no-session-persistence` semantics | `engine-client.ts:436-443`, `main.ts:1859-1865` | Resume strategy must be free to change without a client release. |
| Subprocess PIDs, signals, spawn retries, timeouts, kill escalation | `engine-client.ts:299-307`, `390-507` | OS/process management is not a domain concept. |
| Raw stream-json frames, `content_block_*`, `tool_use` ids, `session_id` | `engine-client.ts:244-283`, `555-566` | Frame format is vendor/version-specific; leaking it recreates the current coupling. The wire `call_ref` is a server-minted opaque correlation id, not the `tool_use` id. |
| Internal filesystem paths (`sessions/*.json`, `chatwise.db`, artifact manifest/version paths) | `main.ts:375-417`, `979-1013`, `1304-1313` | Paths are deployment details; artifacts are exposed by URL/id. |
| API key plaintext | `settings.json`, `main.ts:2138-2155` | Only `apiKeyConfigured` + write-only update. |
| Migration bookkeeping | yet to exist | Not a client concern. |

`EngineStatusView.lastError` is sanitized: no argv, no stack trace, no env values.

---

## 4. Coarse-grained HTTP surface

The endpoint set is intentionally proportional to **use cases**, not to the 100+
legacy IPC channels. Routing may be implemented with FastAPI (recommended by
`ch09_Python_Web应用开发.md:107-114`) or any thin adapter; the contract is
framework-independent.

### 4.1 Health, bootstrap, settings, engine

| Method | Path | Domain operation | Request | Response | Design driver |
|---|---|---|---|---|---|
| GET | `/api/health` | liveness only | — | `{ok,version,bootId,uptimeMs,db,engine}` | Deepest possible probe: one boolean-ish shape, no I/O. Token-exempt so Electron can poll before login. |
| GET | `/api/bootstrap` | `BootstrapService.read()` | — | `BootstrapView` | Narrow aggregate read model; avoids chatty startup and hides parallel loading. |
| GET | `/api/settings` | `SettingsService.read()` | — | `SettingsView` | One aggregate, no per-field getters. |
| PUT | `/api/settings` | `SettingsService.update(patch)` | `SettingsPatch` | `SettingsView` | Whole-aggregate update; hides defaults, provider resolution, `.claude.json` sync. |
| GET | `/api/providers` | `SettingsService.providers()` | — | `ProviderCatalogView` | Static catalog for UI choice. |
| GET | `/api/providers/{id}` | `SettingsService.provider(id)` | — | `ProviderView` | Resolves URL/models; hides endpoint rules. |
| GET | `/api/engine/status` | `EnginePort.status()` | — | `EngineStatusView` | Status intention, not process inspection. |
| GET | `/api/events` | cross-cutting changes | — | SSE | One stream for artifact/engine/skill invalidation. |

`PUT /api/settings` deliberately replaces the legacy `saveSettings` + hidden
`syncEngineConfig` + `provider:resolve` trio. The client expresses “these are my
settings”; the backend owns how they are persisted and applied. This is
information hiding in the ADT sense (`ch05_抽象数据类型.md:14`).

### 4.2 Sessions

| Method | Path | Domain operation | Request | Response |
|---|---|---|---|---|
| GET | `/api/sessions` | `SessionService.list()` | `?limit=` | `{sessions:[SessionSummary]}` |
| POST | `/api/sessions` | `SessionService.create()` | `{title?}` | `SessionView` |
| GET | `/api/sessions/{sessionId}` | `SessionService.get()` | — | `SessionView` |
| PATCH | `/api/sessions/{sessionId}` | `SessionService.rename()` | `{title}` | `SessionView` |
| DELETE | `/api/sessions/{sessionId}` | `SessionService.delete()` | — | `{deleted:true}` |
| POST | `/api/sessions/{sessionId}/branch` | `SessionService.branch()` | `{title?}` | `SessionView` |

No `/messages` sub-resource: messages are part of the session aggregate in v1 and
are written only by `TurnService`. This prevents clients from inventing message
ordering rules (`ch05_抽象数据类型.md:26-35`).

### 4.3 Turns (chat streaming)

| Method | Path | Domain operation | Request | Response |
|---|---|---|---|---|
| POST | `/api/turns/{turnId}/stream` | `TurnService.run(turnId, request)` | `{sessionId,text,overrides?}` | `text/event-stream` |
| POST | `/api/turns/{turnId}/cancel` | `TurnService.cancel(turnId)` | — | `202 {cancelling:true}` |
| GET | `/api/turns/{turnId}` | `TurnService.status(turnId)` | — | `TurnStatusView` |

- `turnId` is a **client-generated UUID** used as an idempotency key. Retrying the
  same `turnId` after a network failure must not start a second turn.
- The single stream call fuses “create turn + run + stream” into one intention.
  This hides spawn, resume, retry and event-framing decisions.
- One active turn per session; a concurrent start returns `409
  TURN_IN_PROGRESS`.
- Client disconnect does not cancel; the turn completes and is persisted.
  Electron cancels all active turns on shutdown.
- `GET /api/turns/{turnId}` returns a terminal snapshot so a reconnecting client
  can recover without replay; delta replay is not part of v1.

### 4.4 Skills (v1.1)

| Method | Path | Domain operation | Request | Response |
|---|---|---|---|---|
| GET | `/api/skills` | `SkillService.catalog()` | `?cwd=` | `{skills:[SkillView],dirs:[...]}` |
| POST | `/api/skills/{name}/enable` | `SkillService.enable(name, path?)` | `{path?}` | `{skills:[SkillView]}` |
| POST | `/api/skills/{name}/disable` | `SkillService.disable(name)` | — | `{skills:[SkillView]}` |
| POST | `/api/skills/discover` | `SkillService.discover()` | `{cwd,query?}` | `{items:[...]}` |

Enable/disable are separate intention-revealing commands, not a generic PATCH,
because the implementation moves directories atomically (`main.ts:2408-2441`).
The response returns the new catalog, so the client never reconstructs it.

### 4.5 MCP (v1.1)

| Method | Path | Domain operation | Request | Response |
|---|---|---|---|---|
| GET | `/api/mcp/servers` | `McpService.list()` | — | `{servers:[McpServerView]}` |
| PUT | `/api/mcp/servers/{name}` | `McpService.upsert(name, spec)` | `McpServerInput` | `McpServerView` |
| DELETE | `/api/mcp/servers/{name}` | `McpService.remove(name)` | — | `{deleted:true}` |
| POST | `/api/mcp/servers/{name}/enable` | `McpService.enable(name)` | — | `McpServerView` |
| POST | `/api/mcp/servers/{name}/disable` | `McpService.disable(name)` | — | `McpServerView` |
| POST | `/api/mcp/discover` | `McpService.discover(name?)` | `{name?,enabledOnly?}` | `{results:[...]}` |
| POST | `/api/tools/invoke` | `McpService.invoke(server?, tool, args)` | `{server?,tool,args}` | tool result (sanitized) |

`McpServerInput` intentionally includes the user's server definition (command,
args, env, URL, headers) because that is a domain object the user owns. What is
hidden is our connection pooling, retry policy, process spawn and JSON-RPC
framing (`main.ts:1490-1744`).

### 4.6 Workspace

| Method | Path | Domain operation | Request | Response |
|---|---|---|---|---|
| GET | `/api/workspace` | `WorkspaceService.status()` | `?workDir=&base=` | `WorkspaceStatusView` |
| GET | `/api/workspace/diff` | `WorkspaceService.diff(path)` | `?path=&workDir=` | `FileDiffView` |
| POST | `/api/workspace/branches/switch` | `WorkspaceService.switch_branch()` | `{branch,workDir?}` | `WorkspaceStatusView` |
| POST | `/api/workspace/init` | `WorkspaceService.init()` | `{workDir?}` | `WorkspaceStatusView` |

The six legacy `getGit*` channels collapse into one status read model plus one
diff read. This is high cohesion: clients care about “workspace state”, not about
`--numstat` vs `--name-status`.

### 4.7 Artifacts (v1.1)

| Method | Path | Domain operation | Request | Response |
|---|---|---|---|---|
| GET | `/api/artifacts` | `ArtifactService.list()` | — | `{artifacts:[ArtifactView]}` |
| POST | `/api/artifacts` | `ArtifactService.create()` | `{title?,description?,html}` | `ArtifactView` |
| GET | `/api/artifacts/{id}` | `ArtifactService.get()` | — | `ArtifactView` |
| GET | `/api/artifacts/{id}/content` | `ArtifactService.content()` | — | raw `text/html` |
| POST | `/api/artifacts/{id}/open` | `ArtifactService.mark_opened()` | — | `ArtifactView` |
| POST | `/api/artifacts/{id}/export` | `ArtifactService.export(targetPath)` | `{targetPath}` | `{path}` |
| POST | `/api/artifacts/import` | `ArtifactService.import(zipPath)` | `{zipPath}` | `ArtifactView` |

The legacy `artifact:source`, `artifact:versions`, and `artifact:load` channels
are folded into `GET /api/artifacts/{id}` (metadata + versions) and
`/content` (raw bytes). The SPA never receives a disk path for display.

### 4.8 MateBot / autowork (v1.1)

| Method | Path | Domain operation | Request | Response |
|---|---|---|---|---|
| POST | `/api/autowork/ask` | `TurnService.ask()` | `{prompt,data?}` | `{text}` or SSE |
| POST | `/api/tools/invoke` | same as MCP invocation | — | — |

Scheduled-task placeholder is dropped.

### 4.9 Native capabilities (not REST)

These remain in the Electron preload because a browser cannot perform them:
window controls, native open/save/message/confirm dialogs, context menus, clipboard
image/text, `shell.openExternal`, `showItemInFolder`, notifications, accent color,
`nativeTheme`, artifact child window, navigation history, single-instance focus.
They are **not** business interfaces and carry no domain state.

### 4.10 Decision ledger (principle → citation)

| API decision | Principle | Citation |
|---|---|---|
| One `/api/bootstrap` aggregate instead of many startup reads | High cohesion, low coupling; a narrow read model hides parallel loading | `ch08_设计模式.md:25-51`, `ch05_抽象数据类型.md:14` |
| `PUT /api/settings` takes the whole settings aggregate | Operations act on the abstract value; normalization/defaults are hidden | `ch05_抽象数据类型.md:26-35`, `151-188` |
| Client-generated `turnId` used as an idempotency key | Intention-revealing command with a stable contract; retry safety | `ch05_抽象数据类型.md:151-188`, `ch08_设计模式.md:53-71` |
| `POST /api/turns/{turnId}/stream` fuses start + stream | Deep module: spawn/resume/retry orchestration stays hidden | `ch05_抽象数据类型.md:26-35` |
| No `/messages` write endpoint | The store owns message ordering and its own invariant | `ch05_抽象数据类型.md:51-112` |
| Enable/disable skills are named commands | Intention-revealing interface; hides directory moves | `ch05_抽象数据类型.md:151-188` |
| One `/api/workspace` status aggregate | Cohesive read model instead of six git-channel mirrors | `ch08_设计模式.md:25-51` |
| Native capabilities stay in preload | Separation of concerns; the domain does not depend on OS APIs | `ch09_Python_Web应用开发.md:255-262` |
| DTOs are separate from domain objects | Domain must not leak to the boundary | `ch09_Python_Web应用开发.md:323-373` |
| One domain-exception → HTTP mapper | Specification and error behavior live at the boundary | `ch09_Python_Web应用开发.md:194-255` |
| Ports declared as `typing.Protocol` | Dependency inversion | `ch08_设计模式.md:53-71` |
| `MateBotEngine` adapts coordinator protocol to `EnginePort` | Adapter for genuinely incompatible interfaces | `ch08_设计模式.md:417-457` |
| Services receive ports via constructor/`Depends` | Dependency injection and a single composition root | `ch08_设计模式.md:53-71`, `ch09_Python_Web应用开发.md:341-373` |
| Frozen DTOs/value objects; no mutable internals returned | Prevent representation exposure | `ch05_抽象数据类型.md:258-326`, `343-412` |

---

## 5. Chat stream: domain events → SSE DTOs

The public wire schema is a projection of **domain events**, not a projection of
stream-json. This is the key anti-corruption boundary: if the CLI changes its
frame format, only `SubprocessEngine` changes.

### 5.1 Domain events

```python
@dataclass(frozen=True, slots=True)
class TurnStarted:    turn_id: str; session_id: str; model: str | None
@dataclass(frozen=True, slots=True)
class TextDelta:      turn_id: str; text: str
@dataclass(frozen=True, slots=True)
class ThinkingDelta:  turn_id: str; text: str
@dataclass(frozen=True, slots=True)
class ToolStarted:    turn_id: str; call_ref: str; name: str | None; input: dict | None
@dataclass(frozen=True, slots=True)
class ToolFinished:   turn_id: str; call_ref: str; name: str | None; ok: bool; text: str | None
@dataclass(frozen=True, slots=True)
class UsageReported:  turn_id: str; input_tokens: int | None; output_tokens: int | None
@dataclass(frozen=True, slots=True)
class TurnCompleted:  turn_id: str; session_id: str; stop_reason: str; text: str
@dataclass(frozen=True, slots=True)
class TurnFailed:     turn_id: str; session_id: str; code: str; message: str; retryable: bool
```

### 5.2 Wire schema

```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive

id: <seq>
event: <type>
data: <json>
```

Common fields: `turnId`, `sessionId`, `seq` (monotonic from 1), `ts` (epoch ms).

| `event` | Data | Domain source |
|---|---|---|
| `turn.started` | `{turnId,sessionId,seq,ts,model?}` | `TurnStarted` |
| `message.delta` | `{turnId,sessionId,seq,ts,channel:"text"\|"thinking",text}` | `TextDelta` / `ThinkingDelta` |
| `message.completed` | `{turnId,sessionId,messageId,seq,ts,text}` | `TurnCompleted` |
| `tool.start` | `{turnId,sessionId,seq,ts,tool:{ref,name?,input?}}` | `ToolStarted` |
| `tool.result` | `{turnId,sessionId,seq,ts,tool:{ref,name?,ok},text?}` | `ToolFinished` |
| `usage` | `{turnId,sessionId,seq,ts,usage:{inputTokens?,outputTokens?}}` | `UsageReported` |
| `turn.completed` | `{turnId,sessionId,seq,ts,stopReason:"end_turn"\|"max_turns"\|"cancelled"}` | `TurnCompleted` |
| `error` | `{turnId,sessionId,seq,ts,code,message,retryable}` | `TurnFailed` |
| `heartbeat` | `{ts}` | transport keep-alive |

No `raw` field is part of the contract. Debugging can log raw frames server-side
under a debug flag.

### 5.3 Legacy behavior to preserve

| Legacy behavior | Evidence | Domain rule |
|---|---|---|
| Thinking deltas currently appear as assistant text | `engine-client.ts:255-257` | Preserve the information but distinguish `channel:"thinking"`; UI may choose to render it separately. |
| `assistant` event replaces accumulated text | `main.ts:1943-1945` | `TurnCompleted.text` is authoritative; deltas are best-effort. |
| Session id is persisted for follow-up turns | `main.ts:1946-1948` | `SessionStorePort.record_turn` stores an opaque engine ref; never sent to the SPA. |
| Abort yields `interrupted` then the run ends | `engine-client.ts:352-356` | `TurnCompleted(stop_reason="cancelled")`. |
| Process exit before result becomes an error | `engine-client.ts:344-349` | `TurnFailed(code="ENGINE_EXITED")`. |
| Artifacts are materialized from final text | `main.ts:1963-1966`, `1160-1177` | `TurnService` calls `ArtifactStorePort` after persisting the assistant message; partial failures are warnings, not turn failures. |

### 5.4 Transport notes

- Because `EventSource` cannot POST, the SPA uses `fetch` + `ReadableStream`.
- Implementations may use FastAPI `StreamingResponse` or a stdlib handler; the
  event schema is identical.
- Send a heartbeat every 15 s.
- Enforce one active turn per session before touching the engine.
- Never hold a DB write transaction open while streaming.

---

## 6. Deep interface checklist

Use this in design review and in the PR checklist.

**Boundary and DTOs**

- [ ] The client expresses intentions (`start turn`, `enable skill`), never
      mechanisms (`spawn`, `resume`, `UPDATE`, `SELECT`).
- [ ] No DTO field is a database column, CLI flag, process id, signal, raw frame,
      env value or absolute server path.
- [ ] Request DTOs enforce preconditions via types (`Field(min_length=...)`),
      following `ch09_Python_Web应用开发.md:95-105`.
- [ ] Response DTOs are frozen/plain values with explicit `to_view()` conversion;
      domain objects never serialize directly (`ch09_…:323-373`).
- [ ] Unknown input fields are rejected or ignored deliberately, not reflected
      back.
- [ ] Errors are `{ok:false,code,error}` from a single domain-exception mapper;
      no traceback, argv or SQL appears.

**Ports and services**

- [ ] Every external dependency (engine, DB, git, filesystem, MCP, artifacts) is
      behind a `Protocol`.
- [ ] Each port has a docstring stating preconditions, postconditions and raised
      domain errors.
- [ ] Ports have few methods (target ≤ 7) and one reason to change.
- [ ] Application services do not import FastAPI, sqlite3, subprocess, httpx or
      Pydantic.
- [ ] Services are unit-tested with fakes; adapters have their own integration
      tests (`ch09_…:531-591`).
- [ ] The composition root is the only place that constructs concrete adapters
      (`ch09_…:341-373`).
- [ ] No module-level mutable singleton stores business state; state is in ports
      (`ch08_设计模式.md:293-343`).

**ADT hygiene**

- [ ] Every port has a documented AF/RI or equivalent invariant statement
      (`ch05_抽象数据类型.md:51-112`).
- [ ] No mutable internal list/dict is returned; return tuples/frozen values or
      copies (`ch05_抽象数据类型.md:343-412`).
- [ ] Domain value objects are `@dataclass(frozen=True, slots=True)` where
      practical.
- [ ] Operations preserve the invariant at entry and exit; property tests cover
      the homomorphism where meaningful.

**HTTP surface**

- [ ] Endpoint count tracks use cases, not legacy IPC channels.
- [ ] Read models are aggregated (`/bootstrap`) instead of chatty per-field calls.
- [ ] Mutating commands are idempotent where retries are plausible (`turnId`).
- [ ] Native OS capabilities stay in preload and do not enter the domain.
- [ ] Health performs no network, engine or heavy DB work.
- [ ] The client can be replaced without changing ports; a port can be replaced
      without changing clients.

---

## 7. Anti-corruption mapping: legacy IPC → domain operation

Legend: **D** = maps to a domain operation behind the ports; **K** = keep as an
OS-native preload capability; **X** = drop. Multiple channels may map to one
operation and one endpoint; that is the point.

| Legacy IPC channel(s) | Domain operation | Endpoint (if any) | Disposition |
|---|---|---|---|
| `app:bootstrap`, `getLocalSettings`, `osInfo`, `getDir` | `BootstrapService.read` / system info | `GET /api/bootstrap` | D |
| `settings:save`, `saveLocalSettings`, `saveTheme` | `SettingsService.update` | `PUT /api/settings` | D |
| `provider:resolve` | `SettingsService.provider` | `GET /api/providers/{id}` | D |
| `chat:list` | `SessionService.list` | `GET /api/sessions` | D |
| `chat:create` | `SessionService.create` | `POST /api/sessions` | D |
| `chat:load` | `SessionService.get` | `GET /api/sessions/{id}` | D |
| `chat:delete` | `SessionService.delete` | `DELETE /api/sessions/{id}` | D |
| `chat:branch` | `SessionService.branch` | `POST /api/sessions/{id}/branch` | D |
| `agent:send` | `TurnService.run` | `POST /api/turns/{turnId}/stream` | D |
| `agent:stop` | `TurnService.cancel` | `POST /api/turns/{turnId}/cancel` | D |
| `agent:event` (push) | `TurnService` domain events | SSE | D |
| `skill:list`, `discoverSkill` | `SkillService.catalog/discover` | `GET /api/skills`, `POST /api/skills/discover` | D |
| `skill:toggle` | `SkillService.enable/disable` | `POST /api/skills/{name}/enable\|disable` | D |
| `mcp:list` | `McpService.list` | `GET /api/mcp/servers` | D |
| `mcp:save` | `McpService.upsert` | `PUT /api/mcp/servers/{name}` | D |
| `mcp:toggle` | `McpService.enable/disable` | `POST /api/mcp/servers/{name}/enable\|disable` | D |
| `mcp:delete` | `McpService.remove` | `DELETE /api/mcp/servers/{name}` | D |
| `mcp:discover`, `autowork:call-mcp-tool` | `McpService.discover/invoke` | `POST /api/mcp/discover`, `POST /api/tools/invoke` | D |
| `workspace:git-status`, `getGitBranches`, `getGitDiffStat`, `getGitDiffFiles`, `getGitDiffFileContent`, `getGitDefaultBranch` | `WorkspaceService.status/diff` | `GET /api/workspace`, `GET /api/workspace/diff` | D |
| `switchGitBranch`, `initGitRepository` | `WorkspaceService.switch_branch/init` | `POST /api/workspace/branches/switch`, `POST /api/workspace/init` | D |
| `artifact:list`, `artifact:load`, `artifact:source`, `artifact:versions` | `ArtifactService.list/get/content` | `GET /api/artifacts`, `GET /api/artifacts/{id}`, `GET /api/artifacts/{id}/content` | D |
| `artifact:create` | `ArtifactService.create` | `POST /api/artifacts` | D |
| `artifact:open` | `ArtifactService.mark_opened` + native window | `POST /api/artifacts/{id}/open` | D + K |
| `artifact:export`, `artifact:import` | `ArtifactService.export/import` + native dialog | `POST /api/artifacts/{id}/export`, `POST /api/artifacts/import` | D + K |
| `artifact:event` (push) | invalidation event | `GET /api/events` | D |
| `autowork:ask-claude` | `TurnService.ask` | `POST /api/autowork/ask` | D |
| `autowork:run-scheduled-task` | — | — | X |
| `glob`, `globTool`, `grep` | engine-owned tools | — | X |
| `dbGet`, `dbAll`, `dbExecute` | — | — | X |
| `readTextFile`, `readFileAsBase64`, `readFileBinary`, `readFile`, `readDir`, `writeTextFile`, `writeFile`, `removePath`, `pathStats`, `createDir`, `copyFile`, `zipFolder`, `unzipFile`, `pathExists`, `ensureDir`, `resolveInAppDataDir`, `resolveInAppFiles`, `saveRecordingAsWav` | — | — | X |
| `electron-fetch:request`, `electron-fetch:abort:*` | — | — | X |
| `electron-exec:request`, `electron-exec:event` | — | — | X |
| `getShellEnv` | — | — | X (secret exposure) |
| `setLoggerEnabled`, `setTrackingEnabled`, `changeLanguage`, `applyTheme`, `initFonts`, `isBinDownloaded`, `downloadBin`, `ensureBinVersion`, `bunInstallInTempFolder`, `startOauthServer`, `stopOauthServer` | — | — | X (stubs) |
| `dialog:select-cwd`, `showOpenDialog`, `showSaveDialog`, `showMessageDialog`, `showConfirmDialog`, `showContextMenu`, `$context-menu-click` | native OS | — | K |
| `getAccentColor`, `setWindowBackground`, `windowReady`, `showCurrentWindow`, `focusCurrentWindow`, `setAlwaysOnTop`, `getWindowProp`, `setWindowProp`, `closeWindow`, `showSettingsWindow` | native window | — | K |
| `shell:open-external`, `openExternalUrl`, `openPath`, `openPathWithProgram`, `showInFolder` | native shell | — | K |
| `copyImageToClipboard`, `copyTextToClipboard`, `getClipboardText` | native clipboard | — | K |
| `sendNotification` | native notification | — | K |
| `autowork:navigate-host`, `autowork:open-external-url` | artifact-window navigation | — | K |
| `invalidateQueryClient`, `navigate` (push), `getFonts`, `appCacheGet`, `appCacheSet` | — | — | X |

Full line-by-line evidence for each channel is in `legacy-inventory.md` §2.

---

## 8. Migration boundary

### 8.1 Remove from Electron immediately

- Session JSON persistence and CRUD (`main.ts:979-1028`, `2216-2234`).
- Turn orchestration, event mapping and artifact materialization
  (`main.ts:1853-1977`, `1030-1177`).
- `engine-client.ts` entirely.
- MCP registry/client (`main.ts:1490-1744`, `2269-2283`).
- Skill scanning/toggling (`main.ts:2284-2441`).
- Artifact file management (`main.ts:395-748`, `2241-2262`), except opening the
  artifact child window.
- Git/workspace commands (`main.ts:2443-2459`, `2546-2567`).
- Generic filesystem/SQL/exec/fetch bridges (`main.ts:2502-2637`,
  `chatwise/transport.ts`).
- No-op stubs (`main.ts:2578-2588`).
- The renderer static HTTP server (`main.ts:1213-1253`).
- `sandbox:false` and the generic `ipcRenderer` exposure (`main.ts:2027`,
  `preload.ts:6-21`).

### 8.2 Keep in Electron (native adapter + lifecycle)

- `BrowserWindow` creation/loading, `ready-to-show`, render recovery.
- Single-instance lock with MaxWire-style retries.
- Backend spawn, port selection, token provisioning, health wait, shutdown.
- Native dialogs, clipboard, shell, notifications, window controls, theme,
  accent color.
- Artifact child window and `artifact-preload.cjs` host actions.
- Logging and the async startup error dialog with timeout.
- `AUTOAGENT_LEGACY` switch.

### 8.3 `AUTOAGENT_LEGACY=1`

- Do not spawn Python and do not migrate.
- Load the legacy bundle against the same data root.
- Legacy files remain untouched; the new backend writes only
  `autoagent-v2.db` (and leaves artifact files in place).

---

## 9. Data migration

### 9.1 Sources (read-only)

| Data | Path | Format | Evidence |
|---|---|---|---|
| Settings | `<userData>/settings.json` | `DesktopSettings` | `main.ts:922-925`, `854-906` |
| Sessions | `<userData>/sessions/<id>.json` | `ChatRecord` | `main.ts:979-1013` |
| MCP servers | `<userData>/chatwise.db` → `tool` | SQLite | `main.ts:1590-1638` |
| Enabled skills | `<userData>/skills.json` | string array | `main.ts:2296-2304` |
| Local settings | `<userData>/local-settings.json` | object | `main.ts:2462-2465` |
| Artifacts | `<userData>/artifacts/manifest.json` + dirs | JSON + files | `main.ts:415-417` |
| Files | `<userData>/files/` | arbitrary | `main.ts:1284` |

`<userData>`: Linux `~/.config/autoagent`; Windows `%TEMP%\autoagent-userdata`
(`main.ts:321-323`); macOS `~/Library/Application Support/autoagent`.

### 9.2 Target and procedure

- Stable root from `AUTOAGENT_DATA_DIR`; Windows must copy the temp tree to a
  persistent location on first run.
- New DB: `<dataDir>/autoagent-v2.db` (SQLite, WAL).
- Import settings through `SettingsPort.update` normalization; import sessions
  through `SessionStorePort`; import `tool` rows through `McpRegistryPort`;
  import skills through `SkillCatalogPort`.
- Preserve `claudeSessionId` as the hidden `engine_session_ref`; it must survive
  migration so follow-up turns can resume.
- Keep `manifest.json` authoritative for artifacts in v1.
- Marker: `kv('legacy_migrated_at')`; idempotent; log and skip corrupt records;
  never delete legacy data automatically.
- Rollback: `AUTOAGENT_LEGACY=1` plus untouched legacy files.

---

## 10. v1 feature list (freeze)

**Must ship**

1. Health + bootstrap + engine status.
2. Session list/create/select/delete.
3. Turn stream (`POST /api/turns/{turnId}/stream`) with text, thinking, tool,
   usage, completion and error events.
4. Turn cancel.
5. Markdown/GFM, sanitized HTML, code blocks, inline `artifact-html`.
6. Core `SettingsView` read/write (provider, model, base URL, masked API key,
   workspace, permission, turns, tools, layout).
7. Native directory picker and standard desktop integrations.
8. First-run migration with Windows temp-path rescue.

**Fast follow (v1.1)**

- MCP server management, discovery and invocation.
- Skills catalog and enable/disable.
- Workspace panel and git operations.
- Artifact library (list/open/content/export/import).
- Session branching.
- Autowork/MateBot ask.
- Global event stream.

**Dropped**

- Generic SQL/file/exec/fetch IPC.
- Engine argv/config-dir exposure.
- No-op stub channels.
- Scheduled-task placeholder.
- ChatWise tables other than `tool`.
- `src/db/*`, `src/providers/factory.ts`.

---

## 11. Top 5 breakage risks

1. **Windows data loss / path divergence.** Legacy userData is
   `%TEMP%\autoagent-userdata` (`main.ts:321-323`); engine logs are also in temp
   (`engine-client.ts:16`). Migrate before the backend starts and verify with a
   fixture tree.

2. **Hidden-state loss when porting.** Resume/session semantics live in
   `engine-client.ts:436-443` and `main.ts:1859-1865`; artifact materialization
   lives in `main.ts:1160-1177`. If the port hides them but does not reimplement
   them, follow-up turns lose context or artifact blocks disappear. Port the
   behavior into `SubprocessEngine`/`TurnService`, not into the SPA.

3. **Stream boundary correctness.** Deliberately dropping raw frames is right,
   but the domain-event adapter must preserve thinking vs text, terminal
   semantics and the engine session ref (`engine-client.ts:244-283`,
   `344-356`). Add golden tests that feed recorded stream-json into the adapter
   and assert domain events, then assert the SSE projection separately.

4. **Port/adapter explosion (over-abstraction).** The checklist targets ≤ 7
   methods per port. Do not create a port per IPC channel or a wrapper per SQL
   statement. If a change does not require swapping an implementation or testing
   in isolation, it does not need a new port (`ch08_设计模式.md:789-797`).

5. **Loopback security.** Moving state behind HTTP adds a local attack surface.
   Bind `127.0.0.1`, require a per-launch token on all `/api/*` except health,
   validate `Origin`, never expose `getShellEnv`, keep `sandbox:true`, and never
   return server paths or API keys. This is also an information-hiding requirement:
   implementation details are also attack surface.

Secondary risks: MCP stdio child lifecycle leaks in Python; skill directory moves
non-atomic; API key plaintext at rest (`main.ts:2138-2155`); git commands without
timeouts (`chatwise/git.ts:19-39`).

---

## 12. Handoff

- **Backend:** implement the ports first with fakes (`InMemorySessionStore`,
  `FakeEngine`, `FakeWorkspace`), then the adapters. The HTTP layer should be
  replaceable in a day.
- **Frontend:** depend only on `BootstrapView`, `SessionView`, `SettingsView`,
  `TurnRequest` and the SSE wire schema. Do not type against `main.ts` interfaces.
- **Electron shell:** single-instance retry, free-port selection, Python spawn,
  health wait, token injection, loadURL, logs, shutdown, `AUTOAGENT_LEGACY`.
- **Do not delete legacy files** until migration fixtures pass on Linux and
  Windows and `AUTOAGENT_LEGACY=1` is verified.
