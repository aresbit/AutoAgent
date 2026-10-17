#!/usr/bin/env python3
"""归档体积失控的 Claude Code 会话（~/.claude/projects/）。

背景：会话 transcript 是只追加的 JSONL，长会话会无界增长。CLI 启动或
`--resume` 时要把它逐行反序列化，一个 100MB 的文件能把 RSS 顶到 1GB+，GC 随即
进入抖动——外部表现就是"打开就卡住，CPU 满载但毫无进展"。

## 单位是「会话」，不是「文件」

磁盘上一个会话是两件东西:

    <uuid>.jsonl        主 transcript
    <uuid>/             sidecar: subagents/（每次自动压缩留一份）、tool-results/ 等

实测里 sidecar 往往比主文件大一个数量级（本机某会话 100MB transcript 配 767MB
sidecar）。只搬走 .jsonl 会留下一个没人会再读的孤儿目录，所以这里按会话整体
决策、整体归档；反过来，transcript 已经不在、只剩 sidecar 的孤儿也会被收走。

## 阈值

默认 --threshold-mb 25，含义是"整个会话占用 >= 25MB 就归档"。25 这个数取自本机
2190 个 transcript 的实测分布：正常会话的主 transcript 最大 8.1MB，10-50MB 之间
是完全真空，25 落在真空中点。--warn-mb 10 是早期哨兵，只报不动。

## 安全边界

  * 默认 dry-run，只有 --apply 才动文件；
  * 会话内任何文件被活进程持有 fd 就整体跳过，--force 也不能越过；
  * mtime 太新的会话默认跳过（--min-age-min），避免动正在写的会话；
  * 主 transcript 压成 .gz、sidecar 压成 .tar.gz，逐文件比对 sha256，全部一致
    才删原件。

注意：归档后该会话不再能被 `--resume` 恢复（数据没丢，在归档里）。MateBot 侧
`opencc_backend.resume_blocker()` 会发现 transcript 不在而自动开新会话。

用法:
  python3 scripts/prune_transcripts.py                    # 体检，只看不动
  python3 scripts/prune_transcripts.py --apply            # 归档超阈值的会话
  python3 scripts/prune_transcripts.py --threshold-mb 50  # 自定义阈值
  python3 scripts/prune_transcripts.py --json             # 机器可读输出
  python3 scripts/prune_transcripts.py --exit-code        # 有超标会话时退出码 1
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import tarfile
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator, Optional

DEFAULT_PROJECTS_DIR = Path.home() / ".claude" / "projects"
DEFAULT_ARCHIVE_DIR = Path.home() / ".claude" / "transcript-archive"

DEFAULT_THRESHOLD_MB = 25.0
DEFAULT_WARN_MB = 10.0
DEFAULT_MIN_AGE_MIN = 30.0

MB = 1024 * 1024
CHUNK = 1 << 20  # 1MiB：够大以摊薄 syscall，又不会把大文件读进内存

BUCKETS = [
    ("<1MB", 0, 1 * MB),
    ("1-5MB", 1 * MB, 5 * MB),
    ("5-10MB", 5 * MB, 10 * MB),
    ("10-25MB", 10 * MB, 25 * MB),
    ("25-50MB", 25 * MB, 50 * MB),
    (">50MB", 50 * MB, float("inf")),
]

# 会话目录名就是 CLI 的 session uuid；用它把 sidecar 和主 transcript 配对，
# 顺带把 memory/ learn-tool/ 这类非会话目录挡在外面。
_UUID_LEN = 36


def looks_like_session_id(name: str) -> bool:
    return len(name) == _UUID_LEN and name.count("-") == 4


def human(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(size) < 1024 or unit == "GB":
            return f"{int(size)}B" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}GB"


def walk_files(root: Path) -> Iterator[Path]:
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            yield path


@dataclass
class Session:
    """一个会话在磁盘上的全部占用：主 transcript + sidecar 目录。"""

    session_id: str
    transcript: Optional[Path] = None
    transcript_bytes: int = 0
    sidecar: Optional[Path] = None
    sidecar_bytes: int = 0
    sidecar_files: int = 0
    newest_mtime: float = 0.0
    holders: list[str] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return self.transcript_bytes + self.sidecar_bytes

    @property
    def age_min(self) -> float:
        return (time.time() - self.newest_mtime) / 60

    @property
    def label(self) -> str:
        base = self.transcript or self.sidecar
        assert base is not None
        tail = "" if self.transcript else "  (孤儿 sidecar，主 transcript 已不在)"
        return f"{base}{tail}"

    def skip_reason(self, min_age_min: float, force: bool) -> Optional[str]:
        """返回不该动它的原因；None 表示可以归档。

        持有 fd 是硬门禁：压一个进程正在追加写的会话，轻则归档出截断快照，重则
        让后续写入落进已被 unlink 的 inode。
        """
        if self.holders:
            return f"进程 {','.join(sorted(set(self.holders)))} 正持有其中的文件"
        if not force and self.age_min < min_age_min:
            return f"{self.age_min:.0f} 分钟前刚写过（< {min_age_min:.0f}min）"
        return None


def find_open_files(projects_dir: Path) -> Optional[dict[str, list[str]]]:
    """扫 /proc 得到 {projects_dir 下的文件路径: [pid, ...]}；无 /proc 时 None。

    读不到的 /proc 条目（别的用户、刚退出的进程）直接跳过——我们只需要能证明
    "有人在用"的正例。
    """
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return None
    prefix = str(projects_dir.resolve())
    held: dict[str, list[str]] = {}
    for proc in proc_root.iterdir():
        if not proc.name.isdigit():
            continue
        try:
            fds = list((proc / "fd").iterdir())
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith(prefix):
                held.setdefault(target, []).append(proc.name)
    return held


def scan(projects_dir: Path, holders: Optional[dict[str, list[str]]]) -> list[Session]:
    """按会话聚合 projects_dir 下的占用。"""
    held = holders or {}
    sessions: list[Session] = []

    for project in sorted(p for p in projects_dir.iterdir() if p.is_dir()):
        found: dict[str, Session] = {}

        for entry in project.iterdir():
            if entry.is_symlink():
                continue
            if entry.is_file() and entry.suffix == ".jsonl":
                sid = entry.stem
                if not looks_like_session_id(sid):
                    continue
                try:
                    st = entry.stat()
                except OSError:
                    continue
                s = found.setdefault(sid, Session(sid))
                s.transcript = entry
                s.transcript_bytes = st.st_size
                s.newest_mtime = max(s.newest_mtime, st.st_mtime)
                s.holders += held.get(str(entry.resolve()), [])
            elif entry.is_dir() and looks_like_session_id(entry.name):
                s = found.setdefault(entry.name, Session(entry.name))
                s.sidecar = entry
                for f in walk_files(entry):
                    try:
                        st = f.stat()
                    except OSError:
                        continue
                    s.sidecar_bytes += st.st_size
                    s.sidecar_files += 1
                    s.newest_mtime = max(s.newest_mtime, st.st_mtime)
                    s.holders += held.get(str(f.resolve()), [])

        sessions.extend(found.values())

    sessions.sort(key=lambda s: s.total_bytes, reverse=True)
    return sessions


def sha256_stream(fh) -> str:
    digest = hashlib.sha256()
    while chunk := fh.read(CHUNK):
        digest.update(chunk)
    return digest.hexdigest()


def sha256_file(path: Path) -> str:
    with path.open("rb") as fh:
        return sha256_stream(fh)


def gzip_file(src: Path, dest: Path) -> str:
    """gzip src -> dest，返回原文件 sha256（压缩时顺带算，只读一遍）。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with src.open("rb") as fin, gzip.open(dest, "wb", compresslevel=6) as fout:
        while chunk := fin.read(CHUNK):
            digest.update(chunk)
            fout.write(chunk)
    return digest.hexdigest()


