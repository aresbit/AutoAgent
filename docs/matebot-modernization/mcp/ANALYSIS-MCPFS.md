# mcp-fs 研究与 AutoAgent 采用建议

> 研究日期：2026-10-19。只读研究；未修改 AutoAgent / MateBot / claude-desktop 源码。
> 领域标签：`[已证实]` = 代码/测试/公开页面直接证据；`[推断]` = 由证据推导；`[未知]` = 没有可靠来源或没有测量。

---

## 0. 一句话结论

**mcp-fs 不是“文件系统 MCP 服务器”，而是把 MCP 连接投影成可 import 的类型化代码模块，让 agent 用代码做扇出、过滤、连接和状态复用，只把 `print/console.log` 的结果送回模型。** 它同时解决三件事：工具 schema 不常驻上下文、中间结果不穿过模型、调用复用宿主已建立的活连接而不是每次冷启动。

AutoAgent 应当采用 **MateBot/opencc 的新 `services/mcpfs` 三层实现（投影 + 宿主网关 + 沙箱绑定）**，彻底删除旧 `McpFsTool/mcpFilesystem` 路径；`SafeFileService` 只保留给 UI 文件功能；工作区文件操作继续用原生 Read/Write/Edit/Bash；官方 Filesystem MCP server 仅在需要对外提供标准 MCP 文件接口时使用。

---

## 1. 研究期间的状态变化（必须先看）

开始研究时，用户列出的旧实现确实存在：

- `/home/tars/yysapp/AutoAgent/packages/opencc/src/utils/mcpFilesystem.ts`（39 KB，1187 行，mtime 2026-10-17 12:03）
- `/home/tars/yysapp/AutoAgent/packages/opencc/src/utils/mcpFsClient.ts`
- `/home/tars/yysapp/AutoAgent/packages/opencc/src/tools/McpFsTool/{McpFsTool,McpFsExecTool,McpFsDiscoverTool,McpFsReadTool}.ts`

研究进行中（2026-10-19 10:38 左右），AutoAgent 工作树被外部替换为更新的 opencc：

- 旧文件在 `git status` 中变成 `D`（已删除）；
- 新的 `/home/tars/yysapp/AutoAgent/packages/opencc/src/services/mcpfs/` 变成 `??`（未跟踪）；
- `CodeActTool`、`prompt.ts`、`onChangeAppState.ts`、`codeActSandbox.ts`、`goalContinuation.ts` 被修改为接入新 mcpfs；
- 旧 `McpFsTool/*` 从 `tools.ts` 的注册中移除。[已证实：`git status` / `git diff HEAD -- packages/opencc/src/tools.ts`]

因此本文的“旧实现”证据采用两处**与 HEAD 同哈希**的保留副本（逐字节一致，便于引用行号）：

- `git -C /home/tars/yysapp/AutoAgent show HEAD:packages/opencc/src/utils/mcpFilesystem.ts`
- `/home/tars/yysapp/AutoAgent-opencc-sync/packages/opencc/src/utils/mcpFilesystem.ts`（sha256 `a4cf25c5192ce79954e633dbdac416c87fb0f3024c49082846e234be2b78725c`，与 HEAD、opencc-runtime-stubs、opencc-memory-performance 完全一致）
- 四个 `McpFsTool/*.ts` 与 `mcpFsClient.ts` 也已逐个比对 HEAD 哈希，一致。

新实现与 MateBot 的 `vendor/opencc/src/services/mcpfs` 六个文件**完全一致**（`diff -rq` 无输出）。也就是说，**AutoAgent 的采用动作已经在工作树里发生，但尚未提交、尚未完成验证与收尾**。这直接决定了下面的 P0/P1/P2。

---

## 2. 四种设计对比表

### 2.1 主表

| 维度 | Anthropic 工程博客（设计蓝图） | AutoAgent 旧 McpFsTool（HEAD，已从工作树删除） | MateBot/opencc 新 mcpfs（AutoAgent 工作树已同步） | 官方 Filesystem MCP server |
|---|---|---|---|---|
| 定位 | 把 MCP 工具投影成文件/代码 API | 独立“MCP-FS 工具族” + Bun 沙箱 | 活连接投影 + CodeAct 网关 | 标准 MCP 文件服务器 |
| 对模型暴露的工具 | 每个 MCP 工具一个 typed 文件；可选 `search_tools` | 4 个元工具：`mcpfs` / `mcpfs_discover` / `mcpfs_read` / `mcpfs_exec` | 不新增元工具；CodeAct prompt 指向 `~/.claude/mcp-fs/servers/` | 14 个标准 MCP tool |
| 发现机制 | `ls ./servers/`，只读需要的工具文件 | 扫描 `manifest.json`、独立 `.ts`、`.mcp.json`/`settings.json`，经 `bridge.mjs` 探测 | `onChangeAppState` → 投影器 → `tools/list` → 写 README/index.json/绑定 | 客户端 `tools/list` |
| 执行方式 | agent 写代码，执行环境运行 | `bun run` 临时目录；只回 stdout | CodeAct 的 TS/Python 运行时；只回 stdout/print | 直接工具调用 |
| 连接复用 | 文章未规定 | **每次调用** spawn `sh` → `node bridge.mjs` → MCP server | **复用** opencc 已持有的活连接；回环 TCP 一行 JSON | 长驻 server 进程 |
| 服务端状态 | 文章未规定 | 每次冷启动，状态丢失 | 跨调用、跨运行保持（测试用 counter 证明） | 文件系统本身持久；进程状态取决于 server |
| 类型质量 | TS 示例；typed wrapper | 只取 inputSchema 顶层字段，输出一律 `Record<string, unknown>` | 完整 input/output schema：嵌套、enum、anyOf/oneOf/allOf、数组、元组、本地 `$ref`、nullable；TS + Python | JSON Schema；质量取决于客户端 |
| resources/prompts | 未讨论 | 不支持 | 运行时 helper：`listResources`/`readResource`/`getPrompt`（Python 同名） | 不提供 |
| 审批模型 | 未讨论 | 无；只有工具级 `isReadOnly` | 每 run 静态扫描 + 用户一次审批 + 网关逐次复核 + deny/allow 规则 | 无；交给客户端权限系统 |
| 根目录/路径策略 | 未讨论 | 无 allowlist；沙箱等同用户权限 | 委托给各 MCP server；网关不额外限制根 | allowed directories + MCP Roots + realpath/符号链接校验 |
| 上下文经济 | 中间结果留在执行环境 | 设计目标相同，但实现不可用 | 中间结果留在 CodeAct；只打印结果 | 结果直接进入模型上下文 |
| 延迟 | 无数字 | 每次调用冷启动；精简 bridge 固定等 3 秒 | 每次调用一次本地 socket；无进程启动 | 每次一次 MCP RPC |
| 语言/生态 | 示例 TS，语言无关 | 仅 TS；完整 bridge 支持 stdio/HTTP/SSE | TS + Python；底层仍是标准 MCP | 任意 MCP 客户端 |
| 当前状态 | 公开文章 | 递归/参数变量/限定名三处致命问题，实际 0 工具可用；已删 | 13 个测试通过（本机实测） | npm `1.0.0`，活跃维护 |

