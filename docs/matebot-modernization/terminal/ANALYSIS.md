# Claude Desktop 2.42304.0 Linux 终端实现端到端逆向

研究对象：`/home/tars/yysapp/claude-desktop/app`（解包后的 app.asar，主进程/预加载，压缩单行 JS）与
`/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist`（渲染进程 SPA）。
辅助证据：`asset/ipc_services.json`、`asset/ida_pty/`、`asset/pty_calls.json`、`asset/rea_application_graph.json`。

偏移约定：文中 `@12345` 均为“UTF-8 解码后的字符下标”（这些 bundle 基本是单行文件），不是行号。
渲染器文件位于 `.../ion-dist/assets/v1/`，主进程文件位于 `app/.vite/build/`。

---

## 1. 结论速览

1. 终端不是单进程实现，而是三层：**渲染进程 xterm.js** -> **主进程 `ShellPtyManager`** -> **独立 utility-process `pty-host`** -> **node-pty** -> **登录 shell / ssh / wsl.exe**。`pty-host` 通过 `Electron MessageChannelMain/MessagePort` 与主进程通信，主进程再通过渲染器 IPC 事件把数据推给 xterm。[已证实]
2. `pty-host` 只做五件事：spawn/kill PTY、转发数据、resize、把输出写进磁盘 scrollback 分段日志、处理 `read-scrollback`（含 grep/分页）。它不参与权限判断、不解析 OSC 133、不做 tab 模型。[已证实]
3. 主进程 `ShellPtyManager` 才是会话/tab 状态机：`ptyKey = sessionId`（主 tab）或 `sessionId::tabId`；管理 spawn 原因、复用、上限/驱逐、SSH 挂起/重连、OSC 133 命令跟踪、输入门控、16ms 输出合批。[已证实]
4. 交互终端默认 argv 是 `$SHELL -l`，cwd 是会话工作目录（scratch workspace 例外，回落到 home）；`TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=claude-desktop`。Windows 的 pwsh/powershell/gitbash 选择逻辑存在于本 binary，但本 Linux build 的 `terminalShellsOffered()` 恒为 false，因此不生效。[已证实]
5. shell integration 不修改用户 dotfiles：它生成一套 shim 目录（zsh/bash/fish/pwsh），通过 `ZDOTDIR`、`--init-file`、fish `-C`、PowerShell `-Command` 注入；nonce 只放在 0600 的临时文件里，脚本读取后立即删除；OSC 133 A/B/C/D 与 OSC 697 ShellReady 都被主进程/渲染器解析。[已证实]
6. 磁盘 scrollback 是**纯文本重建**：写入时保存原始字节，读取时用完整 VT 状态机跨 segment 重放并剥离控制序列；nonce 会被 `*` 脱敏；分段 4 MiB、最多 16 段，但驱逐条件还会把“总字符数减最老段”压到 4 MiB 以下，实际保留通常约 4-8 MiB。读取窗口 100 KiB，grep 最多显示最近 40 个命中、每处 2 行上下文。[已证实]
7. 主进程另有一个 256 KiB 的**原始输出 replay ring**，用于面板重挂载/SSH 重连时原样回放；它和磁盘纯文本 scrollback 是两套东西。`read_terminal` 在没有 offset/grep 时走 replay ring + 无头 xterm 重放取“屏幕行”，有 offset/grep 时走磁盘日志。[已证实]
8. SSH 有两种 carrier：新版共享连接（sharing，本地 PTY 或 pipes 承载多个远端会话，预算 9 个通道；被对端拒绝后该 host 改用独立连接）与独立 `ssh -t -o EscapeChar=none -- host 'cd ... && printf nonce && exec $SHELL -l'`。连接丢失时 tab 会挂起并保留 replay，可按键唤醒/自动重开。[已证实，共享 carrier 的底层引擎只部分可见]
9. 命令输入有严格门控：`run_in_terminal` 只接受单行、<=2000 字节、可打印 ASCII；先在 1s 超时内做静态危险构造检查，再用真实 shell 的 `-n` 解析（zsh/bash/sh/fish/powershell）；之后还必须等 shell 真正空闲、远端 shell 与“校验命令的 shell”一致，才把命令逐字键入 PTY。非 Claude 打开的 tab、用户键入过的 tab 永远不碰。[已证实]
10. 渲染器使用内联 FitAddon（`ze`）与 SearchAddon（`Nt`）、动态加载的 WebglAddon、自定义链接 provider 和 OSC 颜色保护；默认字体 `Menlo, Monaco, "Courier New", monospace` 13px、`minimumContrastRatio: 3`、scrollback 10000（可 1000/5000/10000）。没有加载 AccessibilityAddon，只设置了 textarea 的 aria-label。[已证实]
11. Bash 工具路径与可见终端是两条 PTY 池：`runBashCommand` 使用隐藏的 80x24 bash-mode PTY（最多 16 个、无磁盘 scrollback、命令后补 `\r`、30s 超时、100 KiB 输出上限、必要时 SIGINT/SIGKILL 或整壳重启），与用户的可见 tab 完全分离。[已证实]
12. 主要风险点：PTY 子进程继承应用 `process.env`（不脱敏）；live 数据没有 credit/ack 背压；OSC 133 的安全性完全依赖 nonce 不泄漏；磁盘日志的 `lost` 是单向标志；渲染器 tab 上限 16、MCP 每会话 Claude tab 上限 6。[已证实]

---

## 2. 进程 / 数据流图（文本）

```
┌──────────────────────────────────────────────────────────────────────┐
│ Renderer (Electron BrowserWindow, ion-dist SPA)                      │
│                                                                      │
│  ShellTerminal (c6bf19e8f)                                           │
│    xterm Terminal ── onData ──► transport.writeShellPty(ptyKey,data) │
│        ▲                              │                              │
│        │ terminal.write()             │ local: IPC invoke            │
│        │                              │ remote: WebSocket JSON       │
│    shell_pty_data ◄── preload onOnEvent                              │
│    set title/OSC 133/tabs (cf718f694, cccc2cf0a, cc0051c10)          │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ contextBridge (mainView.js)
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Main process (Electron)                                              │
│                                                                      │
│  LocalSessions IPC handlers (B4uTve_e.js @61989)                     │
│        │                                                             │
│        ▼                                                             │
│  ShellPtyManager (CbknQPGf.js @36257)                                │
│    shellPtyProcesses : Map<ptyKey, LocalPty>                         │
│    suspendedShells  : Map<ptyKey, {sshConfig,...}>                   │
│    shellPtyBuffers  : Map<ptyKey, ScrollbackBuffer(256KiB replay)>   │
│    shellPtyTrackers : Map<ptyKey, Osc133Tracker>                     │
│    pendingEmits     : Map<ptyKey,string[]>  16ms 合批                │
│        │                                                             │
│        ├─ MessagePort.postMessage(spawn/write/resize/read-scrollback)│
│        ▲                                                             │
│        │ spawned/data/exit/spawn-error/spawn-fallback/scrollback-read│
│  PtyHostService (CbknQPGf.js @6288)                                  │
│    utilityProcess.fork(ptyHostWorker.js, serviceName="Claude Desk..." )│
│    40s watchdog (仅 spawn ack 未完成时), cooldown, refork-on-demand   │
│        │                                                             │
│        ├─ 事件转发到 renderer: shell_pty_data / close / link / tab   │
│        └─ read_terminal: 256KiB replay -> heavy-work worker          │
│                          （无头 xterm 重放，取屏幕行）                │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ MessagePort
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│ pty-host utility process (pty-host/ptyHostWorker.js)                 │
│   node-pty.spawn(file,args,{name,cols,rows,cwd,env})                 │
│   onData -> post {type:"data"}; append to scrollback log             │
│   onExit -> post {type:"exit"}; dispose log                          │
│   read-scrollback -> VT state replay -> plain text / grep            │
└──────────────────────────────────┬───────────────────────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ shell: $SHELL -l             │
                    │ ssh -t ... host 'cd && exec' │
                    │ wsl.exe -d <distro> --cd ... │
                    └──────────────────────────────┘
```

补充事实：

- `PtyHostService.forkWorker()` 使用 `electron.utilityProcess.fork(qon("pty-host","ptyHostWorker.js"), [], {serviceName:"Claude Desktop PTY Host", stdio:"pipe"})`，随后 `new MessageChannelMain()`，把 `port2` 作为 `init` 消息的 transfer 传给 worker；worker 只在收到 `{type:"init",ports:[port]}` 后开始服务，否则 `process.exit(1)`。[已证实：Cbkn @6288、ptyHostWorker @11479]
- 主进程在 `spawn` 时立即把 pty 放入 Map，并在收到 `spawned`（pid>0）或 `exit`/`spawn-error` 后才清 watchdog ack；若 40s 内没有 ack，认为 worker 不响应并 `child.kill()`，随后按需 refork。[已证实：Cbkn @6288-7100]
- worker 崩溃/被杀时，所有存活 PTY 立即收到 `emitExit(1,"Terminal backend crashed")`，pending read 以 `{ok:false,error:"terminal backend exited"}` 结束；下次 spawn 时再 fork。[已证实]
- cooldown：连续早死按 `min(30s * 2^n, 10min)` 退避；若上一轮 fork 曾成功 spawn 过且不是 watchdog 杀的，则不进入 cooldown。[已证实：Z7Wx @2629488 `Xon`]
- 为什么单独进程：代码没有注释说明。基于 watchdog、refork、`stopsChildProcesses` 退出钩子和把磁盘 IO 放在 worker 的事实，推断是为了隔离 node-pty 原生模块崩溃/阻塞、允许整进程重启而不拖垮主进程，并把大日志写入移出主进程。[推断]

