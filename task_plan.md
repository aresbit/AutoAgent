# Task Plan: AutoAgent Desktop Cross-Platform Refactor

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
| T6 | 诊断并复现 Linux X11/Wayland 桌面启动与性能差异，收集日志/命令证据 | complete | — | exists:docs/cross-platform/diagnosis.md |
| T7 | 根因对比：maxwire 与 AutoAgent 的启动器/Electron 参数/打包布局/沙箱/GPU 路径 | complete | T6 | exists:docs/cross-platform/root-cause.md |
| T8 | 重构 Linux 启动器：Wayland/X11 协议选择、沙箱策略、日志与崩溃兜底 | complete | T7 | changed:packaging/deb/usr/bin/autoagent |
| T9 | 加固 Electron 主进程：移除 in-process-gpu、GPU 降级、显示环境探测与加载失败恢复 | complete | T7 | changed:src/main.ts |
| T10 | 按 maxwire 方式重构打包：/opt/autoagent 自包含布局、4755 chrome-sandbox、依赖与 preinst/postinst | complete | T8, T9 | changed:scripts/build-deb.sh |
| T11 | 用四个参考技能产出可复用 maxwire 风格打包技能与改造文档 | complete | T7 | exists:docs/cross-platform/packaging-playbook.md |
| T12 | 独立评估：X11 实机与 Wayland 嵌套合成器启动、打包审计、回归测试 | complete | T10, T11 | exists:docs/cross-platform/evaluation.md |
| T13 | 应用最终候选并归档证据、更新 PM/SE 账本 | complete | T12 | exists:docs/cross-platform/README.md |

## Notes
-
