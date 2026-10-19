# Claude Desktop 2.42304.0 Linux 文件系统实现：端到端逆向研究

> 研究对象：`/home/tars/yysapp/claude-desktop/app`（Vite 打包后的主进程/预加载/worker JS）与 `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources`。
> 原生证据：`/home/tars/yysapp/claude-desktop/asset/ida_native/`（对 `@ant/claude-native` N-API addon 的 IDA 导出）与直接读取同一 `.node` 的字符串。
> 证据标记：**[已证实]** 来自反编译/字符串/结构化证据；**[推断]** 由代码路径与字符串强推但未逐条验证；**[未知]** 未找到或无法确认。
> 所有 JS 偏移均为对应压缩单行文件中的字符偏移（0-based），用于复核；原生偏移为文件偏移（hex）。

---

## 0. 结论速览

1. **两层 API**：渲染进程（`https://claude.ai` / `.com` / `app://localhost`）通过预加载脚本暴露的 `claude.web.FileSystem` 和 `claude.settings.FilePickers` 调用主进程；FileSystem 有 19 个方法，FilePickers 有 2 个方法。另有 `CoworkUserFiles`、`CoworkStorage`、`CoworkSpaces`、`LocalSessions` 提供会话/空间级文件能力。[已证实]
2. **统一 IPC 契约**：所有服务由 `ro(prefix, service, senderValidator, {methods, events})` 注册。通道名为硬编码前缀 + `服务名_$_方法名`，主进程用 `ipcMain.handle`；入参按命名位置校验、返回值再校验；返回信封固定为 `{result}` 或 `{error: string}`。错误码不会跨 IPC 保留，只剩 message。[已证实]
3. **文件访问的核心是一个集中校验器** `validateLocalFileAccess`（`index.chunk-B1NUaAKC.js`）：要求绝对路径、拒绝 UNC、限定 `local_*` 会话（云端 CCR 仅读路径例外）、拒绝危险扩展名/文件名、计算允许根集合、解析符号链接、realpath、校验“解析后仍在根内”、检测路径在读取/同意期间被替换，最后才允许读取/打开/写入。[已证实]
4. **safe-fs 原生模块是强制的**：addon 加载失败时 `getClaudeNativeOrThrow()` 直接抛错，拒绝回退到基于路径字符串的 open（错误信息明确引用 CC-2885）。JS 侧封装 `openBeneath/openRootDir/statBeneath/mkdirBeneath/renameBeneath/unlinkBeneath/rmdirBeneath`；addon 内可见 `openat2`、`readlinkat`、`symlinkat`、`renameat2`、`unlinkat`、`FICLONE` 等字符串。[已证实字符串；具体 openat2 flags 为推断]
5. **读取上限**：`readLocalFile` 主机/VM 均为 **50 MiB**；会话文本文件 **10 MiB**、会话图片 **10 MiB**、媒体 **50 MiB**、面板文档 **25 MiB**；Cowork Space 单文件读取 **50 MiB**。文本/二进制判定：MIME 为 text/* 或若干 application 类型，或前 8192 字节无 NUL（且扩展名不是 `.plugin/.skill`）则 UTF-8；否则 base64。[已证实]
6. **写入不是原子的**：`writeLocalFile` 直接 `open(O_WRONLY|O_CREAT|O_NOFOLLOW)` 后 `truncate(0)` 再写入 UTF-8 字符串；没有 temp+rename，也没有 fsync。会话 `writeSessionFile` 同样是原地写，但支持 expectedHash 冲突检测。`createSessionFile` 用 `wx` 独占创建；下载文件用最终文件名的独占创建（不覆盖），不是先写临时文件。[已证实]
7. **路径模型**：`app.getPath("userData")`（Linux 通常 `~/.config/Claude`）下是 `local-agent-mode-sessions/<acct8>/<org8>/`、`scratch-workspaces/`、`pending-uploads/`、`cowork-user-files/`、`cowork-managed/`、`cowork-file-preview/` 等。Cowork 用户文件根默认 `~/Claude`，历史根 `Documents/Claude`，最终兜底 `userData/cowork-user-files`，可通过设置迁移。[已证实]
8. **会话目录**：每个会话目录包含 `outputs/`、`uploads/`、`.claude/`、`.projects/<projectUuid>/`、`host-cwd/`（平台代码另有 `/var/empty` 占位常量），会话记录为 `<accountDir>/<sessionId>.json`；agent 会话位于 `<accountDir>/agent/`。VM 内路径为 `/sessions/<vmProcessName>/...`，挂载点常见 `/mnt/<mountName>`、`/mnt/uploads`、`/mnt/.claude/cowork_plugins/`。[已证实]
9. **信任模型**：工作区信任存放在 Claude 配置的 `projects[path].hasTrustDialogAccepted`（通常即 `~/.claude.json`），并沿父目录继承；scratch workspace 创建时以 literalKeyOnly 方式标记可信。会话内另有 `userSelectedFolders/resolvedFolders` 与 `userApprovedFileAccessPaths`，分别表示“文件夹授权”和“单文件读/打开授权”。[已证实]
10. **选择器/拖放/粘贴**：目录和文件选择均走 Electron `dialog.showOpenDialog`（支持多选、默认路径记忆、管理员根限制）；拖放通过预加载暴露的 `claudeAppSettings.filePickers.getPathForFile`（Electron `webUtils.getPathForFile`）；粘贴文件保存到 `pending-uploads/<account>/<org>/<uuid>-<basename>`，目录 0700、文件 0600。[已证实]
11. **索引/搜索**：独立 utility process `file-index-worker`。路径索引优先 `git ls-files --recurse-submodules`（cwd 下最多 16 个子仓库），失败回退深度 4 / 200 目录 / 2000 条目的浅 BFS；内容搜索优先 `rg --json`，失败回退 `git grep --no-index`；每文件最多 6 条命中，默认总上限 200，忽略 `node_modules` 等重目录。索引是内存结构，没有发现磁盘索引库。[已证实]
12. **浏览/预览**：缩略图只接受本机会话的 `.png/.jpg/.jpeg/.gif/.webp/.bmp`，文件 ≤20 MiB、像素 ≤50M、最大边 ≤2048，返回 dataURL；`whichApplication/appInfoForExtension` 使用原生 `getAppInfoForFileAsync`，后者对 docx/pdf/md 通过 `userData/ext-icon-probe/probe.<ext>` 探测并缓存。[已证实]
13. **导出/清理**：Google Drive 导出读上限 30 MiB、18 分钟超时、同组织校验、HIPAA 门控；Cowork 归档导出到 Downloads，凭据文件/符号链接/特殊文件被跳过或脱敏，按 <4 GiB / <60k 条分卷；Cowork 清理接受 30/60/90 天窗口（stale 计数展示 30/90），preview 发 token，run 必须带 token，usage 缓存 60 秒。[已证实]
14. **Linux 重点**：路径逻辑跨平台但包含大量 Windows UNC/WSL/automount 防御；Linux 上 TCC 相关函数是 `NotSupported` 存根；资源中存在 `virtiofsd` 与 `cowork-linux-helper`（静态 ELF），说明 Linux Cowork VM 使用 virtiofs 挂载；`materializeDatalessFile` 在非 macOS 返回 ENOTSUP。[已证实]

---

## 1. 架构与数据流

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Renderer / claude.ai web app                                               │
│  window["claude.web"].FileSystem.*      window["claude.settings"]...       │
│  window.claudeAppSettings.filePickers.getPathForFile(File)  (drag&drop)    │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ ipcRenderer.invoke(channel, ...positionalArgs)
┌───────────────────────────────▼────────────────────────────────────────────┐
│ Preload (mainView.js)                                                      │
│  - exposes only explicit namespaces via contextBridge                     │
│  - channel prefix: $eipc_message$_958...claude.web_$_                     │
│                    $eipc_message$_958...claude.settings_$_                │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────────────┐
│ Main process: service dispatcher `ro()`                                    │
│  1) sender origin/top-frame check (`yy` / `Lg`)                            │
│  2) named positional arg validation (`aSe`)                                │
│  3) handler implementation                                                 │
│  4) output validation (`nSe`)                                              │
│  5) reply `{result}` or `{error: message}`                                 │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │                               │
┌───────────────▼────────────────┐   ┌──────────▼────────────────────────────┐
│ FileSystem handler             │   │ LocalSessions / CoworkSpaces / ...     │
│  browse*/list*/read/write/...  │   │  session file access, spaces, storage  │
└───────────────┬────────────────┘   └──────────┬────────────────────────────┘
                │                               │
┌───────────────▼───────────────────────────────▼────────────────────────────┐
│ LocalFileAccessValidator (B1NUaAKC)  /  SessionFileAccess (BvLvPLAH)       │
│  - absolute / UNC / extension / basename gates                             │
│  - session lookup + allowed root set                                       │
│  - symlink chain + realpath + path-moved checks                            │
│  - per-file consent (read/open only)                                       │
│  - admin allowlist + read-only roots                                       │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │                               │
┌───────────────▼────────────────┐   ┌──────────▼────────────────────────────┐
│ @ant/claude-native (Rust/N-API)│   │ Node fs / Electron APIs                │
│  openBeneath/openRootDir/...   │   │  readdir/stat/realpath/open/caps       │
│  openat2 + fd-relative checks  │   │  shell.openPath/showItemInFolder        │
└───────────────┬────────────────┘   └──────────┬────────────────────────────┘
                │                               │
┌───────────────▼───────────────────────────────▼────────────────────────────┐
│ Filesystem: userData, ~/Claude, Documents/Claude, Downloads, VM mounts     │
└────────────────────────────────────────────────────────────────────────────┘

旁路：utility processes（MessagePort）
  file-index-worker        : 路径模糊索引 + rg/git grep 内容搜索
  transcript-search-worker : 会话 JSONL 检索
  heavy-work-worker        : 目录用量、归档导出、复制、scratch carry
  cowork-linux-helper/virtiofsd : Linux Cowork VM 挂载（资源存在）
