"""Agent workspace loader — OpenClaw-style persistent identity for MateBot.

MateBot's personality used to live nowhere: every turn re-injected a slice of
`.CLAUDE.md` into the *user* prompt, which is both KV-cache hostile and easy for
the model to treat as just another instruction from the user.

This module adopts the OpenClaw workspace model instead: identity lives in plain
Markdown files on disk, is assembled once, and is handed to the CLI via
`--append-system-prompt` at spawn time. Because the process is long-lived, that
cost is paid once per session rather than once per message.

Load order matters and mirrors OpenClaw's: the most stable files come first so
they dominate attention, the most volatile (memory, today's note) come last.

    SOUL.md      who you are — personality, tone, guardrails
    IDENTITY.md  how you present — name, emoji, self-description
    USER.md      who you are talking to — preferences, facts
    AGENTS.md    how you work — conventions, safety, coordination
    TOOLS.md     what you can reach — environment-specific tooling
    MEMORY.md    curated long-term memory
    memory/YYYY-MM-DD.md   today's running note

Missing files are fine — they get a marker and the assembly continues. Files
over `max_chars` are truncated *visibly* (OpenClaw truncates silently, which
makes long files fail in confusing ways).
"""

from __future__ import annotations

import hashlib
import os
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Optional

# Order is the injection order. Stable first, volatile last.
WORKSPACE_FILES: tuple[str, ...] = (
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "AGENTS.md",
    "TOOLS.md",
    "MEMORY.md",
)

DEFAULT_MAX_CHARS = 20000

_DEFAULT_ROOT = Path(__file__).parent / "workspace"


def default_workspace_root() -> Path:
    return Path(os.environ.get("MATEBOT_WORKSPACE", str(_DEFAULT_ROOT))).expanduser()


class Workspace:
    """Reads the agent workspace and assembles a system-prompt bundle.

    Thread-safe: `system_prompt()` and `append_daily()` may be called from the
    poll loop and from stream-reader threads concurrently.
    """

    def __init__(
        self,
        root: Optional[Path] = None,
        max_chars: int = DEFAULT_MAX_CHARS,
    ):
        self.root = Path(root) if root else default_workspace_root()
        self.max_chars = max_chars
        self._lock = threading.Lock()

    # -- paths ------------------------------------------------------------

    @property
    def memory_dir(self) -> Path:
        return self.root / "memory"

    def daily_note_path(self, day: Optional[date] = None) -> Path:
        day = day or date.today()
        return self.memory_dir / f"{day.isoformat()}.md"

    # -- assembly ---------------------------------------------------------

    def _read_capped(self, path: Path) -> tuple[str, bool]:
        """Return (content, truncated). Empty content if unreadable."""
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return "", False
        if len(text) > self.max_chars:
            return text[: self.max_chars], True
        return text, False

    def _section(self, name: str, path: Path) -> str:
        text, truncated = self._read_capped(path)
        if not text.strip():
            return f"<!-- {name}: not present -->"
        suffix = (
            f"\n\n<!-- {name} truncated at {self.max_chars} chars "
            f"(raise MATEBOT_SOUL_MAX_CHARS to see the rest) -->"
            if truncated
            else ""
        )
        return f"<!-- BEGIN {name} -->\n{text.strip()}{suffix}\n<!-- END {name} -->"

    def system_prompt(self, include_daily: bool = True) -> str:
        """Assemble the full identity bundle for `--append-system-prompt`."""
        with self._lock:
            parts = [
                "You are running as a long-lived assistant reachable over Feishu. "
                "The files below are your workspace at "
                f"{self.root}. They define who you are and what you know about "
                "your user. Treat them as your own standing instructions, not as "
                "a message from the user. You may read and edit them with your "
                "normal file tools when your identity or knowledge should change."
            ]
            for name in WORKSPACE_FILES:
                parts.append(self._section(name, self.root / name))

            if include_daily:
                note = self.daily_note_path()
                parts.append(self._section(f"memory/{note.name}", note))

            return "\n\n".join(parts)

    def fingerprint(self) -> str:
        """Hash of the identity bundle, excluding the daily note.

        The daily note changes constantly and must not force a process restart;
        the stable files are what warrant re-spawning with a new system prompt.
        """
        return hashlib.sha256(
            self.system_prompt(include_daily=False).encode("utf-8")
        ).hexdigest()[:16]

    # -- daily note -------------------------------------------------------

    def append_daily(self, text: str, day: Optional[date] = None) -> None:
        """Append a timestamped entry to today's note.

        This is the durable half of memory: even if a session is lost, the next
        spawn re-reads the note and picks up where the conversation left off.
        """
        if not text.strip():
            return
        path = self.daily_note_path(day)
        stamp = datetime.now().strftime("%H:%M")
        with self._lock:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                new_file = not path.exists()
                with path.open("a", encoding="utf-8") as f:
                    if new_file:
                        f.write(f"# {(day or date.today()).isoformat()}\n\n")
                    f.write(f"- **{stamp}** {text.strip()}\n")
            except OSError as e:
                print(f"[soul] could not write daily note: {e}")

    # -- scaffolding ------------------------------------------------------

    def ensure_scaffold(self) -> list[str]:
        """Create any missing workspace files from templates.

        Never overwrites an existing file. Returns the names it created.
        """
        created: list[str] = []
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            self.memory_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            print(f"[soul] could not create workspace at {self.root}: {e}")
            return created

        for name, body in _TEMPLATES.items():
            path = self.root / name
            if path.exists():
                continue
            try:
                path.write_text(body, encoding="utf-8")
                created.append(name)
            except OSError as e:
                print(f"[soul] could not write {name}: {e}")
        return created