---

## 3. 协议表

### 3.1 主进程 -> pty-host（MessagePort，结构化克隆）

| type | 方向 | 字段 | 语义 |
|---|---|---|---|
| `spawn` | main -> worker | `ptyId,file,args,opts{name,cols,rows,cwd,env,windowsFallbackFile?,scrollbackLogDir?,scrollbackRedact?}` | 创建 PTY；`name` 同时作为 TERM 名（`xterm-256color`）。有 `scrollbackLogDir` 时创建日志；有 `windowsFallbackFile` 时建立 64KiB 输入 replay。 |
| `spawned` | worker -> main | `ptyId,pid` | 已创建；pid 可能先为 0，首个 onData 后修正并再发一次。 |
| `data` | worker -> main | `ptyId,data:string` | 原始 PTY 输出（UTF-8 字符串）。 |
| `exit` | worker -> main | `ptyId,exitCode` | 进程退出。信号退出被换算为 `128+signal`。`kill` 也会主动回一个 exit(0)。 |
| `spawn-error` | worker -> main | `ptyId,message` | spawn 抛错且无 fallback。 |
| `spawn-fallback` | worker -> main | `ptyId,fromFile,toFile,reason` | Windows fallback 文件启动失败/首输出前退出；worker 用 fallback 重新 spawn 并回放输入 replay。Linux 本地终端通常没有 fallback。 |
| `write` | main -> worker | `ptyId,data` | 写入 PTY；同时把输入追加到 fallback replay（上限 64KiB）。 |
| `resize` | main -> worker | `ptyId,cols,rows` | `node-pty.resize`；列/行被钳制到 2..1000，默认 80x24。 |
| `kill` | main -> worker | `ptyId` | 删除日志、杀 PTY、回 exit(0)。 |
| `dispose-scrollback` | main -> worker | `ptyId` | 只删日志，不动 PTY。 |
| `read-scrollback` | main -> worker | `ptyId,requestId,offsetLines,lines,grep?` | 请求历史文本。 |
| `scrollback-read` | worker -> main | `ptyId,requestId,result` | 结果见 6.3。 |
| `shutdown` | main -> worker | 无 | killAllPtys 后 `process.exit(0)`。 |

worker 侧用 `postMessage` 直接发送对象；主进程用 zod `U` 校验 worker 消息，畸形消息丢弃并告警。[已证实：Cbkn @4430]

### 3.2 主进程 -> 渲染器事件（`LocalSessions_$_onEvent` 通道）

| type | 关键字段 | 语义 |
|---|---|---|
| `shell_pty_data` | `sessionId,data` | 注意：`sessionId` 实际是 **ptyKey**（可能是 `base::tab`）。16ms 合批后按 ptyKey 发送。 |
| `shell_pty_close` | `sessionId(=ptyKey),code?,error?` | PTY 退出或被杀。`error` 是给人看的 reason；渲染器把它映射为 `reason`。 |
| `shell_pty_link` | `sessionId(=ptyKey),shellPtyLink: lost\|restored\|idle\|starting\|connected,shellPtyHost?,shellPtyShell?,error?` | SSH 链路状态。`error` 控制字符被替换、截断 200。 |
| `shell_pty_tab_opened` | `sessionId(=基础会话),terminalTab{ptyKey,tabId,cwd,title?,openedBy,ranCommand?,onHost?,...},created,ranCommand?,leavePane?` | 新 tab 或 MCP 复用/打开；渲染器据此 adopt。 |
| `shell_pty_tab_closed` | `sessionId(=基础会话),terminalTab` | tab 被关闭，含最后的屏幕行（`stopClaudeTab` 的 tail）。 |

渲染器本地 transport 只订阅 `shell_pty_data/close/link`（c039 @1811）；tab 事件由 SPA 的会话事件总线处理（ce401cf8e @5341 分派到 adopt/close）。[已证实]

### 3.3 渲染器 -> 主进程（preload `mainView.js`）

| 方法 | 参数 | 语义 |
|---|---|---|
| `startShellPty` | `sessionId(=ptyKey),cols,rows,spawnReason,ownerCwd,linkAware,options{hostShellAware?,shell?}` | IPC `LocalSessions_$_startShellPty`。返回 `{ok,error?,shell?,buffered?,cols?,rows?,waiting?}`。 |
| `stopShellPty` | `ptyKey` | 只停这一个 key（LocalSessions 传 `{noSweep:true}`）。 |
| `resizeShellPty` | `ptyKey,cols,rows` | 尺寸。 |
| `writeShellPty` | `ptyKey,data` | 键盘输入。 |
| `getBusyShellPtyKeys` | `sessionId,tabsOnly?` | 返回 `{live,busy,probed,unknown,tabs}`；用于判断 tab 是否在跑命令。 |
| `setShellPtyTitle` | `ptyKey,title` | 设置主进程 meta 的 label（MCP 复用命名）。 |
| `getTerminalShells` | 无 | Windows 可选 shell 列表；本 Linux build 恒空。 |
| `runBashCommand` | `sessionId,command` | 隐藏 bash-mode PTY，返回 `{stdout,stderr,code?,error?,foregroundActive?,foregroundUninterruptible?,interruptedPrevious?}`。 |
| `interruptBashCommand` | `sessionId` | 向隐藏 bash PTY 写 `\x03`。 |

这些 handler 在 `B4uTve_e.js @61989` 注册；IPC 服务名表见 `asset/ipc_services.json` 的 `LocalSessions` 条目。[已证实]

### 3.4 远端/云端 WebSocket transport

`c03935b01` 定义第二套 transport（不是 SSH 本地 pty，而是 CCR/云端会话）：

| 方向 | 消息 | 字段 | 语义 |
|---|---|---|---|
| client -> server | `resize` | `cols,rows` | WS 打开后立即发一次，之后尺寸变化再发。 |
| client -> server | `data` | `data:string` | 原始键盘输入（未 base64）。 |
| client -> server | `close` | 无 | 关闭。 |
| server -> client | `opened` | `data?:base64` | 打开成功；`data` 是可选的初始 replay，用 streaming `TextDecoder` 解码。 |
| server -> client | `data` | `data:base64` | 输出。 |
| server -> client | `exit` | `exit_code?,signal?` | 退出。 |
| server -> client | `error` | `error?` | 未 opened 前是启动失败；opened 后转为 close。 |

URL：feature flag 决定 `${proto}//${host}/v1/code/sessions/<sid>/terminal` 或 `/v2/ccr-sessions/<sid>/terminal`；15s 打开超时；同一 session 重复 start 会先关旧 socket。[已证实：c039 @3160-4700]

### 3.5 MCP 终端工具（`mcp__terminal__*`）

| 工具 | 作用 | 关键限制 |
|---|---|---|
| `read_terminal` | 读屏幕或历史 | `lines` 默认 200、最大 1000；`wait_for_output_ms`；`offset_lines`/`grep` 需 flag 1923867086；只读。 |
| `run_in_terminal` | 新开或复用 Claude tab 并键入一行命令 | 单行、<=2000 bytes、可打印 ASCII；最多 6 个 Claude tab/会话；只碰 `openedBy=claude` 且用户没键入过的 tab。 |
| `open_terminal_tab` | 新开空 tab 并显示面板 | cwd 必须在会话可访问目录内。 |
| `list_terminal_tabs` | 列出 tab | 返回 `is_running_command`（probe 成功时）与 `reusable`。 |
| `stop_terminal_tab` | Ctrl-C 或关闭 | `close:true` 才关 tab；只作用于自己开的 tab。 |

工具名常量在 Z7Wx @4169000：`mcp__terminal__read_terminal` 等；schema/描述在 `index.chunk-hWiNbYHV.js`。[已证实]

---

## 4. 会话 / 标签 / 生命周期

### 4.1 键与命名

- 分隔符 `"::"`。`shellPtyKeyFor(sessionId,tabId)`：`tabId` 为空或 `"0"` 时返回 `sessionId`，否则 `${sessionId}::${tabId}`。[已证实：Cbkn @16516]
- 渲染器主 tab id 为 `"0"`；用户新 tab 用递增数字；Claude/MCP tab 用 `c<N>`（`qe="c"`）。[已证实]
- `parseShellPtyKey` 反向拆分。很多 IPC 参数名仍叫 `sessionId`，实际传的是 ptyKey，阅读时不要被名字误导。[已证实]

### 4.2 spawn 原因

枚举：`prewarm | pane_open | new_tab | inline_run | mcp | unknown`（`Ge` 集合）。渲染器映射：

