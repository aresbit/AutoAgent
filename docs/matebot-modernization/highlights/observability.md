# Claude Desktop 2.42304.0：可靠性、可观测性与发布工程亮点

> 研究对象：`/home/tars/yysapp/claude-desktop/app`（Electron 主进程/预加载/渲染器 minified JS）与 `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources`（含 `ion-dist` Web 资产）。
> 辅助证据：`asset/rea_application_graph.json`、`asset/ipc_services.json`。
> 证据格式：`文件:字节偏移`。构建产物为单行 minified JS，偏移是该行内的字节位置；符号名取自反混淆后的局部函数名/字符串。
> 版本：`2.42304.0`，commit `e7f60e658f15cfece9efa384a78a39aec3c12845`。

---

## 1. 结论速览（按“值得借鉴”排序）

1. **[已证实] 观测被拆成三条互不替代的平面**：本地 winston 文件日志、产品事件遥测（`/api/event_logging/v2/batch`）、Sentry/原生崩溃。三条平面分别有独立的开关、脱敏和失败策略，而不是“一个 logger 打天下”。  
   证据：`app/.vite/build/index.pre.js:804658`（主 logger）、`:910011`（Sentry DSN）、`app/.vite/build/index.chunk-Z7WxBjyE.js:2979261`（事件队列 flush）、`:2987389`（手工诊断发送）。

2. **[已证实] “essential / non-essential” 双层遥测 + fail-closed**：崩溃报告（Sentry、Datadog RUM）属于 essential；`/api/event_logging/` 属于 non-essential。管理配置里两个开关都声明 `failClosedValue: true`：远程缺失键默认禁用，解析失败时回落到禁用；同时 `applyUnverified: true` 表示“格式正确但未验证”的远程值仍可应用。  
   证据：`index.pre.js:574681`（disableEssential）、`:575318`（disableNonessential）、`:826819`（`j1(e)=!e()&&!process.env.CI`）。

3. **[已证实] 事件循环卡顿采样器（stall sampler）是整套设计里最强的可靠性观测**：独立 worker 通过 `SharedArrayBuffer + Atomics` 心跳检测主线程阻塞；超过阈值时用 V8 inspector 抓 CPU profile；能区分“真卡顿”和 OS suspend/resume、更新重启造成的假象；并把 GC、内存、最近任务、窗口焦点状态一起上报。  
   证据：`app/.vite/build/stall-sampler-worker/stallSamplerWorker.js:0-2033`；`index.chunk-Z7WxBjyE.js:5238452`（`QUi` 心跳）、`:5238825`（worker 路径）、`:5238837`（开关）、`:5241987`（sleep 分类）、`:5244101`（`desktop_main_event_loop_stall`）。

4. **[已证实] 端到端启动性能埋点**：主进程用 `process.uptime()` 的单调检查点表，从 `__claudeMainJsStartMs`、pre-import、managed config、Sentry init、bundle start，到 window created/visible、main view request/headers/DOM ready，再到 Web 侧的 `claude:composer_input_ready` / `claude:sidebar_painted`，最终合成一条 `desktop_app_startup_perf` 事件。  
   证据：`index.chunk-Z7WxBjyE.js:6716028`（`V9.set`）、`:6718738`（`__claudeMainJsStartMs`）、`:6719155`（`main_imports_loaded`）、`:6720401`（事件）；`index.chunk-CJaTtjRj.js:653/685/5567`（PerformanceObserver）。

5. **[已证实] Support Bundle 不是“把日志打个包”，而是可组合 section registry**：metadata / logs / crash 三类 section，每个 section 有 `defaultChecked`、`appliesIn`、`countsTowardLogHealth`；打包为 zip + `manifest.json`，既能导出也能在同意后作为事件发送。  
   证据：`index.chunk-Z7WxBjyE.js:5039200-5047800`（section 表）、`:5046449`（`uOi`）、`:5048952`（状态机）、`:5051557`（发送体）、`:125389`（zip 内逐文件脱敏）。

6. **[已证实] 通用 utility worker 监管器**：请求互斥、超时、可取消、超时杀 worker、首个 reply 才算 “proven”、early death 指数退避（30s 起、上限 10min）、退出后按需惰性 refork、MessagePort 传输缓冲。PTY host 另有 40s watchdog。  
   证据：`index.chunk-Z7WxBjyE.js:2629472`（`Jon=30000`、`Yon=600000`、cooldown）、`:2632550`/`:2632972`（`killAndClear`/`ensureWorker`）；`index.chunk-CbknQPGf.js:5054`（`ce=40000`）、`:7834`（`armWatchdog`）、`:8234`（`forkWorker`）。

7. **[已证实] 优雅退出有“可观测的退出”**：命名的 quit handlers 并发执行，75s 全局预算，超时 abort 并上报 pending handlers；退出后把每个 handler 的耗时、是否 watchdog fired 写入 store，下次启动发 `desktop_quit_cleanup_summary`；15s（打包）/5s（开发）后强制 exit。  
   证据：`index.chunk-Z7WxBjyE.js:898341`（`nGe=75000`、`rGe` 注册表）、`:3004167`（`zkn`）、`:2988482/2988833`（记录与汇总）、`:3005682`（watchdog 事件）。

8. **[已证实] 更新/重启感知“会话是否在干活”**：`restartToUpdateWhenIdle` 监听本地 + SSH 会话，按 `turn / held_input / background_task / loop / remote_client / violin_bow / lanyard` 等活动维度计数；空闲或仅 unattended 会话时才安装；每 60s 复查；可取消。  
   证据：`index.chunk-Z7WxBjyE.js:2228665`（`JS`）、`:2228738`（`vXt`）、`:2229393`（`xXt`）、`:6287285`（IPC `restartToUpdateWhenIdle`）。

9. **[已证实] 配置/Flag 的 fail-closed 语义做得比常见产品细**：每个配置键声明 `flatKey`、`readers`、`support.enabled.scopes`（1p/3p）、`availableInVersion`、`remotePolicy`、`failClosedValue`；远程 unverified 值只有在 `applyUnverified:true`，或“等于 fail-closed 值 / asFailClosed”时才应用。  
   证据：`index.pre.js:641758`（`XU`）、`:641931`（`ZU`）、`:643579`（`hW`）、`:643664`（`gW`）；示例 schema `index.chunk-Z7WxBjyE.js:619081+`。

10. **[已证实，且与种子不一致] 种子里提到的若干“性能 mark”在本构建中不存在**：没有 `ui_render:ask/answer/applied/invalidate`，没有 `ui_press:sent`；只有 CCD 路由层的 `BENCH ui_render ... M0/M1/M2`，且其 key 生成函数返回 `null`，因此实际不输出。  
    证据：`index.chunk-BIbv25VD.js:9145`（`J`）、`:13937`（`Me=e=>null`）、`:14235`（M0/M1/M2）；全仓 `rg --hidden --no-ignore` 无匹配。

---

## 2. 架构与数据流

