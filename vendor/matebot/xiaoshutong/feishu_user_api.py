"""用户身份飞书 API 客户端（user_access_token）。

与 feishu_api.py（bot tenant_access_token）不同，本模块以「用户身份」调用飞书
OpenAPI，可读取用户所有会话（群聊 + 私聊）并搜索消息。需先通过 feishu_auth.py
完成一次性 OAuth 授权，token 存于 config.token_file，过期自动刷新。

所需权限（用户身份，均已在开放平台开通）：
- im:chat:read        → list_chats 列会话
- im:message:readonly → read_messages 读消息
- search:message      → search_messages 消息搜索（获取消息搜索结果）
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import yaml

log = logging.getLogger("feishu_user_api")

FEISHU_BASE = "https://open.feishu.cn/open-apis"


# ── Token 管理 ──────────────────────────────────────────────


class UserTokenManager:
    """管理 user_access_token：加载、过期刷新、持久化。

    Token 文件结构:
        {"access_token": "...", "refresh_token": "...",
         "expires_at": <epoch_ms>, "open_id": "..."}
    """

    def __init__(self, app_id: str, app_secret: str, token_path: Path):
        self._app_id = app_id
        self._app_secret = app_secret
        self._token_path = Path(token_path)
        self._data: Optional[Dict[str, Any]] = None

    # -- public -------------------------------------------------

    @property
    def access_token(self) -> str:
        data = self._ensure_loaded()
        token = data.get("access_token", "")
        if not token:
            raise RuntimeError(
                "未找到 user_access_token。请先运行 feishu_auth.py 完成授权。"
            )
        # 提前 5 分钟过期
        expires_at = data.get("expires_at", 0)
        if expires_at and time.time() * 1000 > expires_at - 5 * 60 * 1000:
            self._refresh()
        return self._data["access_token"]

    @property
    def open_id(self) -> str:
        return self._ensure_loaded().get("open_id", "")

    def save_from_auth_result(self, result: Dict[str, Any]) -> None:
        """由 feishu_auth.py 在授权成功后写入 token。"""
        self._data = {
            "access_token": result.get("access_token", ""),
            "refresh_token": result.get("refresh_token", ""),
            "expires_at": int(time.time() * 1000)
            + int(result.get("expires_in", 7200)) * 1000,
            "open_id": result.get("open_id", "") or result.get("openid", ""),
        }
        self._persist()

    # -- internals -----------------------------------------------

    def _ensure_loaded(self) -> Dict[str, Any]:
        if self._data is None:
            if not self._token_path.exists():
                return {}
            try:
                self._data = json.loads(self._token_path.read_text("utf-8"))
            except (json.JSONDecodeError, OSError):
                log.error("Token 文件解析失败: %s", self._token_path)
                self._data = {}
        return self._data

    def _persist(self) -> None:
        self._token_path.parent.mkdir(parents=True, exist_ok=True)
        self._token_path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2), "utf-8"
        )
        log.info("Token 已持久化: %s", self._token_path)

    def _refresh(self) -> None:
        data = self._ensure_loaded()
        refresh_token = data.get("refresh_token", "")
        if not refresh_token:
            raise RuntimeError("无 refresh_token，无法刷新。请重新运行 feishu_auth.py。")

        app_tok = _get_app_access_token(self._app_id, self._app_secret)
        url = f"{FEISHU_BASE}/authen/v1/oidc/refresh_access_token"
        body = {"grant_type": "refresh_token", "refresh_token": refresh_token}
        try:
            with httpx.Client(timeout=httpx.Timeout(15.0), trust_env=False) as client:
                resp = client.post(
                    url, json=body,
                    headers={"Authorization": f"Bearer {app_tok}"},
                )
                data_out = resp.json()
        except Exception as e:
            log.error("Token 刷新失败 (network): %s", e)
            raise

        if data_out.get("code") != 0:
            msg = data_out.get("msg", "")
            log.error("Token 刷新失败 (API): code=%s msg=%s",
                      data_out.get("code"), msg)
            raise RuntimeError(f"Token 刷新失败: {msg}")

        d = data_out.get("data", {})
        self._data = {
            "access_token": d.get("access_token", data.get("access_token", "")),
            "refresh_token": d.get("refresh_token", refresh_token),
            "expires_at": int(time.time() * 1000)
            + int(d.get("expires_in", 7200)) * 1000,
            "open_id": d.get("open_id", data.get("open_id", "")),
        }
        self._persist()
        log.info("user_access_token 已刷新（%ss）", d.get("expires_in"))


def _get_app_access_token(app_id: str, app_secret: str) -> str:
    """获取 app_access_token（oidc 换发 user_access_token 需要）。"""
    url = f"{FEISHU_BASE}/auth/v3/app_access_token/internal"
    body = {"app_id": app_id, "app_secret": app_secret}
    with httpx.Client(timeout=httpx.Timeout(15.0), trust_env=False) as client:
        resp = client.post(url, json=body)
        data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(
            f"获取 app_access_token 失败: code={data.get('code')} "
            f"msg={data.get('msg')}"
        )
    return data["app_access_token"]


# ── 会话 ────────────────────────────────────────────────────


def list_chats(tm: UserTokenManager) -> List[Dict[str, Any]]:
    """列出用户所有会话（分页拉全）。

    返回 item 含: chat_id, chat_type(p2p/group), name, description 等。
    """
    chats: List[Dict[str, Any]] = []
    page_token = ""
    url = f"{FEISHU_BASE}/im/v1/chats"
    params = {"user_id_type": "open_id", "page_size": 100}

    with httpx.Client(timeout=httpx.Timeout(15.0), trust_env=False) as client:
        while True:
            p = dict(params)
            if page_token:
                p["page_token"] = page_token
            resp = client.get(
                url, params=p,
                headers={"Authorization": f"Bearer {tm.access_token}"},
            )
            data = resp.json()
            if data.get("code") != 0:
                log.warning("list_chats 失败: code=%s msg=%s",
                            data.get("code"), data.get("msg"))
                break
            items = data.get("data", {}).get("items", [])
            chats.extend(items)
            page_token = data.get("data", {}).get("page_token", "")
            if not page_token or not items:
                break
            if len(chats) > 500:  # 防御性上限
                break
    return chats


def list_group_chats(tm: UserTokenManager) -> List[Dict[str, Any]]:
    """仅群聊（排除 p2p/机器人会话）。"""
    return [c for c in list_chats(tm) if c.get("chat_type") in ("group", "topic")]


# ── 消息读取 ────────────────────────────────────────────────


def read_messages(
    tm: UserTokenManager,
    chat_id: str,
    start_ts_ms: Optional[int] = None,
    end_ts_ms: Optional[int] = None,
    max_items: int = 2000,
) -> List[Dict[str, Any]]:
    """读取某个会话的消息（倒序分页，返回升序）。

    仅返回时间窗口 [start_ts_ms, end_ts_ms) 内的消息。
    """
    items: List[Dict[str, Any]] = []
    page_token = ""
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {
        "container_id_type": "chat",
        "container_id": chat_id,
        "page_size": 50,  # 该 API 最大 50，超限会报 99992402
        "sort_type": "ByCreateTimeDesc",
    }
    if start_ts_ms is not None:
        params["start_time"] = str(int(start_ts_ms) // 1000)  # 该 API 用秒
    if end_ts_ms is not None:
        params["end_time"] = str(int(end_ts_ms) // 1000)

    with httpx.Client(timeout=httpx.Timeout(20.0), trust_env=False) as client:
        while True:
            p = dict(params)
            if page_token:
                p["page_token"] = page_token
            try:
                resp = client.get(
                    url, params=p,
                    headers={"Authorization": f"Bearer {tm.access_token}"},
                )
                data = resp.json()
            except Exception as e:
                log.warning("read_messages(%s) network error: %s", chat_id, e)
                break
            if data.get("code") != 0:
                if data.get("code") == 230027:
                    # 缺 get_as_user 权限：抛给上层做搜索回退
                    raise PermissionError(
                        data.get("msg", "") or "缺少读消息权限"
                    )
                log.warning("read_messages(%s) 失败: code=%s msg=%s",
                            chat_id, data.get("code"), data.get("msg"))
                break
            batch = data.get("data", {}).get("items", [])
            items.extend(batch)
            if len(items) >= max_items:
                break
            page_token = data.get("data", {}).get("page_token", "")
            if not page_token or not batch:
                break

    items.reverse()  # 升序
    return items


# ── 消息搜索（search:message 权限）─────────────────────────


def search_messages(
    tm: UserTokenManager,
    query: str,
    chat_ids: Optional[List[str]] = None,
    start_ts_ms: Optional[int] = None,
    end_ts_ms: Optional[int] = None,
    max_items: int = 50,
) -> List[Dict[str, Any]]:
    """按关键词搜索消息。

    注意：该接口需「获取消息搜索结果」权限，且使用 user_access_token。
    返回 item 含 chat_id / chat_name / sender / body 等字段。
    """
    url = f"{FEISHU_BASE}/im/v1/messages/search"
    body: Dict[str, Any] = {"query": query}
    if chat_ids:
        body["chat_ids"] = chat_ids
    if start_ts_ms is not None:
        body["start_time"] = start_ts_ms
    if end_ts_ms is not None:
        body["end_time"] = end_ts_ms
    body["user_id_type"] = "open_id"

    results: List[Dict[str, Any]] = []
    page_token = ""
    with httpx.Client(timeout=httpx.Timeout(20.0), trust_env=False) as client:
        while True:
            params = {"page_size": min(30, max_items or 30)}
            if page_token:
                params["page_token"] = page_token
            try:
                resp = client.post(
                    url, params=params, json=body,
                    headers={"Authorization": f"Bearer {tm.access_token}"},
                )
                data = resp.json()
            except Exception as e:
                log.warning("search_messages network error: %s", e)
                break
            if data.get("code") != 0:
                log.warning("search_messages 失败: code=%s msg=%s",
                            data.get("code"), data.get("msg"))
                break
            batch = data.get("data", {}).get("items", [])
            results.extend(batch)
            if len(results) >= max_items:
                break
            page_token = data.get("data", {}).get("page_token", "")
            if not page_token or not batch:
                break
    return results


# ── 消息文本解析（与 feishu_api.py 一致）──────────────────


def parse_message_text(item: Dict[str, Any]) -> str:
    """从飞书消息体中提取纯文本。

    text 消息: body.content = '{"text":"hello"}'
    其他类型（post/image/file）尽力提取，失败返回原始串。
    """
    body = item.get("body", {})
    content_str = body.get("content", "")
    if not content_str:
        return ""
    try:
        content = json.loads(content_str)
    except (json.JSONDecodeError, TypeError):
        return str(content_str)

    if isinstance(content, dict):
        # 纯文本
        if "text" in content and isinstance(content["text"], str):
            return content["text"]
        # 富文本 post
        if "title" in content:
            parts = [str(content.get("title", ""))]
            for seg in (content.get("content") or []):
                for line in seg if isinstance(seg, list) else [seg]:
                    if isinstance(line, dict) and "text" in line:
                        parts.append(line["text"])
            return "\n".join(p for p in parts if p)
        # 其他
        return json.dumps(content, ensure_ascii=False)
    return str(content)


def sender_name(item: Dict[str, Any]) -> str:
    """提取发送者显示名。

    ⚠️ im/v1/messages 的 `sender` 只有 {id, id_type, sender_type, tenant_key}，
    **没有** name 字段。所以这里几乎总是拿不到名字，返回空串让上层去查
    `list_chat_members` 建立的 open_id → 名字映射。

    历史 bug：这里回退成返回 open_id，上层再截断成 12 个字符，于是报告里
    「提出人」列全是 `ou_405eac73ea` 这种看着像乱码的东西。
    """
    sender = item.get("sender", {}) or {}
    ids = sender.get("ids", {}) or {}
    name = ids.get("name") or ""
    return str(name).strip()


def message_mentions(item: Dict[str, Any]) -> List[Dict[str, str]]:
    """消息里 @ 到的人：[{open_id, name}, ...]。

    `mentions` 是少数几个直接带 name 的地方，所以它既用来判断「有没有 @ 我」，
    也顺带喂给名字缓存。
    """
    out: List[Dict[str, str]] = []
    for m in item.get("mentions") or []:
        if not isinstance(m, dict):
            continue
        raw_id = m.get("id")
        # API returns id as a string (the open_id directly),
        # but older code treated it as a dict — handle both
        if isinstance(raw_id, dict):
            open_id = raw_id.get("open_id", "")
        else:
            open_id = str(raw_id or "")
        name = (m.get("name") or "").strip()
        if open_id or name:
            out.append({"open_id": open_id, "name": name})
    return out


def list_chat_members(tm: UserTokenManager, chat_id: str) -> List[Dict[str, str]]:
    """列出会话成员：[{open_id, name}, ...]。

    用 im:chat:read（已有的 scope）就能拿到名字，不需要额外申请
    contact:user.base:readonly 再走一遍 OAuth 授权。
    """
    members: List[Dict[str, str]] = []
    page_token = ""
    url = f"{FEISHU_BASE}/im/v1/chats/{chat_id}/members"

    with httpx.Client(timeout=httpx.Timeout(15.0), trust_env=False) as client:
        while True:
            params: Dict[str, Any] = {
                "member_id_type": "open_id",
                "page_size": 100,
            }
            if page_token:
                params["page_token"] = page_token
            try:
                resp = client.get(
                    url, params=params,
                    headers={"Authorization": f"Bearer {tm.access_token}"},
                )
                data = resp.json()
            except Exception as e:
                log.debug("list_chat_members(%s) network error: %s", chat_id, e)
                break
            if data.get("code") != 0:
                log.debug("list_chat_members(%s) 失败: code=%s msg=%s",
                          chat_id, data.get("code"), data.get("msg"))
                break
            for it in data.get("data", {}).get("items", []) or []:
                mid = it.get("member_id") or ""
                name = (it.get("name") or "").strip()
                if mid and name:
                    members.append({"open_id": mid, "name": name})
            page_token = data.get("data", {}).get("page_token", "")
            if not page_token:
                break
            if len(members) > 1000:  # 防御性上限
                break
    return members
