# Claude Desktop 2.42304.0 Linux 的 MCP 端到端集成研究

> 研究对象：`/home/tars/yysapp/claude-desktop/app`（minified JS）与
> `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources`。
> 只读研究，未修改 `app/` 或 `extracted/`。所有偏移均为 JS 文本中的字符偏移，用于定位，不保证是磁盘字节偏移。
>
> 版本：`2.42304.0`（`app/package.json`）。
> 主入口：`.vite/build/index.pre.js`；共享大 chunk：`index.chunk-Z7WxBjyE.js`（7.0 MB）；
> Agent SDK / Claude Code 相关：`index.chunk-DNyequwM.js`、`index.chunk-BvLvPLAH.js`、`index.chunk-D7Cps41t.js`。

---

## 1. 结论速览

1. Claude Desktop 的 MCP 不是一个单层实现，而是 **四层并存**：
   - **桌面用户配置层**：`claude_desktop_config.json` 的 `mcpServers`，本质是 stdio 服务器 + 可选 `extensionId`。
   - **扩展/DXT 层**：已安装、已启用的 Desktop Extension 通过 manifest 的 `server.mcp_config` 生成 stdio 配置。
   - **企业/托管直连层**（3P/custom3p）：`managedMcpServers` + 组织插件 MCP，由主进程直接连 HTTP/SSE，工具 schema 在主进程缓存，并通过代理暴露给会话。
   - **Claude Code / Agent SDK 层**：`.mcp.json`、`.claude/settings.json`、`~/.claude.json`、`--mcp-config`、`strictMcpConfig` 与 `managedMcpServers`；传输类型最全（stdio/sse/http/ws/sdk/claudeai-proxy）。
2. **桌面本地 MCP 的连接方式很特别**：主进程负责 spawn 服务器，然后把一个 `MessagePort` 通过 `mcp-server-connected` 事件交给 renderer；renderer 自己作为 MCP client 完成 `initialize`/`tools/list`/`tools/call`。主进程只做生命周期、日志、状态和策略。
3. **stdio 帧格式是 newline-delimited JSON**，不是 Content-Length：逐行读、允许 `\r`、最大缓冲 10 MB。
4. **环境隔离明确**：Linux 下只继承 `HOME, LOGNAME, PATH, SHELL, TERM, USER`，再叠加用户配置的 `env`。
5. **审批是分层的**：配置/托管层 `toolPolicy`（allow/ask/ask-session/blocked，取最严格）→ 用户逐工具开关（`mcp-user-tool-toggles.json`）→ 会话运行时 `ask` 的逐次审批 → Claude Code 权限规则（`mcp__server__tool` 的 allow/ask/deny）→ `canUseTool` 回调。
6. **破坏性工具不是仅凭 `destructiveHint` 就自动放行**：`ask` 策略下每次调用都要审批；Auto 模式下破坏性 connector 工具会覆盖“总是允许”（gate `4200321681`）。
7. **OAuth 实现完整**：PRM / RFC 8414 / OIDC discovery、PKCE S256、loopback callback（默认 `127.0.0.1:53280/callback`）、DCR/CIMD、scope 约束、safeStorage 加密 token、5 分钟提前刷新、指数退避、401/403 单次重试。
8. **内置服务器只有三个真正的“bundled server”入口**：`github`、`microsoft365`、`websearch`；且只允许 `source === "admin"`。GitHub 是 20 MB 静态 ELF；Office365 是 7.3 MB 的 `.mjs`，由内置 Node utility process 承载。
9. **DXT/.mcpb 是 stdio 扩展包格式**，manifest v0.1–v0.4，支持 node/python/binary/uv runtime、`user_config`（敏感字段 safeStorage 加密）、签名状态、黑名单、组织策略与开发者模式。
10. **MCP Apps (`ui://`)** 是独立于 DXT 的 UI 扩展：工具 `_meta.ui.resourceUri` 指向 `ui://` 资源，能力声明 `io.modelcontextprotocol/ui` + `text/html;profile=mcp-app`，widget 在 `*.claudemcpcontent.com` iframe 中运行，并受 CSP/权限与组织“非必要服务”开关约束。
11. 外部直接修改 `claude_desktop_config.json` 后，**没有找到自动文件监听器**；代码里提供菜单“Reload MCP Configuration”和 `setMcpServerConfigs` 写入后重载路径。更稳妥的结论是：外部编辑通常需要重载/重启（见 §3.5）。
12. **最大风险点**：桌面 `claude_desktop_config.json` 的 schema 非常窄（只有 command/args/env/extensionId），但扩展、企业直连、Claude Code 各自有完整 schema；把三套 schema 混在一起会导致错误的信任边界。

---

## 2. 架构 / 数据流图

### 2.1 桌面本地 MCP（stdio / DXT）

```
Renderer (mainView)
  │  1. invoke IPC "MCP_$_getMcpServersConfig" / getMcpServersConfigWithStatus
  │  2. send   "connect-to-mcp-server" {serverName}
  ▼
Main process (index.chunk-Z7WxBjyE.js)
  │  TY() = extension configs (y9r) + user config (dei)
  │  D5r(serverName):
  │    ├─ g8r() era probe（可选，只有内置 Node 通道）
  │    ├─ UHt() 选择 runtime:
  │    │    built-in Node → utilityProcess.fork(nodeHost.js)
  │    │    node/python    → 系统解释器（semver 匹配）
  │    │    uv            → dynamic-uv
  │    │    其他 binary    → exec + process group reaper
  │    ├─ MessageChannelMain:
  │    │    port1 → M8r（主进程 ↔ 服务器桥）
  │    │    port2 → renderer（作为 MCP client 端口）
  │    └─ V8r 包装：工具列表拦截、注入工具、DXT prompt 校验
  │
  └─ postMessage "mcp-server-connected" {serverName, uuid, prior}, transfer port2
         │
         ▼
Renderer MCP client: initialize → tools/list → tools/call
```

关键证据：
- IPC schema：`Z7:1583817`（`Rg=ro(Ig,"MCP",...)`，方法/事件列表）。
- preload 暴露：`/home/tars/yysapp/claude-desktop/app/.vite/build/mainView.js:3618`（`getMcpServersConfig`、`onMcpStatusChanged` 等）。
- 连接握手：`Z7:6522722`（`KUa(eo.ConnectToMcpServer, ...)`，发送 `eo.McpServerConnected` 并 transfer port）。
- 通道枚举：`Z7:530102`（`ListMcpServers`、`ConnectToMcpServer`、`McpServerConnected`、`RequestOpenMcpSettings`、`McpServerAutoReconnect`）。
- spawn：`Z7:4429334`（`D5r`）、`Z7:2089700`（`LHt` 进程组）、`Z7:2091013`（`UHt`）。
- 桥接：`Z7:4415k–4420k`（`M8r`、`V8r`、prompt 校验、注入工具）。

### 2.2 企业/托管远程 MCP（custom3p / direct pool）

```
Managed config / org plugins
  │  managedMcpServers: [{name,url,type,oauth,headers,...}]
  │  orgPluginSettings: {...}
  ▼
Main "custom3p-mcp" pool (Z7:~2198k)
  ├─ mergePluginConfigs(): admin managed + org-plugin，同名冲突丢弃 plugin
  ├─ jqt(): 并发 connect
  │    ├─ builtin (github/m365/websearch) → ph()
  │    ├─ transport === "stdio"        → Pqt()（仅 admin + MDM 认可）
  │    └─ 其他                          → Fqt()
  │         └─ directMcpHost.js utility process
  │              SSE: ex；Streamable HTTP: ax
  │              10s connect / 60s tools discovery
  │              session 404 → close/repark；3 次 terminal error → close
  └─ 连接结果写入 connectedMcp / pendingOAuth
        │
        ├─ 工具 schema 缓存在 store key "directMcpToolSchemas"
        └─ 通过 proxy manager 暴露给会话（callRemoteTool/readRemoteResource）
```