def verify_gzip(dest: Path, expected_sha: str) -> None:
    with gzip.open(dest, "rb") as fh:
        if sha256_stream(fh) != expected_sha:
            raise RuntimeError(f"gzip 校验失败: {dest}")


def tar_dir(src: Path, dest: Path) -> dict[str, str]:
    """把目录打成 tar.gz，返回 {相对路径: sha256}。"""
    manifest = {
        str(f.relative_to(src)): sha256_file(f) for f in sorted(walk_files(src))
    }
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(dest, "w:gz", compresslevel=6) as tar:
        tar.add(src, arcname=src.name, recursive=True)
    return manifest


def verify_tar(dest: Path, src_name: str, manifest: dict[str, str]) -> None:
    """逐成员比对 sha256，并确认没有多出或缺失的文件。"""
    seen: set[str] = set()
    with tarfile.open(dest, "r:gz") as tar:
        for member in tar:
            if not member.isfile():
                continue
            rel = os.path.relpath(member.name, src_name)
            fh = tar.extractfile(member)
            if fh is None or sha256_stream(fh) != manifest.get(rel):
                raise RuntimeError(f"tar 成员校验失败: {member.name}")
            seen.add(rel)
    missing = set(manifest) - seen
    if missing:
        raise RuntimeError(f"tar 缺少 {len(missing)} 个文件，例如 {sorted(missing)[:3]}")