### 2.2 SafeFileService 与“新 files 功能”单列

`SafeFileService` 不是 MCP，也不是 agent 工具；它是后端 UI 文件功能的策略层。`file_router.py` + `FileBrowser.tsx` 是它的 HTTP/前端外壳。

| 维度 | SafeFileService | 新 files 功能（router + FileBrowser） |
|---|---|---|
| 定位 | 后端文件策略与原子 I/O | 桌面端文件浏览器/文本编辑器 |
| 接口 | Python 方法 | `/api/files/*` HTTP（14 个端点） |
| 根模型 | root id + 相对路径；默认 `workspace`；root 解析器与 `is_allowed_root` 注入 | 同 |
| 路径安全 | `Path.resolve(strict=True)` 规范化；逐段 `lstat`，**任何符号链接都拒绝**；写前再次校验 fd | 委托给 service；router 额外要求 loopback |
| 写安全 | 原子写 + 可选 SHA-256 compare-and-swap；大小上限 | 编辑器用 `expectedSha256` 防覆盖 |
| 能力 | list/stat/read/write/create/mkdir/rename/delete/copy/move；分页；hidden 过滤 | 懒加载树、过滤已加载节点、文本编辑、图片预览、上传/下载、reveal |
| 缺失 | 无 search、无递归 tree、无按行 edit（只有 maxLines）；composition 只配一个 root | 无后端搜索；搜索仅过滤“已加载”的树节点 |
| Agent 可用 | **否**（没有注册成 agent 工具） | 否 |
| MCP 互操作 | 无 | 无 |

结论：**SafeFileService 是 UI 文件功能的最佳选择，不应被 mcpfs 或 Filesystem MCP server 取代。** 它和 mcp-fs 解决的是不同层的问题。

---

## 3. 架构与数据流

### 3.1 旧 McpFsTool（HEAD / AutoAgent-opencc-sync）

```text
模型
 │
 ├─ mcpfs_discover ──► discoverTools()
 │                       ├─ 扫描 ~/.claude/mcp-fs/servers/*/manifest.json
 │                       ├─ 扫描独立 .ts
 │                       └─ discoverMcpBridgeTools()
 │                            └─ ensureMcpFsRuntime() ↺ 无条件自递归
 │
 ├─ mcpfs_read ──────► discoverToolsCached()  ──► 默认 probe=true ──► 同上自递归
 │
 ├─ mcpfs ───────────► executeToolSimple()
 │                       └─ registry.json 查找 ──► sh -c "<entry.command>"
 │
 └─ mcpfs_exec ──────► executeCode()
                         ├─ 建 sandbox/exec_<ts>/
                         ├─ 复制 client.ts、registry.json；symlink servers/
                         ├─ 写 agent.ts；spawn bun run
                         └─ import ./servers/<s>/<t>.js
                              └─ callMCPTool(server__tool)
                                   ├─ 读 ./registry.json
                                   └─ sh -c "<command>"
                                        └─ node bridge.mjs
                                             └─ spawn MCP server
                                                initialize → tools/call
                                                （精简 bridge 固定 sleep 3000ms）
                                                  └─ JSON → sandbox → console.log → 模型
```

关键失败点（全部 [已证实]）：

1. **无条件自递归**：`ensureMcpFsRuntime()` 第一行就是 `await ensureMcpFsRuntime()`。`discoverAndGenerate()`、`probeMcpServerTools()`、`discoverMcpBridgeTools()` 都会走到这里。由于是 async 递归，实际表现更像“永不完成/持续占用”而不是同步栈溢出；旧文档把它描述为“栈溢出”。[旧代码 245–247；新文档 `docs/mcp-fs.md:7` 也记录了重写原因]
2. **工具描述即触发递归**：`McpFsTool.description()` 与 `McpFsExecTool.description()/prompt()` 调 `discoverToolsCached()` 默认 `probeMcpServers=true`，因此连渲染工具说明都会进入上述递归。[`McpFsTool.ts:34-39`、`McpFsExecTool.ts:33-45`]
3. **bridge 参数变量读错**：`callMCPTool` 写入 `MCP_ARGS`；安装包内联的精简 bridge 读 `BRIDGE_TOOL_ARGS`，所以桥接调用永远收到 `{}`。完整 `mcpBridge.mjs` 读 `MCP_ARGS`，只有精简版有这个问题。[`mcpFilesystem.ts:185` vs `mcpFsClient.ts:33`、`mcpFilesystem.ts:333`]
4. **桥接工具的限定名与 registry 不匹配**：bridge 条目在 registry 里 `server = "mcp-bridge-<name>"`，但生成的 wrapper 用 `mcpServer__mcpToolName`（如 `filesystem__read_file`）；`callMCPTool` 按 `server === "filesystem"` 查 registry，查不到，返回 “no command defined”。[`mcpFilesystem.ts:272-274`、`996-1017`、`mcpFsClient.ts:40-53`]
5. **`ensureBridge()` 定义了但从未被调用**，所以 `bridge.mjs` 不会按注释自举；只有用户手动放置或其它路径留下时才会存在。[`mcpFilesystem.ts:123`，全文件仅此一处定义]
6. **类型系统被压扁**：只生成顶层输入字段；数组变 `unknown[]`，对象变 `Record<string, unknown>`；响应接口是索引签名。[`mcpFilesystem.ts:259-276`、`extractInputFields` 约 1140 行]
7. **没有审批、没有根目录策略**：`mcpfs`/`mcpfs_exec` 的 `isReadOnly()` 都是 `false`，但没有 per-tool 审批；沙箱继承整个 `process.env`，以普通用户权限运行，旧文档明确说“不是安全边界”。[`McpFsTool.ts:48`、`McpFsExecTool.ts:53`、`mcpFilesystem.ts:581-590`、旧文档 `docs/mcpfs-tool-family-architecture.md:98-103`]