证据：`Z7:2198398`、`Z7:2203632`、`Z7:2104732`、`/home/tars/yysapp/claude-desktop/app/.vite/build/mcp-runtime/directMcpHost.js:~608k–613k`。

### 2.3 Claude Code / Agent SDK 路径

```
Desktop session manager
  ├─ 收集 mcpServers / remoteMcpServersConfig / enabledMcpTools
  ├─ 生成 --mcp-config 临时文件（extraArgs["mcp-config"]）
  ├─ strictMcpConfig（某些 host/launcher 场景强制）
  └─ spawn Claude Code CLI（JSON stream-json 协议）
        ├─ .mcp.json（project）
        ├─ .claude/settings.json / settings.local.json
        ├─ ~/.claude.json
        ├─ managed settings（MDM/OS policy/managed-settings.json）
        └─ 连接 SDK 内置 MCP server / claudeai connectors / local MCP
```

证据：`/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-BvLvPLAH.js:548811`（`mcp-config` 参数）、`BvLvPLAH:80788`（`.mcp.json` 探测）、`index.chunk-DNyequwM.js:1131265`（`strictMcpConfig`）。

---

## 3. 配置模型与优先级

### 3.1 桌面用户配置：`claude_desktop_config.json`

**位置**：`app.getPath("userData")/claude_desktop_config.json`。
证据：`Z7:1672817`（`g_()`），`Z7:841368`（`Vze="claude_desktop_config.json"`，`Hze=1048576` 上限）。

**加载**：同步读取（`readFileSync`）+ 进程内缓存；`getMcpServersConfig(forceReload)` 可强制重读。
证据：`Z7:1672942`（`imt()`），`Z7:1676089`（`x_(forceReload)`）。

**Schema（非常窄）**：

```ts
mcpServers: Record<string, {
  command: string
  args?: string[]
  env?: Record<string,string>
  extensionId?: string
}>
```

证据：`Z7:1543712`（`Og=j({command,args,env,extensionId})`，`kg=M(D(),Og)`）。
注意：**没有 `type/url/headers`**。桌面用户配置里的 MCP 只能是 stdio。

**有效性**：逐条 `Og.safeParse`；非法条目被丢弃，启动后弹窗列出名字。
证据：`Z7:1675331`（`cmt()`、`lmt()`、`umt()`）。

**其他字段**：同一文件还承载应用设置（`features.isLocalDevMcpEnabled`、`isUsingBuiltInNodeForMcp`、`isDxtAutoUpdatesEnabled` 等）。
证据：`Z7:1672069`（`rmt` schema）。

### 3.2 扩展/DXT 配置

- 安装后的扩展读取 settings 文件（`Xb(id)`），`isEnabled`、`orgBlockedReason`、`userConfig`。
- `userConfig` 中 `sensitive: true` 的字段以 `__encrypted__:` 前缀 + Electron `safeStorage` 加密存储。
- 扩展 manifest 的 `server.mcp_config` 经过 `${__dirname}`、`${pathSeparator}`、`${user_config.x}` 替换后，产出 stdio `{command,args,env}`，再附加 `extensionId`。
- 必填 user_config 缺失时跳过该服务器。
- 平台覆盖：`platform_overrides[process.platform]` 覆盖 command/args/env。

证据：`Z7:4482566`（`y9r()`），`Z7:4482271`（`v9r()`），`Z7:1534236`（`nst()`），`Z7:4441081`（`tY()`）。

### 3.3 合并与优先级（桌面）

`TY(forceReload)`：

1. `y9r()` 取所有已安装、已启用、未被组织策略阻断的 DXT 服务器配置。
2. `dei()` 取用户 `claude_desktop_config.json` 的 `mcpServers`（去掉 `extensionId`），但**仅当** `mcp.localStdioEnabled` 为真且 `features.isLocalDevMcpEnabled !== false`。
3. `Object.assign(Object.create(null), extensions, user)`：**用户同名服务器覆盖扩展服务器**。
4. 更新内部服务器名集合与扩展归属映射。

证据：`Z7:4487452`（`TY`/`dei`），`Z7:3289228`（`m$n()`）。

**disabled 语义**：
- 用户配置的“本地开发 MCP”总开关关闭时，`dei()` 返回空对象 → 用户服务器全部不加载。
- 扩展 `isEnabled=false` 或 `orgBlockedReason` 非空 → 不加载。
- HIPAA/Cowork 场景下，没有安装元数据的扩展会被拒绝（`dxt_unrecorded`）。
证据：`Z7:4482566`。

### 3.4 企业/托管配置优先级（桌面 3P）

- `managedMcpServers` 来自托管配置（MDM/OS policy/managed settings），只接受 **http/sse**，必须 https，禁止 `command/args/env/headersHelper`，禁止 `${VAR}` 展开，禁止控制/不可见字符。
- 组织插件 MCP 与 managed 同名时，插件被丢弃。
- `allowedPluginServers` / `deniedPluginServers` 用 URL pattern 允许/阻断插件远程服务器。
- `localStdioEnabled` 控制是否允许用户本地 stdio MCP；默认 true，但 fail-closed 值为 false。
- 托管策略存在时，设置 `strictPluginOnlyCustomization:["mcp"]`、`allowManagedMcpServersOnly:true`、`allowedMcpServers`、`deniedMcpServers`，并映射到 Claude Code 设置。

证据：`/home/tars/yysapp/claude-desktop/app/.vite/build/index.pre.js:479797`、`pre.js:581905`、`pre.js:582378`、`pre.js:583006`；`Z7:2101995`、`Z7:2106431`（`AUt/jUt/MUt`）；`DNyequwM:825739`、`DNyequwM:825812`。

托管 MCP 条目字段（桌面侧）：
```ts
{
  name, server: "github"|"microsoft365"|"websearch"|...,
  url?, type?: "http"|"sse"|...,
  toolPolicy?: Record<toolName, "allow"|"ask"|"ask-session"|"blocked">,
  oauth?, headers?, headersHelper?, sensitivityLabels?, azureCloud?, scope?, ...
}
```
证据：`pre.js:479797` 附近（`WI.safeParse`、`toolPolicy`、`sensitivityLabels`）。

### 3.5 重载

- `setMcpServerConfigs` → `bmt` → `ymt`：写回 `claude_desktop_config.json`，对删除的服务器调用 `reconcileRemovedMcpServers`，然后向 renderer 推送 `mcpConfigChange`。
- 菜单 “Reload MCP Configuration” → `N5r(await TY(true))`。
- `M5r` 关闭全部 MCP、清缓存、推送完整配置、通知 remote tools 设备。
- **没有找到对 `claude_desktop_config.json` 的 `fs.watch`/`watchFile`**；自动热重载 [推断为否]，外部编辑需要手动重载或重启。

证据：`Z7:1678246`、`Z7:4437798`、`Z7:4491483`、`Z7:4436426`。

### 3.6 Claude Code 配置层

可见 schema（`DNyequwM:825000–827400`）：
- 传输：`stdio`, `sse`, `sse-ide`, `ws-ide`, `ws`, `http`/`streamable-http`（统一归一化为 `http`）, `sdk`, `claudeai-proxy`。
- scope：`local | user | project | dynamic | enterprise | claudeai | managed | agent`。
- stdio：`command,args,env,timeout,alwaysLoad,bareElicitationCapability,role`。
- sse/http：`url,headers,headersHelper,oauth{clientId,callbackPort,authServerMetadataUrl,scopes,xaa},timeout,request_timeout_ms,tools[{name,permission_policy}],alwaysLoad,discoveryCache,toolPermissions,toolPermissions`。
- `request_timeout_ms` 上限 300000，若给 `request_timeout_ms` 会折叠进 `timeout`。
- `claudeai-proxy`：`url,id,displayName,iconUrl,toolPermissions,stateless,cachedInitResponse,discoverSupport,cachedDiscoverResponse,eligible,ineligibleReason,enterpriseManaged`。

