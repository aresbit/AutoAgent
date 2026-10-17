# Legacy Inventory — AutoAgent Desktop → MateBot Architecture

Scope: repository `/home/tars/yysapp/AutoAgent` at commit `8387c3f` (branch
`master`). Evidence is cited as `file:line`. No source files were modified.

Reference architecture: `/home/tars/yysapp/maxwire` (Electron thin shell + local
Python stdlib backend + SPA). See `maxwire-model.md` for the reference patterns and
`api-contract-v1.md` for the proposed API, ports and migration boundary.

**Architecture constraint:** the target API uses the deep-interface (deep module)
pattern. The public HTTP surface is narrow and intention-revealing; the
implementation (SQLite rows, opencc/Claude argv, flag probing, retries, resume
logic, subprocess lifecycle, stream-json frames) stays behind ports. Therefore:

- The per-channel “domain operation” columns below are **anti-corruption hints**,
  not a one-endpoint-per-IPC contract.
- Many IPC channels collapse into one coarse domain operation and one endpoint.
- No IPC channel maps 1:1 to a REST endpoint.
- The authoritative mapping is `api-contract-v1.md` §7.

---

## 1. Process and window lifecycle

`src/main.ts` owns the entire desktop process.

| Concern | Evidence | Notes |
|---|---|---|
| Electron entry | `package.json` `"main": "dist/main.js"`; build target `src/main.ts` in `scripts/build-desktop.mjs` | Bun bundles main, preload and renderer separately. |
| App identity | `main.ts:306-334` | `PRODUCT_NAME=AutoAgent`, Linux app name `autoagent`, desktop name `autoagent.desktop`, Windows AUMID `com.autoagent.desktop`. |
| Windows startup overrides | `main.ts:314-324` | Disables GPU, forces disk cache and **userData** to `%TEMP%\autoagent-userdata`. Critical for data migration. |
| Main window | `main.ts:2003-2030` | 1200×870, `contextIsolation`, `nodeIntegration:false`, `sandbox:false`, preload `dist/preload.cjs`, hidden until `ready-to-show`. |
| Renderer delivery | `main.ts:1213-1302`, `2080-2122` | Local ephemeral HTTP server (`listen(0,'127.0.0.1')`), `loadURL`, retry, `file://` fallback, inline `data:` error page. |
| Custom protocol | `main.ts:361-373`, `1278-1302` | `client://` scheme with `app-files` / `file` proxies; `protocol.handle`. |
| Artifact window | `main.ts:750-773` | Separate `BrowserWindow`, `sandbox:true`, `artifact-preload.cjs`, denied `window.open`. |
| Render recovery | `main.ts:2067-2078` | Reloads up to 2 times on `crashed`/`oom`. |
| Single instance | `main.ts:2721-2733` | No retry loop (MaxWire retries; see `maxwire-model.md`). |
| Quit cleanup | `main.ts:2767-2779` | Aborts runs, kills exec children, closes renderer server. No backend process exists today. |

The current app has **no local backend process**. All business logic, persistence,
spawning, MCP and git live in the Electron main process. The migration inverts
this: Electron becomes an OS adapter + lifecycle supervisor; Python owns the
domain.

---

## 2. IPC surface (authoritative evidence)

All `ipcMain.handle`/`ipcMain.on` registrations are in `main.ts:2164-2719`, except
the transport channels registered from `src/chatwise/transport.ts:19-90`.

Disposition legend:

- **D** — maps to a domain operation behind a port (not necessarily its own
  endpoint; several channels usually share one).
- **K** — keep in the Electron preload as an OS-native capability.
- **X** — drop.

### 2.1 App, settings, providers