### 3.2 新 mcpfs（当前 AutoAgent 工作树 / MateBot）

```text
MCP 连接建立 / 重连 / tools/list_changed
  └─ onChangeAppState（mcp slice 变化）
       └─ 250ms debounce
            └─ McpFsProjector.sync(clients, tools)
                 ├─ fingerprint = connectionId + 所有工具名 + inputSchema
                 ├─ 未变且目录存在 → skip
                 └─ 变 → tools/list（分页）
                      └─ projectServer(snapshot)
                           ├─ <server>/<tool>.ts  完整类型 + callMCPTool
                           ├─ <server>/<tool>.py  keyword-only 签名
                           ├─ <server>/README.md  instructions + 工具索引
                           ├─ <server>/index.ts / __init__.py
                           ├─ 根 README.md / index.json / _mcpfs.ts / _mcpfs.py
                           └─ 整目录原子替换；只动 .opencc-generated

CodeAct 调用
  ├─ checkPermissions
  │    └─ mcpPermissionCheck → scanMcpReferences(code)
  │         ├─ 命中 mcp__server__tool deny 规则 → 整次 deny
  │         ├─ bypass / readOnlyHint / 已有 allow 规则 → 放行
  │         └─ 其余 → 一次 ask（列出 server: tools）
  ├─ openMcpRun → gateway.open
  │    └─ 每次 run 随机 token + 127.0.0.1:<port>（listener 全局一个）
  └─ CodeAct 沙箱（servers/ 以 symlink/junction 链入）
       └─ import typed binding → callMCPTool
            └─ 一行 JSON {token, op, server, tool, args}
                 └─ gateway.handle
                      ├─ decideMcpCall（与 checkPermissions 同一函数）
                      ├─ ensureConnectedClient（复用活连接）
                      ├─ callMCPToolWithUrlElicitationRetry（原始结果，不截断）
                      └─ resources/read、resources/list、prompts/get
                           └─ 原始结果 → 代码 → 只打印的结果 → 模型
```

关键机制：

- **投影是连接的函数**：连接/重连/`tools/list_changed` 触发；服务器断开则删除其目录；pending（重连中）保留目录，避免抖动。[`projection.ts:1-44`、`401-455`]
- **原子替换与所有权**：`writeServerDir` 先写 staging，再 `rename` 旧目录为 retired，最后删除；不是 opencc 生成的目录（无 `.opencc-generated`）不会被覆盖或删除。[`projection.ts:328-350`]
- **活连接复用**：`ensureConnectedClient` + `callMCPToolWithUrlElicitationRetry`；服务器进程、认证、会话状态与模型原生 MCP 调用共用。[`gateway.ts:133-180`]
- **每 run 一个网关会话**：24 字节随机 token，`timingSafeEqual` 比较，`close()` 撤销并 abort 在途请求。[`gateway.ts:243-300`]
- **审批与执行共用判定**：`decideMcpCall` 同时被 `mcpPermissionCheck` 和网关调用，做到“批准的集合 = 能执行的集合”。[`gateway.ts:76-131`、`approval.ts:63-94`]
- **resources/prompts**：投影只记录 capability 布尔值，不生成逐资源文件；运行时通过 helper 访问。[`projection.ts:66-67, 257-258, 320-321`、`runtime.ts:112-126`、`gateway.ts:182-206`]
- **关闭开关**：`OPENCC_MCPFS=0` 关闭投影与 run 环境。[`approval.ts:29`、`onChangeAppState.ts:179`]

---

## 4. 优势/劣势清单

### 4.1 Token / 上下文经济

**新 mcpfs（优点）**

- MCP 工具不再需要把 N 份 JSON Schema 塞进模型上下文；agent 读 `servers/README.md` 和单个工具文件即可。[已证实：投影文件结构]
- 结果在沙箱里是原始对象：过滤 1 万行只打印 5 行；大结果不经过模型。[已证实：`runtime.ts:20-125`、测试 `mcpfs.test.ts:240`]
- 类型完整，读一个文件就能知道参数/返回，不需要反复试探。[已证实：`schema.ts`]
- 生成树是磁盘文件，不是 prompt 常量；不会每轮重复计费。[已证实]

**新 mcpfs（限制）**

- **不会自动减少原生 MCP 工具的 schema 开销**：`assembleToolPool()` 仍把 `appState.mcp.tools` 全部并入工具池；`client.ts` 仍把每个 MCP tool 转成模型工具。mcpfs 是“加法”，不是“替换”。[已证实：`tools.ts:443-478`、`services/mcp/client.ts:1799-1820`]
- 要让“schema 不进上下文”真正成立，需要额外策略：关闭原生 MCP 工具暴露、按需 defer、或仅保留 mcpfs 路径。目前没有找到这样的开关。[已证实：未找到；推断：默认两条路径并存]
- 投影的 README/index.json 仍可能很长，但只有 agent 主动读时才进上下文。[已证实]