设置项（schema 描述明确）：
- `enableAllProjectMcpServers`：自动批准项目 `.mcp.json` 中所有服务器。
- `enabledMcpjsonServers` / `disabledMcpjsonServers`：逐服务器批准/拒绝。
- `disableClaudeAiConnectors`：任一来源为 true 即禁用 claude.ai connectors；项目级 false 不能覆盖用户级 true。
- `managedMcpServers`：仅托管来源；只接受 http/sse。
- `toolPolicy` / `permissions` 的 allow/ask/deny 规则。

证据：`DNyequwM:939234`、`DNyequwM:825739`、`DNyequwM:939322`。

配置来源探测：
- `.mcp.json`（项目根）；若含 stdio 服务器，会触发“需要完整 tree/沙箱”判定。
- `.claude/settings.json`、`.claude/settings.local.json`；hooks、local marketplace 也会触发 tree。
- `~/.claude.json`（`CLAUDE_CONFIG_DIR` 可覆盖）。
- `--mcp-config` 指向配置文件；`strictMcpConfig` 禁止其他来源。
- 托管 settings（server-managed / MDM / OS policy / managed-settings.json）。

证据：`BvLvPLAH:80788`（`.mcp.json`、settings、hooks、marketplace 探测），`BvLvPLAH:114656`（`.claude`/`.mcp.json` 路径安全），`Z7:3738790`（`AU()` → `~/.claude.json` 或 `$CLAUDE_CONFIG_DIR/.claude.json`），`DNyequwM:1189557`（`STe`：`~/.claude.json` 与 `~/.claude/settings.json`）。

> **优先级**：代码里能确认 scope 名称、显式批准开关、托管约束与 `strictMcpConfig`，但 Claude Code CLI 的最终逐 scope 合并顺序在提取到的 JS 中没有完整实现（CLI 可执行文件不在此包里），因此列为 **[未知]**；文献/推断上通常为 managed > CLI args > local > project > user，但本报告不把它当作已证实。

---

## 4. 传输 / 连接状态机

### 4.1 stdio

- 帧：NDJSON（每行一个 JSON-RPC 对象），`\n` 分隔；行尾 `\r` 被去掉；空/语法错误行被跳过（`SyntaxError` 继续）。
- 单条缓冲上限 10 MB（默认 `maxBufferSize`）。
- 写：`JSON.stringify(msg) + "\n"`。
- 子进程：`shell:false`、stdin/stdout pipe、stderr `inherit|pipe|overlapped`，`windowsHide`。
- 环境：见 §9。
- 进程组：`LHt` 在 POSIX 上作为 process-group leader；退出时触发 graceful/immediate reaper。

证据：`Z7:1164525`（`R5e` / `z5e` / `B5e`），`Z7:1427196`（`sh`），`Z7:2089700`（`LHt`）。

**内置 Node 通道**：
- `utilityProcess.fork(nodeHost.js, [entryPoint,...args])`，serviceName `"Claude Desktop MCP Node Host"`。
- `nodeHost.js` 把子进程的 `stdin/stdout/stderr` 桥接到 `MessagePort`：
  - parent → child：`{type:"stdin", data}`；
  - child → parent：`{type:"stdout"|"stderr"|"fatal-error"|"self-exec-blocked"}`。
- 它拦截 `child_process.spawn/fork/exec*/spawnSync`，阻止 MCP server 通过 Electron 自身的 `process.execPath` 再启动 Node/Electron，返回 `ERR_MCP_NODE_HOST_NOT_NODE`。
- 有 `init` 消息 + MessagePort 才能启动；SIGTERM/SIGINT 直接退出。

证据：`Z7:1430351`（`Drt`），`/home/tars/yysapp/claude-desktop/app/.vite/build/mcp-runtime/nodeHost.js` 全文；`Z7:1429786`（`Crt`）。

**runtime 选择**（DXT）：
- `uv` → dynamic-uv（检查 `pyproject.toml`、确保 uv、`uv sync`）。
- `node` → 内置 Node（若 `isUsingBuiltInNodeForMcp !== false` 且兼容 semver）；否则系统 node（匹配 `compatibility.runtimes.node`，否则最高版本）。
- `python` → 系统 python（匹配 semver，否则最高）。
- 其他/无法解析 → 直接 exec（PATH 查找，Windows 扩展名处理）。
- 启动超时：默认 30 s（Win 60 s；Office365 6e4/3e4）；远程 direct stdio 默认 120 s，可用 `startupTimeoutSec` 覆盖。

证据：`Z7:2021000`（`IRt`）、`Z7:2089700`、`Z7:1430351`。

### 4.2 SSE / Streamable HTTP（directMcpHost）

- 主进程 spawn `directMcpHost.js`（“Custom 3P MCP Host”），通过 `addServer` 消息传配置和 `MessagePort`。
- `transport === "sse"` → SSE transport；否则 → Streamable HTTP transport。
- 连接超时 10 s；tools discovery 超时 60 s；`toolCallTimeoutMs` 默认 300000（配置值 +60000，最低 300000）。
- 协议版本协商：`versionNegotiation: {mode:"auto", probe:{timeoutMs}}`；失败时回退到 legacy initialize 一次。
- 认证：`Authorization` 头可被 `updateAuth` / `updateHeaders` 动态轮换；401/403 且头变化时同一请求重试一次。
- 拒绝重定向：`redirect:"error"`，错误信息要求直接把 URL 指向最终地址。
- session：`Mcp-Session-Id` 过期表现为 HTTP 404 → 关闭连接并等待 repark。
- terminal error 连续 3 次 → 关闭；普通错误会重置计数。
- elicitation：`elicitation/create` 通过 MessagePort 往返；支持 URL mode 和 form mode。
- 请求取消：所有请求带 `AbortSignal`。

证据：`/home/tars/yysapp/claude-desktop/app/.vite/build/mcp-runtime/directMcpHost.js:~608k–613k`（`pE`、`hE`、`IT`、`UT`、`tE`、`gE`），`Z7:2104732`、`Z7:2105996`、`Z7:2106111`。

### 4.3 连接/重连状态机（内置 direct pool）

记录：`{config, desired:"enabled"|"disabled", phase:"spawning"|"connected"|"parked", connection, budget, parkReason, epoch}`。

事件：
- `user-connect` / `user-disconnect` / `config-changed`
- `auth-terminal` / `sign-in-failed`
- `spawn-started` / `spawn-succeeded` / `spawn-failed`
- `connection-closed`

失败预算：
- 18 分钟窗口内连续 5 次，或本次运行累计 15 次 → `budget-exhausted`，停止自动 respawn，UI 显示 “Restart/Connect”。
- 惰性重连冷却 30 s（`bJt=30000`）。
- `needs-auth` / `disabled` 停车时不自动重试。
- `suspend/lock/resume/unlock` 会触发重连/刷新。
- auth cache 清理有 10 s rewipe backstop。

证据：`Z7:887000–898000`（`kWe`、`kd`、`NWe`、`PWe`），`Z7:2191172`（`bJt`）。

**状态枚举**：
- 桌面 IPC 状态：`initializing | running | failed`，附带 `error`。
- Claude Code 初始化统计：`connected | pending | failed | needs-auth | disabled | other`。
- 直连池附加：`unknown | spawning | connected | parked`，parkReason：`needs-auth | crashed | budget-exhausted | transport-closed | keychain-locked`。

证据：`Z7:1543712`（`Dg`），`BvLvPLAH:24003`，`Z7:2167k`（`Cqt` 映射）。

### 4.4 渲染器侧事件

