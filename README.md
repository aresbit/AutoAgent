# AutoAgent (Desktop)

Electron 桌面版 AI 编码助手，基于 opencc (reverse-engineered Claude Code CLI) 构建。

## 环境要求

- [Bun](https://bun.sh/) >= 1.2.0
- Node.js (Electron 依赖) >= 18
- Linux / macOS

## 快速开始

```bash
# 安装依赖
bun install

# 开发模式（构建并启动 Electron）
bun run dev

# 仅构建
bun run build

# 生产模式启动
bun run start
```

## 项目结构

```
autoagent/
├── src/
│   ├── main.ts          # Electron 主进程
│   ├── preload.ts       # 预加载脚本
│   └── renderer/        # 渲染进程 (前端 UI)
├── packages/
│   └── opencc/          # opencc 核心 (reverse-engineered Claude Code CLI)
├── packaging/           # .deb 打包配置
├── assets/              # 应用图标
├── package.json
└── tsconfig.json
```

## 如何编译

```bash
# 完整构建（Electron 主进程 + 预加载 + 渲染进程）
bun run build

# 构建产物
# dist/main.js       - Electron 主进程
# dist/preload.js    - 预加载脚本
# dist/client/       - 渲染进程前端资源
```

### 打包 .deb

```bash
# 先构建应用，再打包为 .deb
bun run build && cd packaging/deb && ./build.sh
```

## 如何测试

```bash
# 启动开发模式，手动验证功能
bun run dev

# 验证 CLI 核心（opencc）
cd packages/opencc && echo "hello" | bun run src/entrypoints/cli.tsx -p
```

## 如何提交新 Feat

采用 **feat 分支** 工作流：

```bash
# 1. 确认当前在 master 且工作区干净
git checkout master
git status

# 2. 从 master 创建 feat 分支
git checkout -b feat/<功能名称>

# 示例
git checkout -b feat/add-dark-mode

# 3. 开发并提交
git add <files>
git commit -m "feat: 添加暗色模式支持"

# 4. 合并回 master
git checkout master
git merge feat/<功能名称>

# 5. 删除 feat 分支（可选）
git branch -d feat/<功能名称>
```

### 分支命名规范

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat/` | 新功能 | `feat/add-tray-icon` |
| `fix/` | Bug 修复 | `fix/electron-crash` |
| `refactor/` | 重构 | `refactor/ipc-module` |

### Commit 规范

```
feat: 简要描述功能
fix: 简要描述修复
refactor: 简要描述重构内容
chore: 构建/依赖等杂项变更
```