```text
┌────────────────────────────── Renderer / Web (ion-dist) ──────────────────────────────┐
│ performance.mark: claude:composer_input_ready / claude:sidebar_painted / surface_ready_*│
│ performance.measure: render/input/inputlatency、code-transcript:fold、chat_host_swap    │
│ console.warn/error ───────────────┐                                                    │
│ 本地 feature exposure             │ contextBridge IPC                                  │
└───────────────────────────────────┼────────────────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────── Electron main ────────────────────────────────────────┐
│ winston                                                           event queue         │
│  ├─ main.log (10MB x5, 0600) ◄── early buffer ◄── logger calls     50 条 / 30-90s     │
│  ├─ <window>.log (5MB x5, warn+) ◄── webContents console-message     │                 │
│  ├─ mcp.log / mcp-server-*.log                                     ▼                 │
│  └─ cowork_vm_*.log / service logs                     /api/event_logging/v2/batch    │
│                                                              (nonessential gate)      │
│ Sentry (@sentry/electron)                                                              │
│  ├─ beforeSend/beforeBreadcrumb scrub                                                  │
│  ├─ egress gate: open / held / blocked + offline queue purge                           │
│  └─ crashpad minidumps (uploadToServer=false, 由 Sentry 集成读取)                       │
│                                                                                        │
│ GrowthBook ── GET /api/desktop/features ── gzip fcache (magic+TTL 24h)                  │
│                                      │                                                 │
│ stall sampler worker ◄── SharedArrayBuffer heartbeat ── main loop (200ms 轮询)          │
│   └─ inspector CPU profile ──► desktop_main_event_loop_stall                           │
│                                                                                        │
│ memory sampler (randomized interval) ──► desktop_process_memory_high_water            │
│ quit cleanup registry ──► persist summary ──► next launch telemetry                    │
│ SupportBundle section registry ──► zip + manifest ──► export / consented event         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 遥测事件信封

`Q(event, props, opts)`（`index.chunk-Z7WxBjyE.js:2984104`）统一入队。`BDn`（`:2985429`）构造：

```text
TelemetryEvent
  event_data.event_name
  event_data.timestamp
  event_data.user_properties.user_id
  event_data.auth.{organization_uuid, account_uuid}
  event_data.metadata = JSON(大量上下文)
```

metadata 包括：`product_surface=claude-desktop`、`desktop_variant=production`、`deployment_mode`、`config_source`、推理 provider/host/host_kind、app/commit、platform/arch、installer variant、OS build、Linux distro/session/DE、CPU、内存、device class、`install_id`、`app_session_id`、uptime、窗口数、组织 ID、进程/渲染器内存、GC 等。  
证据：`index.chunk-Z7WxBjyE.js:2985429+`。

批处理：`nDn=50`，flush 间隔 60s ±50%（30-90s），`setTelemetryFlushIntervalMs` 可调但 clamp 到 1-10min；CI 环境只打印“withholding N events”不上传；退出时注册 `flushEventQueue`。  
证据：`index.chunk-Z7WxBjyE.js:2978641`、`:2979261`、`:2979887`。

---

## 3. 各子系统细节

### 3.1 日志架构

#### 3.1.1 级别与出口

| 项 | 事实 | 证据 |
|---|---|---|
| 库 | winston 3.19.0 | `index.pre.js:713042+` 的 package 元数据 |
| 级别 | npm levels：error/warn/info/http/verbose/debug/silly | `index.pre.js:713042+` |
| 默认级别 | 打包版 `info`；开发版 `debug`；`DESKTOP_LOG_LEVEL` 覆盖 | `index.pre.js:803732`（`oZ`） |
| Console 出口 | 仅 `CLAUDE_ENABLE_LOGGING` 或未打包；支持 `DEBUG` 过滤 | `index.pre.js:803800`（`sZ`）、`:804658` |
| 文件出口 | 始终在打包版启用（除非 logs 目录不可用） | `index.pre.js:805973`（`yZ`） |
| 早期日志 | `uZ` buffer transport 暂存，文件 sink 就绪后回放 | `index.pre.js:804152`、`:806080` |
| 目录 | `app.getPath("logs")`；`CLAUDE_USER_DATA_DIR` 存在时改为 `<dir>/Logs` | `index.pre.js:805973`、`:906200` 附近 |
| 文件权限 | `mode: 0o600`，append | `index.pre.js:800276`（`wX`） |

#### 3.1.2 轮转与各子系统日志

| 日志 | 级别/大小 | 说明 | 证据 |
|---|---|---|---|
| `main.log` | 10MB × 5（`main.log`、`main1..main4.log`） | 主进程 | `index.pre.js:804516`（`gZ`，`maxsize:10485760,maxFiles:5`）；`index.chunk-BCbYBjsb.js:2736-2783` |
| `<window>.log` | 5MB × 5，warn+ | 每个 WebContents：`claude.ai-web`、`find-in-page`、`about`、`main-window`、`quick-entry-window`、`custom3p-setup`、`custom3p-device-code`、`in-app-browser` | `index.chunk-Z7WxBjyE.js:286619-290455`（`xme/Sme/Hme/Ume`）；枚举 `:290107` |
| `mcp.log` | winston，level info | MCP 总日志 | `index.chunk-Z7WxBjyE.js:4413381` |
| `mcp-server-<name>.log` | 每 server 一个，含 raw stdout/stderr | 另含 `<name> [level] message {metadata}` 格式 | 同上 `:4414200+` |
| `cowork_vm_node.log` | 打包 info，开发 debug；`maxFiles:2` | VM 节点 | `index.chunk-Z7WxBjyE.js:2945088` |
| `system-info.txt` / `gpu-info.json` / `mcp-info.json` / `supported-features-info.json` | 诊断快照 | 生成在 logs 目录，供 bundle 收集 | `index.chunk-Z7WxBjyE.js:5098000+` |
| `debug.jsonl` | 每 artifact 1MB，超出保留后半 | Cowork artifact 调试日志；字段截断（args 200、result 2000 等） | `index.chunk-Z7WxBjyE.js:5794453` |
| `cli-diagnostics.jsonl` / `cli-diagnostics1.jsonl` | 过滤后最多约 1MB+ | Claude Code API/stream/byte_watchdog/malformed_fallback 事件 | `index.chunk-Z7WxBjyE.js:5019929-5022533` |

`<window>.log` 只捕获 main frame 的 `warning/error` console message，并过滤两类已知噪声：`Error with Permissions-Policy header`、`loop completed with undelivered notifications`；`in-app-browser` 额外把换行替换为 `⏎`、截断 4096 字符、去掉 URL query/fragment。  
证据：`index.chunk-Z7WxBjyE.js:290455+`。

#### 3.1.3 脱敏

- **默认模式**：`hZ.transform` 只有在 `fX()`（`__complianceSinkRestricted === true`）时才调用 `mZ` -> `NX()` 的 scrubber；否则日志原样写入。spawn 参数始终被 `lZ` 折叠为 `[N arg(s) redacted]`。  
  证据：`index.pre.js:798329`（`fX`）、`:800578`（`NX`）、`:804466`（`hZ`）、`:804658`（logger）、`:803900` 附近（`lZ`）。
- **合规/HIPAA 模式**：`dX()` 设置 restricted，`MX((e)=>X3(e))` 安装 `__complianceLogLineScrub`；scrub 覆盖路径、home、用户名、SSH host 名、ANSI/控制字符、非打印字符；失败则整行 withheld。  
  证据：`index.pre.js:876845`（`MX`）、`:875300-878900`（`X3`/`H3`/`J3`/`g6`）。
- **MCP raw 进程日志**：合规模式下 `createProcessStream()` 指向 `/dev/null`；启动后 `discardRawMcpProcessLogs()` 删除 latch 之前写下的 `mcp-server-*.log`。  
  证据：`index.chunk-Z7WxBjyE.js:4414600+`（`createProcessStream`）、`:4414400` 附近（`discardRawMcpProcessLogs`）。
- **日志目录损坏**：不是目录时重命名为 `<path>.corrupt-<ts>` 后重建，并禁用文件日志而不是崩溃。  
  证据：`index.pre.js:805412`（`_Z`）。

#### 3.1.4 用户可见入口

- `MCP_$_revealLogs` 打开 logs 目录；`MCP_$_revealServerLog` 打开单个 server 日志（有路径/symlink guard）。  
  证据：`ipc_services.json` 的 `MCP`；`index.chunk-Z7WxBjyE.js:6709314`。
- `DesktopInfo_$_showLogsInFileManager` 实际调用 `dji()`：生成脱敏 zip 到 Downloads 并 reveal。  
  证据：`index.chunk-Z7WxBjyE.js:5096458`（`dji`）、`:6709314`。
- `SupportBundle` / `AutoUpdater` 通过 store 向渲染器暴露状态。  
  证据：`ipc_services.json`；`mainView.js:18219+`。

---

### 3.2 Sentry 与崩溃观测

#### 3.2.1 初始化与发布标识

- `@sentry/electron` `^7.12.0`；Sentry 仅在非 CI 且 `telemetry.disableEssential !== true` 时初始化。  
  证据：`app/package.json`；`index.pre.js:907748`（`j1(...,disableEssential)`）、`:826819`（`j1`）。
- DSN：`https://2f98127cbffe4740b1f767a2de77d23b@o1158394.ingest.us.sentry.io/4507368973008896`。  
  证据：`index.pre.js:910011`。