- `mcpStatusChanged(name, status, error)`
- `mcpConfigChange(configs)`
- `mcp-server-auto-reconnect`（服务器名）
- `mcp-server-connected {serverName, uuid, prior}`
- `list-mcp-servers`

证据：`Z7:6522722`、`Z7:530102`、`Z7:1583817`。

---

## 5. 工具发现 / 审批 / 调用

### 5.1 发现与缓存

- **本地 stdio/DXT**：renderer 作为 MCP client 在 MessagePort 上执行 `initialize` 和 `tools/list`；主进程不缓存常规工具表，但会拦截 `tools/list` 响应以注入工具、加描述前缀、剥离工具。
- **远程 direct pool**：主进程在连接时 `listTools`，并写入 store key `directMcpToolSchemas`；parked server 可返回上次缓存工具；配置变化时修剪缓存。并发连接中若尚无结果，也可能把 in-flight 配置暴露出来。
- **未声明 tools capability**：记录 “zero tools” 警告，不强行发 `tools/list`。
- **schema 处理**：原样透传 `inputSchema`、`description`、`annotations`、`_meta`；输出 `structuredContent` 也会透传。
- **DXT**：manifest `tools` / `tools_generated` 只用于声明与校验；真实列表仍来自 server。
- **resources/prompts**：本地/远程走标准 MCP；云 connectors 走 Anthropic 控制面 API。

证据：`Z7:4415k–4420k`（`Q8r` 注入、`V8r` 拦截），`Z7:2192k`（`OJt="directMcpToolSchemas"`），`Z7:2203632`（`parkedServersWithCachedTools`），`Z7:2169k`（zero tools）。

### 5.2 命名规则

- 标准名：``mcp__${sanitize(server)}__${sanitize(tool)}``。
- `sanitize`：`[^a-zA-Z0-9_-]` → `_`。
- 服务器名还要求：不能是 `constructor/prototype/__proto__/__defineGetter__/...`，不能与保留内置名冲突。
- 归一化碰撞检测：大小写、`-`/`_`、非 ASCII、`#no-ascii-head` 等。
- 保留了 `plugin_<plugin>_<server>__tool` 形式。
- 内置保留 server：`cowork`、`session_info`、`dispatch`、`memory`、`scheduled-tasks`、`claude-in-chrome`、`Claude in Chrome`，以及插件/技能/registry 等。

证据：`Z7:4482566`（`xY`、`W9r`、`k9r`、`B9r`、`Z9r`），`DNyequwM:821k`（`Uge`/`Gge`/`k2`），`Z7:2234k`（内置名）。

### 5.3 审批模型

**配置层 `toolPolicy`**：
- 值：`allow | ask | ask-session | blocked`。
- 同一工具多个来源时取最严格：`blocked(3) > ask(2) > ask-session(1) > allow(0)`。
- 通配符匹配（`*`）。
- `blocked` → 直接拒绝；`ask` → 每次调用审批；`ask-session` → 每会话一次（版本 1.21459.0+）。
- 非法值归一化为 `blocked`（fail-closed）。

证据：`Z7:1543712`、`Z7:557k`（`GTe`、`us`、`ds`），`pre.js:445742`，`Z7:2099087`（`Lx`）。

**用户逐工具开关**：
- 持久化在 `userData/mcp-user-tool-toggles.json`，v3 schema：`{v:3, owners:{accountUuid:[disabledToolKey...]}}`。
- 每账号最多 2000 条、总大小 ≤ 4 MB；键形如 `local:<server>:<tool>` 或 `<server>:<tool>`。
- 禁用判断会同时检查 `local:` 和裸 server 键。

证据：`Z7:884k–886k`（`uWe`、`gWe`、`wWe`、`EWe`、`Q`）。

**运行时代理（direct connectors）**：
- `blocked` 或用户禁用 → `Tool 'x' is not permitted`。
- `ask` → 调用方必须提供审批回调；否则返回 `Tool 'x' requires user approval for each call and was not approved`。
- 审批后**重新读取最新配置并再次检查 blocked**，防止审批期间策略变化（TOCTOU 防护）。
- `chat-attested` 且 1P 的特定 origin 可绕过 ask（有严格条件）。
- 远程连接失败/未连接 → `Server 'x' is not connected`。

证据：`c1MnZbIW:487k–491k`（`callRemoteTool`、`sdkSessionPolicyRefusal`）。

**Claude Code 权限规则**：
- 规则字符串：`mcp__server__tool`（通配符 `*` 可用）。
- `allowedTools` / `disallowedTools` / `permissions.allow|ask|deny`。
- 托管 `toolPolicy` 被翻译成 deny/ask 规则。
- 每次请求走 `canUseTool` 回调；可返回 `allow/deny`。
- 未信任/无人值守会话：需要人工批准的请求会被拒绝。
- 伪造的 card-named ask 会被 deny。

证据：`Z7:2099087`、`Z7:2101995`、`D7Cps41t:354000–358500`。

**破坏性/敏感工具**：
- 工具注解：`readOnlyHint, destructiveHint, idempotentHint, openWorldHint`。
- `isDestructiveConnectorTool` = 非本地 MCP 且 `destructiveHint === true`。
- Auto 模式（gate `4200321681`）下，破坏性 connector 的“总是允许”会被覆盖，转为 ask/记录 `lam_auto_mode_always_allow_overridden`。
- 公开 flag 名存在：`disable_destructive_mcp_tools_by_default`、`sensitive_mcps_per_call_consent`、`mcp_tool_approval_config`、`sensitive_mcp_tools`，但**具体实现路径未找到**（只在特征 flag 列表中）→ **[未知]**。

证据：`Z7:1061568`、`Z7:108178`、`c1MnZbIW:492473`、`Z7:5942016`、`D7Cps41t:219349`。

### 5.4 调用、超时、取消与错误

- 本地：renderer client → MessagePort → server。
- 远程 direct：`callTool({name,arguments},{timeout})`；超时由 `toolCallTimeoutMs` 控制。
- `directMcpHost` 捕获 `callTool` 异常：
  - URL elicitation required → 原样抛给上层；
  - 其他 → `{content:[{type:"text",text:"Tool call failed: <sanitized>"}],isError:true}`。
- SDK 代理路径失败 → `Tool call failed — see the desktop main log for detail.`
- 错误文本会做 URL 归约（只保留 origin）、路径/控制字符清理、长度截断（~300/540/1002 字符）。
- 取消：`AbortSignal` / `AbortController`；端口关闭会 drain 所有等待者。

证据：`directMcpHost.js` 尾部（`pE` 的 callTool handler、`lE`、`cE`），`c1MnZbIW:494k`，`Z7:899k`（`QWe`）。

### 5.5 结果渲染

- 透传 `content` 数组与 `isError`；`structuredContent`、`_meta` 在代理/SDK 路径也会保留。
- MCP Apps：若 `_meta.ui.resourceUri` 是 `ui://`，renderer 可把结果渲染为 widget；否则显示文本/结构化内容。
- Resources：`resources/read` 返回 `contents`；超过 10 MB 的 SDK 资源会被拒绝。
- Prompts：DXT 的 `prompts/get` 必须与 manifest 中的模板匹配，否则返回错误。

证据：`BvLvPLAH:696867`、`c1MnZbIW:494k`、`Z7:4416k–4420k`（`I8r`/`P8r`）。

---

## 6. resources / prompts / OAuth

### 6.1 Resources

- 本地/远程 MCP：标准 `resources/list`、`resources/templates/list`、`resources/read`、`resources/subscribe`。
- Desktop proxy：`listRemoteResources`、`readRemoteResource`；若服务器被 `toolPolicy["*"]==="blocked"`，资源读取返回 `BlockedByPolicy`。
- 云 connectors：HTTP `POST /api/organizations/{orgId}/mcp/servers/{uuid}/resources/read`，带 `X-*` account header。
- `ui://` 资源只有在能力/策略允许时才可读；`isDirectMcpResourceBlocked` 用 `toolPolicy("*")` 判定。
- Claude Code 暴露资源工具：`ListMcpResources`、`ReadMcpResource`、`ReadMcpResourceDir`（内部重命名映射）。