| Channel | Evidence | Domain operation | Disposition |
|---|---|---|---|
| `app:bootstrap` | `main.ts:2164-2181` | `BootstrapService.read` (aggregate: settings, providers, sessions, MCP, artifacts) | D |
| `settings:save` | `main.ts:2183-2188` | `SettingsService.update` (whole aggregate; hides normalization + `.claude.json` sync) | D |
| `provider:resolve` | `main.ts:2190-2206` | `SettingsService.provider` (hides static catalog and endpoint rules) | D |
| `dialog:select-cwd` | `main.ts:2208-2214` | native directory picker | K |
| `getAccentColor` | `main.ts:2461` | OS accent color | K |
| `getLocalSettings` | `main.ts:2462-2465` | `SettingsService.read` / local view | D |
| `saveLocalSettings`, `saveTheme` | `main.ts:2697-2704` | `SettingsService.update` (+ `nativeTheme`) | D + K |
| `getDir`, `osInfo` | `main.ts:2483-2501` | `BootstrapService.read` / system info | D |
| `getShellEnv` | `main.ts:2490` | **Returns full `process.env`.** | X |
| `appCacheGet/Set` | `main.ts:2491-2500` | no renderer consumer | X |
| `invalidateQueryClient` | `main.ts:2511-2513` | replaced by `/api/events` | X |
| `showSettingsWindow`, `showCurrentWindow`, `focusCurrentWindow`, `setAlwaysOnTop`, `getWindowProp`, `setWindowProp`, `closeWindow`, `setWindowBackground`, `windowReady` | `main.ts:2466-2482`, `2706-2719` | window controls | K |
| `showOpenDialog`, `showSaveDialog`, `showMessageDialog`, `showConfirmDialog`, `showContextMenu`, `$context-menu-click` | `main.ts:2646-2696` | native dialogs/menus | K |
| `openPath`, `openExternalUrl`, `openPathWithProgram`, `showInFolder` | `main.ts:2568-2571`, `2638-2640` | shell integration | K |
| Clipboard: `copyImageToClipboard`, `copyTextToClipboard`, `getClipboardText` | `main.ts:2641-2645` | clipboard | K |
| `sendNotification` | `main.ts:2573-2577` | native notification | K |
| `getFonts`, `initFonts` | `main.ts:2582`, `2705` | stubs/empty | X |
| `setLoggerEnabled`, `setTrackingEnabled`, `changeLanguage`, `applyTheme`, `isBinDownloaded`, `downloadBin`, `ensureBinVersion`, `bunInstallInTempFolder`, `startOauthServer`, `stopOauthServer` | `main.ts:2578-2588` | no-op stubs | X |

### 2.2 Chat sessions and agent turns

| Channel | Evidence | Domain operation | Disposition |
|---|---|---|---|
| `chat:create` | `main.ts:2216` | `SessionService.create` | D |
| `chat:load` | `main.ts:2217` | `SessionService.get` | D |
| `chat:list` | `main.ts:2218` → `979-988` | `SessionService.list` | D |
| `chat:delete` | `main.ts:2219-2222` | `SessionService.delete` | D |
| `chat:branch` | `main.ts:2223-2234` | `SessionService.branch` (must not copy the engine session ref) | D |
| `agent:send` | `main.ts:2235` → `1853-1978` | `TurnService.run`; returns `{runId}` today, becomes `POST /api/turns/{turnId}/stream` | D |
| `agent:stop` | `main.ts:2236-2239` | `TurnService.cancel` | D |
| `agent:event` (main → renderer) | `main.ts:1876`, `1960`, `1967`, `1971`; consumed at `app.tsx:490-510` | domain events → SSE | D |

Runtime facts that must be preserved *inside* the engine adapter:

- `runAgent` loads settings, **merges `request.settings` and writes them to
  `settings.json` on every send** (`main.ts:1854-1856`). The new API must split
  “persist settings” from “start turn”; per-turn overrides are not persisted
  implicitly.
- `resumeSessionId` comes from `chat.claudeSessionId` (`main.ts:1858`). This value
  must become the hidden `engine_session_ref` and never cross the HTTP boundary.
- `noSessionPersistence` is forced to `false` so follow-up turns can resume
  (`main.ts:1859-1863`).
- User message is appended before the async loop (`main.ts:1870`); the assistant
  message is appended after the stream (`main.ts:1963-1966`).
- The session id is captured from the CLI result event (`main.ts:1946-1948`).
- Event mapping is duplicated in `main.ts:1951-1960`; it belongs in the engine
  adapter.
- Artifacts are materialized from assistant text at the end of a turn
  (`main.ts:1964` → `1160-1177`); this belongs in `TurnService` +
  `ArtifactStorePort`.
- The current UI allows **one active turn per chat** (`app.tsx:272`, `449`);
  enforce this in the service.

### 2.3 Artifacts

