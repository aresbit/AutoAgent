# Browser / Preview 特性交接（来自 Claude Desktop 逆向）

> 目标：在 AutoAgent 中集成 Claude Desktop 风格的浏览器/预览面板。
> **状态（2026-10-19）：T0 已实现并合入。** `PreviewManager`/IPC/协议位于
> `desktop/src/native/preview-*.ts`，preload 暴露 `window.autoagentPreview`，
> 前端位于 `frontend/src/features/preview/`，`Shell` 增加 Preview tab。
> 默认拒绝：空 origin 白名单 + 可选 `AUTOAGENT_PREVIEW_ROOT`；本目录保留为来源证据。
> 实现遵循 `docs/matebot-modernization/architecture.md`：主进程持有 OS 能力与策略，SPA 只拿 typed DTO，禁止通用 IPC。

## 文件

- `ANALYSIS.md` — Claude Desktop 浏览器/预览端到端逆向（64 KB，file+offset 证据）
- `reference/README.md` — 架构、`WebContentsView` vs iframe、T0/T1/T2、安全模型、集成映射、验收
- `reference/PATCH_PLAN.md` — AutoAgent 文件级 T0/T1/T2 计划、CSP、回滚
- `reference/desktop/preview-manager.ts` — Electron 主进程 `WebContentsView` 管理器
- `reference/desktop/preview-ipc.ts` — sender/payload 校验的 IPC
- `reference/desktop/preview-contract.ts` — 固定通道/限额/类型
- `reference/desktop/preview-protocol.ts` — `autoagent-preview://` 自定义协议
- `reference/preload/preview-api.ts` — 只暴露 `window.autoagentPreview`
- `reference/frontend/PreviewPane.tsx` — React 19 标签页/工具栏/截图/日志
- `reference/frontend/previewClient.ts` — typed 客户端与事件校验

## Claude Desktop 的关键结论

- **预览模型**：每个 serverId 一个 `PreviewContext`，内部 `containerView` + `tabs: Map<tabId, WebContentsView>`；renderer 上报 bounds，主进程 `setBounds` + `setVisible(active)`；支持 show/hide/popout/attach/detach。
- **导航守卫**：main-frame guard + 决策表；Allowed-sites/session grant + 用户手势 + 私有网络/DNS rebinding 检查 + 凭据剥离 + 外部站点 handoff。
- **本地内容**：`loadHtmlPreview` 对 worktree 做包含校验、`O_NOFOLLOW`、UNC/symlink 防护；文本上限 2,097,024，content tab 源文件 524,288；`loadHtmlPreviewContent` 用 data: + CSP。
- **权限**：默认拒绝；clipboard 有例外；media 拒绝；WebAuthn 取消；live stream 需显式 arm。
- **模型工具**：CDP 工具集 + `callRemoteBrowserTool`，有 guard/timeout/银行站点扣留；截图/读页面结果前做 epoch 校验。
- **Chrome 扩展/native host**：扩展 ID、manifest、socket 路径、4-byte framing；Linux 上安装/重启 Chrome 不支持。
- **`$BROWSER` 桥**：每 session 32-byte key、0600 socket、超时与回退；`claude-browser-shim.js`。
- **Framebuffer**：独立 IPC + canvas worker + 帧 seq + 输入事件；底层推断为 VNC/RFB（`@ant/rfb-client`、`vncUrl`、`serverFlavor`），执行体未定位。
- 下载：只看到 `will-download` telemetry 与隐藏 tab 关闭，**没有自定义 containment**——这一点不要照搬。

## AutoAgent 参考实现（T0）

- **架构**：React `PreviewPane` ↔ preload `window.autoagentPreview` ↔ 主进程 `PreviewManager` ↔ 每 tab 一个 `WebContentsView`。
- **为什么不用 iframe**：真实站点需要独立进程/独立 partition/cookie、导航守卫、权限、截图、console、下载、历史；这些 iframe 做不到或不可靠。
- **保留 iframe 的场景**：自包含 HTML artifact（现有 `ArtifactFrame` 的 `sandbox="allow-scripts allow-forms"` + CSP + `srcDoc` 继续用）。
- **安全**：
  - `session.fromPartition('persist:autoagent-preview')`；
  - 目标内容无 preload、无 Node、`sandbox/contextIsolation`、`nodeIntegration=false`；
  - 权限/下载默认拒绝；`will-navigate`/`will-redirect`/`setWindowOpenHandler`/`will-attach-webview` 全守卫；
  - 仅允许 `https:` 白名单 origin 或 `autoagent-preview://` 本地 root；拒绝 `file:`、`javascript:`、凭据 URL、encoded dot/separator；
  - bounds 夹取、URL/body/log 限额、sender = 主窗口主 frame + app origin；
  - 自定义协议做 `realpath` containment、MIME 白名单、64 MiB 上限、HTML/SVG CSP。
- **UI**：tab strip、前进/后退/刷新、地址栏（含 IME guard）、加载/错误/崩溃状态、截图条、外部打开、console drawer、ResizeObserver bounds、活动 tab focus。

## T0 集成（详见 reference/PATCH_PLAN.md）

桌面：
1. 新增 `desktop/src/native/{preview-contract.ts,preview-manager.ts,preview-ipc.ts,preview-protocol.ts}`。
2. 新增 `desktop/src/preview-api.ts`（preload）。
3. `desktop/src/main.ts`：`app.whenReady()` 后创建 `PreviewManager`，注册协议与 IPC，`before-quit` 释放。
4. `desktop/src/preload.ts`：只暴露 `window.autoagentPreview`。

前端：
1. 新增 `frontend/src/features/preview/{previewClient.ts,PreviewPane.tsx,PreviewPanel.tsx}`。
2. `app/Shell.tsx` 增 Preview tab。
3. T0 默认 allowlist 为空；通过 `AUTOAGENT_PREVIEW_ORIGINS` 传入；UI 用 `VITE_PREVIEW=1` 开关。
4. T1：后端 settings 提供 allowlist 来源；下载策略、popout、PDF、clear data。

验收：
1. 打开允许的 https 页面；前进/后退/刷新；关闭清理 view。
2. 非白名单 origin、`javascript:`/`file:`、凭据 URL 被拒绝。
3. 目标页面无法访问 AutoAgent preload/launch token/SPA origin。
4. 权限请求与下载默认拒绝；外部链接走显式打开。
5. 截图/console 可用；bounds 随 ResizeObserver 正确更新。
6. 关闭窗口/退出应用无残留 WebContentsView。

## 已验证

`tsc --noEmit`（Electron 41.3.0 / React 19 / Node 类型）exit 0，7 个代码文件均被检查；协议 smoke：有效解析、`file://`/`a%2fb`/`%2e%2e` 拒绝、HTML 200+CSP、CSS 200、404、symlink 403；策略 smoke：允许 https/preview，拒绝 `http:`/`javascript:`/`file:`/非白名单/凭据/encoded-dot，文件名清洗正确。

## 风险 / 未验证

- 没有真实 Electron 运行时测试；Wayland/HiDPI/面板过渡下的 bounds/focus 需手工验收。
- typecheck 使用 `skipLibCheck: true` 和 research 目录内的本地类型链接；合并后需在 AutoAgent 真实 tsconfig 下重跑。
- 不实现 Chrome native host、扩展/登录导入、framebuffer/VNC、远程浏览器/CDP、live stream；这些是 T2。
- 不要把下载直接落到最终文件名；如需下载，先写临时文件再 rename，并做路径 containment。