- Release：`SENTRY_RELEASE={id:"e7f60e..."}`（由 `@sentry/vite-plugin` 注入，不是运行时读取环境变量）。每个 chunk 注入 `_sentryDebugIds` / `_sentryDebugIdIdentifier`。  
  证据：`index.pre.js:144`、`:376`；所有 `index.chunk-*.js` 头部同样存在。
- `initialScope`：`user.id = Q6()`，`tags.deployment_mode = "3p" | "1p"`；`sendDefaultPii: false`。  
  证据：`index.pre.js:910300` 附近。
- 主进程 init 未设置 `tracesSampleRate`；存在 `beforeSendTransaction` 钩子，但默认不开启事务采样。  
  证据：`index.pre.js:910011+`（init options）；`tracesSampleRate` 仅出现在 SDK 内部实现（`:142133+`）。

#### 3.2.2 采集内容

- JS 异常/消息、renderer/main 错误；`beforeSend` 里做：
  - 路径/凭据/环境错误重分类；
  - fs error fingerprint 归一化；
  - custom3p credential 事件降级并打 `feature=custom3p_credential`、`credential_kind`、`credential_reason`；
  - `sdk-dead-transport` 单独 fingerprint；
  - 每次捕获写本地 `Sentry caught: {type,value,stack}` 日志。
  证据：`index.pre.js:910410+`。
- 原生崩溃：`crashReporter.start({ignoreSystemCrashHandler:true, uploadToServer:false, submitURL:"https://f.a.k/e", compress:true})`；`SentryMinidump` 集成从 `crashDumps/{reports|completed}` 读取 `.dmp`，忽略 30 天前文件、等待文件 1s 不再修改、解析 Crashpad annotations、作为 `event.minidump` 附件发送后删除；每 session 最多 10 个。  
  证据：`index.pre.js:317377`、`:318722+`、`:315267+`。
- `render-process-gone` / `child-process-gone` 且 reason 在列表内时，作为 `level:fatal, platform:native` 事件上报，并带 `event.process`、`exit.reason`。  
  证据：`index.pre.js:318722+`。
- 主进程原生/browser crash 会额外发 `desktop_main_process_crash_reported`，`crashed_app_version` 用 Sentry release 解析并 shape-gate。  
  证据：`index.chunk-Z7WxBjyE.js:6358040`。

#### 3.2.3 PII 脱敏与“失败关闭”

- `sendDefaultPii:false`。
- `i5()` 对 message/exception/extra/tags/contexts/breadcrumbs 做路径替换（`<home>|<user>|<vol>|<unc>|<drv>` -> `<path>`），单串 64KB 上限；`S6()` 对 transaction 做同样处理。  
  证据：`index.pre.js:892812`（`i5`）、`:880300` 附近（`S6`）。
- `C5()` 对 console breadcrumb 做参数脱敏；第三方模式下用 `<withheld: ...>` 替代消息。  
  证据：`index.pre.js:895756`。
- `k8()` 是“hook 失败即丢弃”的包装器：`beforeSend` / `beforeSendTransaction` 抛错时，该事件不发送，只记录一次。  
  证据：`index.pre.js:888402`。
- `E6()` 丢弃没有 `DumpWithoutCrashing-file` 的 native 事件（除非 `__sentryDwocDropDisabled`）。  
  证据：`index.pre.js:880624`。
- `_5()` 去重：消息归一化（路径、hex、数字），缓存 200 条，每小时最多放行 6 次，重复时加 `repeat_guard:"heartbeat"` 和 `repeat_suppressed_count`。  
  证据：`index.pre.js:895091`、`:893400`（`o5=6,s5=3600000,c5=200`）。

#### 3.2.4 出站闸门（egress gate）

状态机：`open / held / blocked`，存放在 `globalThis`：

- 第三方部署：`open`。
- 合规受限启动：`blocked`。
- 其他情况：`held`，只允许继承时间点之后的事件或显式的 allow event id。
- `shouldStore=false` 当 blocked 或存在 purge debt。
- 离线队列：`userData/sentry/queue`；blocked 时 purge；`queue-purge-owed` 标记跨启动保留。
- Crashpad：受限组织策略下清理 crash dumps；若检测到受限 session 的 marker 出现，运行时阻断 Sentry 出站。
- `transport.send` 被包装，`QS()` 为 true 时直接 `Promise.resolve({})`。
证据：`index.pre.js:330905`（`zS`）、`:331911`（`XS`）、`:332225`（`ZS`）、`:332385`（`QS`）、`:906500-908500`（init/queue/crashpad）。

#### 3.2.5 essential vs non-essential

| 平面 | 开关 | 语义 | 证据 |
|---|---|---|---|
| Sentry | `disableEssentialTelemetry` | 关闭崩溃/错误报告 | `index.pre.js:574681`、`:907748` |
| Datadog RUM | `disableEssentialTelemetry` | `/api/v2/rum` | `index.chunk-Z7WxBjyE.js:821500+` 端点表 |
| Anthropic event logging | `disableNonessentialTelemetry` | `/api/event_logging/` 使用分析 | `index.pre.js:575318`；`index.chunk-Z7WxBjyE.js:2987389` |
| 非必要网络服务 | `disableNonessentialServices` | favicon、artifact iframe、MCP app iframe、Linux 拼写词典 | `index.chunk-Z7WxBjyE.js:821500+` |

两个 telemetry 开关都声明：`support.enabled.scopes:["3p"]`、`availableInVersion:"1.2581.0"`、`remotePolicy:{default:true,applyUnverified:true}`、`failClosedValue:true`、`default:false`。含义：字段默认 false（开启）；远程缺失键默认 true（禁用）；解析失败时用 `failClosedValue=true`（禁用）；`applyUnverified:true` 表示“格式正确但未验证”的远程值仍会应用；只影响 3p。  
证据：`index.pre.js:574681/575318`。

---

### 3.3 性能观测

#### 3.3.1 启动检查点

`V9` 是 `Map<string, ms>`，`O0a` 只在首次写入（避免重复覆盖）。最终 `F0a` 汇总为 `desktop_app_startup_perf`。  
证据：`index.chunk-Z7WxBjyE.js:6716028`、`:6718738`、`:6720401`。

| 检查点 | 含义 |
|---|---|
| `__claudeMainJsStartMs` | main JS 开始执行 |
| `__claudeMainPreImportsLoadedMs` | pre bundle import 完成 |
| `__claudeMainPreNativeAddonLoadedMs` | 原生 addon 加载 |
| `__claudeMainPreManagedConfigReadMs` | 管理配置读取 |
| `__claudeMainPreSentryInitStartMs` | Sentry 初始化开始 |
| `__claudeMainBundleStartMs` | 主 bundle 开始加载 |
| `main_imports_loaded` | 主 bundle import 完成 |
| `app_ready` | `app.whenReady` |
| `window_created` / `window_ready_to_show` / `window_did_finish_load` / `window_visible` | 窗口生命周期 |
| `main_view_request_seen` / `main_view_send_headers_seen` / `main_view_dom_ready` | 主视图导航 |
| `main_view_ready_to_show` / `ready_handler_done` | 首屏可显示/ready handler 完成 |
| `main_compile_cache` | V8 compile cache 状态 |
| `main_gc_*` | GC minor/major/pause/heap |
| `island_load_start/end` | Cowork island 预热 |