```

关键数据流：

1. **读取本地文件**：renderer `FileSystem.readLocalFile(sessionId,path)` → main handler → `readLocalFileImpl` → `validateLocalFileAccess` → `checkFileAccessConsent`（首次）→ 再次 symlink-free 检查 → `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` → `fstat` 与路径 `lstat` 比对 dev/ino → 读满上限 → text/base64 编码 → `{result}`。
2. **写入本地文件**：`writeLocalFile(sessionId,path,content:string)` → `validateLocalFileAccess`（无逐个文件同意）→ `open(O_WRONLY|O_CREAT|O_NOFOLLOW)` → `fstat` + 路径 symlink-free + dev/ino 比对 → `truncate(0)` → `writeFile(content,"utf-8")`。
3. **下载**：`writeFileDownload(filename,url)` → 校验 filename / URL host → `electron.net.fetch`（或 Cowork VM outputs 读取）→ `Downloads` 解析并做相对路径检查 → 以最终文件名 `wx` 独占创建并流式写入 → 句柄与路径身份复核 → 返回绝对路径。
4. **索引**：`Resources.setFocusedCwd` → 主进程 `swr()` → worker `stage-git-listing`/`set-entries` → worker 内构建路径索引；`searchFileContents` → worker `content-search` → `rg`/`git grep` → 结果回传。
5. **目录变更**：renderer 调用 `LocalSessions.watchSessionDirectories({sessionId,watchId,dirPaths})` → 主进程 SessionDirectoryWatcher（`fs.watch`）→ 去抖/令牌桶 → `sessionDirectoryChanged` 事件。

---

## 2. IPC 协议与信封

### 2.1 通道命名

- 前缀常量（`cy`）：`$eipc_message$_958332a8-5ab7-4169-a3ed-b963307a26b1_$_claude.web_$_`
- 设置类前缀（`Ig`）：`$eipc_message$_958332a8-5ab7-4169-a3ed-b963307a26b1_$_claude.settings_$_`
- 完整通道：`<prefix><Service>_$_<method>`，例如
  `...claude.web_$_FileSystem_$_readLocalFile`
  `...claude.settings_$_FilePickers_$_getFilePath`
- 事件：`<prefix><Service>_$_<event>`；另有 store 事件后缀 `_$store$_`。[已证实]

### 2.2 注册与校验

`ro()` 的实现要点：

- 发送者校验（`yy`/`Lg`）：要求 `senderFrame.parent === null`（顶层 frame），且 origin 必须是：
  `https://claude.ai`、`https://preview.claude.ai`、`https://claude.com`、`https://preview.claude.com`、`app://localhost`；开发覆盖时允许 localhost 或 `*.ant.dev`。
- 入参：`aSe` 逐个调用方法的 validator；失败抛出含接口名、方法名、参数名、位置的错误。
- 返回：handler 返回值再经输出 validator；失败抛 “Result ... failed to pass validation”。
- 异步方法：`ipcMain.handle`；回复固定为 `{result: value}` 或 `{error: message}`。
- 同步方法（本文件相关服务基本未使用）：`ipcMain.on` + `event.returnValue`。
- 调用方拿不到结构化错误码；`LocalFileAccessError.code` 只存在于主进程内部，跨 IPC 后退化为 message 字符串。[已证实]

### 2.3 错误语义

`LocalFileAccessError` 的主要 code（内部）：

| code | 触发 |
|---|---|
| `INVALID_SESSION` | 非 `local_*` 会话、未知会话、跨组织 |
| `INVALID_PATH` | 非绝对路径、UNC、危险文件名、不安全符号链接、路径解析失败 |
| `PATH_TRAVERSAL` | VM 路径 `/sessions/..` 等 |
| `BLOCKED_EXTENSION` | 二进制/可执行扩展名、可执行权限文件 |
| `PERMISSION_DENIED` | `EACCES/EPERM` |
| `NOT_FOUND` | `ENOENT/ENOTDIR` |
| `PATH_NOT_ALLOWED` | 根外、符号链接替换、移动、写入只读位置 |
| `USER_DENIED` | 用户拒绝 consent |
| `FILE_TOO_LARGE` | 超过读取上限 |
| `FILE_READ_ERROR` / `FILE_WRITE_ERROR` | 其他 I/O 失败 |
| `VM_UNAVAILABLE` | 云端 VM addon 不可用 |

---

## 3. API / 协议表

### 3.1 FileSystem（19 个方法）

契约定义：`index.chunk-Z7WxBjyE.js` @ 1929976 起（`ro(cy,"FileSystem",yy,{...})`）；主进程实现 @ 6273600–6282000；具体实现分派到 `index.chunk-B1NUaAKC.js`。

| 方法 | 输入 | 输出 | 限制与行为 |
|---|---|---|---|
| `writeFileDownloadAndOpen` | `filename:string, url:string` | `string \| null`（落盘路径） | 先走 download；随后 `Hb(path)` 必须 symlink-free 且 `lstat().isFile()`；`shell.openPath`，失败则 `showItemInFolder`；拒绝非普通文件 |
| `writeFileDownload` | `filename:string, url:string` | `string \| null` | filename 过滤控制字符/非 ASCII 空白/`\ / :`/尾随点空格/可执行扩展名；URL host 必须属于 Claude 主域；Downloads 目录内相对检查；独占创建，不覆盖（冲突加 `_1`）；无显式字节上限（流式）[已证实；上限未知] |
| `whichApplication` | `filename:string` | `{appName, appIconBase64?} \| null` | 有扩展名时以扩展名为缓存键（30 秒）；无扩展名或扩展名 >32 字符时直接调用原生 `getAppInfoForFileAsync` |
| `appInfoForExtension` | `extension:string` | 同上 | 只允许 `docx/pdf/md`；在 `userData/ext-icon-probe/probe.<ext>` 写空探针文件后查询；缓存 30 秒 |
| `browseFolder` | `title, restrictToHomeDir?, validateAsCoworkMount?, wslDistro?` | `string \| null` | Electron 目录选择器；默认路径记忆；管理员根检查；可拒绝 cowork 保护挂载；取消返回 null |
| `browseFolders` | `title, restrictToHomeDir?, validateAsCoworkMount?` | `string[] \| null` | 多选目录；逐个 canonicalize/管理员检查；跳过受保护目录并弹提示 |
| `listDirectory` | `dirPath:string` | `{directories:string[], error?:string, missing?:boolean}` | 只返回直接子目录名并排序；UNC/junction-to-UNC 拒绝；管理员根限制；ENOENT/ENOTDIR 标记 `missing` |
| `getSystemPath` | `pathType: downloads\|documents\|pictures\|music\|videos\|desktop\|home` | `string \| null` | 映射到 `app.getPath`；未知类型返回 null |
| `openLocalFile` | `sessionId, path, showInFolder?` | `void` | `showInFolder=true` 时只 reveal；否则校验 + consent + open sink；xlsx 有额外的 web-origin 标记逻辑 |
| `listFilesInFolder` | `sessionId, folderPath` | `{name,path,isDirectory,link?}[]` | 会话必须存在且有 `userSelectedFolders`；路径必须位于这些文件夹内；目录必须是目录；完整 readdir（无条数上限）；符号链接目录会 stat 后标记 |
| `readLocalFile` | `sessionId, path` | `{content,mimeType,fileName,encoding?,checkedPlainFile?} \| null` | 50 MiB 上限；文本/二进制判定；本地会话、CCR 云端只读路径例外；consent；TOCTOU 复核 |
| `getLocalFileThumbnail` | `sessionId, path, maxSize:number` | `{dataUrl,width,height} \| null` | 仅本机会话、仅图片扩展；`maxSize` clamp 1..512；文件 ≤20 MiB；像素 ≤50M；输出最大边 ≤2048；nativeImage resize quality good |
| `writeLocalFile` | `sessionId, path, content:string` | `boolean` | 只写 UTF-8 字符串；无逐文件 consent；O_NOFOLLOW；覆盖前 truncate；拒绝 uploads（只读附件）和管理员只读目录；无显式尺寸上限（字符串） |
| `showInFolder` | `path:string` | `boolean` | 独立于会话；限速 10 次/10 秒；绝对路径；UNC 守卫；Downloads 内的符号链接路径额外拒绝；`shell.showItemInFolder` |
| `savePastedFile` | `base64, mimeType, filename` | `{path?, error?}` | 保存到 `pending-uploads`（登录后按 account/org 分目录）；`UUID-<basename>`；目录 0700、文件 0600；mimeType 仅作参数未参与校验；无显式大小上限 [未知] |
| `browseFiles` | `title` | `string[] \| null` | 多文件选择；无路径校验（仅返回用户选择） |
| `browseFile` | `title, cwd?` | `{folder,name,relPath?} \| null` | 单文件；默认路径记忆；可选 cwd 约束；符号链接解析并返回相对 cwd 的 relPath；管理员根检查 |
| `exportLocalFileToGoogleDrive` | `sessionId, path` | `{driveUrl?,driveFileId?,errorCode?,mcpServerId?,mcpServerUrl?}` | 文件 ≤30 MiB；180 秒超时；会话组织必须等于当前组织；HIPAA 门控；POST multipart 到 `/api/organizations/<org>/cowork/export-to-google-drive` |
| `promoteScratchpadFile` | `sessionId, path` | `{hostPath,vmOutputsPath}` | 只接受 `/sessions/` VM 路径且必须等于该会话 vmProcessName；复制到 outputs；返回宿主/VM 路径并通知会话 |

### 3.2 FilePickers（`claude.settings`，2 个方法）

| 方法 | 输入 | 输出 | 行为 |
|---|---|---|---|
| `getDirectoryPath` | `multiple:boolean` | `string[]` | Electron `openDirectory`，`multiple` 时加 `multiSelections`；取消返回空数组 |
| `getFilePath` | `multiple:boolean` | `string[]` | Electron `openFile`，`multiple` 时多选；取消返回空数组 |

拖放补充：`mainView.js` 预加载暴露 `claudeAppSettings.filePickers.getPathForFile = (file) => webUtils.getPathForFile(file)`，使 renderer 能把拖入的 `File` 变成绝对路径。这是 Electron 新版移除 `File.path` 后的标准做法。[已证实]

### 3.3 CoworkUserFiles（4 个方法）

契约 @ 1924973。