- tab id `"0"` 可见 pane：`pane_open`
- 其他可见 tab：`new_tab`
- 隐藏的 `ShellTerminalChunk`：`immediate ? "inline_run" : "prewarm"`
- MCP 工具：`mcp`
- 无法识别：`unknown`

证据：Cbkn @16523；cccc2cf0a @44900-46600（`spawnReason:n.id==="0"?"pane_open":"new_tab"`，隐藏组件 `spawnReason:o?"inline_run":"prewarm"`）。[已证实]

### 4.3 start 的完整顺序（ShellPtyManager.startShellPty）

1. 解析基础 session、owner、页信息；若 session 不存在且非 Claude 内部 tab，`resolveToolOwner` 失败 -> `Session not found`。
2. 若已有 `suspendedShells[key]` 且不是 `resume`：更新尺寸，返回 `{ok:true,waiting:true,buffered}`；按需 `reopenSuspendedShell` 或按键唤醒。
3. 若已有活 PTY：非 resume -> 重挂载（把 Map 条目移到末尾模拟 LRU，返回 replay/cols/rows）；resume -> `a terminal is already open under this tab id`。
4. 计算 cwd：`openedBy==="claude"` 或显式 cwd 优先；否则 `worktreePath||cwd`；scratch workspace 回落到 home。
5. WSL：若 session 有 wslConfig 且未恢复，调用 `judgeWslShell` 并构造 `wsl.exe` spec。
6. SSH：`resolveSshSpawnSpec` 做 host 校验、策略判断、连接、远端 cwd 展开，选择 shared/separate carrier。
7. 本地：`fs.access(cwd)`；不存在时允许回落到会话 cwd，否则报 `Working directory "..." does not exist`。
8. 计算 scrollback 目录（仅本地、非 WSL、非 SSH、非 archive）；计算 shell integration shim + nonce 文件。
9. 竞态检查：`realpath(cwd) !== cwd`、会话 cwd 已变化、session 已 archive、quit 中、owner 已 stop -> 拒绝并清理 nonce。
10. 构造 env/argv，调用 `W(shell,args,opts)` -> `PtyHostService.spawn`；立即放入 Map，先放 replay buffer/tracker/stats。
11. 等待 `whenReady`（`spawned` ack；10s 未 ack 时“继续”）；失败 -> 清理并返回错误。
12. SSH 额外等待 `awaitSshShellReady`（30s）：读取 OSC 697 ShellReady（可带 Tty/Pid/Shell）；超时则信任并告警。
13. 统计 `desktop_ccd_terminal_spawned`；shell PTY 总数 >16 时驱逐。
14. 返回 `{ok:true}`；如果 pane 尚未接手（`notForItsPage`），可能立即 stop 并返回“页面已重载未接管”的错误。[已证实：Cbkn @36257-45000]

### 4.4 停止、驱逐、退避

- `stopShellPtyKey(key,reason)`：flush 未发数据、递归杀进程树、上报 `desktop_ccd_terminal_pty_closed`、删日志/nonce/buffers/trackers、发 `shell_pty_close`。[已证实：Cbkn @45891]
- 进程树杀法：主进程 `pgrep -P` 递归收集子进程 -> 逐个 `SIGKILL` -> `pty.kill()`；Windows 上额外 `taskkill /T /F`。[已证实：Cbkn @44800]
- 上限：shell PTY 池 16（`At=16`）；bash PTY 池 16（`Nt=16`）。驱逐优先挑“其他会话、不在运行、不在打字”的最老 key；若没有，则挑任意最老。[已证实：Cbkn @45758]
- SSH 共享连接预算 9：不够时先驱逐该 host 上空闲的隐藏 bash PTY；仍不够则报“Too many terminals are open on ...”。[已证实：Cbkn @34400]
- 无 shell 的挂起 tab 最多 8；新键唤醒时淘汰最老。[已证实：Cbkn @38294]
- 关闭原因字符串：`stopped / evicted / quit / exited / connection_lost / killed`（部分为内部原因）。[已证实]

### 4.5 挂起 / 重连（SSH）

- 当共享 carrier 的 `transportAlive()` 为 false，或退出码为 255，且不是主动关闭时，进入 `suspendShell`：保留 sessionId/hostKey/hostLabel/cols/rows/hadShell/scrolledUp，发 `shell_pty_link="lost"`，不删 tab。[已证实：Cbkn @45077]
- `reopenSuspendedShell` 以 `resume:true` 重新 start；成功发 `restored/connected`；失败且 `keepWaiting` 则继续等待；连续 channel 丢失 3 次/60s 后不再自动重试，转为 idle。[已证实：Cbkn @36950]
- 用户在 idle 终端按键：`writeShellPty` 识别“真实输入”（过滤 DA/CPR/颜色/mouse 等查询响应），触发 `wakeSuspendedShell` -> `connectForShell(...,openedBy terminal)`。[已证实：Cbkn @58000]
- 共享连接对端拒绝：输出中出现 `"Session open refused by peer"` 且 shell 未 ready -> 标记 `peerRefused`、把 host 加入 `hostsRefusingSessions`，之后该 host 的终端改走独立 ssh。[已证实：Cbkn @42513]

### 4.6 Claude tab、复用与序号

- `nextClaudeTabId(sessionId)`：读取“内存最大序号”和持久化 `terminalClaudeTabOrdinal` 的较大者，`n+1` 生成 `cN`，直到 `holdsTab()` 不冲突；随后异步写回会话记录（5s 超时；失败只影响下次重启的稳定性）。[已证实：Cbkn @67435]
- 复用 `claudeTabReuse` 的拒绝原因：`missing / not_claude / remote / no_prompt_marks / other_shell / running / typed_in / renamed / unnamed / ambiguous`。只有 `openedBy=claude`、非 SSH、shell integration 报告命令、非 compromised、shell 类型与当前一致、处于 idle、用户未键入、命名匹配且不歧义时才复用。[已证实：Cbkn @64551]
- 每会话最多 6 个 Claude tab（MCP 工具侧计数，含在途）。[已证实：hWiN @14674]
- `stopClaudeTab({close})`：close -> 杀 PTY、发 `shell_pty_tab_closed`、返回最后 20 行屏幕；否则写 `\x03`，等待 3s 判断 idle/running/exited。[已证实：Cbkn @66100]
- 渲染器自己的 tab 元数据持久化在 zustand persist key `epitaxy.terminalTabs.v1`（bySession + defaultShell），`pendingCd/pendingFocus/quietOpen` 不持久化；rehydrate 时清理无法对应的未发送输入。[已证实：c039 @10843]

### 4.7 页面接管（page awareness）

主进程维护 `pagesWord: ptyKey -> {aware,pageId}`。渲染器每次 start 带 `{id:windowId,hostShellAware}`。`notForItsPage` 阻止把数据发给“没有接手这个 tab 的页面”（例如重载后的旧页面），并可能在 shell ready 后立刻停掉 PTY 返回错误。[已证实：Cbkn @38600、@52300]

---

## 5. shell 解析与安全

### 5.1 本地 shell 解析

`fZe()`（Z7Wx @956921）：

1. `process.env.SHELL` 必须是绝对路径且存在 -> 用它。
2. 否则第一轮：`/bin/zsh`（存在且 `~/.zshrc` 存在）-> `/bin/bash`（存在且 `~/.bashrc` 存在）。
3. 第二轮（不看 rc）：`/bin/zsh` -> `/bin/bash` -> `/bin/sh`；最后兜底 `/bin/sh`。

本地 argv 始终以 `["-l"]` 为基准（`Ve`），再由 shell integration 改写：

| shell | 最终 argv | 注入方式 |
|---|---|---|
| zsh | `zsh -l` | `ZDOTDIR=<shim>/zsh`、`CLAUDE_DESKTOP_ZDOTDIR`、`CLAUDE_DESKTOP_USER_ZDOTDIR` |
| bash | `bash --init-file <shim>/bash/claude-desktop.bash` | 自定义 init 文件显式 source `/etc/profile` 与 `~/.bash_profile/.bash_login/.profile` |
| fish | `fish -l -C 'source <shim>/fish/claude-desktop.fish <nonceFile> 0/1'` | `-C` |
| pwsh | `pwsh -NoProfile -NoExit -Command <loader>` | loader 自己 dot-source 四个 profile 路径后安装 hook |

若 shell integration 不可用，直接用 `-l`。[已证实：Z7Wx @4161585-4163100]

### 5.2 环境变量

本地可见终端的 env 构造为：

```js
{
  ...process.env,                 // 应用进程环境，未脱敏
  ...browserBridgeEnv,            // 可能含 BROWSER / CLAUDE_BROWSER_BRIDGE
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "claude-desktop",
  TERM_PROGRAM_VERSION: undefined, // 显式清空
  ...shellSpec.env,               // ZDOTDIR / nonce file / headless 等
  ...integration.env
}
```

