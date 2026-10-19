# Claude Desktop 2.42304.0 Linux 浏览器 / 预览系统端到端逆向

研究对象：`/home/tars/yysapp/claude-desktop/app`（解包后的 app.asar，主进程与 preload，压缩单行 JS）。
辅助对象：
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist`（渲染器 SPA、artifact/frame 壳）
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/chrome-native-host`（Rust/tokio 原生消息宿主）
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/claude-browser-shim.js`
- `/home/tars/yysapp/claude-desktop/asset/ipc_services.json`、`asset/rea_application_graph.json`、`asset/ida_native/`

偏移约定：文中 `@12345` 一律是“UTF-8 解码后的字符下标”，不是行号（bundle 基本是单行）。二进制用 `strings` 的字节偏移。所有结论都给出直接代码/字符串证据；无法从本 build 证明的写 `[未知]`。

---

## 1. 结论速览

1. **预览不是 iframe，也不是 BrowserWindow，而是 Electron `WebContentsView` 的原生覆盖层。** 每个预览上下文（通常一个 dev server 或一个 session pane）持有一个 `containerView: View`，每个 tab 是一个独立 `WebContentsView`；tab 被加进上下文容器，容器再被 attach 到主窗口或 popout 窗口的 `contentView`。同一时刻只显示 active tab（`setVisible(e===activeTabId)`）。[已证实] @4747565、@4757102、@4815487、@4795653
2. **坐标/布局由渲染器主导。** 渲染器通过 `Launch.showPreview(serverId, bounds, claimantId?, targetWindowId?)` 传入 `{x,y,width,height,radius?,parked?}`，主进程据此 `setBounds`/`setBorderRadius`，并处理窗口缩放因子、popout、artifact 全屏、被遮挡时 `rendererParked`。[已证实] @1932736、@4815487、@4859593
3. **导航有两个完全不同的信任等级。** 用户/页面发起的普通浏览基本放行（仍受私有网络、外部专用站、凭据、隐藏文件文档等限制）；**模型发起的导航（mcp-tool）必须过 Allowed-sites / session grant / 私有网络卡片 / 组织策略**，并做提交前后 epoch 校验。[已证实] @3162698、@4917178、@5457376、@3137358
4. **本地 HTML 有两条路径：** `file:` 直接渲染（严格做 worktree 包含、`O_NOFOLLOW`、UNC/符号链接拒绝、原始文档扩展名限制）；或读入内容后用 `data:` URL 注入**极严 CSP**（`default-src 'none'; script-src 'none'; ... connect-src 'none'`）渲染。文本/内容上限 2,097,024 字符；交互式内容 tab 源文件上限 524,288 字节。[已证实] @4839346、@4844978、@5517239、@4855964
5. **每个上下文独立 session partition。** 命名规则为 `persist:launch-preview-<cwdHash12>`、`persist:launch-preview-session-<sessionId>`、`persist:launch-preview-static`、`persist:launch-preview-cowork-shared`；由设置 `launchPreviewStorage`（`none|shared|session`）决定持久化粒度。Claude page 预览是唯一使用 `session.defaultSession` 的预览。[已证实] @3092701、@4725096、@4726059、@4757470
6. **Browser 工具是 in-app CDP，不是 Playwright。** `preview_*`、`read_page`、`computer`、`form_input`、`navigate`、`find`、`get_page_text`、`javascript_tool`、`read_console_messages`、`read_network_requests`、`resize_window`、`tabs_*`、`browser_batch` 全部作用于宿主进程里的 `WebContentsView`，通过 CDP 快照 / 元素引用 / 输入注入 / 网络缓冲实现。`playwright-core` 只是 devDependency，运行时没有找到自动化调用。[已证实] BTGRIMpO、Bb_jZsw8；@5508386、@5509767
7. **Chrome 扩展是独立体系。** 扩展从 Chrome Web Store 安装，不在 deb 内；`chrome-native-host` 是 Rust/tokio 的 native messaging 宿主，同时在本机 `/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock` 监听 Unix socket，App 通过 4 字节小端长度前缀 + JSON 帧通信。Linux 上 `installExtension`/`restartChrome` 明确不支持。[已证实] @5158803、@5160349、@5160480、@3920797、二进制字符串
8. **另有 Code session 的 `$BROWSER` 桥。** App 为每个终端会话生成 32 字节 key 与 0600 Unix socket，注入 `BROWSER=<shim>`、`CLAUDE_BROWSER_BRIDGE={"socket","key"}`；shim 把 http(s) URL 发给 App，App 可回 `pane` 让预览面板打开，否则 shim 用 `xdg-open`。[已证实] DldNzPRj、`claude-browser-shim.js`
9. **FramebufferPreview 是独立的 VNC/RFB 类远程屏幕面板。** 它不创建 `WebContentsView`，而是把帧通过 `MessagePort` 送到渲染器，`OffscreenCanvas` worker 解码绘制；输入通过 `sendPointer/sendKey/sendScroll` 回传。模型侧有 `framebuffer_*` 工具，但要求面板已 attach、用户未接管、先截图、像素未变。其 VNC 会话执行体在本 Linux build 未定位到，只有 IPC/渲染/工具层。[部分已证实，执行体未知]
10. **安全模型总体是“浏览器级隔离 + 模型工具级二次授权”。** sandbox/contextIsolation 开、nodeIntegration 关、权限默认拒绝、私有网络 DNS rebinding 防护、凭据剥离、外部协议只允许 http(s)、PDF 强制下载、下载/网页内容不可信、组织策略可关闭外部浏览。主要薄弱/未知点：blocklist 网络失败时 fail-open；浏览器下载路径没有看到自定义 containment；framebuffer 执行体未知。[综合]

---

## 2. 架构 / 数据流图

### 2.1 预览面板（Browser / Artifact pane）

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Renderer: ion-dist SPA (main BrowserWindow)                             │
│  Preview pane UI (cf580efe9)                                            │
│   tabs strip │ address bar │ back/fwd/reload │ select element │ annotate │
│   server picker │ viewport/color scheme │ allowed sites │ import Chrome  │
│        │  window.claude.web.Launch.* / onPreviewTabsChanged ...          │
│        │  showPreview(serverId, {x,y,w,h,radius,parked}, claimant, win)  │
└────────┼────────────────────────────────────────────────────────────────┘
         │ preload generated IPC bridge (mainView.js)
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Main process: Launch service implementation                            │
│  Map<serverId, PreviewContext>  ($ = new Map, @483~)                   │
│   PreviewContext:                                                       │
│     containerView: View          ← 一个上下文一个原生容器               │
│     tabs: Map<tabId, Tab>        ← tab = WebContentsView + gate + CDP   │
│     activeTabId                  ← 默认 seed                           │
│     mountGroup (azr)             ← attach/detach/raise/popout/bounds    │
│     previewSession               ← 每上下文独立 partition               │
│     isVisible / rendererParked / artifactFullscreen / claimantId         │
│        │                                                                │
│        ├── Tab: WebContentsView (sandbox, contextIsolation, no node)    │
│        │     cdpTools ($si) → DevTools Protocol: snapshot, inspect,     │
│        │     screenshot, viewport, color scheme, input, network logs    │
│        │     gate: user gesture / nav epochs / toolAccess / grants      │
│        │                                                                │
│        ├── Server manager (t2): .claude/launch.json, spawn, port, logs  │
│        └── Events: previewTabsChanged / previewUrlChanged /             │
│                     elementSelected / shortcuts / boundsProbe           │
└─────────────────────────────────────────────────────────────────────────┘
```

关键点：
- 一个 serverId 对应一个上下文；上下文里最多约 9 个 tab（`atTabCap = tabs.size > 8`，@4492912、@4794690）。
- 远程 session 上下文总数上限 8（`whi=8`，@4848xxx）。
- 最后一个 tab 关闭会 `ZZ(serverId)` 销毁整个上下文（@4813628）。
- 隐藏且非静态的上下文 5 分钟后被 reaper 回收（`ngi=3e5`，@4839xxx `VZ`）。
- `artifact`/`chat`/`gdrive`/`remote` 是特殊 previewId 前缀，不是普通 dev server。

### 2.2 Chrome 扩展 / native host 双通道

```
Chrome (扩展, Web Store 安装)
   │ chrome.runtime.connectNative("com.anthropic.claude_browser_extension")
   │ stdio: 4-byte LE length + JSON (native messaging)
   ▼
chrome-native-host (Rust/tokio, version 0.1.0)
   ├─ Unix socket server: /tmp/claude-mcp-browser-bridge-<user>/<pid>.sock
   │     4-byte LE length + JSON  (App ↔ host)
   └─ MCP 客户端连接 (多个 App/session)
        │
        ├─ 本地模式: App 扫描 socket，校验 0700 目录 / 0600 socket / owner，
        │            可选 local pairing（JWKS/HPKE 式握手）
        └─ 托管模式: wss://bridge.claudeusercontent.com（或 staging）
```

