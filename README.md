# AutoAgent

> A high-performance desktop AI coding agent — local-first, multi-model, extensible.

AutoAgent is an Electron-native desktop application that puts a full-featured AI coding agent at your fingertips. It combines a reactive GUI with a high-throughput inference engine to deliver real-time code generation, multi-file refactoring, and autonomous tool orchestration — all running locally on your machine.

## Architecture

```
Desktop (Electron)          Inference Engine (Bun)
┌──────────────────┐       ┌──────────────────────┐
│  Renderer (TSX)  │  IPC  │  cli.js -p            │
│  Chat / MCP /    │◄─────►│  stream-json stdio    │
│  Skills / Git    │       │  (Agent SDK pathway)  │
└──────────────────┘       └──────────────────────┘
        │                          │
        ▼                          ▼
┌──────────────────┐       ┌──────────────────────┐
│  SQLite + JSON   │       │  ask() → tool pool    │
│  Session persist │       │  MCP → permissions    │
└──────────────────┘       │  partial stream       │
                           │  ~/.autoagent.json    │
                           └──────────────────────┘
```

- **Frontend**: TypeScript + React SPA with custom IPC bridge to Electron main process
- **Engine**: Long-running `cli.js -p --input-format stream-json --output-format stream-json --verbose` subprocess. This reuses the mature Agent SDK/print pathway (ask(), tool pool, MCP, permissions, partial stream) instead of a custom desktop-only agent loop. The process is restarted when config (model, cwd, etc.) changes.
- **Protocol**: Newline-delimited JSON (JSONL) on stdio — user messages in, `stream_event` / `assistant` / `user` / `result` messages out. Control requests (tool permissions) auto-responded.
- **Persistence**: SQLite for structured state (chats, messages, MCP servers), JSON for settings; automatic WAL-mode migration
- **Distribution**: Single `.deb` package with bundled Bun runtime — zero external dependencies beyond `libc`

## Features

### Agent Core
- **Multi-provider inference** — Anthropic Messages API, Codex-compatible backends, DeepSeek, and custom endpoints. Switch providers per session without restarting
- **Persistent CLI subprocess** — single long-running `cli.js -p` process reused across queries; the CLI owns tools, MCP, permissions, compaction, and session state. Restarted only when config changes (model, cwd, etc.)
- **Streaming output** — real-time token streaming via `text_delta` stream events; tool-use and thinking events passthrough
- **Permission control** — bypass, accept-edits, auto, and default modes; configurable per session
- **Configurable tool allowlist** — Read, Write, Edit, Glob, Grep, Bash, WebFetch, WebSearch
- **Max-turns governor** — hard limit on agent loops to prevent runaway inference

### Session Management
- **Persistent chat sessions** — all conversations survive restarts; stored as JSON with SQLite metadata index
- **Session branching** — fork any conversation at any point to explore alternative approaches
- **Chat history browser** — sidebar navigation with inline delete and branch controls

### MCP (Model Context Protocol)
- **Full MCP client** — stdio, HTTP streamable, and SSE transports
- **Server registry** — persisted server configurations with enable/disable toggles
- **Tool discovery** — inspect MCP server tool manifests directly from the UI
- **Bundled defaults** — ships with default MCP server definitions for common tools

### Skills System
- **Dual-source skill scanner** — system-level (`~/.claude/skills/`) and project-level (`.claude/skills/`)
- **SKILL.md parser** — extracts YAML frontmatter descriptions and presents them in the UI
- **Toggle per skill** — enable/disable individual skills; toggles persist across sessions
- **Auto-append** — enabled skills are injected into the system prompt automatically

### Workspace Integration
- **Git awareness** — diff stats, branch listing, changed file inventory; all computed from the configured workspace directory
- **Directory picker** — native OS directory chooser for selecting workspace
- **File system tools** — glob pattern matching, regex grep with ripgrep, file read/write/edit

### Desktop Experience
- **Single-instance lock** — dock icon click focuses existing window instead of spawning duplicates
- **Startup-optimized** — in-process GPU on Linux, lazy SQLite init, deferred config sync
- **Dark theme** — `#0d0f12` background with system theme detection
- **Linux-first packaging** — `.deb` with hicolor icon theme integration, `desktopFileName` WM_CLASS matching
- **System notifications** — native OS notifications for long-running agent completions

## Quick Start

### Installation