**旧实现**

- 设计同样声称 98.7% token reduction，但这是把 Anthropic 文章里的单一示例当成通用结论；旧文档与旧工具描述直接复述该数字，没有本地测量。[旧文档 `mcp-fs-capabilities.md` 未给测量；工具描述见 `McpFsExecTool.ts:39`]
- `mcpfs` 的 `description()` 会把所有 `server/tool` 名字拼进工具说明；273 个工具时会形成每轮固定的长字符串。[`McpFsTool.ts:34-39`；旧文档称 42 servers / 273+ tools，见 `mcp-fs-capabilities.md:4`]
- 实际不可用，token 讨论没有运行意义。[已证实：递归]

**官方 Filesystem MCP server**

- 14 个工具的 schema 会直接进入模型上下文；每次目录/文件结果也直接回模型。若客户端不做代码执行，无法把中间结果留在外面。[已证实：工具注册]
- 适合一次性、少量文件操作，不适合批量扇出。[推断]

**Anthropic 文章的数字**

- 原文：“This reduces the token usage from 150,000 tokens to 2,000 tokens—a time and cost saving of 98.7%.” 这是 Google Drive → Salesforce 的单一示例；文章没有给数据集、方法或独立基准。[已证实：URL + 原文]
- 文章还说工具多时“they’ll need to process hundreds of thousands of tokens before reading a request”。[已证实：原文]
- **本报告不做任何本地 token 基准**；AutoAgent 侧没有可引用的 token 测量。[未知]

### 4.2 延迟与连接复用

| 设计 | 单次调用开销 | 状态 |
|---|---|---|
| 旧 mcpfs | `sh` + `node bridge.mjs` + spawn MCP server + initialize；完整 bridge 等到响应（最长 60s），精简 bridge 固定 3s；每次冷启动 | 服务端状态丢失 |
| 新 mcpfs | 一条 loopback TCP 连接 + 一行 JSON + 一次 SDK `tools/call`；无进程启动 | 状态跨调用/运行保持 |
| 官方 FS server | 一次 MCP RPC；server 长驻 | 文件系统持久；进程内状态取决于 server |
| SafeFileService | 后端进程内 Python 调用（HTTP 外壳） | 无 MCP 状态 |

- 新实现的“状态复用”有测试证据：TS 连续 `counterAdd(2)`、`counterAdd(3)`、`counterGet()` 得到 `5 5`，Python 再 `counterAdd(4)` 得到 `9 9`。[`mcpfs.test.ts:215-238`]
- 旧实现的 bridge 每次 `stdioCall` 都 `spawn` 并重新 `initialize`，没有持久连接。[`mcpBridge.mjs:78-108`]
- **没有本地延迟数字**：不能声称新实现“快 X%”。[未知]

### 4.3 状态与事务

- 新 mcpfs 复用活连接，所以“打开一个 binary / 数据库句柄 / MCP 会话”可以跨调用、跨 CodeAct run 保留；这正是投影相对于“每次 spawn”的核心差异。[已证实：`gateway.ts` 头部注释 + 测试]
- 投影本身是“最终一致”：app state 变化 → 250ms debounce → 投影；极短窗口内文件可能是旧版本。[已证实：`projection.ts:492-502`]
- 旧实现没有状态复用。[已证实]
- 官方 FS server 无事务；`write_file` 覆盖不是崩溃原子，`move_file` 目标存在即失败。[已证实：README + lib.ts]

### 4.4 类型与语言

- 新实现：完整类型、`outputSchema` → structuredContent、无 outputSchema → `{text,json,content}`、`isError` 抛 `McpToolError`；TS + Python。[已证实：`schema.ts`、`runtime.ts`]
- 旧实现：仅 TS；顶层字段；输出 `Record<string, unknown>`；bridge 条目 `readOnly/destructive` 一律 false。[已证实]
- 官方 server：标准 JSON Schema，客户端决定是否生成类型；模型直接调用时 schema 即上下文。[已证实]
- SafeFileService：Python DTO + Pydantic 校验；与 MCP 类型系统无关。[已证实]

### 4.5 资源与提示词

- 新 mcpfs 支持 `resources/list`、`resources/read`、`prompts/get`，但没有逐资源生成 typed 文件，也没有把资源内容投影到 README。[已证实：`projection.ts:257-258`、`runtime.ts:112-126`]
- 旧实现完全不支持 resources/prompts。[已证实：旧桥只有 tools/list、tools/call]
- 官方 server 只提供 tools，不提供 resources/prompts。[已证实]
- **审批缺口**：网关对 `read_resource`、`list_resources`、`get_prompt` **没有调用 `decideMcpCall`**；只要 run 拿到 token，就能读任意已连接 server 的资源/提示词。是否是有意（资源视为只读）需要产品确认。[已证实代码分支；影响为推断]

### 4.6 审批与安全

**新 mcpfs 做对的**

- 静态扫描代码引用：具名 import、`import *` / `import servers.x` 展开整服务器、字面量 `callMCPTool`/`call_tool`。[`scan.ts:37-97`]
- deny 规则优先；readOnlyHint、allow 规则、bypass 模式放行；其余一次性审批。[`approval.ts:63-94`]
- 网关用同一判定函数复核；运行时拼出的工具名不在批准集合，返回 `not_approved`。[`gateway.ts:150-180`；测试 `mcpfs.test.ts:258-269`]
- 每次 run 随机 token，`timingSafeEqual`，run 结束/中止即撤销；关闭后调用返回 `unauthorized`。[测试 `mcpfs.test.ts:280-291`]
- 投影目录只覆盖自己生成的目录，避免误删用户文件。[`projection.ts:332-350`]

**新 mcpfs 的风险**

