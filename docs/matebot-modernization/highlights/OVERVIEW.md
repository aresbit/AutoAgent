# Claude Desktop 亮点设计总览（2.42304.0 Linux）

> 汇总来源：
> - `highlights/platform-security.md`（53 KB）
> - `highlights/observability.md`（55 KB）
> - `highlights/orchestration.md`（73 KB）
> - `highlights/ux-design.md`（48 KB）
> - 以及 `artifacts.md`、`generative-ui.md`、`terminal.md`、`file-system.md`、`browser-system.md`、`mcp-claude-desktop.md`、`mcp-fs.md`
>
> 标记：`[已证实]` 有代码/资产/字节证据；`[推断]` 由证据组合推出；`[未知]` 未定位。

---

## 0. 结论速览（Top 20）

| # | 亮点 | 评级 | 一句话 |
|---|---|---|---|
| 1 | **三类不可信输入的默认拒绝** | S | 内容/进程/配置都做成“默认拒绝 + 身份可验证 + 失败即关闭 + 自检”，不是堆开关。 |
| 2 | **分区网络 kill-switch + 自检** | S | 假代理 `255.255.255.255:9` + `<-loopback>` + 主动探测；自检失败不返回任何内容。 |
| 3 | **fd-relative safe-fs** | S | `*Beneath` + `openat2` + `O_NOFOLLOW` + dev/ino/nlink；原生绑定失败拒绝退回路径式 open（CC-2885）。 |
| 4 | **三层 IPC 信任** | S | `webContents.ipc` 作用域 + 逐接口 origin 校验 + 参数/返回 schema；顶层 frame 只是必要条件。 |
| 5 | **Artifacts = 文件 + manifest + 独立视图** | S | 不是 iframe 组件，而是 `WebContentsView` + `cowork-artifact://` + 网络黑洞 + 能力桥 + 快照版本。 |
| 6 | **EngineSurface 声明式生成式 UI** | S | 类型化 JSON 树 + 预算 + Shadow DOM 渲染 + `coalesce/supersede` + 两次 null 回退。 |
| 7 | **Terminal 独立 utility process** | S | `pty-host` 隔离原生崩溃/阻塞；VT scrollback、watchdog/cooldown、shell integration nonce、命令四道门。 |
| 8 | **mcpfs：live MCP 连接投影成代码** | S | 工具变 typed TS/Python 模块；gateway 复用活连接；中间结果不进上下文；审批+运行期复核。 |
| 9 | **多层父子会话编排** | S | 明确 parent/child 边、任务 brief、结果通知、权限继承、detach；不是一个大循环。 |
| 10 | **Turn 级持久输入状态机** | S | `userMessageUuid` 贯穿 turn；held/kept/deferred；崩溃/重启/换账号不丢用户输入。 |
| 11 | **Context 自动恢复** | S | 检测 context full → `/compact` → 续跑；有状态、证据、遥测、失败处理。 |
| 12 | **Worktree 池 + 租约 + kept-dirty** | S | 池化/复用/清理/脏树保留/WIP stash；不是用完即删。 |
| 13 | **定时任务 ack/claim** | S | 发出 `session_started` 后 5s 等 ack；未 ack 不消耗 slot；3 次超时停泊；重连恢复。 |
| 14 | **三平面可观测性 + 双闸门** | S | 本地日志 / 产品事件 / Sentry+crash 独立；essential/non-essential 都 fail-closed。 |
| 15 | **Event-loop stall sampler** | S | SAB + Atomics 心跳，阻塞时 inspector 抓 CPU profile；区分真卡顿与睡眠/重启。 |
| 16 | **启动性能检查点** | A+ | pre-import → main → window → DOM → composer/sidebar，最终一条 `desktop_app_startup_perf`。 |
| 17 | **优雅退出可观测** | A+ | 命名 quit handlers + 75s 预算；记录耗时/pending/watchdog，下次启动回报。 |
| 18 | **浏览器预览的导航/权限/私网防线** | A+ | 每 tab 一个 `WebContentsView`；权限默认拒绝；DNS rebinding/私网 fail-closed；CDP 工具。 |
| 19 | **UX 手感工程** | A+ | 令牌六层、滚动渐隐、流式 follow 控制器、boot placeholder、双环焦点、IME 守卫、复制衰减。 |
| 20 | **平台安装生命周期即安全面** | A | apt keyring + signed-by + unattended-upgrades + AppArmor userns + GNOME search 硬化。 |