App 侧把 Chrome 能力注册成 MCP server `claude-in-chrome`（工具前缀 `mcp__claude-in-chrome__`），另有 `list_connected_browsers` / `select_browser` / `switch_browser`；这与 `Launch.callRemoteBrowserTool` 是两条路线（后者操作 in-app Browser pane）。[已证实] @3912625、@3329523、@5161237、@3919xxx、BTGRIMpO

### 2.3 Code session 的 `$BROWSER` 桥

```
CCD terminal session
  env: BROWSER=<copied shim>  CLAUDE_BROWSER_BRIDGE={"socket":"...","key":"<64hex>"}
        │
        └─ gh/python/vite 执行 URL
              ▼
        claude-browser-shim.js
          - 只接受 http(s)、无 userinfo
          - 3s 内通过 Unix socket 发 {"v":1,"key":"...","url":"..."}\n
          - App 回 {"result":"pane"} → 结束；{"result":"declined"} → OS 打开
          - 其余情况 xdg-open / open，并清掉 BROWSER 防止回环
```

App 侧 socket 目录最大路径 107 字节（Unix socket 限制），每 session 32 字节 key，请求 8 KiB、响应 1 KiB、3 s；目录 0700、socket 0600、owner 校验。[已证实] `index.chunk-DldNzPRj.js` @~700-6000、`claude-browser-shim.js` 13-114 行

### 2.4 Framebuffer / 远程屏幕

```
Renderer preview pane
  framebuffer canvas (fw)
    ├─ OffscreenCanvas worker (framebufferCanvasWorker-*.js)
    │    {sessionId,seq,width,height,mimeType,data} → ImageDecoder → drawImage
    └─ FramePortClient (cccc2cf0a @153631 "framebuffer:port")
         message event with MessagePort → adoptPort
Main process service
  requestFramePort() → 把 MessagePort 交给渲染器
  attach(cwd,name) → {sessionId,name,width,height}
  setStreamHints / sendPointer / sendKey / sendScroll / detach
  events: sessionResized / sessionFatal / openSourceRequested
```

`framebuffer_*` 工具与电脑使用（computer use）不是同一套：computer use 用 `cuCaptureDisplay`/`cuWindowRects`（`claude-native-binding.node`），framebuffer 用远程 VNC 帧与 canvas。[已证实] c1MnZbIW、cccc2cf0a、@4025914、@5331818

---

## 3. Preview API / 协议表

### 3.1 服务面

`asset/ipc_services.json` 记录：
- `Launch`：108 个方法
- `BrowserNavigation`：3
- `ChromeExtension`：7
- `FramebufferPreview`：11

生成方式：`gy=ro(cy,"Launch",yy,{methods,stores,events})`（@1932736），每个方法映射到 `Launch_$_<method>` IPC 通道；渲染器 preload 暴露为 `window.claude.web.Launch`（`mainView.js` 中可见 `requestFramePort`、`Launch_$_...`）。事件按 `events` 表推给渲染器。

### 3.2 Launch 方法分组

#### A. 上下文 / server 生命周期

| 方法 | 参数 | 语义 / 返回 |
|---|---|---|
| `isAvailable` | – | 恒 true（本 build）@5521xxx |
| `isJitlessForced` | – | `qM() && mui()`；决定是否加 `--js-flags=--jitless` @4684xxx |
| `startBrowserPreview` | `cwd, sessionId` | 通过 launch config 解析 cwd 后 `t2.loadBrowserPreview`，返回 previewId |
| `startFromConfig` | `cwd, name?, sessionId?` | 显式启动 `.claude/launch.json` 条目；返回 `{serverId,previewId,tabId}` 或 `{error}`/`{refused}` |
| `startRemoteBrowserPreview` | `sessionId, initialUrl, openInNewTab?, coworkRemote?` | 远程/Cowork pane |
| `ensureRemoteBlankPreview` | `sessionId, coworkRemote?` | 确保 remote blank 上下文 |
| `ensureChatBlankPreview` | `conversationUuid` | chat pane blank |
| `openGdriveDocument` | `conversationUuid, kind, fileId, page, fullChrome?` | Drive pane，特殊导航限制 |
| `openPreviewTab` | `serverId, cwd?` | 新建用户 tab（仅已有上下文） |
| `closePreviewTab` | `serverId, tabId, reopenable?` | 关闭 tab；最后一个销毁上下文 |
| `closeAllPreviewTabs` | `serverId` | 保留 seed/第一个 tab |
| `reopenClosedPreviewTab` | `serverId` | 有界 reopen 栈 |
| `reorderPreviewTab` | `serverId, tabId, toIndex` | 调整 tab 顺序 |
| `setActivePreviewTab` | `serverId, tabId` | 前台 tab |
| `hidePreview` / `showPreview` | 见 3.3 | 原生覆盖层显隐 |
| `destroyPreview` | `serverId` | 销毁上下文 |
| `teardownRemoteSessionPreview` | `sessionId` | 销毁 remote 上下文并清 jar/auth cache |
| `clearCoworkBrowserData` / `clearPreviewBrowsingData` | – / previewId | `clearData` + `clearAuthCache` |
| `getPreviewTabs` / `getAllSessionPreviewTabs` | serverId / – | `{tabs:[summary],activeTabId}` |
| `getPreviewUrl` | serverId | 显示用 URL（错误页会映射） |
| `getPreviewNavState` | serverId, tabId? | `{canGoBack,canGoForward}` |
| `previewSnapshot` | serverId | CDP 可访问性/DOM 快照文本（≤12,000 字符） |
| `previewInspect` | serverId, selector, styles? | `{found, info}` |
| `previewConsoleLogs` | serverId, `{onlyErrors?,clear?}` | 当前 origin 的日志；可清除 |
| `previewModelScreenshot` | serverId | 原始 base64 |
| `capturePreviewScreenshot` | serverId, tabId?, targetWindowId? | base64；不可见/未加载/不存在返回 null |
| `capturePreviewScreenshotIfChanged` | serverId, force?, targetWindowId? | 未变化返回 `""` |
| `getPreviewLastFrame` / `discardPreviewLastFrame` | sessionId | 最近 loopback 帧 underlay |
| `exportPreview` | serverId, `file|screenshot` | 保存对话框；返回 bool/null |
| `previewBoundsProbe` (event) | serverIds | 原生层与渲染器对齐探测 |
| `focusPreview` / `setPreviewChromeFocus` | serverId, targetWindowId? / focused | 原生 focus 与 chrome focus 分离 |

`showPreview` 的 bounds 校验器只接受 `{x,y,width,height,radius?,parked?}`（@1721771 `Dv`）。

#### B. 导航 / 内容加载

| 方法 | 语义 |
|---|---|
| `navigatePreview` | URL bar/用户导航；仅 http(s)；文件 URL 走 `loadHtmlPreview`；否则 `xQ` |
| `navigatePreviewFromModel` | 模型导航，返回 `Ok|Blocked|Failed`；Cowork pane 直接拒绝 |
| `goBack` / `goForward` | 校验目标 URL 的 `lUn` 判定后 `navigationHistory.goToIndex` |
| `refreshPreview` | 重新加载；静态内容重新读源文件/重建 data URL |
| `loadHtmlPreview` | 文件路径 → 包含性校验 → pinned/content/plugin tab |
| `loadHtmlPreviewContent` | 内容 + 路径 + isSvg → 新 `html-preview-*` 上下文（data: URL） |
| `loadClaudePagePreview` | claude.ai/design page，defaultSession + preload |
| `pickHtmlFile` | 文件选择器；html/htm/svg/png/jpg/jpeg/gif/webp/avif/pdf |
| `openPreviewInBrowser` | 去凭据、非 loopback 去 query/hash，`shell.openExternal` |
| `openExternalLinkInPreview` / `openClickedLinkInPreview` | 转录链接/页面点击链接路由到合适 tab 或外部 |
| `setPreviewLinkRouting` / `openRoutedLinkExternally` / `resolveRoutedLinkConfirm` | 链接路由到 OS 浏览器，120 s 确认 |
| `setPreviewViewport` / `clearPreviewViewport` | CDP 设备度量；用户/agent 两种 owner |
| `setPreviewColorScheme` | light/dark；CDP `setColorScheme` |
| `addPreviewAllowedOrigin` / `remove...` / `clear...` / `get...` | Allowed-sites 持久化 |
| `setAutoVerify` / `getAutoVerify` | launch config 的 autoVerify 开关 |
| `detectServerCandidates` / `detectServerCandidatesWithAgent` | 识别 npm/yarn/pnpm 脚本与框架 |
| `addServerFromCandidate` | 校验后写 `.claude/launch.json` |
| `getConfiguredServices` | 返回 `{name,port}[]` |
| `importChromeLogins` 等 | 见第 5 节 |