- `name` 选项同样是 `xterm-256color`，node-pty 会据此设置 TERM。
- Bash-mode 隐藏 PTY **不设置** `TERM_PROGRAM`，并在 shim 中设置 `CLAUDE_DESKTOP_TERMINAL_HEADLESS=1`；zsh/fish 也会隐藏右提示/提示符。[已证实：Cbkn @39500]
- SSH 独立 carrier 的 env 是 `{...process.env, PATH=<login PATH>}`；共享 carrier 再叠加 `TERM/COLORTERM`，仅在 `identifyTerminal` 时加 `TERM_PROGRAM=claude-desktop`。[已证实：Cbkn @35219]
- 结论：**没有对本地 PTY 做环境变量白名单/脱敏**。这是用户自己的登录 shell，设计上要继承凭据（SSH_AUTH_SOCK、云凭据等）。[已证实 + 设计推断]

### 5.3 shell integration shim 与 nonce

生成目录：`<userData>/terminal-shell-integration/{zsh,bash,fish,pwsh,spawn}`；文件清单见 `VHr`（Z7Wx @4161585）。目录 0700、文件 0600（`ri` mode 448，`qr` 默认 mode 384）。[已证实]

nonce 文件 `<spawn>/<random8hex>` 内容两行：

```
<32位hex nonce>
<16位hex displayNonce>
```

- 主 nonce 用于 A/C/D 标记；display nonce 用于 B/P（提示符边界/提示文本）标记。
- 脚本启动时 `read` 两行、`rm -f` 删除文件，并 `unset CLAUDE_DESKTOP_TERMINAL_NONCE_FILE`；zsh/bash 还特意 `typeset +x`/`export -n`，避免 `allexport` 把它导给子进程。[已证实：Z7Wx @4142000-4155000]
- 主进程默认 nonce 文件 TTL 60s（`Ht=6e4`）；到期仍存在则 `tracker.distrust()` 并删除。启动时还会扫掉 mtime 超过 1h 的旧 nonce 文件（`Vt=36e5`）。[已证实：Cbkn @27066]
- OSC 697 `ShellReady` 由远端 shell 打印，格式：
  `ESC]697;ShellReady=<nonce>[;Tty=...;Pid=...;Shell=...]BEL`
  解析器限制 8KiB、最多 256 字符 payload，host 校验 `Tty` 为 `/dev/...`、pid 为正整数、shell 取 basename。[已证实：DL8FV @609-1935]

### 5.4 OSC 133 标记与信任

shim 产生：

- `ESC]133;A;nonce=<n>BEL` 提示符开始（fish/PowerShell 也只发 A/C/D）
- `ESC]133;P;k=i;dn=<dn>BEL` 提示文本开始
- `ESC]133;B;dn=<dn>BEL` 命令行开始（zsh/bash/PowerShell）
- `ESC]133;C;nonce=<n>;cmdline_url=<urlencoded>BEL` 命令开始（命令文本最多 2048/6144 字节，URL 编码）
- `ESC]133;D;<exit>;nonce=<n>BEL` 命令结束
- `A` 可带 `;cl=0` 表示该 shell 不报告命令行（PowerShell 无 PSReadLine 时）

主进程 tracker（DL8FV）：

- 只接受带正确 nonce 的 A/C/D；B/P 只接受 display nonce。
- 维护 `{marksSeen,promptSeen,reportsCommands,phase,currentCommand,startedAt,lastCommand,lastExitCode,finishedAt}`；`finished` 最多 64 条。
- `C` -> `commandSeq++`，记录 outputStart、清 promptSpans、phase=running；`D` -> 生成 `{seq,command,exitCode,startedAt,finishedAt,durationMs,outputLines,outputStart,outputEnd}`。
- **nonce 泄漏检测**：在普通输出流中搜索 nonce；若出现且不在合法的标记区间内，`distrust()`：清空 nonce、phase=idle、`compromised=true`，之后不再复用/自动键入，并告警 `OSC 133 marks no longer trusted`。[已证实：DL8FV @4710-6900；Cbkn @43000]

### 5.5 命令输入门控（run_in_terminal）

`checkTerminalCommandFor`（BvLv @2025949）：

- 本地：`$x(command, localShellPath())` -> `VUr` -> `BUr` 静态检查 + `rUr` 用真实 shell 的 `-n` 解析。
- SSH：`eS`/`_S` 在远端执行 `LC_ALL=C; unset BASH_ENV ENV; $SHELL ... -n -c -- 'cmd'`，把识别出的 shell 名返回给 `vettedBy`。

`BUr` 规则（Z7Wx @4174177）：

- 必须是字符串、非空、trim 后非空。
- UTF-8 字节数 <= 2000。
- 不允许 `\r`/`\n`（强制单行；多步用 `&&`）。
- 不允许控制字符、不可见字符、非标准空格。
- 不允许非 printable ASCII（防同形字伪造审批卡片）。
- 静态危险构造检查（zsh/bash 巨量 denylist：history 展开 `!`、`fc/r/history/pushln`、`read` 家族、`typeset/declare/local`、`eval/trap/sched/zle/zstyle/source/ssh/su/tmux/screen`、`$'...'` 数字转义、zsh glob qualifier、`${(flags)x}`、`PROMPT_COMMAND/HISTFILE/histchars/ZDOTDIR/...` 赋值、prompt/mail 参数、hook 函数定义/alias、`print -P`、`<<<`、`/proc/*/exe` 等）。
- `_Gr` 对 PowerShell 做 AST 白名单：只允许字符串/常量/命令/参数/数组/变量赋值/重定向；禁止 `Invoke-History/ihy/r/iex/Add-Type/sal/nal/ipal/New-PSDrive/ndr/mount/prompt`、PSReadLine、`function:/alias:/env:` drive、`$env:PSModulePath`、`--%`、注释、计算表达式。
- 解析器在 1s 超时（`EUr=1000`）内运行；超时即拒绝。
- 随后 `rUr` 真正执行 shell 语法检查：zsh `-f -n -c`，bash `--noprofile --norc -n -c`，sh/dash/ash `-n -c`，fish `-n -c`，PowerShell AST 脚本；env 只保留 `PATH=/usr/bin:/bin, LC_ALL=C`，cwd `/`，超时 5s（PowerShell 30s）。[已证实]

`typeWhenShellReady`/`typeIntoShell`（Cbkn @60020）：见 6.5。

### 5.6 cwd 包含与授权

- 渲染器先调用 `resolveTerminalDirectory(sessionId, cwd)`；本地走文件访问层解析真实路径并检查是否在会话可访问目录；SSH 用 `resolveAgentHandoffPath(...,{foldersOnly:true})` 并在远端比较容器目录。
- 拒绝原因：`no_session`、`outside`（“outside the directories this session has access to, or does not exist there”）、`not_directory`。
- 客户端拿到的 realpath 若与用户给的规范化路径不同，要求重新调用（防“审批后目录被换”）。
- 主进程在 spawn 前再次 `fs.realpath`，并在 spawn 期间比较会话 cwd 是否变化；不一致则拒绝。
- `cwd` 解析还禁止控制字符、Windows 路径（SSH）、反斜杠、智能引号（SSH）。[已证实：BvLv @1041324；Cbkn @36600-39500]

### 5.7 SSH 校验

独立 carrier（`Ue`，Cbkn @15034）：

- `sshHost` 必须匹配 `^[A-Za-z0-9.@_:-]+$` 且不以 `-` 开头（防选项注入）。
- `sshPort` 必须是整数。
- 远端 cwd：禁止控制字节、Windows 盘符/反斜杠、智能引号。
- `sshIdentityFile` 不以 `-` 开头且无控制字节，否则丢弃并告警。
- cwd 用 `t.DS` 做 shell 引号；recovered HOME 只有在 `^[A-Za-z0-9._/-]+$` 时才加 `env 'HOME=...'`。
- 组装后的程序若含 `'`、换行、`!` 或连续反斜杠则抛错。
- 最终：
  `ssh [...-t -o EscapeChar=none ...] -- <host> 'cd <quoted> && printf <nonce> && exec [env HOME=...] [env TERM_PROGRAM=claude-desktop] $SHELL -l'`
- cwd 固定为本地 home；`identifyTerminal` 控制 TERM_PROGRAM。
- 调用前必须 `judgeSshDial`（策略）；ssh 二进制必须解析为绝对路径；managed ssh 不可用时给出企业错误文案。[已证实]

共享 carrier 还做：`liveChannels()+本机计数+1 <= 9`；对端拒绝检测；`hostsRefusingSessions`；EVICT 空闲 bash。底层 plan 的 `argvFor/start/resizeRemote` 在 `O.s(sshConfig)` 引擎里，本文未逐行展开。[部分证实/未知]

### 5.8 WSL

`Pvr`（Z7Wx @3789201）：feature flag `2897767209` 关闭或 session 无 wslConfig 时返回“not available yet”；远端路径必须匹配 `^(?:~|~?\/[^\p{Cc}"\\]*)$`；启动 `wsl.exe -d <distro> --cd <path>`，本地 cwd=home，不使用登录 shell 参数。Bash-mode 明确不支持 WSL。[已证实]

### 5.9 权限/审批