| Channel | Evidence | Domain operation | Disposition |
|---|---|---|---|
| `artifact:create` | `main.ts:2241-2245` | `ArtifactService.create` | D |
| `artifact:list` | `main.ts:2246`, `642-646` | `ArtifactService.list` | D |
| `artifact:load` | `main.ts:2247-2252` | `ArtifactService.get` | D |
| `artifact:open` | `main.ts:2253-2256` | `ArtifactService.mark_opened` + native window | D + K |
| `artifact:source` | `main.ts:2257-2259` | `ArtifactService.content` (folded into `GET /api/artifacts/{id}/content`) | D |
| `artifact:versions` | `main.ts:2260`, `680-695` | `ArtifactService.get` (versions folded into metadata) | D |
| `artifact:export` | `main.ts:2261`, `697-714` | `ArtifactService.export` + native save dialog | D + K |
| `artifact:import` | `main.ts:2262`, `716-740` | `ArtifactService.import` + native open dialog | D + K |
| `artifact:event` (push) | `main.ts:638`, consumed `app.tsx:340-347` | invalidation via `/api/events` | D |

Artifact persistence details (hidden behind `ArtifactStorePort`): manifest at
`userData/artifacts/manifest.json` (`main.ts:415-417`), version files
(`411-413`, `658-661`, `671`), HTML shell with Mermaid CDN (`447-551`), metadata
script injection/extraction (`423-445`).

### 2.4 MCP, skills, autowork, workspace

| Channel | Evidence | Domain operation | Disposition |
|---|---|---|---|
| `mcp:list` | `main.ts:2269`, `1590-1596` | `McpService.list` | D |
| `mcp:save` | `main.ts:2270`, `1611-1639` | `McpService.upsert` | D |
| `mcp:toggle` | `main.ts:2271-2273`, `1641-1654` | `McpService.enable/disable` | D |
| `mcp:discover` | `main.ts:2274-2276`, `1656-1694` | `McpService.discover` | D |
| `mcp:delete` | `main.ts:2277-2283` | `McpService.remove` | D |
| `skill:list` | `main.ts:2404-2406`, `2306-2389` | `SkillService.catalog` | D |
| `skill:toggle` | `main.ts:2408-2441` | `SkillService.enable/disable` (hides directory moves) | D |
| `autowork:call-mcp-tool` | `main.ts:2263`, `1713-1744` | `McpService.invoke`; dispatches internal `visualize` tools first (`src/autowork/visualize.ts:195-243`) | D |
| `autowork:ask-claude` | `main.ts:2264`, `1746-1815` | `TurnService.ask` (one-shot, `maxTurns ≤ 8`, no persistence) | D |
| `autowork:run-scheduled-task` | `main.ts:2265` | stub returning error | X |
| `autowork:navigate-host` | `main.ts:2266`, `1817-1830` | artifact-window history | K |
| `autowork:open-external-url` | `main.ts:2267` | duplicate shell capability | K |
| `workspace:git-status` | `main.ts:2443-2459` | `WorkspaceService.status` (aggregate) | D |
| `getGitDefaultBranch`, `getGitBranches`, `getGitDiffStat`, `getGitDiffFiles`, `getGitDiffFileContent`, `switchGitBranch`, `initGitRepository` | `main.ts:2546-2567`; `chatwise/git.ts:51-148` | `WorkspaceService.status/diff/switch_branch/init` | D |
| `discoverSkill` | `main.ts:2514-2520` | `SkillService.discover` | D |
| `glob`, `globTool` | `main.ts:2521-2531` | engine-owned Glob; no UI consumer | X |
| `grep` | `main.ts:2532-2545` | engine-owned Grep; no UI consumer | X |

### 2.5 Generic filesystem, DB, transport (legacy ChatWise compatibility layer)

These are not used by the current React renderer (`src/renderer/app.tsx` only calls
the bridge methods defined in `src/preload.ts:31-75`).

| Channel(s) | Evidence | Disposition |
|---|---|---|
| `readTextFile`, `readFileAsBase64`, `readFileBinary`, `readFile`, `readDir`, `writeTextFile`, `writeFile`, `removePath`, `pathStats`, `createDir`, `copyFile`, `zipFolder`, `unzipFile`, `pathExists`, `ensureDir`, `resolveInAppDataDir`, `resolveInAppFiles`, `saveRecordingAsWav` | `main.ts:2589-2637` | X — no renderer consumer; backend owns its own filesystem adapters. |
| `dbGet`, `dbAll`, `dbExecute` | `main.ts:2502-2510` | X — arbitrary SQL, a direct representation leak. |
| `electron-fetch:request`, `electron-fetch:abort:*` | `chatwise/transport.ts:19-65` | X — SPA can fetch the local backend directly. |
| `electron-exec:request`, `electron-exec:event` | `chatwise/transport.ts:67-123` | X — subprocess management is hidden in the engine adapter. |

