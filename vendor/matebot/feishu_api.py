#!/usr/bin/env python3
"""Feishu API client — token management, message polling, sending, chat discovery.

Replaces the Telegram API layer in bridge.py. Uses httpx for HTTP calls
(reference: feishu-bot-bridge/tools/bot_poller.py).

Key differences from Telegram:
- OAuth2 tenant_access_token (2h expiry, auto-refresh)
- chat_id discovery via GET /im/v1/chats
- Messages polled via GET /im/v1/messages with container_id
- Message content is JSON-in-JSON: body.content = '{"text":"hello"}'
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Callable

import httpx

# 只清 socks 系代理：httpx 不认 socks:// scheme（会抛 ValueError）。
# 保留 http/https 代理 —— 本机可能直连不通，需走 Clash 的 http 代理
# （如 https_proxy=http://127.0.0.1:7890），httpx 会读环境变量自动走它。
for _k in list(os.environ):
    if _k.lower().endswith("proxy"):
        v = (os.environ.get(_k) or "").strip().lower()
        if "socks" in v:
            os.environ.pop(_k, None)

log = logging.getLogger("feishu_api")

FEISHU_BASE = "https://open.feishu.cn/open-apis"
CN_TZ = timezone(timedelta(hours=8))

# ── Token management ────────────────────────────────────────────


class TokenManager:
    """Manage tenant_access_token with auto-refresh.

    Token expires in 2h; we refresh 30min before expiry.
    """

    def __init__(self, app_id: str, app_secret: str):
        self._app_id = app_id
        self._app_secret = app_secret
        self._token: str = ""
        self._expires_at: float = 0.0
        self._client = httpx.Client(timeout=httpx.Timeout(15.0))

    @property
    def token(self) -> str:
        """Get current valid token, refreshing if needed."""
        if not self._token or time.time() > self._expires_at - 1800:
            self._refresh()
        return self._token

    def _refresh(self) -> None:
        url = f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal"
        body = {"app_id": self._app_id, "app_secret": self._app_secret}
        try:
            resp = self._client.post(url, json=body)
            data = resp.json()
        except Exception as e:
            log.error("Token refresh failed (network): %s", e)
            return

        if data.get("code") != 0:
            log.error("Token refresh failed (API): code=%s msg=%s",
                      data.get("code"), data.get("msg"))
            return

        self._token = data["tenant_access_token"]
        expire = data.get("expire", 7200)
        self._expires_at = time.time() + expire
        log.info("Token refreshed (expires in %ds)", expire)

    def close(self) -> None:
        self._client.close()


# ── Chat discovery ──────────────────────────────────────────────


def discover_chat_id(token_mgr: TokenManager, user_open_id: str) -> Optional[str]:
    """Auto-discover the P2P chat_id between the bot and user.

    Calls GET /im/v1/chats, filters for chat_type=p2p where the other
    member matches user_open_id.
    """
    url = f"{FEISHU_BASE}/im/v1/chats"
    params = {"user_id_type": "open_id", "page_size": 100}

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.get(
                url, params=params,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Chat discovery failed (network): %s", e)
        return None

    if data.get("code") != 0:
        log.error("Chat discovery failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None

    items = data.get("data", {}).get("items", [])
    log.info("Bot has %d chats", len(items))

    for chat in items:
        if chat.get("chat_type") != "p2p":
            continue
        members = chat.get("members", [])
        for member in members:
            if member.get("id") == user_open_id and member.get("id_type") == "open_id":
                chat_id = chat["chat_id"]
                log.info("Found P2P chat_id: %s", chat_id)
                return chat_id
        # Fallback: if no members exposed but it's the only P2P chat
        if not members:
            log.info("P2P chat without members, using as candidate: %s", chat["chat_id"])
            return chat["chat_id"]

    log.warning("No P2P chat found for user %s — send a message to the bot first",
                user_open_id)
    return None


# ── Message polling ─────────────────────────────────────────────


def poll_messages(
    token_mgr: TokenManager,
    chat_id: str,
    last_msg_id: str = "",
) -> List[Dict[str, Any]]:
    """Poll Feishu for new messages in a chat.

    Args:
        token_mgr: Token manager
        chat_id: P2P chat ID
        last_msg_id: Last processed message_id (for dedup)

    Returns:
        New messages in chronological order (oldest first).
    """
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {
        "container_id_type": "chat",
        "container_id": chat_id,
        "page_size": 10,
        "sort_type": "ByCreateTimeDesc",
    }

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.get(
                url, params=params,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Poll failed (network): %s", e)
        return []

    if data.get("code") != 0:
        log.error("Poll failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return []

    items = data.get("data", {}).get("items", [])
    if not items:
        return []

    # Filter already-processed messages by message_id
    new_items = []
    for item in items:
        msg_id = item.get("message_id", "")
        if last_msg_id and msg_id == last_msg_id:
            break  # items are descending by time
        new_items.append(item)

    new_items.reverse()  # chronological order
    if new_items:
        log.info("Found %d new messages", len(new_items))
    return new_items


def parse_message_text(item: Dict[str, Any]) -> str:
    """Extract plain text from a Feishu message body.

    Feishu text messages: body.content = '{"text":"hello"}'
    """
    body = item.get("body", {})
    content_str = body.get("content", "")
    if not content_str:
        return ""

    try:
        content = json.loads(content_str)
        return content.get("text", content_str)
    except (json.JSONDecodeError, TypeError):
        return content_str


# ── Message sending ─────────────────────────────────────────────


def send_message(
    token_mgr: TokenManager,
    chat_id: str,
    text: str,
    msg_type: str = "text",
) -> Optional[str]:
    """Send a text message to a Feishu chat.

    Returns:
        message_id on success, None on failure.
    """
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {"receive_id_type": "chat_id"}
    body = {
        "receive_id": chat_id,
        "msg_type": msg_type,
        "content": json.dumps({"text": text}, ensure_ascii=False),
    }

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.post(
                url, params=params, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Send failed (network): %s", e)
        return None

    if data.get("code") != 0:
        log.error("Send failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None

    msg_id = data.get("data", {}).get("message_id", "")
    log.info("Message sent: %s", msg_id)
    return msg_id


def edit_message(
    token_mgr: TokenManager,
    message_id: str,
    text: str,
) -> bool:
    """Edit an existing message (for streaming live updates).

    Feishu PATCH /im/v1/messages/:message_id — replaces the full content.
    """
    url = f"{FEISHU_BASE}/im/v1/messages/{message_id}"
    body = {
        "content": json.dumps({"text": text}, ensure_ascii=False),
    }

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.patch(
                url, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Edit failed (network): %s", e)
        return False

    if data.get("code") != 0:
        log.error("Edit failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return False

    return True


def reply_message(
    token_mgr: TokenManager,
    chat_id: str,
    text: str,
    reply_to_msg_id: str = "",
) -> Optional[str]:
    """Reply to a specific message in Feishu chat.

    Feishu supports reply via the `root_id` field in the message body.
    """
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {"receive_id_type": "chat_id"}
    body = {
        "receive_id": chat_id,
        "msg_type": "text",
        "content": json.dumps({"text": text}, ensure_ascii=False),
    }
    if reply_to_msg_id:
        body["root_id"] = reply_to_msg_id

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.post(
                url, params=params, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Reply failed (network): %s", e)
        return None

    if data.get("code") != 0:
        log.error("Reply failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None

    return data.get("data", {}).get("message_id", "")


def upload_image(
    token_mgr: TokenManager,
    image_path: str,
    image_type: str = "message",
) -> Optional[str]:
    """Upload an image to Feishu, returns image_key for use in messages.

    image_type 必须放 multipart form 字段（放 query 会报 234001），
    取值 "message"（消息用图）或 "avatar"（头像）。
    """
    url = f"{FEISHU_BASE}/im/v1/images"

    try:
        with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
            with open(image_path, "rb") as f:
                resp = client.post(
                    url,
                    data={"image_type": image_type},
                    files={"image": f},
                    headers={"Authorization": f"Bearer {token_mgr.token}"},
                )
            data = resp.json()
    except Exception as e:
        log.error("Image upload failed (network): %s", e)
        return None

    if data.get("code") != 0:
        log.error("Image upload failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None

    return data.get("data", {}).get("image_key", "")


def send_image_message(
    token_mgr: TokenManager,
    chat_id: str,
    image_key: str,
) -> Optional[str]:
    """Send an image message to a Feishu chat."""
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {"receive_id_type": "chat_id"}
    content = json.dumps({"image_key": image_key}, ensure_ascii=False)
    body = {
        "receive_id": chat_id,
        "msg_type": "image",
        "content": content,
    }

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.post(
                url, params=params, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Image send failed: %s", e)
        return None

    if data.get("code") != 0:
        log.error("Image send failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None

    return data.get("data", {}).get("message_id", "")


# ── 语音/文件上传与发送 ───────────────────────────────────────


def upload_file(
    token_mgr: TokenManager,
    file_path: str,
    file_type: str = "opus",
) -> Optional[str]:
    """上传文件到飞书，返回 file_key（语音消息用 opus）。

    file_type/file_name 必须放 multipart form 字段（放 query 会报 234001）。
    """
    url = f"{FEISHU_BASE}/im/v1/files"
    file_name = os.path.basename(file_path)
    try:
        with httpx.Client(timeout=httpx.Timeout(30.0)) as client:
            with open(file_path, "rb") as f:
                resp = client.post(
                    url,
                    data={"file_type": file_type, "file_name": file_name},
                    files={"file": (file_name, f, "application/octet-stream")},
                    headers={"Authorization": f"Bearer {token_mgr.token}"},
                )
            data = resp.json()
    except Exception as e:
        log.error("File upload failed (network): %s", e)
        return None
    if data.get("code") != 0:
        log.error("File upload failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None
    return data.get("data", {}).get("file_key", "")


def send_audio_message(
    token_mgr: TokenManager,
    chat_id: str,
    file_key: str,
) -> Optional[str]:
    """发送语音消息（msg_type=audio，content 里放 file_key）。"""
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {"receive_id_type": "chat_id"}
    content = json.dumps({"file_key": file_key}, ensure_ascii=False)
    body = {"receive_id": chat_id, "msg_type": "audio", "content": content}
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.post(
                url, params=params, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Audio send failed: %s", e)
        return None
    if data.get("code") != 0:
        log.error("Audio send failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None
    return data.get("data", {}).get("message_id", "")


def send_file_message(
    token_mgr: TokenManager,
    chat_id: str,
    file_key: str,
) -> Optional[str]:
    """发送普通文件消息（msg_type=file，content 里放 file_key）。

    与 send_audio_message 同构，仅 msg_type 不同。file_key 由 upload_file() 取得。
    """
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {"receive_id_type": "chat_id"}
    content = json.dumps({"file_key": file_key}, ensure_ascii=False)
    body = {"receive_id": chat_id, "msg_type": "file", "content": content}
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.post(
                url, params=params, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("File send failed: %s", e)
        return None
    if data.get("code") != 0:
        log.error("File send failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None
    return data.get("data", {}).get("message_id", "")


# ── File operations ─────────────────────────────────────────────


def _detect_image_ext(content: bytes) -> str:
    """从文件头魔数推断图片扩展名（返回带点；未知返回空串）。"""
    if content[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if content[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if content[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    if content[:2] == b"BM":
        return ".bmp"
    return ""


def download_file(
    token_mgr: TokenManager,
    message_id: str,
    file_key: str,
    file_type: str,
    save_dir: str = "/tmp",
) -> Optional[str]:
    """Download a file attachment from a Feishu message.

    Returns the local file path on success.
    """
    url = f"{FEISHU_BASE}/im/v1/messages/{message_id}/resources/{file_key}"
    params = {"type": file_type}

    try:
        with httpx.Client(timeout=httpx.Timeout(30.0)) as client:
            resp = client.get(
                url, params=params,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
    except Exception as e:
        log.error("File download failed (network): %s", e)
        return None

    if resp.status_code != 200:
        log.error("File download failed: status=%s", resp.status_code)
        return None

    # Determine filename from Content-Disposition or fallback
    filename = f"feishu_file_{message_id}"
    cd = resp.headers.get("content-disposition", "")
    if "filename=" in cd:
        import re
        match = re.search(r'filename[^;=\n]*=((["\']).*?\2|[^;\n]*)', cd)
        if match:
            filename = match.group(1).strip('"\'')
    elif file_type == "image":
        # 扩展名必须跟真实格式走（魔数），否则存成 .png 实为 JPEG 会让读取器报
        # [Unsupported Image]。Content-Disposition 没给名字时靠魔数补。
        ext = _detect_image_ext(resp.content)
        filename = f"{message_id}{ext or '.png'}"

    filepath = f"{save_dir}/{filename}"
    with open(filepath, "wb") as f:
        f.write(resp.content)

    log.info("File downloaded: %s", filepath)
    return filepath


def get_message_content(
    token_mgr: TokenManager,
    message_id: str,
) -> Optional[Dict[str, Any]]:
    """Get detailed content of a specific message by ID."""
    url = f"{FEISHU_BASE}/im/v1/messages/{message_id}"

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.get(
                url,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Get message failed: %s", e)
        return None

    if data.get("code") != 0:
        log.error("Get message failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None

    return data.get("data", {}).get("items", [{}])[0] if data.get("data", {}).get("items") else None


# ── Card messages (editable, supports streaming) ──────────────────


def send_card_message(
    token_mgr: TokenManager,
    chat_id: str,
    card: Dict[str, Any],
    root_id: str = "",
) -> Optional[str]:
    """Send an interactive card message that can be edited later.

    Card messages support real-time editing via PATCH, enabling streaming
    updates (Feishu text messages cannot be edited).

    Args:
        token_mgr: Token manager
        chat_id: P2P chat ID
        card: Card JSON object (header + elements in markdown format)
        root_id: Optional reply-to message ID

    Returns:
        message_id on success, None on failure.
    """
    url = f"{FEISHU_BASE}/im/v1/messages"
    params = {"receive_id_type": "chat_id"}
    body = {
        "receive_id": chat_id,
        "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False),
    }
    if root_id:
        body["root_id"] = root_id

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.post(
                url, params=params, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Send card failed (network): %s", e)
        return None

    if data.get("code") != 0:
        log.error("Send card failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return None

    msg_id = data.get("data", {}).get("message_id", "")
    log.info("Card sent: %s", msg_id)
    return msg_id


def edit_card_message(
    token_mgr: TokenManager,
    message_id: str,
    card: Dict[str, Any],
) -> bool:
    """Edit an existing card message (for streaming live updates).

    This is the key mechanism for streaming: send an initial card, then
    repeatedly call edit_card_message to update the content in place.

    Args:
        token_mgr: Token manager
        message_id: The message to edit
        card: Updated card JSON object

    Returns:
        True on success.
    """
    url = f"{FEISHU_BASE}/im/v1/messages/{message_id}"
    body = {"content": json.dumps(card, ensure_ascii=False)}

    try:
        with httpx.Client(timeout=httpx.Timeout(10.0)) as client:
            resp = client.patch(
                url, json=body,
                headers={"Authorization": f"Bearer {token_mgr.token}"},
            )
            data = resp.json()
    except Exception as e:
        log.error("Edit card failed (network): %s", e)
        return False

    if data.get("code") != 0:
        log.error("Edit card failed (API): code=%s msg=%s",
                  data.get("code"), data.get("msg"))
        return False

    return True


# 飞书卡片 markdown 元素会把 `![alt](src)` 当图片，要求必须传 image_key，
# 否则 230099 / 11310（the card contains images but no imagekey is passed in）。
# 流式卡片不传 image_key，所以把图片语法中性化成普通链接，避免整卡编辑失败。
_CARD_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)]*)\)")


def _sanitize_card_markdown(text: str) -> str:
    """把 markdown 图片语法 `![alt](src)` 转成链接 `[alt](src)`。

    图片引用没被上传成飞书 image_key，直接进卡片 markdown 会抛 11310，
    让整张卡片（含其余文本）编辑失败。改成链接后飞书按普通链接渲染，不再报错。
    """

    def _repl(m: "re.Match[str]") -> str:
        alt, url = m.group(1).strip(), m.group(2).strip()
        label = alt or url
        if not url:
            return label
        return f"[{label}]({url})"

    return _CARD_IMG_RE.sub(_repl, text)


def build_streaming_card(
    text: str,
    title: str = "MateBot",
    template: str = "blue",
    tool_lines: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Build a Feishu card JSON for streaming output.

    Args:
        text: The main text content (markdown supported)
        title: Card header title
        template: Card header color (blue/green/red/yellow/purple)
        tool_lines: Optional tool status lines to prepend

    Returns:
        Card dict ready for send_card_message / edit_card_message.
    """
    elements = []
    if tool_lines:
        elements.append({
            "tag": "markdown",
            "content": _sanitize_card_markdown("\n".join(tool_lines)),
        })
    elements.append({
        "tag": "markdown",
        "content": _sanitize_card_markdown(text) if text else "▊",  # cursor marker when empty
    })

    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": template,
        },
        "elements": elements,
    }