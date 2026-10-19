# Claude Desktop 2.42304.0 Linux：平台集成与安全加固亮点

> 范围：`/home/tars/yysapp/claude-desktop/extracted`（rootfs、安装内容）、`/home/tars/yysapp/claude-desktop/control`（postinst/postrm/control）、`/home/tars/yysapp/claude-desktop/app`（Vite 构建产物与原生绑定）、以及已有证据 `research/terminal.md`、`file-system.md`、`browser-system.md`、`mcp-claude-desktop.md`、`asset/ida_native/`。
>
> 本文只做只读分析；未修改 `app/` 或 `extracted/`。除特别说明外，路径均为绝对路径。

---

## 1. 结论速览（按强度排序）

| 排名 | 亮点 | 为什么强 | 评级 | 关键证据 |
|---|---|---|---|---|
| 1 | **分区网络 kill-switch + 自检** | 对 Cowork artifact/file 预览会话设置固定代理 `http://255.255.255.255:9`，`proxyBypassRules:"<-loopback>"`，再主动请求 `https://127.0.0.1/`，只有代理返回 `PROXY 255.255.255.255:9` 才认为网络确实关闭；否则协议 handler 直接 `Response.error()`，不提供内容。 | S | `index.chunk-Z7WxBjyE.js` @4529448（`Kni`）、@5763379（`cowork-artifact` handler）、@4550398（`cowork-file` handler） |
| 2 | **“webContents 作用域 + 逐接口 origin + 参数/返回 schema”三层 IPC 信任** | 生成的 RPC 框架 `ro()` 为每个接口绑定一个 sender 校验器；方法参数与返回值都做 schema 校验；通道名固定且挂在 `webContents.ipc` 上。另有一个通用 `XNa(senderFrame)` 兜底（仅顶层 frame + Claude 主机）。 | S | `index.chunk-Z7WxBjyE.js` @532227（`ro`）、@6362827（`XNa`/`tj`）、@1581981（`Lg`）、@533335（`cSe`）、@6520372（`KUa`） |
| 3 | **fd-relative safe-fs：`*Beneath` + `openat2` + `O_NOFOLLOW` + dev/ino/nlink** | 原生 Rust 绑定暴露 `open_beneath`、`mkdir_beneath`、`rename_beneath`、`rmdir_beneath`、`stat_beneath`、`unlink_beneath`、`open_root_dir`；二进制含 `openat2`、`openBeneath`、`fstatat/statx/readlinkat/renameat2/unlinkat/mkdirat`。JS 层再叠逐段 `lstat`、realpath、`{dev,ino,mtime,size}` 与硬链接检查。关键点是：**原生绑定加载失败时拒绝退回路径式 open（CC-2885）**。 | S | `app/node_modules/@ant/claude-native/claude-native-binding.node` 字符串；`index.chunk-Z7WxBjyE.js` @252835（`zr`）、@284280（“refusing to fall back to a path-based open (CC-2885)”）；`research/file-system.md` §5.4 |
| 4 | **私网/DNS rebinding 防线的 fail-closed 实现** | `Jdi()` 通过 `session.resolveHost()` 解析主机名，命中 loopback/私网/主机接口地址/本机路由网段即拒绝；解析失败、超时、结果不明一律取消请求；缓存 60 秒、最多 512 项。另有 IPv4/IPv6 映射、CGNAT、链路本地（含 `169.254.169.254`）、组播、保留段、`localhost/.local/.internal/...` 后缀与单标签主机拒绝。 | S | `index.chunk-Z7WxBjyE.js` @4711688（`Jdi`）、@2434026（私网/保留段表）、@3091937（`WN` 接口/路由比对）、@3099240（`xP`）、@4713436（`YX/XX`） |
| 5 | **渲染器默认加固与导航默认拒绝** | 冻结的默认 webPreferences：`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、`nodeIntegrationInSubFrames:false`、`nodeIntegrationInWorker:false`、`webviewTag:false`、`navigateOnDragDrop:false`、`enableBlinkFeatures:""`、`devTools` 仅未打包时开启。artifact 窗口还 `will-navigate`/`will-redirect`/`will-frame-navigate`/`will-attach-webview` 全拒绝，`window.open` 走“点击信用 + opener 身份 + URL 允许表 + 上限”的门控。 | A+ | `index.chunk-Z7WxBjyE.js` @3188706（`aKn`）、@3190458、@3195017、@3203142、@6734054 |
| 6 | **自定义协议最小权限 + 每协议 CSP + Origin/Host 校验** | `app://localhost` handler 要求 hostname 为 `localhost`，且若带 `Origin` 必须等于 `app://localhost`，否则 403；`cowork-artifact://` 要求网络已关闭、artifact id 正则、路径解析受限、`Cache-Control:no-store`、`X-DNS-Prefetch-Control:off` 与专用 CSP；`cowork-file://` 权限全拒绝 + 请求允许表 + 根目录/保护区校验；`claude-media://` 使用内存 capability 或 HMAC 签名 URL。 | A+ | `index.chunk-Z7WxBjyE.js` @4365901、@6731986、@2790191（`app` 特权）、@5763379、@4549078、@6515608 |
| 7 | **企业/托管配置 fail-closed** | `/etc/claude-desktop/managed-settings.json` 用 `O_NOFOLLOW|O_NONBLOCK` 打开，`fstat` 必须是普通文件，且必须 **uid 0 且不可 group/world writable**；每个键声明 `failClosedValue`（如 `allowedWorkspaceFolders: []`、`disableDeepLinkRegistration: true`、`isDesktopExtensionSignatureRequired: true`）；配置不可读时把 `managed-settings-unreadable` 当作拒绝 `device` 表面的策略来源。 | A+ | `index.chunk-Z7WxBjyE.js` @868873、@831754、@3044990、@742769、@687317 |
| 8 | **Linux 打包生命周期本身是安全面** | apt 仓库自动注册使用独立 keyring + `signed-by=`（绝不全局信任）、`arch=amd64,arm64`、站点作用域 `unattended-upgrades`；`/etc/default/claude-desktop` **解析而非 source**；marker 区分“包管理”与“管理员自有”；写文件前 `rm -f` 防符号链接穿透；AppArmor userns profile 按 `abi/4.0` 门控；SUID `chrome-sandbox` 作为后备；postrm 对管理员自有文件保守。 | A | `/home/tars/yysapp/claude-desktop/control/postinst` L79-L232、L236-L281；`postrm` L50-L82 |
| 9 | **浏览器桥的 capability/文件系统双重认证** | 每个会话生成 32 字节随机 key，`CLAUDE_BROWSER_BRIDGE` JSON 同时携带 socket 路径与 key；服务端用 `timingSafeEqual` 比对；目录 `0700`、socket `0600`、目录名 `^ccd-br-[A-Za-z0-9]{6}$`、shim 用 `O_CREAT|O_EXCL|O_NOFOLLOW` 写入并校验 sha256；限制 32 连接、8 KiB 请求、3 秒超时。 | A | `index.chunk-DldNzPRj.js` @811、@2586；`index.chunk-Z7WxBjyE.js` @3356818、@3920826 |
| 10 | **Chrome native messaging 的“窄 manifest + 窄 socket”** | manifest `allowed_origins` 只列 3 个扩展 ID；socket 目录 `/tmp/claude-mcp-browser-bridge-<user>` 要求非符号链接、`0700`、属主为当前 uid；扩展 ID 不允许路径分隔符；清理“死 PID”的 stale socket；host 只通过 stdio 与 Chrome 说话。 | A | `index.chunk-Z7WxBjyE.js` @3289524、@3292038、@3356818；`resources/chrome-native-host` 字符串 |
| 11 | **Cowork Linux VM 的宿主/客体信任边界** | 静态 Go helper 以 `-socket` 启动；运行时目录在 `XDG_RUNTIME_DIR` 或 `/tmp/claude-cowork-<uid>`，要求普通目录、非符号链接、属主 uid、`0700`；socket 必须是非符号链接的 Unix socket；打包版强制用原生 `connectUnixSocketSameUid`（SO_PEERCRED），缺失则拒绝连接；RPC 4 字节大端长度 + JSON，最大 10 MiB，30 秒超时，5 次 RPC 重试（可触发 helper 重启）；vsock 随机 CID + `expectedCID` 校验；QEMU 带 `-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`（字符串证据，推断为 QEMU `-sandbox` 参数）。 | A- | `index.chunk-Z7WxBjyE.js` @2959289-2965538；`resources/cowork-linux-helper` 字符串；`resources/virtiofsd` |
| 12 | **SSH askpass 的每连接 FIFO + 进程身份校验** | 每条 SSH 连接写一份 `askpass.sh`，用 `p.fifo`/`a.fifo` 传递 `"<pid> <hint>\0<prompt>\0"` 与 `"<pid> Y/N..."`；Go 侧有 `verifyServer`、`peerOf`、`ancestry`、`frameProof`、`terminateParent`、`readRelayFile`、`dialRelay`；peer 校验失败报 “the socket is served by user %d / process %d, not the app”；relay 消失时用 `kill -TERM $PPID` 结束 ssh 而不是返回空密码。 | A- | `index.chunk-DCzX8ut3.js` @48770；`resources/claude-ssh-askpass` 字符串 |
| 13 | **更新路径在 Linux 上收敛到包管理器** | 本构建的更新状态报告把 `platformUnsupported` 固定为 true，并明确 “platform has no auto-update (updates via system package manager)”；apt 侧由 postinst 注册仓库，`unattended-upgrades` 站点作用域安装。另有安装失败计数（同一目标版本 ≥2 次失败记录）与 72 小时默认强制执行窗口（用于非 Linux 的 autoUpdater 路径）。 | B+ | `index.chunk-Z7WxBjyE.js` @4404297（`B6r`）、@5038127（诊断文案）、@4387724（`S3r=2`）；`postinst` L79-L181 |
| 14 | **GNOME Shell search provider 也做了输入/文件硬化** | D-Bus 激活的 GJS 脚本只读会话标题与 id；`Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS`、只接受普通文件、最多 500 个文件、每个 ≤10 MiB、只接受 `local_[A-Za-z0-9-]{1,64}` 会话 id、标签清洗双向控制字符并截断 80 字符、只打开 `claude://` URL。 | B+ | `resources/gnome-search-provider/searchProvider.js` L55-L175 |