#### C. 事件

`elementSelected`、`selectionModeEnded`、`previewUrlChanged`、`previewTabsChanged`、`previewSelectionShortcut`、`previewSketchShortcut`、`previewPaneShortcut`、`previewCloseShortcut`、`previewNewTabShortcut`、`previewReopenTabShortcut`、`previewAddressBarShortcut`、`previewFocusEnter/Exit`、`previewBoundsProbe`、`previewRevealRequested`、`sessionPaneVisibilityRequested`、`previewSupersededByArtifact`、`previewExternalLinkRequested`、`routedLinkConfirmRequested`、`claudePageLoadSettled`。[已证实] @1937600 附近

`previewTabsChanged` 的 tab summary 包含：`tabId, origin, toolAccess, isOrgBlocked, title, faviconUrl, loading, toolActive, openedWithoutGesture, servedSessionId, pageBackgroundColor/top/bottom, usesBrowserDefaults, audible, muted, emulatedViewport{width,height,setBy}`。`detail.lastTabClosedBy` 用于 UI 决定 reopen 提示。[已证实] @1786239、@4780xxx

### 3.3 BrowserNavigation

只有 3 个方法，作用于**主窗口自身**的 `webContents.navigationHistory`，不是预览：
- `goBack()`
- `goForward()`
- `requestMainMenuPopup()`
证据：`sPt=ro(cy,"BrowserNavigation",...)`（@1912877）。

### 3.4 ChromeExtension

| 方法 | Linux 行为 |
|---|---|
| `isInstalled` | 扫描 Chrome/Edge/Prisma 配置目录的 `Default|Profile N/Extensions/<id>/manifest.json` |
| `installExtension` | Linux 返回错误状态：`No per-user Chrome extension install mechanism on this platform`（@5160349） |
| `restartChrome` | Linux 返回 false（@5160480） |
| `launchBrowser` | spawn `/opt/google/chrome/chrome` 或 `/opt/microsoft/msedge/msedge`（另走 `launchLinuxApp`） |
| `getBrowserActivity` | 读 `/proc/<pid>/exe` 判断 running，结合 installed |
| `getConnectedExtensions` | 通过 bridge client 的 `listConnectedExtensions`；返回 `deviceId,name,onThisComputer,...` |
| `connectedExtensionsChanged` | socket 目录/文件变化触发的 roster 刷新事件 |

### 3.5 FramebufferPreview

| 通道 | 参数 | 方向/返回 |
|---|---|---|
| `requestFramePort` | – | App 把 `MessagePort` 通过 `framebuffer:port` 窗口消息交给渲染器 |
| `listSources` | `cwd` | `{name,origin}[]`（launch.json + launch.d + 运行中的 vm-run 会话） |
| `attach` | `cwd,name` | `{sessionId,name,origin,width,height}` |
| `detach` | `sessionId` | – |
| `setStreamHints` | `sessionId,{backgrounded?,maxWidth?}` | 背景/最大宽提示 |
| `sendPointer` | `sessionId,x,y,buttonMask` | 位掩码 1=左 2=中 4=右 |
| `sendKey` | `sessionId,key,code,down` | key/code 均传 |
| `sendScroll` | `sessionId,direction,notches` | up/down/left/right |
| 事件 `sessionResized` | `sessionId,width,height` | 渲染器调整画布 |
| 事件 `sessionFatal` | `sessionId,message` | 渲染器显示错误 |
| 事件 `openSourceRequested` | `name,cwd,sessionId?` | 模型 `framebuffer_attach` 请求前端打开面板 |

---

## 4. 生命周期 / 状态机

### 4.1 PreviewContext 状态

```
(无)
  │ createPreview / createHtmlPreview / createHtmlPreviewFromContent
  │ createBrowserPreview / createClaudePagePreview / getOrCreateRemoteSessionPreview
  ▼
[context created]
  ├─ containerView + seed tab WebContentsView
  ├─ session partition 选择
  ├─ seed 先加载 data: 空白壳（外部预览），或 about:blank（remote）
  └─ 可选 connect()/loadURL()
        │
        ├─ showPreview(bounds, claimant, targetWindow)
        │     attach container → setBounds → active tab visible → invalidate
        │
        ├─ hidePreview / 窗口消失 / 被遮挡
        │     view.setVisible(false) → detach → rendererParked
        │     ├─ 5 min 未被再次 show → reaper destroy（静态内容保留 contentForExport）
        │     └─ Cowork 可 park 到隐藏 helper window 继续取帧
        │
        ├─ tab close
        │     ├─ 还有 tab → 激活相邻 tab
        │     └─ 最后一个 → emitTabsChanged([]) + ZZ(serverId) destroy
        │
        └─ destroy
              stop timers, close all WebContents, dispose mountGroup,
              remove from maps, clear per-session grants
```

### 4.2 Tab 状态

- `loading`：`did-start-loading` 置 true；`did-stop-loading`/`did-navigate` 置 false。
- `isLoaded` / `loadFailed`：等待 `waitForLoad` 的 resolver；静态内容有 `markLoadFailed`。
- `revealed`：首次真正 commit 后置 true（窗口打开前就导航的 tab 不会自动抢前台）。
- `pinnedUrl`：单文档/文件 tab 只允许同一文档或 hash 导航；地址栏导航会新建 tab。
- `backgroundLiveWanted`：toolActive 的后台 tab 关闭 background throttling。
- `muted`：上下文级别 `setMuted`。
- `toolActiveCount`：模型工具执行期间保持页面活跃。
- `emulatedViewport`：CDP 设备度量，用户或 agent 设置，缩放适配面板。
- `gate`：`toolAccess`（pending/allowed/needs-grant/blocked-policy/blocked-unavailable）、`lastUserInputAt`、`navEpoch`、`consent`、`subframeOriginGrants` 等。

### 4.3 页面导航生命周期（关键分支）

`navigatePreview` → `xQ`（@4917178）：
1. 找上下文；不存在返回 false。
2. `publicHostsOnly` 上下文（remote/artifact/chat/gdrive）先做公网主机检查。
3. mcp-tool 不允许操作 `popup-*`。
4. Chrome Web Store 等 external-only 站点：不导航，交给 OS（`handOffExternalOnlySite`）。
5. 地址栏在 pinned tab 上导航 → 新建 tab，不破坏 pinned。
6. 带 `user:password@` 的 URL：mcp-tool 无授权直接 `blocked`；其他路径剥离并通知。
7. 文件 URL：worktree 包含校验 + 可预览扩展名 → `loadURL`。
8. `isAllowedUrl`（同上下文 host 规则）→ 用户手势/epoch 更新 → `loadURL`。
9. 否则进入 `requestExternalNavigation`，按 `lUn` 结果 allow / block / 外部打开 / 弹卡片。

`will-navigate` / `will-redirect` / `will-frame-navigate` / `setWindowOpenHandler` 都在 `wireTabHandlers` 中（@4797441、@4819308）：
- main frame → `handleMainFrameNavGuard`（@4772889）
- subframe → `subframeNavAllowed`
- `window.open` → `handleTabWindowOpen`（@4781132）
- `will-prevent-unload` 永远 `preventDefault()`（不弹 beforeunload）

### 4.4 关闭 / 重开

- `closePreviewTab(..., reopenable)` 把 URL 存入 `cZ` reopen 栈，带 cwd。
- `reopenClosedPreviewTab` 仅对 `offersTabReopen` 的上下文可用：非 Cowork、非 Claude page、非 publicHostsOnly、有 sessionWorkingDir。
- 重开前再次校验 session ownership 与 cwd，避免跨 session 重开。

---

## 5. Chrome / native host 路径

### 5.1 标识与 manifest

[已证实] @3289493、@3923020、二进制字符串：
- native host 名：`com.anthropic.claude_browser_extension`
- 可执行名：`chrome-native-host`（version 0.1.0）
- manifest 文件：`com.anthropic.claude_browser_extension.json`
- `type: "stdio"`
- `allowed_origins`：
  - `chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/`
  - `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/`
  - `chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/`
- 主扩展 ID（稳定版）：`fcoeoabgfenejglbffodgkkbkcdhcgfn`
- Web Store URL：`https://chromewebstore.google.com/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn`

### 5.2 Linux 安装 / 发现

- 浏览器配置根：`$XDG_CONFIG_HOME/google-chrome`、`microsoft-edge`、`Palo Alto Networks/PrismaAccessBrowser`；`$XDG_DATA_HOME` 仅用于 data 目录。
- native host manifest 目录：`<browser config>/NativeMessagingHosts/`。
- 打包模式下 manifest 的 `path` 直接指向 `process.resourcesPath/chrome-native-host`；非打包模式指向仓库 artifacts。Linux `Vr()` 为 false，因此不复制二进制。
- App 启动时 `JDr()` 对所有检测到的浏览器同步 manifest；文件 watcher 在 500ms debounce 后再次同步。
- Linux **不支持**从 App 安装扩展（`installExtension` 返回错误），也**不支持**重启 Chrome；扩展必须用户自己在 Web Store 安装。