1. **readOnlyHint 是服务器自报的，不可信**。恶意/被攻陷的 server 可以把破坏性工具标成只读，从而免审批。[已证实机制；风险为推断]
2. **指纹不包含 description/annotations/outputSchema**，只包含工具名 + inputSchema。若 server 在 `tools/list_changed` 中只改了 `readOnlyHint` 或描述，投影不会重写，审批索引会保留旧的只读判断。[已证实：`projection.ts:409-415`；安全影响为推断]
3. **resources/prompts 不经审批**，见 4.5。[已证实]
4. **沙箱不是安全边界**：`codeActSandbox.ts` 明确写了 “The sandbox is NOT a security boundary. It runs with the same user ...”。[`codeActSandbox.ts:11`]
5. **提示词注入面**：server 的 `instructions`、tool description、README 内容都会写进 agent 可读文件。审批只限制“非只读工具”，无法阻止只读工具/资源读取敏感数据，也无法阻止沙箱内 Bash/网络把数据带出。[推断]
6. **原生 MCP 工具仍走各自的权限路径**；mcpfs 的审批不会覆盖模型直接调用原生 MCP 工具的行为。[已证实：两条路径并存]

**旧实现的安全问题**

- 没有 root allowlist；agent 代码以用户权限运行；继承全部环境变量；`sh -c` 执行 registry 中的命令；bridge 工具名未做 shell 转义（`BRIDGE_TOOL='${tool.name}'`），恶意 server 的工具名可注入 shell。[`mcpFilesystem.ts:1012`；风险为推断]
- 发现阶段会读项目内 `.mcp.json` 并执行其中 `command`；不可信仓库可借此触发命令执行（这是 MCP 配置的通用风险，但旧实现没有额外确认）。[推断]
- 旧文档自己承认沙箱不是安全边界，只用于上下文隔离。[`docs/mcpfs-tool-family-architecture.md:98-103`]

**官方 Filesystem MCP server 的安全边界**

- allowed directories 来自 CLI 参数；客户端支持 Roots 时，roots 会**完全替换** CLI 目录；无有效 roots 时拒绝访问（“Access denied - no allowed directories”）。[已证实：README]
- `validatePath` 先做 `path.resolve(path.normalize(...))` 包含性检查，再 `fs.realpath` 并复查；符号链接目标越界会拒绝（“Access denied - symlink target outside allowed directories”）。[已证实：`lib.ts`]
- 写入：新文件用 `wx`；覆盖用 `lstat` + `O_NOFOLLOW` + inode 复核，拒绝非常规文件；明确接受“崩溃可能留下半写文件”的取舍。[已证实：`lib.ts`]
- **没有审批**，也没有结果数量/大小上限；`search_files` 递归无 depth/result/timeout 上限，`read_text_file` 无大小上限。[已证实：`lib.ts`]
- 把 `/`、`$HOME` 之类宽根目录交给它，等价于把用户文件系统交给模型；必须窄根 + 客户端审批。[推断]

### 4.7 生态与互操作

- 标准 MCP 工具：任何客户端可用；server 作者无需生成绑定；但 schema 与结果直接进上下文。[已证实]
- 新 mcpfs：标准 MCP 之上加一层“代码 API”；支持 TS/Python；资源/提示词通过 helper；与 opencc CodeAct 强绑定，换宿主需要移植投影器/网关。[已证实]
- 旧 mcpfs：仅 TS；虽然桥支持 stdio/HTTP/SSE，但实现已坏；不可作为互操作方案。[已证实]
- 官方 FS server：最通用；可被新 mcpfs 直接投影（连接后自动生成 14 个 typed 绑定），但会多一层 server 进程和重复的 root 策略。[推断]
- SafeFileService：私有 HTTP API，仅 AutoAgent 前端使用；不是 MCP 生态的一部分。[已证实]

### 4.8 运维与可观测性

- 新 mcpfs：投影失败只 `logForDebugging`，不阻断 CodeAct；网关错误按 `code` 返回；没有指标/计数。[已证实：`projection.ts:397`、`gateway.ts:254-270`]
- 旧 mcpfs：错误多为吞掉或返回 `[]`；递归会让诊断非常困难。[已证实]
- 官方 FS server：日志走 stderr；无内置审计。[推断]
- 建议补：投影耗时、工具数、审批拒绝次数、网关调用延迟、token 估算；在拿到测量前不要复用 98.7%。[建议]

---

## 5. AutoAgent 采用建议

### 5.1 P0（必须，先做）

1. **完成并提交已经在工作树里的同步，不要回滚到旧实现。**
   - 当前 `services/mcpfs/*` 未跟踪、旧文件已删除、CodeAct 集成已修改；这是“半落地”状态，最容易丢失或产生构建漂移。
   - P0 动作：把 `src/services/mcpfs/`、`CodeActTool`、`prompt.ts`、`onChangeAppState.ts`、`codeActSandbox.ts`、`goalContinuation.ts`、`docs/mcp-fs.md` 一起提交；确认旧 `McpFsTool`、`mcpFilesystem.ts`、`mcpFsClient.ts`、旧两份 docs、`scripts/chatwise-to-mcpfs.ts` 的删除一并提交。
2. **把“旧路径已死”变成可执行门禁。**
   - CI 增加：`bun test src/services/mcpfs/__tests__/mcpfs.test.ts`（本机 13 pass / 0 fail / 760ms）。
   - CI 增加 grep 门禁：`McpFsTool`、`mcpFilesystem`、`mcpFsClient` 不得再被引用。
   - 增加 TypeScript 类型检查；当前工作树是一次大合并，必须确认没有断引用。
3. **明确唯一入口**：MCP-as-code 只走 CodeAct + mcpfs；不要再恢复 `mcpfs_discover/mcpfs_read/mcpfs_exec` 元工具族。旧实现的问题不是“某个 bug”，而是 discover/exec/bridge 三层耦合 + 无审批，修复成本高于替换。
4. **确认打包产物也走新路径。** 旧实现曾依赖仓库相对拷贝 `src/utils/mcpBridge.mjs`，安装包中失效；新实现把沙箱客户端作为模板内联在 `runtime.ts`，不依赖仓库文件。打包后要实际跑一次：连接一个 stdio MCP server → 读 README → import 绑定 → 调用 → 检查 `~/.claude/mcp-fs/servers/` 与网关环境变量。