| 方法 | 输入 | 输出 | 行为 |
|---|---|---|---|
| `getInfo` | 无 | `{currentRoot, homeRoot, isLegacyDocumentsRoot, managedRoot?}` | 报告当前 Cowork 用户文件根、`~/Claude`、是否历史 Documents 根、managed 根 |
| `pickTarget` | 无 | `{path} \| null` | 目录选择器，默认 `~/Claude`，允许创建目录 |
| `migrate` | `targetRoot:string` | `{ok, newRoot?, errorCode?}` | 有运行中会话则拒绝；校验目标（UNC、在当前根内部、不可写、home 交叉等）；递归复制并切换指针；重启应用 |
| `reveal` | 无 | `void` | 在文件管理器中显示 Cowork 数据 |

`migrate` 错误码：`sessions-running`、`target-invalid`、`target-unc`、`target-inside-current`、`target-not-writable`、`copy-failed`、`state-write-failed`。[已证实]

### 3.4 CoworkStorage（10 个方法）

契约 @ 1924715；实现 @ 5964102–5977500。

| 方法 | 输入 | 输出 | 行为 |
|---|---|---|---|
| `getCounts` | 无 | `{count,chatCount,stale:[{olderThanDays,count}]}` | 只统计非 hidden 会话；stale 窗口 30/90 天 |
| `getUsage` | `refresh?:boolean` | usage 对象或 null | 目录用量扫描；60 秒缓存；扫描超时 240 秒；分解 transcripts/attachments/generated/plugin/other/VM |
| `reveal` | 无 | `void` | 显示会话数据目录 |
| `previewCleanup` | `window: "30"\|"60"\|"90"` | `{preview?, errorCode?}` | 生成候选计划并签发一次性 token；返回条数、字节、云副本数、示例、不可验证数 |
| `runCleanup` | `token:string` | `{deletedCount,skippedCount,failedCount,failedInUseCount?,cancelled,errorCode?}` | 必须持有有效 token；通过 `deleteSessionFully` 删除会话目录与记录；跳过运行中/固定/最近使用/已变化项；非第三方部署要求在线；支持取消；进度事件 |
| `cancelCleanup` | 无 | `void` | 取消当前清理 |
| `exportTask` | `sessionId` | `{status, skippedCount?, skippedByReason?}` | 导出单个任务到 Downloads 归档 |
| `exportProject` | `spaceId` | 同上 | 导出 Space（CLAUDE.md、project.json、memory） |
| `exportAll` | 无 | 同上 | 导出整个 accountStorageDir |
| 事件 `cleanupProgress` | — | `{done,total}` | 清理进度 |

### 3.5 CoworkSpaces 文件相关方法

契约 @ 1926281 起。Space 的允许根 = `space.folders[].path` + auto memory dir。

| 方法 | 输入 | 输出 | 行为/限制 |
|---|---|---|---|
| `listFolderContents` | `spaceId, folderPath` | `{name,path,isDirectory}[]` | 绝对路径；隐藏/临时/OS junk 过滤；路径必须在 Space 根内且不落入保护位置 |
| `readFileContents` | `spaceId, filePath, options?{plainFileOnly}` | `{content,mimeType,fileName,encoding?,checkedPlainFile?} \| null` | ≤50 MiB；可选 plain-file 路径走 fd 级校验；同上编码规则 |
| `openFile` | `spaceId, filePath` | `boolean` | 先做扩展名/可执行检查，再 `shell.openPath` |
| `createSpaceFolder` | `parentPath, folderName` | `string \| null` | `join(parent,name)`；重名自动加 ` (n)`；递归 mkdir；仅做 NUL/UNC 守卫，未见 `folderName` 的 `..`/分隔符或目标包含性检查 [潜在风险] |
| `copyFilesToSpaceFolder` | `spaceId, filePaths[]` | `boolean` | 目标为 Space 第一个 folder；目录会 `addFolderToSpace`，文件流式复制；跳过受保护目标/危险 basename |
| `getAutoMemoryDir` | `spaceId` | `string \| null` | `<accountDir>/spaces/<spaceId>/memory` |
| `readSpaceMemoryIndex` | `spaceId` | `string \| null` | 读取 memory/MEMORY.md（功能门控） |

### 3.6 LocalSessions 文件相关方法

契约 @ 1944900 起；实现分派到 `index.chunk-B4uTve_e.js` 与 `index.chunk-BvLvPLAH.js`。

| 方法 | 输入 | 输出 | 限制/行为 |
|---|---|---|---|
| `pickSessionFile` | `sessionId` | `string \| null` | 在会话根内选文件 |
| `pickFileAtCwd` | `cwd` | `string \| null` | 在可信 cwd 内选文件 |
| `readFileAtCwd` | `cwd, filePath` | `{contents,absPath,hash?,fileSize?,isTail?,inSessionFolders?} \| null` | cwd 需绝对且通过信任/策略；≤10 MiB；按根解析 |
| `listDirectoryAtCwd` | `cwd, dirPath` | `{name,path,isDirectory,link?}[]` | 仅可信 landing root 或会话根；符号链接分类 |
| `readSessionFile` | `sessionId, filePath, options?{tailBytes?,includeHash?,previewContent?,automatic?}` | file \| null | 相对/绝对路径按 primaryFolder 解析；≤10 MiB；tail 读只允许输出/会话根 |
| `readSessionFileWithStatus` | 同上 | `{status, file?, maxBytes?, creatable?}` | status: `ok/notFound/tooLarge/readError/outsideSessionFolders` |
| `getSessionFilePlacement` | `sessionId, filePath` | `sessionFolder\|cliTemp\|cliPlans\|outside` | 判断文件归属通道 |
| `suggestFolderForSessionFile` | `sessionId, filePath` | `string \| null` | 文件在会话根外时，向上寻找安全的 git 根/文件夹作为建议 |
| `addSuggestedFolderForSessionFile` | `sessionId, filePath, folder` | `boolean` | 把建议文件夹加入会话授权 |
| `resolveSessionFile` | `sessionId, filePath` | `string \| null` | 返回包含后的真实路径 |
| `isSessionPathGone` | `sessionId, filePath` | `boolean` | 路径是否消失 |
| `showSessionFileInFolder` | `sessionId, filePath` | `boolean` | 先 resolve + symlink-free，再 reveal |
| `showSessionFilePreview` | `sessionId, filePath, bounds, consumerId?, targetWindowId?, options?{startVm?,joinVmStart?}` | 预览结果 | 支持 Epitaxy 原生预览、Office 转换、VM 启动 |
| `openSessionFileInDefaultApp` | `sessionId, filePath` | `{ok,error?}` | 扩展名一致、路径字符、危险 basename、可执行类型、consent 对话框、打开前再次 symlink/类型复核 |
| `listSessionDirectory` | `sessionId, dirPath` | file entries | 同 listDirectoryAtCwd，但按会话根 |
| `watchSessionDirectories` | `{sessionId,watchId,dirPaths[]}` | void | 最多 64 个目录；去抖后发 `sessionDirectoryChanged` |
| `readSessionImageAsDataUrl` | `sessionId,filePath,userInitiated?,options?` | string | ≤10 MiB；图片扩展名白名单 |
| `getSessionImageStreamUrl` | `sessionId,filePath` | string | `claude-media://` + HMAC 签名，6 小时有效期 |
| `readSessionMediaAsDataUrl` | `sessionId,filePath` | string | ≤50 MiB |
| `readSessionPanelMediaAsDataUrl` | `sessionId,filePath` | string | ≤25 MiB |
| `writeSessionFile` | `sessionId,filePath,contents,expectedHash?` | `{status:"ok"\|"conflict"\|"denied", hash?, currentHash?, deniedReason?}` | 读旧文件算 sha256；期望 hash 不符返回 conflict；package.json 的 hook manager 键变更拒绝；原地 UTF-8 写 |
| `createSessionFile` | `sessionId,filePath` | 同上 | 目标必须在写根内且非 scratchpad；父目录递归 0755；文件 `wx` 0644；EEXIST → conflict |
| `getDiffFileContent` | `cwd, mergeBase, filePath, prevFilePath?` | `{oldText,newText}` | git diff 文件内容；路径 ≤4096 字符 |
| `getDiffFileImage` | `{cwd,filePath,rev?}` | 图片数据 | git blob 图片预览；无显式上限（由调用方/渲染层约束）[未知] |
| `getGitInfo` / `getGitDiff` / `getGitDiffStats` / `getGitCommits` / `getUncommittedChanges*` | cwd/ref/路径 | 结构化 git 状态 | git 子进程；本地/SSH/remote 三套实现；路径与仓库根受约束 |

---

## 4. 路径模型与存储布局

### 4.1 根目录定义

| 根 | 计算方式 | 用途 |
|---|---|---|
| `userData` | `app.getPath("userData")`；Linux 通常 `~/.config/Claude` [推断，Electron 默认] | 会话、scratch、待上传、预览、managed 数据 |
| `local-agent-mode-sessions` | `<userData>/local-agent-mode-sessions` | 所有本地 agent/chat 会话存储 |
| account 目录 | `<local-agent-mode-sessions>/<acct8>/<org8>`；ID 前 8 位小写；若短名冲突/已存在则用全量 ID | 账号/组织隔离 |
| 会话目录 | `<accountDir>/local_<uuid8>`（可用则短名，否则 `local_<full-uuid>`）；agent 会话 `<accountDir>/agent/` | 单会话数据 |
| `outputs` | `<sessionDir>/outputs` | 交付物、VM `/mnt/outputs` 对应宿主目录 |
| `uploads` | `<sessionDir>/uploads` | 用户附件；对写入只读 |
| `.claude` | `<sessionDir>/.claude` | CLI 配置、projects/transcripts、debug |
| `.projects` | `<sessionDir>/.projects/<projectUuid>` | 挂载的代码项目 |
| `host-cwd` | `<sessionDir>/host-cwd`；若 host loop 有专用 cwd 则用它；平台常量中另有 `/var/empty` 占位 | 无文件夹会话的宿主 cwd |
| 会话记录 | `<accountDir>/<sessionId>.json`；agent 在 `<accountDir>/agent/<sessionId>.json` | 会话元数据/授权路径 |
| `scratch-workspaces` | `<userData>/scratch-workspaces/<acct>/<org>/scratch-YYYY-MM-DD-<6hex>` | 无文件夹 Code 会话临时工作区 |
| `pending-uploads` | `<userData>/pending-uploads[/<acct>/<org>]/<uuid>-<basename>` | 粘贴/暂存上传，后续进入 session uploads |
| `cowork-user-files` | `<userData>/cowork-user-files` | Cowork 用户文件兜底根 |
| `cowork-managed` | `<userData>/cowork-managed`；存在 `.migrated.json` marker 时作为新根 | 迁移后的 managed 根 |
| Cowork 用户文件根 | 默认 `~/Claude`；历史 `Documents/Claude`；兜底 `userData/cowork-user-files`；可由 `coworkUserFilesPath` 覆盖 | 用户可见的 Cowork 数据 |
| `Artifacts` | `<coworkRoot>/Artifacts` | 用户可见 artifacts |
| `artifacts.json` / `artifacts/` | `<accountDir>/artifacts.json`、`<accountDir>/artifacts/` | 内部 artifact 元数据/文件 |
| `cowork-file-preview` | `<userData>/cowork-file-preview` | 文件预览缓存 |
| `ext-icon-probe` | `<userData>/ext-icon-probe/probe.<ext>` | appInfoForExtension 探针 |
| `remote-bash-outputs` | `<userData>/remote-bash-outputs` | 远端 Bash 输出 |
| `cowork-spawn-settings` | `<userData>/cowork-spawn-settings` | 子进程设置 |
| VM 会话路径 | `/sessions/<vmProcessName>/...` | 云端/VM 内路径 |