**一句话总结**：这套设计的核心不是“多上几个开关”，而是把 **“不可信内容/不可信进程/不可信配置”** 三类输入都做成 **默认拒绝 + 身份可验证 + 失败即关闭 + 自检**：分区网络要自检确实关死，helper 连接要 SO_PEERCRED，文件系统要 fd 相对解析，托管配置要 root-owned + 逐键 fail-closed，协议 handler 要 Origin/Host + CSP。

---

## 2. 打包 / 安装图

### 2.1 包内容（本 deb，amd64）

```text
claude-desktop_2.42304.0_amd64.deb
├─ /usr/bin/claude-desktop -> ../lib/claude-desktop/claude-desktop
├─ /usr/lib/claude-desktop/
│  ├─ claude-desktop                         Electron 主程序（ELF）
│  ├─ chrome-sandbox                         SUID root，mode 4755
│  ├─ chrome_crashpad_handler
│  ├─ libffmpeg.so / libvulkan.so.1 / libvk_swiftshader.so
│  ├─ version                                内容：44.7.2
│  ├─ resources/
│  │  ├─ app.asar                            ~49 MB
│  │  ├─ app.asar.unpacked/node_modules/@ant/claude-native/claude-native-binding.node
│  │  ├─ chrome-native-host                  Rust ELF（动态链接 libc）
│  │  ├─ claude-ssh-askpass                  Go ELF（静态）
│  │  ├─ cowork-linux-helper                 Go ELF（静态）
│  │  ├─ virtiofsd                           Rust ELF（libseccomp/libcap-ng）
│  │  ├─ smol-bin.x64.img                    DOS/MBR，28 MB
│  │  ├─ gnome-search-provider/*.ini,*.service,searchProvider.js
│  │  ├─ linux-mime/com.anthropic.Claude.xml
│  │  └─ ion-dist/, locales/, *.json, 图标
│  └─ ...
├─ /usr/share/applications/com.anthropic.Claude.desktop
├─ /usr/share/icons/hicolor/{16,32,48,128,256}/apps/claude-desktop.png
└─ /usr/share/doc/claude-desktop/copyright
```

关键事实：

- `chrome-sandbox` 在 deb 中就是 `-rwsr-xr-x root/root`；不是 postinst 后 chmod 的。[已证实：`dpkg-deb --contents`]
- `/usr/bin/claude-desktop` 是指向 `/usr/lib/claude-desktop/claude-desktop` 的符号链接。[已证实：`extracted/usr/bin/claude-desktop`]
- `resources/bin/ccd` **本构建未提供**，所以 postinst 不会创建 `/usr/bin/ccd`。[已证实：`extracted/usr/lib/claude-desktop/resources` 无 `bin/`；postinst L62-L69]
- `.desktop` 的 `MimeType` 同时声明 `x-scheme-handler/claude`、`application/vnd.anthropic.mcpb`、`application/vnd.anthropic.skill`；`.dxt` 复用 mcpb 的 MIME 类型。[已证实：`com.anthropic.Claude.desktop` L16；`linux-mime/com.anthropic.Claude.xml`]

### 2.2 postinst（root）执行图

```text
dpkg configure
  └─ postinst (sh, set -e, DPKG_ROOT 支持)
     ├─ 1. AppArmor
     │    if /etc/apparmor.d/abi/4.0 存在:
     │      write /etc/apparmor.d/claude-desktop
     │        abi <abi/4.0>,
     │        profile claude-desktop /usr/lib/claude-desktop/claude-desktop flags=(unconfined) {
     │          userns,
     │          include if exists <local/claude-desktop>
     │        }
     │      apparmor_parser -r -W -T（仅在 aa-enabled 为真且非 DPKG_ROOT；失败不阻断安装）
     │    目的：Ubuntu 24.04+ 的 kernel.apparmor_restrict_unprivileged_userns=1 下，
     │          仍允许 Chromium 使用 user namespace sandbox；
     │          flags=(unconfined) 不是“限制应用”，只是“允许 userns”。
     ├─ 2. apt 仓库 + keyring
     │    write /usr/share/keyrings/claude-desktop-archive-keyring.asc（0644）
     │    write /etc/apt/sources.list.d/claude-desktop.list（0644）
     │      ### Managed by the claude-desktop package.
     │      deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc]
     │          https://downloads.claude.ai/claude-desktop/apt/stable stable main
     │    write /etc/apt/apt.conf.d/50claude-desktop
     │      Unattended-Upgrade::Origins-Pattern {
     │        "origin=Anthropic,archive=stable,site=downloads.claude.ai";
     │      };
     │    /etc/default/claude-desktop 用 sed 解析 CLAUDE_DESKTOP_ADD_REPO=true|false，
     │      不 source（避免 chroot/目标 rootfs 内容以宿主 root 执行）。
     │    已存在且首行无 marker 的 sources 文件视为管理员自有，不覆盖。
     ├─ 3. GNOME Shell search provider
     │    copy resources/gnome-search-provider/*.ini -> /usr/share/gnome-shell/search-providers/
     │    copy *.service -> /usr/share/dbus-1/services/
     │      Exec=/usr/bin/gjs -m /usr/lib/claude-desktop/resources/gnome-search-provider/searchProvider.js
     ├─ 4. MIME
     │    copy linux-mime/com.anthropic.Claude.xml -> /usr/share/mime/packages/
     │    update-mime-database /usr/share/mime（失败不阻断）
     └─ 5. ccd
          if resources/bin/ccd 存在且 /usr/bin/ccd 不存在:
            ln -s ../lib/claude-desktop/resources/bin/ccd /usr/bin/ccd
          （本构建没有该文件，所以无链接）
```