# ---------------------------------------------------------------- 每日提炼 --

# transcript 里绝大多数记录是 agent 的内部活动：思考、工具调用、工具回包。留下
# 来对以后的自己有用的只有对话本身，所以提炼只取两类：真人说的话（type=user 且
# content 是纯字符串——list 形态的 user 记录是 tool_result），以及助手回复里的
# text 块。isSidechain 的记录属于子 agent，不进主线流水。
_DIGEST_ROLES = {"user": "用户", "assistant": "助手"}
DEFAULT_DIGEST_CHARS = 280

# 以 user 身份进入 transcript 的机器注入。实测占 user 消息的 97%（1038 条里
# 1008 条是 task-notification），不滤掉的话流水基本全是管道噪声、真人说的话反而
# 被淹掉。
_INJECTED_PREFIXES = (
    "<task-notification>",
    "<command-name>",
    "<command-message>",
    "<local-command-caveat>",
    "<local-command-stdout>",
    "<ci-monitor-event>",
    "<user-prompt-submit-hook>",
)
_SYSTEM_REMINDER_RE = re.compile(
    r"<system-reminder>.*?</system-reminder>", re.DOTALL
)


def _strip_injected(text: str) -> str:
    """去掉机器注入的内容；整条都是注入时返回空串。"""
    cleaned = _SYSTEM_REMINDER_RE.sub("", text).strip()
    if cleaned.startswith(_INJECTED_PREFIXES):
        return ""
    return cleaned


def _digest_text(record: dict) -> Optional[str]:
    message = record.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        if record.get("type") != "user":
            return None
        return _strip_injected(content) or None
    if not isinstance(content, list):
        return None
    parts = [
        b.get("text", "")
        for b in content
        if isinstance(b, dict) and b.get("type") == "text"
    ]
    joined = "\n".join(p for p in parts if p)
    return _strip_injected(joined) or None


def _one_line(text: str, max_chars: int) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= max_chars else flat[: max_chars - 1].rstrip() + "…"


def extract_daily_digest(
    path: Path, max_chars: int = DEFAULT_DIGEST_CHARS
) -> dict[str, list[str]]:
    """把 transcript 逐行提炼成 {本地日期: [bullet, ...]}。

    逐行流式处理而不是整个 json.load：这个工具存在的理由就是这些文件大到不该被
    一次性读进内存。时间戳按本地时区换算后再分组，否则 UTC 的跨零点会话会被切到
    错误的日期上。
    """
    by_day: dict[str, list[str]] = {}
    last: dict[str, str] = {}
    try:
        # 直接认 .gz，这样已经归档的会话也能补提炼，不必先解压出来。
        if path.suffix == ".gz":
            fh = gzip.open(path, "rt", encoding="utf-8", errors="replace")
        else:
            fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return {}
    with fh:
        for line in fh:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict) or record.get("isSidechain"):
                continue
            role = _DIGEST_ROLES.get(record.get("type"))
            if not role:
                continue
            text = _digest_text(record)
            if not text or not text.strip():
                continue
            stamp = record.get("timestamp")
            if not isinstance(stamp, str):
                continue
            try:
                when = datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone()
            except ValueError:
                continue
            day = when.strftime("%Y-%m-%d")
            bullet = f"- **{when:%H:%M}** {role}: {_one_line(text, max_chars)}"
            # 轮询通知一类的连续重复会把流水撑满，只留第一条。
            if last.get(day) == bullet:
                continue
            last[day] = bullet
            by_day.setdefault(day, []).append(bullet)
    return by_day


