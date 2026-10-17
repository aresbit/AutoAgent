#!/usr/bin/env python3
"""科技日报：抓 Hacker News → opencc LLM 中文总结 → 转 PDF → 发飞书。

三段式（对齐小书童）：
  - fetch   : 抓 HN 首页 → data/latest.md（原始快照，零 token）
  - （agent）: opencc headless 会话读 agent_prompt.md + latest.md，
               写中文总结到 data/digests/<YYYY-MM-DD>.md
  - publish : 读 digest md → 转 PDF → 发飞书

本脚本只做确定性的事（抓取 / 转 PDF / 发送），总结交给 LLM。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx
import yaml

_DIR = Path(__file__).resolve().parent
_PARENT = _DIR.parent
sys.path.insert(0, str(_PARENT))  # 复用 MateBot 的 feishu_api / feishu_config

HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json"
HN_ITEM = "https://hacker-news.firebaseio.com/v0/item/{}.json"


def load_config() -> dict:
    with open(_DIR / "config.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _data_dir(cfg: dict) -> Path:
    return _DIR / cfg.get("data_dir", "data")


# ── fetch：抓 HN → data/latest.md ─────────────────────────────
def _fetch_item(sid: int, client: httpx.Client) -> dict | None:
    try:
        r = client.get(HN_ITEM.format(sid), timeout=10)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def fetch_top(client: httpx.Client, n: int) -> list[dict]:
    r = client.get(HN_TOP, timeout=15)
    r.raise_for_status()
    ids = r.json()[:n]
    with ThreadPoolExecutor(max_workers=8) as pool:
        items = list(pool.map(lambda i: _fetch_item(i, client), ids))
    out: list[dict] = []
    for it in items:
        if not it or it.get("type") != "story" or not it.get("title"):
            continue
        out.append({
            "title": it["title"],
            "score": it.get("score", 0),
            "comments": it.get("descendants", 0),
            "url": it.get("url") or f"https://news.ycombinator.com/item?id={it['id']}",
        })
    out.sort(key=lambda x: -x["score"])
    return out


def do_fetch(cfg: dict) -> int:
    top_n = int(cfg.get("top_n", 30))
    data_dir = _data_dir(cfg)
    data_dir.mkdir(parents=True, exist_ok=True)

    with httpx.Client() as client:
        stories = fetch_top(client, top_n)
    if not stories:
        print("[error] 抓取 HN 失败或无数据")
        return 1

    date_str = datetime.now().strftime("%Y-%m-%d")
    lines = [
        f"# Hacker News 首页快照 {date_str}",
        "",
        f"共 {len(stories)} 条，按热度降序。格式：`序号. [点数 / 评论数] 标题 — 链接`",
        "",
    ]
    for i, s in enumerate(stories, 1):
        host = urlparse(s["url"]).netloc.replace("www.", "") if s["url"].startswith("http") else ""
        meta = f"{s['score']} 点 / {s['comments']} 评论"
        if host:
            meta += f" · {host}"
        lines.append(f"{i}. [{meta}] {s['title']} — {s['url']}")

    latest = data_dir / "latest.md"
    latest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[fetch] 抓到 {len(stories)} 条 → {latest}")
    return 0


# ── publish：读 digest md → 转 PDF → 发飞书 ───────────────────
def _find_digest(cfg: dict) -> Path | None:
    digest_dir = _data_dir(cfg) / "digests"
    if not digest_dir.is_dir():
        return None
    today = datetime.now().strftime("%Y-%m-%d")
    exact = digest_dir / f"{today}.md"
    if exact.is_file():
        return exact
    # 兜底：取当天 mtime 最新的 md
    candidates = sorted(digest_dir.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


# PDF 引擎在正式转换前先做一次自检：本机曾发生 tectonic 二进制被静默改写
# （5 字节位翻转，mtime 不变）导致启动即段错误，--version 都跑不起来。
# 那种情况下 pandoc 只会吐一句无信息的 "Error producing PDF"，排查成本很高。
def _pdf_engine_candidates() -> list[str]:
    cands: list[str] = []
    env = (os.environ.get("TECTONIC") or "").strip()
    if env:
        cands.append(env)
    cands.append(str(Path.home() / ".local/bin/tectonic"))
    which = shutil.which("tectonic")
    if which:
        cands.append(which)
    seen: set[str] = set()
    out: list[str] = []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _engine_healthy(exe: str) -> bool:
    if not exe or not Path(exe).exists():
        return False
    try:
        proc = subprocess.run(
            [exe, "--version"], capture_output=True, text=True, timeout=20
        )
    except Exception:
        return False
    return proc.returncode == 0


def pick_pdf_engine() -> tuple[str | None, list[str]]:
    """按候选顺序返回第一个自检通过的引擎；返回 (路径, 失败列表)。"""
    bad: list[str] = []
    for exe in _pdf_engine_candidates():
        if _engine_healthy(exe):
            return exe, bad
        bad.append(exe)
    return None, bad


def to_pdf(md_path: Path, pdf_path: Path) -> bool:
    script = Path.home() / ".local/bin/convert_md_to_pdf.sh"
    if not script.exists():
        print(f"[error] 找不到转换脚本: {script}")
        return False

    engine, bad = pick_pdf_engine()
    if engine is None:
        print("[error] PDF 引擎自检失败（--version 跑不通），疑似二进制损坏，本次跳过 PDF：")
        for b in bad:
            p = Path(b)
            size = p.stat().st_size if p.exists() else "-"
            print(f"        ✗ {b} (size={size})")
        print("        修复：curl -fsSL -o ~/.local/bin/tectonic "
              "https://github.com/tectonic-typesetting/tectonic/releases/download/"
              "tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz"
              " && tar -xzf - -C ~/.local/bin tectonic && chmod +x ~/.local/bin/tectonic")
        return False

    pdf_path.unlink(missing_ok=True)  # 防止上一轮的旧 PDF 冒充本轮产物
    try:
        proc = subprocess.run(
            ["bash", str(script), str(md_path), str(pdf_path)],
            capture_output=True, text=True, timeout=300,
            env={**os.environ, "TECTONIC": engine},
        )
    except subprocess.TimeoutExpired:
        print("[error] PDF 转换超时")
        return False

    if proc.returncode != 0 or not pdf_path.exists() or pdf_path.stat().st_size == 0:
        print(f"[error] PDF 转换失败 (rc={proc.returncode}, engine={engine})")
        tail = ((proc.stderr or "") + (proc.stdout or "")).strip().splitlines()[-10:]
        for line in tail:
            print(f"        {line}")
        return False
    if pdf_path.read_bytes()[:4] != b"%PDF":
        print(f"[error] 产物不是合法 PDF: {pdf_path}")
        return False
    return True


def send_file(path: Path, cfg: dict, file_type: str) -> bool:
    """上传并发送一个文件到飞书。file_type 用飞书取值：pdf / stream / ..."""
    try:
        from feishu_config import get_feishu_app_id, get_feishu_app_secret, get_chat_id
        from feishu_api import TokenManager, upload_file, FEISHU_BASE
    except Exception as e:
        print(f"[error] 导入飞书模块失败: {e}")
        return False
    app_id = get_feishu_app_id()
    secret = get_feishu_app_secret()
    chat_id = (cfg.get("send_chat") or "").strip() or get_chat_id()
    if not app_id or not secret or not chat_id:
        print("[error] 飞书凭据或 chat_id 缺失")
        return False
    tm = TokenManager(app_id, secret)
    file_key = upload_file(tm, str(path), file_type=file_type)
    if not file_key:
        print(f"[error] 上传失败: {path.name}")
        return False
    url = f"{FEISHU_BASE}/im/v1/messages"
    body = {
        "receive_id": chat_id,
        "msg_type": "file",
        "content": json.dumps({"file_key": file_key}, ensure_ascii=False),
    }
    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(
                url, params={"receive_id_type": "chat_id"}, json=body,
                headers={"Authorization": f"Bearer {tm.token}"},
            )
            data = resp.json()
    except Exception as e:
        print(f"[error] 发送失败: {e}")
        return False
    return data.get("code") == 0


def do_publish(cfg: dict) -> int:
    md_path = _find_digest(cfg)
    if md_path is None:
        print("[error] 找不到 digest md（agent 可能没生成）")
        return 1
    pdf_dir = _data_dir(cfg) / "pdfs"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = pdf_dir / f"{md_path.stem}.pdf"

    # PDF 是尽力而为：转换失败也要把 markdown 发出去，日报不能因为渲染挂掉而静默丢失。
    pdf_ok = to_pdf(md_path, pdf_path)
    if pdf_ok:
        print(f"[pdf] 生成 → {pdf_path}")
    else:
        print("[warn] PDF 未生成，本轮只发 markdown")

    if not cfg.get("send_enabled", True):
        print(f"[ok] 科技日报完成（send_enabled=false，未发送）→ {md_path}")
        return 0

    if pdf_ok:
        print(f"[send] pdf {'成功' if send_file(pdf_path, cfg, 'pdf') else '失败'}"
              f" → {pdf_path.name}")

    md_ok = send_file(md_path, cfg, "stream")
    print(f"[send] markdown {'成功' if md_ok else '失败'} → {md_path.name}")
    if not md_ok:
        print("[error] markdown 也未送达，本次日报彻底失败")
        return 1

    suffix = "" if pdf_ok else "（PDF 降级为 markdown）"
    print(f"[ok] 科技日报完成 → {md_path.name}{suffix}")
    return 0


def main() -> int:
    cfg = load_config()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "fetch"
    if cmd == "fetch":
        return do_fetch(cfg)
    if cmd == "publish":
        return do_publish(cfg)
    print(f"[error] 未知子命令: {cmd}（可选 fetch / publish）")
    return 2


if __name__ == "__main__":
    sys.exit(main())