### 5.3 传输

1. **Chrome ↔ native host**：Chrome native messaging 的 `stdin/stdout`，4 字节小端长度 + JSON。
2. **App ↔ native host**：Unix socket `/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock`；同样是 4 字节小端长度 + JSON（`readUInt32LE(0)`，@3331083）。
3. **本地安全校验**（@3331470）：
   - 目录必须是 `claude-mcp-browser-bridge-*`、非符号链接、mode 0700、owner 当前 uid。
   - socket 必须是 socket、mode 0600、owner 当前 uid。
   - 失败直接不拨号。
4. **local pairing**（可选）：exchange pair 消息走 JWKS，四步 offer/accept/done；用 `local-pairing` partition 做证书 pin；API origin 来自 bootstrap。托管模式直接用 `wss://bridge.claudeusercontent.com`（staging：`wss://bridge-staging.claudeusercontent.com`）。
5. socket 客户端自动重连，指数退避，最多 100 次；连接超时约 10s（`Nz`）。

### 5.4 工具面

- 注册 MCP server `claude-in-chrome`，工具前缀 `mcp__claude-in-chrome__`。
- 浏览器 roster：`list_connected_browsers`、`select_browser`、`switch_browser`。
- 扩展侧负责页面 DOM/导航；App 侧只做 MCP 桥与权限/telemetry。
- `getConnectedExtensions` 在 bridge 不可用时抛错，UI 转成“未连接”。
- `getBrowserActivity` 返回 `{browser,installed,running}`，Linux 用 `/proc` 识别进程。

### 5.5 Chrome 登录导入（只有 cookie + localStorage，没有密码）

[已证实] `index.chunk-OZpEme0W.js`：
- 浏览器：Chrome、Edge、Brave、Chromium、Firefox；Linux 含 `~/.config/...`、`~/.var/app/...`、`~/snap/...`。
- cookie DB：`Network/Cookies` 或 `Cookies`，上限 64 MiB。
- Chrome v10/v11：
  - v10 key = PBKDF2-SHA1("peanuts" 或 "", "saltysalt", 1003, 16)；
  - v11 key 从 Secret Service（`secret-tool search --all ... application=<browser>`）或 KWallet（`kwallet-query --read-password "<Browser> Safe Storage" --folder "<Browser> Keys"`）读取；
  - AES-128-CBC，IV 为 16 个空格；
  - v24+ 密文前缀带 `SHA256(host_key)`，先比对再解；
  - Firefox 直接读取明文 `moz_cookies`。
- 站点索引：按 hostKey 聚合到 root；过滤 localhost/IP/.local/.internal；分类 `identity`（Okta/Auth0/1Password 等）、`email`（Google/Outlook/Proton 等）、`financial`（bank 正则 + 远端 financial host）。
- 选择流程：列出 `{root,cookieCount,hostCount,lastAccess,sensitive?,suggested?}`；最多建议 5 个 auth-shaped、非敏感站点；当前 host 优先。
- 用户确认：必须弹出 “Let Claude read your <browser> logins?”；窗口必须可见，离开窗口 120s 超时中止。
- 导入：ticket 300s；只导入选中 root；可选 `enablePersist`（会把 `launchPreviewStorage` 从 none 切到 shared，@31312）；cookie 写入 session jar；localStorage 通过一个隐藏、`javascript:false/images:false/webgl:false` 的 `WebContentsView` + CDP `DOMStorage.setDOMStorageItem` 种子化（@18773）。
- 结束后 reload 当前页面；返回 `{results,persistent,reloaded,storagePending,storageCarried}`。
- 失败映射：`keychain_item_missing/keychain_denied/keychain_error/...`；若从 keyring 拿不到 key 且所有 cookie 都解密失败，返回 `keyring_unavailable`。

---

## 6. 安全模型

### 6.1 进程与视图隔离

- 所有外部预览 tab：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`focusOnNavigation:false`、`disableDialogs:true`、`plugins:true`。[已证实] @4757470
- Claude page 预览例外：使用 `session.defaultSession`，`nodeIntegrationInSubFrames:true`，加载专用 preload `claudePagePreview.js`；仍 sandbox/contextIsolation，preload 只暴露 `claudeDesktopArtifactPane` 和 host tools MessagePort。[已证实] @4757470、`claudePagePreview.js`
- 没有使用 `<webview>` 标签；`will-attach-webview` 的 deny 逻辑存在于其他 artifact 检查路径，但预览本身是 `WebContentsView`。[已证实]
- 渲染器只能通过生成的 IPC 方法操作；CDP 只在主进程持有。[已证实]

### 6.2 Session / partition

命名（@3092701）：

| 场景 | partition |
|---|---|
| 每 workspace（shared 模式） | `persist:launch-preview-<md5(cwd).slice(0,12)>` |
| 每 session（session 模式） | `persist:launch-preview-session-<sessionId>` 或非 persist 同名 |
| 静态 HTML | `persist:launch-preview-static` |
| Cowork 共享 | `persist:launch-preview-cowork-shared` |
| 本地配对 | `local-pairing`（独立，cache:false，证书 pin） |

- `launchPreviewStorage` 枚举：`none|shared|session`（@1547200）。
- `none` → 非持久 partition；`shared` → 每 workspace；`session` → 每 session。
- 启动时 `Cfi({preserveCoworkSharedJar:true})` 清理旧 session 数据；退出时注册 `preview-static-partition-wipe`；组织策略 block 时关闭所有外部可浏览上下文并清理 shared jar；session 删除时 `clearData()` + `clearAuthCache()`。
- `clearPreviewBrowsingData(previewId)` 对 remote 用共享清理，否则清当前 jar；`clearCoworkBrowserData` 清 shared jar。
- 身份变化时关闭 chat/artifact/gdrive pane。

### 6.3 权限

`lfi(session,...)`（@4715274）注册：
- `setPermissionRequestHandler`：
  - 只允许 `clipboard-sanitized-write`，且必须是 main frame、URL 是 loopback 或 `docs.google.com` 的 GDrive 上下文、tab 可见且 active。
  - `media`（camera/mic）**一律拒绝**，并按 tab 记录 `deniedMediaKinds`，向渲染器发通知 + telemetry。
  - 其他权限一律 `false`。
- `setPermissionCheckHandler`：只对上述 clipboard 条件返回 true。
- WebAuthn：`select-webauthn-account` 只在单凭证时自动选择；多凭证直接取消（无 picker UI）。
- `setDisplayMediaRequestHandler`：只有被 `armPreviewLiveStream(previewId)` 在 15s 内“武装”的 mainFrame（processId/routingId/url 匹配）才可能拿到视频源；否则返回空。[已证实] @4528435、@4529025

### 6.4 导航 / 来源判定（`lUn`，@3162698）

判定顺序（简化）：
1. URL 解析失败 → 由调用方处理。
2. URL 含 userinfo → `block-credentials`。
3. `publicHostsOnly` 且目标不是公网主机 → 除非有 committed admission/loopback 授权，否则 `block-private-host`。
4. `isAllowedUrl`（同 host / 文件 / Claude page 规则）→ `allow-native`。
5. 外部预览被禁用 → `block-gate-off`。
6. external-only 站点（Chrome Web Store）→ `open-external`。
7. worktree 内 `file:`：
   - 原始文档扩展名（pdf/图片/视频）且不是 history → `block-raw-file-doc`；
   - 5s 内无用户手势 → `block-silent`。
8. 非 http(s) → `block-silent`。
9. Allowed-sites / session grant / history → `allow-native`。
10. 同源已提交 → `allow-native`。
11. `open-tab` 且 5s 无手势 → `block-silent`。
12. 否则 `defer-to-prompt`（由上层决定是否弹卡片；模型导航会走 `TBn`）。

`requestExternalNavigation` 是模型/URL bar 的主要同意路径：
- 受管策略 → `blocked`
- Allowed-sites（`kF`）或 session grant（`tF`）或 domain transition → allowed
- 私有网络 / category3 → 用户卡片；可通过 session mode 或 Allowed-sites trust 豁免
- 超时/拒绝 → `denied-by-user`
- `TBn` 对非 `mcp-tool` 直接返回 `allowed`，所以卡片只约束模型侧。

### 6.5 私有网络 / DNS rebinding

`webRequest.onBeforeRequest`（@4715274 内）对 `publicHostsOnly` 和受管 session：
- 解析主机名，拒绝 loopback/private/metadata/非公网地址；
- 对解析失败、预算耗尽、DNS 结果不明 → 取消；
- 允许同一文档已授权的同源请求；
- 子资源还要与主文档同源（`LHn`）；
- `Jdi` 做 DNS 解析缓存（60s）。
- `publicHostsOnly` 上下文包括 remote/chat/artifact/gdrive pane。
- `subframeNavAllowed` 对子帧有更窄的许可集合。