### 2.3 postrm（root）执行图

```text
dpkg remove|purge
  ├─ 删除 /etc/apparmor.d/claude-desktop（若 AppArmor 活跃则 parser -R；失败不阻断）
  ├─ apt：
  │    sources 首行为 marker -> 删除 sources
  │    sources 无 marker（管理员自有）且 action != purge -> 保留 keyring + unattended 片段
  │    purge -> 连 keyring/unattended 一起删
  ├─ 删除 GNOME search provider .ini/.service
  ├─ 删除 MIME XML 并 update-mime-database
  ├─ 删除精确目标为 ../lib/claude-desktop/resources/bin/ccd 的 /usr/bin/ccd 链接
  └─ 不进入用户 home：~/.config/autostart、各浏览器 NativeMessagingHosts manifest 留给用户/下次登录清理
```

### 2.4 安装生命周期里的安全设计

| 设计 | 说明 | 证据 |
|---|---|---|
| 独立 keyring + `signed-by=` | apt 信任只作用于该仓库，不写全局 trusted.gpg | postinst L99-L106、L159 |
| `arch=amd64,arm64` | 仓库只索引这两个架构，避免 multiarch 系统每次 `apt update` 报 foreign arch | postinst L150-L160 |
| 站点作用域 unattended-upgrades | 用 `site=downloads.claude.ai` 防止同 Origin 的其他仓库被顺带放行 | postinst L163-L181 |
| marker 所有权 | 首行 marker 区分“包管理”与“管理员自有”；管理员自有文件永不被包覆盖/删除（purge 除外） | postinst L94-L97、L224-L229；postrm L50-L70 |
| 解析而非 source | `/etc/default/claude-desktop` 只接受精确 true/false，避免目标 rootfs 代码以宿主 root 执行 | postinst L196-L213 |
| 写前 `rm -f` | 避免 `cat >` 穿透预先放置的符号链接；注释明确不防御父目录符号链接（dpkg 本身也跟随） | postinst L107-L116、L150-L151、L254-L255 |
| AppArmor 门控 | 只在 `/etc/apparmor.d/abi/4.0` 存在时写 profile；AppArmor 3.x 上不可解析，直接使用 SUID 后备 | postinst L236-L274 |
| `flags=(unconfined)` | 不限制应用，只授予 userns；和 SUID sandbox 形成 belt-and-suspenders | postinst L240-L265 |
| postrm 保守 | 不做 `rm -rf` 式清理；不触碰用户 home；admin-owned 源在 remove 时保留 keyring | postrm L50-L82 |
| 单实例 / 深链 | `requestSingleInstanceLock()`；`second-instance` 做 argv 去重、超长 argv 重新拉起并 cap、激活 token 交给已有实例；`.desktop` 用 `SingleMainWindow=true` 抑制 GNOME 默认“New Window”；深链注册受 `disableDeepLinkRegistration` 控制 | `index.chunk-Z7WxBjyE.js` @6744702；`postinst`/`postrm` 不注册 scheme，注册由 app 的 `setAsDefaultProtocolClient` 完成 |
| 无 conffiles / 不创建 `/etc/default` | 升级不会留下 dpkg conffile 冲突；管理员文件由管理员自己创建 | postrm 头注释 L6-L7 |

**评价**：apt 自动注册是“VS Code / Chrome / 1Password 模式”，对终端用户友好，但对企业镜像/离线环境属于有侵入性的行为。Anthropic 用 `CLAUDE_DESKTOP_ADD_REPO` 和 marker 所有权做了可退出与可共存设计，这是加分项；仍然建议企业部署时显式写入 `false`，避免 dpkg 安装改变 apt 配置面。

---

## 3. 安全分层表