`p0a()` 通过 V8 heap profiler 得到 `main_gc_minor_count/major_count/pause_ms/heap_allocated_bytes/gc_window_ms`；`ohe()`/`F0a` 还合并 SPA resource timing、input ready、sidebar painted。  
证据：`index.chunk-Z7WxBjyE.js:6718000+`。

事件在 `!D0a()` 时发送；`D0a()` 为 true 时不发（内部/测试条件）。日志仍写 `[startup-perf]`。  
证据：`index.chunk-Z7WxBjyE.js:6720401`。

#### 3.3.2 Web 侧 mark/measure

- `claude:composer_input_ready`、`claude:sidebar_painted`：由 Web 侧 `performance.mark` 发出，主进程用 `PerformanceObserver({type:"mark", buffered:true})` 读取，10s 超时，允许 `surface=chat|cowork|code`，其他归为 `other`。  
  证据：`index.chunk-CJaTtjRj.js:653`、`:685`、`:5567`、`:6641`。
- 导航/资源：读取 `performance.getEntriesByType("navigation"/"resource")`，计算 DNS/connect/TLS/TTFB/DCL、脚本 fetch/queue/wait、cache vs network、transfer/encoded bytes、visibility。  
  证据：`index.chunk-CJaTtjRj.js:1000-5000`。
- Web bundle 自身还有大量 mark/measure：`static_composer_ready/swap/painted/handoff`、`new_chat_input_ready`、`composer_interactive`、`route_content_painted`、`surface_ready_*`、`stream_start/end`、`code-transcript:fold/release/refold`、`chat_host_swap`、`keydown/input/render/inputlatency`。  
  证据：`extracted/.../ion-dist/assets/v1/c0c1c41fc-UusIIGu7.js:1590314-1591080`；`shared-3-DnHYUZdJ.js:312288-312520`；`c5da7eb42-B8cTG8SI.js:261607`。

#### 3.3.3 Stall sampler（重点）

配置（`index.chunk-Z7WxBjyE.js:5238750` 附近）：

```text
stallThresholdMs: 1000
pollIntervalMs: 100
minCaptureIntervalMs: 300000      # 5 min
maxBurstCaptures: 3
maxCaptureMs: 30000               # 30 s
samplingIntervalUs: 1000
maxFrames: 8
```

机制：

1. 主进程每 200ms 执行一次检查，`QUi()` 对 `BigInt64Array` 做 `Atomics.add(heartbeat, 1)`；worker 用 `Atomics.load` 读取。
2. worker 每 100ms poll；心跳长时间不更新则判定 stall。
3. 达到 1s 阈值后，worker 通过 `inspector/promises` 的 `Profiler.start/stop` 抓采样，取 top N frames，`selfMs = hits * samplingIntervalUs / 1000`。
4. 主进程在恢复后收到 `{type:"stall_capture", resumeSeq, frames, startLagMs}`，只接受仍在等待的 `resumeSeq`，防错配。
5. 主进程区分：
   - `power_event`：检测到 suspend/resume/unlock/session/focus；
   - `duration_heuristic`：无 power event 但时长异常；
   - `update_relaunch`：更新重启 marker；
   - OS suspend 本身会先记录 `[event-loop-stall] OS suspend`，resume 后抑制误报。
6. 上报 `desktop_main_event_loop_stall`，字段包括：`stall_duration_ms`、`likely_sleep`、`sleep_signal`、`focus_state`、`any_window_visible`、`main_rss_bytes`、`recent_main_stall_*`、`gc_in_stall_*`、`sampler_frames`、`start_lag_ms`、`follows_stall_snapshot`、`accessibility_support_enabled` 等。
7. 帧名/URL 在 emit 前 clamp：函数名匹配 `FRAME_FN_PATTERN`，URL 只允许 `node:` 或 `app://`；本地 app 路径 rebase 到 `app://`，其他脚本折叠为 `(external)`。
8. worker 退出时只 `warn("[stall-sampler] worker exited unexpectedly")`，**没有自动 refork**；功能开关通过一个远程门（`XUi` -> `ob()` + `mb(...)`）控制。

证据：`stall-sampler-worker/stallSamplerWorker.js:0-2033`；`index.chunk-Z7WxBjyE.js:5238452`、`:5238825`、`:5238837`、`:5241987`、`:5244101`；frame clamp `:5242500+`。

#### 3.3.4 内存/GC 采样

- 随机化 interval + jitter；`trigger` 为 `interval` 或 `stall`；由 GrowthBook `1480778051` 控制（flag 开启时跳过采样）。
- 采 `app.getAppMetrics()` + `process.memoryUsage()` + heap limit + VM guest memory + main view heap。
- 高水位事件按 `process` / `tree_sum` / `tree_footprint` 三种 reason 分桶，桶宽 GB / RAM 百分比；持续超 100%/110% 发 `desktop_process_memory_over_ram`。
- 事件里带 top1/2/3 footprint、main view RSS/footprint、CLI 子树。
证据：`index.chunk-Z7WxBjyE.js:5235515`（`RUi`）、`:5235777`（high water）、`:5236984`（`VUi`）、`:5236100` 附近（over RAM）。

#### 3.3.5 终端 / PTY 指标

终端侧不是只打文本日志，还发结构化指标：

- `desktop_ccd_terminal_spawned`：`sessionId`、shell basename、`spawn_reason`、`carrier`（`local` / `ssh_separate` / `ssh_mux_tty` / `ssh_discrete_tty`）。
- `desktop_ccd_terminal_pty_evicted`：pool、当前 size。
- `desktop_ccd_terminal_shared_unavailable`：reason（如 `budget`）。
- `desktop_ccd_terminal_pty_closed`：pool、`close_reason`、`spawn_reason`、`shell_integration`、`command_marks`、`commands_run`、`lifetime_ms`、`cap_bytes`、`bytes_received`、`bytes_dropped`、`reads`、`reads_cap_limited`、`had_input`、`replays`、`replays_after_drop`、`scrollback_log`、`log_reads`。
- PTY 还有 9 条共享 SSH channel 的预算；超预算先淘汰 idle bash PTY，再报错。
- 终端输出 emit 做了合并缓冲：`pendingEmits` + `flushTimer`（`ot`），减少 IPC 风暴。

证据：`index.chunk-CbknQPGf.js:45495`（spawned）、`:24458`（closed）、`:45803`（evicted）、`:34367`（shared_unavailable）、`:33996`（budget）、`:24458` 附近（queuePtyEmit/flush）。

#### 3.3.6 与种子不一致的“UI render/press 性能 mark”

- `index.chunk-BIbv25VD.js` 里 `ui_render` / `ui_press` 是 CCD（Claude Code Desktop）UI 路由的 RPC subtype。
- 只有 `J("ui_render", key, "M0"/"M1"/"M2")` 和 `J("ui_press", ...)`；`J` 打印 `BENCH <name> key=<key> M0=<Date.now()>`。
- key 生成函数 `Me=e=>null`，所以 `key=null`，`J` 直接 return，**本构建不会输出 BENCH**。
- 全仓（含 hidden `.vite` 与 `extracted`）没有 `ui_render:ask`、`ui_render:answer`、`ui_render:applied`、`ui_render:invalidate`、`ui_press:sent`。
证据：`index.chunk-BIbv25VD.js:9145`、`:14100`、`:14235`、`:11497`。

---

### 3.4 可靠性原语

#### 3.4.1 PTY host：40s watchdog + 指数退避 + 惰性 refork