---

## 1. 安全与平台：最强的一组设计

### 1.1 网络 kill-switch + 自检 [已证实]

对 Cowork artifact/file 预览分区：

- 固定代理 `http://255.255.255.255:9`，`proxyBypassRules:"<-loopback>"`。
- 主动请求 `https://127.0.0.1/`，只有代理返回 `PROXY 255.255.255.255:9` 才认为网络关死。
- 自检失败 → 协议 handler 直接 `Response.error()`，**宁可不显示内容**。

> 可借鉴：任何“离线/不可联网”沙箱都不要只信配置；加一个主动自检并 fail-closed。

### 1.2 fd-relative safe-fs [已证实]

原生绑定：`open_beneath / mkdir_beneath / rename_beneath / rmdir_beneath / stat_beneath / unlink_beneath / open_root_dir`；字符串含 `openat2`、`fstatat/statx`、`readlinkat`、`renameat2`、`FICLONE`。
JS 层再叠逐段 `lstat`、realpath、dev/ino/nlink 复核。

**关键设计**：原生绑定加载失败时明确拒绝退回路径式 `open`（CC-2885）。

### 1.3 三层 IPC 信任 [已证实]

1. 通道挂在 `webContents.ipc`，天然按 WebContents 隔离；
2. 每个接口生成独立 sender 校验器（origin/主机/顶层 frame）；
3. 方法参数与返回值都做 schema 校验；
4. `XNa(senderFrame)` 作为兜底，仅允许顶层 frame + Claude 主机。

### 1.4 托管配置 fail-closed [已证实]

`/etc/claude-desktop/managed-settings.json`：

- `O_NOFOLLOW|O_NONBLOCK` 打开；
- 必须是普通文件、uid 0、非 group/world writable；
- 每个键声明 `failClosedValue`；不可读时按 `managed-settings-unreadable` 拒绝相应表面。

### 1.5 平台 helper 的安全边界 [已证实]

- `connectUnixSocketSameUid`（SO_PEERCRED）认证 Cowork helper；打包版缺失原生校验即拒绝连接。
- Chrome native host：manifest 只列 3 个扩展 ID；socket 目录 `0700`、socket `0600`、非符号链接、属主校验。
- SSH askpass：每连接 FIFO + PID/进程谱系 + peer 校验；relay 消失时终止 ssh，不返回空密码。
- Cowork VM：QEMU `-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,...`；vsock 随机 CID + `expectedCID`。

### 1.6 打包生命周期 [已证实]

- 独立 apt keyring + `signed-by=`；站点作用域 `unattended-upgrades`。
- AppArmor userns profile 按 `abi/4.0` 门控；SUID `chrome-sandbox` 作为后备。
- `/etc/default` 解析而非 source；写前 `rm -f` 防符号链接穿透。
- postrm 对管理员自有文件保守。

> **不要照搬**：过度复杂的 36 档色板/952 CSS 变量、DXT/MCP Apps 全套、Chromium 级 helper 拆分。按 AutoAgent 的威胁模型取子集。

---

## 2. Artifacts 与生成式 UI

### Artifacts [已证实]

- 数据模型：`Artifacts/<id>/{index.html,thumbnail.png,versions/*.html,debug.jsonl}` + `artifacts.json` manifest。
- 渲染：独立 `WebContentsView` + `cowork-artifact://local/<id>/index.html` + 独立 persistent partition。
- 网络：假代理 + 协议/请求白名单 + CSP + 权限全拒绝。
- 页面能力只有 `window.cowork.{callMcpTool,askClaude,runScheduledTask}`。
- 版本：全量 HTML 快照（≤100）；restore = 读回快照再生成新版本。
- 分享：`share_from_content`（≤1M 字符）+ 导入轮询。

### 生成式 UI [已证实]