| 层 | 机制 | 关键实现 | 强度/备注 |
|---|---|---|---|
| **OS/打包** | AppArmor userns + SUID sandbox | Ubuntu 24.04+ 的 userns 限制下允许 unprivileged userns；`chrome-sandbox` 4755 作为后备 | 强；但 AppArmor profile 是 `unconfined`，真正隔离来自 Chromium sandbox |
| **进程沙箱** | Electron sandbox + Chromium namespaces | 默认 `sandbox:true`；所有远程/预览内容在独立 renderer 进程 | 强；主窗口未显式覆盖，依赖 Electron 默认（推断）；远程内容另用显式 `WebContentsView` |
| **渲染器/视图** | 冻结 webPreferences | `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、`nodeIntegrationInSubFrames:false`、`nodeIntegrationInWorker:false`、`webviewTag:false`、`navigateOnDragDrop:false`、`enableBlinkFeatures:""`、`devTools` 仅 dev | 强；Claude page 预览是一个显式的 `nodeIntegrationInSubFrames:true` 例外，但仍 sandbox/contextIsolation，preload 仅暴露 artifact pane |
| **preload 表面** | contextBridge 白名单 | `mainView` 暴露 12 个命名空间（含 managed/enterprise/telemetry 三个同源别名）；`claudePagePreview` 只暴露 `claudeDesktopArtifactPane`；`process` 只透传 `arch/platform/type/versions` | 强；比直接暴露 `ipcRenderer` 好得多 |
| **导航** | 默认拒绝 | `will-navigate`/`will-redirect`/`will-frame-navigate`/`will-attach-webview` 全 preventDefault；`setWindowOpenHandler` 默认 deny；仅在“点击信用 + opener 身份 + URL 允许表 + 上限”时放行弹出 | 强；点击信用窗口约 5 秒 |
| **权限** | 默认拒绝 + 条件放行 | `setPermissionRequestHandler`/`setPermissionCheckHandler` 默认 `false`；预览只允许 `clipboard-sanitized-write`（主 frame、loopback 或 GDrive 上下文、可见且 active tab）；摄像头/麦克风一律拒绝；屏幕共享用 15 秒 armed 记录 + processId/routingId/url 精确匹配 | 强；`deny` 时记录 telemetry 并通知 renderer |
| **自定义协议** | 最小权限 + 专用 CSP | `app`（standard/secure/supportFetchAPI/allowServiceWorkers）、`cowork-artifact`（standard/secure/supportFetchAPI）、`cowork-file`（+stream）、`claude-media`（+stream/bypassCSP）、`claude-simulator`（+stream/bypassCSP/supportFetchAPI/corsEnabled） | 强，但协议数量和 `bypassCSP` 面需要重点审 |
| **IPC** | 作用域 + origin + schema | `webContents.ipc` 每视图独立注册；`ro()` 校验 sender、参数、返回值；`XNa` 仅顶层 frame + Claude host；部分接口只校验顶层 frame（About/Quick/TitleBar） | 强；`XNa` 的 host 检查只接受配置基域及其 `.ai/.com` 兄弟域 |
| **网络（分区）** | 假代理 kill-switch + 自检 | `http://255.255.255.255:9`、`<-loopback>`、主动探测 `https://127.0.0.1/` 并核对 `PROXY 255.255.255.255:9` | 很强；失败时协议 handler 拒绝服务内容 |
| **网络（公网/私网）** | 解析后比对接口/路由 | `resolveHost` + 本机接口地址 + 本机路由网段；解析失败/超时/不明 → cancel；60 秒缓存 | 很强；比静态 RFC1918 列表更抗 DNS rebinding |
| **文件系统** | fd-relative containment | 原生 `*_beneath` + `openat2` + `O_NOFOLLOW` + `fstatat/statx` + dev/ino/nlink；JS 逐段 lstat/realpath/根包含 | 很强；这是“真正的 openat2 风格”而不是字符串前缀判断 |
| **文件系统（策略）** | 根集合 + carve-out + consent | 会话选中目录、outputs、uploads、`.projects`、autoMemory、只读插件；保护 `.claude`/凭据目录 carve-out；单文件首次同意，默认按钮为 Cancel | 强；父目录信任继承是可用性 vs 安全性的已知取舍 |
| **凭据** | safeStorage / libsecret | `safeStorage.isEncryptionAvailable()` + 加解密往返自检；后端枚举 `basic_text|gnome_libsecret|kwallet|kwallet5|kwallet6|unknown`；不可用则抛 `SafeStorageUnavailableError`，不落明文 | 强；Linux 依赖 `libsecret-1-0` + `gnome-keyring|plasma-workspace` |
| **URL/凭据** | 剥离 userinfo + 外链白名单 | `Vjn` 去掉 username/password，对已知 Claude/白名单主机把 `http:` 升级为 `https:`；`Hjn` 拒绝带 userinfo 的深链；`openPreviewInBrowser` 只允许 `http(s)`，非 loopback 去掉 query/hash；`mailto:`/自定义协议不由 `shell.openExternal` 触发 | 强；server redirect 带 userinfo 也会被拦截 |
| **本地 helper IPC** | SO_PEERCRED + 目录/socket 属主 | `connect_unix_socket_same_uid`；打包版缺失即拒绝；`/tmp/claude-cowork-<uid>` 0700、非符号链接、uid 匹配；socket 0600、非符号链接、uid 匹配 | 很强；这是 Linux 上最容易被忽略、也最值得抄的一层 |
| **浏览器桥** | per-session capability + fs 校验 | 32 字节 key + `timingSafeEqual`；0700/0600；O_EXCL|O_NOFOLLOW 写 shim；sha256 校验；32 连接/8 KiB/3 秒上限 | 很强；适合任何“本机 agent 与浏览器/CLI 通信”的场景 |
| **VM** | QEMU + vsock + virtiofsd | 静态 Go helper；随机 CID + expected CID；QEMU seccomp sandbox；virtiofsd seccomp/cap-ng；宿主 CA 注入 + 代理配置 | 强但复杂；需要实机验证 guest→host 网络/文件共享边界 |
| **企业策略** | 逐键 fail-closed | root-owned 且不可 group/world writable + O_NOFOLLOW；不可读→deny device surfaces；`allowedWorkspaceFolders: []`、`disableDeepLinkRegistration: true`、`isDesktopExtensionSignatureRequired: true` | 很强；适合金融/医疗等强合规场景 |
| **更新** | 包管理器 + 失败熔断 | Linux `platformUnsupported=true`，apt 负责更新；失败安装记录同版本 ≥2 次；默认 72 小时 enforcement | 中上；没有发现应用驱动的 rollback |
| **遥测/日志** | 固定枚举 + 脱敏 | `safeStorage` 后端、版本、平台、GPU、协议、错误码等固定枚举；避免用户文本 | 中上；细节见已有各专项报告 |

---

## 4. 平台 helper 说明

| 二进制 | 语言/链接 | 角色 | 安全设计 | 注意点 |
|---|---|---|---|---|
| `chrome-native-host` | Rust（tokio 1.47、socket2、log4rs；动态链接 libc） | Chrome/Chromium 扩展的 native messaging host；stdio 与浏览器说话，Unix socket 与桌面 app 说话 | manifest `allowed_origins` 仅 3 个扩展 ID；socket 目录 `/tmp/claude-mcp-browser-bridge-<user>`；目录非符号链接、0700、uid 匹配；扩展 ID 不含路径分隔符；清理死 PID socket；app 侧再次校验目录与 socket | `0.sock` 路径位于 `/tmp`；依赖目录权限与 uid，未在该二进制看到显式 per-session secret（app 侧有 `connectVerified` 路径）[推断] |
| `claude-ssh-askpass` | Go，静态链接 | 只回答 Claude app 发起的 SSH 密码/确认提示；直接运行不做任何事 | 环境变量 `CLAUDE_SSH_ASKPASS_RELAY`、`CLAUDE_SSH_ASKPASS_BROKER`；FIFO 协议带 PID；`verifyServer`/`peerOf`/`ancestry`/`frameProof`/`terminateParent`；peer 不匹配报 “served by user/process … not the app” | FIFO 放在每条连接的控制目录；必须保证 0700/uid；这是“终端/SSH 自动化”最值得抄的模式 |
| `cowork-linux-helper` | Go，静态链接（`coworkd/cmd/cowork-linux-helper`） | Cowork VM 的宿主侧 supervisor：QEMU、virtiofsd、vsock RPC、生命周期 | `-socket` 启动；runtime dir `/tmp/claude-cowork-<uid>` 或 `XDG_RUNTIME_DIR`；目录 0700/非符号链接/uid；socket 必须 Unix socket 且 uid 匹配；打包版强制 `connectUnixSocketSameUid`；RPC 4 字节大端长度 + JSON，10 MiB/30 秒/5 次重试；vsock 随机 CID + expected CID；QEMU `-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny` | 复杂度最高；guest 网络使用 QEMU user networking（`user,id=net0`），并有 `hostLoopbackIP`/`apiProbeURL`/代理字段；guest→host 边界的完整隔离需要实机验证 [未知] |
| `virtiofsd` | Rust（上游 virtiofsd；libseccomp/libcap-ng） | 把宿主目录以 virtio-fs 共享给 guest | `--shared-dir`、`--socket-path`；seccomp/cap-ng；每个 VM 独立 socket | 依赖系统 `libseccomp.so.2`、`libcap-ng.so.0`；不是静态二进制 |
| `smol-bin.x64.img` | DOS/MBR 小镜像（28 MB，partition 1 Type 0x0c / FAT32 LBA，startsector 2048） | 可选 guest 启动/工具镜像；helper 在找不到时仍可“booting without it” | 作为 QEMU `-drive` 使用；路径由 helper 校验 | 具体用途（agent 二进制盘 vs 最小 rootfs）未完全确认 [推断] |
| `claude-native-binding.node` | Rust N-API（动态链接 libpipewire） | 所有需要 syscall/平台 API 的热点：safe-fs、same-UID socket、进程谱系、X11/Wayland 捕获、剪贴板、硬件密钥/DPAPI 等平台差异 | `open_beneath`/`mkdir_beneath`/`rename_beneath`/`rmdir_beneath`/`stat_beneath`/`unlink_beneath`/`open_root_dir`/`clone_at`；`connect_unix_socket_same_uid`；`get_process_lineage`/`read_process_tree`/`read_process_creation_time`；`cu_wayland_*`；`hardware_key_*`/`user_dpapi_*`（按平台） | 原生绑定缺失时 safe-fs 拒绝退回路径式 open；打包版 helper 连接也拒绝无 peer 校验 |
| `ccd` / `ccd-ssh` | 本构建未提供 `ccd` 二进制；`ccd-ssh` 是控制目录前缀 | `ccd` 终端启动器（条件安装）；`ccd-ssh-*` 为 SSH 控制目录 | postinst 只创建精确目标链接；`ccd-ssh-` 目录要求 `isDirectory && uid==当前用户 && mode==0700`；OpenSSH askpass 生成 `askpass.sh` + FIFO | 本构建无 `/usr/bin/ccd`；不要把“postinst 支持”误读为“本包已安装” |