证据：`c1MnZbIW:465564`、`c1MnZbIW:466720`、`Z7:2203632`、`BvLvPLAH:696867`、`DNyequwM:821k`（`C2` 映射）。

### 6.2 Prompts

- 标准 `prompts/list` / `prompts/get`。
- DXT 扩展启用 prompt 校验：
  - 只允许 manifest `prompts[].name` 中声明的 prompt；
  - 未声明 → `MethodNotFound`；
  - 返回内容必须与 manifest 模板（支持 `${arguments.x}` 替换）逐字符匹配；
  - 不匹配 → `Prompt content validation failed`，用于防 prompt injection。
- `prompts_generated=true` 时跳过校验。
- 其他来源的 prompts 不做模板校验（只在扩展路径做）。

证据：`Z7:4416k–4420k`（`N8r`、`F8r`、`I8r`、`P8r`、`z8r`）。

### 6.3 OAuth

**发现**：
- 从 `WWW-Authenticate: Bearer resource_metadata="..."` 取 PRM URL；否则请求 `/.well-known/oauth-protected-resource`。
- AS metadata：`/.well-known/oauth-authorization-server`、`/.well-known/openid-configuration`，带路径变体。
- 校验 resource 与配置/expected 一致；issuer 校验可跳过（配置）。
- 支持的 AS 选择：`prm`（默认）、`tenant`、`issuer`、`explicit`。

**PKCE / 客户端**：
- `code_verifier` 43–128 字符；`code_challenge_method=S256`。
- 客户端元数据：`client_name: "Claude Desktop (<version>)"`、`redirect_uris:[loopback]`、`grant_types:["authorization_code","refresh_token"]`、`response_types:["code"]`、`token_endpoint_auth_method:"none"`。
- 默认 callback：`http://127.0.0.1:53280/callback`；可配置 `oauth.callbackPort`、`callbackHost`；支持额外 referrer hosts。
- 支持 DCR（`registration_endpoint`）与 client-id metadata document；托管 admin 可用 Anthropic hosted client assertion（`client_assertion`）。
- 显式 `authorizationUrl/tokenUrl` 在打包版本必须 https。
- 授权服务器在 redirect/callback 间变化时拒绝发送 code/verifier。

**存储**：
- Electron `safeStorage` 加密后放入 store（键包含 `mcp-oauth`、`builtin-mcp-auth`、`custom3pMcpOAuth` 等）。
- 每个 server 记录：`tokens`（密文）、`expiresAt`、`scopeKey`、`hosted`、`brokerGrant`、`urlKey=sha256(url)`。
- URL 改变后旧 token 不会被复用（`urlKey` 不匹配 → 要求重新登录）。
- keychain 不可用 → `keychain-locked` park；safeStorage 不可用 → 不持久化（退化为每次登录）。

**刷新**：
- 到期前 5 分钟刷新（`Bqt=300000`）。
- 失败退避：60 s 起，指数 ×2，上限 30 分钟（`bS=60000`, `Vqt=1800000`）。
- 网络恢复：每 1 s 检查，恢复后 5 s 重试，最多 2 次；离线宽限 30 分钟。
- 401/403：directMcpHost 在 header 轮换后重试一次；否则返回 needs-auth。
- terminal 错误（`invalid_grant`、`invalid_client` 等）→ 停车并清缓存。
- 登出/切换人员：清除该 server 的 auth cache 目录；孤儿目录 1 小时后 sweep。

证据：`Z7:1330k–1333k`（discovery/PRM/WWW-Authenticate），`Z7:1310k–1335k`（PKCE），`Z7:2140k–2175k`（`hS`、token 读写、refresh），`Z7:2172871`、`Z7:899k–901k`（auth cache/wipe）。

**企业 broker**：
- Microsoft 365 支持 OS identity broker（Entra）silent renewal；失败可回退浏览器登录。
- 仅 admin/managed 来源可使用 hosted client identity。
- `clientSecretHelper` 仅 admin/probe-form 来源允许。

证据：`Z7:2140k–2190k`，`WPPTJ-tb.js`。

---

## 7. 内置服务器与 MCP Apps / DXT

### 7.1 内置服务器

只允许 `source === "admin"`；`ph(e,t,n,r)` 按 `e.server` 分派：

| server | 实现 | 启动方式 | 关键点 |
|---|---|---|---|
| `github` | 绑定 `github-mcp-server` 静态 ELF | stdin/stdout pipe | `GITHUB_PERSONAL_ACCESS_TOKEN`, `GITHUB_HOST`, `GITHUB_TOOLSETS`, `GITHUB_READ_ONLY`；30 s 连接；token 加密缓存；工具调用错误时验证 token 并失效；缺 token → needs-auth shell |
| `microsoft365` | `resources/office365-mcp/office365-mcp-stdio.mjs` | `Drt` 内置 Node host | `MCP_AUTH_PUBLIC_CLIENT_ID/TENANT_ID`、`MCP_LOCAL_AUTH_CACHE*`、broker 模式、CAE、敏感度标签、Azure cloud、scopes；30/60 s spawn；MSAL cache 加密；`msal-*` 子进程消息；`proxyTargetHost=graph.microsoft.com` |
| `websearch` | `connectWebSearchBuiltinMcp` | 内部 MCP server | 细节未展开 → **[未知]** |

证据：`/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-ppY_-sIU.js` 全文；`Z7:1446k–1460k`；`Z7:1454k`（`Dit`、`ph`）；`/home/tars/yysapp/claude-desktop/app/resources/github-mcp/github-mcp-server`（ELF, 20 MB, statically linked）；`/home/tars/yysapp/claude-desktop/app/resources/office365-mcp/office365-mcp-stdio.mjs`（7.3 MB）。

**文件系统扩展**：`ant.dir.ant.anthropic.filesystem` 会：
- 注入 `copy_file_user_to_claude`；
- 加 `[This tool operates on the user's computer...]` 描述前缀；
- 对 `list_allowed_directories` 加重要提示；
- 剥离 `read_media_file`；
- 用 args 中的允许目录做路径校验。

证据：`Z7:4429952`（`Q8r` 注入）、`Z7:2089700`。

**内置“伪 MCP” 工具名**（不是外部服务器）：`cowork`、`dispatch`、`memory`、`scheduled-tasks`、`session_info`、`claude-in-chrome`。它们使用 `mcp__<name>__<tool>` 命名，参与权限和碰撞检测。

证据：`Z7:2234k–2237k`。

**Bundled skills**：
- 路径：`app/resources/bundled-skills/manifest.json` + `*.skill`（zip）。
- manifest：`agentSkillsRef`、`skills[{name,description,tier}]`。
- `tier: "always"` 默认启用；`default_false` 则禁用。
- 由 Skills 插件 seed 到本地插件目录，**不是 MCP 服务器**；Claude Code 通过 `Skill` 工具调用。

证据：`/home/tars/yysapp/claude-desktop/app/resources/bundled-skills/manifest.json`；`index.chunk-DlUocsGr.js:16279`（`ge()`、`_e()`、`B()`）。

### 7.2 DXT / .mcpb

