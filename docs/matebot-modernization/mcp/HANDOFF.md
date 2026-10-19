# MCP 集成交接（Claude Desktop 逆向 + opencc/mcpfs 更新 + AutoAgent 参考实现）

> 状态（2026-10-19）：**vendored opencc 已更新到 MateBot HEAD `0ed706d` / 2.1.888**，新 `services/mcpfs` 已落地并通过构建/测试；根 `bun.lock` 已同步。
> 本目录是研究 + 参考实现；`reference/` 未应用到 AutoAgent 源码。

## 文件

- `ANALYSIS-CLAUDE-DESKTOP.md` — Claude Desktop MCP 端到端逆向（53 KB）
- `ANALYSIS-MCPFS.md` — mcp-fs 四种设计对比与采用建议（42 KB）
- `reference/README.md` — AutoAgent MCP 目标架构、协议、安全、集成映射
- `reference/PATCH_PLAN.md` — 文件级 T0/T1/T2、迁移、回滚
- `reference/VERIFICATION.md` — 本轮实际运行结果
- `reference/backend/{transports,connection_manager,approval}.py` — stdlib 持久连接参考实现
- `reference/backend/test_mcp_manager.py` — 13 个测试
- `reference/frontend/{mcpStatusClient.ts,McpStatusPanel.tsx}` — 状态/日志/审批 UI 参考
- `../opencc-update/REPORT.md`、`APPLIED_DEVIATIONS.md` — opencc 更新报告

## 一、Claude Desktop MCP 的关键结论

- **桌面 `claude_desktop_config.json` 只支持 stdio**（`command/args/env/extensionId`）；HTTP/SSE/OAuth 在企业直连层（directMcpHost）和 Claude Code 层。
- 桌面采用 **renderer-as-client + MessagePort**：主进程 `mcp-server-connected` 把 port 交给 renderer，renderer 做 JSON-RPC；stdio 是 NDJSON，缓冲上限 10 MB，环境变量走白名单。
- `directMcpHost`：SSE / Streamable HTTP；init 10s / call 60s；3 次 terminal error；404 session 重新初始化；拒绝重定向；401/403 单次重试。
- 重连预算：**5 连续 / 15 总计**，30s 惰性冷却；`needs-auth` 不自动重试。
- 工具命名：`mcp__<server>__<tool>` + sanitize + 保留名/碰撞检测（安全边界）。
- 审批：**blocked > ask > ask-session > allow**，非法值 fail-closed 到 blocked；per-call 审批后必须**再次检查策略**（避免 TOCTOU）。
- OAuth：PKCE S256 + loopback + 拒绝重定向 + refresh + 加密存储；DCR/hosted client assertion 未做。
- DXT/.mcpb 与 MCP Apps（`ui://`）是独立体系；widget 需要独立 iframe 域 + CSP + 权限声明，**P2**。
- 重要未知：敏感 MCP flag 的运行时逻辑、Claude Code 完整逐 scope 加载器、MCP Apps iframe sandbox 细节。

## 二、mcp-fs 的优势（重点）

**mcp-fs 不是 Filesystem MCP server，而是把 live MCP 连接投影成可 import 的 typed 代码模块。**

旧 AutoAgent 实现（已删除）：
- `mcpfs` / `mcpfs_discover` / `mcpfs_read` / `mcpfs_exec` 四个元工具 + `mcpFilesystem.ts` + `bridge.mjs`。
- 每次调用走 subprocess bridge，**冷启动、无状态、无审批**；实现本身还有递归/参数变量/限定名三处致命问题，实际不可用。

新 MateBot/opencc `services/mcpfs`（已同步进 AutoAgent）：
- `projection.ts`：把连接投影成 `~/.claude/mcp-fs/servers/<server>/<tool>.ts|py`，连接变化时重写。
- `runtime.ts`：沙箱侧 `_mcpfs.ts/_mcpfs.py`，通过 loopback gateway + per-run token 调宿主。
- `gateway.ts`：复用 opencc 已持有的活连接，**服务端状态跨调用/跨运行保持**。
- `approval.ts` + `scan.ts`：静态扫描代码引用 → 只读自动放行 → 一次审批 → 网关逐次复核。
- `schema.ts`：完整 JSON Schema → TS/Python 类型（嵌套/enum/anyOf/oneOf/数组/元组/$ref/nullable）。
- 13 个测试通过：状态持久化、200 KB 原始结果、动态拼名拒绝、token 撤销。

优势总结：
1. **上下文经济**：工具 schema 不常驻，中间结果留在执行环境，只回 `print/console.log`。
2. **延迟/状态**：每次调用只是一个本地 socket，不是冷启动进程；服务端会话状态保留。
3. **类型**：完整 input/output schema，TS + Python，支持 resources/prompts。
4. **审批**：按代码引用做一次审批，运行期网关复核，deny/allow 规则一致。
5. **生态**：底层仍是标准 MCP，任何 server 都能被投影。

需要修的 P1：
- 投影指纹只覆盖 `connectionId + toolName + inputJSONSchema`；`description/annotations/outputSchema` 变化不会刷新，`readOnlyHint` 可能过期。
- `read_resource/list_resources/get_prompt` 尚未经过 `decideMcpCall`；需明确按 server 审批或文档化为只读。
- 原生 MCP tools 仍全部注册；若目标是省 schema，需要 `native / code-only / both` 暴露策略。
- README 中要提醒：工具描述和 server instructions 是**不可信输入**。