### 4.1 为什么用 Rust/Go

- **Rust native host / native addon**：需要异步 IO、Unix socket、native messaging framing、N-API 边界；Rust 提供内存安全与较小的运行时依赖。native addon 只依赖 `libpipewire`/`libc`/`libgcc`/`libm`。
- **Go helper / askpass**：静态链接、无运行时依赖，适合在受限用户环境、SSH 子进程、QEMU supervisor 中长期运行；Go 的 `os/exec`、`net`、`syscall`、`/proc` 处理足够直接。
- **virtiofsd**：上游 Rust 实现，带 seccomp/cap-ng，适合处理不可信 guest 的文件请求。
- 这套分工的共同点是：**把需要特权的系统调用放进小而专的原生进程，把策略和 UI 留在 Electron 主进程**；Electron 主进程自身不直接做危险 syscall。

### 4.2 PipeWire / Wayland / X11

- deb 依赖 `libpipewire-0.3-0`、`xdg-desktop-portal`、`xdg-desktop-portal-gtk|gnome|kde`；native addon 的 `NEEDED` 明确包含 `libpipewire-0.3.so.0`。[已证实]
- 二进制字符串包含 `org.freedesktop.portal.ScreenCast`、`org.freedesktop.portal.RemoteDesktop`、`SelectSources`、`Start`、`restore_token`、`persist_mode`、`wayland: pipewire:`、`spawn pipewire thread` 等。[已证实]
- X11 路径使用 `XGetInputFocus`/`XQueryTree`/`NET_ACTIVE_WINDOW` 等，`XTest` 由 `libxtst6` 依赖与 `cu_*` 输入函数推断；Wayland 路径走 portal + PipeWire；两者通过同一组 `cu_*` 原生函数暴露。[已证实：X11 字符串/依赖；XTest 为推断]
- 会话类型检测：`XDG_SESSION_TYPE` 优先，否则 `WAYLAND_DISPLAY`；`XDG_CURRENT_DESKTOP` 只保留 `[A-Za-z0-9:-]{1,64}` 用于遥测。[已证实]

**Linux 特有 caveat**

- `libpipewire-0.3-0` 与 `xdg-desktop-portal*` 是 hard Depends，说明屏幕共享/输入捕获被视为核心能力；QEMU/OVMF/virtiofsd 是 Recommends，缺失时 Cowork VM 不可用，但主应用可运行。[已证实：`control/control` Depends/Recommends]
- GNOME search provider 的 D-Bus service 直接 `Exec=/usr/bin/gjs`，但 deb 没有显式依赖 `gjs`；GNOME Shell 环境通常自带，非 GNOME 环境该服务会失败，不影响主应用。[已证实 service 文件；依赖假设为推断]
- VM 需要 `/dev/kvm`、`/dev/vhost-vsock`、对应内核模块、OVMF 与可执行的 `virtiofsd`；这些条件在应用内有专门的 readiness 检查与 `kvm_permission_denied`/`vhost_vsock_module_missing` 等状态。[已证实：`index.chunk-Z7WxBjyE.js` @2956574]

---

## 5. 亮点评级：哪些是真强，哪些是过度设计

### 5.1 真正强的设计

| 设计 | 评级 | 理由 |
|---|---|---|
| 网络 kill-switch **自检** | S | 大多数产品只是“设个代理就算关网”；这里主动验证代理确实生效，失败则拒绝内容。 |
| fd-relative safe-fs + 原生强制 | S | `*Beneath` + `openat2` + `O_NOFOLLOW` + dev/ino/nlink 是 Linux 上正确的 TOCTOU/符号链接防御方式；并且明确拒绝无原生绑定的路径回退。 |
| SO_PEERCRED same-UID helper | S | 在 Linux 桌面应用里非常少见；把“同用户”当成最小信任边界，比文件权限更直接。 |
| 逐接口 IPC origin + schema | S | 不是“全局一个 if”，而是每个接口独立校验器 + 参数/返回 schema；显著降低 renderer 被 XSS 后的横向能力。 |
| 托管配置 fail-closed | A+ | root-owned + O_NOFOLLOW + 逐键 failClosedValue + 不可读即 deny；这是企业策略应有的默认。 |
| 分区 + 每协议 CSP | A+ | 把“内容来源”与“网络能力”绑定，避免预览/artifact 变成 SSRF/数据外带通道。 |
| 浏览器桥 capability | A | per-session key + timingSafeEqual + 文件系统校验 + 大小/连接/超时上限，工程完整度高。 |
| apt 仓库注册细节 | A | 独立 keyring、signed-by、站点作用域、marker 所有权、解析不 source、写前 rm -f，细节到位。 |
| GNOME search provider | B+ | 一个“搜索提供器”都做了 NOFOLLOW、普通文件、大小/数量上限、标签清洗，说明安全基线是统一的。 |

### 5.2 偏复杂 / 值得警惕的设计

| 设计 | 评级 | 问题 |
|---|---|---|
| 同时维护 AppArmor userns + SUID chrome-sandbox | B+ | 作为兼容性后备是合理的，但两套沙箱路径增加测试矩阵；SUID 二进制本身是高风险面。 |
| 5+ 个自定义协议（`app`、`cowork-artifact`、`cowork-file`、`claude-media`、`claude-simulator`，另有 custom-3p） | B | 每个协议都有不同 privilege 组合与 CSP；`claude-media`/`claude-simulator` 使用 `bypassCSP`，审计面大。建议未来收敛为一个“受控资源协议 + 权限参数”。 |
| `app://localhost` 的 `allowServiceWorkers:true` | B | service worker 持久化会扩大持久化攻击面；虽然内容来自打包资源，仍建议评估是否必须。 |
| `cowork-artifact` 的 window.open 点击信用模型 | B+ | 设计很强（点击时间、opener 身份、URL 允许表、上限、throwaway guest），但状态机复杂，容易出现“信用泄漏/重放”类 bug。 |
| Cowork QEMU/vsock/virtiofsd | B | 安全边界设计合理，但组件多、平台依赖多（`/dev/kvm`、`/dev/vhost-vsock`、OVMF、virtiofsd），可观测性和故障面大。guest 网络/共享边界需要独立审计。 |
| 更新策略（stagedVersion、maxVersion、enforcementHours、失败熔断） | B | 对非 Linux 平台是必要的企业能力；在 Linux 上 `platformUnsupported=true`，大部分逻辑不生效，形成“代码复杂度与实际路径不匹配”。 |
| 父目录信任继承（`hasTrustDialogAccepted`） | B- | 信任 `~` 等于信任其全部子目录；AutoAgent 若采用 grant 模型，应避免宽泛继承，至少在 UI 显示继承来源。 |
| 无应用驱动 rollback | C+ | 只找到失败安装计数（同版本 ≥2 次），没有找到自动回滚/上一版本保留；Linux 侧可依赖 apt 手动降级，但不是产品级 rollback。 |
| 下载路径没有 containment | C+ | 已有报告指出 `will-download` 只记录目录用于遥测，未发现强制下载目录/路径包含策略；这是预览/浏览器路径的一个缺口。 |

### 5.3 明确的“不要抄”