### 2.6 Collapsed operations (coarse-grained)

The 100+ channels above collapse into these domain operations:

```
BootstrapService.read
SessionService.{list,create,get,rename,delete,branch}
TurnService.{run,cancel,status,ask}
SettingsService.{read,update,provider,providers}
SkillService.{catalog,discover,enable,disable}
McpService.{list,upsert,remove,enable,disable,discover,invoke}
WorkspaceService.{status,diff,switch_branch,init}
ArtifactService.{list,create,get,content,mark_opened,export,import}
```

This is the anti-corruption boundary: legacy channel names do not appear in the
HTTP surface, and CLI/SQL/frame concepts do not appear in the DTOs.

---

## 3. Preload bridge

`src/preload.ts:23-93` exposes three globals:

- `window.api` / `window.autoagent` — 35 methods (`preload.ts:31-75`), including
  chat CRUD, send/stop, artifacts, MCP, skills, git, openExternal and the two event
  subscriptions (`onAgentEvent`, `onArtifactEvent`).
- `window.ipcRenderer` — raw `invoke`/`send`/`on`/`off` (`preload.ts:6-21`). This
  is a generic escape hatch and a representation leak; the new preload must not
  expose it.
- `window.__electronFetchInternal` — streaming fetch bridge (`preload.ts:79-90`);
  drop once the SPA talks HTTP directly.

`src/artifact-preload.ts` exposes `window.autowork` / `window.cowork` with
`callMcpTool`, `askClaude`, `sample`, `runScheduledTask`, `navigateHost`,
`openExternalUrl`, plus back/forward mouse handling (`artifact-preload.ts:5-38`).
After migration, artifact windows should call the backend API with the same
per-launch token; only `navigateHost`/`openExternalUrl` remain native.

The new preload should be explicitly allow-listed: window controls, dialogs,
clipboard, shell, notifications, theme, accent color, artifact window. It must not
carry business data or generic `invoke`.

---

## 4. Engine client (`src/engine-client.ts`)

This is the most important module to port and hide behind `EnginePort`. It is
**not** a long-running process despite the README claim: every `query()` spawns a
fresh CLI process and kills it in `finally` (`engine-client.ts:309-388`,
`390-391`, `463-468`).