**Manifest v0.1–v0.4**（zod schema）：
```ts
{
  manifest_version?: "0.1"|"0.2"|"0.3"|"0.4",
  dxt_version?: same, // deprecated
  name, display_name?, version, description, long_description?,
  author: {name,email?,url?}, repository?, homepage?, documentation?, support?,
  icon?, icons?, screenshots?, localization?, keywords?, license?, privacy_policies?,
  server: {
    type: "python"|"node"|"binary"|"uv",
    entry_point: string,
    mcp_config: {
      command, args?, env?,
      platform_overrides?: Record<platform, Partial<{command,args,env}>>
    }
  },
  tools?: [{name,description?}],
  tools_generated?: boolean,
  prompts?: [{name,description?,arguments?,text}],
  prompts_generated?: boolean,
  compatibility?: {claude_desktop?, platforms?, runtimes?: {python?, node?}},
  user_config?: Record<string, {
    type: "string"|"number"|"boolean"|"directory"|"file",
    title, description, required?, default?, multiple?, sensitive?, min?, max?
  }>,
  _meta?
}
```
证据：`Z7:1526342`（`sot/vot/Pot/Xot/Zot`），`Z7:1525000–1535000`。

**安装**：
- 允许 `.dxt` / `.mcpb`。
- 复制到 `userData/dxt-install-*`；读取 `manifest.json`（≤1 MB）；计算 identity `publisher.name`。
- `signatureRequired` 时 unsigned 拒绝；签名状态 `signed | unsigned | self-signed`，记录 publisher/fingerprint。
- 安全黑名单检查；组织 allowlist 检查；identity 必须与请求安装槽一致。
- 解包有 `requireSigned`；目录复制上限 100,000 条目；总大小有上限；manifest 必须存在。
- 本地未打包安装需要 **Developer Mode**。
- 扩展目录启用还受组织策略 `directoryEnabled` 控制。

证据：`Z7:4475000`、`Z7:4471000`、`Z7:4480000`、`Z7:4464043`。

**隔离**：
- 扩展服务器本质仍是 stdio 子进程；隔离来自：
  - 内置 Node host（禁止自执行 Electron）；
  - 进程组 reaper；
  - manifest 声明的 prompts 校验；
  - 工具列表注入/剥离；
  - 扩展启用/组织阻断检查（启动前和启动后）。
- 扩展 settings 的 `sensitive` 字段加密；扩展目录路径按 ID 隔离。

### 7.3 MCP Apps (`ui://`)

- 能力：`extensions["io.modelcontextprotocol/ui"] = {mimeTypes:["text/html;profile=mcp-app"]}`。
- 工具/资源通过 `_meta.ui.resourceUri` 或 `_meta["ui/resourceUri"]` 指向 `ui://...`。
- `readResource` 对 `ui://` 返回 HTML（`text/html;profile=mcp-app`）；SDK 侧只允许 `ui://`，超过 10 MB 拒绝。
- Widget iframe：
  - 主机域名：`*.claudemcpcontent.com`、`sandbox.claudemcpcontent.com`；
  - 字体资源：`assets.claude.ai`；
  - CSP 指令：`frame-src`；
  - resource 可携带 `_meta.ui.permissions`（如 `clipboardWrite`）和 `csp.connectDomains/resourceDomains`。
- 内置 `imagine` 的 `show_widget` 使用 `ui://imagine/show-widget.html`，允许 `esm.sh/cdnjs/jsdelivr/unpkg/fonts`。
- “Nonessential services” 关闭会禁用 MCP Apps widget，只显示文本结果。

证据：`CQIVLXmn:10603`、`BPeAtel1:5406`、`c1MnZbIW:33599`、`c1MnZbIW:458516`、`Z7:823545`、`Z7:543194`、`bli2ILAi:455449`、`BvLvPLAH:696867`。

> iframe 的具体 `sandbox` 属性（`allow-scripts` 等）在提取到的代码中没有直接定位到 MCP Apps 渲染器；只有另一处通用 CSP 使用 `sandbox allow-scripts` → **[未知]**。

---

## 8. 安全模型

### 8.1 进程/环境

- 环境白名单（Linux）：`HOME, LOGNAME, PATH, SHELL, TERM, USER`；丢弃 `()` 开头的值；再合并用户 `env`。
- stdio `shell:false`，避免 shell 注入。
- 进程组 + reaper；退出时 stop child processes。
- 内置 Node host 阻止 MCP server 用 Electron 可执行文件再起 Node/Electron 子进程；只允许 `nodeHost.js` 白名单入口。
- 远程 direct host 使用 utility process，与主进程隔离。
- `cwd` 可配置，但 RPC 路径安全函数会做 realpath/边界检查。

证据：`Z7:1426842`（`frt`/`prt`），`nodeHost.js`，`Z7:2089700`，`Z7:1430351`。

### 8.2 网络

- 托管 MCP 只允许 https（http/sse 类型，但 URL 必须 https）。
- 远程 direct host 拒绝重定向。
- URL 校验禁止 query/fragment（部分场景）、凭据、反斜杠、疑似 API key/token。
- 云 connectors / MCP 资源走固定 API host；`proxyTargetHost` 固定目的域。
- 组织 egress allowlist 映射为 `WebFetch(domain:...)`；`allowManagedDomainsOnly`。
- SSRF 防护：loopback/私网/元数据地址识别；托管 URL 拒绝 loopback（除显式允许）。

证据：`Z7:2101995`、`Z7:1330k`、`Z7:557k`、`Z7:2117k`。

### 8.3 工具与 prompt

- 工具名保留前缀/名称碰撞检测，防止伪造内置工具。
- 扩展 prompt 内容逐字符校验。
- `_meta` 在跨进程/桥接时做白名单或重写。
- 伪造 card-named ask 直接 deny。
- 无人值守会话需要人工批准的请求被拒绝。
- 定时任务复用审批时，若运行被沙箱路由，则不继承“总是允许”。

证据：`Z7:4482566`、`Z7:4416k`、`D7Cps41t:354k`、`Z7:219349`。

### 8.4 凭据与日志

- OAuth token：safeStorage 加密；每个 server 独立；URL 变化失效；登出清空。
- DXT `user_config.sensitive`：safeStorage 加密，前缀 `__encrypted__:`。
- GitHub/Office365 token/cache：safeStorage；builtin cache 目录按 server+hash 隔离；孤儿 sweep。
- 日志：`mcp-server-<name>.log`，路径 escape 检查；错误 URL 归约；长度截断；日志中不打印 token。
- 敏感文件列表包含 `claude_desktop_config.json` 与 `.claude.json`，用于文件工具的凭据保护。
- 遥测事件中的工具名/服务器名做 clamp/hash/白名单，避免用户文本进入指标。

证据：`Z7:4413k`（`S8r` 日志路径），`Z7:899k`（`QWe`），`Z7:3073572`（敏感文件列表），`Z7:901k`（store keys），`Z7:1446k`。

### 8.5 已知弱点/注意

- 桌面用户配置 schema 不限制 `command` 为绝对路径，也不限制参数；server 由用户主动添加，因此默认信任用户输入。
- 扩展配置来自 manifest + user_config，`${user_config.x}` 直接进入 command/args/env；依靠安装时校验和用户确认，不是运行时沙箱。
- `ask` 之外的自动批准仍依赖工具注解；恶意服务器可以谎报 `readOnlyHint`（[推断] 风险）。
- 远程 MCP 的 `headers` 可由配置提供；`headersHelper` 仅 admin/probe-form 且需轮换。
- MCP Apps 的 HTML 来自服务器；依赖 iframe 域隔离 + CSP；具体 sandbox 属性未验证。

---

## 9. 可借鉴到 AutoAgent（P0/P1/P2）

AutoAgent 现状：Python MCP client + FastAPI + React。

### P0（必须先做）

1. **统一的 MCP Server 配置模型**：
   - 至少区分 `stdio` / `http(s)` / `sse` 三类；AutoAgent 内部统一成 `McpServerConfig`，不要把桌面 `claude_desktop_config.json` 的窄 schema 当成通用模型。
   - 名字校验：`[A-Za-z0-9_-]+`、拒绝 `__proto__` 等、保留内置前缀。