- `EngineSurface` 19 个 invoke + 6 个 push 事件。
- `uiRender` 返回类型化 JSON 树：`Box/Text/Button/Input/Select/Link/Code/Markdown/Svg/Client/engine/fragment`。
- 预算：节点 <2000、深度 <32、字符 <262144；props 单值 ≤65536。
- 交互：`uiPress/uiInput/uiSelect/uiScroll/uiFocus`，不是 DOM 事件透传。
- 节奏：`coalesce`（流式）与 `supersede`（一次性）；两次 `null` 回退内建渲染。
- Pane：roster + `uiPaneShow/Focus/Close`；宿主做 tab/Esc/toast 策略。

> 可借鉴：把“声明式 UI”和“任意 HTML artifact”彻底分开；前者可校验/可回退，后者只进沙箱。

---

## 3. Terminal / Filesystem / Browser

### Terminal [已证实]

- 三层：renderer(xterm) → 主进程 `ShellPtyManager` → `pty-host` utility process → node-pty。
- `pty-host` 协议：`spawn/write/resize/kill/read-scrollback` + `spawned/data/exit/spawn-error/spawn-fallback/scrollback-read`。
- 40s watchdog、崩溃 refork、30s→10min 指数退避。
- 两套缓冲：256 KiB 原始 VT replay（重连）vs 磁盘纯文本日志（MCP 分页/grep）。
- shell integration：0600 nonce、TTL 60s、读完即删；OSC 133 必须带 nonce。
- 命令四道门：单行 ASCII/长度 → 静态危险构造 → 真实 shell `-n` → idle + shell 一致 → 逐字键入。

### Filesystem [已证实]

- FileSystem 19 方法；路径根 `local-agent-mode-sessions/<acct>/<org>/<session>`、`~/Claude`、uploads/outputs。
- 分层校验：允许根 + 扩展名封锁 + symlink 40 跳 + realpath + dev/ino TOCTOU + 单文件 consent + 管理员只读。
- 索引：独立 worker，`git ls-files` + 浅 BFS 回退；`rg`/`git grep` 回退。
- 缩略图：20 MiB/50MP/2048；Drive 导出 30 MiB/18 分钟。

### Browser [已证实]

- 每 tab 一个 `WebContentsView` + 每上下文一个 `containerView`；renderer 只上报 bounds。
- 导航两套信任等级：普通浏览 vs 模型发起的 `mcp-tool` 导航（Allowed-sites/session grant/私网卡片/组织策略 + epoch TOCTOU）。
- 本地内容三条路径：静态 `data:` + 极严 CSP；`.html/.svg` 裸 `data:`；交互式 content tab。
- 权限默认拒绝；媒体拒绝；WebAuthn 取消；PDF 强制下载。
- Browser 工具是 **in-app CDP**（`preview_*`/`read_page`/`computer`/`form_input`/网络/console），不是 Playwright。
- Chrome native host + `$BROWSER` shim；Framebuffer 为 VNC/RFB 类。

---

## 4. MCP 与 mcpfs

### Claude Desktop MCP [已证实]

- 桌面 `claude_desktop_config.json` **仅 stdio**；HTTP/SSE/OAuth 在企业直连/Claude Code 层。
- renderer-as-client + MessagePort；stdio NDJSON 10 MB；env 白名单。
- directMcpHost：SSE/Streamable HTTP；init 10s/call 60s；3 次 terminal error；404 session 重初始化；拒绝重定向；401/403 单次重试。
- 重连 5 连续/15 总计 + 30s 冷却；`needs-auth` 不自动重试。
- 工具名 `mcp__server__tool` + sanitize + 保留名/碰撞检测。
- 审批 `blocked > ask > ask-session > allow`；per-call 后二次检查。
- OAuth PKCE S256 + loopback + refresh + 加密存储。

### mcpfs 优势 [已证实]

- **不是文件服务器**，而是 live MCP 连接 → typed TS/Python 代码投影。
- `projection`（连接变化重写）+ `runtime`（sandbox 客户端）+ `gateway`（复用活连接、per-run token）+ `approval/scan/schema`。
- 中间结果留在执行环境；只回 `print/console.log`；服务端状态跨调用/跨运行保持。
- 13 个测试通过；旧 `McpFsTool` 不可用，已删除。
- P1：投影指纹未覆盖 `annotations/outputSchema`；resources/prompts 未走审批；原生工具仍全量注册。