### 6.6 文件包含 / 本地内容

`loadHtmlPreview`（@5517239）：
- 拒绝非 localhost 的 `file:` host；拒绝 UNC；`cwd` 必须可预览；`realpath` 必须落在 worktree 内（`zb`/`Bb`/`WU`）。
- agent 发起且指向 worktree 外 → 需要文件访问卡片；`incidental` provenance 可跳过。
- 扩展名分类：plugin（PDF）、content（html/htm/svg）、pinned（图片/视频/pdf）、plain（文本）。
- content tab 源文件 > 524,288 字节 → 拒绝；文本预览 > 2,097,024 字符 → `PREVIEW_CONTENT_TOO_LARGE`。
- 符号链接/特殊文件：`O_NOFOLLOW` + `fstat`，拒绝非常规文件。
- 源文件身份用 `{dev,ino,mtimeNs,size}` 绑定；导出/刷新时再验证，防 TOCTOU。
- `loadHtmlPreviewContent` 生成 `data:text/html;charset=utf-8,...`，注入 CSP：
  `default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`
- SVG 包成 `<svg>` 页面；纯文本转义后放 `<pre>`。
- **交互式 content tab** 使用 `contentInteractive` 时可保留脚本（但仍是 data: URL + CSP？此处 `x2` 扩展名列表为 html/htm/svg；CSP 在非交互时注入，交互模式由 `egi` 走另一分支，具体脚本策略见 `mbi`）。[部分已证实，交互模式边界需实测]

### 6.7 外部协议 / 凭据 / 下载

- `openPreviewInBrowser` / `openRoutedLinkExternally`：只 http(s)，拒绝凭据、超长 hostname；非 loopback 去掉 query/hash；`shell.openExternal`。
- 页面导航到 `mailto:`/自定义协议：`JP` 返回 null → blocked；不会调用 OS。
- 凭据 URL：模型导航直接拒绝；其他路径剥离并 toast；server redirect 带凭据会被拦截。
- PDF 导航：`Content-Type: application/pdf` 且非 attachment → 改写为 `Content-Disposition: attachment`，触发下载（@4724094）。
- `will-download`：若下载来自尚未 revealed 的 tab，关闭该 tab；全局 `will-download` 只记录目标目录用于 telemetry。**没有发现下载路径 containment / 强制下载目录策略**。[已证实 + 未知]
- `exportPreview`：保存对话框；静态源导出前再校验 `{dev,ino}`，写入 mode 0600（`{mode:420}`）；截图导出为 PNG。[已证实] @4890660

### 6.8 站点策略 / 组织策略

- 远端 blocklist：`/api/web/url_hash_check/browser_extension` 或 `/api/web/domain_info/browser_extension`；category1/2 或 org policy block 是明确阻断；category3 是“可能需要私有网络/高风险卡片”；网络/解析失败 **fail-open**（仅记录 warning）。[已证实]
- 金融/银行站点：`KP` 读取 feature flag hosts（`pb("3302457740").hosts`）；命中后 Browser 工具直接不可用；远程工具运行后若出现银行帧会扣留结果。
- 组织策略：`qM()`、`BM()`、`zM()`；block 时会关闭 external-capable contexts 并清 shared jar。
- `jitless` kill switch：`--js-flags=--jitless` 可显著降低 JIT 攻击面；feature flag `3602629573` 控制。

### 6.9 模型工具二次授权

- `toolAccess` 状态：`pending → allowed/needs-grant/blocked-policy/blocked-unavailable`。
- `M2i`（@5457376）对模型读取/操作做 Allowed-sites、blocklist、私有网络、session grant、private-network waiver 检查。
- `r3i`/`i3i` 记录 `{approvedOrigin,commitEpoch,subframeCount,subframeEpoch}`，截图/日志/元素检查完成后再次比对；页面或帧变化就丢弃结果（防 TOCTOU）。
- `callRemoteBrowserTool`（@5509767）还有 budget/guard：
  - 银行页/银行帧 → 不执行或扣留结果；
  - 页面/帧在调用期间变化 → 返回“page changed, retry”；
  - 工具关闭 → 扣留结果；
  - 超时 150s（`browser_batch` 300s）；
  - `browser_batch` 最多 25 个动作、不可嵌套。
- `browsing tools` 的输入门控还要求：tab 存在、页面已加载、模型工具对该 tab 的 `toolAccess` 为 allowed。

---

## 7. Framebuffer / 远程浏览器

### 7.1 定义

Framebuffer 是 `.claude/launch.json` 中 `type:"framebuffer"` 的远程屏幕源：
```json
{"name":"<name>","type":"framebuffer","vncUrl":"vnc://[:pw@]host:port","serverFlavor":"standard|vz"}
```
- `socketPath` 可替代 `vncUrl`（Unix socket 上的服务器）。
- `agentInput:false` 关闭该源的输入工具。
- `serverFlavor:"vz"` 用于 Apple Virtualization.framework 的 Cmd/Option keysym 映射；其他用 `standard`。
- 支持 `.claude/launch.d/*.json` 单条目；`ownerPid` 让条目在进程死亡后消失。
- `listSources` 还会列出运行中的 `vm-run.sh` 会话（工具描述）。[已证实] c1MnZbIW @55800、@73500

### 7.2 渲染链路

- 主进程 `attach(cwd,name)` 返回 session 元数据；渲染器 `aw()` 请求 frame port。
- `FramePortClient` 监听 `window.message`，只接受 `type==="framebuffer:port"` 且 source 为自身/同源的 MessagePort。
- Worker 校验帧 `{sessionId,seq,width,height,mimeType,data:Uint8Array}`；`seq` 单调递增，丢弃旧帧；尺寸变化时重设 canvas；用 `ImageDecoder` 或 `createImageBitmap` 解码，`drawImage` 到 2D context。
- 优先 `transferControlToOffscreen()` + Worker；不支持时主线程 2D canvas 兜底。
- 鼠标坐标：从 canvas 显示区域按 `object-fit: contain` 反算到源坐标；wheel 每累计 50px 发一个 notch；键盘在 canvas 获得焦点时发送 down/up，blur 时释放所有键。[已证实] cccc2cf0a @153631-161500、worker 全文

### 7.3 模型工具与安全

工具（c1MnZbIW @73500）：
`framebuffer_list`、`framebuffer_attach`、`framebuffer_screenshot`、`framebuffer_zoom`、`framebuffer_cursor_position`、`framebuffer_click`、`framebuffer_move`、`framebuffer_drag`、`framebuffer_scroll`、`framebuffer_type`、`framebuffer_key`、`framebuffer_hold_key`、`framebuffer_batch`。

门控：
- `framebuffer_attach` 只是让用户的预览面板打开该源；真正连接由面板建立。
- 没有 attached consumer → 输入工具不可用；`agentInput:false` → 输入工具不可用。
- 首次输入前必须先 `framebuffer_screenshot`（`xi`）。
- `inputStatus()` 返回 `inputSuspended/connected/ownedByHuman/dirty/disconnectCount`；用户接管时拒绝，页面变化时要求重新截图。
- 点击前 `compareClickPatch` 比较目标区域像素，变化则拒绝（`pixelGuard`）。
- 输入写入 `~/.config/<app>/framebuffer-ledgers/<sha256(sessionId)>.jsonl`，单条 ≤4 KiB、总量 5 MiB、轮转；记录 origin/kind/args。
- 输入文本若像 token/密码/私钥，会先警告。
- `framebuffer_batch` 最多 10 个动作。/ 这些是渲染器/工具层证据；真正的 RFB 会话管理未定位。[已证实工具层，执行体未知]

### 7.4 与 computer use 的区别

- computer use：`cuCaptureDisplay`、`cuWindowRects`、Wayland portal、cowork VM、`connectUnixSocketSameUid`（SO_PEERCRED）。[已证实] @4025914、@5331818、@2955900
- framebuffer：远程 VNC 帧，不抓本机屏幕；由 preview pane 显示，模型用 `framebuffer_*`。
- 两者共享“用户可接管、输入需观察、敏感操作需确认”的产品思路，但代码路径不同。

### 7.5 远程浏览器（remote pane）

- previewId：`preview-remote-<session>`、`preview-remote-chat_<conversationUuid>`、`preview-remote-artifact_<uuid>`、`preview-remote-gdrive_<id>`。
- `publicHostsOnly:true`，共享 `cowork-shared` jar，private network 限制更严。
- `startRemoteBrowserPreview` / `ensureRemoteBlankPreview` / `ensureChatBlankPreview` / `openGdriveDocument`。
- `callRemoteBrowserTool` 是**这个** in-app pane 的工具执行器，不是 Chrome 扩展。
- `teardownRemoteSessionPreview` 销毁 pane 并清 jar/auth cache。