- 不要为了“看起来安全”给所有自定义协议开 `bypassCSP`；只对确有需要的流式资源开，并且用 HMAC/短 TTL capability 限制。
- 不要把“自动注册 apt 仓库”当成所有 Electron 应用的标准动作；没有发行版签名基础设施时，这会变成供应链风险。
- 不要照搬“父目录信任继承”；AutoAgent 的 SafeFileService 应使用显式 grant + 精确路径。
- 不要把“unconfined AppArmor profile”误读为“应用被限制”；它只是允许 userns。
- 不要在没有 SO_PEERCRED 等价物（Windows named pipe ACL / macOS audit token）的平台上退化为“只靠 socket 文件权限”。

---

## 6. AutoAgent 借鉴清单

> 前提：AutoAgent 已有 loopback + token + Origin 校验、`WebContentsView`、`SafeFileService`。下面只列“增量/强化”，不重复已有能力。

### P0（必须先做）

1. **本机 helper 的 same-UID 认证**
   - Linux：Unix socket + `SO_PEERCRED`（uid/pid）；Windows：named pipe DACL + `GetNamedPipeClientProcessId`；macOS：`LOCAL_PEERCRED`/audit token。
   - 打包版**禁止**在认证不可用时退回 `connect()`；开发版才允许显式 warning 降级。
   - 对应 Claude：`connect_unix_socket_same_uid`、`connectUnixSocketSameUid` 缺失即拒绝。
2. **所有 IPC 的 sender 校验统一化**
   - 顶层 frame + 精确 origin（不要用 `startsWith`）+ 参数/返回 schema。
   - 每个 `WebContentsView` 使用自己的 `webContents.ipc`，不要全局 `ipcMain` 共享通道。
   - 对本地文件视图（about/quick/titlebar）至少校验“顶层 frame + 绑定到该 webContents”，不能只校验 channel 名。
3. **SafeFileService 强化为 fd-relative**
   - 使用 `openat2(RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS)`（或等价实现的 `openBeneath`），禁止字符串前缀判断。
   - 打开后 `fstat`/`statx` 校验 `dev/ino/mode/nlink`；最终组件 `O_NOFOLLOW`；父目录逐段 `lstat`/realpath。
   - 原生实现不可用时拒绝服务，不要回退到 `os.open(path)`。
4. **受管/企业配置 fail-closed**
   - Linux `/etc/autoagent/managed-settings.json`：root-owned、不可 group/world writable、`O_NOFOLLOW|O_NONBLOCK`、`fstat` 必须是普通文件。
   - 每个 key 明确 `failClosedValue`；文件不可读/非法时按 failClosed 值执行，并把“策略不可读”作为拒绝高风险表面的理由。
5. **渲染器默认值冻结**
   - `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、`nodeIntegrationInSubFrames:false`、`nodeIntegrationInWorker:false`、`webviewTag:false`、`navigateOnDragDrop:false`、`enableBlinkFeatures:""`。
   - `devTools` 仅在未打包时开启；所有 `will-navigate`/`will-redirect`/`will-frame-navigate`/`will-attach-webview` 默认 deny。
6. **私网/元数据地址 fail-closed**
   - 在“只允许公网”或“托管浏览”上下文，先解析再决策；解析失败/超时/结果不明取消请求。
   - 拒绝 loopback、RFC1918、CGNAT、link-local（含 `169.254.169.254`）、组播、保留段、IPv4-mapped IPv6、`localhost/.local/.internal` 等；并比对本机接口/路由，而不仅是静态表。
7. **权限默认拒绝**
   - `setPermissionRequestHandler`/`setPermissionCheckHandler` 默认 `false`；只对明确允许的能力（如剪贴板 sanitized write）在“主 frame + 可见 + active tab + 特定 origin”条件下放行。
   - 摄像头/麦克风在预览视图一律拒绝；屏幕共享使用短时“armed”记录 + processId/routingId/url 精确匹配。

### P1（强烈建议）

1. **本地配对证书 SPKI pinning**
   - `session.fromPartition("local-pairing",{cache:false})` + `setCertificateVerifyProc`；只接受预置 SPKI SHA-256 链，证书错误直接失败，不 `-3` 放行未知链。
   - 配合 loopback OAuth/配对服务器的 `Host` 头校验、`state` 校验、`default-src 'none'`、`X-Content-Type-Options: nosniff`。
2. **协议最小权限 + 每协议 CSP**
   - 自定义协议只开必要 privilege；不要默认 `bypassCSP`/`corsEnabled`。
   - 资源协议用 capability：随机 token 或 HMAC(session|path|ttl)，配合短 TTL、条数上限、大小上限；返回 `no-store`、`X-DNS-Prefetch-Control:off`。
   - 对 `app://` 等本地 SPA 协议校验 `Host` 与 `Origin`；注意“无 Origin 请求”要单独定义策略，不能默认放行所有无 Origin 请求。
   - 把 `autoagent://` 当作 `app://localhost` 的同类：固定 host、校验 `Origin`/`Host`、最小 privilege、专用 CSP；不要复用“多种 bypassCSP 协议并存”的复杂度。
3. **浏览器/CLI 桥的 capability**
   - 每会话 32 字节随机 key；JSON 信封 `{v,key,url}`；`timingSafeEqual`；目录 0700、socket 0600、目录名严格正则；shim 用 `O_EXCL|O_NOFOLLOW` + sha256 内容校验；连接数/请求大小/超时上限。
4. **SSH/命令提示的进程身份校验**
   - 用 per-connection FIFO/管道；消息带 PID + 类型；校验 peer uid/pid 与进程谱系；relay 消失时终止父进程而不是返回空凭据。
   - 直接运行 askpass 时输出说明并退出，不做任何提示。
5. **分区隔离**
   - 按 workspace/session/static/cowork 分 session；退出/删除会话时 `clearData()` + `clearAuthCache()`。
   - 对“不允许联网”的预览分区，设置不可达代理 + 主动自检；自检失败就不要提供内容。
6. **safeStorage 不可用即失败**
   - 不要落明文；记录 `SafeStorageUnavailableError` 并提示用户/管理员。
   - Linux 明确依赖 libsecret/kwallet；对外提供后端枚举用于诊断。
7. **下载/导出路径 containment**
   - 这是 Claude 本身未完全覆盖的点：为 AutoAgent 定义固定下载目录、规范化路径、`open("wx")` 独占创建、写后 `dev/ino/nlink` 校验、失败删除。
8. **自定义文件类型处理**
   - `.mcpb/.dxt/.skill` 这类“压缩包/脚本包”在 double-click 时走严格 manifest 校验、签名策略（fail-closed）、解压路径穿越防护、大小/条目上限；不要直接执行包内命令。

### P2（按需）

1. **AppArmor userns profile + SUID 后备**（仅 Linux 桌面分发；需要有 dpkg/rpm 生命周期管理）。
2. **apt 仓库自动注册 + unattended-upgrades 站点作用域**（仅当你确实有签名仓库与发布流水线；否则不要做）。
3. **GNOME Shell search provider**：若做，必须 NOFOLLOW、普通文件、数量/大小上限、标签清洗、只读、只打开自己的 scheme。
4. **PipeWire/portal 捕获**：优先 Wayland portal + PipeWire；X11 仅作为 fallback；对捕获会话做短时授权与“用户主动结束”处理。
5. **QEMU/vsock/virtiofsd 隔离**：只有在确实需要“不可信执行环境”时才引入；否则优先进程级沙箱 + 明确的工作目录。
6. **更新失败熔断**：记录“同版本安装失败次数”，达到阈值后停止自动重试并提示；比“无限重试”安全。

### 不要照搬