### 5.2 P1（应该做，影响正确性/安全）

5. **修复投影指纹。**
   - 现状：指纹只覆盖 `connectionId + toolName + inputJSONSchema`；description、annotations、outputSchema 变化不会触发重写。
   - 建议：指纹改为“完整 snapshot 哈希”（tools/list 全量结果），或在每次 `tools/list_changed` 无条件重写该 server。
   - 直接收益：`readOnlyHint` 变化能及时反映到审批索引，避免“已变成破坏性工具但仍按只读自动放行”。
6. **决定 resources/prompts 的权限模型。**
   - 方案 A：把 `read_resource`/`list_resources`/`get_prompt` 纳入 `decideMcpCall`（至少按 server 审批）。
   - 方案 B：明确文档化为“资源读取视为只读、无需审批”，并在 UI/审计里可见。
   - 无论哪种，都补测试，避免未来误改。
7. **明确原生 MCP 工具的暴露策略。**
   - 如果目标是“用 mcpfs 省 schema token”，必须让原生 MCP 工具可被 defer/隐藏，否则模型仍会看到全部 schema。
   - 建议增加设置（例如“MCP tools: native / code-only / both”），默认保持兼容；`code-only` 时只投影、不注册原生 MCP tool。
   - 如果短期不做，就在文档里明确“mcpfs 是加法，不是 schema 替代”。
8. **可观测性与安全加固。**
   - 记录投影耗时、工具数、审批拒绝、网关错误码。
   - 对非只读工具继续坚持“静态扫描 + 运行期复核”；不要基于 tool description 自动放行。
   - 在生成 README 中标注“工具描述/服务器 instructions 是不可信输入”，提醒 agent 不要执行其中的指令。

### 5.3 P2（可选/对外）

9. **SafeFileService 保持现状，不要接进 mcpfs。** 它是 UI 文件功能的策略层，已有 root id、符号链接拒绝、大小上限、原子写、SHA CAS；这些正是 mcpfs 不具备的。若外部 MCP 客户端需要访问 AutoAgent 工作区，建议写一个薄的 MCP adapter 包在 `SafeFileService` 外，而不是直接暴露官方 Filesystem server；这样能保留 CAS、上限和 root 策略。
10. **官方 Filesystem MCP server 仅在“需要通用 MCP 文件接口”时采用。**
    - 固定 npm `@modelcontextprotocol/server-filesystem@1.0.0`。
    - 只挂载窄根目录；不要挂 `$HOME`、`/`、`~/.ssh`。
    - 加客户端审批；注意它没有结果上限、覆盖不是崩溃原子、`move_file` 目标存在即失败。
    - 如果只是 AutoAgent 自己用，原生 Read/Write/Edit/Bash + SafeFileService 已足够，没必要多一个 server 进程。

### 5.4 代码复用/替换清单

| 处理 | 路径 | 说明 |
|---|---|---|
| **直接复用** | `/home/tars/yysapp/AutoAgent/packages/opencc/src/services/mcpfs/projection.ts` | 与 MateBot 完全一致；投影、原子写、清理 |
| **直接复用** | `.../services/mcpfs/runtime.ts` | 沙箱 TS/Python 客户端；一行 JSON 协议 |
| **直接复用** | `.../services/mcpfs/gateway.ts` | 活连接、per-run token、审批复核 |
| **直接复用** | `.../services/mcpfs/approval.ts` | 静态扫描 → 一次审批 → 开 run |
| **直接复用** | `.../services/mcpfs/scan.ts` | TS/Python import 与字面量调用识别 |
| **直接复用** | `.../services/mcpfs/schema.ts` | 完整 JSON Schema → TS/Python |
| **直接复用** | `.../services/mcpfs/__tests__/mcpfs.test.ts` | 13 个端到端测试；本机通过 |
| **直接复用** | `CodeActTool.ts`、`CodeActTool/prompt.ts`、`onChangeAppState.ts`、`codeActSandbox.ts`、`goalContinuation.ts` | 集成点已改好 |
| **保留** | `/home/tars/yysapp/AutoAgent/backend/src/autoagent_backend/adapters/files/safe_file_service.py` | UI 文件策略层；不要替换 |
| **保留** | `api/routes/file_router.py`、`frontend/src/features/files/*` | 新 files 功能；不要接 mcpfs |
| **保留** | opencc 原生 `Read/Write/Edit/Bash` | agent 工作区文件操作的最短路径 |
| **替换/删除** | `src/utils/mcpFilesystem.ts`、`src/utils/mcpFsClient.ts`、`src/tools/McpFsTool/*` | 旧路径；已从工作树删除，确保提交 |
| **删除** | 旧 docs `mcp-fs-capabilities.md`、`mcpfs-tool-family-architecture.md`、`scripts/chatwise-to-mcpfs.ts` | 已删除；不要作为现行文档 |
| **不要采用** | 旧 `bridge.mjs` / `registry.json` / `mcpfs_discover` 设计 | 冷启动、无状态、无审批、已坏 |
| **按需采用** | 官方 Filesystem MCP server | 仅对外/通用 MCP 文件接口；窄根 |
| **按需新增** | SafeFileService 的 MCP adapter | P2；保留 CAS/上限/root 策略 |

### 5.5 何时用哪个

| 场景 | 选择 |
|---|---|
| 用户在桌面端浏览/编辑/上传/下载工作区文件 | **SafeFileService + file_router + FileBrowser** |
| agent 读写工作区单个文件 | **opencc 原生 Read/Write/Edit/Bash** |
| 多个 MCP server、批量/循环/过滤/join、需要服务端状态 | **opencc mcpfs 投影 + CodeAct** |
| 一次性调用 1 个 MCP 工具、结果很小 | 原生 MCP tool 直接调用即可；不必绕 mcpfs |
| 需要把文件能力提供给外部 MCP 客户端 | **官方 Filesystem MCP server**（窄根、审批）或自建 SafeFileService MCP adapter |
| 需要可移植的 root-scoped 文件 API，但不用 opencc | 官方 Filesystem MCP server |
| 需要 UI 级 CAS 写入、大小上限、符号链接拒绝 | **SafeFileService**（不要用官方 server 替代） |

