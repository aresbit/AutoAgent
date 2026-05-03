# Claude Desktop UI 生成机制：Cowork vs Desktop 完整对比

## 一、核心结论

**Desktop (CCD) 根本不需要可视化生成 MCP 服务。** Claude 通过 API 返回的 Markdown 文本，由 Electron 前端（React 组件）直接渲染。这与 Cowork 模式使用 `show_widget` 完全不同。

---

## 二、两种模式的 UI 生成对比

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Desktop                            │
├────────────────────────────┬────────────────────────────────────┤
│     CCD (本地会话)          │      Cowork (VM 沙箱)               │
├────────────────────────────┼────────────────────────────────────┤
│                            │                                    │
│  Claude API                │  Claude API                        │
│    ↓                       │    ↓                               │
│  content[{type:"text"}]    │  tool: show_widget                 │
│    ↓                       │    ↓                               │
│  Markdown 文本             │  HTML/SVG 代码                     │
│    ↓                       │    ↓                               │
│  React 组件渲染             │  Sandbox iframe 渲染               │
│  (内联在聊天消息中)          │  (独立 iframe + CSP)               │
│                            │                                    │
│  特性:                      │  特性:                             │
│  ✅ 代码块语法高亮           │  ✅ 内联 SVG 渲染                  │
│  ✅ 表格/Mermaid            │  ✅ 交互式 HTML Widget             │
│  ✅ 流式渲染                │  ✅ Chart.js/D3 图表               │
│  ✅ 自定义 HTML 元素        │  ✅ sendPrompt() 回调               │
│     <code-stats>            │  ✅ CSS Variables 主题             │
│  ✅ Artifact 系统(持久化)    │  ✅ CDN 外部库                     │
│                            │                                    │
│  MCP:                       │  MCP:                             │
│  • Claude Preview           │  • visualize (show_widget)        │
│    (dev server 预览)        │    (内联可视化)                     │
│  • CoworkArtifacts          │  • CoworkArtifacts                 │
│    (持久化 HTML 页面)        │    (持久化 HTML 页面)              │
│                            │                                    │
└────────────────────────────┴────────────────────────────────────┘
```

---

## 三、Desktop (CCD) 的渲染机制

### 3.1 消息流

```
User sends message
  │
  ▼
Claude Code CLI subprocess (spawned by Agent SDK)
  │
  ├── stdout JSON-RPC stream
  │     │
  │     ├── {type: "assistant", content: [{type: "text", text: "..."}]}
  │     ├── {type: "tool_use", name: "Bash", ...}
  │     └── {type: "tool_result", ...}
  │
  ▼
handleAssistantMessage()  (index.js:416388)
  │
  ├── messageBuffer.push(message)
  ├── trimMessageBuffer()
  ├── 处理 cron jobs
  ├── 处理 planPath
  └── emit("event", ...)
  │
  ▼
React Frontend (Electron renderer process)
  │
  ├── ChatMessageList → 遍历 messageBuffer
  ├── ContentBlock → 解析 type: "text"
  │     ├── Markdown → React Markdown 组件
  │     │     ├── 代码块 → <pre><code> + 语法高亮
  │     │     ├── 表格 → <table>
  │     │     ├── 内联代码 → <code>
  │     │     └── 链接/图片/列表 → 对应 HTML
  │     └── 自定义元素 → 注册的 React 组件
  │           └── <code-stats> → CodeStats 组件
  ├── ToolUse → ToolCard 组件
  └── ToolResult → ToolResultCard 组件
```

### 3.2 关键技术栈

| 层 | 技术 |
|----|------|
| API 通信 | Anthropic API (stream-json) |
| 文本格式 | Markdown (标准 CommonMark + GFM) |
| 前端框架 | React 18 |
| 代码高亮 | 自定义实现 (无 Prism/highlight.js) |
| Markdown 渲染 | 自定义 React 组件 (无 marked/markdown-it) |
| 表格渲染 | React 表格组件 |
| Mermaid | Artifact 系统加载 (CDN jsdelivr + SRI) |

### 3.3 自定义 HTML 元素

在消息文本中嵌入的 HTML 标签由 React 组件渲染：

```javascript
// index.js:414370 — 代码统计
emitSyntheticAssistantMessage(session, "<code-stats></code-stats>")

// index.js:414373 — 填充 JSON 数据
emitSyntheticAssistantMessage(session, 
  `<code-stats>${JSON.stringify(stats)}</code-stats>`)