- 终端工具受 flag 1496761016 和组织/客户端能力约束；`sessionType` 必须是 `ccd`；SSH 只有 `terminalsOnHost===true` 才暴露；`cliUntrusted` 时关闭。[已证实：hWiN @32556]
- `run_in_terminal` 的审批卡片展示“将要逐字键入的那一行”；默认模式用户批准精确行，auto 模式按“无沙箱 Bash”同类分类器判断；SSH/远程控制始终在本机询问，远程控制给的批准不算数。[已证实：hWiN @2000-9000、Z7Wx @4166400]
- `terminalApprovalNeedsThisComputer`/`redeemTerminalConsent` 与 `_consent` 字段在 `I()` 中检查；`vettedBy` 由命令校验器提供，SSH 时还要与远端 shell 名一致。[已证实：hWiN @15008、Cbkn @61000]
- 命令不会由应用拼进 shell 字符串执行：交互路径是“逐字写入 PTY”；唯一拼接是 SSH remote 程序，且有上述白名单/引号/拒绝规则。[已证实]

---

## 6. scrollback / shell integration

### 6.1 两套缓冲

| 缓冲 | 位置 | 容量 | 用途 |
|---|---|---|---|
| replay ring | 主进程 `ScrollbackBuffer` (`mt`) | 256 KiB（`Z=262144`），按 chunk 维护 VT start-state，最多 64 个 resize 记录 | 面板重挂载/SSH 重连时原样回放；`read_terminal` 无 offset/grep 时重放取屏幕行 |
| disk scrollback | pty-host worker | 段 4 MiB，最多 16 段，实际约 4-8 MiB | `read_terminal` 的 offset/grep 历史；纯文本 |
| xterm 本地 scrollback | 渲染器 | 默认 10000 行 | 用户可见滚动条；不参与 MCP 读取 |

replay ring 细节（Cbkn @18031 `mt`）：

- `push` 累加 `endState = P(endState, chunk)`（完整 VT 状态机）。
- 丢弃最老 chunk，直到剩余 < 256 KiB；若被丢弃部分含 alt-screen 进入，会记录 `discardedOnAltScreen`。
- `replaySnapshot()`：必要时补状态前缀；若发生中行截断，回退到 16 KiB 内最后一个换行边界（`ct=16384`），并在前面插 `\x1b[2m[earlier output truncated]\x1b[0m\r\n`；若丢弃区间进入过 alt screen，则补 `\x1b[?1049h`。
- `screenReplay()` 返回 `{data,cols,rows,resizes:[{at,cols,rows}]}`；`at` 是字符位置。
- `readText(lines,offset)` 用于隐藏 bash PTY 的文本抽取（剥离 ANSI）。

### 6.2 磁盘日志实现（ptyHostWorker @3935 `X`）

- 目录：`<userData>/terminal-scrollback/<run-id>/<random8hex>/`；run-id=`run-<pid>-<base36 time>`。
- 文件名 `<generation>.log`；目录 0700、文件 0600。
- 写入前按 `redact` 列表（nonce、displayNonce）替换为 `*`，跨 chunk 用 carry 处理被切断的 secret。
- 每个 pending chunk 记录 `stateBefore` 与 `gapBefore`；异步顺序写盘（写入循环防止 0 进度死循环）。
- 队列上限 4 MiB（`backlogMaxChars`）：超过则**丢弃新数据**，置 `lost=true`、`gapPending=true`。
- 段轮转：当当前段达到 4 MiB 或出现 gap 时新建段，新段记录 `startState`。
- 驱逐：当段数 >16 或（总字符数 - 最老段）>=4 MiB 时删最老段，并把下一段标记 `afterGap=true`、`lost=true`。
- 关闭/退出/被 kill 时删除该 pty 的整个目录；应用退出时删除整个 run 目录；启动时清扫不是当前 run、且进程已死或超过 1h 的旧 run 目录。
- OSC/CSI 等控制序列保留在磁盘原文里，读取时由状态机剥离。

### 6.3 read-scrollback 结果形状

成功（zod `H`，Cbkn @4430）：

```
{ ok:true, text, totalLines, rangeStart, rangeEnd,
  matchCount?, shownMatches?, firstShownLine?,
  lost:boolean, truncated:boolean }
```

失败：`{ok:false,error,retryable?}`。

- `offsetLines`：跳过最新 N 行；`lines`：返回其前面的 M 行。范围是 1-based 闭区间。
- 返回文本从左侧裁剪到 100 KiB（`W=102400`），`truncated=true`。
- `lost=true` 表示有段被丢弃/队列溢出；结果里会插入 `[... earlier output not kept ...]`。
- grep：大小写不敏感子串；只搜索 `offsetLines` 之前的部分；最多显示**最近** 40 个命中（`G=40`），每处前后 2 行（`K=2`）；行格式 `行号:命中行` / `行号-上下文`；多组之间 `--`；`matchCount` 是总命中数，`shownMatches` 是展示数，`firstShownLine` 供继续分页。
- 读取前等待已接受字符全部落盘（`flushed(acceptedChars)`）；15s 超时返回 `retryable:true`。
- 若日志无该 pty -> `no scrollback log for this terminal`；非 retryable 错误会 dispose 日志。

### 6.4 渲染器的 tab/命令显示

- OSC 0/2 标题：xterm `onTitleChange`，清洗到 200 字符；若看起来像 `.exe` 路径则丢弃；用于 tab 标签的 `reported`。[已证实：cf718f694 @3387]
- OSC 133 A/C/D：渲染器自己再解析一遍（用于 tab 上的“正在运行什么”）；`cmdline_url` 解码后显示；500ms 防抖。[已证实]
- 命令结束事件从主进程 tracker 经 `onCommandFinished` 通知工作树刷新和 activity ledger；渲染器不依赖它显示输出。

### 6.5 `typeWhenShellReady` 的等待算法

常量（Cbkn @16499-17300）：默认超时 15s，flag 3014178965 开启时 60s；本地无标记 quiet 500ms、有标记 3000ms、SSH 1500ms；前台忙重试 2 次、每次 1500ms；键入确认 2000ms；中断等待 500ms；stop tab 等待 3000ms。

步骤：

1. 每个 pty 同一时刻只允许一个 typing（`shellPtyTyping`），否则 `in_use`。
2. 记录当前用户输入计数；若中途用户键入 -> `user_typed`。
3. 若 tracker 已 `promptSeen && !compromised` -> 立即 ready。
4. 否则挂 output tap，等待“安静窗口”；SSH 还要求 ready 后有过输出；超时 -> `starting`。
   若 shell 报告 prompt 但 nonce 文件未被消费（且不是 fish），不轻易判 ready。
5. `intoOpenTab` 时再跑 `reuseBlock`，不满足 -> `not_free`。
6. 前台状态：本地 `ps -o pgid= -o tpgid= -p <pid>`，`pgid!==tpgid` 即 busy；SSH 走远端 probe。busy -> `busy`；SSH 非 idle -> `unverified`。
7. SSH 还要求 `sharedShells.get(pty).remote.shell === vettedBy`，否则 `unverified`（防止“本地按 bash 校验、远端却是 zsh”）。
8. 写入：fish 用 bracketed paste `ESC[200~<cmd> ESC[201~\r`，其他 `<cmd>\r`；通过 `localShellPath()` 的 shell 类型决定。
9. 若有 prompt 报告：等待 `startedCount` 增加或用户键入或 marks 失效；校验 `currentCommand` 与键入行一致（允许截断）。不一致则发 `\x03`，返回 `interrupted`/`unfinished`；shell 已消失则 `typed`/`shell_gone`。

---

## 7. 渲染器与交互

### 7.1 xterm 版本与创建参数

- 终端核心打包在 `c788b5dbe-aTpk2pXo.js`，导出 `{Terminal}`。没有保留版本字符串；本地 `app/node_modules` 也没有 `@xterm`。从特性（`overviewRuler`、`synchronizedOutputMode`、`getSelectionPosition`、`onSelectionChange`、`windowOptions.pushTitle/popTitle`）判断为 **@xterm/xterm 5.5.x 或更新**。[推断；确切版本未知]
- 创建（c6bf @58968 `Gr`）：

```js
new Terminal({
  cursorStyle, cursorBlink,
  fontSize: 13,                 // 可被编辑器字体设置覆盖
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme,
  scrollback: 10000,            // 设置项 1000/5000/10000
  minimumContrastRatio: 3,
  allowProposedApi: true,
  windowOptions: { pushTitle: true, popTitle: true }
})
```

- `name`/TERM 由 PTY 侧设置；渲染器只负责显示。

### 7.2 addons

| addon | 实现 | 行为 |
|---|---|---|
| FitAddon | 内联类 `ze`（c6bf @1562） | `proposeDimensions()` 扣掉 padding、滚动条（overviewRuler 宽 14）、cell 尺寸；`fit()` 后 `terminal.resize`。 |
| WebglAddon | 动态 `import("./c7c73ad28-DGVd537-.js")` | 仅在已 fit、非 closed、host 连通时加载；context loss -> dispose 并回落 DOM；加载失败/不存在 -> DOM。 |
| SearchAddon | 内联类 `Nt`（c6bf @30910） | 首次查找时懒加载；`findNext/findPrevious`；查找时清 selection，避免干扰。 |
| Link provider | 自定义 `Cn`/`Sn`（c6bf @46630） | 只激活 http(s) 与受限文件路径；悬停显示 tooltip；打开走 `shell.openExternal`（只接受 http/https，`noopener,noreferrer`）。 |
| OSC 颜色保护 | `Nn`（c6bf @49749） | 注册 OSC 4/10/11/12/104/110/111/112，只放行纯查询形式，避免程序改写主题色。 |
| AccessibilityAddon | 未加载 | 仅设置 `textarea[aria-label="Terminal input"]`；核心 `screenReaderMode` 未开启。 |