---

## 6. 证据索引

### 6.1 公开来源

| 结论 | 证据 |
|---|---|
| Anthropic 的“tools as files + code execution”设计与 98.7% 示例 | https://www.anthropic.com/engineering/code-execution-with-mcp （Published Nov 04, 2025） |
| 原文数字：150,000 → 2,000 tokens，98.7%；无方法/数据集 | 同上，原文 “This reduces the token usage from 150,000 tokens to 2,000 tokens—a time and cost saving of 98.7%.” |
| 原文：工具多时需处理 “hundreds of thousands of tokens” | 同上 |
| 原文安全要求：secure execution environment with sandboxing, resource limits, monitoring | 同上 |
| 原文 PII tokenization：真实邮箱/电话/姓名不经过模型 | 同上 |
| 官方 Filesystem server 工具清单与 roots 行为 | https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/README.md |
| 官方工具注册、annotations（14 个，含 deprecated `read_file`） | https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/server.ts |
| 官方 `validatePath`、realpath/符号链接校验、O_NOFOLLOW、非崩溃原子写、search 无上限 | https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/lib.ts |
| `isPathWithinAllowedDirectories` 使用 `path.resolve(path.normalize(...))` + separator 边界；不做 symlink 解析 | https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/filesystem/path-validation.ts |
| npm 版本 `@modelcontextprotocol/server-filesystem` = `1.0.0` | `npm view @modelcontextprotocol/server-filesystem version dist-tags --json` 与仓库 `package.json` |

### 6.2 旧实现（HEAD / 保留副本，逐字节一致）

| 结论 | 证据（文件:行） |
|---|---|
| 自称实现 Anthropic 模式；目录结构 | `/home/tars/yysapp/AutoAgent-opencc-sync/packages/opencc/src/utils/mcpFilesystem.ts:8-31` |
| `ensureBridge()` 定义但未调用 | 同上 `:123` |
| 精简 bridge 读 `BRIDGE_TOOL_ARGS` | 同上 `:185` |
| 精简 bridge 固定 sleep 3000ms | 同上 `:192` |
| `ensureMcpFsRuntime()` 无条件自递归 | 同上 `:245-247` |
| wrapper 生成：顶层字段、`Record<string, unknown>`、限定名 | 同上 `:259-276` |
| `callMCPTool` / `MCP_ARGS` / `sh -c` / 300s | `/home/tars/yysapp/AutoAgent-opencc-sync/packages/opencc/src/utils/mcpFsClient.ts:17-69` |
| 执行沙箱 `bun run`、只回 stdout、继承 process.env | `mcpFilesystem.ts:479-601`（env 在 `:581-590`） |
| `discoverAndGenerate()` 触发递归 | 同上 `:628-632` |
| bridge 探测：spawn node、30s、5min cache | 同上 `:888-906`、`:935-993` |
| bridge 条目 `readOnly: false`、命令拼接 | 同上 `:996-1017` |
| 单工具执行走 `sh -c` | 同上 `:1030-1064` |
| 旧工具注册 | `git show HEAD:packages/opencc/src/tools.ts`，imports `:115-118`，注册 `:284-287` |
| 旧工具描述触发默认 probe | `.../tools/McpFsTool/McpFsTool.ts:34-39`；`McpFsExecTool.ts:33-45` |
| 旧工具权限：`mcpfs`/`mcpfs_exec` 非只读 | `McpFsTool.ts:48`、`McpFsExecTool.ts:53` |
| 旧文档：42 servers / 273+ tools | `git show HEAD:packages/opencc/docs/mcp-fs-capabilities.md:4` |
| 旧文档：沙箱不是安全边界、98.7%、300s | `git show HEAD:packages/opencc/docs/mcpfs-tool-family-architecture.md:98-103` |
| 旧实现重写原因（自递归、固定 3 秒、参数变量、类型、只读标记、0 工具） | `/home/tars/yysapp/AutoAgent/packages/opencc/docs/mcp-fs.md:5-7` |

### 6.3 新实现（当前 AutoAgent 工作树，与 MateBot 一致）

| 结论 | 证据（文件:行） |
|---|---|
| 定位：不是 MCP 客户端；投影活连接 | `/home/tars/yysapp/AutoAgent/packages/opencc/docs/mcp-fs.md:3` |
| 三层：projection / gateway / runtime | 同上 `:9-15` |
| 目录结构与原子替换/清理 | 同上 `:17-27`；`projection.ts:328-350` |
| 完整类型、outputSchema、raw result | 同上 `:29-34`；`schema.ts:32-265`；`runtime.ts:20-125` |
| 审批：静态扫描 + 一次审批 + 网关复核 + token 撤销 | 同上 `:50-60`；`approval.ts:25-113`；`gateway.ts:76-131, 276-300` |
| 投影触发与 250ms debounce | `projection.ts:382-455, 492-502`；`onChangeAppState.ts:173-183` |
| 指纹 = connectionId + toolName + inputSchema | `projection.ts:409-415` |
| `tools/list` 分页、instructions、version | `projection.ts:302-325` |
| resources/prompts capability 与 helper | `projection.ts:66-67, 257-258, 320-321`；`runtime.ts:112-126`；`gateway.ts:182-206` |
| 网关调用走活连接、原始结果不截断 | `gateway.ts:133-180` |
| token 24 bytes、timingSafeEqual、loopback | `gateway.ts:243-300` |
| CodeAct 审批入口 / 运行入口 | `CodeActTool.ts:186, 309, 334` |
| CodeAct prompt 指向 `~/.claude/mcp-fs/servers/` | `CodeActTool/prompt.ts:252-265` |
| 沙箱把 servers 目录链入；不是安全边界 | `utils/codeActSandbox.ts:11, 119-137, 331-340` |
| 测试：13 个，覆盖投影/list_changed/审批/状态/大结果/动态名/关闭 token/断开 | `services/mcpfs/__tests__/mcpfs.test.ts:174, 215, 240, 258, 270, 280, 293` |
| 本机测试结果 | `bun test src/services/mcpfs/__tests__/mcpfs.test.ts` → 13 pass / 0 fail / 31 expect / 760ms（2026-10-19） |
| 原生 MCP 工具仍进入工具池 | `tools.ts:443-478`；`services/mcp/client.ts:1799-1820` |