### 4.2 绝对 vs 相对

- **FileSystem 服务**：路径必须是绝对路径。`validateLocalFileAccess` 在 `path.isAbsolute` 失败时直接 `INVALID_PATH`；`~` 不会在该路径展开。[已证实]
- **LocalSessions 文件 API**：`NT()`（导出 `nW`）会展开 `~` 和 `~/`；`requestedPath()` 把相对路径按 `primaryFolder(session)` 解析。即会话文件 API 支持相对路径，FileSystem 不支持。[已证实]
- **CoworkSpaces**：`QMn` 要求绝对路径；`createSpaceFolder` 用 `parentPath + folderName` 拼接后只做 NUL/UNC 守卫，未做 `..`/包含性检查。[已证实代码路径；风险为推断]
- **AutoAgent 已有设计**使用 `root_id + relative path`，与 Claude Desktop 的绝对路径模型不同；两边不要混用（详见第 10 节）。[已证实，来自现有 `research/fs-integration/README.md`]

### 4.3 会话内文件通道

`resolveSessionFilePaths` 给出的通道语义：

- `primaryFolder`：会话 cwd/worktree（若 harnessCwd 存在则优先）。
- `grantedRoots`：cwd、originCwd、worktreePath、`outputs`、`uploads`、`.projects`、`.claude/projects`（tool-results/plans）、CLI temp。
- `writeRoots`：更窄，通常只有 cwd/worktree/outputs 等。
- `cliRoot` 取值 `toolResults` / `plans` / `temp`，用于区分 CLI 内部文件。
- `scratchpad` 形路径有独立的候选根解析；写操作禁止在 scratchpad 目录创建文件，必须 promote 到 outputs。
- 读 `tool-results` 下的文件有额外校验：相对 `projects` 至少 3 段且第 3 段为 `tool-results`。[已证实]

### 4.4 VM / 挂载模型

- 会话 ID 形如 `local_*` 才允许使用 `/sessions/` 路径；VM 路径必须以 `/sessions/<vmProcessName>/` 开头，且 `<vmProcessName>` 必须等于会话记录中的 `vmProcessName`。[已证实]
- VM 路径内还会阻止危险扩展名（`BLOCKED_EXTENSION`），并拒绝路径穿越。[已证实]
- 常见挂载：`/mnt/uploads`（上传）、`/mnt/<mountName>`（用户选择的文件夹）、`/mnt/.claude/cowork_plugins/`（插件）。宿主侧把 mount name 映射回 `userSelectedFolders`，读写模式有 `ro/rw/rwd` 与 `hide/glob` 变体。[已证实]
- Linux 资源中存在 `virtiofsd` 和静态 `cowork-linux-helper`，字符串包含 `virtiofsdPath`、`uid_map/gid_map`、`SessionOnly`，说明 Linux VM 用 virtiofs 共享目录。[已证实资源与字符串；具体调用链未逐条反编译 = 推断]
- `promoteScratchpadFile` 把 VM scratchpad 文件复制到 outputs，并通知会话。`recordDetectedFile`/`notifySession` 由会话管理器完成。[已证实]

---

## 5. 安全模型

### 5.1 分层

1. **进程/来源层**：只有顶层 claude 来源 frame 可调用；预加载只暴露白名单 namespace。
2. **协议层**：通道名固定、入参/出参 schema 校验。
3. **会话层**：必须 `local_*`（CCR 只读例外）；必须存在且属于当前账号/组织。
4. **路径层**：绝对路径、拒绝 UNC、拒绝 dot segments、解析符号链接、realpath、根包含。
5. **类型层**：扩展名/可执行位/危险 basename/硬链接检查。
6. **用户同意层**：单文件读/打开首次弹窗，结果持久化到会话记录。
7. **管理员策略层**：`allowedWorkspaceFolders` 允许列表 + read-only 模式；可禁用“添加文件夹”。
8. **原生 fd 层**：`*Beneath` + `O_NOFOLLOW` + fd 相对操作，缩小 TOCTOU 窗口。
9. **操作系统层**：Linux 文件权限；macOS TCC（Linux 上是存根）。

### 5.2 允许根集合（FileSystem）

对本地会话：

```text
allowed =
  session.userSelectedFolders
  ∪ outputsDir(session)
  ∪ sessionStorageDir/uploads
  ∪ sessionStorageDir/.projects
  ∪ autoMemoryDir(session)
  ∪ readOnlyPluginPaths(session)
  ∪ midSessionReadOnlyPaths(session)
```

- 对 CCR 会话的读路径，还会加入组织级 display roots，并先执行 `BP(session,...)` / `ensure` 等 VM 前置步骤。[已证实]
- `o.m(target, roots, {userGrants})` 做根包含校验；返回值不是布尔，而是“匹配到的真实根路径或 false”。调用方再用 `resolve(returned) === resolve(realpath)` 检查路径未在验证后被移动。[已证实]
- `containedInGrantedFolders` 还处理：
  - 拒绝把 `user-files` 根本身或其别名作为 grant；
  - 计算每个 grant 的保护子路径 carve-out（`.claude`、凭据目录等）；
  - 检查 grant 未被撤销；
  - 检查目标不在保护 carve-out 内。[已证实]

### 5.3 扩展名/文件名封锁