| Behavior | Evidence |
|---|---|
| Tokenize configured command (quotes/shell words) | `38-55` |
| Windows `.bat/.cmd` spawn through `cmd.exe /d /c` | `57-79` |
| Probe `--help` once per command, cache supported flags | `81-140` |
| Only pass flags the CLI advertises | `142-156` |
| Build args: `-p --input-format stream-json --output-format stream-json` | `395-401` |
| `--verbose`, `--include-partial-messages`, `--include-hook-events`, `--debug` | `403-406` |
| Thinking/effort/budget/turns/model/agent/permission/json-schema | `408-424` |
| Tools/MCP/betas/setting sources/add-dir/plugins/channels | `426-435` |
| Session: `--session-id`, `--fork-session`, `--continue`, `--resume`, `--resume-session-at`, `--no-session-persistence` | `436-443` |
| Env: `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES=1`, `CLAUDE_CONFIG_DIR`, optional `AUTOAGENT_RG_PATH`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_CUSTOM_MODEL_OPTION` | `446-459` |
| Writes user message JSON line to stdin, then closes stdin | `509-520`, `365-367` |
| Writes `control_request initialize` with `appendSystemPrompt` | `522-536` |
| Auto-approves `can_use_tool` control requests | `538-553` |
| Reads stdout line-by-line, parses JSON | `555-566` |
| Maps CLI messages → `tool_start`, `text_delta`, `assistant`, `tool_result`, `result`, `error`, `interrupted` | `244-283`, `333-357` |
| Abort sends `SIGINT`; `stop()` sends `SIGTERM`, then `SIGKILL` after 2s | `299-307`, `352-356` |
| Base URL normalization strips `/chat/completions` and `/v1` | `569-571` |

All of the above is **hidden implementation** in the target:

- `EnginePort.start_turn/stream/cancel/status` is the only surface the
  `TurnService` sees.
- `SubprocessEngine` owns argv, probing, env, resume, retries and signals.
- `MateBotEngine` owns coordinator framing and reconnection; it adapts to the same
  `EnginePort` (Adapter pattern, `ch08_设计模式.md:417-457`).
- `DomainEvent` is the abstraction; raw stream-json never reaches the service or
  the SPA.

Notes for parity:

- Thinking deltas are mapped to `text_delta` (`255-257`), i.e. current UI shows
  reasoning as normal assistant text. The domain model should distinguish them.
- `error` terminal path also emits an error if the process closes before `result`
  (`344-349`).
- `extractEngineText` (`main.ts:1030-1066`) supports several historical CLI
  shapes; the Python adapter must replicate the same tolerance internally.

---

## 5. Persistence and data locations

| Data | Location | Evidence |
|---|---|---|
| Settings (incl. plaintext `apiKey`) | `userData/settings.json` | `main.ts:922-925`, `2185` |
| Local/UI settings (theme) | `userData/local-settings.json` | `main.ts:2462-2465`, `2697-2704` |
| Chat sessions | `userData/sessions/<uuid>.json` (`ChatRecord`) | `main.ts:979-1013` |
| MCP servers | `userData/chatwise.db`, SQLite `tool` table | `main.ts:1304-1313`, `1590-1638` |
| Other ChatWise tables (`chat`, `message`, `provider`, …) | same DB, created/migrated but unused by the UI | `main.ts:1315-1461` |
| Enabled skills | `userData/skills.json` (array of names) | `main.ts:2296-2304` |
| Artifact index | `userData/artifacts/manifest.json` | `main.ts:415-417`, `553-583` |
| Artifact content/versions | `userData/artifacts/<id>/index.html`, `versions/<ms>.html`, `thumbnail.png` | `main.ts:395-413`, `648-678` |
| App files | `userData/files/...` | `main.ts:1284`, `2603-2606` |
| Engine log | `<tmp>/autoagent-userdata/engine.log` | `engine-client.ts:16-31` |
| Desktop log | `${XDG_STATE_HOME:-~/.local/state}/autoagent/logs/desktop.log` | `RUNTIME_PATHS.md:210`, `packaging/deb/usr/bin/autoagent:9` |

Resolved `userData` roots:

- Linux: Electron default `~/.config/autoagent` (app name set at `main.ts:328`).
- Windows: forced to `%TEMP%\autoagent-userdata` (`main.ts:321-323`).
- macOS: `~/Library/Application Support/autoagent`.

These are **representations**. After migration, the SPA sees `ArtifactView`,
`SessionView`, etc.; only the adapters know these paths.

`src/db/index.ts` and `src/db/schema.ts` are **dead code**. `getDatabase()` is not
imported anywhere (verified by grep); its default path `${process.cwd()}/autoagent.db`
(`db/index.ts:9`) is never created. Do not migrate it.

`DesktopSettings` has 50+ fields (`main.ts:52-102`); the full list and defaults are
at `main.ts:854-906`. The public `SettingsView` is deliberately much smaller; CLI,
session and advanced fields stay inside `SettingsPort`.

---

## 6. Renderer surface and feature ranking

`src/renderer/app.tsx` is a single 1048-line component tree.

### 6.1 Implemented user-visible features

| Feature | Evidence | v1 rank |
|---|---|---|
| Session sidebar: list, create, select, delete | `app.tsx:631-652`, `379-407` | **Must** |
| Session branching | `app.tsx:409-415`, `646` | Later |
| Chat transcript with markdown/GitHub-flavored markdown/sanitized HTML | `app.tsx:694-702`; `message-content.tsx:539-581` | **Must** |
| Streaming assistant text | `app.tsx:463-509` | **Must** |
| Tool events rendered as `<pre>` | `app.tsx:486-488`, `493-499`, `793-794` | **Must** |
| Stop run | `app.tsx:512-517`, `683` | **Must** |
| Error/system message rendering | `app.tsx:500-503`, `788-794` | **Must** |
| Composer (Ctrl/Cmd+Enter) | `app.tsx:704-718` | **Must** |
| Provider + model selection | `app.tsx:871-874`, `430-435` | **Must** |
| Core agent settings (provider, model, base URL, API key, workspace, permission, thinking/effort/budgets/turns/tools) | `app.tsx:865-927` | **Must** (narrowed `SettingsView`) |
| Workspace directory picker | `app.tsx:437-444`, `887` | **Must** |
| Run status and cwd in header | `app.tsx:670-692` | **Must** |
| Layout persistence (panel widths/open state) | `app.tsx:288-335`, `676-690` | Later (polish) |
| MCP server list/edit/toggle/discover | `app.tsx:929-954` | Later |
| Skill scan/toggle + source dirs | `app.tsx:995-1012` | Later |
| Git workspace panel (stat, branches, changed files) | `app.tsx:1014-1032` | Later |
| Artifact list/open/export/import/versions | `app.tsx:961-993` | Later |
| Inline `artifact-html` preview and “create artifact” | `message-content.tsx:329-411` | **Must** (chat output) |
| `artifact-ref` preview cards | `message-content.tsx:413-513` | Later |
| Mermaid rendering | `message-content.tsx:286-326` | Later (nice) |
| Code blocks + `code-stats` metric cards | `message-content.tsx:232-284` | **Must** (code blocks), metric cards later |
| Autowork/visualize internal tools | `src/autowork/visualize.ts:195-243` | Later |
| Native notifications | preload only; no renderer call found | Later |
| Theme | `local-settings.json`, read in `main.ts:2751-2753` | Later |

### 6.2 Renderer quirks that must not silently change

- `toggleSkill` (app.tsx:571-580) updates `appendSystemPrompt` in React state but
  **does not call `saveSettings`**; the injected skill list only takes effect after
  the user presses Save. `SkillService` should own skill injection explicitly.
- `submitPrompt` sends the entire settings object on every message
  (`app.tsx:455-459`), and the backend persists it (`main.ts:1854-1856`). The API
  should split “send turn” from “persist settings”.
- Live messages are discarded on `done` and the chat is reloaded from disk
  (`app.tsx:504-509`), so any stream event not persisted server-side is lost.
  `TurnService` must persist the completed assistant message.
- The renderer never calls the generic file/db/exec/fetch IPC layer; those are
  inherited ChatWise scaffolding and can be dropped.

---

## 7. Dead, stale and unsafe legacy pieces

| Item | Evidence | Action |
|---|---|---|
| `src/db/*` | no imports | Delete |
| `src/providers/factory.ts` | imports `@ai-sdk/*`, none of which are in `package.json`; no imports from app | Delete |
| Generic SQL IPC | `main.ts:2502-2510` | Delete |
| No-op stubs | `main.ts:2578-2588` | Delete |
| `chatwise` DB tables other than `tool` | `main.ts:1315-1461` | Do not migrate |
| README claim of a persistent CLI process | `README.md:43-44` vs `engine-client.ts:350-352`, `390-391` | Update docs; the Python adapter may choose per-turn or resident (`--matebot`) internally. |
| Plaintext API key | `settings.json`, `main.ts:2138-2155` | Keep local-only; never return it in DTOs; never log. |
| Generic `ipcRenderer` exposure | `preload.ts:6-21` | Remove; allow-list native methods only. |
| Renderer `sandbox:false` | `main.ts:2027` | Turn on; the SPA no longer needs Node. |

---

## 8. Porting surface summary

Modules that move behind ports in the Python backend:

| Legacy module | Target port/service |
|---|---|
| Settings load/normalize/save + `.claude.json` sync (`main.ts:854-957`, `2126-2162`) | `SettingsPort` / `SettingsService` |
| Chat JSON CRUD (`979-1028`) | `SessionStorePort` / `SessionService` |
| Engine spawn/stream/abort (`engine-client.ts`) | `EnginePort` (`SubprocessEngine`) |
| MateBot coordinator transport (future) | `MateBotPort` (`MateBotEngine`) |
| Turn orchestration + artifact materialization (`1853-1977`, `1030-1177`) | `TurnService` |
| MCP registry + client (`1490-1744`) | `McpRegistryPort` / `McpService` |
| Skill scan/toggle (`2284-2441`) | `SkillCatalogPort` / `SkillService` |
| Artifacts (`395-773`, `642-748`) | `ArtifactStorePort` / `ArtifactService` |
| Git (`chatwise/git.ts`) | `WorkspacePort` / `WorkspaceService` |
| Provider catalog (`providers/config.ts`) | `SettingsPort` |

Modules that stay in Electron:

- Window creation/loading, single instance, menus, native dialogs, clipboard,
  shell open, notifications, window controls, artifact child window, backend
  lifecycle and the `AUTOAGENT_LEGACY` switch.