### 7.3 resize 路径

1. `ResizeObserver` 监听终端 host；回调通过 `MessageChannel` 投递一次（`zt`，c6bf @40092），避免同一帧多次 fit。
2. `Vr` 调 `fitAddon.fit()`，得到 cols/rows；若 `ptyStarted` 且尺寸变化 -> `transport.resizeShellPty(ptyKey,cols,rows)`。
3. `Br` 只在 `ptyReady && cols/rows 与上次不同` 时发送；等待 host 期间的 resize 只记录，ready 后补发。
4. 重连/replay 时如果 snapshot 带了 `cols/rows`，先 `terminal.resize` 再 `write`，并在 write 回调里重新 fit。
5. 主进程 `resizeShellPty` 对 suspended shell 只更新记录；活 PTY 立即 `node-pty.resize`；replay ring 记录 resize 点。

### 7.4 输入路径与早期输入

- `terminal.onData` -> 如果是查询应答（`Kn`，<=64 字符，匹配 DA/CPR/OSC 颜色/kitty 序列）则不发；否则：
  - 未 ready 且本地且没有 pendingCommand：push 到 `typedEarly`，并触发“按键保持”提示；
  - 否则 `transport.writeShellPty`。
- 启动完成后 `zr(entry, force)` 用 `terminal.input(t)` 把 `typedEarly` 重新注入 `onData` 管线（因此仍走正常过滤/发送）；若等待 host 或需要 host 先写 `cd`（`hostWritesFirst`），则不冲刷。
- 主进程 `writeShellPty` 还会用 `at` 正则判断是否“真实输入”，过滤终端自动应答，避免在 SSH idle 时错误唤醒。
- 主进程对 suspended shell：真实输入 -> `wakeSuspendedShell`；非真实输入直接丢弃。

### 7.5 键盘/复制/粘贴/搜索/菜单

自定义 key handler（c6bf @59900）：

- 应用级动作：`toggleTerminal`、`reopenClosed`、`attachTerminalOutput`（Ctrl/Cmd+Shift+L）、`findInFile`（Ctrl/Cmd+F）、Ctrl+Tab、Claude 应用的 F11/Ctrl+Alt+Shift+O。
- 选择存在时，Cmd+C 或 Ctrl+Shift+C 复制并 `clearSelection`；Ctrl+Shift+V 走默认粘贴。
- 仅当终端程序开启 mouse tracking 且不是 Shift 时，右键才由终端消费；否则显示浏览器/应用默认菜单。
- 自定义菜单项：Attach selection as context、Copy、Paste、Select all、Clear terminal。
- Cmd/Option+左右移动：行首/行尾/词移动，由应用注入 escape 序列。
- Ctrl/Cmd+Up/Down：在命令之间滚动（依赖命令标记）。

选中行为：

- `copyOnSelect` 可开启；选择变化会在末端显示 “Attach as context” 浮层（Cmd+Shift+L）。
- 双击/三击、整缓冲选择有特殊处理；选择整屏时可一键附加。

搜索：

- 懒加载 SearchAddon；查找浮层输入框；next/previous；搜索时忽略终端 selection 变化回调（`Le.current` 防重入）。

IME / 焦点：

- 输入由 xterm 的隐藏 textarea 处理；未找到自定义 composition 逻辑。[未知/未见]
- `autoFocus`、`requestTabFocus`、`shellPty:focus` 事件驱动聚焦；面板隐藏时 `display:none`，恢复时重新 fit。
- 光标闪烁受 reduced-motion 设置控制；隐藏时用自定义 idle cursor 元素。

### 7.6 tab 与面板

- 每个会话维护 `tabs[]`，主 tab id `"0"`；`addTab/adoptTab/renameTab/reorderTab/closeTab/closeOthers`；tab 状态持久化（见 4.6）。
- 可见 pane 的终端实例缓存 Map 上限 16；超限按 LRU 驱逐，若 PTY 仍在跑则 `stopShellPty`。
- `ShellTerminalChunk` 用 `height:0` 的隐藏容器预热 `prewarm`/`inline_run` 终端；在 `requestIdleCallback` 后创建。
- 内联代码块运行（inline run）：
  - 目标是主 tab 或新 tab；支持“capture”模式：在无头终端里重放并切出命令输出。
  - 捕获缓冲 512 KiB；当 `pendingWriteBytes > 4 MiB` 时丢输出并插入 `[output dropped—terminal fell behind]`，恢复时插入截断提示。
  - 运行结果 `endedBy`: `done / unstarted / unready / uncapturable / interrupted ...`；非 capture 模式直接键入。

### 7.7 链接与外部打开

- xterm 自定义 link provider 识别 http(s) 和受限文件路径；URL 必须无用户名/密码、host 非空、避免 CJK 全角点等。
- `activate` 时若是文件路径，走会话文件解析；否则要求 http(s)/合法 URL，再调用应用 open external。
- 打开外部前可能弹出 “Open link? Host: ... href: ...” 提示；只允许 http/https 进入 `shell.openExternal`。

---

## 8. Bash 命令路径 vs 交互式 shell PTY

| 维度 | 交互终端 `startShellPty` | Bash 模式 `runBashCommand` |
|---|---|---|
| 可见性 | 用户可见 tab | 隐藏（80x24，`jt/Mt`） |
| PTY 池 | 16，per ptyKey | 16，per session |
| 磁盘 scrollback | 有（本地） | 无 |
| shell integration | 有，nonce 文件 | 有，headless 模式；PowerShell 额外用 marked hidden shell |
| 命令写入 | 用户键盘/逐字键入 | `command + "\r"`（PowerShell 有专用 keystrokes） |
| 输出获取 | 实时推给 xterm | 从 replay buffer 读取，按 OSC 133 标记切出命令输出，剥离 echo/prompt |
| 超时 | 无（长期） | 30s（`Ft=3e4`） |
| 输出上限 | 无（日志有上限） | 100 KiB，超出插 `[output truncated]` |
| 中断 | 用户 Ctrl-C | `\x03`，再探测前台；必要时 `SIGKILL` 整个 tpgid；仍卡则重启隐藏 shell |
| 串行化 | 多 tab 并行 | 每会话同一时刻一个命令（`runCommandInFlight`） |
| 退出/重置 | 关 tab/停 shell | shell 退出或被迫重启时返回错误，提示 cd/exports 丢失 |

`runCommand` 关键行为（Cbkn @77741）：

- 已有命令在跑 -> `A command is already running in this session`。
- 若上一条还“看似运行”则先尝试中断（PowerShell marked shell 有自己的 interruptLast），否则 Ctrl-C + 等待 prompt；3s 内不清 -> 重启 PTY（`cleared_by:"restart"`）。
- 若会话 cwd 已移动：检查该 PTY 是否还有自己的子进程；没有则重启，有则保留并标注“仍在新 shell 的旧目录，因为有进程在跑”。
- 启动时若 `bashPtyObservedIdle` 未置位，先等输出安静（`zt=2000`），再用 `ps` 判断前台；必要时发 SIGINT/SIGKILL。
- 输出归属 `attributeCommandMarks`：用 tracker 的 `startedCount`/`finishedAfter` 与命令行文本匹配（允许按 UTF-8 截断的近似比较）；成功则精确切出 outputStart..outputEnd，并把 promptSpans 剔除；失败则退化为原始 buffer 文本，去掉首行 echo 和尾部提示符。
- 结果附带 `foregroundActive` / `foregroundUninterruptible`（有前台进程且无法判断时），供上层提示用户。
- `interruptBashCommand`：Windows host 未 ready 时直接 stop；否则写 `\x03`。

---

## 9. 可借鉴到 AutoAgent 的设计

以下按 P0/P1/P2 分级。现有参考实现位于 `research/terminal-integration/`（Python/FastAPI + React），可作为落地骨架；本节指出 Claude 的做法中值得吸收与不应照搬的部分。

### P0（必须）

