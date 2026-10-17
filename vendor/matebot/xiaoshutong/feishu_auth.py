#!/usr/bin/env python3
"""一次性 OAuth 授权：为小书童换取 user_access_token。

流程（约 1 分钟）：
1. 本脚本打印授权链接，并起本地 loopback 服务器 (127.0.0.1:8765)
2. 用户在浏览器打开链接，登录飞书并点击「同意授权」
3. 浏览器跳回 http://localhost:8765/callback?code=xxx，脚本捕获 code
4. 用 code 换取 user_access_token + refresh_token，存入 token_file

前提（用户需先在飞书开放平台完成）：
- 应用「安全设置 → 重定向 URL」添加: http://localhost:8765/callback
- 应用已开通权限: im:chat:read / im:message:readonly / search:message

用法:
    python3 feishu_auth.py                # 完整授权流程
    python3 feishu_auth.py --print-url    # 只打印授权链接（手动授权）
"""

from __future__ import annotations

import argparse
import logging
import os
import secrets
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional

import httpx

from config import ensure_config_exists, load_config
from feishu_user_api import UserTokenManager, _get_app_access_token

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("feishu_auth")

AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token"
USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info"


# 一次性 OAuth 需要的权限 scope（与开放平台已开通的权限一致）
# offline_access 用于换取 refresh_token；其余为数据访问权限
# 读单聊/群聊需 im:message:readonly 基础 + 对应 get_as_user 细粒度权限
DEFAULT_SCOPE = (
    "offline_access im:chat:read im:message:readonly "
    "im:message.p2p_msg:get_as_user im:message.group_msg:get_as_user "
    "search:message"
)


def build_auth_url(app_id: str, redirect_uri: str, state: str, scope: str = DEFAULT_SCOPE) -> str:
    params = {
        "client_id": app_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": scope,          # offline_access 用于换取 refresh_token
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


class _CallbackServer:
    """捕获授权回调 code 的本地 loopback 服务器。"""

    def __init__(self, port: int, expected_state: str):
        self.expected_state = expected_state
        self.code: Optional[str] = None
        self.error: Optional[str] = None
        self._received = threading.Event()
        self._server = HTTPServer(("127.0.0.1", port), self._handler_factory())

    def _handler_factory(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                parsed = urllib.parse.urlparse(self.path)
                qs = urllib.parse.parse_qs(parsed.query)
                if qs.get("error"):
                    outer.error = qs.get("error", [""])[0]
                    outer._received.set()
                    self._respond("授权失败", 400)
                    return
                state = qs.get("state", [""])[0]
                code = qs.get("code", [""])[0]
                if state != outer.expected_state:
                    outer.error = "state 不匹配（CSRF 防护）"
                    outer._received.set()
                    self._respond("state 校验失败", 400)
                    return
                outer.code = code
                outer._received.set()
                self._respond("授权成功！可以关闭此页面。")

            def _respond(self, text: str, code: int = 200):
                body = f"<html><body><h2>{text}</h2></body></html>".encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # 静默访问日志
                pass

        return Handler

    def start(self) -> None:
        t = threading.Thread(target=self._server.serve_forever, daemon=True)
        t.start()

    def wait(self, timeout: int) -> bool:
        return self._received.wait(timeout)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def exchange_code(app_id: str, app_secret: str, code: str) -> dict:
    """用授权码换取 user_access_token。"""
    app_tok = _get_app_access_token(app_id, app_secret)
    body = {"grant_type": "authorization_code", "code": code}
    with httpx.Client(timeout=httpx.Timeout(15.0), trust_env=False) as client:
        resp = client.post(
            TOKEN_URL, json=body,
            headers={"Authorization": f"Bearer {app_tok}"},
        )
        data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(
            f"换取 user_access_token 失败: code={data.get('code')} "
            f"msg={data.get('msg')}"
        )
    return data.get("data", {})


def fetch_open_id(access_token: str) -> str:
    """获取当前用户 open_id（用于标识授权者）。"""
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0), trust_env=False) as client:
            resp = client.get(
                USER_INFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            data = resp.json()
        if data.get("code") == 0:
            return data.get("data", {}).get("open_id", "")
    except Exception:
        pass
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(description="小书童 OAuth 授权")
    parser.add_argument("--port", type=int, default=8765, help="loopback 端口")
    parser.add_argument(
        "--print-url", action="store_true",
        help="只打印授权链接，不启动本地服务器",
    )
    parser.add_argument(
        "--scope", default=DEFAULT_SCOPE,
        help="请求的权限 scope（默认含 im:chat:read / im:message:readonly / search:message / offline_access）",
    )
    args = parser.parse_args()

    ensure_config_exists()
    cfg = load_config()
    if not cfg.feishu_app_id or not cfg.feishu_app_secret:
        log.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量")
        return 1
    cfg.ensure_dirs()

    redirect_uri = f"http://localhost:{args.port}/callback"
    state = secrets.token_urlsafe(16)

    url = build_auth_url(cfg.feishu_app_id, redirect_uri, state, args.scope)
    print("\n" + "=" * 72)
    print("小书童 OAuth 授权")
    print("=" * 72)
    print("请在浏览器打开以下链接，登录飞书并点击授权：")
    print("\n  " + url + "\n")
    print(f"授权后会跳回 {redirect_uri}")
    print("=" * 72 + "\n")

    if args.print_url:
        return 0

    # 启动本地服务器捕获 code
    server = _CallbackServer(args.port, state)
    server.start()
    log.info("等待授权回调（5 分钟内有效）...")
    if not server.wait(timeout=300):
        server.close()
        log.error("等待授权超时，请重试")
        return 1

    server.close()
    if server.error:
        log.error("授权失败: %s", server.error)
        return 1
    if not server.code:
        log.error("未获取到授权码")
        return 1

    log.info("已获取授权码，正在换取 token...")
    result = exchange_code(cfg.feishu_app_id, cfg.feishu_app_secret, server.code)

    # 补充 open_id（用于标识授权者 / 过滤本人消息）
    if not result.get("open_id") and result.get("access_token"):
        oid = fetch_open_id(result.get("access_token", ""))
        if oid:
            result["open_id"] = oid

    tm = UserTokenManager(cfg.feishu_app_id, cfg.feishu_app_secret, cfg.token_file)
    tm.save_from_auth_result(result)
    print(f"\n✅ 授权成功！token 已保存到 {cfg.token_file}")
    print(f"   open_id: {tm.open_id}")
    print("   现在可以运行 feishu_fetch.py 抓取聊天记录了。\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