- `se=10s`：spawn ack 超时；超时后 warn 并继续（不直接杀）。
- `ce=40s`：有 outstanding spawn ack 且 worker 无消息时，判定 worker unresponsive，`child.kill()`，标记 `killedByWatchdog`。
- `oe=15s`：scrollback read 超时，返回 `{ok:false,error:"timed out reading the scrollback log",retryable:true}`。
- cooldown `t._U`：`forked()` 清除 proven；`proven()` 在首个真实 spawn ack 后调用；`exited(killedByWatchdog)` 返回退避 ms。未 proven 的 early death 按指数增长，base 30s、上限 10min；watchdog kill 也触发退避。
- `exit` 时：reject pending reads、清空 PTY map、对每个 PTY 发 `"Terminal backend crashed"`；有退避则 log “backing off Xms before refork”，否则“refork on demand”。
- 优雅退出：`t._4({name:"pty-host-shutdown",stopsChildProcesses:true,...})`；worker 收到 `shutdown` 或 SIGTERM/SIGINT 时 `killAllPtys()`；Windows 用 `taskkill /T /F` + 5s timeout；Unix 用 `killPtyTree` 递归 `pgrep -P`。
- stale scrollback sweep 清理旧 run dirs。
证据：`index.chunk-CbknQPGf.js:5054`、`:6388`、`:7834`、`:8234`、`:23667`、`:24458`、`:38981`、`:47166`；worker `pty-host/ptyHostWorker.js` 尾部。

#### 3.4.2 通用 utility worker 监管器

`esn` 类（`index.chunk-Z7WxBjyE.js:2632550`/`:2632972`）：

- `request()` 支持 `serialize`（互斥）、AbortSignal、`timeoutMs`、`cancelAfterMs`。
- `onTimeout: "kill" | "none"`；kill 时 reject 所有 pending，并按 cooldown 退避。
- `replyIsOnlyProof`：worker 在“有请求在飞”时退出，即使之前 proven 也退避。
- `spawn()` 前检查 bundle 是否存在；缺失时拒绝为 `worker_unavailable`，不反复重试。
- worker 首次 reply 或 ready 后 `proven()`；exit 后 `child=null`，下次请求再 `ensureWorker()`，即惰性 refork。
- `pendingTransfers` 缓存 MessagePort，worker ready 后补发。
- `release()` 在没有 pending / transfer 时 kill worker，控制常驻进程数。
- cooldown 常量：base 30s，max 10min，指数 `2^consecutiveEarlyDeaths`。
证据：`index.chunk-Z7WxBjyE.js:2629472`、`:2632550`/`:2632972`。

#### 3.4.3 外部 helper 进程

- 重启退避 `[0, 1000, 5000]`，耗尽后 60s cooldown；成功 round-trip 后 `restartAttempt=0`。
- crash loop breaker：连续 N 次“没有完成任何 round-trip”的崩溃后暂停 respawn 300s。
- 请求超时按方法预算；队列 drain deadline 用 `min(max(prev, now)+budget, now+sumBudgets)`，防止队列无限堆积。
- 连续超时达到阈值时 `SIGKILL` hung helper。
- `stopCooperatively`：关闭 stdin，默认 700ms 后 SIGKILL。
- `ENOENT` -> `permanentlyUnavailable`，不再重试。
- 崩溃事件带 `exit_code/signal/uptime_ms/last_method/restart_count`。
证据：`index.chunk-Z7WxBjyE.js:4017688`（`BPr=[0,1000,5000]`、`VPr=60000`、`HPr=300000`）、`:4018000+`。

#### 3.4.4 主视图恢复与重试

- load 失败：退避 `[0, 15s, 30s]` ±20% jitter；总重试窗口 180s；HTTP error 会额外推进一步退避；连续 HTTP error 超过 3 次后停止自动重试。
- 重试前重置网络状态：`closeAllConnections`、`clearHostResolverCache`、`forceReloadProxyConfig`。
- 离线：每 1s 轮询，窗口结束后等待用户手动重试；手动重试有 10s 冷却，可把重试窗口延长 60s。
- 重试耗尽发 `desktop_main_view_load_retry_exhausted`；恢复发 `desktop_main_view_load_recovered`。
- redirect 到非预期 host：发 `desktop_main_view_redirect_blocked`，给出 IT 提示，并 `about:blank`。
- unresponsive：若正在 `print()` 且有 guard，跳过 kill 并只记一次 `desktop_main_view_unresponsive_kill_skipped`；否则 `forcefullyCrashRenderer()` + reload。print guard 上限 10min。
- renderer gone：killed 延迟 300ms；reload cap 3 次 / 5min；launch-failed 退避 `[1s, 5s, 20s]`；发 `desktop_main_view_render_process_gone`。
证据：`index.chunk-Z7WxBjyE.js:3177503`（`$Wn=18e4`、`eGn=[0,15e3,3e4]`）、`:3179591`（`fL`）、`:3177974`（`cL`）、`:3182058`（`kGn`）、`:3182410`（`jGn`）、`:3184284-3185200`（unresponsive/gone）。

#### 3.4.5 优雅退出

- 命名 handler 注册：`Ld({name, fn, stopsChildProcesses, beforeInstall})`。
- 并发执行，`AbortController` 在 75s 后 abort；记录每个 handler 的开始/耗时/是否 pending。
- 结束后 `JDn` 持久化 `lastQuitCleanup`：completed、cleanup_ms、handler_count、slowest_handler/ms、timed_out、pending_handlers、watchdog_fired、for_update、quit_app_version、quit_epoch_ms。
- `Ia.quiesce()` 等 store 写入落盘，5s 超时。
- 15s（打包）/5s（开发）后 quit watchdog 强制 `app.exit(0)`，先发 `desktop_quit_watchdog_fired`。
- 下次启动读取上一条记录并发 `desktop_quit_cleanup_summary`；格式不合法则忽略并 warn。
- `before-quit` / `will-quit` 都走同一守卫；`before-quit-for-update` 设置 for_update。
证据：`index.chunk-Z7WxBjyE.js:898341`、`:3004167`、`:2988482`、`:2988833`、`:2989310`、`:3005682`、`:2989549`、`:3005933`。

#### 3.4.6 孤儿/子进程清理

- PTY：quit handler `local-session-pty-cleanup`；`killAllPtysForQuit`；`killPtyTree`；Windows `taskkill /T /F`。
- SSH：共享 shell 的 channel 预算为 9；超预算时先淘汰空闲 bash PTY，再报 `desktop_ccd_terminal_shared_unavailable`。
- 更新/退出前可 park remote sessions（`confirmQuitParksRemoteSessions`）。
证据：`index.chunk-CbknQPGf.js:23667/47166/33996`；`index.chunk-Z7WxBjyE.js:2228665+`。

---

### 3.5 Feature Flags 与配置系统

#### 3.5.1 GrowthBook

- 端点：`/api/desktop/features`（`index.chunk-Z7WxBjyE.js:1996908`）。
- 磁盘缓存：`userData/fcache`，magic `CLF\x02\x00\x9a\xb7\xe2` + gzip JSON `{timestamp, mode, orgUuid, features}`；TTL 24h；mode 不匹配或 org 不匹配则丢弃。  
  证据：`:1997004`、`:1997311`、`:1997538`。
- 分层优先级：`network(3) > disk(2) > map-final(1) / map-fallback(1) > none(0)`；`ab()` 认为 `none` 和 `map-fallback` 都“未加载完成”，即 fail-closed。  
  证据：`:2001467`、`:2001583`。
- 刷新：正常 1h，网络错误 5min；启动 fetch 30s 超时；账号切换时清缓存并刷新；in-flight fetch 去重。  
  证据：`:1997000` 常量、`:2001642`、`:2002566`、`:2002748`。
- 未认证响应 `user==null` -> `anon-refused`；此时用磁盘缓存，没有缓存再用 hardcoded map，并标记为 fallback。  
  证据：`:1998599+`、`:2001642`。
- `isFeatureEnabled(name)` 默认 `false`（`t?.on ?? false`）；`getFeatureValue(name, default)`；本地开发 `CLAUDE_DEV_FORCE_GATES` 只允许 hashed id，且只在 `!app.isPackaged` 生效。  
  证据：`:2005132`、`:2005763`、`:2005201`。