1. **PTY 隔离进程**：不要在 FastAPI/Uvicorn 进程里直接持有很多 `pty.openpty` 读循环。用一个独立进程/子服务（Python `multiprocessing` + `os.openpty`，或 node-pty sidecar）持有 PTY，主服务只做协议转发。为 worker 加：启动 ack、心跳/看门狗、崩溃后按需重启、指数退避、退出时清理进程树。Claude 的 40s watchdog + cooldown + refork 是可直接照抄的模式。
2. **显式 `session::tab` 键与生命周期状态机**：主 tab 用裸 session id、其余用 `::tab`；每个 tab 记录 `cwd/title/openedBy/userTyped/running`；start/reattach/stop/evict 各有明确返回码。不要把“sessionId”这个名字复用到 ptyKey 上（Claude 自身也因此容易误读）。
3. **有界磁盘 scrollback + 文本重建**：写入原始字节，读取时跨段重放 VT 状态机；段大小 4 MiB、最多 16 段、队列上限 4 MiB；`lost/truncated` 明确回传；nonce/secret 在写入前脱敏。AutoAgent 可用 `pyte` 做状态重放，或把重放放到 Node 小服务。
4. **OSC 133 + nonce 文件**：不要改写用户 dotfiles；生成 shim，通过 `ZDOTDIR`/`--init-file`/`-C` 注入；nonce 只落 0600 临时文件，脚本读完即删；解析 A/B/C/D，带 nonce 校验与泄漏检测。没有 nonce 的 marks 一律不可信。
5. **命令校验与审批**：单行 + 长度上限 + 可打印 ASCII；静态危险构造检查 + 用真实 shell 的 `-n` 在干净 env（`PATH=/usr/bin:/bin`, `LC_ALL=C`, cwd `/`）下二次校验；SSH 用远端 shell 校验并核对 shell 名；cwd 必须 realpath 后仍在允许目录内，并在批准后重新核对，防 TOCTOU。

### P1（强烈建议）

6. **256 KiB replay ring + 断线重连**：按 chunk 维护 VT start-state，记录 resize 点；重连返回 `{data,cols,rows,resizes}`；面板重挂载先 replay 再恢复实时数据。SSH 断线时保留 tab 元数据、标记 `lost/idle`，按键唤醒或自动重开。
7. **两套读取接口**：`read_screen(lines)` 用 replay + 无头终端（或 pyte）渲染出屏幕行；`read_history(offset_lines, lines, grep)` 用磁盘日志分页/搜索。返回 `rangeStart/rangeEnd/totalLines/matchCount/lost/truncated`，让调用方能正确提示“更早的输出没有保留”。
8. **tab 复用与配额**：区分 `openedBy=user|agent`，记录 `user_typed`；agent 只能复用自己开的、有 prompt marks、非运行、非 remote、命名匹配且不歧义的 tab；每会话上限（Claude 是 6 个 agent tab、16 个终端实例）；全局/每 host 上限与驱逐（先驱逐空闲、非运行、其他会话的）。
9. **输出合批与背压**：主进程按 ptyKey 16ms 合批；渲染器/内联捕获要有 `pendingWriteBytes` 上限（Claude 在 inline capture 用 4 MiB）和 `[output dropped]` 提示；协议里加 seq/字节计数，便于检测丢数据。不要像 Claude 的 live data 路径那样完全无 credit/ack。

### P2（体验增强）

10. **渲染器细节**：xterm.js + FitAddon + ResizeObserver（MessageChannel 合帧）；WebGL 可选并支持 context-loss 回落；SearchAddon 懒加载；自定义链接 provider 只放行 http/https；OSC 颜色保护；主题从编辑器配色映射；copy-on-select/搜索/附加选区到对话/右键菜单；Claude 的早期输入 `typedEarly` 和自动应答过滤值得照搬。
11. **内联运行/捕获**：代码块在终端中运行并精确切出输出，需要 OSC 133 + 命令文本匹配；捕获失败时明确返回 `uncapturable/unstarted/unready`，不要假装成功。
12. **平台特化隔离**：Windows 的 pwsh/gitbash fallback、WSL、SSH 共享 carrier 都应做成可选 adapter；Linux 产品不要照搬这些死代码。

### 不建议照搬

- **继承整个 `process.env` 给 agent 触发的终端**：Claude 面向“用户自己的 shell”这样做是合理的；AutoAgent 若让模型间接驱动命令，应使用允许列表，并至少剥离云凭据/代理凭据，除非产品明确需要。
- **无 nonce 的 OSC 解析**、**把 nonce 放进环境变量**、**把命令拼进 shell 字符串**：都容易伪造/注入。
- **无限日志**、**无上限的 live 推送**、**无 `lost` 标志的截断**。
- **允许 agent 复用用户 tab**：Claude 有 `openedBy`/`userTyped` 双重保护；缺少这两个字段就会出现“AI 在用户正在输入的命令里打字”的事故。
- **把“磁盘历史”当成“屏幕内容”**：两者行数/内容会不同（重绘、alt screen、prompt 重排）。

---

## 10. 证据索引

偏移为字符下标；“@”后数字均为该文件 UTF-8 解码字符串中的位置。

| # | 文件（绝对路径） | 偏移 / 符号 | 内容 |
|---|---|---|---|
| 1 | `/home/tars/yysapp/claude-desktop/app/.vite/build/pty-host/ptyHostWorker.js` | @1253 `A={GROUND...}`；@2907 `L=class`；@2230 `N`；@2332 `P` | VT 状态机、secret 脱敏、纯文本重建 |
| 2 | 同上 | @3347 `z=class`；@3676 `B=4194304`；@3701 `U=262144`；@3710 `W=102400`；@3719 `G=40`；@3724 `K=2`；@3728 占位文本；@8559 `Z=65536` | 行拆分、4 MiB 段/backlog、100 KiB 窗口、grep 40/2、64 KiB 输入 replay |
| 3 | 同上 | @3935 `X=class`；@4393 `append`；@7627 `windowResult`；@7875 `grepResult` | 分段写入/轮转/驱逐、读取结果形状 |
| 4 | 同上 | @8658 `handle`；@8683 `spawn`；@8977 `read-scrollback`；@9321 `write`；@9517 `resize`；@9594 `dispose-scrollback`；@9651 `kill`；@9861 `shutdown`；@10548 `swapToFallback`；@11479 `process.parentPort` | pty-host 协议全表 |
| 5 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-CbknQPGf.js` | @6288 `de=new class`；@6815 `forkWorker`；@8681 `handleWorkerMessage` | utilityProcess、MessageChannel、watchdog/cooldown、worker 崩溃处理 |
| 6 | 同上 | @14619 `CLAUDE_DESKTOP_TERMINAL_SHELL`；@15034 `Ue`；@16499 `G=3e4`；@16516 `K="::"`；@16523 `Ge`；@16927 `qe="c"`；@17107 `Xe`；@17231 `at=`；@17410 `Z=262144`；@17419 `ot=16`；@17484 `lt`；@18031 `mt=class`；@20563 `At=16` | shell 解析、SSH 命令、key/原因枚举、replay ring、16ms、16 上限 |
| 7 | 同上 | @22665 `flushAllPtyEmits`；@23690 `queuePtyEmit`；@24984 `sweepStaleScrollbackLogs`；@25339 `scrollbackLogDirForSpawn`；@25725 `shellIntegrationForSpawn`；@25874 `writeShellIntegrationDir`；@27066 `expireNonceFile` | 事件合批、日志目录、integration/nonce 生命周期 |
| 8 | 同上 | @27923 `readShellScrollback`；@35219 `spawnSshShell`；@36257 `startShellPty`；@36950 `reopenSuspendedShell`；@38294 `waitForKeystroke`；@42513 `noteSessionRefusal`；@45077 `suspendShell`；@45758 `shellPtyEvictionVictim`；@45891 `stopShellPtyKey` | 主状态机、SSH 挂起/重连、驱逐 |
| 9 | 同上 | @58000 `writeShellPty`；@60020 `typeWhenShellReady`；@60310 `typeIntoShell`；@61818 `shellPtyForegroundState`；@63862 `probeForegroundProcessGroup`；@63991 `readScreenLines`；@64021 `screenSnapshot`；@64551 `reuseBlock`；@65483 `claudeTabReuse`；@66100 `stopClaudeTab`；@67036 `announceTab`；@67435 `nextClaudeTabId` | 输入、等待/校验、前台探测、读取、Claude tab |
| 10 | 同上 | @70002 `startBashPty`；@77437 `interruptBashCommand`；@77741 `runCommand`；@83000 尾部导出 | Bash 模式 PTY、输出切分、SIGINT/SIGKILL/重启 |
| 11 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-DL8FV-hF.js` | @609 OSC 697；@1186 `f`；@1935 `p`；@2976 `y`；@3274 `b`；@4005 scanner；@4710 tracker；@6602 `checkNonceExposure`；@6853 `distrust` | ShellReady/ShellFailed、OSC 133 解析、nonce 泄漏检测 |
| 12 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` | @956921 `fZe`；@2629488 `Xon`；@2629314 `qon`；@5225250 `KHi`；@3789201 `Pvr`；@4142000-4163100 integration 字符串；@4162112 `GHr`；@4163092 `JHr`；@4161585 `VHr`；@4161873 `UHr` | shell 解析、cooldown、utility 路径/服务名、WSL、shim 与 argv 改写 |
| 13 | 同上 | @4165924 `rUr`；@4167444 `iUr`；@4168021 `oUr`；@4174177 `BUr`；@4175568 `VUr`；@4175712 `HUr`；@4169000 工具名常量 | 命令静态检查、真实 shell `-n`、SSH 检查、工具名 |
| 14 | 同上 | @4337419 `F1r`；@4340854 `t0r`；@4341847 `a0r`；@927277 `lJ` | terminal env 直接取 process.env；code session 的 PATH 修复（对照） |
| 15 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-B4uTve_e.js` | @61989 `startShellPty`；@62043 `runBashCommand`；@62713 邻域 | LocalSessions IPC 注册与转发 |
| 16 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-BvLvPLAH.js` | @1041324 `resolveTerminalDirectory`；@1469802 `new Be.ShellPtyManager`；@1471464 `terminal-scrollback`；@1471518 `shellIntegration`；@155749 `"run_in_terminal"`；@2025949 `checkTerminalCommandFor`；@2088533 `runBashCommand` | 依赖注入、cwd、命令校验、Bash 结果映射 |
| 17 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-hWiNbYHV.js` | @790 `a=256`；@14674 `P`；@15008 `F`；@16648 `re`；@22109 `oe`；@22458 `se`；@25010 `ce`；@26468 `le`；@28740 `me`；@30459 `handleToolCall`；@32556 `isEnabled` | MCP 终端工具定义、read/grep 文案、审批/复用、工具开关 |
| 18 | `/home/tars/yysapp/claude-desktop/app/.vite/build/mainView.js` | @120987 `startShellPty`；@121047 IPC 名；@121635 `runBashCommand`；@138890 `onOnEvent` | contextBridge API 与事件通道 |
| 19 | `/home/tars/yysapp/claude-desktop/app/.vite/build/heavy-work-worker/heavyWorkWorker.js` | @670853 `BM` | 无头 xterm 重放 replay -> 屏幕行，scrollback 10000、输出上限 262144 |
| 20 | `/home/tars/yysapp/claude-desktop/extracted/.../ion-dist/assets/v1/c6bf19e8f-oq2b1_8O.js` | @951 import Terminal；@1562 FitAddon；@30910 SearchAddon；@40092 `zt`；@50767 `Kn`；@58968 `Gr`；@59251 Terminal 创建；@62051 `onData`；@57530 `typedEarly`；@57589 `zr`；@57920 `Vr`；@58237 `Hr`；@53695 `yr`；@46630 link provider；@55392 `Sr` | 渲染器终端、addon、输入/早期缓冲/resize/事件/replay |
| 21 | 同上 | @54700-55100 Webgl 动态加载；@55600-57200 键盘处理；@64000-71000 选择/搜索/菜单/面板 | WebGL 回落、快捷键、复制/搜索/右键 |
| 22 | `.../assets/v1/c03935b01-CyJKQj4N.js` | @1811 `Dt`；@2012 local transport；@3160 `Mt`；@3374 `Nt`；@3525 `Pt`；@3808 WS `startShellPty`；@4401 `opened`；@4532 `data`；@4618 `exit`；@4661 `error`；@10843 persist key | 本地 transport、远端 WS、tab store 持久化 |
| 23 | `.../assets/v1/cf718f694-jeQhHLuv.js` | @1201 设置读取；@3387 `be`；@3737 主题映射；@4595 dark/light 回退；@5357 `Te` | 光标/scrollback 设置、OSC 133 渲染器侧、主题 |
| 24 | `.../assets/v1/cccc2cf0a-B0D--VZp.js` | @44900-46600 | `pane_open/new_tab`、隐藏 `prewarm/inline_run`、右键菜单 |
| 25 | `.../assets/v1/cc0051c10-pi8fKHOz.js` | @~3000 `S` adopt、@~3600 tab 事件分派 | `shell_pty_tab_opened/closed` 的 adopt/close |
| 26 | `.../assets/v1/ce401cf8e-CQ0qo2sB.js` | @5341 `shell_pty_tab_opened`；@5431 `shell_pty_tab_closed` | 会话事件总线分派 |
| 27 | `/home/tars/yysapp/claude-desktop/asset/ida_pty/survey.json` | `pty.node` metadata / exports | node-pty 原生模块（`PtyOpen/PtyResize/PtyGetProc`）证据 |
| 28 | `app/node_modules/node-pty/package.json` | version | node-pty `1.2.0-beta.14` |
| 29 | `/home/tars/yysapp/claude-desktop/asset/ipc_services.json` | `LocalSessions` | 终端相关 IPC 方法集合 |
| 30 | `/home/tars/yysapp/claude-desktop/asset/pty_calls.json` | IDA 调用记录 | `pty.node` 调查步骤 |