2. **stdio NDJSON 客户端**：
   - 每行 JSON + `\n`；允许 `\r`；单条缓冲上限（10 MB）；语法错误行跳过而不是崩溃。
   - 只继承最小环境变量 + 显式 env；`shell=False`；cwd 明确。
   - `connect timeout`、`list_tools timeout`、`call_tool timeout` 分开配置（建议 120s / 60s / 300s）。
3. **工具命名与权限**：
   - 统一 `mcp__<server>__<tool>`，服务端与前端都用同一套 sanitize。
   - `allow | ask | ask-session | blocked`，多来源取最严格；非法值 fail-closed 为 blocked。
   - `blocked` 在调用入口拒绝；`ask` 每次调用审批，审批后**重新检查策略**（防 TOCTOU）。
4. **连接生命周期**：
   - 状态机 `spawning/connected/parked/failed`，parkReason `needs-auth/crashed/budget-exhausted`。
   - 失败预算：例如 5 次连续 / 15 次总计；冷却 30s；预算耗尽后 UI 显示手动 Connect。
   - 进程退出、父进程退出、取消请求要清理。
5. **凭据安全**：
   - OAuth token 用系统 keyring/KeyVault 加密；按 server + URL hash 隔离；URL 变化失效。
   - 401/403 只重试一次，且必须重新取 token；拒绝重定向；日志只保留 origin。
6. **错误/日志**：
   - 对外错误文本截断/脱敏；对内结构化日志（server、tool、duration、status）；不要把 token/参数全量写日志。

### P1（下一阶段）

1. **OAuth**：PRM + RFC8414/OIDC discovery、PKCE S256、loopback callback、DCR；refresh 提前 5 分钟、指数退避、离线宽限。
2. **resources/prompts**：`resources/list/read`、`prompts/list/get`；prompt 若来自不受信扩展，做模板/来源校验。
3. **工具 schema 缓存**：进程内 + 持久缓存（按 server 版本/配置 hash），失败时可用缓存工具表；配置变化修剪。
4. **状态推送**：WebSocket/SSE 给 React 推送 `mcpStatusChanged` 与 `mcpConfigChange`；区分 initializing/running/failed/needs-auth。
5. **用户逐工具开关**：持久化 disabled tool keys；与策略合并。
6. **工具搜索/延迟加载**：工具多时提供 `ToolSearch` 式入口；服务器配置 `alwaysLoad` 强制直载。
7. **安全默认值**：敏感/破坏性工具默认 `ask`；只依赖 `destructiveHint` 不够，最好维护内置敏感工具名单。

### P2（可选/后期）

1. **MCP Apps (`ui://`)**：`io.modelcontextprotocol/ui` 能力、`_meta.ui.resourceUri`、iframe 域 + CSP；先做只读 widget。
2. **DXT/.mcpb**：manifest v0.4、签名/哈希、黑名单、开发者模式、user_config 加密。
3. **企业托管**：`allowedMcpServers/deniedMcpServers`、`allowManagedMcpServersOnly`、URL pattern allowlist、仅 https。
4. **多 runtime**：内置 Node/Python 选择与 semver 兼容；uv。
5. **远程桥接/多设备**：Claude Desktop 的 session host/direct pool 很复杂，AutoAgent 不应第一版复制。

### 应避免

- 不要把用户配置、扩展配置、托管配置混成一个无来源标记的 dict；必须保留 `source/origin`。
- 不要默认继承全量 `os.environ`。
- 不要用 shell 拼接命令。
- 不要信任服务器自报的 `readOnlyHint` 做唯一安全判断。
- 不要自动跟随 OAuth/HTTP 重定向。
- 不要在重启循环中无限重试；必须有预算和用户可见的 Connect。
- 不要把 MCP Apps HTML 直接放进主文档 DOM；必须 iframe + 域名隔离 + CSP。
- 不要把原始异常/路径/URL/凭据写进 UI 或日志。

---

## 10. 证据索引

> 文件均为绝对路径。偏移为 JS 文本字符偏移，`~` 表示区间近似。

### 10.1 配置与 IPC

| 主题 | 文件 | 偏移/符号 |
|---|---|---|
| `claude_desktop_config.json` 路径 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` | `1672817` `g_()`；`841368` `Vze` |
| 同步读取/缓存/强制重载 | 同上 | `1672942` `imt()`；`1676089` `x_(forceReload)` |
| 桌面 mcpServers schema | 同上 | `1543712` `Og`, `kg`, `Dg` |
| 状态 schema | 同上 | `1558914` `xct/Sct/Cct` |
| MCP IPC 定义 | 同上 | `1583817` `Rg=ro(Ig,"MCP",...)` |
| preload API | `/home/tars/yysapp/claude-desktop/app/.vite/build/mainView.js` | `3618` |
| IPC 实现 | `Z7` | `6709147` `Rg.for(e).setImplementation(...)` |
| 写配置/重载 | `Z7` | `1678246` `ymt/bmt`；`4437798` `M5r/N5r` |
| 手动重载菜单 | `Z7` | `4491483` |
| 本地 MCP 开关 | `Z7` | `3289228` `m$n()` |
| 合并扩展+用户 | `Z7` | `4487452` `TY/dei` |
| 扩展配置生成 | `Z7` | `4482271` `v9r`；`4482566` `y9r` |
| 工具权限 schema | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.pre.js` | `445742` |
| 托管 MCP schema | `pre.js` | `479797`；`581905` `localStdioEnabled`；`582378` / `583006` allow/deny plugin |
| 敏感文件列表 | `Z7` | `3073572`（包含 `claude_desktop_config.json`、`.claude.json`） |
| IPC 服务清单 | `/home/tars/yysapp/claude-desktop/asset/ipc_services.json` | `MCP` 数组 |

### 10.2 Claude Code / Agent SDK

| 主题 | 文件 | 偏移/符号 |
|---|---|---|
| MCP 传输/scope schema | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-DNyequwM.js` | `823051`、`825739` |
| managedMcpServers 约束 | 同上 | `825739`、`825812` |
| settings 说明 | 同上 | `939234`、`939322`、`939423` |
| `.mcp.json` 探测 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-BvLvPLAH.js` | `80788`（`uo/oo/so/co`） |
| `--mcp-config` | 同上 | `548811`、`552101` |
| ToolSearch/延迟工具 | 同上 | `133303` |
| `strictMcpConfig` | `DNyequwM` | `1131265` |
| `.claude.json` 路径 | `Z7` | `3738790` `AU()` |
| `STe` 路径 | `DNyequwM` | `1189557` |
| 托管策略→CC 设置 | `Z7` | `2101995`、`2106431`（`AUt/jUt/MUt`） |
| 权限规则转换 | `Z7` | `2099087` `Lx`；`2099510` `CUt`；`2099656` `wUt` |
| 资源工具映射 | `DNyequwM` | `~821k` `C2` |

### 10.3 传输与状态机

| 主题 | 文件 | 偏移/符号 |
|---|---|---|
| NDJSON framing | `Z7` | `1164525` `R5e/z5e/B5e` |
| stdio transport | `Z7` | `1427196` `sh` |
| 环境白名单 | `Z7` | `1426842` `frt/prt` |
| 内置 Node host | `Z7` | `1430351` `Drt`；`1429786` `Crt` |
| nodeHost 沙箱 | `/home/tars/yysapp/claude-desktop/app/.vite/build/mcp-runtime/nodeHost.js` | 全文 |
| runtime 选择 | `Z7` | `2021000` `IRt`；`2089700` `LHt`；`2091013` `UHt` |
| direct host spawn | `Z7` | `2104732`、`2105996`、`2106111` |
| direct host 实现 | `/home/tars/yysapp/claude-desktop/app/.vite/build/mcp-runtime/directMcpHost.js` | `~608k–613k` |
| 重连预算 | `Z7` | `887000–898000`（`kWe/kd/NWe/PWe`） |
| 惰性重连冷却 | `Z7` | `2191172` `bJt=30000` |
| OAuth 刷新退避 | `Z7` | `2172871` |
| 状态映射 | `Z7` | `2167k` `Cqt` |
| 握手 IPC | `Z7` | `6522722` |

