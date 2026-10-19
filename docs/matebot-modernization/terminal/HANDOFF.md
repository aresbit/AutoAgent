# Terminal 特性交接（来自 Claude Desktop 逆向）

> 目标：在 AutoAgent 中集成 Claude Desktop 风格的 integrated terminal。
> 本目录是**只读研究 + 参考实现**，没有修改任何 AutoAgent 源码。
> 实现时请遵循 `docs/matebot-modernization/architecture.md` / `api-contract-v1.md` 的深接口与安全约定。

## 文件

- `ANALYSIS.md` — Claude Desktop 2.42304.0 terminal 的端到端逆向（64 KB，file+offset 证据）
- `reference/README.md` — 参考架构、线协议、安全、集成映射、验收
- `reference/PATCH_PLAN.md` — AutoAgent 文件级 T0/T1/T2 计划、验证命令、回滚
- `reference/backend/terminal_manager.py` — stdlib PTY 管理器（无 FastAPI/Pydantic）
- `reference/backend/terminal_router.py` — FastAPI REST + WebSocket 路由
- `reference/backend/test_terminal_manager.py` — 17 个 pytest（全通过）
- `reference/frontend/TerminalPane.tsx` — React 19 + xterm.js
- `reference/frontend/terminalClient.ts` — typed WebSocket 客户端
- `reference/frontend/useTerminalTabs.ts` — tab 状态与对账

## 先做 T0（MVP）

### 后端

1. 新增 `backend/src/autoagent_backend/adapters/terminal/manager.py`（复制参考实现）。
2. 新增 `backend/src/autoagent_backend/api/routes/terminals.py`（复制参考实现）。
3. `composition.py`：`Container` 增 `terminal_manager`，注册 shutdown closer。
4. `app.py`：`include_router(terminals.router)`，放在 static catch-all 之前。
5. `api/static.py`：CSP `connect-src` 增 `ws://127.0.0.1:*`。
6. `api/routes/sessions.py`：删除 session 时 `await terminal_manager.destroy_owner(session_id)`。
7. 测试：`tests/unit/test_terminal_manager.py`、`tests/integration/test_terminal_ws.py`。

### 前端

1. `package.json` 增 `@xterm/xterm ^5.5.0`、`@xterm/addon-fit ^0.10.0`。
2. 新增 `frontend/src/features/terminal/{TerminalPane.tsx,terminalClient.ts,useTerminalTabs.ts,TerminalPanel.tsx}`。
3. `api/client.ts` 暴露 launch token / `ensureSessionCookie()`；WS 优先 HttpOnly cookie。
4. `app/Shell.tsx` 增 terminal tab（T0 右侧面板；T1 底部 dock/split）。
5. 可选：`styles/index.css` 引入 `@xterm/xterm/css/xterm.css`。

## 线协议（参考实现）

- WS：`/api/sessions/{sessionId}/terminals/{tabId}/ws`
- 客户端帧：`init {cols,rows,replay}`（必须第一帧）、`input {data}`、`resize {cols,rows}`、`close`、`ping`
- 服务端帧：`ready {tabId,sessionId,shell,cwd,cols,rows,state,exitCode,replayBytes,seq}`、`data {data,replay?,seq}`、`exit {code,signal,seq}`、`error {code,message}`、`pong`
- close codes：4400 bad frame / 4401 auth / 4403 origin / 4404 not found / 4409 already attached / 4429 rate limit
- 文本用 UTF-8 增量解码；**不要 base64**（终端是文本）。

## 关键设计点

- 每个 session/tab 独立 PTY；不要共享全局 shell。
- `os.openpty()` + `fork` + `setsid` + `TIOCSCTTY` + `execvpe`；`TIOCSWINSZ` resize；`killpg` 结束进程组；PDEATHSIG 防孤儿。
- shell 白名单：`$SHELL`、`/bin/bash`、`/bin/zsh`、`/bin/sh`；argv 列表，绝不 `shell=True`，绝不做字符串插值。
- cwd 必须在批准的工作区内（调用方注入 `is_cwd_allowed`）。
- env 只保留最小集合（PATH/HOME/TERM/COLORTERM/LANG/LC_ALL），丢弃 secrets/LD_PRELOAD。
- 有界输出队列 + ring buffer（1 MiB）用于重连 replay；v1 不写磁盘日志。
- WS 只监听 loopback；Origin + launch token/cookie 校验；单 tab 单 attach；输入限流。
- 终端内执行的命令仍应经过 AutoAgent 现有的权限/审批链路；不要因为终端是“用户自己开的”就绕过。

## v1 明确不做（P1/P2）

- 独立 utility process（FastAPI 可直接管 PTY）
- 分段磁盘日志/grep、40s watchdog、SSH/WSL、OSC 133 shell integration
- WebGL/Search addon
- 把 token 放 WS query 作为主鉴权路径

## 验收

1. 创建 tab → WS init → 看到 shell prompt。
2. 输入 `printf hello` 回显正确；resize 生效。
3. `exit` 后收到 `exit` 帧并显示 code。
4. 重连收到 replay 且不重复输出。
5. 非白名单 shell / 越界 cwd / 错误 Origin / 缺 token 被拒绝。
6. 删除 session 时终端被杀；后端退出无孤儿进程。

参考实现状态：`py_compile` OK、`pytest` 17 passed (1.41s)、`ruff` clean；TS 在临时 stub 下 `tsc --noEmit` exit 0，加入真实 `@xterm` 包后需重跑。另用一个镜像 AutoAgent import 布局的 scratch FastAPI 跑通了 create → WS init → input → exit → reconnect replay → delete，以及缺 token / 错误 Origin 拒绝，连续 3 次通过。

## 架构风险（实现时优先确认）

- **多线程 uvicorn 中的 `fork()`**：这是本方案最大的架构风险。理想顺序是在 uvicorn 启动线程之前初始化 PTY 管理器；如果无法保证，T1 应切换到 subprocess 方案（父进程只做 PTY master 读写，子进程 `setsid` + `execvpe`；或使用 `ptyprocess`/`script` 包装）。参考实现已保留 subprocess fallback 路径，先按 T0 验证行为再决定。
- **cookie vs query WS 鉴权**：参考实现两者都支持，但产品上应选 `POST /api/auth/session` + HttpOnly cookie；query token 只用于测试/早期集成，并确保访问日志不记录 query。
- **`connect-src 'self'`** 可能已覆盖同源 `ws://`，但 Electron 打包环境建议显式加 `ws://127.0.0.1:*` 并在打包后验证握手。
