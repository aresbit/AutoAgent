# Claude Code 内部 MCP 服务器完整清单

## 一、总览

Claude Code 通过 `InternalMcpServerManager` 管理 **16 个内部 MCP 服务器**，分为两组：

| 组 | 数量 | 加载方式 |
|----|------|---------|
| **b1r 基础列表** | 7 | 静态定义，`L1r()` 启动时加载 |
| **动态注入** | 9 | 条件编译/feature flag 控制 |

代码位置：`index.js:230269(b1r)` + `index.js:230856(L1r)`

---

## 二、全部 16 个服务器

### 2.1 b1r 基础列表 (7 个)

#### 1. `Claude in Chrome` (MF)
- **常量**: `MF = "Claude in Chrome"`
- **行号**: `index.js:230271`
- **工具**: Chrome 浏览器自动化工具（导航、点击、截图、DOM 查询等）
- **条件**: 需 Chrome 扩展连接
- **特性**: 支持权限管理（ask/follow_a_plan/skip_all_permission_checks）

#### 2. `mcp-registry` (fce)
- **常量**: `fce = "mcp-registry"`
- **行号**: `index.js:230396`
- **工具**:
  - `search_mcp_registry` — 搜索 MCP 连接器注册表
  - `suggest_connectors` — 向用户推荐未连接的 MCP
- **用途**: 当用户说"查我的 Asana 任务"时，搜索对应的 MCP 推荐安装

#### 3. `plugins` (v1r)
- **常量**: `v1r = "plugins"`
- **行号**: `index.js:230529`
- **工具**: `suggest_plugin_install` — 渲染插件安装卡片
- **条件**: 非 3p 类型会话(`xi().type !== "3p"`)

#### 4. `skills` (k1r)
- **常量**: `k1r = "skills"`
- **行号**: `index.js:230699`
- **工具**: `list_skills` — 渲染 slash-menu 技能列表交互控件
- **条件**: `sessionType === "cowork" && pluginsEnabled !== false`

#### 5. `cowork-onboarding` (T1r)
- **常量**: `T1r = "cowork-onboarding"`
- **行号**: `index.js:230774`
- **工具**: Cowork VM 引导工具
- **条件**: Cowork 会话

#### 6. `dev-debug`
- **常量**: 直接字符串 `"dev-debug"`
- **行号**: `index.js:230805`
- **工具**: 开发者调试工具集（仅开发模式）

#### 7. `radar` (N1r)
- **常量**: `N1r = "radar"`
- **行号**: `index.js:230835`
- **工具**: `surface_card` + `retire_card` — 高亮/淘汰行动卡片
- **描述**: "Record one actionable item pointed at the user"

---

### 2.2 动态注入 (9 个)

#### 8. Office Addin (iJn)
- **行号**: `index.js:230860-230880`
- **工具**: `list_connected_workbooks`, `office_addin_run`, `office_addin_get_context`, `open_office_file`, `close_office_file`
- **条件**: `Pt("4116586025") && (Windows || macOS) && Qi("louderPenguinEnabled")`
- **用途**: MS Office 集成（Excel 宏等）

#### 9. `computer-use` (vxt)
- **常量**: `vxt = "computer-use"`
- **行号**: `index.js:220931 (cLr)`
- **函数**: `cLr()` → `getComputerUseServerDef()`
- **工具**: `request_access`, `screenshot`, `click`, `type`, `scroll`, `drag`, `computer_batch`, `list_granted_applications`, `open_application`, `request_teach_access`, `teach_step`, `key_combo`
- **条件**: 需 macOS Accessibility + Screen Recording 权限
- **特性**: 支持 Teach Mode、锁管理、多显示器

#### 10. `visualize` (QJn)
- **常量**: `QJn = "visualize"`
- **行号**: `index.js:448176-448200 (hJn/fJn)`
- **工具**:
  - `show_widget` — 渲染 SVG/HTML 可视化内容
  - `read_me` — 加载 Imagine 设计模块
- **条件**: `Pt("3444158716") && sessionType === "cowork"`
- **CSP**: `esm.sh`, `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`
- **资源**: `ui://imagine/show-widget.html`

#### 11. `Claude Preview` (Pae)
- **常量**: `Pae = "Claude Preview"`
- **行号**: `index.js:230887`
- **工具**: 从 `LGr` 映射（web 预览相关工具）
- **条件**: `Pt("2976814254") && sessionType === "ccd" && !isSSH && launchEnabled`

#### 12. `Framebuffer` (WhA)
- **常量**: `WhA = "Framebuffer"`
- **行号**: `index.js:230893`
- **工具**: `Skr()` 返回的工具
- **状态**: **永久禁用** (`isEnabled: () => false`)
- **响应**: `"Framebuffer preview unavailable."`

#### 13. `ccd_session` (WGr)
- **常量**: `WGr = "ccd_session"`
- **行号**: `index.js:224524-224676 (eUr)`
- **工具**:
  - `spawn_task` — 标记一个值得后台处理的任务（显示 chip 供用户一键启动）
  - `mark_chapter` — 标记会话新章节（显示分隔线和目录）
- **条件**: `sessionType === "ccd"`

#### 14. `ccd_directory` (x2t)
- **常量**: `x2t = "ccd_directory"`
- **行号**: `index.js:224275-224380 (PGr)`
- **工具**: `request_directory_access` — 请求用户选择文件夹共享
- **条件**: `sessionType === "ccd" && !isSSH`
- **安全**: 自动/绕过模式下拒绝