### 6.4 SafeFileService / 新 files 功能

| 结论 | 证据（文件:行） |
|---|---|
| root id + 相对路径；root_resolver + is_allowed_root 注入 | `/home/tars/yysapp/AutoAgent/backend/src/autoagent_backend/adapters/files/safe_file_service.py:1-20, 238-350` |
| 大小/条目/深度上限 | 同上 `:59-66` |
| 相对路径校验：拒绝绝对路径、`..`、反斜杠、NUL | 同上 `:355-386` |
| 符号链接逐段拒绝 | 同上 `:442` |
| resolve + inside 复查 | 同上 `:447-482` |
| list/stat/read/write/mkdir/rename/delete/copy/move | 同上 `:573, 656, 708, 771, 827, 854, 900, 948, 1008, 1064, 1120, 1149, 1208` |
| composition 只配一个 `workspace` root；未传 `is_writable_root` | `composition.py:267-285` |
| router 仅 loopback；端点列表 | `api/routes/file_router.py:64-90, 412-744` |
| 前端文件浏览器/编辑器/上传/预览/CAS 保存 | `frontend/src/features/files/fileClient.ts:1-20`；`FileBrowser.tsx:2, 165-200, 315-379, 461-497`；`useFileTree.ts:1-20` |
| 搜索仅过滤已加载节点，无后端搜索 | `FileBrowser.tsx:509-514, 736-750` |

---

## 7. 不确定性清单

- **[未知] token 收益**：没有 AutoAgent 本地 token 计数；Anthropic 的 98.7% 是单一示例，不是本项目的测量。不要把它写成 AutoAgent 的结论。
- **[未知] 延迟收益**：没有新/旧实现的本机延迟对比；只能说旧实现每次冷启动、新实现复用连接，不能给百分比。
- **[未知] 原生 MCP 工具是否会被上层 defer**：`assembleToolPool` 会并入全部 MCP tools，但 SDK/服务端是否另有 deferred tool 策略，未在本仓库确认。若上层已 defer，则 mcpfs 的 schema 收益更小；若没有，则收益取决于是否关闭原生暴露。
- **[推断] 旧 `ensureMcpFsRuntime` 的真实失败形态**：async 自递归通常表现为挂起/资源增长；旧文档称“栈溢出”。无论哪种，路径不可用。
- **[推断] 指纹缺 annotations 的实际安全影响**：取决于 server 是否会在不改变工具名/inputSchema 的情况下翻转 `readOnlyHint`；协议允许，但常见 server 很少这样做。
- **[推断] resources/prompts 不审批是否有意**：代码没有调用 `decideMcpCall`，但文档没有说明；需要产品确认。
- **[未知] 官方 Filesystem server 的完整 root 刷新并发语义**：README 描述了刷新屏障；本次只抓取了 README、index.ts、lib.ts、server.ts、path-validation.ts 的摘要，没有逐行审计 `roots-utils.ts`。
- **[未知] 生产环境打包行为**：新实现内联了沙箱客户端，理论上不依赖仓库文件；但没有在打包后的 Electron 产物里实际运行验证。

---

## 8. 交接（10 条）

1. **mcp-fs 的本质是“MCP 工具 → 代码 API”**：不是文件服务器，也不是 MCP 客户端替代品；核心收益是代码组合 + 中间结果留在执行环境 + 活连接复用。
2. **研究期间 AutoAgent 工作树被外部替换**：旧 `McpFsTool/mcpFilesystem` 已删除（`git status` 为 `D`），新 `services/mcpfs` 未跟踪（`??`），集成文件已修改；这是未提交的半落地状态。
3. **旧实现不是“有点 bug”，而是不可用**：`ensureMcpFsRuntime` 自递归、精简 bridge 读错参数变量、bridge 工具限定名与 registry 不匹配；三者任一都足以让旧路径失效。
4. **新实现与 MateBot 六个文件完全一致**：projection / runtime / gateway / approval / scan / schema；直接复用，不要重写。
5. **新实现的三层数据流**：app state → 投影器 → 磁盘 typed 模块；CodeAct → 静态扫描审批 → per-run token → loopback 网关 → 活 MCP 连接。
6. **状态复用有测试证据**：counter 跨 TS/Python 调用保持 5→9；大结果 200000 字符完整到达代码；动态拼名被 `not_approved` 拒绝；关闭 session 返回 `unauthorized`。
7. **13 个 mcpfs 测试本机通过**（13 pass / 0 fail / 760ms）；这是当前最可靠的质量证据。
8. **没有本地 token/延迟基准**；Anthropic 的 150k→2k / 98.7% 是公开文章中的单一示例，必须标注来源与局限。
9. **P0 = 提交并门禁这次同步；P1 = 修指纹（annotations/outputSchema）、定 resources/prompts 审批、定原生 MCP 工具暴露策略；P2 = 可选 SafeFileService MCP adapter / 官方 FS server 窄根接入。**
10. **文件能力的正确分层**：UI 用 SafeFileService + file_router + FileBrowser；agent 工作区用原生 Read/Write/Edit/Bash；MCP 多步工作流用 mcpfs；对外通用 MCP 文件接口才用官方 Filesystem server。