- 曝光：`desktop_feature_exposure` 只发 `feature_hash`（DJB2）、`on`、`source`、`in_experiment`；实验曝光 `GrowthbookExperimentEvent` 带 device/anonymous id、experiment key、variation id。  
  证据：`:2004289`、`:2004387`。

#### 3.5.2 配置 schema / 远程策略

示例键声明：

```text
flatKey: "disableEssentialTelemetry"
readers: ["desktop","code"]
support.enabled.scopes: ["3p"]
support.enabled.availableInVersion: "1.2581.0"
remotePolicy: { default: true, applyUnverified: true }
failClosedValue: true
default: false
category: "telemetry"
```

证据：`index.pre.js:574681`。

应用规则：

- `XU()`：可远程应用的键 = 3p scope 且非 `remote-disabled`，且非 `requiresUserConsent`，且 `applyUnverified:true` 或 `failClosedValue` 是原始值。
- `ZU()`：`applyUnverified:true` 直接接受；`"asFailClosed"` 只接受等于 fail-closed 的值或映射为 fail-closed；`false` 拒绝。
- `hW()`：任何解析失败都写入 `failClosedValue`。
- `gW()`：managed config 逐键解析；布尔接受 `"true"/"1"/"false"/"0"`；数组若所有条目都不可读则 fail-closed；`channel !== "hybrid"` 时还会走 predicate/redaction 检查。
- `cW()`：缺失键应用 `remotePolicy.default`。
- `YU()`：platform variant 映射。
证据：`index.pre.js:641758`、`:641931`、`:643579`、`:643664`。

---

### 3.6 Support Bundle 与日志交接

#### 3.6.1 组成

`uOi()`（`index.chunk-Z7WxBjyE.js:5046449`）并行采集：

- 主日志过滤行（最近 error/warn/custom-3p/updater/hybrid，最多 200 行；不足 200 时拼上 `main1.log`）。
- crash dumps 列表（最多 5 个）。
- 插件扫描（5s 超时）。
- 网络可达性（15s AbortController；host 用 line scrub 处理）。
- session host 自述（3p）。
- 然后按 section 表收集。

Section 表（`index.chunk-Z7WxBjyE.js:5039200-5047800`）：

- metadata：`system-info`、`deployment-mode`、`os-build`、`managed-config`、`mcp-servers`、`configured-marketplaces`、`sharing-endpoint`、`history-import`、`provider-status`、`model-selection`、`reachability`、`auto-update`、`session-host`。
- logs：`main-log`、`main-log-other-profile`、`claude-ai-web-log`、`mcp-log`、`mcp-server-logs`、`custom3p-setup-log`、`cowork-vm-log`、`cowork-vm-service-log`、`cowork-vm-guest-log`、`cowork-edr-integration`、`cli-diagnostics-log`。
- crash：`builtin-mcp-incidents`、`dmp-names`。

每步最少 300ms（`minStepMs`），logs section 统计 `[error]` / `[warn]` 数量用于 `logErrorCount/logWarnCount`。

#### 3.6.2 输出与同意

- zip + `manifest.json`：`bundleId`、org uuid、install id、app version、platform/arch、createdAt、sections、可选 sessionHost manifest。
- 文件名 `claude-diagnostic-<bundleId8>-<timestamp>.zip`。
- 状态机：`Closed -> Packaging -> Ready -> Exporting -> Saved / Sending -> Sent`。
- `canSend = !telemetry.disableNonessential`；`showSendUi` 由部署模式决定。
- Export 走 `showSaveDialog`；Send 走 `lh(vOi(result), 15000)`，超时 15s。
- 发送事件 `cowork_3p_diagnostic_bundle` 包含 manifest、provider、config snapshot、reachability，以及（仅当 `eventCarriesLogLines`）`scrubbed_*_log` 字段。
- 日志行发送前会 `$f` 再次处理；metadata section 用较轻的 `V1e`，logs 用较重的 `H1e`。
证据：`index.chunk-Z7WxBjyE.js:5048952`、`:5051557`；IPC `mainView.js:18219+`。

#### 3.6.3 脱敏与安全检查

- zip 内逐文件 `Wce`：
  - 二进制扩展（pdf/png/jpg/zip/docx/xlsx 等）原样通过；
  - `.jsonl` 逐行 parse + JSON scrub；
  - `.json` parse + scrub，失败回退 line scrub；
  - 文本逐行 scrub，失败则整行 `[line withheld: scrub failed]`；
  - email -> `<email>`，IP -> `<ip>`。
- 读取日志前 `fNr(e)` 拒绝 symlink/非常规文件；reveal 时 `yOi` / `bOi` 再次 `lstat` 并拒绝 symlink。
- `noteSavedSshNames()`：若存在保存的 SSH host 名，普通 SupportBundle 的**发送事件**会把 `eventCarriesLogLines=false`，不再附带 log lines；但 **zip 导出**仍可能包含日志。`createLogsZipBuffer` 才会直接拒绝打包。
- `createLogsHandoffBundle`（Slack 交接）：先过 HIPAA gate `JV("logs_slack_handoff")`；只接受 `anthropic.slack.com` / `anthropic.enterprise.slack.com` 的 `^/archives/[A-Z0-9]+/p\d+$`；zip 保存到 Downloads、复制说明到剪贴板、打开 Slack thread；zip 不含 conversation transcript，但含 session id、文件路径、URL 等元数据；secrets/emails 被 redact。
- `createErrorFeedbackBundle`：额外把该 session 的 transcript files 加入 zip；这是与 logs handoff 不同的隐私边界。
证据：`index.chunk-Z7WxBjyE.js:125389`（`Wce`）、`:5094340`（`oji/sji/cji`）、`:5115609`（`Iji`）、`:5112978`（`Mji`）、`:5096458`（`dji`）。

---

### 3.7 自动更新

#### 3.7.1 通道与平台

- 通道：`stable`、`latest`、`staggered`；`i6r()` 只把配置的 `staggered` 当 staggered；`latest` 由 `ancientJournal` 开关 + GrowthBook `3424654946` 决定；否则 stable。  
  证据：`index.chunk-Z7WxBjyE.js:4397261`。
- `releaseChannel` 配置只接受 `stable|staggered`；`latest` 是单独的 “ancientJournal” 机制。  
  证据：`index.chunk-Z7WxBjyE.js:688217+`（schema）、`:4396812`。
- **Linux**：`K3r()` 明确 `[updater] Linux: in-app updater off (updates via apt)`，发 `desktop_update_disabled{reason:"managed_by_package_manager"}`；但仍每约 30s 首查、之后 1h 轮询 `https://<host>/claude-desktop/apt/stable/dists/stable/main/binary-<arch>/Packages`，用 semver 判断可用版本。  
  证据：`index.chunk-Z7WxBjyE.js:4396428`、`:4396534`、`:4397500+`。
- 若 `/proc/self/exe` 指向 ` (deleted)` 且新 exe 可访问 -> 状态 `replaced`，提示重启。  
  证据：`index.chunk-Z7WxBjyE.js:4397600+`。

#### 3.7.2 状态机与后台下载

状态：`idle / checking / downloading / ready / replaced / error / available`。  
证据：`index.chunk-Z7WxBjyE.js:4391403`（`kJ`）。

- `checking-for-update` -> 发 `desktop_update_check_started`。
- `update-available` -> 记下载开始时间，状态 `downloading`，发 `desktop_update_available`。
- `update-downloaded` -> 状态 `ready`，发 `desktop_update_downloaded`（含 `duration_ms`、`feed_arch`、`payload_arch`、`payload_kind`：`zip/delta/delta_fell_back`）。
- 无窗口且 Claude 正在工作时：不安装；`xXt(YS, ..., {unattendedOnly:true})` 等空闲后再装。
- 手动检查：`setManualCheck()` 会把 stagedAt 置 0，使 “Restart to Update” 立即显示；否则按 GrowthBook `2938421209` × 1h 延迟显示。
- 检查触发：`focus` / `unlock` / `resume`，以及 1h 定时；初始 30s。
- `dangerousMaxVersion`：semver 上限，超过则 `capped`，不更新。
证据：`index.chunk-Z7WxBjyE.js:4391403-4395000`。

