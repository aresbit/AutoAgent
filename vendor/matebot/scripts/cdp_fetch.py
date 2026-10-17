#!/usr/bin/env python3
"""CDP 抓取飞书登录页全文（含多维表格 base）。

原理：本机 Chrome 已登录飞书，通过 CDP（浏览器级 WebSocket）开新 tab、
等渲染、用 document.body.textContent 抓全文（飞书懒加载，innerText 拿不全）。

用法:
  python3 scripts/cdp_fetch.py "<url>"                 # 抓全文打印到 stdout
  python3 scripts/cdp_fetch.py "<url>" --save out.txt  # 存文件
  python3 scripts/cdp_fetch.py "<url>" --wait 15       # 自定义等待秒数
  python3 scripts/cdp_fetch.py "<url>" --port 9222     # 指定 CDP 端口

依赖: pip install websockets
"""
import argparse
import asyncio
import json
import os
import re
import sys

import websockets

CHROME_ACTIVE_PORT = os.path.expanduser("~/.config/google-chrome/DevToolsActivePort")


def find_cdp():
    """读 DevToolsActivePort 得到 port + 浏览器级 ws path。"""
    for path in (CHROME_ACTIVE_PORT,):
        if os.path.exists(path):
            with open(path) as f:
                lines = f.read().strip().splitlines()
                if len(lines) >= 2:
                    return lines[0], lines[1]
    raise RuntimeError("找不到 DevToolsActivePort，Chrome 未以 --remote-debugging-port 启动")


async def fetch(ws_url, target_url, wait_seconds):
    async with websockets.connect(ws_url, max_size=100_000_000) as ws:
        next_id = 0

        async def cmd(method, params=None, session_id=None):
            nonlocal next_id
            next_id += 1
            mid = next_id
            payload = {"id": mid, "method": method}
            if params:
                payload["params"] = params
            if session_id:
                payload["sessionId"] = session_id
            await ws.send(json.dumps(payload))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == mid:
                    if "error" in msg:
                        raise RuntimeError(f"CDP {method} 失败: {msg['error']}")
                    return msg.get("result", {})

        # 1. 开新 tab
        res = await cmd("Target.createTarget", {"url": target_url})
        target_id = res.get("targetId", "")
        # 2. attach 拿 sessionId（flatten 后要过滤 attachedToTarget 事件）
        res = await cmd("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        sid = res.get("sessionId", "")

        async def evaluate(expr):
            r = await cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True}, session_id=sid)
            return r.get("result", {}).get("value")

        # 3. 轮询等渲染：title 出现且文本长度稳定
        last_len = 0
        for i in range(wait_seconds // 2 + 1):
            await asyncio.sleep(2)
            try:
                info = await evaluate(
                    "({t: document.title, n: (document.body? document.body.textContent.length : 0)})"
                )
            except Exception:
                continue
            title = (info or {}).get("t", "") or ""
            n = (info or {}).get("n", 0) or 0
            if "登录" not in title and n > 100 and n == last_len and i >= 1:
                break
            last_len = n

        # 4. textContent 抓全文
        text = await evaluate("(document.body ? document.body.textContent : '')") or ""

        # 5. 清理：折叠空白、去空行
        lines = [l.strip() for l in text.split("\n")]
        cleaned = "\n".join([l for l in lines if l]).strip()

        title_clean = re.sub(r"[\u200b-\u200f\u2060-\u206f\ufeff\u202a-\u202e]", "", title)
        return title_clean, cleaned


def main():
    ap = argparse.ArgumentParser(description="CDP 抓取飞书登录页全文")
    ap.add_argument("url", help="目标 URL（飞书 wiki / base / doc 等）")
    ap.add_argument("--save", help="保存到文件")
    ap.add_argument("--wait", type=int, default=20, help="最大等待秒数，默认 20")
    ap.add_argument("--port", help="CDP 端口，默认从 DevToolsActivePort 读取")
    args = ap.parse_args()

    port, ws_path = find_cdp()
    if args.port:
        port = args.port
    ws_url = f"ws://127.0.0.1:{port}{ws_path}"

    title, content = asyncio.run(fetch(ws_url, args.url, args.wait))

    header = f"# {title}\n> CDP 抓取自: {args.url}\n> 时间: 2026-08-06\n\n"
    if args.save:
        with open(args.save, "w") as f:
            f.write(header + content)
        print(f"已保存: {args.save}")
        print(f"标题: {title}")
        print(f"长度: {len(content)}")
    else:
        print(header + content)


if __name__ == "__main__":
    main()