---

## 5. 会话编排

Top 亮点 [已证实]：

1. **多层父子会话**：`start_task/start_code_task/send_message/read_transcript`；side session、fork、subagent worktree；空闲回注通知。
2. **Turn 级持久输入**：`userMessageUuid` 主线；queued/started/completed；held/kept/deferred；崩溃/重启不丢输入。
3. **Context 自动恢复**：context full → `/compact` → 续跑；有状态/原因/遥测。
4. **Worktree 池 + 租约**：`leasedBy/cliBound/status`；池化/复用/keep-dirty；WIP commit/stash + OID 校验。
5. **调度 ack/claim**：5s ack；未 ack 不消耗 slot；3 次超时停泊；renderer 重连恢复。
6. **控制记录与 transcript 分离**：Desktop JSON（AutoAgent 可映射 SQLite）+ Claude Code `.jsonl`。
7. **分层信任**：cwd/SSH endpoint/session/task/dispatch 多层，授予/撤销有 provenance。
8. **可见性驱动 warm/idle/prewarm**：隐藏 15 分钟回收；重新可见预热；1s 错峰；spare 池。
9. **Transcript 搜索 worker**：4 路并发、compact boundary、50 MiB 上限、`O_NOFOLLOW`。
10. **EngineSurface**：声明式 UI 总线；4s host-ask 超时；pane/focus/scroll。

> 注意：bundle 中没有名为 `agent registry`、`persistent child`、`swarm` 的独立机制；`checkpoint` 主要指 SSH 重放检查点，不是通用对话 checkpoint。`[已证实]`

---

## 6. 可靠性与可观测性

### 三平面 [已证实]

1. 本地 winston 文件日志（main/window/mcp/cowork_vm，轮转、0600）。
2. 产品事件遥测 `/api/event_logging/v2/batch`（non-essential）。
3. Sentry + crashpad（essential）。

### 双闸门 [已证实]

- essential / non-essential 独立开关；管理配置 `failClosedValue: true`。
- 远程值未验证时不应用，除非 `applyUnverified` 或等于 fail-closed 值。

### Stall sampler [已证实]

- 独立 worker + `SharedArrayBuffer + Atomics` 心跳；200ms 轮询。
- 主线程阻塞超阈值 → V8 inspector CPU profile。
- 区分 OS suspend/resume、更新重启；附带 GC/内存/焦点/最近任务。
- 事件 `desktop_main_event_loop_stall`。

### 其他 [已证实]

- 启动单调检查点：`__claudeMainJsStartMs` → pre-import → managed config → Sentry → window → DOM → composer/sidebar → `desktop_app_startup_perf`。
- 通用 worker 监管器：互斥/超时/取消/首 reply proven/30s→10min 退避/惰性 refork。
- 优雅退出：75s 预算 + 命名 handlers + 下次启动 `desktop_quit_cleanup_summary`。
- Support Bundle：section registry + `defaultChecked/appliesIn/countsTowardLogHealth` + zip/manifest + 同意发送 + 独立脱敏。
- 更新：`restartToUpdateWhenIdle` 监听 turn/held_input/background_task/loop/remote_client 等活动；空闲才安装；60s 复查。Linux 收敛到 apt。

> 修正：种子里的 `ui_render:ask/answer/applied/invalidate`、`ui_press:sent` 在本构建**不存在**；`ancientJournal` 是死代码。`[已证实]`

---

## 7. UX / 设计系统

Top 亮点 [已证实/推断]：