#### 3.7.3 空闲感知与会话守卫

- `getRunningLocalSessionCount/Sessions` 暴露给渲染器。
- `restartToUpdateWhenIdle`：若 state `ready/replaced`，注册 session event listener + 60s recheck；所有本地/SSH 会话空闲后执行 quit+install；`unattendedOnly` 只等待 unattended 会话。
- `cancelPendingRestart` 清除 timer/listener。
- 会话活动维度：`turn / held_input / background_task / loop / remote_client / violin_bow / lanyard`。
- quit guard：若有运行中会话，弹确认框；可按会话类型 park remote sessions；可 veto quit。
证据：`index.chunk-Z7WxBjyE.js:2228665/2228738/2229393`、`:6287285`、`:1912670`。

#### 3.7.4 失败与回退

- `updaterFailedInstall` 持久化 `{appVersion,targetVersion,attempts}`；同一 target 失败 >=2 次 -> repeated failure。
- 读取 `~/Library/Caches/com.anthropic.claudefordesktop.ShipIt/ShipIt_stderr.log` 最后 16KB（只读、no-follow、no-block），用于诊断。
- 事件：`desktop_update_error`、`desktop_update_install_failed`、`desktop_update_replacement_failed`、`desktop_update_applied`（含 `is_downgrade`、`payload_kind`、`payload_arch`）。
- **未发现显式 rollback 到上一版本**；只有 target 上限、失败计数、替换检测、quit/relaunch。  
  证据：`index.chunk-Z7WxBjyE.js:4387807`、`:4388687`、`:4366535`、`:4390742`、`:4394023`。

#### 3.7.5 ancientJournal 的真实状态

- `Z3r()` 硬编码 `return !1`；`$3r()` 硬编码 `return !1`；`Q3r()`、`AJ()`、`e6r()` 因此全部为 false。
- `n6r()` 永远返回 `{available:false, value:"stable"}`。
- IPC/菜单/AboutWindow 仍然暴露 `ancientJournal`，但本构建不可用。
证据：`index.chunk-Z7WxBjyE.js:4396812-4397142`；`ipc_services.json` 的 `AboutWindow`。

---

### 3.8 健康/状态界面

- 主视图错误 overlay：`setErrorOverlay` / `currentErrorOverlay` / `showLoadError` / `hideLoadError`；错误时显示重试/刷新，刷新前重置网络。  
  证据：`index.chunk-Z7WxBjyE.js:3179000+`；`ipc_services.json` 的 `MainWindowTitleBar`。
- 主视图加载错误卡片：`load_failed` / `http_error` / `redirect_blocked` 等 kind，带 retrying 状态。
- MCP：`mcpStatusChanged` 事件；per-server `error()` 同时写本地日志、主 MCP 日志、并弹 toast（`showToast!==false`）。  
  证据：`index.chunk-Z7WxBjyE.js:4414200+`；`ipc_services.json`。
- 更新：`AutoUpdater` store `updaterState`；SupportBundle state store；AppFeatures/AppPreferences store。
- 日志入口：MCP revealLogs/revealServerLog；DesktopInfo.showLogsInFileManager；AboutWindow getSupport/openHelp。
- 所有 IPC 操作统计：1491 个 operation、1480 个动态 channel operation、27 个 main handler、63 个 sender validation 观察；utility process 4 个。  
  证据：`asset/rea_summary.json`。

---

## 4. 亮点评级

| 设计 | 评级 | 理由 |
|---|---|---|
| essential/non-essential 遥测拆分 + fail-closed | **must-borrow** | 合规与产品分析的边界清晰；默认安全；可直接复用到任何桌面 Agent |
| Stall sampler + sleep/power 判别 | **must-borrow** | 比普通 “long task” 观测强一个量级；能解释“为什么卡” |
| 启动检查点（pre/main/renderer） | **must-borrow** | 成本低、收益高；能定位到具体阶段 |
| utility worker 监管器 | **must-borrow** | 请求互斥/超时/退避/refork/端口转移是通用 infra |
| SupportBundle section registry | **must-borrow** | 诊断包从“日志压缩”升级为“可配置证据包” |
| 优雅退出 + 退出摘要 | **must-borrow** | 把“退出慢/退出丢数据”变成可观测问题 |
| Sentry egress gate + 去重 + hook fail-closed | **nice** | 对受监管/3p 场景很强，普通产品可简化 |
| GrowthBook 磁盘缓存 + fallback 分层 | **nice** | 离线/未认证可用；注意 `map-fallback` 仍被视为未加载 |
| 配置键级 fail-closed / scope/version 门控 | **nice** | 适合多部署形态，但 schema 复杂度高 |
| 内存高水位 + GC 关联 | **nice** | 对 Electron 很有用；采样成本需评估 |
| PTY/终端指标 | **context-specific** | 适合有本地终端的产品 |
| 更新空闲重启 + 会话感知 | **nice** | 桌面 Agent 很需要；实现依赖会话模型 |
| HIPAA/1p-3p 双轨脱敏 | **context-specific** | 只有受监管/混合部署才需要 |
| ancientJournal | **不要照抄** | 本构建死代码 |
| BENCH M0/M1/M2 | **不要照抄** | 本构建被 `Me=e=>null` 关闭 |

---

## 5. AutoAgent 借鉴清单

### P0（先做，直接决定可运维性）

1. **统一 `logEvent` 信封 + 队列 + 双闸门**
   - `event_name/timestamp/user_id/metadata` 固定结构；metadata 含 app/commit/platform/arch/session/install id。
   - 50 条或 30-90s jitter flush；退出时 flush；CI 不上传。
   - `essential`（崩溃）与 `nonessential`（使用分析）分离；默认关闭不可验证的远程开关。
   - 验收：关闭 nonessential 后没有任何 `/event_logging` 请求；关闭 essential 后 Sentry 不初始化。

2. **启动检查点**
   - `process.uptime()*1000` 的 `Map`，首次写入；pre-import、native addon、config、bundle、app ready、window visible、renderer mark 全链路。
   - 渲染器用 `performance.mark("agent:input_ready")` / `"agent:first_paint"`，主进程 `PerformanceObserver` buffered 读取，10s 超时。
   - 验收：一条 `agent_startup_perf` 能回答“慢在 pre、bundle、窗口还是首屏”。

3. **worker 监管器模板**
   - 互斥/超时/取消/超时 kill/首个 reply 才 proven/early death 指数退避（30s→10min）/惰性 refork/端口缓冲。
   - 验收：worker 在初始化前崩溃 5 次，仍能恢复；不会形成 fork 风暴。

4. **优雅退出**
   - 命名 handler；75s 预算；超时 abort 并记录 pending；退出摘要写 store，下次启动上报；15s watchdog 强制 exit。
   - 验收：退出慢时能看到具体 handler 和耗时。

5. **Support Bundle MVP**
   - 先做 6 个 section：system-info、config（redacted）、agent/CLI diagnostics、main log tail、crash list、reachability。
   - 导出走 save dialog；发送必须显式同意；所有文本 section 走统一 scrub。
   - 验收：zip 可复现、manifest 可定位、symlink 被拒绝。

### P1（第二个迭代）

6. **Sentry/等价崩溃上报**
   - release = commit；每个 bundle 注入 debug id；`sendDefaultPii=false`；`beforeSend` 路径/凭据脱敏；hook 失败即丢；重复消息去重。
   - 原生崩溃用 minidump，限制每 session 数量并清理旧 dump。