def render_digest(day: str, bullets: list[str], session_id: str, origin: str) -> str:
    users = sum(1 for b in bullets if "** 用户: " in b)
    return "\n".join([
        f"# {day}",
        "",
        f"<!-- 由 prune_transcripts.py 从会话 {session_id} 提炼；"
        f"原始 transcript 已归档到 {origin} -->",
        "",
        f"> 本日 {len(bullets)} 条：用户 {users}，助手 {len(bullets) - users}。",
        "",
        *bullets,
        "",
    ])


def merge_digest_into(target: Path, day_body: str, session_id: str) -> None:
    """把提炼结果并进 --digest-dir 下已有的当日文件，可重复执行。

    用 BEGIN/END 标记圈出本会话的段落：重跑时替换而不是追加，所以这个工具可以
    安全地放进定时任务而不会把流水撑成三份。绝不覆盖标记之外的人工内容。
    """
    begin = f"<!-- BEGIN prune-digest {session_id} -->"
    end = f"<!-- END prune-digest {session_id} -->"
    block = f"{begin}\n{day_body}{end}\n"
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_text(block, encoding="utf-8")
        return
    existing = target.read_text(encoding="utf-8", errors="replace")
    start = existing.find(begin)
    if start != -1:
        stop = existing.find(end, start)
        if stop != -1:
            target.write_text(
                existing[:start] + block + existing[stop + len(end) + 1:],
                encoding="utf-8",
            )
            return
    sep = "" if existing.endswith("\n") else "\n"
    target.write_text(existing + sep + "\n" + block, encoding="utf-8")


def write_digests(
    session: Session,
    out_dir: Path,
    origin: str,
    max_chars: int,
    digest_dir: Optional[Path],
) -> dict[str, object]:
    if not session.transcript:
        return {}
    by_day = extract_daily_digest(session.transcript, max_chars)
    if not by_day:
        return {}
    local_dir = out_dir / f"{session.session_id}.digest"
    local_dir.mkdir(parents=True, exist_ok=True)
    for day, bullets in sorted(by_day.items()):
        body = render_digest(day, bullets, session.session_id, origin)
        (local_dir / f"{day}.md").write_text(body, encoding="utf-8")
        if digest_dir:
            merge_digest_into(digest_dir / f"{day}.md", body, session.session_id)
    return {
        "digest_dir": str(local_dir),
        "digest_days": len(by_day),
        "digest_bullets": sum(len(v) for v in by_day.values()),
        "digest_merged_into": str(digest_dir) if digest_dir else None,
    }