- 对 open/write 等目标操作始终阻止（list/show 不阻止）：`.exe,.com,.msi,.scr,.pif,.cpl,.bin,.app,.dmg,.pkg,.mpkg,.sparsebundle,.sparseimage,.iso,.img,.cdr,.toast,.vhd,.vhdx,.prefpane,.saver,.jar`。[已证实]
- 对 `openLocalFile` 与 `writeLocalFile` 阻止的脚本/配置/快捷方式：`.sh,.bash,.zsh,.command,.tool,.terminal,.fileloc,.inetloc,.webloc,.bat,.cmd,.ps1,.vb,.vbs,.vbe,.jse,.wsf,.wsh,.wsc,.hta,.lnk,.reg,.msc,.url,.wsb,.jnlp,.js,.pl,.py,.pyw,...,.desktop`。[已证实]
- `openLocalFile` 还会阻止 `mode & 0o111` 且扩展名不在文档白名单内的文件（“executable-mode file”）。[已证实]
- `writeFileDownload` 的 filename 过滤：非 ASCII 空白、控制字符、`\`、`/`、`:`、尾随点/空格、可执行扩展名。[已证实]
- `t.Dy`（`R2r`）检查危险 basename：非 ASCII 空白、控制字符、反斜杠/斜杠/冒号、尾随点空格、可执行扩展名。[已证实]

### 5.4 符号链接、硬链接与 TOCTOU

**[已证实] 路径解析：**

- `zr`（`guardPath`）逐段 `lstat`：
  - 跟随符号链接最多 40 跳；
  - 拒绝指向 raw `\\wsl$`、UNC、Windows device path 的链接；
  - 拒绝 automount/file-id 之类的“substituted path”；
  - 不存在（ENOENT/ENOTDIR）返回 null，由调用方决定。
- `Kb`（`RX`）在 `zr` 后 `realpath`；如果目标不存在，则逐段回溯父目录并拼回尾段，用于“新建文件”的场景。
- `Gb`（`FX`）安全写目标：canonicalize 目标与根，检查 `target` 在 `root` 内；支持 `trustedAncestor` 防止容器路径被替换。

**读取：**

- `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`；`O_NOFOLLOW` 拒绝最终组件为符号链接。
- `fstat` 与路径 `lstat` 的 `dev/ino` 必须一致（`Ffe`）。
- 读取前再次 `Hb(path)`（逐段 symlink-free）。
- 若路径在 consent 后变化，抛 `PATH_NOT_ALLOWED`。
- 会话文件读还会对 `nlink > 1` 的硬链接文件返回 `multiplyLinked`（CLI 临时通道例外）。

**写入：**

- `open(O_WRONLY|O_CREAT|O_NOFOLLOW)`；随后 `fstat`、`lstat`、`dev/ino`、symlink-free 三重检查。
- 目标不存在时只允许创建叶子；父目录必须 realpath 成功。
- 如果目标存在且不是普通文件，拒绝。
- 没有 temp+rename；写入过程中路径被替换的防护依赖 fd 与写前检查，仍不是完全原子。

**打开 sink（openLocalFile）：**

- 再次 `Hb` symlink-free；
- 类型必须是普通文件或目录；
- 统一拒绝可执行位/危险扩展名；
- xlsx 额外做 web-origin mark 检查（macOS quarantine xattr 等）；
- 打开后若路径被替换 / 类型变化 / 变为可执行，拒绝。

**下载：**

- 以最终文件名 `open("wx")` 独占创建；
- 写完后 `X2r` 比较 fd 与路径的 `dev/ino/nlink`；
- 失败删除；
- 代码里存在一个在 `for(;;)` 之后不可达的 `.dl-<rand>.tmp` + rename 分支，说明早期设计过 temp 但当前主路径没有使用。[已证实代码结构；可达性为静态判断]

### 5.5 用户同意（consent）

`checkFileAccessConsent`：

- 已记录 `userApprovedFileAccessPaths` 包含该真实路径 → 允许。
- 操作为 `read` 且目标位于父目录授权范围内（`hasUserApprovedParentDirectoryAccess`：outputs 或会话选中文件夹）→ 允许。
- CCR 只读路径：先做 VM 路径校验，再允许。
- 否则弹 `showMessageBox`：
  - title `File Access Request`
  - message `Allow Claude to preview/open this file?`
  - detail 显示路径
  - 按钮为 `[Cancel, Allow]`，`defaultId` 与 `cancelId` 都指向 Cancel（index 0）
- 用户同意后 `recordUserFileAccessApproval(sessionId, realPath)`，写入会话记录并持久化。
- 同一 `sessionId:path` 的并发请求用 Map 合并，避免重复弹窗。[已证实]

注意：`getLocalFileThumbnail`、`listFilesInFolder`、`writeLocalFile` 不弹单文件 consent；它们依赖根/会话授权。`openLocalFile` 和 `readLocalFile` 会弹。[已证实]

### 5.6 工作区信任（cwd trust）

- 读取 `~/.claude.json`（经 `FU()` 投影/缓存）中的 `projects`。
- `checkStoredTrust(path)` 从该路径开始逐级向父目录查找 `hasTrustDialogAccepted`；父目录可信则子目录继承。[已证实]
- `saveTrust(path)` 写入 `hasTrustDialogAccepted: true`；如果路径可归一到 git 根，可能同时写入 git 根（`jU`），以扩大/对齐信任范围。[已证实]
- `changeCwd(sessionId,cwd,trustAccepted?,trustedDirectory?)` 携带信任结果；`answerPendingCwdTrust` 回答待处理的 cwd 信任提示；`checkTrust` 返回 `{trusted, sources}`。[已证实]
- scratch workspace 创建后调用 `markTrusted(t,{literalKeyOnly:true})`，只标记精确路径、不做 git 根扩展。[已证实]
- SSH/remote 信任另有 `remoteTrustGrant`（endpoint keyed + grantedAt），与本地路径信任分开。[已证实]

**风险/改进点 [推断]**：父目录信任继承会让“信任 `~` 或某个大目录”等于信任其全部子目录；AutoAgent 若采用显式 grant，应避免这种宽泛继承，或至少在 UI 中显示继承来源。

### 5.7 管理员策略

- `allowedWorkspaceFolders` 来自 managed config：
  - 每项 `{path, mode?: "rw"|"ro"}`；
  - `Dj()` 返回全部允许根（缓存）；
  - `nNn()` 返回 read-only 根；
  - 缺失根会尝试 `mkdir(recursive,0o755)`；
  - 空数组表示“管理员禁用添加文件夹”，选择器直接拒绝并提示。
- `browseFolder/browseFolders/browseFile` 都检查管理员根；多选时跳过不允许项并提示。
- `writeLocalFile` 额外拒绝管理员 read-only 根，错误 message 为 “Folder is configured read-only by your administrator.”。
- 管理员只读在 Cowork VM 侧还通过 bindfs/writeClamp 实现（日志字符串明确提到）。[已证实日志字符串；实现细节未展开]

---

## 6. 文件索引与搜索

### 6.1 进程与协议

- worker：`.vite/build/file-index-worker/fileIndexWorker.js`，utility process + MessageChannel。
- init：父进程只接受一次 `{type:"init", ports:[port]}`，随后 worker 回 `{type:"ready"}`。
- 请求类型：
  - `clear`
  - `discard-staged-git`
  - `set-entries` → `set-result`
  - `stage-git-listing` → `stage-git-result`
  - `commit-staged-git` → `commit-staged-result`
  - `search` → `search-result`
  - `content-search` → `content-search-result`
  - `list` → `list-result`
  - 通用 `error`
- 主进程 zod 校验所有 reply；超时：`stage-git-listing` 120 秒，`content-search` 30 秒，`search` 30 秒，默认 120 秒；worker 退出会清空缓存并递增 epoch。[已证实]

### 6.2 路径索引

- 优先获取 git 文件列表：
  - `git ... ls-files --recurse-submodules`
  - cwd 下最多探测 16 个子目录中的 git 仓库，作为带 prefix 的额外列表；
  - `maxBuffer` 64 MiB，`maxLineChars` 65536，超时 10 秒，硬超时 15 秒；
  - 列表过大/被截断时，把该仓库标记为 oversized 并回退到浅 BFS，深路径可能缺失。
- 浅 BFS 回退：
  - 深度 ≤4；
  - 最多 200 个目录、2000 个条目、10 秒；
  - 跳过 `.git/.svn/.hg/CVS` 和 `.DS_Store/__MACOSX/Thumbs.db/desktop.ini`。
- 忽略集合（路径索引/浅 BFS）：
  `node_modules,.git,.svn,.hg,dist,build,out,.next,.nuxt,.cache,__pycache__,.tox,.venv,venv,env,.env,coverage,.nyc_output,.turbo,.parcel-cache,target,vendor,.terraform,.gradle,.m2,.mvn,.idea,.vscode,.history,.yarn,.pnpm-store,.npm,.vite`
- 索引结构：内存中的 `FileIndex` 类；`loadFromFileList` 构建字符位图/路径长度/名称起始位置，支持模糊查询和命中位置。`list()` 返回换行拼接路径 + SHA-1 version；版本相同则 `paths:null`。没有发现磁盘索引文件。[已证实]
- 刷新节流：cwd/remote 变化才重建；完成后 5 秒内复用；最多 20 个结果缓存。[已证实]
- UI mention 上限：50（`NW=50`）；`file-index search` 本身接受调用方 limit。[已证实]

### 6.3 内容搜索

- 首选 `rg`：
  - `rg --json --no-config [-S] <fixed/regex options> --max-count 6 -g !node_modules -- <query>`
  - 默认 `--fixed-strings`；不区分大小写时加 `-i`（`matchCase` 时不加）；整词加 `-w`；
  - 先试 `--crlf`；正则失败再试无 `--crlf`；正则非法返回 `{patternRefused:true}`；
  - 超时 8 秒，硬超时 10 秒，maxBuffer 64 MiB；
  - 每文件最多 6 条；相对 cwd 之外的命中丢弃。
- 回退 `git grep`：
  - `git grep --no-index --exclude-standard -nIz -m 6 -e <query> --`
  - 排除忽略目录与隐藏文件/隐藏目录；
  - 只在 rg 不可用/失败时使用。
- 结果：`{relativePath, absPath, line, column, preview}`；preview 截断到约 200 字符并围绕命中位置。
- 默认总上限：`searchFileContents` 200 条；带 options 的调用由调用方给 `maxResults`。[已证实]
- `searchFileContentsWithOptions` 返回 `{matches, patternRefused}`。[已证实]

### 6.4 目录监视

`SessionDirectoryWatcher`（`index.chunk-B4uTve_e.js`）：

- 每个 renderer/watchId 一组目录；最多 32 组，总目录 64，内部 dir 记录上限 80。
- 默认对每个目录非递归 `fs.watch({persistent:false})`；可选整树递归监视。
- 只关心 `rename` 事件；忽略隐藏/临时名称（`t.RU`）。
- 目录被删除且 `handleDiesWithFolder` 时自动重开；子目录失效会重试。
- 通知去抖：
  - 基础最小间隔 1 秒，并参考上次 `list` 耗时；
  - 全局令牌桶 8 次/秒，回填 2 次/秒；
  - 单目录事件超过 256 次进入 resting，1 秒后重开 watcher；
  - 不再需要的目录 1 秒后关闭。
- 回调最终发 `sessionDirectoryChanged {sessionId, dirPath}`。
- 导航/渲染进程崩溃/会话归档删除会清空 watcher。[已证实]

### 6.5 transcript 搜索

- 独立 worker `transcript-search-worker`；扫描会话 `.jsonl`。
- 查询先做小写化/空白归一；若 token 含引号/反斜杠/非 printable，则不做正则预过滤。
- 并发 4 个会话；每个会话只返回第一条命中；limit 由调用方传入。
- 片段：命中前 20 字符、后 80 字符；按 lastActivityAt 排序。
- 同时提供 `readTranscript` 和 `extractInferenceLogIds`。[已证实]

---

## 7. 缩略图、预览与应用信息

### 7.1 `getLocalFileThumbnail`

- 仅当：
  - 不是 CCR 会话（`gKe(sessionId)` 为 false）；
  - 路径不是 `/sessions/`；
  - 扩展名匹配 `/\.(png|jpe?g|gif|webp|bmp)$/i`。
- 输入 `maxSize` 被 clamp 到 1..512。
- 校验路径后：
  - 以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开；
  - 文件必须是普通文件且 ≤20 MiB；
  - 路径与 fd 身份一致（TOCTOU）；
  - 用 `nativeImage.createFromBuffer` 解码；
  - 空图/宽高非正/像素数 >50M 返回 null；
  - 按请求尺寸等比缩放，最大边不超过 2048；
  - 返回 `{dataUrl,width,height}`。
- 不弹 consent；依赖会话根授权。[已证实]

### 7.2 `whichApplication` / `appInfoForExtension`

- `whichApplication(filename)`：
  - 扩展名必须非空且 ≤32 字符；
  - 规范化/缓存键为路径（caseSensitive）；
  - 调用原生 `getAppInfoForFileAsync(path)`；
  - 30 秒 TTL 缓存（`D2r`）。
- `appInfoForExtension(ext)`：
  - 仅 `docx`、`pdf`、`md`；
  - 在 `userData/ext-icon-probe` 下写 `probe.<ext>` 空文件；
  - 调用同一原生方法；
  - 缓存 30 秒。[已证实]
- 原生 addon 导出名为 `getAppInfoForFileAsync`；`whichApplication` 不是原生导出，只是服务方法名。[已证实]
- 原生在 Linux 上如何解析默认应用（xdg-mime/GIO/desktop entry）未在本次证据中展开。[未知]

### 7.3 图片/媒体/文档预览

- 图片：直接 dataURL ≤10 MiB；或 `claude-media://` 流 URL（带 HMAC-SHA256 签名，6 小时 TTL）。
- 媒体：≤50 MiB；面板媒体/文档 ≤25 MiB。
- 文档：
  - 本地文档扩展名映射：`.pdf`、`.xlsx`；云端转换文档：`.docx`、`.pptx`；
  - `showSessionFilePreview` 支持原生预览、Office 转换、必要时启动 VM；
  - 远程文档有独立上限与“扩展名类别一致”检查（防止把非请求类型当作文档返回）。