7. **日志分级与轮转**
   - main 10MB×5、0600；每个子系统独立文件；早期 buffer；warn+ 的窗口日志；MCP per-server 日志。
   - 默认模式明确“不脱敏”，合规模式再启用 line scrub；不要假装默认安全。

8. **Feature flag 基础设施**
   - 本地磁盘缓存 + magic/TTL + 账号/模式校验；network > disk > fallback；未认证无缓存时 fail-closed；`isFeatureEnabled` 默认 false。
   - 每个 flag 有默认值、fail-closed 值、scope、最低版本、是否允许远程未验证。
   - 曝光事件只发 hash，不发原始 key。

9. **空闲重启/更新**
   - 统计“运行中 agent/终端/后台任务”；空闲才重启；每 60s 复查；可取消。
   - 失败安装记录 + 目标版本上限 + 下次启动 `from/to version` 对比。

10. **简化版 stall 观测**
    - 先做 heartbeat worker + 1s 阈值 + 事件循环滞后 + 最近任务标签；不一定要 CPU profile。
    - 区分 suspend/resume，避免把睡眠当卡顿。
    - 验收：能定位到“卡在哪个 task”，并排除 OS 睡眠。

### P2（按产品需要）

11. **内存高水位 + GC 关联**：进程树 footprint、top offenders、stall 期间 GC。
12. **终端/子进程指标**：spawn reason、carrier、lifetime、bytes/dropped、eviction、close reason。
13. **Per-artifact `debug.jsonl`**：字段截断、1MB 截断保留后半、队列上限。
14. **UI 状态 store**：updater/support bundle/feature flags 通过 typed IPC store 暴露给渲染器。

---

## 6. 风险与反模式（不要无脑照抄）

- **[已证实] 默认日志不脱敏**：`hZ` 只在 `__complianceSinkRestricted` 时 scrub。默认 `main.log` 可能含路径、用户名、URL。Support Bundle 的 scrub 是另一套逻辑。  
  证据：`index.pre.js:798329/804466`。
- **[已证实] Slack logs handoff 与 SSH host 检查不一致**：`createLogsZipBuffer` (`cji`) 会因保存的 SSH host 名拒绝打包；`createLogsHandoffBundle` (`Iji`) 走 `sji`，不做该拒绝。SupportBundle 的 zip 导出也不走 `cji`，只在发送事件里去掉 log lines。  
  证据：`index.chunk-Z7WxBjyE.js:5094340/5094567/5094628/5115609`。
- **[已证实] error feedback bundle 会带 transcript**：`createErrorFeedbackBundle` 把 `getTranscriptFiles` 的结果作为 zip extras。  
  证据：`index.chunk-Z7WxBjyE.js:5112978+`。
- **[已证实] zip scrub 对二进制扩展原样放行**：pdf/png/jpg/zip 等不做内容 scrub。  
  证据：`index.chunk-Z7WxBjyE.js:125389`。
- **[已证实] stall sampler worker 退出后不自动 refork**：只 warn。  
  证据：`index.chunk-Z7WxBjyE.js:5238825+`。
- **[已证实] 本构建多处“有代码但关闭”**：`ancientJournal`、BENCH M0/M1/M2、`Me=e=>null`。不要根据字符串存在就判断功能启用。
- **[已证实] 种子里的 `diagnosticTracking` 不存在**：全仓无此符号；实际相近能力是 session host 的 `desktop_diagnostic_counts_enabled` / `host_report_enabled` 能力位，以及 Support Bundle 的 `cli-diagnostics.jsonl`。
- **[已证实] 只发现一个 40s watchdog**：PTY host 的 `ce=4e4`。没有找到独立的“terminal 40s watchdog”；终端另有 10s spawn ack 与 15s scrollback read 超时。
- **复杂度成本**：7MB 主 chunk、大量动态 require、多个独立 subsystem；AutoAgent 应抽取模式而不是复制规模。

---

## 7. 证据判定汇总

### [已证实]

- winston 级别、`DESKTOP_LOG_LEVEL`、`CLAUDE_ENABLE_LOGGING`、`DEBUG`。
- `main.log` 10MB×5；per-window 5MB×5；mcp/per-server；cowork VM。
- 合规模式下日志行 scrub、MCP raw log 丢弃。
- Sentry DSN、release/debug id、`sendDefaultPii:false`、beforeSend/beforeBreadcrumb、egress gate、离线队列 purge、minidump。
- essential/non-essential 开关与 fail-closed 值。
- 启动检查点、SPA marks、stall sampler、内存采样。
- PTY 40s watchdog、10s spawn ack、15s scrollback read、worker cooldown。
- 通用 worker 监管器、helper 退避、主视图重试、quit cleanup。
- GrowthBook 端点/缓存/优先级/fail-closed/dev override。
- Support Bundle section、zip、发送、SSH 名检查、symlink 拒绝。
- 更新通道、Linux apt、状态机、空闲重启、会话守卫、失败记录。
- `ancientJournal` 在本构建不可用。
- 种子的 `ui_render:ask/answer/applied/invalidate`、`ui_press:sent` 不存在。

### [推断]

- Linux 默认日志路径通常是 `~/.config/Claude/logs`（Electron `app.getPath("logs")` 默认行为）；代码只明确 `CLAUDE_USER_DATA_DIR` 时改为 `<dir>/Logs`。
- Sentry 默认事务采样未开启（init 未设 `tracesSampleRate`，但 renderer 端 SDK 可能另有配置）。
- terminal/preview 没有独立日志文件；PTY stdout/stderr 通过 `[pty-host]` 前缀汇入主日志，preview 可能使用 `in-app-browser.log`。
- `latest` 通道在正式构建中基本不可用，因为 `ancientJournal` 被硬编码关闭。
- 更新 rollback 机制不存在；只有上限/失败记录/替换检测。

### [未知]

- 服务端如何聚合这些事件（Sentry 项目、BQ/事件仓库、看板、采样率）。
- Sentry 错误事件的 `sampleRate` / `tracesSampler` 最终值（init 未显式设置）。
- `SENTRY_RELEASE` 是否还会被启动器以环境变量方式覆盖（代码只看到注入的 global）。
- 各平台安装器/包管理器是否提供真正的版本回滚。
- 用户菜单中 “Help / Support” 的确切文案与入口层级。
- `@sentry/electron` 除自定义集成外的完整默认集成列表。

---

## 8. Handoff（10 条）

1. 本报告只读分析 `app` 与 `extracted`，未修改任何产品文件；唯一写入是 `research/highlights/observability.md`。
2. 最值得抄的是“三平面 + 双闸门”：本地日志、产品事件、Sentry/崩溃各自独立，essential/non-essential fail-closed。
3. 最强可靠性设计是 stall sampler：SAB heartbeat + inspector profile + power/sleep 判别 + app:// frame 归一化。
4. 启动性能用单调检查点贯穿 pre/main/renderer，最终落一条 `desktop_app_startup_perf`；成本低，优先做。
5. worker 监管器是通用模板：互斥/超时/取消/首 reply proven/30s→10min 退避/惰性 refork/端口缓冲。
6. 优雅退出把 handler 耗时、pending、watchdog 写进 store，下次启动回报；这是“退出可靠性”的关键。
7. Support Bundle 的核心不是 zip，而是 section registry + manifest + 同意发送；注意 zip 导出与事件发送的脱敏边界不同。
8. 日志默认不脱敏（除非 compliance restricted）；MCP raw log 在合规模式被丢弃；Support Bundle 有独立 scrub。
9. 种子里 `ui_render:ask/answer/applied/invalidate`、`ui_press:sent` 在本构建不存在；`ancientJournal` 是死代码；不要基于字符串存在判断功能启用。
10. AutoAgent 的 P0 落地顺序建议：统一事件信封/闸门 -> 启动检查点 -> worker 监管器 -> 优雅退出 -> Support Bundle MVP；随后再补 Sentry、flag、更新、stall 简化版。