Download the latest `.deb` from [GitHub Releases](https://github.com/aresbit/AutoAgent/releases):

```bash
sudo dpkg -i autoagent_0.3.0_amd64.deb
```

This installs:
- `/usr/bin/autoagent` — launcher script
- `/usr/lib/autoagent/` — application bundle (bun runtime + JS bundles)
- `/usr/share/applications/autoagent.desktop` — DE integration
- `/usr/share/icons/hicolor/*/apps/autoagent.png` — app icons

Launch from your application launcher, or run `autoagent` from the terminal.

### First Launch

1. Open AutoAgent from your app launcher (or run `autoagent` in a terminal)
2. The settings panel opens on the right — click the **Agent** tab
3. Configure your provider:

| Field | What to enter |
|---|---|
| Provider | Select `anthropic` for Claude, `codex` for Codex-compatible models, or a custom provider |
| API type | Auto-selected based on provider; `anthropic-messages` or `codex-completions` |
| Model | e.g. `claude-sonnet-4-6`, `deepseek-v4-pro[1m]`, `deepseek-chat` |
| Base URL | Your API endpoint; auto-filled for known providers |
| API key | Your provider API key; stored locally in `~/.autoagent/` |
| Workspace | The project directory the agent will operate in |

4. Click **Save**

### Your First Session

1. Click **New Session** in the sidebar
2. Type a prompt in the composer at the bottom — e.g.:
   > *"Explain the project structure and suggest improvements"*
3. Press `Ctrl+Enter` (or `Cmd+Enter`) to send
4. The agent streams its response in real time; tool invocations appear inline
5. Click **Stop** to abort a running query at any time

### Working with Skills

AutoAgent scans two skill directories:
- `~/.claude/skills/` — your personal, cross-project skills
- `<workspace>/.claude/skills/` — project-specific skills

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter. Go to the **Skills** tab, click **Scan**, and toggle the skills you want active.

### MCP Servers

In the **MCP** tab:
1. Enter a **Display ID** (e.g., `playwright`)
2. Select the transport — `stdio` for CLI tools, `http`/`sse` for remote servers
3. Fill in the command/URL and environment variables
4. Click **Save MCP**, then **Discover** to verify tool availability

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | Send prompt |
| `Ctrl+Shift+B` | Stop running agent |

## Building from Source

### Linux / macOS

```bash
# Prerequisites: bun >= 1.2.0, node >= 18
bun install

# Development (build + launch Electron)
bun run dev

# Production build only
bun run build

# Build .deb package
bash scripts/build-deb.sh
```

### Windows

#### 环境准备

1. 安装 [Bun](https://bun.sh/)（>= 1.2.0）和 Node.js（>= 18）
2. 安装 [ripgrep](https://github.com/BurntSushi/ripgrep/releases)（`rg.exe`），确保 `rg` 在环境变量 `PATH` 中可用
3. 安装项目依赖：
   ```powershell
   bun install
   ```

#### 开发调试

```powershell
# 构建并启动 Electron
bun run dev
```

#### 打包生产版本

```powershell
# 1. 先构建桌面资源（生成 dist/、build-resources/ 等）
bun run build

# 2. 运行 Windows 本地打包脚本（生成安装程序和便携版）
node scripts/package-win-local.mjs
```

打包产物位于 `release/` 目录下：
- `AutoAgent-0.8.0-setup-x64.exe` — NSIS 安装程序
- `AutoAgent-0.8.0-portable-x64.exe` — 免安装便携版

#### 只打特定格式

```powershell
# 仅生成便携版
node scripts/package-win-local.mjs -- portable

# 仅生成安装程序
node scripts/package-win-local.mjs -- nsis

# 仅输出未打包目录（用于调试）
node scripts/package-win-local.mjs --dir
```

#### 常见问题

| 问题 | 解决方案 |
|---|---|
| `rg.exe` 找不到 | 安装 ripgrep 并添加到 PATH，或设置环境变量 `RG_BIN` 指向 `rg.exe` |
| `app-builder.exe EPERM` | 以管理员身份运行终端，或将项目移出受限目录 |
| 文件被占用 | 关闭所有 AutoAgent/Electron 窗口，关闭资源管理器中的 `release\win-unpacked` 预览，再重试 |

## Project Structure

```
autoagent/
├── src/
│   ├── main.ts              # Electron main process
│   ├── preload.ts           # Context bridge (IPC)
│   ├── engine-client.ts     # cli.js subprocess manager
│   ├── renderer/            # Frontend SPA
│   │   ├── app.ts           # UI logic, state, IPC handlers
│   │   ├── index.html       # Shell
│   │   └── style.css        # Dark-theme stylesheet
│   └── providers/           # Built-in & custom provider configs
├── packages/opencc/         # Inference engine (Bun)
│   ├── src/
│   │   ├── entrypoints/
│   │   │   ├── cli.tsx       # CLI entry (--server, -p, interactive)
│   │   │   └── server.ts     # JSON-RPC App Server + ThreadManager
├── packaging/deb/           # .deb template
│   ├── DEBIAN/              # control, postinst
│   └── usr/                 # install tree
├── scripts/build-deb.sh     # One-shot .deb builder
├── assets/                  # App icons (16x16 → 512x512)
├── package.json
└── tsconfig.json
```

## Contributing

Feature branches off `master`:

```bash
git checkout -b feat/<name>
# ... implement, test
git commit -m "feat: description"
git checkout master && git merge feat/<name>
```

Keep commits atomic. Use `feat:`, `fix:`, `refactor:`, `chore:` prefixes.