def rmtree(path: Path) -> None:
    for child in sorted(path.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if child.is_dir() and not child.is_symlink():
            child.rmdir()
        else:
            child.unlink()
    path.rmdir()


def archive_session(
    session: Session,
    projects_dir: Path,
    archive_dir: Path,
    *,
    digest: bool = True,
    digest_chars: int = DEFAULT_DIGEST_CHARS,
    digest_dir: Optional[Path] = None,
) -> dict[str, object]:
    """归档整个会话；每一件都校验通过之后才删原件。"""
    base = session.transcript or session.sidecar
    assert base is not None
    rel_project = base.parent.relative_to(projects_dir)
    out_dir = archive_dir / rel_project
    written: dict[str, object] = {}
    archived_bytes = 0

    if digest:
        written.update(
            write_digests(session, out_dir, str(out_dir), digest_chars, digest_dir)
        )

    if session.transcript:
        dest = out_dir / (session.transcript.name + ".gz")
        part = dest.parent / (dest.name + ".part")
        sha = gzip_file(session.transcript, part)
        verify_gzip(part, sha)
        part.replace(dest)
        written["transcript_gz"] = str(dest)
        written["transcript_sha256"] = sha
        archived_bytes += dest.stat().st_size

    if session.sidecar:
        dest = out_dir / (session.sidecar.name + ".sidecar.tar.gz")
        part = dest.parent / (dest.name + ".part")
        manifest = tar_dir(session.sidecar, part)
        verify_tar(part, session.sidecar.name, manifest)
        part.replace(dest)
        written["sidecar_tgz"] = str(dest)
        written["sidecar_files"] = len(manifest)
        archived_bytes += dest.stat().st_size

    meta = out_dir / f"{session.session_id}.meta.json"
    meta.write_text(
        json.dumps(
            {
                "session_id": session.session_id,
                "project": str(base.parent),
                "original_bytes": session.total_bytes,
                "transcript_bytes": session.transcript_bytes,
                "sidecar_bytes": session.sidecar_bytes,
                "newest_mtime": session.newest_mtime,
                "archived_at": time.time(),
                **written,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    # 校验都过了才动原件。
    if session.transcript:
        session.transcript.unlink()
    if session.sidecar:
        rmtree(session.sidecar)

    written["archived_bytes"] = archived_bytes
    return written


def print_distribution(sessions: list[Session]) -> None:
    total = sum(s.total_bytes for s in sessions)
    print(f"扫描到 {len(sessions)} 个会话，合计 {human(total)}\n")
    print("  区间        会话数")
    for label, lo, hi in BUCKETS:
        n = sum(1 for s in sessions if lo <= s.total_bytes < hi)
        print(f"  {label:<10} {n:>6}  {'#' * min(40, n)}")
    print()


def main() -> int:
    ap = argparse.ArgumentParser(description="归档体积失控的 Claude Code 会话")
    ap.add_argument("--projects-dir", type=Path, default=DEFAULT_PROJECTS_DIR)
    ap.add_argument("--archive-dir", type=Path, default=DEFAULT_ARCHIVE_DIR)
    ap.add_argument("--threshold-mb", type=float, default=DEFAULT_THRESHOLD_MB,
                    help=f"会话总占用超过此值就归档（默认 {DEFAULT_THRESHOLD_MB:g}）")
    ap.add_argument("--warn-mb", type=float, default=DEFAULT_WARN_MB,
                    help=f"超过此值只告警不归档（默认 {DEFAULT_WARN_MB:g}）")
    ap.add_argument("--min-age-min", type=float, default=DEFAULT_MIN_AGE_MIN,
                    help=f"写入新于此分钟数的会话跳过（默认 {DEFAULT_MIN_AGE_MIN:g}）")
    ap.add_argument("--apply", action="store_true", help="真的归档（默认只报告）")
    ap.add_argument("--force", action="store_true",
                    help="忽略 mtime 保护；不会忽略「被进程持有」的保护")
    ap.add_argument("--no-digest", dest="digest", action="store_false",
                    help="不提炼每日流水（默认提炼后再归档）")
    ap.add_argument("--digest-only", type=Path, default=None, metavar="TRANSCRIPT",
                    help="只对指定 transcript 提炼每日流水，不归档、不删任何东西；"
                         "接受 .jsonl 或已归档的 .jsonl.gz")
    ap.add_argument("--digest-chars", type=int, default=DEFAULT_DIGEST_CHARS,
                    help=f"每条流水截断长度（默认 {DEFAULT_DIGEST_CHARS}）")
    ap.add_argument("--digest-dir", type=Path, default=None,
                    help="额外把每日流水并进这个目录（如 workspace/memory），"
                         "按会话标记圈定，可重复执行")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--exit-code", action="store_true",
                    help="存在超阈值会话时退出码为 1")
    args = ap.parse_args()

    if args.digest_only:
        src = args.digest_only
        if not src.is_file():
            print(f"文件不存在: {src}", file=sys.stderr)
            return 2
        by_day = extract_daily_digest(src, args.digest_chars)
        if not by_day:
            print(f"{src} 里没有可提炼的对话。")
            return 0
        session_id = src.name.split(".")[0]
        out_dir = src.parent / f"{session_id}.digest"
        out_dir.mkdir(parents=True, exist_ok=True)
        for day, bullets in sorted(by_day.items()):
            body = render_digest(day, bullets, session_id, str(src))
            (out_dir / f"{day}.md").write_text(body, encoding="utf-8")
            if args.digest_dir:
                merge_digest_into(args.digest_dir / f"{day}.md", body, session_id)
        total = sum(len(v) for v in by_day.values())
        print(f"提炼 {len(by_day)} 天 / {total} 条 -> {out_dir}")
        if args.digest_dir:
            print(f"已并入 {args.digest_dir}")
        return 0

    if not args.projects_dir.is_dir():
        print(f"目录不存在: {args.projects_dir}", file=sys.stderr)
        return 2
    if args.warn_mb > args.threshold_mb:
        print("--warn-mb 不应大于 --threshold-mb", file=sys.stderr)
        return 2

    holders = find_open_files(args.projects_dir)
    if holders is None and args.apply:
        print("读不到 /proc，无法确认文件是否正被写入，拒绝执行 --apply。",
              file=sys.stderr)
        return 2

    sessions = scan(args.projects_dir, holders)
    threshold = args.threshold_mb * MB
    warn = args.warn_mb * MB
    over = [s for s in sessions if s.total_bytes >= threshold]
    warning = [s for s in sessions if warn <= s.total_bytes < threshold]

    results = []
    for s in over:
        reason = s.skip_reason(args.min_age_min, args.force)
        entry: dict[str, object] = {
            "session_id": s.session_id,
            "path": s.label,
            "bytes": s.total_bytes,
            "transcript_bytes": s.transcript_bytes,
            "sidecar_bytes": s.sidecar_bytes,
            "sidecar_files": s.sidecar_files,
            "age_min": round(s.age_min, 1),
            "action": "skip" if reason else ("archive" if args.apply else "would-archive"),
            "reason": reason,
        }
        if args.apply and not reason:
            try:
                entry.update(archive_session(
                    s, args.projects_dir, args.archive_dir,
                    digest=args.digest,
                    digest_chars=args.digest_chars,
                    digest_dir=args.digest_dir,
                ))
            except Exception as exc:  # 一个会话失败不该带走其余的
                entry["action"] = "error"
                entry["reason"] = str(exc)
        results.append(entry)

    if args.json:
        print(json.dumps({
            "scanned_sessions": len(sessions),
            "total_bytes": sum(s.total_bytes for s in sessions),
            "threshold_bytes": int(threshold),
            "over": results,
            "warning": [
                {"session_id": s.session_id, "path": s.label, "bytes": s.total_bytes}
                for s in warning
            ],
        }, indent=2, ensure_ascii=False))
    else:
        print_distribution(sessions)
        if warning:
            print(f"告警带（>= {args.warn_mb:g}MB，暂不处理）:")
            for s in warning:
                print(f"  {human(s.total_bytes):>9}  {s.label}")
            print()
        if not over:
            print(f"没有超过 {args.threshold_mb:g}MB 的会话。")
        else:
            print(f"超阈值（>= {args.threshold_mb:g}MB）:")
            for e in results:
                tag = {"archive": "已归档", "would-archive": "待归档",
                       "skip": "跳过", "error": "失败"}[str(e["action"])]
                print(f"  [{tag}] {human(e['bytes']):>9}  {e['path']}")
                print(f"           transcript {human(e['transcript_bytes'])}"
                      f" + sidecar {human(e['sidecar_bytes'])}"
                      f" ({e['sidecar_files']} 个文件)")
                if e["reason"]:
                    print(f"           原因: {e['reason']}")
                if "archived_bytes" in e:
                    ratio = int(e["archived_bytes"]) / max(1, int(e["bytes"])) * 100
                    print(f"           -> {human(e['archived_bytes'])} "
                          f"({ratio:.1f}%) 于 {args.archive_dir}")
                if e.get("digest_days"):
                    line = (f"           提炼 {e['digest_days']} 天 / "
                            f"{e['digest_bullets']} 条 -> {e['digest_dir']}")
                    if e.get("digest_merged_into"):
                        line += f"，并入 {e['digest_merged_into']}"
                    print(line)
            if not args.apply:
                print("\n以上是 dry-run。加 --apply 才会真的归档。")

    return 1 if (args.exit_code and over) else 0


if __name__ == "__main__":
    sys.exit(main())