### 10.4 审批、资源、OAuth

| 主题 | 文件 | 偏移/符号 |
|---|---|---|
| 权限合并 | `Z7` | `557k`（`GTe/us/ds`） |
| per-call 审批 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-c1MnZbIW.js` | `487k–491k` |
| 破坏性工具 | 同上 | `492473`；`Z7:5942016` |
| 用户工具开关 | `Z7` | `884k–886k` |
| artifacts 注入 | `Z7` | `4429952` |
| prompt 校验 | `Z7` | `4416k–4420k` |
| 云 resources API | `c1MnZbIW` | `465564`、`466720` |
| OAuth discovery | `Z7` | `1330k–1333k` |
| PKCE | `Z7` | `1310k–1335k` |
| OAuth client/token | `Z7` | `2140k–2175k` |
| Entra broker | `Z7` | `2140k–2190k`；`index.chunk-WPPTJ-tb.js` |
| `ui://` schema | `c1MnZbIW` | `33599`、`458516` |
| MCP Apps 能力 | `index.chunk-CQIVLXmn.js` | `10603` |
| `ui` meta 判定 | `index.chunk-BPeAtel1.js` | `5406` |
| widget 域名/CSP | `Z7` | `823545`、`543194` |

### 10.5 内置服务器与 DXT

| 主题 | 文件 | 偏移/符号 |
|---|---|---|
| GitHub 内置 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-ppY_-sIU.js` | 全文 |
| Office365 内置 | `Z7` | `1446k–1460k`；`1454k` `Dit/ph` |
| 内置分派 | `Z7` | `1446k` `ph()` |
| DXT manifest schema | `Z7` | `1526342` |
| manifest→stdio | `Z7` | `1534236` `nst()` |
| DXT 安装 | `Z7` | `4475000`、`4471000`、`4480000` |
| 扩展 settings 加密 | `Z7` | `4441081` `tY`；`4439k` `F5r/I5r` |
| bundled skills | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-DlUocsGr.js` | `16279` `ge/_e/B` |
| skills manifest | `/home/tars/yysapp/claude-desktop/app/resources/bundled-skills/manifest.json` | - |
| GitHub 二进制 | `/home/tars/yysapp/claude-desktop/app/resources/github-mcp/github-mcp-server` | ELF x86-64 |
| Office365 脚本 | `/home/tars/yysapp/claude-desktop/app/resources/office365-mcp/office365-mcp-stdio.mjs` | 7.3 MB |

### 10.6 特征 flag（仅名字/存在性）

`Z7:108178`、`pre.js:661991` 的 flag 集合包含：
`disable_destructive_mcp_tools_by_default`、`sensitive_mcps_per_call_consent`、`mcp_tool_approval_config`、`sensitive_mcp_tools`、`mcp_apps_frame_domains`、`apps_mcp_apps_experimental_flags`、`epitaxy_disable_mcp_elicitation` 等。
这些是 **flag 名**，对应实现未全部定位 → 见 §11。

---

## 11. [已证实] / [推断] / [未知]

### [已证实]

- 桌面 `claude_desktop_config.json` 的 mcpServers schema 只有 `command/args/env/extensionId`。
- 配置路径、1 MB 上限、同步读取与缓存、强制重载入口。
- 扩展配置与用户配置的合并顺序（用户覆盖同名扩展）。
- `mcp-server-connected` + MessagePort 的 renderer-as-client 架构。
- stdio NDJSON、10 MB 缓冲上限、环境白名单。
- 内置 Node host 的自执行阻止与 MessagePort 桥接。
- directMcpHost 的 SSE/Streamable HTTP、10s/60s 超时、3 次 terminal error、404 session 处理、重定向拒绝、401/403 单次重试。
- 重连预算 5 连续 / 15 总计、30s 惰性冷却。
- `mcp__server__tool` 命名与 sanitize、保留名/碰撞检测。
- `allow/ask/ask-session/blocked` 与“取最严格”合并。
- `mcp-user-tool-toggles.json` v3 schema。
- DXT manifest v0.1–0.4 字段、签名状态、签名要求、黑名单、安装限制。
- GitHub/Office365 内置服务器启动与凭据处理。
- OAuth discovery/PKCE/loopback/refresh/token 加密。
- MCP Apps 的 `ui://`、能力声明、widget 域名/CSP。

### [推断]

- 外部修改 `claude_desktop_config.json` 后没有自动热重载（未找到 watcher；更可能是手动重载/重启）。
- Claude Code 的逐 scope 合并顺序（managed > CLI > local > project > user）在这份包外 CLI 中实现，本包只暴露 schema/开关。
- 破坏性工具的 `destructiveHint` 可被恶意服务器伪造，构成审批绕过风险。
- MCP Apps iframe 很可能使用 `sandbox="allow-scripts ..."`，但未在提取代码中直接定位。
- `toolSearchEnabled` 打开后 MCP 工具默认走延迟加载；`alwaysLoad` 可强制直载。

### [未知]

- `sensitive_mcps_per_call_consent`、`mcp_tool_approval_config`、`sensitive_mcp_tools` 的具体运行时逻辑（只找到 flag 名）。
- `mcpServerAutoReconnect`（若指配置项）在桌面配置 schema 中不存在；只找到事件 `mcp-server-auto-reconnect`。
- `client_credentials` OAuth grant 未找到实现；目前看到的 refresh 流程是 `refresh_token`。
- websearch 内置服务器的具体工具/网络策略。
- Claude Code CLI 的完整 MCP 配置加载器（CLI 可执行文件不在提取路径中）。
- MCP Apps widget 的完整 iframe sandbox 属性与 postMessage 校验细节。
- 桌面 stdio 服务器 renderer 侧是否有独立的重连/退避（主进程只发 `mcp-server-auto-reconnect`）。

---

## 12. Handoff（10 条）

1. **先读三处**：`Z7:1543712`（桌面 schema）、`Z7:4487452`（合并）、`Z7:6522722`（MessagePort 握手）——这三处定义了桌面 MCP 的最小闭环。
2. **不要把 `claude_desktop_config.json` 当通用 MCP 配置**：它只支持 stdio。HTTP/SSE/OAuth 在企业直连层和 Claude Code 层。
3. **AutoAgent 第一阶段只做 stdio + NDJSON + 最小 env + 三档超时**，即可覆盖绝大多数本地 MCP server。
4. **审批模型照抄“取最严格”**：`blocked > ask > ask-session > allow`，非法值 fail-closed 到 blocked。
5. **per-call 审批后必须重查策略**（Claude Desktop 的 `callRemoteTool` 明确做了二次检查），否则有 TOCTOU。
6. **连接状态机照抄预算/冷却**：5 连续/15 总计、30s 冷却、`needs-auth` 不自动重试、UI 手动 Connect。
7. **OAuth 只做安全子集**：PKCE S256 + loopback + 拒绝重定向 + safeStorage/keyring + 5 分钟提前刷新；先不做 DCR/hosted client assertion。
8. **工具命名与保留名检测是安全边界**：`mcp__server__tool` + sanitize + 拒绝 prototype 名称 + 内置名冲突检测。
9. **MCP Apps/DXT 放 P2**：先做文本/结构化结果；`ui://` widget 需要独立 iframe 域、CSP、权限声明，不能直接 innerHTML。
10. **剩余最大不确定性**：Claude Code CLI 的逐 scope 配置优先级、敏感 MCP flag 的运行时逻辑、MCP Apps iframe sandbox 细节；若 AutoAgent 要做到等价，需要另外拿到 CLI 可执行文件或做黑盒实验。
