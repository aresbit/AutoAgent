#!/usr/bin/env python3
"""PreToolUse 护栏：允许关闭功能 ⟺ (有超时) ∧ (点名具体功能)。

来源
----
codyho.dev《I Came, I Prompted, I Left》Part 1（本仓 workspace 外的 opc2 讲义见
`cs/硬件设计/apple-silicon-re/ch05_LLM无人值守工作流.md` §2.3）。作者在无人值守循环里
观察到：agent 遇到报错时最廉价的"让错误消失"手段就是把出错的东西关掉。

作者的第一版规则是"任何情况下都不许关闭功能"，但那样连调试都做不了；最终规则是：

    If I wanted to give Codex freedom to turn something off after debugging,
    I would usually tell it to set a timer, and if at the end of the timer only
    then did it have permission to turn off that specific feature.

即 **两个条件缺一不可**：
  - 没有 timer  → agent 会在"调试中"就关掉它，从而失去调试对象；
  - 没有点名    → 会变成"顺手也关了邻近的三个"（作者实录：Codex 正确关掉
                  TrustedAccessory 时，顺手关了 xars / AppleEpochManager /
                  AppleMobileApNonceNVRAM，导致 SEP 拒绝解密；作者原话是
                  "I had not noticed because it was two lines of code in a sea
                  of changes"）。

为什么这个仓需要它
------------------
`opencc_backend.py` 以 `--dangerously-skip-permissions` 启动 CLI（见 _spawn），
**没有人工确认关卡**。因此 PreToolUse hook 是唯一还能落护栏的地方。
`xiaoshutong_run.sh` 又是 cron 无人值守跑的。两者叠加 = 博客里的场景。

本护栏管什么、不管什么
----------------------
管：**Bash 工具调用**里显式的「关闭 / 跳过 / 绕过」操作。
不管：Edit/Write 把某个检查悄悄注释掉、或者在海量 diff 里改坏一件事。
      —— 作者本人也没有解决这个问题（"I don't have a great idea for how to
      prevent problems like this"）。**不要把本护栏当成"已解决"。**

失败姿态
--------
命中模式但缺条件 → **拒绝**（exit 2）。
脚本自身异常    → **放行**（exit 0）+ stderr 告警，避免护栏 bug 把整个 harness 卡死。
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# ── 命中模式表 ────────────────────────────────────────────────────────────
# 刻意收窄：只认**显式**的关闭/跳过动作，不猜。过宽的护栏会误伤正常操作，
# 这在博客里也是作者踩过的坑（"主动关掉"的教训）。
DISABLE_PATTERNS: list[tuple[str, str]] = [
    # 权限 / 校验类开关
    (r"--dangerously-skip-permissions", "跳过权限确认"),
    (r"--no-verify\b", "跳过 git 钩子校验"),
    (r"--no-gpg-sign\b", "跳过提交签名"),
    (r"--skip-[A-Za-z0-9_-]+", "显式 skip 标志"),
    (r"(?<![-\w])--ignore[= ][^\s;|&]+", "排除测试/文件"),
    (r"\bpytest\b[^\n;|&]*\s-k\s+['\"]?not\s", "pytest -k 'not ...' 排除用例"),
    # 服务 / 系统开关
    (r"\bsystemctl\s+(?:--\S+\s+)*(?:stop|disable|mask)\b", "停止/禁用 systemd 单元"),
    (r"\bservice\s+\S+\s+stop\b", "停止 service"),
    (r"\bufw\s+disable\b", "关闭防火墙"),
    (r"\bsetenforce\s+0\b", "关闭 SELinux"),
    (r"\biptables\s+-F\b", "清空 iptables 规则"),
    (r"\bswapoff\b", "关闭 swap"),
    # 禁用类环境变量：FOO_DISABLE=1 / SKIP_TESTS=1 / NO_VALIDATE=1
    (r"\b[A-Z][A-Z0-9_]*(?:DISABLE|DISABLED|SKIP|BYPASS|NOCHECK|NO_VALIDATE)[A-Z0-9_]*\s*=",
     "禁用类环境变量"),
]

# ── 放行条件 ──────────────────────────────────────────────────────────────
TTL_PATTERN = re.compile(
    r"(?:\btimeout\s+\d+)"            # timeout 600 cmd
    r"|(?:--timeout[= ]\d+)"          # --timeout=600
    r"|(?:\bMATEBOT_GUARD_TTL=\d+)"   # MATEBOT_GUARD_TTL=600
)
SCOPE_PATTERN = re.compile(r"\bMATEBOT_GUARD_SCOPE=([^\s;|&]+)")

# 不接受这些"点名"——它们等于没点名
VAGUE_SCOPES = {"*", "all", "any", "everything", "1", "true", "yes", "todo", "tbd"}

# 本护栏自己放行自己（避免递归 / 自锁）
EXEMPT_MARKERS = ("guard-disable.py", "MATEBOT_GUARD_BOOTSTRAP=1")


def _log(entry: dict) -> None:
    """审计留痕。写不进去也不能影响判定。"""
    try:
        log = Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")) / "hooks" / "guard.log"
        line = json.dumps(entry, ensure_ascii=False)
        with log.open("a", encoding="utf-8") as fh:
            fh.write(f"[{datetime.now().isoformat(timespec='seconds')}] {line}\n")
    except Exception:
        pass


def evaluate(payload: dict) -> tuple[bool, str, str]:
    """返回 (是否放行, 命中说明, 拒绝理由)。"""
    tool = payload.get("tool_name", "")
    if tool != "Bash":
        return True, "", ""

    command = (payload.get("tool_input") or {}).get("command", "") or ""
    if not command.strip():
        return True, "", ""

    if any(marker in command for marker in EXEMPT_MARKERS):
        return True, "", ""

    hits = [label for pattern, label in DISABLE_PATTERNS if re.search(pattern, command)]
    if not hits:
        return True, "", ""

    has_ttl = bool(TTL_PATTERN.search(command))
    scope_match = SCOPE_PATTERN.search(command)
    scope = scope_match.group(1).strip().strip("'\"") if scope_match else ""
    has_scope = bool(scope) and scope.lower() not in VAGUE_SCOPES

    if has_ttl and has_scope:
        return True, " / ".join(hits), f"已按护栏放行（scope={scope}，含超时）"

    missing = []
    if not has_scope:
        missing.append("没有点名具体功能（缺少 MATEBOT_GUARD_SCOPE=<功能名>）")
    if not has_ttl:
        missing.append("没有超时（缺少 timeout <秒> 或 MATEBOT_GUARD_TTL=<秒>）")

    reason = (
        "⛔ 护栏拦截：检测到「关闭 / 跳过 / 绕过」类操作。\n"
        f"   命中：{' / '.join(hits)}\n"
        f"   缺失：{'；'.join(missing)}\n"
        "\n"
        "   规则（codyho.dev 无人值守工作流）：允许关闭功能 ⟺ (有超时) ∧ (点名具体功能)。\n"
        "   两个条件缺一不可 —— 没有 timer 会失去调试对象；没有点名会顺手关掉邻近的东西。\n"
        "\n"
        "   要放行，把两个条件写进同一条命令：\n"
        "     MATEBOT_GUARD_SCOPE=<被关闭的具体功能名> MATEBOT_GUARD_TTL=<秒数> <你的命令>\n"
        "   例：\n"
        "     MATEBOT_GUARD_SCOPE=user-data-decryption MATEBOT_GUARD_TTL=600 systemctl stop foo\n"
        "\n"
        "   不接受 * / all / any 这类不点名的写法。\n"
        "   如果这个操作其实不该被关，请改代码而不是关掉它 —— 这正是本护栏要挡的。"
    )
    return False, " / ".join(hits), reason


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception as exc:  # noqa: BLE001 — 护栏自身出错要放行，不能卡死 harness
        print(f"[guard-disable] 输入解析失败，放行：{exc}", file=sys.stderr)
        return 0

    try:
        allowed, hits, reason = evaluate(payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[guard-disable] 判定异常，放行：{exc}", file=sys.stderr)
        return 0

    if allowed:
        if hits:
            _log({"decision": "allow", "hits": hits, "note": reason,
                  "cmd": (payload.get("tool_input") or {}).get("command", "")[:500]})
        return 0

    _log({"decision": "deny", "hits": hits,
          "cmd": (payload.get("tool_input") or {}).get("command", "")[:500]})
    print(reason, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