- PDF 文本提取：资源中有 `resources/office365-mcp/pdfExtractorProcess.mjs`（基于 pdfjs）与 `bundled-skills/pdf-reading.skill`（pypdfium2/pdftotext/pdftoppm 示例）。该路径属于 MCP/skill 侧，不是 FileSystem 缩略图。 [已证实文件存在；具体调用链未展开]

---

## 8. 导入/导出/清理

### 8.1 Google Drive 导出

- 方法：`FileSystem.exportLocalFileToGoogleDrive(sessionId,path)`。
- 只允许本地文件；拒绝 `/sessions/`。
- 读取上限 30 MiB；18 分钟超时。
- 校验：
  - 会话组织必须等于当前 active org；
  - HIPAA restricted 时的额外门控；
  - 需要有效登录态。
- 请求：`POST ${apiHost}/api/organizations/${org}/cowork/export-to-google-drive`，multipart `file`，文件名 basename。
- 返回：`driveUrl`、`driveFileId`，或 `errorCode`（含 MCP server 信息）。[已证实]

### 8.2 Cowork 归档导出

入口：`CoworkStorage.exportTask/exportProject/exportAll` → `index.chunk-CCOedJ4y.js` → heavy worker `coworkArchive`。

- 目标 Downloads；单飞锁（busy）；HIPAA 门控。
- 内容：
  - task：`CLAUDE.md`、`.claude/skills/port-task-data/SKILL.md`、会话目录、会话 JSON；
  - project：`CLAUDE.md`、`project.json`、`memory/`；
  - all：整个 accountStorageDir。
- 归档安全：
  - 文件名 sanitize：NFC、去除控制/默认可忽略字符、压缩空白、最多 60 字符；
  - 拒绝符号链接、特殊文件、不可读项；
  - `.credentials.json` 直接跳过；
  - 配置类 JSON 超过 32 MiB 跳过，否则脱敏（token/secret/password/apikey/privatekey/bearer/auth 等键）；
  - 分卷：每卷约 <4 GiB、<60,535 条目；
  - 临时 `.tmp`；失败清理；旧临时文件 10 分钟后清理；
  - 最终重命名避免覆盖（`_1` 后缀）。
- 返回 `{status, skippedCount?, skippedByReason?}`；status 为
  `saved/not_found/busy/too_large/restricted/failed`。[已证实]

### 8.3 Cowork 清理/用量

- usage：
  - 扫描 accountStorageDir 下条目；
  - 目录用量走 heavy worker `directoryUsage`；
  - 单次扫描 cancelAfter 240 秒；单目录 stat 30 秒；
  - 结果缓存 60 秒；并发请求合并；
  - 分解 `.claude/projects`（transcripts）、`.claude/plugins`、`uploads`、`outputs`、VM bundle/warm 镜像等；
  - `incomplete` 表示有不可测量/不可读项。
- cleanup：
  - preview/run 接受 30/60/90 天窗口；counts 的 stale 展示只列 30/90；
  - preview 生成候选、字节、云副本数、示例、不可验证数，并签发 token；
  - run 必须用 token 换计划；
  - 删除前检查：非隐藏、非运行中、非 pinned/starred（策略模式下可例外）、最近未使用、ctime 未变化、没有被其他会话共享目录；
  - 通过 `deleteSessionFully` 删除会话目录 + 记录；
  - progress 事件；可取消；
  - 失败计数包含 failedInUseCount。[已证实]
- 后台策略清理（`runHeadlessCleanup`）与用户清理共用计划/执行器，但触发源为 policy 且不显示进度。[已证实]

### 8.4 导入

- `ClaudeAiImport`：`peekLocalZips`、`pickLocalZips`、`pickSessionSourceFolder`、`previewSessionExport`、`runImportFromLocalZips`、`mergeImportedSpace`、`fetchRemoteExport` 等。
- `HistoryImport`：本地历史导入。具体 zip 校验、大小上限、路径穿越防护未在本次证据中逐条展开。[未知]
- 从 API 设计看，导入是“预览/peek 后执行”的两阶段模型，且支持本地 zip 与会话源目录。[已证实方法存在]

---

## 9. Linux / 跨平台要点

### 9.1 路径与平台差异