---

## 8. UI / UX

从 `cf580efe9`（预览面板 SPA）可确认：
- Header：server picker（运行/停止、Add server、Stop all）、日志开关、地址栏、Tab strip、Open external、Reload、Select element、Annotate、Screenshot/Export。
- 地址栏：支持文件路径（`loadHtmlPreview`）与 URL；`target_kind` 区分 native/file；刷新时对 file-origin 且当前是 data: 的 tab 会重新调用 `loadHtmlPreview`。
- 菜单：Manage allowed sites、Set link destination、Clear browsing data、Keep cookies/Clear session data、Viewport presets、Import Chrome logins / Use imported cookies。
- 选择元素：进入 CDP inspect mode；选中后发送 `elementSelected`，payload 含 tagName/classes/attributes/computedStyles/boundingBox/screenshot/innerText/parentPath/component/reactComponent/reactProps/outerHTML/siblingHTML；UI 把它作为“截图 + HTML + 样式 + selector + React 信息”发给 Claude。
- Annotate/sketch：有快捷键与按钮；具体绘制实现是渲染器侧 overlay，[未知] 其持久化格式。
- 隐藏/遮挡：`rendererParked`、`previewPaneState` 文案由主进程生成。

快捷键（主进程 `before-input-event`，@4683900）：
| 快捷键 | 行为 |
|---|---|
| Cmd/Ctrl+W | 关闭 tab |
| Cmd/Ctrl+T | 新 tab |
| Cmd/Ctrl+Shift+T | 重开最近关闭 |
| Cmd/Ctrl+L | 地址栏 |
| Cmd/Ctrl+R | reload |
| Cmd/Ctrl+[ / ] | 后退/前进 |
| Ctrl+Tab / Ctrl+Shift+Tab / PageUp/PageDown | 循环 tab |
| Cmd/Ctrl+1..9 | 激活第 N 个 tab（9 = 最后一个） |
| Cmd/Ctrl+Shift+P 或 B | 预览 pane 快捷 |
| Cmd/Ctrl+Shift+S | sketch/annotate |
| Cmd/Ctrl+Shift+X | selection mode |
| F6 | 聚焦 pane |
| Cmd/Ctrl+Shift+I | 打开 devtools（仅允许时） |

### Artifact / frame 集成

- `ion-dist/app://` 提供主渲染器与 artifact 资源；`frame-shell.html` 处理 artifact 内嵌、host-tools、chrome 能力协商。
- `client-shell-v1.html` 是严格 CSP 的 shell：
  `default-src 'none'; script-src 'unsafe-inline' blob:; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; webrtc 'block'`
  并用 `window.name` handshake、嵌套 sandbox iframe、MessageChannel 把 port 交给父级。
- 预览与 artifact 的交互：`previewSupersededByArtifact` 事件、`setArtifactPaneHost`（本 build 返回 false，host 逻辑在别处）、`html-preview-*` 命名空间。

---

## 9. 跨平台 / Linux 细节

1. Chrome/Edge 路径固定：`/opt/google/chrome/chrome`、`/opt/microsoft/msedge/msedge`；运行检测读 `/proc/<pid>/exe`，去掉 `" (deleted)"` 后缀。[已证实] @5157xxx
2. Chrome 用户配置：`$XDG_CONFIG_HOME`（默认 `~/.config`）下 `google-chrome`、`microsoft-edge`、`Palo Alto Networks/PrismaAccessBrowser`。
3. native host manifest：`<browser config>/NativeMessagingHosts/com.anthropic.claude_browser_extension.json`。
4. Linux 不支持 App 内安装扩展 / 重启 Chrome。
5. Chrome cookie 解密走 `secret-tool`（GNOME keyring）或 `kwallet-query`（KDE，wallet 名 `kdewallet`/`kwalletd5/6`），失败时回退 `peanuts`/空 key。
6. `$BROWSER` shim：`xdg-open` 打开，且清理 `BROWSER`/`CLAUDE_BROWSER_BRIDGE` 防止回环。
7. `scheduleLinuxFirstFrameFallback`：Linux 上 `WebContentsView` 首帧可能不绘制；在 `setBounds` 后 250ms 用 `capturePage` 探测尺寸，必要时把 view 高度 ±1px 触发重绘（@4816xxx）。
8. `launchLinuxApp` 用于启动浏览器；`process.platform==="linux"` 时 `connectUnixSocketSameUid` 用 SO_PEERCRED 校验 cowork helper。
9. 本 Linux build 的 `FramePreview` 执行体未定位；只有 IPC 协议、canvas 渲染与工具层，推测为特性/平台门控。[未知]

---

## 10. 可借鉴到 AutoAgent（Python/FastAPI + Electron/React）

### P0（必须照做）