#### 15. `ccd_session_mgmt` (l0A)
- **常量**: `l0A = "ccd_session_mgmt"`
- **行号**: `index.js:224380-224523 ($Gr)`
- **工具**:
  - `list_sessions` — 列出用户的其他 CCD 会话
  - `search_session_transcripts` — 全文搜索其他会话的对话记录
  - `archive_session` — 归档会话
- **条件**: `sessionType === "ccd"`
- **安全**: `search_session_transcripts` 和 `archive_session` 需要用户确认

#### 16. `terminal` (pJn)
- **常量**: `pJn = "terminal"`
- **行号**: `index.js:448196-448220 (DJn)`
- **工具**: `read_terminal` — 读取集成终端内容（最后 ~200 行，ANSI 剥离）
- **参数**: `lines` (行数), `wait_for_output_ms` (等待新输出)
- **条件**: 终端面板需打开

---

## 三、服务器启用条件汇总

### 按会话类型

| 会话类型 | 启用的服务器 |
|----------|------------|
| **ccd** (Claude Code Desktop) | `ccd_session`, `ccd_directory`, `ccd_session_mgmt`, `Claude Preview` |
| **cowork** (VM 沙箱) | `skills`, `cowork-onboarding`, `visualize` |
| **全类型** | `Claude in Chrome`, `mcp-registry`, `plugins`, `radar`, `dev-debug` |

### 按 Feature Flag

| Flag | 控制的服务器 |
|------|------------|
| `3444158716` | `visualize` (Imagine) |
| `4116586025` | Office Addin |
| `4019128077` | `Claude in Chrome` (alwaysLoad) + `computer-use` (alwaysLoad) |
| `2976814254` | `Claude Preview` |
| `louderPenguinEnabled` | Office Addin (额外条件) |
| `launchEnabled` | `Claude Preview` (额外条件) |

### 永久禁用
- `Framebuffer` — `isEnabled: () => false`

---

## 四、工具完整清单

```
Claude in Chrome (MF):
  ├── navigate
  ├── screenshot
  ├── click / clickxy
  ├── type
  ├── eval / evalraw
  ├── html / snap
  ├── net / shot
  └── ... (chrome-cdp 全套)

mcp-registry (fce):
  ├── search_mcp_registry
  └── suggest_connectors

plugins (v1r):
  └── suggest_plugin_install

skills (k1r):
  └── list_skills

cowork-onboarding (T1r):
  └── onboard_*

dev-debug:
  └── (开发调试工具)

radar (N1r):
  ├── surface_card
  └── retire_card

Office Addin:
  ├── list_connected_workbooks
  ├── office_addin_run
  ├── office_addin_get_context
  ├── open_office_file
  └── close_office_file

computer-use (vxt):
  ├── request_access
  ├── screenshot
  ├── click / type / scroll / drag
  ├── computer_batch
  ├── list_granted_applications
  ├── open_application
  ├── request_teach_access
  ├── teach_step
  └── key_combo

visualize (QJn):
  ├── show_widget
  └── read_me

Claude Preview (Pae):
  ├── preview_open
  └── preview_* (web preview 相关)

Framebuffer (WhA): [已禁用]
  └── framebuffer_preview → "unavailable"

ccd_session (WGr):
  ├── spawn_task
  └── mark_chapter

ccd_directory (x2t):
  └── request_directory_access

ccd_session_mgmt (l0A):
  ├── list_sessions
  ├── search_session_transcripts
  └── archive_session

terminal (pJn):
  └── read_terminal
```

---

## 五、架构流程

```
Claude Code 子进程启动
  │
  ├── InternalMcpServerManager (G1r class)
  │     │
  │     ├── L1r() → 组装全部 16 个 server definitions
  │     │     ├── b1r.map() — 基础 7 个
  │     │     ├── iJn → Office Addin (conditionally)
  │     │     ├── VDA() ? cLr() : skip → computer-use (conditionally)
  │     │     ├── fJn → visualize (conditionally)
  │     │     ├── Pae → Claude Preview
  │     │     ├── WhA → Framebuffer (disabled)
  │     │     ├── eUr() → ccd_session
  │     │     ├── PGr() → ccd_directory
  │     │     ├── $Gr() → ccd_session_mgmt
  │     │     └── DJn → terminal
  │     │
  │     └── createProxyServers()
  │           ├── 过滤: isEnabled(session) === false → skip
  │           ├── 过滤: allowedTools 配置 → 白名单过滤
  │           └── 注册到 MCP 代理层
  │
  └── MCP Client 发现 → tools/list → 全部可用工具
```

## 六、关键发现

1. **Framebuffer 服务器已死** — 代码仍保留但 `isEnabled: () => false`，返回固定错误消息
2. **visualize/Imagine 仅 Cowork** — `show_widget` 和 `read_me` 只在 VM 沙箱环境可用
3. **ccd_session 系列仅 Desktop** — `spawn_task`、`mark_chapter`、`archive_session` 等仅 CCD 类型会话
4. **computer-use 条件最复杂** — 需要 feature flag + macOS 权限 + 未禁用 + Cowork 会话
5. **radar 是个轻量提醒系统** — `surface_card`/`retire_card` 用于高亮行动项
6. **terminal 是最简单的服务器** — 仅一个 `read_terminal` 工具