```

处理方式：
- `<code-stats>` → React `CodeStats` 组件 (内联渲染统计面板)
- 未来可扩展更多自定义元素

### 3.4 Artifact 系统（Desktop/Cowork 共享）

Desktop 和 Cowork 都使用 `CoworkArtifacts` 系统：
- 写入 HTML 到 `Documents/Claude/Artifacts/{slug}/index.html`
- 在独立窗口中渲染（iframe sandbox + CSP）
- 持久化、可收藏、可导出导入

---

## 四、Claude Preview 服务器（Desktop 专属）

`Pae = "Claude Preview"` — 管理本地 dev server 预览。这是 Desktop 独有的 Web 开发预览能力。

### 4.1 工具清单

| 工具 | 功能 |
|------|------|
| `preview_start` | 按 `.claude/launch.json` 启动 dev server |
| `preview_stop` | 停止 server |
| `preview_list` | 列出运行中的 server |
| `preview_logs` | 获取 server stdout/stderr (支持过滤) |
| `preview_console_logs` | 获取浏览器 console 输出 |
| `preview_screenshot` | 页面截图 (JPEG) |
| `preview_snapshot` | 无障碍树快照 (验证文本/结构) |
| `preview_inspect` | CSS 选择器检查元素 (computed styles) |
| `preview_click` | 点击元素 |
| `preview_fill` | 填写表单 |
| `preview_hover` | 悬停元素 |
| `preview_navigate` | 导航到 URL |
| `preview_eval` | 执行 JS |
| `preview_reload` | 刷新页面 |
| `preview_resize` | 调整 viewport |

### 4.2 launch.json 格式

```json
{
  "configurations": [
    {
      "name": "frontend",
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": ".",
      "autoPort": true,
      "port": 3000
    },
    {
      "name": "backend",
      "command": "python",
      "args": ["-m", "uvicorn", "main:app", "--port", "8000"],
      "autoPort": false,
      "port": 8000
    }
  ]
}
```

### 4.3 启用条件

```javascript
isEnabled: (session) =>
  featureFlag("2976814254") &&
  session.sessionType === "ccd" &&
  !session.isSSH &&
  userSetting("launchEnabled") !== false
```

---

## 五、Cowork (VM) 的 visualize 服务器

`QJn = "visualize"` — 仅在 Cowork VM 会话中可用。

### 5.1 工具清单

| 工具 | 功能 |
|------|------|
| `show_widget` | 在聊天流中内联渲染 SVG/HTML |
| `read_me` | 加载 Imagine 设计模块 |

### 5.2 read_me 模块

```
diagram       → SVG 流程图、结构图、示意图
mockup        → UI 模型、表单、卡片
interactive   → 交互式解释器 (滑块、按钮)
data_viz      → 数据可视化 (Chart.js)
chart         → 图表
art           → 生成艺术
elicitation   → 技能参数收集表单
```

### 5.3 启用条件

```javascript
isEnabled: (session) =>
  featureFlag("3444158716") &&
  session.sessionType === "cowork"
```

---

## 六、完整 UI 生成能力矩阵

| 能力 | Desktop (CCD) | Cowork (VM) |
|------|:---:|:---:|
| Markdown 渲染 | ✅ React 组件 | ✅ React 组件 |
| 代码块语法高亮 | ✅ 内置 | ✅ 内置 |
| 表格渲染 | ✅ Markdown | ✅ Markdown |
| Mermaid 图表 | ✅ Artifact CDN | ✅ Artifact CDN |
| 内联 SVG | ❌ | ✅ show_widget |
| 交互式 HTML Widget | ❌ | ✅ show_widget |
| Elicitation 表单 | ❌ | ✅ show_widget |
| Chart.js 图表 | ❌ | ✅ show_widget |
| Dev Server 预览 | ✅ Claude Preview | ❌ |
| 页面截图/检查 | ✅ Claude Preview | ❌ |
| Artifact 持久化 | ✅ | ✅ |
| Custom HTML 元素 | ✅ <code-stats> | ✅ show_widget |

---

## 七、关键发现

1. **Desktop 的 UI 渲染是"被动"的** — Claude 输出 Markdown，React 前端渲染
2. **Cowork 的 UI 渲染是"主动"的** — Claude 调用 `show_widget` 工具生成 HTML
3. **Claude Preview 不是可视化工具** — 它是 dev server 管理工具，用于 Web 开发预览
4. **两个模式共享 Artifact 系统** — 持久化 HTML 页面在这两种模式下都可用
5. **Imagine 设计规范是 Cowork 专属** — Desktop 中无法使用 `show_widget`/`read_me`
6. **`<code-stats>` 是 Desktop 唯一的自定义 UI 元素** — 远不如 Cowork 的 show_widget 灵活
