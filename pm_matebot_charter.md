# PM Charter: AutoAgent MateBot Modernization

## Operating Model
- Human leads architecture and sequencing.
- AI executes scoped tasks, then human audits and refactors continuously.

## Tasks

| ID | Task | Status | Depends On | Verify |
|----|------|--------|------------|--------|
| T1 | Agree problem statement and success metrics | complete | — | — |
| T2 | Select and freeze the language/runtime | complete | T1 | — |
| T3 | Document module boundaries and data flow | complete | T2 | — |
| T4 | Implement features with a refactor pass each cycle | complete | T3 | — |
| T5 | Complete validation and prepare delivery notes | complete | T4 | — |
| T6 | 调研 MateBot 后台链接、opencc --matebot 协议、vendored 差异与旧桌面能力清单 | complete | — | exists:docs/matebot-modernization/recon.md |
| T7 | 架构与 API 契约：Electron 薄壳 + Python 后端 + React SPA，定义 REST/SSE 与迁移边界 | complete | T6 | exists:docs/matebot-modernization/architecture.md |
| T8 | 同步 vendored opencc 到 MateBot 版本并验证 --matebot 协调器模式 | complete | T7 | exists:docs/matebot-modernization/opencc-sync.md |
| T9 | Python 后端纵切：health/settings/sessions/chat + 长驻 opencc --matebot 引擎 + SSE | complete | T7 | exists:backend/autoagent/server.py |
| T10 | Electron 薄壳：Python 后端生命周期、健康探针、端口协商、加载 SPA、日志与退出兜底 | complete | T7 | exists:desktop/main.cjs |
| T11 | 现代前端：React+TS+Tailwind/shadcn，Apple 动效与 Claude 设计系统，替换单体 app.tsx | complete | T7 | exists:frontend/src/App.tsx |
| T12 | 集成与打包：构建链、Python 后端随包、deb、Wayland/X11 启动 | complete | T8, T9, T10, T11 | exists:docs/matebot-modernization/packaging.md |
| T13 | 独立评估：API 契约、--matebot 流式对话、现代前端、X11/Wayland、打包回归 | complete | T12 | exists:docs/matebot-modernization/evaluation.md |
| T14 | 交付文档、迁移说明与可复用技能沉淀 | complete | T13 | exists:docs/matebot-modernization/README.md |
| T15 | M5 后端：skills/MCP/workspace/artifacts 端口、适配器与路由 | complete | T9 | exists:backend/tests/integration/test_skills.py |
| T16 | M5 前端：skills/MCP/workspace/artifacts 面板与 API 客户端 | complete | T11 | exists:frontend/src/features/skills |
| T17 | Vendor MateBot/opencc，接入 OpenccSession 长连接，并复用 ~/.claude/settings.json 模型 | complete | T9 | exists:vendor/matebot/opencc_backend.py |
| T18 | M5.1 后端：artifact 物化、不可变版本/manifest/sha256、SSE 顺序与版本 API | complete | T17 | exists:backend/src/autoagent_backend/application/artifact_materializer.py |
| T19 | M5.1 前端：安全 ArtifactFrame（sandbox/CSP）、聊天卡片与面板联动、/api/events 刷新 | complete | T17 | exists:frontend/src/features/artifacts/ArtifactFrame.tsx |
| T20 | M5.1 独立安全评估：物化/SSE 顺序/沙箱/CSP/版本恢复/面板联动 | complete | T18, T19 | exists:docs/matebot-modernization/evaluation.md |
| T21 | M5.1 P1：独立 CSP artifact frame（短期 token/专用端点/注入 resize）+ 面板交互 + 版本计数修复 | complete | T18, T19 | exists:backend/src/autoagent_backend/api/routes/artifact_frame.py |
| T22 | M5.2 后端：artifact 能力白名单/tools.call + 审计 + 版本 diff API | complete | T21 | exists:backend/src/autoagent_backend/application/artifact_diff.py |
| T23 | M5.2 前端：artifact JSON-RPC 桥/consent + 版本 diff/split UI | complete | T21 | exists:frontend/src/features/artifacts/bridge.ts |
| T24 | M5.2 桌面：autoagent-artifact 自定义协议 + 专用 preload/partition 子窗口 | complete | T21 | exists:desktop/src/artifact-preload.ts |
| T25 | M5.2 独立安全评估：工具桥 consent/配额/审计、diff、协议子窗口隔离 | in_progress | T22, T23, T24 | exists:docs/matebot-modernization/evaluation.md |
| T26 | M5.2 收尾前端：Open in window 接线 + artifact capabilities 编辑器 | complete | T24 | exists:frontend/src/features/artifacts/CapabilitiesEditor.tsx |
| T27 | M5.2 收尾桌面：native bridge 签名对齐与协议资产打包验证 | complete | T24 | exists:desktop/dist/artifact-protocol.js |
| T28 | Terminal T0：stdlib PTY manager + WebSocket + xterm 面板 | complete | T27 | exists:backend/src/autoagent_backend/adapters/terminal/manager.py |
| T29 | Filesystem T0：SafeFileService（根作用域/符号链接拒绝/原子写/CAS/Range）+ 文件面板 | complete | T28 | exists:backend/src/autoagent_backend/adapters/files/safe_file_service.py |
| T30 | Browser/Preview T0：PreviewManager（WebContentsView/partition/导航白名单）+ IPC + 预览面板 | complete | T28 | exists:desktop/src/native/preview-manager.ts |
| T31 | 设置页统一选择后端 harness（opencc/claude-code）与 API 来源（Claude/AutoAgent/env），移除独立 Engine tab | complete | T30 | exists:backend/src/autoagent_backend/adapters/engine/harness.py |

## Anti-Trap Control Checklist
- [ ] Vibe coding constrained: no long unreviewed AI coding streaks
- [ ] Fatigue guardrail enabled: avoid late-night prompt loops
- [ ] Code awareness maintained: read each AI patch and keep module map updated
- [ ] Design decisions made early: no repeated "later" deferrals for core architecture
- [ ] Time context logged: external API evolution notes include explicit dates
