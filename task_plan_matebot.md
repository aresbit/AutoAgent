# Task Plan: AutoAgent MateBot Modernization

## Goal
[One sentence describing the end state]

## Tasks

| ID | Task | Status | Depends On | Verify |
|----|------|--------|------------|--------|
| T1 | Understand user intent and constraints | complete | — | — |
| T2 | Define approach and structure | complete | T1 | — |
| T3 | Implement the plan | complete | T2 | — |
| T4 | Verify requirements are met | complete | T3 | — |
| T5 | Review outputs and deliver | complete | T4 | — |
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
| T21 | M5.1 P1：独立 CSP artifact frame（短期 token/专用端点/注入 resize）+ 面板交互 + 版本计数修复 | pending | T18, T19 | exists:backend/src/autoagent_backend/api/routes/artifact_frame.py |

## Notes
-