- 不要给所有协议开 `bypassCSP`。
- 不要自动改 apt 源而没有显式企业 opt-out。
- 不要用父目录信任继承代替显式 grant。
- 不要在原生安全能力缺失时静默退回不安全路径。
- 不要把“AppArmor profile”当作实际 confinement。

---

## 7. [已证实] / [推断] / [未知]

### [已证实]

- postinst 写入 AppArmor profile、apt keyring/sources/unattended、GNOME search provider、MIME，并条件创建 `/usr/bin/ccd` 链接；postrm 按 marker 保守清理。（`control/postinst` L79-L281；`control/postrm` L50-L82）
- AppArmor profile 为 `flags=(unconfined)` + `userns,`，只在 `/etc/apparmor.d/abi/4.0` 存在时写；加载失败不阻断安装。（postinst L236-L274）
- apt keyring 使用独立 `signed-by=`、`arch=amd64,arm64`、站点作用域 unattended pattern；`/etc/default/claude-desktop` 解析不 source；写前 `rm -f` 防符号链接。（postinst L99-L232）
- `chrome-sandbox` 在 deb 中为 SUID 4755；`/usr/bin/claude-desktop` 为符号链接。（`dpkg-deb --contents`；`extracted/usr/bin/claude-desktop`）
- 本构建未提供 `resources/bin/ccd`，所以 postinst 不会创建 `/usr/bin/ccd`。（`extracted/usr/lib/claude-desktop/resources`；postinst L62-L69）
- `.desktop` 注册 `x-scheme-handler/claude`、`application/vnd.anthropic.mcpb`、`application/vnd.anthropic.skill`，并带 NewChat/NewCode actions、`SingleMainWindow=true`、`StartupWMClass=com.anthropic.Claude`。
- MIME XML 将 `.mcpb`/`.dxt` 映射到 `application/vnd.anthropic.mcpb`，`.skill` 映射到 `application/vnd.anthropic.skill`，均为 zip 子类。
- 默认 webPreferences 冻结值：`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、`nodeIntegrationInSubFrames:false`、`nodeIntegrationInWorker:false`、`webviewTag:false`、`navigateOnDragDrop:false`、`enableBlinkFeatures:""`、`devTools` 仅未打包开启。（`index.chunk-Z7WxBjyE.js` @3188706）
- 远程预览视图显式 `sandbox:true`/`contextIsolation:true`/`nodeIntegration:false`/`focusOnNavigation:false`/`disableDialogs:true`；Claude page 预览是 `nodeIntegrationInSubFrames:true` 例外，但仍有 sandbox/contextIsolation 且 preload 仅暴露 `claudeDesktopArtifactPane`。（`index.chunk-Z7WxBjyE.js` @4741242、@4757692；`claudePagePreview.js`）
- IPC 框架 `ro()` 对每个接口执行 sender 校验 + 参数 schema + 返回 schema；`XNa` 仅允许顶层 frame 且 host 命中 Claude 域名/其 `.ai/.com` 兄弟域；部分本地视图接口只校验顶层 frame。（`index.chunk-Z7WxBjyE.js` @532227、@6362827、@3018215、@533335）
- `app://localhost` handler 校验 hostname，若存在 `Origin` 则必须等于 `app://localhost`，否则 403。（`index.chunk-Z7WxBjyE.js` @4365901）
- `cowork-artifact`/`cowork-file` 分区权限全拒绝、请求允许表、假代理自检；`cowork-artifact` 响应带 CSP/no-store/DNS-prefetch-off；`cowork-file` 校验根目录/保护区并限制读取大小。（`index.chunk-Z7WxBjyE.js` @5763379、@4550398、@4549078）
- `claude-media` 使用内存随机 capability（`v/<16-byte>`）或 HMAC 签名（`s/...?sig=`），10 MiB 上限、约 6 小时空闲 TTL（`216e5` ms）、最多 64 项、dev/ino/nlink 检查。（`index.chunk-Z7WxBjyE.js` @6515608、@6516143）
- 假代理常量为 `255.255.255.255:9`，自检目标 `https://127.0.0.1/`，期望 `PROXY 255.255.255.255:9`；失败返回 false 并记录 telemetry。（@4529448）
- 私网/DNS rebinding：`resolveHost` + 本机接口/路由比对 + 解析失败 fail-closed + 60 秒缓存；拒绝 loopback/私网/CGNAT/link-local/组播/保留段/IPv4-mapped IPv6 与本地后缀。（@4711688、@2434026、@3091937、@3099240）
- 原生绑定暴露 `open_beneath`/`mkdir_beneath`/`rename_beneath`/`rmdir_beneath`/`stat_beneath`/`unlink_beneath`/`open_root_dir`/`clone_at`/`connect_unix_socket_same_uid`/`get_process_lineage`/`cu_wayland_*` 等；二进制含 `openat2`、`openBeneath`、`SO_PEERCRED`、`fstatat`、`statx`、`readlinkat`、`renameat2`、`unlinkat`、`mkdirat` 字符串和 `libpipewire` 依赖。（`app/node_modules/@ant/claude-native/claude-native-binding.node` 字符串与 `NEEDED`）
- Safe-fs 在原生绑定缺失时明确拒绝路径回退（CC-2885）。（`index.chunk-Z7WxBjyE.js` @284280）
- 浏览器桥：per-session 32 字节 key、`timingSafeEqual`、目录 0700、socket 0600、`ccd-br-[A-Za-z0-9]{6}`、`O_EXCL|O_NOFOLLOW`、sha256 shim 校验、32 连接/8 KiB/3 秒上限。（`index.chunk-DldNzPRj.js` @811、@2586）
- Chrome native host manifest `allowed_origins` 仅 3 个扩展 ID；socket 目录 `/tmp/claude-mcp-browser-bridge-<user>`，要求非符号链接/0700/uid，清理死 PID socket。（`index.chunk-Z7WxBjyE.js` @3289524、@3292038、@3356818）
- Cowork helper 运行时目录 `/tmp/claude-cowork-<uid>`（或 `XDG_RUNTIME_DIR`）要求 0700/非符号链接/uid；socket 要求 Unix socket/非符号链接/uid；打包版强制 `connectUnixSocketSameUid`；RPC 10 MiB/30 秒/5 次重试；vsock expected CID；QEMU sandbox 字符串存在。（`index.chunk-Z7WxBjyE.js` @2959289-2965538；`resources/cowork-linux-helper` 字符串）
- Cowork helper 字符串含 `[vm] installed %d host CA certificates in guest`、`httpProxy`/`httpsProxy`/`noProxy`/`pacScript`/`hostLoopbackIP`/`apiProbeURL`、`user,id=net0`、`--shared-dir`、`--socket-path`、`root=/dev/vda1 ro`、`console=hvc0` 等。（`resources/cowork-linux-helper`）
- askpass：`CLAUDE_SSH_ASKPASS_RELAY/BROKER`、`SSH_ASKPASS_PROMPT`、FIFO `p.fifo`/`a.fifo`、PID 标签、`verifyServer`/`peerOf`/`ancestry`/`frameProof`/`terminateParent`、peer 不匹配错误文案。（`index.chunk-DCzX8ut3.js` @48770；`resources/claude-ssh-askpass` 字符串）
- 托管配置：Linux 路径 `/etc/claude-desktop/managed-settings.json`；`O_NOFOLLOW|O_NONBLOCK`；普通文件；uid 0 且不可 group/world writable；逐键 `failClosedValue`；不可读时 `managed-settings-unreadable` 拒绝 device 表面；`allowedWorkspaceFolders` fail-closed 为空数组；`disableDeepLinkRegistration`/`isDesktopExtensionSignatureRequired` fail-closed 为 true。（`index.chunk-Z7WxBjyE.js` @868873、@831754、@3044990、@742769、@687317）
- `--desktop-managed-config=` 通过 `additionalArguments` 传给 preload，preload 暴露 `desktopManagedConfig`/`desktopEnterpriseConfig`/`desktopTelemetryConfig`/`deviceClass`/`preferredSystemLanguages`。（`mainView.js`；`index.chunk-Z7WxBjyE.js` @4092334）
- `disableConnectorSignInInApp` 会忽略 `mcp-auth-callback` 的 `step=finish` 深链；`disableDeepLinkRegistration` 会调用 `removeAsDefaultProtocolClient`。（@3259193、@3246851）
- Linux 更新报告 `platformUnsupported:true`，并明确“updates via system package manager”；安装失败计数阈值 `S3r=2`；默认 `enforcementHours` 为 72。（@4404297、@5038127、@4387724）
- GNOME search provider 使用 NOFOLLOW、只读普通文件、500 文件/10 MiB 上限、会话 id 正则、标签清洗、只打开 `claude://`。（`searchProvider.js` L55-L175）
- 安全存储：`safeStorage.isEncryptionAvailable()` + 加解密往返自检；后端枚举；不可用抛 `SafeStorageUnavailableError`。（@995540、@1459085、@2115526）
- 进程谱系/原生能力：`get_process_lineage`、`read_process_tree`、`read_process_creation_time`、`read_process_footprints`、`hardware_key_*`、`user_dpapi_*` 均出现在原生导出字符串中。（`claude-native-binding.node`）