- 使用 `node:path`（`n.default`），在 Windows 下对 `\\?\`、UNC、junction、WSL `\\wsl$` 做大量防御；在 Linux 下这些检查仍然编译在代码里，只是多数分支不触发。[已证实]
- `Nr()`/`Ar()`/`Dr()` 分别识别 UNC、raw UNC、WSL；`SE()` 识别 automount/file-id 路径（macOS `/net`、`/home` 等）。[已证实]
- `app.getPath` 失败时有回退：
  - 先尝试 `~/<Documents|Downloads|...>`；
  - 再尝试 `~/Claude/<...>` 并创建；
  - 用于 Downloads/Documents 等目录。[已证实]

### 9.2 XDG

- 应用数据目录通过 Electron `app.getPath("userData")`，Linux 默认 XDG config 目录（通常 `~/.config/Claude`）。[推断，基于 Electron 默认；代码未硬编码]
- 受保护路径列表包含 XDG 相关：
  - `XDG_DATA_HOME/claude`（默认 `~/.local/share/claude`）
  - `XDG_STATE_HOME/claude`（默认 `~/.local/state/claude`）
  - `~/.local/bin/claude`、`~/.local/bin/claude.exe`
  - `~/.claude.json`、`~/.claude.json.backup`
  - `.claude`、`.ssh`、`.docker`、`.config/gcloud`、`.config/gh`、shell rc 文件、`.config/powershell` 等。[已证实]

### 9.3 权限/模式

- 内部目录创建：`mkdir(recursive, mode 0o700)`；`mkdirPrivate` 还会打开目录 fd 校验。
- 内部暂存文件：`writeFile(mode 0o600)`，写入前对已存在文件 chmod 0600。
- 用户文件根：`~/Claude` 或 userData 兜底根创建后 chmod 0700。
- 会话 `createSessionFile`：目录 0755，文件 0644（`wx`）。
- 管理员自动创建的允许根：0755。
- 这些模式不一致是有意/历史结果：内部私有数据严格 0700/0600，用户可见交付物更宽松。[已证实]

### 9.4 对话框与桌面集成

- `dialog.showOpenDialog` 在 Linux 走 XDG desktop portal；代码对“取消发生在 <300ms”打日志，明确提示可能是 `xdg-desktop-portal` 或后端未安装。[已证实日志字符串]
- `shell.openPath` / `shell.showItemInFolder` 用于打开与 reveal。
- 存在 `linux-mime/com.anthropic.Claude.xml`、GNOME search provider、`OsEntryPlaces/OsOpenHandlers` 等桌面集成资源/服务。[已证实文件/服务存在；完整流程未展开]
- TCC：
  - macOS 专用 `classifyTccFolderKind`、`openMacFilesAndFoldersSettings`、`x-apple.systempreferences:...Privacy_FilesAndFolders`；
  - Linux 上相关实现返回 null / `NotSupported`，`c4r()` 对 desktop/documents/downloads 都返回 NotSupported。[已证实]
- Linux Cowork VM：`virtiofsd` + `cowork-linux-helper` 资源存在；helper 字符串包含 `uid_map/gid_map`、`virtiofsdPath`、`SessionOnly`。[已证实]
- `materializeDatalessFile` 在非 macOS 返回 `ENOTSUP: materializeDatalessFile is macOS-only`。[已证实]

### 9.5 文件监视

- 使用 `fs.watch`（非 chokidar）；观察 `rename`；大量事件进入 resting；按 session 清理。Linux inotify 对递归大目录成本高，因此默认逐目录非递归，并限制 64 个目录。[已证实]

---

## 10. 可借鉴到 AutoAgent 的优先级

> 现有 AutoAgent 参考设计见 `/home/tars/yysapp/claude-desktop/research/fs-integration/README.md`：它已经采用 loopback FastAPI + launch token/origin gate + `root_id + relative path`。下列建议保留这个更安全的相对路径模型，不照搬 Claude Desktop 的绝对路径 IPC。

### P0（必须）

1. **保留 root_id + relative path，不把绝对路径放进 SPA/HTTP**。Claude Desktop 的绝对路径模型建立在其 IPC 调用方是受信 claude.ai 顶层 frame 的前提上；AutoAgent 的 SPA 不应假设同等信任。原生选择器返回的绝对路径只能换成一个短时/命名 root，不能直接回传 renderer。
2. **实现一个集中式 `SafeFileService`**（AutoAgent 已有雏形）：
   - `resolve(root_id) -> canonical root`
   - `lexical -> lstat 逐段 -> realpath -> root containment`
   - 拒绝 NUL、`.`/`..`、绝对路径（在相对路径 API 中）、Windows drive/UNC、控制字符。
   - 所有读/写/列目录/打开/预览必须经过同一入口。
3. **所有最终打开使用 `O_NOFOLLOW` + fd 校验**：
   - `open` 后 `fstat` 与路径 `lstat` 的 dev/ino 比对；
   - 写前/读前复核 symlink-free；
   - 读取支持 `maxBytes`，写入支持大小上限。
4. **原子写**：AutoAgent 现有设计已提“atomic replace”。继续坚持 `tempfile` + `fsync` + `os.replace`，比 Claude Desktop 的 `writeLocalFile`/`writeSessionFile` 原地 truncate 更安全。对需要并发控制的写，采用 `expectedHash`/`If-Match`（Claude Desktop 的 `writeSessionFile` 已给出模式）。
5. **DTO 与错误码**：
   - 读：`{content, encoding: "utf-8"|"base64", mimeType, fileName, size, hash?}`；
   - 写：`{status:"ok"|"conflict"|"denied", hash?, currentHash?, reason?}`；
   - 错误带稳定 `code`（不要像 Claude Desktop 跨 IPC 只剩 message）。
6. **会话/工作区 grant**：
   - 保存 `root_id -> {path, mode: rw|ro, source: picker|suggested|admin}`；
   - 单文件读/打开需要一次性或持久 approval；
   - `outputs`、`uploads` 分离；`uploads` 对 agent 写只读。
7. **大小/类型限制**：
   - 文本读 10 MiB、二进制/媒体按需更高（Claude Desktop 为 10/50 MiB，单文件 IPC 50 MiB）；
   - 缩略图 20 MiB/50M 像素/2048 边；
   - 导出 30 MiB/30 分钟级别超时；
   - 拒绝可执行/脚本扩展名与 `mode & 0o111` 文件。
8. **下载/导出文件名安全**：
   - 过滤控制字符、非 ASCII 空白、路径分隔符、尾随点空格；
   - 只在 Downloads 根内写；
   - 独占创建、不覆盖；写后复核 dev/ino。
9. **选择器与拖放**：
   - 原生对话框只返回路径；
   - 拖放通过 Electron `webUtils.getPathForFile`（若 Electron 版本支持）或等价 native 通道；
   - 原生返回的路径视为 grant，转为 root/grant 后再进入 HTTP。
10. **权限模式**：内部数据 0700/0600；用户交付物 0644；目录不要默认 world-writable。

### P1（强烈建议）

1. **目录监视去抖/限流**：参考 SessionDirectoryWatcher 的 64 目录上限、1 秒最小间隔、令牌桶、事件风暴 resting，避免 inotify 把主进程拖垮。
2. **独立索引 worker**：
   - 优先 `git ls-files`，尊重 `.gitignore`；
   - 回退浅 BFS，深度/目录/时间上限；
   - 路径模糊索引放 worker，主进程只持有 version/paths。
3. **内容搜索**：
   - 优先 `rg --json`，固定字符串默认、正则/整词/大小写选项；
   - 回退 `git grep`；
   - 每文件命中上限、总上限、超时、`patternRefused`。
4. **忽略规则**：`node_modules,.git,dist,build,out,.next,.cache,__pycache__,.venv,target,vendor,...`，另加隐藏/临时/OS 元数据过滤。
5. **工作区信任存储**：如果 AutoAgent 有“信任此文件夹”概念，存 canonical path + source；避免父目录继承的过度授权，或在 UI 明示。
6. **scratch workspace**：`<data>/scratch-workspaces/<acct>/<org>/scratch-YYYY-MM-DD-xxxxxx`；创建后标记可信；7 天未用/空目录 1 小时清理；移动会话时搬运文件。
7. **缩略图/应用信息缓存**：限制像素/尺寸；Linux 应用信息可走 `xdg-mime`/GIO，缓存短 TTL。
8. **导出安全**：跳过符号链接/特殊文件/凭据；配置 JSON 脱敏；分卷；临时文件 + rename；单飞锁。
9. **用量/清理**：usage 缓存、preview token、run 二次确认、删除前 ctime/共享目录复核、进度与取消。
10. **Linux 桌面 portal 兼容**：检测 `xdg-desktop-portal` 缺失并在 UI 给出可诊断错误，而不是静默取消。

### P2（按需）

1. VM/容器挂载：virtiofs/9p 的路径映射、只读 bind、mount name 稳定化；先做本地，再考虑 VM。
2. Git diff 文件/图片、PR 集成：把 git 作为独立能力层，不要让文件 API 直接依赖 git。
3. transcript 搜索 worker：JSONL、预过滤、并发 4、单会话单命中。
4. 导入两阶段（peek/preview → run）+ zip 路径穿越/大小限制。
5. Google Drive/云导出：同组织校验、HIPAA/合规门控、超时与错误码。
6. Word/Excel/PPT/PDF 预览：本地转换或库（pypdfium2、LibreOffice）与 MIME/扩展名一致性检查。
7. 可观测性：记录 lane（root 类型）、outcome、spelled-in 通道、拒绝原因，但要避免记录敏感绝对路径。

### 明确不要照搬

- **不要**把绝对路径直接暴露给 renderer/HTTP。
- **不要**用“扩展名黑名单”作为唯一类型防线；应同时校验 magic/MIME、可执行位、最终 realpath。
- **不要**原地 truncate 后写；用 temp+fsync+rename。
- **不要**在正常下载路径把半成品直接暴露在最终文件名；先写临时文件再 rename（Claude Desktop 的 temp 分支实际不可达）。
- **不要**对 50 MiB 文件做一次性整读；用流式/分块。
- **不要**把 `user-files` 根、`~/.claude`、`~/.ssh` 等作为可挂载目录。
- **不要**依赖“父目录已信任”无限继承；显式 grant 更可审计。
- **不要**像 `CoworkSpaces.createSpaceFolder` 那样只做 NUL/UNC 守卫就 `join + mkdir`；必须额外校验 `folderName` 不含 `..`/分隔符，且最终路径仍在 parent 内。
- **不要**让搜索超时静默截断而不告知调用方；返回 `truncated/timeout` 标志。

---

## 11. 证据索引

> JS 偏移为压缩文件字符偏移；原生为文件偏移。所有文件均在只读范围内。

| 证据 | 位置 | 内容 |
|---|---|---|
| FileSystem 契约 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 1929976 | 19 个方法、输入 schema、输出 validator |
| FileSystem 实现 | 同上 @ 6273600–6282000 | browse/list/read/write/thumbnail/download/export/promote 具体分派 |
| 服务注册器 `ro` | 同上 @ 532227 | 通道前缀、sender 校验、参数/返回值校验、`{result/error}` |
| 校验辅助 | 同上 @ 531290–531942 | `eSe/aSe/nSe/rSe` 错误文案 |
| 通道前缀 `cy` | 同上 @ 1908725 | `$eipc_message$_...claude.web_$_` |
| 设置前缀 `Ig` | 同上 @ 1581506 | `...claude.settings_$_` |
| FilePickers 契约 | 同上 @ 1585562 | `getDirectoryPath/getFilePath` |
| FilePickers 实现 | 同上 @ 6708278 | Electron dialog + multiSelections |
| LocalSessions 文件契约 | 同上 @ 1944900–1948600 | pick/read/write/create/placement/watch/preview/diff |
| CoworkUserFiles/CoworkStorage 契约 | 同上 @ 1924715–1925024 | getInfo/pickTarget/migrate/reveal；usage/cleanup/export |
| CoworkSpaces 契约 | 同上 @ 1926281–1926800 | list/read/open/create/copy |
| 本地文件校验 `validateLocalFileAccess` | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-B1NUaAKC.js` @ 1900–6500 | 会话/绝对路径/UNC/扩展名/根/symlink/realpath/move/consent 调用 |
| 本地读取/缩略图/写入 | 同上 @ 8500–12100 | 50 MiB、O_NOFOLLOW、text/base64、thumbnail 常量、write 流程 |
| 校验器导出 | 同上 @ 17300 尾部 | `validateLocalFileAccess`、`readLocalFileImpl`、`writeLocalFileImpl` 等 |
| 读取上限常量 | 同上 @ 8800 | `E=52428800`（50 MiB） |
| 缩略图常量 | 同上 @ 11000 左右 | `P=512, F=20971520, I=52428800, L=2048` |
| 文本/二进制判定 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 6228550 | `vEa/_Ea/yEa` 与 `bEa` |
| DTO：listDirectory | 同上 @ 1780762 | `{directories,error?,missing?}` |
| DTO：readLocalFile | 同上 @ 1773483 | `{content,mimeType,fileName,encoding?,checkedPlainFile?}` |
| DTO：thumbnail | 同上 @ 1779946 | `{dataUrl,width,height}` |
| DTO：appInfo | 同上 @ 1778364 | `{appName,appIconBase64?}` |
| DTO：download/promote/export | 同上 @ 1780040–1780311 | savePasted/promote/drive 返回 |
| `browseFile` 实现 | 同上 @ 6281572 起 | 默认路径记忆、symlink、cwd relPath、管理员根 |
| `savePastedFile` | 同上 @ 6280937 | pending-uploads + UUID + base64 |
| `writeFileDownload` | 同上 @ 6274078 / 4374072 | URL host、Downloads、wx、路径复核 |
| 文件名安全 | 同上 @ 4369728 | 控制字符/分隔符/可执行扩展名 |
| `showInFolder` | 同上 @ 4376556 | 10 次/10 秒、UNC/symlink/Downloads 检查 |
| 打开 sink | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-qo9IR8Re.js` @ 32047 | symlink-free、类型、可执行位、web-origin mark、`shell.openPath` |
| safe-fs 原生封装 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 506500–510500 | `openBeneath/openRootDir/statBeneath/...`、O_NOFOLLOW、nlink>1 拒绝 |
| addon 强制 | 同上 @ 283970 | 加载失败拒绝回退（CC-2885） |
| 路径 hop guard | 同上 @ 252500–254700 | 40 跳、UNC/WSL/substituted 拒绝 |
| canonical/hardlink 检查 | 同上 @ 2049901 / 2050928 | `Hb` symlink-free、`Kb` realpath、`Gb` write containment |
| 管理员根 | 同上 @ 3033594 / 3035141 / 3036574 | `Dj/Oj/Aj`、自动创建、read-only |
| 扩展名封锁 | 同上 @ 3030218 | `KMn/qMn` |
| 文件名阻断 | 同上 @ 4369728 | `R2r` |
| `~`/相对路径展开 | 同上 @ 2553625 | `NT` |
| Cowork 根定义 | 同上 @ 2254737–2255404 | `~/Claude`、`Documents/Claude`、`cowork-user-files`、`cowork-managed` |
| Cowork 根解析/持久化 | 同上 @ 2256402 / 2257407 | 设置项、UNC/可验证性、回退 |
| managed marker | 同上 @ 2240741 | `.migrated.json` |
| Artifacts | 同上 @ 2263300 | `NC()/Artifacts`、account `artifacts.json/artifacts/` |
| 会话目录短名 | 同上 @ 2260206 / 2260708 | `local_<8>` 逻辑 |
| 会话存储常量 | 同上 @ 2235166 | `local-agent-mode-sessions`、`agent`、`host-cwd`、`/var/empty` |
| 会话目录/输出路径 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-D7Cps41t.js` @ 456648 / 457470 / 467742 | account dir、`outputs/.claude/host-cwd`、短名 |
| 会话记录 | 同上 @ 456822 | `<accountDir>/<sessionId>.json`、agent 子目录 |
| 自动 memory | 同上 @ 469999 / 2263768 | agent/space memory 路径 |
| 单文件批准 | 同上 @ 559496 | `userApprovedFileAccessPaths`、父目录范围 |
| VM 进程名 | 同上 @ 574739 | `getVMProcessName` |
| Scratch workspace | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-L3BG3g83.js` @ 1300–2600 | 命名、5 次重试、策略拒绝、mark trust、sweep |
| Scratch 根 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 3725217 | `scratch-workspaces/<acct>/<org>`、正则 |
| 信任存储 | 同上 @ 3746645–3747215 | 祖先继承、写 `hasTrustDialogAccepted`、literalKeyOnly |
| consent | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-B1NUaAKC.js` @ 5900–8500 | 弹窗、去重、记录 |
| 会话文件访问实现 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-BvLvPLAH.js` @ 1001003–1037200 | 10 MiB/50 MiB/25 MiB、resolve/read/write/create、symlink walk 40 跳 |
| 会话文件读取上限 | 同上 @ 1001003 | `SESSION_FILE_MAX_BYTES=10485760`、image 10 MiB、media 50 MiB、panel 25 MiB |
| 会话文件写入 | 同上 @ 1033166 | hash 冲突、原地写、package.json hook 键拒绝 |
| 会话文件创建 | 同上 @ 1034619 | 父目录 0755、`wx` 0644 |
| 目录 watcher | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-B4uTve_e.js` @ 18349–27000 | 32 组/64 目录/80 记录、去抖、令牌桶、resting |
| watcher 注册 | 同上 @ 60958 | `setWatchedDirectories` |
| 文件索引 worker 常量/协议 | `/home/tars/yysapp/claude-desktop/app/.vite/build/file-index-worker/fileIndexWorker.js` @ 893751–907000 | git 配置、ignore 集合、MessagePort 协议 |
| 内容搜索 | 同上 @ 899262 / 899806 / 900642 | 6 条/文件、rg/git grep、8s/10s、64 MiB |
| 路径索引类 | 同上 @ 903481 | `FileIndexHost`、git staging、list version |
| 深度/条目限制 | 同上 @ 897592 | 深度 4、200 目录、2000 条目、10 秒 |
| 主进程索引客户端 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 3674760–3677600 | worker 管理、超时、缓存、cwd 刷新 |
| mention 上限 | 同上 @ 3843532 | `NW=50` |
| Resources handler | 同上 @ 6284800 | getProjectFileList/searchFileContents |
| transcript worker | `/home/tars/yysapp/claude-desktop/app/.vite/build/transcript-search-worker/transcriptSearchWorker.js` @ 32478 / 33267 / 33890 | 并发 4、20/80 片段、单会话单命中 |
| 缩略图实现 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-B1NUaAKC.js` @ 10800–11900 | 图片扩展、20 MiB、50M 像素、2048 边 |
| appInfo 探针 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 6274445 | docx/pdf/md、ext-icon-probe、30s 缓存 |
| Google Drive 导出 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-B1NUaAKC.js` @ 13200–16000 | 30 MiB、18 分钟、同组织、multipart |
| Cowork 存储常量 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 5964102 | 60s usage 缓存、240s scan、30/90 天、split 路径 |
| Cowork usage/counts/preview/run | 同上 @ 5968625–5976500 | 计划/token/删除规则 |
| Cowork 导出 API | 同上 @ 5976995 | exportTask/Project/All |
| Cowork 归档实现 | `/home/tars/yysapp/claude-desktop/app/.vite/build/heavy-work-worker/heavyWorkWorker.js` @ 258464–260500 | 跳过 symlink/特殊/凭据、分卷、脱敏 |
| 归档限制 | 同上 @ 252688 / 253407 | partBytes≈4 GiB-256 MiB、partEntries=60,535、config 32 MiB |
| Cowork export 包装 | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-CCOedJ4y.js` @ 4400–6200 | Downloads、HIPAA、单飞、task/project/all 内容 |
| Cowork 用户文件 migrate | `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` @ 5833600–5835600 | getInfo/pickTarget/migrate/reveal |
| Spaces 文件 API | 同上 @ 6236800–6251000 | allowedFolders、50 MiB、list/read/open/create/copy |
| 拖放 pathForFile | `/home/tars/yysapp/claude-desktop/app/.vite/build/mainView.js` @ 165187 | `webUtils.getPathForFile` 暴露 |
| FileSystem renderer 包装 | 同上 @ 89874–91560 | 19 个 invoke 方法 |
| 原生 addon 元数据 | `/home/tars/yysapp/claude-desktop/asset/ida_native/survey.json` | `claude-native-binding.node`、sha256、14281 functions、入口 `napi_register_module_v1` |
| 原生 addon 导出字符串 | `/home/tars/yysapp/claude-desktop/app/node_modules/@ant/claude-native/claude-native-binding.node` @ 0x3aab2–0x453e8 | `cloneAt/openBeneath/openRootDir/materializeDatalessFile/readFreshUserPath/readProcessTree/statBeneath/...` |
| `openat2` 字符串 | 同上 @ 0x56fcc | 与 `openBeneath: empty segments`、`ELOOP/EXDEV` 相邻 |
| `FICLONE` | 同上 @ 0x570c6 | `cloneAt` 的 CoW 复制路径 |
| macOS-only 错误 | 同上 @ 0x5d919 | `ENOTSUP: materializeDatalessFile is macOS-only` |
| Linux VM 资源 | `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources/virtiofsd`、`cowork-linux-helper` | virtiofsd/helper 存在 |
| REA 图限制 | `/home/tars/yysapp/claude-desktop/asset/rea_application_graph.json` | `limitations` 明确 `fileIndexWorker.js` 语义分析 heap exhausted；`native_addon_bindings: 0` |
| REA 统计 | `/home/tars/yysapp/claude-desktop/asset/rea_summary.json` | 447 relevant files / 433 parsed / 6569 findings |

---

## 12. 明确标注的未知项

1. **openat2 的精确 resolve flags**：addon 字符串确认使用 `openat2`，JS 封装也加了 `O_NOFOLLOW`，但未逐条反汇编确认 `RESOLVE_BENEATH/RESOLVE_NO_SYMLINKS`。**[推断，强]**
2. **`getAppInfoForFileAsync` 的 Linux 后端**：是 xdg-mime、GIO 还是 desktop-file 解析，未反编译。**[未知]**
3. **`readFreshUserPath`、`readProcessTree`**：addon 中存在导出字符串，但在 447 个 JS 文件中未找到调用点；用途与参数未确认。**[未知]**
4. **`savePastedFile` 的大小上限**：handler 未做显式字节上限；是否由 renderer/附件层限制，未找到。**[未知]**
5. **`writeFileDownload` 的字节上限**：代码为流式，无显式 cap。**[未知]**
6. **`OsEntryPlaces`/`OsOpenHandlers` 的完整语义**：契约存在（report/ready），实现细节与 Linux 桌面集成流程未展开。**[未知]**
7. **Cowork 清理资格判定 `wfa/gpa` 的全部条件**：已确认包含最近活动、ctime、starred、共享目录、云副本检查；精确阈值/组合未逐行展开。**[部分未知]**
8. **Linux Cowork VM 的调用链**：`virtiofsd`/helper 存在，但主进程中 Swift VM addon 路径在 Linux 上是否被替换，未确认。**[未知]**
9. **`copyFilesToSpaceFolder` 的单文件/总量上限**：未看到显式 cap，只有流式复制与目标保护。**[未知]**
10. **归档 `h_` 的 oversized 判定阈值**：分卷常量已确认；总额/压缩比阈值的具体组合未展开。**[未知]**
11. **ClaudeAiImport/HistoryImport 的 zip 校验**：只确认两阶段 API；路径穿越、大小、加密 zip 策略未展开。**[未知]**
12. **`FileSystem.browseFolder` 的 `restrictToHomeDir` 实际效果**：参数在契约中存在，但 handler 中未看到直接使用；可能由更上层 UI 或旧版本兼容保留。**[未知]**
13. **`writeLocalFile` 内容大小限制**：schema 只要求 string；无显式字节上限。**[未知]**
14. **`getDiffFileImage` 上限**：git blob 读取大小限制未展开。**[未知]**

---

## 13. Handoff（10 条）

1. **主入口**：读 `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-Z7WxBjyE.js` 的 1929976（契约）与 6273600（handler）；本地文件最终逻辑在 `/home/tars/yysapp/claude-desktop/app/.vite/build/index.chunk-B1NUaAKC.js`。
2. **协议结论**：IPC = 硬编码前缀 + `服务_$_方法`；顶层 claude 来源校验；位置参数 + schema 双重校验；返回 `{result}`/`{error:message}`；错误码跨进程丢失。
3. **FileSystem 19 方法**：19 个方法已全部列表；核心读 50 MiB、缩略图 20 MiB/50MP/2048、Drive 导出 30 MiB/18 分钟；写只支持 UTF-8 string。
4. **路径结论**：用户数据在 `userData/local-agent-mode-sessions/<acct8>/<org8>/<sessionDir>`；会话目录 `outputs/uploads/.claude/.projects/host-cwd`；Cowork 根 `~/Claude` → `Documents/Claude` → `userData/cowork-user-files`。
5. **安全结论**：集中校验 + 允许根 + 扩展名/文件名封锁 + symlink 40 跳 + realpath + dev/ino TOCTOU 复核 + 单文件 consent + 管理员 ro；原生 `*Beneath` 是强制层（CC-2885）。
6. **关键改进点**：`writeLocalFile`/`writeSessionFile` 非原子；下载正常路径把内容直接写到最终文件名；大文件整读；父目录信任继承过宽。AutoAgent 应使用 temp+fsync+rename、流式、显式 grant。
7. **索引结论**：独立 worker；`git ls-files` + 浅 BFS 回退；`rg` + `git grep` 回退；每文件 6 条、默认总 200、忽略重目录；内存索引，无磁盘库。
8. **Linux 结论**：TCC 存根；XDG 路径；`virtiofsd`/`cowork-linux-helper` 存在；portal 取消有诊断日志；`materializeDatalessFile` 非 macOS ENOTSUP。
9. **复用边界**：保留 AutoAgent 现有 `root_id + relative path` 设计，不要把 Claude Desktop 的绝对路径 IPC 直接搬进 loopback HTTP；只移植校验/限流/索引/导出的实现模式。
10. **未完成验证**：openat2 flags、Linux app info 后端、`readFreshUserPath/readProcessTree`、导入 zip 校验、VM Linux 调用链；这些已在第 12 节列为未知，后续可用 `nm/objdump`（addon）与动态抓取补齐。