1. **令牌六层**：palette → ramp → elevation → purpose → density → motion；组件只消费 purpose 层。
2. **滚动边缘渐隐**：CSS scroll-driven animation + 7 段非线性 mask + `mask-composite:intersect`，主线程零成本。
3. **流式跟随控制器**：24px pin 容差、触摸/隐藏暂停、程序写入/迟到帧区分、pinned/written/late/missed 指标。
4. **Boot placeholder**：复用上次侧栏布局（288px，<700px 折叠），首帧内联绘制，缩放同步。
5. **双环焦点**：内环挖空 + 外环 accent + 6px 光晕；禁用控件焦点重路由。
6. **IME 守卫**：`isComposing` + keyCode 229 + `Process`；合成结束 500ms 内 Enter 不误发送。
7. **复制衰减**：2s 后回落、富文本、过期调用保护、`role="status"`。
8. **标题栏 overlay**：按 zoom 计算高度（36px 基准、最小 24px）；无痕 44px；模态遮罩联动。
9. **查找栏 CJK 特化**：拉丁 >2 字符，CJK 2 字符；250ms 防抖；关闭 10ms 还焦点。
10. **同意页隔离**：无框架、`textContent`、500ms 输入保护、焦点陷阱。
11. **Quick Entry skooch**：606×470 透明浮窗；贴边内移 30px；关闭 30s 内恢复前台应用。
12. **离线小游戏**：连接失败兜底；`role="application"`、Space 开始、reduced-motion 感知。
13. **i18n**：43 个唯一 locale、65 个 JSON、react-intl、49 条 plural、前缀回退。
14. **可访问性**：aria/role/focus 管理/强制色/粗指针/减少动态；仍有缺口（Quick Entry/查找栏 IME）。

> 可借鉴：优先复刻语义令牌、双环焦点、复制衰减、IME 守卫、纯 CSS 滚动渐隐、流式 follow、boot placeholder；不要复制专有字体/插画/Clawd Quest。

---

## 8. 可借鉴评级与 AutoAgent 建议

### P0（1–3 天，直接提升正确性/可运维性）

1. **统一事件信封 + essential/non-essential 闸门**（本地日志/产品事件/错误分开）。
2. **启动检查点**（backend spawn → health → window → DOM → composer；一条 startup 事件）。
3. **通用 worker/PTY 监管器**（互斥/超时/取消/首 reply proven/退避/惰性 refork）。
4. **优雅退出摘要**（handler 耗时/pending/watchdog，下次启动回报）。
5. **Support Bundle MVP**（section registry + zip + 脱敏 + 用户同意）。
6. **Turn 级持久输入/outbox**（发送前落库；ACK 后标记；重启重放）。
7. **UX 四件套**：语义令牌、双环焦点、IME 守卫、复制衰减。
8. **流式 follow 控制器** + **boot placeholder**。

### P1（1–2 周）

9. **Worktree 池/租约/keep-dirty**。
10. **调度任务 ack/claim**。
11. **Context 自动 compact + 续跑**。
12. **mcpfs P1 修复**：投影指纹、resources/prompts 审批、原生工具暴露策略。
13. **简化版 stall sampler**（SAB 心跳 + 采样堆栈/事件；不必一开始就 CPU profile）。
14. **浏览器导航/私网/DNS rebinding fail-closed**（已有 PreviewManager，可补）。
15. **SafeFileService 升级 openat2/O_NOFOLLOW/fd 校验**（已有部分）。

### P2（按产品需要）

16. **声明式 pane 白名单**（table/metrics/choices/form/diff/callout）。
17. **OAuth / DXT / MCP Apps `ui://`**。
18. **VNC/Framebuffer / Cowork VM**。
19. **完整 AppArmor/apt 发布链**（如果做 Linux 包）。
20. **RTL / 43 locale**（有真实需求再做）。

### 不要照搬

- 952 个 CSS 变量 / 36 档色板 / 专有字体与插画。
- 全套 DXT/MCP Apps/Chrome native host（除非有对应生态）。
- 把所有逻辑塞进 339 个 LocalSessions 方法；按域拆分。
- 通用 `checkpoint` 的误解：Desktop 的 checkpoint 主要是 SSH 重放，不是对话快照。

---

## 9. 证据索引

| 主题 | 文件 |
|---|---|
| 平台/安全 | `highlights/platform-security.md` §3-§7 |
| 可观测性/可靠性 | `highlights/observability.md` §3-§5 |
| 会话编排 | `highlights/orchestration.md` §2-§5 |
| UX/设计系统 | `highlights/ux-design.md` §1-§7 |
| Artifacts | `artifacts.md` |
| 生成式 UI | `generative-ui.md` |
| Terminal | `terminal.md` |
| Filesystem | `file-system.md` |
| Browser | `browser-system.md` |
| MCP | `mcp-claude-desktop.md`、`mcp-fs.md` |