### [推断]

- `open_beneath` 使用 `openat2` 且很可能带 `RESOLVE_BENEATH`；字符串确认了 `openat2` 与 `openBeneath`，但未直接看到 `RESOLVE_BENEATH` 常量。
- `chrome-native-host` 与 app 的 socket 协议除目录/socket 权限外，可能还有 app 侧的 `connectVerified` 或协议级握手；二进制中只看到 version/ping/status 等消息，完整认证语义未展开。
- Cowork guest 通过 `hostLoopbackIP` 访问宿主 loopback API；`user,id=net0` 表明使用 QEMU user-mode NAT，但 guest→host 的完整可达边界需要实机验证。
- `smol-bin.x64.img` 是可选 guest 工具/启动镜像；从“booting without it”与 `-drive` 字符串推断，不是必需 rootfs。
- Linux 上 `disableAutoUpdates` 主要影响应用内 autoUpdater（本构建 `platformUnsupported=true`），不太可能阻止 apt/unattended-upgrades 的包更新；需要结合策略说明。
- 扩展签名校验的算法与信任根未在本次证据中展开；只确认了 `isDesktopExtensionSignatureRequired` 策略键及 fail-closed 语义。
- `cSe`（About/Quick/TitleBar）只校验顶层 frame，安全性依赖这些 handler 绑定到特定 `webContents.ipc`，而非全局 `ipcMain`；代码结构支持这一点，但未逐条动态验证。

### [未知]

- **应用驱动的更新回滚**：未找到 rollback/上一版本保留/自动降级的实现；只找到失败安装计数与 enforcement window。Linux 侧可通过 apt 手动降级，但不是产品级 rollback。
- **Electron fuses 的实际位值**：构建链引用 `@electron-forge/plugin-fuses` 与 `@electron/fuses`，但本次未读取二进制中的 fuse 状态（RunAsNode、NodeOptions、OnlyLoadAppFromAsar、EmbeddedAsarIntegrityValidation 等）。
- **下载路径 containment**：已有报告指出未发现强制下载目录/路径包含策略；本次复核未推翻该结论。
- **guest 内文件共享的细粒度策略**：virtiofsd `--shared-dir` 之外，是否对 guest 的写入/删除/重命名做额外 clamp，未在本次证据中展开。
- **Chrome native host 的协议级认证**：是否对每条转发请求做额外 token/来源校验，未完全确认。
- **原生 addon 的 `hardware_key_*` 在 Linux 是否实际启用**：字符串存在，但 Linux 更可能使用 safeStorage/libsecret；平台分支未逐条验证。
- **自定义协议 `bypassCSP` 的实际风险边界**：`claude-media`/`claude-simulator` 的 handler 只提供流式资源，但 service worker / 导航组合的完整风险未做动态测试。

---

## 8. Handoff（10 条）

1. **先抄“同 UID 原生 IPC”**：Linux 用 `SO_PEERCRED`，Windows 用 named pipe DACL + client PID，macOS 用 audit token；打包版禁止无认证回退。
2. **把 safe-fs 从路径校验升级为 fd 相对**：`openat2(RESOLVE_BENEATH)`/`openBeneath` + `O_NOFOLLOW` + `fstat/statx` dev/ino/nlink；原生不可用即拒绝服务。
3. **IPC 统一到“每 WebContents + 每接口 origin + schema”**：不要用一个全局 `ipcMain` 加零散 if；顶层 frame 是必要条件，不是充分条件。
4. **对“不允许联网”的预览分区做假代理 + 主动自检**：`255.255.255.255:9` + `<-loopback>` + 探测 `https://127.0.0.1/`；自检失败就不返回内容。
5. **私网/DNS rebinding 采用“解析后比对接口/路由 + 解析失败即拒绝”**，不要只维护静态 RFC1918 列表。
6. **托管配置按 key 声明 failClosedValue**：root/Administrator-owned、`O_NOFOLLOW`、普通文件、非 group/world writable；不可读即按最严格值执行。
7. **本地配对用 SPKI pinning + Host/state 校验 + `default-src 'none'`**；不要依赖系统 CA 的默认信任。
8. **浏览器/CLI 桥用 per-session capability**：32 字节 key、`timingSafeEqual`、0700/0600、O_EXCL|O_NOFOLLOW、shim sha256、连接/大小/超时上限。
9. **SSH/askpass 用 per-connection FIFO + PID/进程谱系 + peer 校验**；relay 消失时终止 ssh，不要返回空答案。
10. **Linux 更新故事收敛到包管理器**：apt 仓库用独立 keyring + `signed-by` + 站点作用域 unattended；不要假装 Electron autoUpdater 在 Linux 可用；同时补上失败安装熔断，rollback 明确列为后续工作。

---

### 附：主要证据索引

| 主题 | 文件/位置 |
|---|---|
| 安装脚本 | `/home/tars/yysapp/claude-desktop/control/postinst`、`postrm`、`control` |
| desktop/MIME/search | `/home/tars/yysapp/claude-desktop/extracted/usr/share/applications/com.anthropic.Claude.desktop`；`.../resources/linux-mime/com.anthropic.Claude.xml`；`.../resources/gnome-search-provider/*` |
| 主 bundle | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` |
| preload | `/home/tars/yysapp/claude-desktop/app/.vite/build/mainView.js`、`claudePagePreview.js`、`mainWindow.js`、`coworkArtifact.js` |
| browser shim | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-DldNzPRj.js` |
| SSH askpass relay | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-DCzX8ut3.js` |
| 原生绑定 | `/home/tars/yysapp/claude-desktop/app/node_modules/@ant/claude-native/claude-native-binding.node` |
| helpers | `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/{chrome-native-host,claude-ssh-askpass,cowork-linux-helper,virtiofsd,smol-bin.x64.img}` |
| 原生导入/汇总 | `/home/tars/yysapp/claude-desktop/asset/ida_native/imports.json`；`/home/tars/yysapp/claude-desktop/asset/rea_summary.json` |
| 既有专项 | `research/browser-system.md` §6；`research/file-system.md` §5；`research/terminal.md` §5/§5.7；`research/mcp-claude-desktop.md` §8 |