分层建议：
- UI 文件功能：`SafeFileService + file_router + FileBrowser`（保留）。
- agent 工作区文件：opencc 原生 `Read/Write/Edit/Bash`。
- 多步 MCP 工作流：**mcpfs + CodeAct**。
- 对外通用 MCP 文件接口：官方 `@modelcontextprotocol/server-filesystem`（窄根、审批）。
- 一次性小结果：原生 MCP tool 直接调用即可。

## 三、opencc 更新结果

- Before: `1.0.2`，base `4c83c36`；After: **`2.1.888`**，HEAD `0ed706dd8d54c9715bff2bf7c9444543294f9148`。
- 合并 177 commits / 482 files，`packages/opencc` 225 个变更（142 M / 73 ?? / 10 D）。
- 本地偏差全部保留：`--server` fast path、`ANTHROPIC_BASE_URL`、`AUTOAGENT_RG_PATH`、`.autoagent` CLAUDE.md/rules/skills、`reg.exe`、Windows 路径、highlight.js pin、`engine.ts/server.ts/headlessState.ts`、本地删除项。
- MCP-FS：旧 `McpFsTool` 族/`mcpFilesystem.ts`/`mcpFsClient.ts` 删除；新 `src/services/mcpfs/*` 接入；无重复工具名。
- 根 `bun.lock` 已更新（45 insertions / 1 deletion），`bun install --frozen-lockfile --ignore-scripts` 通过。
- 验证：`bun run build` → 5,450 modules / 21.45 MB；`mcpfs + matebotMode` 测试 **18 pass / 0 fail**；`bun dist/cli.js --version` → `2.1.888 (opencc)`；bundle 含 `matebot/mcpfs/OPENCC_MCPFS/--server/ANTHROPIC_BASE_URL/AUTOAGENT_RG_PATH/.autoagent`。
- 已知：`tsc --noEmit` 156 个错误与上游 HEAD 完全一致（非本次引入）；`goalDecision.test.ts` 在上游也失败；完整 `turn/start` 未跑（需要凭据/网络）。

## 四、AutoAgent MCP 参考实现（T0）

目标：把当前“每次 discover/call 都新建短连接”的 MCP client 换成持久连接管理器。

现状审计（本轮读码确认）：
- 每次 discover/call 新建短连接，协议固定 `2024-11-05`，`sse` 路由不正确；
- 没有 Streamable HTTP、notifications、tools 缓存失效、status/logs、approval、resources/prompts；
- 引擎从未消费 `mcp_servers`；SQLite 里的密钥是明文。

边界建议：
- **T0/T1**：后端 manager 负责 UI、配置、状态和直接调用。
- **T2**：让 opencc/MateBot engine 成为 turn/CodeAct 调用的唯一 owner，把启用的 spec 同步到它的 MCP 配置。
- **不要**把后端调用转发到 per-run 的 mcpfs gateway —— 它是 sandbox-scoped，不是控制面。

- `connection_manager.py`：per-server 持久会话、懒连接、健康检查、重连/退避、并发、超时、取消、`tools/list_changed` 缓存失效、状态回调。
- `transports.py`：stdio（argv + 最小 env + 进程组 kill）、Streamable HTTP（`Mcp-Session-Id`、`MCP-Protocol-Version`、`Accept`、SSE 解析）、legacy SSE。
- `approval.py`：`readOnlyHint/destructiveHint/idempotentHint/openWorldHint`、allowlist、per-call consent、deny 规则。
- resources/prompts：`list_resources/read_resource/list_prompts/get_prompt`。
- 前端：连接状态、最后错误、工具数、重连、日志抽屉、approve/deny。
- 验证：**14 pytest pass**、ruff clean、mypy strict、tsc exit 0；开发中发现并修复了 stdio reader 与 connect lock 的死锁。

T0 集成（详见 `reference/PATCH_PLAN.md`）：
1. 新增 `backend/src/autoagent_backend/adapters/mcp/{connection_manager,transports,approval}.py`。
2. `application/mcp_service.py` 改为使用 manager；`api/routes/mcp.py` 增加 status/logs/resources/prompts/approve 端点。
3. `composition.py` 构造并关闭 manager；`config.py` 增加超时/重连/审批策略。
4. 前端 `McpPanel` 增加状态/日志/审批；`api/client.ts` 增加类型。
5. 保留现有短连接实现作为 `AUTOAGENT_MCP_PERSISTENT=0` 回滚。

## 五、优先顺序

- **P0**：提交 opencc 同步 + root `bun.lock`；给 mcpfs 加 CI（13 tests + grep 门禁）；AutoAgent 后端持久连接 + 状态/日志（T0）。
- **P1**：修投影指纹（annotations/outputSchema）；resources/prompts 审批；原生 MCP tool 暴露策略；per-call 审批后二次检查；重连预算/冷却。
- **P2**：OAuth PKCE、DXT/.mcpb、MCP Apps `ui://`、官方 Filesystem MCP server 窄根接入。

## 六、风险

- 投影指纹过期可能导致 `readOnlyHint` 变更后仍自动放行（安全）。
- resources/prompts 当前未走审批（需明确策略）。
- AutoAgent 参考实现未接入 FastAPI/EventBus；需在真实路由下补 integration test。
- opencc 更新未提交；工作树还有其他特性改动，提交时请分开 commit。
- 不要在 AutoAgent 仓库执行盲目的 `git clean`。