1. **预览用 `WebContentsView`，不要 iframe。** 一个 `containerView` + 每 tab 一个 `WebContentsView`；渲染器只上报 bounds/claimant；主进程负责 attach/raise/setVisible。Electron 的 `BrowserWindow` 只作为宿主，预览内容不进入 React DOM。
2. **每 session/workspace 独立 partition。** 至少 `persist:autoagent-preview-<hash>` 与静态 `persist:autoagent-preview-static`；删除会话时 `clearData()` + `clearAuthCache()`；不要把预览放进 `defaultSession`。
3. **CDP 工具层。** 用 `webContents.debugger`（或 `playwright-core` 连接本地 CDP，但主进程仍持有生命周期）实现：accessibility snapshot + ref、点击/输入、截图、网络日志、console、viewport、color scheme。不要让 Python 侧直接持有 `webContents`。
4. **严格 webPreferences。** `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、`disableDialogs:true`；Claude page 这类需要 preload 的特例单独建上下文。
5. **权限默认拒绝。** 只对明确需要的 clipboard 场景放行；camera/mic 默认拒绝并告知用户；WebAuthn 多凭证取消。不要把 `setPermissionRequestHandler` 留空（Electron 默认行为不可接受）。
6. **模型导航二次授权。** Allowed-sites + session grant + 用户手势；私有网络单独卡片；`file:` 必须 worktree 包含；拒绝 `user:password@`、非 http(s)、原始 PDF/图片文档。
7. **文件预览安全。** `O_NOFOLLOW` + `fstat`、UNC/符号链接拒绝、worktree realpath 包含、2 MiB 文本上限、524 KiB 内容 tab 上限、导出前再校验 dev/ino。
8. **截图管线。** 可见时 `capturePage`/CDP；隐藏时 warm capture；`IfChanged` 做位图比较；隐藏预览保留 underlay 帧；截图最大宽度 800、JPEG 85/75。
9. **事件驱动 tab 模型。** `previewTabsChanged` 带 origin/toolAccess/loading/toolActive/emulatedViewport；关闭最后一个 tab 销毁上下文；有界 reopen 栈；tab 上限（本实现 9 个左右）。
10. **DNS rebinding 防护。** `onBeforeRequest` 里解析 hostname，拒绝 loopback/private/metadata；子资源与主文档同源；public-hosts-only 上下文更严格。

### P1（强烈建议）

11. **Launch config（`.autoagent/launch.json`）**：`runtimeExecutable/runtimeArgs/port/url`；只允许 `npm/yarn/pnpm` 的 `dev/start/serve/develop` 候选；`autoPort`；启动前用户同意；日志缓冲。
12. **浏览器 UI**：地址栏、tabs、reload、back/forward、open external、viewport presets、allowed-sites 管理、清浏览数据、截图/导出。
13. **链接路由**：用户点击/转录链接 → 已有 tab 或新 tab；外部专用站点交给 OS；loopback 链接只允许 session 拥有的端口。
14. **`$BROWSER`/CLI 打开链接桥**：Unix socket + 每 session key + 新行 JSON；只接受 http(s) 无 userinfo；超时回退 OS。
15. **Chrome 导入（若产品需要）**：只 cookie + localStorage，不做密码；Secret Service/KWallet；敏感站点分类 + 明确用户确认 + ticket TTL。
16. **Chrome 扩展 MCP 桥（若需要真实浏览器）**：native messaging + Unix socket、0700/0600/owner 校验、可选 local pairing、4-byte length framing；Linux 不要假装能自动安装扩展。
17. **TOCTOU 校验**：调用前记录 `{origin,commitEpoch,subframeCount}`，返回结果前比对；页面变化就丢弃并要求重试。

### P2（可选/高级）

18. **Framebuffer/VNC 面板**：canvas + OffscreenCanvas worker + MessagePort；seq 丢旧帧；`maxWidth` 对齐 128 的倍数；输入前必须截图、用户接管时拒绝、像素 guard。
19. **Live stream 授权**：`setDisplayMediaRequestHandler` + 短时 arm，绑定 `{processId,routingId,url}`。
20. **窗口/popout/全屏**：`targetWindowId`、owner claimant、artifact fullscreen、窗口缩放因子、Linux 首帧 fallback。
21. **颜色采样/主题**：`nativeTheme` + CDP `setColorScheme` + 页面背景色采样（用于预览边框/underlay）。
22. **后台活跃管理**：toolActive 时关闭 background throttling；隐藏 park helper；预算回收。

### 应避免

- 不要让模型直接指定任意 URL 就导航；必须过 origin grant/用户手势。
- 不要把预览塞进 `defaultSession` 或主渲染器 iframe。
- 不要 `nodeIntegration:true` / `contextIsolation:false` / 关闭 sandbox。
- 不要信任页面 `title`、`origin`、`favicon`、`window.open` 的 disposition；都要重新判定。
- 不要让 `file:` 通过字符串前缀判断包含性；必须 realpath + `O_NOFOLLOW` + fd 身份。
- 不要依赖远端 blocklist 的可用性；本实现 fail-open 是风险点，AutoAgent 应至少 fail-closed 或明确提示。
- 不要把所有 session 的 cookie 放在一个 jar；不要在隐藏 tab 继续下载文件。
- 不要让 renderer 直接拿 CDP/`webContents`；所有能力走受校验的主进程 IPC。
- 不要把 Playwright 当作唯一安全边界；它只是自动化库，导航/权限/文件仍要宿主进程把关。

---

## 11. 证据索引

### 11.1 IPC 服务清单

- `/home/tars/yysapp/claude-desktop/asset/ipc_services.json`
  - `Launch`（108）、`BrowserNavigation`（3）、`ChromeExtension`（7）、`FramebufferPreview`（11）。
- `/home/tars/yysapp/claude-desktop/asset/rea_summary.json`：全局统计（447 files、433 parsed JS、1491 IPC operations、50 contextBridge APIs）。
- `/home/tars/yysapp/claude-desktop/asset/ida_native/survey.json`：目标为 `@ant/claude-native/claude-native-binding.node`；字符串/导入主要是 Linux 桌面、Wayland、通知、cowork VM，不是浏览器自动化。

### 11.2 主进程 / preload

文件：`/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js`

| 偏移 / 符号 | 内容 |
|---|---|
| `@1912877 sPt=ro(cy,"BrowserNavigation"` | BrowserNavigation 3 方法 |
| `@1916833 vPt=ro(cy,"FramebufferPreview"` | FramebufferPreview 11 方法 + 事件 |
| `@1932736 gy=ro(cy,"Launch"` | Launch 108 方法 + 事件 |
| `@1937600` | Launch 事件表 |
| `@1786239 _Tt` | tab summary 校验器 |
| `@1793410 nEt` | elementSelected payload |
| `@1721771 Dv` | showPreview bounds 校验 |
| `@4099801 azr / izr` | 窗口挂载组（attach/detach/raise/popout） |
| `@4101723 azr` | attach：容器 + 所有 tab 加到 contentView |
| `@4743623 jpi` | 每 tab gate 初始状态 |
| `@4747565 uZ=class` | PreviewContext 类 |
| `@4757102` | mountGroup / webPreferences 构造 |
| `@4757470` | session partition、preload、sandbox/contextIsolation/nodeIntegration、jitless |
| `@4794270/4795653 createUserTab` | 新 tab 创建 |
| `@4797441 wireTabHandlers` | 导航/window.open/键盘/下载相关事件 |
| `@4810829 setActiveTab` | 前台切换、焦点、park |
| `@4813628 closeTab` | 关闭 tab / 最后 tab 销毁 |
| `@4814990` | `ZZ` 调用点 |
| `@4815487 updateTabBounds` | zoomFactor、emulatedViewport、setBorderRadius、只显示 active |
| `@4819308 setupEventHandlers` | `will-navigate`、`will-redirect`、`will-frame-navigate`、`setWindowOpenHandler` |
| `@4829241 destroy()` | 销毁上下文、关闭 WebContents、释放 mountGroup |
| `@4839037 jZ` | 按需创建/恢复上下文 |
| `@4839346 shi` | `new uZ(serverId,port,...)` |
| `@4844978 xhi` | 静态 HTML/文本文件预览 |
| `@4850878 RZ` | openSessionPreviewTab |
| `@4857816 tgi` | 从内容创建静态上下文/data URL |
| `@4859593 ugi` | showPreview |
| `@4861999 WZ` | hidePreview |
| `@4870833 ZZ` | destroyPreview |
| `@4877038 u_i` | 取上下文或抛 `PreviewError` |
| `@4879221 v_i` | 可见全分辨率截图 |
| `@4879572 y_i` | warm/IfChanged 截图 |
| `@4883072 L_i` | 隐藏捕获 jog |
| `@4884934 B_i` | hidden warm capture |
| `@4886067 iQ` | 统一截图入口 |
| `@4890660 q_i` | exportPreview |
| `@4906661 Rvi` | previewSnapshot 文本（12k 截断） |
| `@4911558 nyi` | getPreviewNavState |
| `@4913602/4914025 cyi/lyi` | goBack/goForward |
| `@4917178 xQ` | navigatePreview |
| `@5449179 loadHtmlPreviewContent` | 内容预览 IPC 实现 |
| `@5457376 M2i` | 模型读取/操作站点策略 |
| `@5495935 P4i` | server candidate 检测 |
| `@5507048 a3i` | Cowork pane 判定 |
| `@5508386 b3i` | listRemoteBrowserTools |
| `@5509767 C3i` | callRemoteBrowserTool |
| `@5517239 W3i` | loadHtmlPreview 完整实现 |
| `@5522820` | allowed origins 方法组 |
| `@5523427` | openPreviewInBrowser |
| `@5524101` | clearPreviewBrowsingData |
| `@5525278` | importChromeLogins |
| `@5532416` | navigatePreviewFromModel |
| `@5532704` | list/call remote tools |
| `@5535061` | startFromConfig |
| `@4715274 lfi` | 权限 handler + onBeforeRequest/onHeadersReceived |
| `@4724094` | preview `will-download` |
| `@4725096 eZ` | launchPreviewStorage |
| `@4726059 vfi` | `session.fromPartition` + UA 伪装 |
| `@4727506 Cfi` | 启动清理 |
| `@4729222 wfi` | 清 session partition |
| `@4772889 handleMainFrameNavGuard` | main frame 导航守卫 |
| `@4781132 handleTabWindowOpen` | popup 允许/拒绝 |
| `@3162698 lUn` | 导航决策表 |
| `@3092701 YN` | partition 命名 |
| `@3111876 KP` | 金融站点 host 列表 |
| `@3122122 Xzn` | origin 资格判断 |
| `@3137358 TBn` | origin 卡片 |
| `@3148273 fI` | 金融站点 wrapper |
| `@4528435 Bni` | armPreviewLiveStream |
| `@4529025 Uni` | display media 授权 |
| `@4492912 DY` | tab cap (>8) |
| `@5158803 mFi` | browser activity |
| `@5160349 xFi` | Linux 不支持安装扩展 |
| `@5160480 SFi` | Linux 不支持 restartChrome |
| `@5161237 TFi` | ChromeExtension 服务注册 |
| `@3329523 w2n=class` | 本地 socket 客户端 |
| `@3331083 connect` | 4-byte LE framing |
| `@3331470 validateSocketSecurity` | 0700/0600/owner |
| `@3920797 FDr` | `/tmp/claude-mcp-browser-bridge-<user>` |
| `@3920913 IDr` / `@3920959 LDr` | 目录 / `0.sock` |
| `@3923020 qDr` | native host manifest 写入 |
| `@3912625 eDr` | hosted bridge URL |
| `@3289493` | 扩展 ID / native host 常量 |
| `@3291886 I$n` | native host 路径解析 |
| `@4025914 cuCaptureDisplay` | computer use（非浏览器） |
| `@5331818 cuWindowRects` | computer use（非浏览器） |
| `@2955900 connectUnixSocketSameUid` | cowork VM helper SO_PEERCRED |

### 11.3 其他主进程 chunk

- `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-BTGRIMpO.js`
  - `@3169` 起：preview_* 工具 schema
  - `@5334 preview_screenshot`、`@5936 preview_snapshot`、`@6303 preview_inspect`、`@8405 preview_network`
  - `@11800` 起：tool access / page 状态门控
  - `@12855 tabs_context`、`@1417 browser_batch`
  - `@3032 getPreviewToolList`、`@3078 isPageCaptureCall`
- `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Bb_jZsw8.js`
  - `@1642 read_page`、`@2086 computer`、`@2668 form_input`、`@2850 navigate`、`@3055 find`、`@3512 get_page_text`、`@3678 javascript_tool`、`@3888 read_console_messages`、`@4024 read_network_requests`、`@4159 resize_window`、`@5435 tabs_context`、`@6051 tabs_create`、`@6553 tabs_select`、`@6903 tabs_close`
- `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-OZpEme0W.js`
  - `@1301` 浏览器根；`@7993 secret-tool`；`@8018 kwallet`；`@9582 saltysalt`；`@9683 v10/v11`；`@9885` key 派生；`@18773` 隐藏 WebContentsView localStorage 种子；`@21156 identity`；`@22555 financial`；`@22679 ft` 站点聚合；`@23299 sensitive`；`@26715` list sites；`@31672` run import；`@31312` enablePersist。
- `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-DldNzPRj.js`
  - `@~700` 常量（`CLAUDE_BROWSER_BRIDGE`、shim 名、8KB/3s/1KB）；`@~3800` 每 session env；`@~5000` socket server。
- `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-OSupu3Vu.js`
  - `@20412 runRemotePaneTool`（in-app pane 工具执行入口）。
- `/home/tars/yysapp/claude-desktop/app/.vite/build/claudePagePreview.js`
  - 全文：top frame 暴露 `claudeDesktopArtifactPane`；子帧处理 pointerdown/pointerlock；host-tools MessagePort。

### 11.4 渲染器 / ion-dist

- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist/assets/v1/cf580efe9-b-DCvKJg.js`
  - `@26292 startFromConfig`；`@35114 Manage allowed sites`；`@35409 Clear browsing data`；`@60741 openPreviewInBrowser`；`@69896 Reload`；`@91390 Go back`；`@91950 Select element` 说明。
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist/assets/v1/cccc2cf0a-B0D--VZp.js`
  - `@153631 framebuffer:port`；`@155104` worker 路径；`@160223 Cw` attach；`@160597` bridge unavailable；`@158458 sendPointer`；`@159111 sendScroll`；`@159418 sendKey`；`@161386 setStreamHints`。
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist/assets/framebufferCanvasWorker-DX2Rs-io.js`
  - 全文：ImageDecoder / createImageBitmap / OffscreenCanvas 2D / seq 丢旧帧 / bind/unbind/release。
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist/frame-shell.html`
  - artifact 壳、embedded/hostcaps/chrome 协商。
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist/client-shell-v1.html`
  - 严格 CSP、window.name handshake、sandbox iframe、MessageChannel。
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/ion-dist/assets/v1/shared-0-ByI5P0CP.js`
  - `globalThis["claude.web"].FramebufferPreview` 等 preload API 入口。

### 11.5 Chrome / native host / shim

- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/chrome-native-host`
  - `@100931 claude-mcp-browser-bridge-`
  - `@110862 Socket location`
  - `@118017 get_status`
  - `@118045 chrome-native-host 0.1.0`
  - `@118068 Entering main message loop`
  - `@118474 tool_response`
  - `@118505 permission_request`
  - `@118540 execute_tool`
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/claude-browser-shim.js`
  - 13-17 行：polyglot / 用途
  - 40-56 行：bridge config 校验（socket + 64 hex key）
  - 61-71 行：只中继 http(s) 无 userinfo
  - 87-114 行：Unix socket 请求/响应
  - 142-178 行：OS opener
- `/home/tars/yysapp/claude-desktop/app/package.json`
  - `@ant/rfb-client`（devDependency）、`playwright-core`（devDependency）、Electron/Forge 版本。

### 11.6 运行环境

- `/home/tars/yysapp/claude-desktop/app/package.json`：版本 2.42304.0。
- `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/app.asar`：生产打包内容；与 `app/` 解包内容一致的关键字符串（`FramebufferPreview`、`Launch_$_`）。

---

## 12. 证据等级汇总

### [已证实]

- 预览模型：`WebContentsView` 每 tab、容器 View、renderer 上报 bounds、show/hide/attach/detach/popout。
- 上下文/分区命名、storage 三档、启动/退出清理、session 删除清 jar。
- `loadHtmlPreview` 的 worktree 包含、`O_NOFOLLOW`、UNC/符号链接、大小上限、data: CSP。
- 导航守卫、`window.open` 策略、凭据剥离、私有网络/DNS 检查、外部站点 handoff。
- 权限默认拒绝（clipboard 例外）、media 拒绝、WebAuthn 取消、live stream arm。
- CDP 工具集与 `callRemoteBrowserTool` 的 guard/timeout/银行站点扣留。
- Chrome native host 名称、扩展 ID、manifest、socket 路径与 4-byte framing、Linux 安装/重启不支持。
- `$BROWSER` shim 的 env、key、socket、超时、回退。
- Framebuffer 的 IPC 面、canvas worker、帧 seq、输入事件、工具门控、像素 guard、用户接管拒绝。
- Linux 的 Chrome 路径、`/proc` 检测、KWallet/secret-tool、首帧 fallback。

### [推断]

- Framebuffer 底层是 VNC/RFB：来自 `@ant/rfb-client`、`vncUrl`、`serverFlavor`、`socketPath` 与工具描述；但本 build 未定位到会话执行体。
- 预览下载没有自定义 containment：只看到 `will-download` telemetry 与隐藏 tab 关闭；Electron 默认下载策略可能仍会弹保存框或落到 Downloads。
- 交互式 HTML content tab 的脚本策略比静态 CSP 宽松；具体边界需要实机验证。
- `autoVerify` 的实际行为（自动导航/自动检查）在 UI 之外没有完整追踪。
- `Annotate/sketch` 的绘制数据格式与持久化未追踪。
- `browser_navigation` 在主窗口上的具体 UI 入口（菜单/标题栏）未展开。

### [未知]

- Framebuffer `attach` 的真实 RPC 实现、RFB 握手、凭据认证、断线重连、帧编码（JPEG/PNG/H.264）在 Linux build 中的位置。
- 预览 session 是否设置自定义代理/证书校验；只确认 `local-pairing` 有证书 pin，cowork artifact partition 有黑洞代理。
- Chrome 扩展的完整 manifest/权限/内容脚本（deb 不含扩展本体）。
- 浏览器下载的最终保存目录与用户确认策略。
- 远端 blocklist 的 category 语义细节（category3/privateNetworkOnly 的完整映射）。
- `previewSketchShortcut` 之后的 sketch 数据流。
- `setArtifactPaneHost` 的真实实现（本 build 返回 false）。

---

## 13. 交接（10 条）

1. **核心对象**：`PreviewContext`（`uZ`）位于 `index.chunk-Z7WxBjyE.js` @4747565；每个 serverId 一个实例，内含 `containerView`、`tabs: Map<tabId, WebContentsView>`、`previewSession`、`mountGroup`、`gate`。
2. **布局主路径**：渲染器 `showPreview(serverId,{x,y,width,height,radius,parked},claimantId,targetWindowId)` → `ugi` @4859593 → `updateTabBounds` @4815487 → `containerView.setBounds` + 每个 tab `view.setBounds` + `setVisible(active)`。
3. **导航主路径**：`navigatePreview` → `xQ` @4917178；main frame 守卫 `handleMainFrameNavGuard` @4772889；决策表 `lUn` @3162698；模型授权 `M2i` @5457376 / `TBn` @3137358。
4. **本地内容路径**：`loadHtmlPreview` @5517239（文件/包含性）→ `RZ` @4850878；`loadHtmlPreviewContent` @5449179 → `tgi` @4857816（data: + CSP）。文本上限 2,097,024；内容 tab 源文件 524,288。
5. **截图/读取路径**：`iQ` @4886067、`v_i` @4879221、`y_i` @4879572、`Rvi` @4906661、`q_i` @4890660。模型读结果前必须过 `r3i/i3i` epoch 校验。
6. **工具层**：`BTGRIMpO`（preview_*）与 `Bb_jZsw8`（read_page/computer/...）；远程执行入口 `OSupu3Vu` @20412；`callRemoteBrowserTool` @5509767。
7. **Chrome 层**：`chrome-native-host` + `Launch` 无关的 `ChromeExtension` 服务 @5161237；socket 路径 @3920797；manifest @3923020；Linux 安装/重启不支持 @5160349/@5160480。
8. **Code session 链接**：`$BROWSER` 桥在 `index.chunk-DldNzPRj.js`，shim 在 `claude-browser-shim.js`；每 session 32-byte key，0600 socket。
9. **Framebuffer 层**：IPC @1916833，渲染 @cccc2cf0a @153631，worker `framebufferCanvasWorker-DX2Rs-io.js`，工具 @c1MnZbIW @73500；底层 VNC 执行体 [未知]。
10. **安全底线**：sandbox + contextIsolation + no node；权限默认拒绝；Allowed-sites/session grant + 用户手势 + 私有网络/DNS + 凭据剥离 + worktree 包含 + TOCTOU 校验。AutoAgent 应把这些作为 P0，而不是后补。