---

## 11. 置信度与未知

### 已证实

- 三层进程模型、MessagePort 协议、pty-host 消息类型、watchdog/cooldown/refork。
- `sessionId::tabId` 键、主 tab `"0"`、Claude tab `cN`、spawn 原因枚举、16/16/6 上限、驱逐策略。
- 本地 shell 解析顺序、`$SHELL -l`、integration shim 的四种注入方式、nonce 文件格式/TTL/删除、OSC 697 与 OSC 133 解析。
- env 构造（含 `TERM_PROGRAM_VERSION: undefined`）、SSH 独立 carrier 的精确 argv、WSL 命令、cwd 校验与审批门控。
- scrollback 的 4 MiB 段、16 段、4 MiB 队列、100 KiB 读取窗口、grep 40/2、`lost/truncated`、redaction。
- replay ring 256 KiB、resize 记录、无头 xterm 屏幕重放。
- 渲染器 xterm 创建参数、内联 Fit/Search addon、WebGL 动态加载/回落、主题映射、早期输入、查询应答过滤。
- Bash 模式 PTY 与可见终端的差异、输出切分、30s/100 KiB/SIGKILL/重启。
- `run_in_terminal` 的单行/ASCII/2000 字节/静态检查/shell `-n`/vettedBy/复用规则。

### 推断

- 独立 utility process 的主要动机是隔离原生崩溃/阻塞和卸载磁盘 IO（无注释）。
- xterm 版本为 5.5.x 或更新（依据特性，无版本字符串）。
- 共享 SSH carrier 的内部 plan/port 复用细节（只看到对外行为：9 通道预算、对端拒绝、carrier local-pty/pipes）。
- OSC nonce 的威胁模型是防止程序伪造命令边界/退出码；代码只实现了检测，没有解释。
- 本地 PTY 继承全部环境变量是面向“用户自己的 shell”的有意设计，而非疏漏。

### 未知 / 未找到

- xterm 的精确版本号。
- 是否存在显式 IME composition 处理（未找到；依赖 xterm 默认 textarea 行为）。
- 是否处理 OSC 7（cwd 动态同步）：未找到 handler；tab 的 cwd 看起来是 spawn 时快照，未见随命令更新。
- AccessibilityAddon / `screenReaderMode` 的启用路径：只找到 aria-label，没有 addon 加载。
- 共享 SSH 引擎（`O.s(sshConfig)`）的完整实现与所属 chunk；本文只覆盖其调用契约。
- `judgeSshDial` 的策略来源与管理配置细节。
- macOS/Windows 专属 fallback 路径的完整触发条件（本 Linux build 中大量分支不可达）。
- pty-host 的 node-pty 版本与 native 构建细节（package.json 证据在手，但未反编译 `pty.node` 内部实现）。

---

## 12. 交接清单（10 条）

1. 终端实现的主入口是 `app/.vite/build/index.chunk-CbknQPGf.js` 的 `ShellPtyManager`（@36257）和 `pty-host/ptyHostWorker.js`；先读这两个文件即可掌握 80% 行为。
2. PTY 协议是 MessagePort 对象，不是字节流；`spawn/spawned/data/exit/write/resize/kill/read-scrollback/scrollback-read/shutdown` 是完整消息集（见 3.1）。
3. 所有事件里的 `sessionId` 在 `shell_pty_data/close/link` 上实际是 `ptyKey`；`shell_pty_tab_*` 才使用基础 session id。这是最容易实现错的点。
4. 磁盘 scrollback 与 replay ring 是两套：前者纯文本、用于 MCP 分页/grep；后者 256 KiB 原始 VT、用于面板/SSH 重连和无头屏幕重放。
5. shell integration 的 nonce 只放 0600 文件、脚本读完即删；OSC 133 必须带 nonce 才可信，泄漏即 `compromised`，tab 复用和自动键入随之关闭。
6. 本地 shell 是 `$SHELL -l`；zsh 用 ZDOTDIR、bash 用 `--init-file`、fish 用 `-C`、pwsh 用 `-NoProfile -NoExit -Command`；不要直接改用户 dotfiles。
7. 命令输入有三道门：单行可打印 ASCII + 长度上限；静态危险构造 + 真实 shell `-n`；等待 shell idle 且远端 shell 与 `vettedBy` 一致后才逐字键入。
8. SSH 有 shared 与 separate 两种 carrier；shared 预算 9 通道，对端拒绝会永久切到 separate；断链会挂起 tab 并保留 replay，按键/重连可恢复。
9. Bash 工具走隐藏 80x24 bash-mode PTY，与用户终端隔离；30s 超时、100 KiB 输出、SIGINT/SIGKILL/整壳重启，无磁盘日志。
10. 给 AutoAgent 的最小可行组合：独立 PTY 进程 + `session::tab` 状态机 + OSC 133 nonce + 有界磁盘日志 + 256 KiB replay + 严格命令审批/目录包含；渲染层用 xterm.js + FitAddon + ResizeObserver，WebGL/Search/链接/主题都是 P2 增强。`research/terminal-integration/` 已有 Python/FastAPI + React 骨架可对照。
