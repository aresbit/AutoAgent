---
name: feishu-send-file
description: 把本机文件作为 file 消息发到飞书当前会话(P2P)。自带上传+发送，收件人默认读 ~/.matecode/feishu_chat_id。args: path(必填,本地文件路径), text(可选,随附一条文本), chat_id(可选), file_type(可选,默认按扩展名推断: stream|pdf|doc|xls|ppt|mp4|opus)
language: python
---

# 把文件发到飞书：走 MateBot 仓库现成的 feishu_api 上传+发送。
# 用法: feishu-send-file path=<本地文件> [text=...] [chat_id=...] [file_type=...]
import json
import os
import sys

REPO = "/home/pc/yysapp/MateBot"
CHAT_ID_FILE = os.path.expanduser("~/.matecode/feishu_chat_id")
ALLOWED = {"opus", "mp4", "pdf", "doc", "xls", "ppt", "stream"}
EXT_MAP = {
    ".pdf": "pdf", ".mp4": "mp4", ".doc": "doc", ".docx": "doc",
    ".xls": "xls", ".xlsx": "xls", ".ppt": "ppt", ".pptx": "ppt",
    ".opus": "opus",
}


def die(msg):
    print("ERR " + msg)
    raise SystemExit(1)


path = (_ACTION_ARGS.get("path") or "").strip()
text = _ACTION_ARGS.get("text") or ""
chat_id = (_ACTION_ARGS.get("chat_id") or "").strip()
ftype = (_ACTION_ARGS.get("file_type") or "").strip().lower()

if not path:
    die("缺 path。用法: feishu-send-file path=<本地文件> [text=...] [chat_id=...] [file_type=...]")
path = os.path.abspath(os.path.expanduser(path))
if not os.path.isfile(path):
    die("文件不存在: %s" % path)

size = os.path.getsize(path)
if size == 0:
    die("文件为空: %s" % path)
if size > 30 * 1024 * 1024:
    die("文件 %d 字节 > 30MB 上限，飞书 im/v1/files 传不了" % size)

if not ftype:
    ftype = EXT_MAP.get(os.path.splitext(path)[1].lower(), "stream")
if ftype not in ALLOWED:
    die("file_type=%r 不合法，只能是 %s" % (ftype, sorted(ALLOWED)))

if not chat_id:
    if not os.path.isfile(CHAT_ID_FILE):
        die("没给 chat_id，且 %s 不存在" % CHAT_ID_FILE)
    with open(CHAT_ID_FILE, encoding="utf-8") as f:
        chat_id = f.read().strip()
if not chat_id:
    die("chat_id 为空")

sys.path.insert(0, REPO)
try:
    import httpx
    from feishu_api import FEISHU_BASE, TokenManager, upload_file
    from feishu_config import get_feishu_app_id, get_feishu_app_secret
except Exception as e:
    die("导入 MateBot 飞书模块失败: %r" % e)

app_id, app_secret = get_feishu_app_id(), get_feishu_app_secret()
if not app_id or not app_secret:
    die("飞书 app_id/app_secret 没配到（查 feishu_config 的 env / yaml）")

tm = TokenManager(app_id, app_secret)
file_key = upload_file(tm, path, file_type=ftype)
if not file_key:
    die("上传失败（见上面 feishu_api 的日志）")

name = os.path.basename(path)


def post(content, msg_type):
    resp = httpx.post(
        FEISHU_BASE + "/im/v1/messages",
        params={"receive_id_type": "chat_id"},
        json={"receive_id": chat_id, "msg_type": msg_type,
              "content": json.dumps(content, ensure_ascii=False)},
        headers={"Authorization": "Bearer " + tm.token},
        timeout=20.0,
    )
    d = resp.json()
    if d.get("code") != 0:
        die("发送失败 msg_type=%s: code=%s msg=%s" % (msg_type, d.get("code"), d.get("msg")))
    return d.get("data", {}).get("message_id", "")


if text:
    post({"text": text}, "text")
mid = post({"file_key": file_key}, "file")

print("OK  file    = %s" % name)
print("OK  size    = %d 字节" % size)
print("OK  type    = %s" % ftype)
print("OK  chat    = %s" % chat_id)
print("OK  message = %s" % mid)