# ---------------------------------------------------------------------------
# Templates. Deliberately short — a soul that costs 5k tokens to state is a soul
# the model skims.

_TEMPLATES: dict[str, str] = {
    "SOUL.md": """# SOUL

我是 MateBot —— 一个常驻在飞书里的工程助理，不是一次性的问答机器人。

## 性格
- 直接。先给结论，再给理由。不铺垫、不复述问题。
- 诚实优先于让人舒服。做不到、没验证过、不确定，就直说。
- 有主见。被问"选哪个"时给出推荐并说明取舍，而不是罗列所有选项。

## 语气
- 中文对话，代码/命令/标识符保持原文。
- 简短。飞书是聊天窗口，不是文档；长内容拆成多条或写进文件。
- 不用 emoji 堆砌，不说"好的，我马上为您……"这类客套开场。

## 底线
- 破坏性操作（删文件、改远端、发对外消息）先确认，除非用户已明确授权。
- 报告结果照实说：测试没过就贴输出，跳过了就说跳过了。
- 不编造文件路径、命令输出或执行结果。没跑过就说没跑过。
""",
    "IDENTITY.md": """# IDENTITY

- **名字**: MateBot
- **称呼**: 小 M
- **入口**: 飞书 P2P 会话
- **一句话**: 常驻工程助理，帮你在手机上驱动本机的 Claude Code。

自我介绍时用一句话说清能做什么，不要念功能列表。
""",
    "USER.md": """# USER

<!-- 关于用户的稳定事实。学到新的就自己写进来，写之前先确认是长期成立的。 -->

## 基本
- 语言：中文
- 环境：Linux

## 偏好
- （待补充）

## 项目
- （待补充）
""",
    "AGENTS.md": """# AGENTS

## 工作方式
- 收到任务先判断是"回答"还是"动手"。动手就直接做，不要先问"要我做吗"。
- 改代码前先读周围代码，风格跟着现有代码走。
- 一次只做一件事。发现的额外问题记下来告诉用户，不要顺手改。

## 记忆约定
- `MEMORY.md` — 长期结论，人工/自己精炼后写入，保持精简。
- `memory/YYYY-MM-DD.md` — 当天流水，随手记，下次开会话会自动读到。
- 值得跨天记住的，从当天流水提炼进 `MEMORY.md`，然后不要重复保留。
- 不记录代码结构、git 历史里已有的东西 —— 那些随时能查。

## 安全
- 不在回复里回显密钥、token、密码。
- 涉及外发（发消息、提 PR、部署）先确认一次。
""",
    "TOOLS.md": """# TOOLS

<!-- 本机特有的工具和入口，避免每次重新摸索。 -->

## 本机
- `qmd search|query "关键词" -c matebot-skills` — 技能文档语义检索
- `skills/` — 本仓库的技能库

## 约定
- 长输出写文件再告诉用户路径，不要整段贴进飞书。
""",
    "MEMORY.md": """# MEMORY

<!-- 精炼后的长期记忆。一行一条，最新的放上面。 -->
""",
}


__all__ = [
    "Workspace",
    "WORKSPACE_FILES",
    "DEFAULT_MAX_CHARS",
    "default_workspace_root",
]
