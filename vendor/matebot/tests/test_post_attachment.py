#!/usr/bin/env python3
"""Unit tests for post-message (图文) parsing in feishu_bridge.BotHandler.

No network, no tokens, no Feishu:

    python3 tests/test_post_attachment.py

What they guard, and why:

  A. **An attachment in a `post` message reaches the model.** Regression, 2026-09-12:
     the `post` branch read only the text elements of `content` and never looked at
     `content["files"]`, so a message that was *just* an attached PDF ("派个 agent 学下
     这本交易书籍" + The Secret Trader.pdf) arrived as that one sentence with the book
     missing entirely. Sending a file with a note is the natural way to use the app,
     which is why this cost a whole round-trip to notice.

  B. Text is not lost in the process. The fix had to add attachments without
     regressing the text that already worked.

  C. Inline images (`tag: "img"`) are attachments too — same reasoning as A.

  D. Nothing here may raise on a malformed or surprising payload. `handle_message`
     skips a message whose text comes back empty, so a parse that throws is a
     *silently dropped user message*; a placeholder is strictly better.

The payloads below are the real wire shapes, copied from live messages.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import feishu_bridge as fb  # noqa: E402

# The message this whole file exists for: a note and a PDF, nothing else.
REAL_POST_WITH_FILE = {
    "message_id": "om_x100b657df81a68a8",
    "msg_type": "post",
    "body": {
        "content": json.dumps(
            {
                "title": "",
                "content": [[{"tag": "text", "text": "派一个agent后台学习下这本交易书籍", "style": []}]],
                "content_v2": [[{"tag": "text", "text": "派一个agent后台学习下这本交易书籍", "style": []}]],
                "files": [
                    {
                        "file_key": "file_v3_0015f_e547c3fa-42a3-40b7-a83a-b97aa19af42g",
                        "file_name": "The Secret Trader.pdf",
                        "is_folder": False,
                    }
                ],
            },
            ensure_ascii=False,
        )
    },
}


def handler_with(recorder: list) -> fb.BotHandler:
    """A BotHandler whose downloads are recorded instead of performed."""
    handler = fb.BotHandler.__new__(fb.BotHandler)

    def fake_download(file_key: str, file_type: str, subdir: str, msg_id: str) -> str:
        recorder.append({"file_key": file_key, "type": file_type, "subdir": subdir, "msg_id": msg_id})
        return f"/tmp/matebot_{subdir}/{file_key}.bin"

    handler._download_key = fake_download  # type: ignore[method-assign]
    return handler


def test_a_posted_attachment_reaches_the_text() -> None:
    """A. The book must be in the returned text — that is the bug."""
    calls: list = []
    text = handler_with(calls)._handle_post(REAL_POST_WITH_FILE)

    assert "派一个agent后台学习下这本交易书籍" in text, f"text lost: {text!r}"
    assert "[文件已保存:" in text, f"attachment dropped — the original bug: {text!r}"
    assert "file_v3_0015f_e547c3fa" in text, f"the wrong key was used: {text!r}"
    assert len(calls) == 1 and calls[0]["type"] == "file" and calls[0]["subdir"] == "files"


def test_text_comes_before_the_attachment() -> None:
    """The instruction is read first, then the material it refers to."""
    text = handler_with([])._handle_post(REAL_POST_WITH_FILE)
    assert text.index("派一个") < text.index("[文件已保存:")


def test_a_nonempty_title_is_kept() -> None:
    item = json.loads(json.dumps(REAL_POST_WITH_FILE))
    body = json.loads(item["body"]["content"])
    body["title"] = "本周报告"
    item["body"]["content"] = json.dumps(body, ensure_ascii=False)

    text = handler_with([])._handle_post(item)
    assert text.startswith("本周报告"), text


def test_an_empty_title_adds_no_blank_line() -> None:
    """The real payload has ``"title": ""``; it must not become a leading newline."""
    text = handler_with([])._handle_post(REAL_POST_WITH_FILE)
    assert not text.startswith("\n")


def test_inline_images_are_downloaded_too() -> None:
    """C. An ``img`` element is an attachment by another name."""
    item = {
        "message_id": "om_test",
        "body": {
            "content": json.dumps(
                {
                    "title": "",
                    "content": [[{"tag": "text", "text": "看图"}], [{"tag": "img", "image_key": "img_v2_abc"}]],
                },
                ensure_ascii=False,
            )
        },
    }
    calls: list = []
    text = handler_with(calls)._handle_post(item)

    assert "看图" in text
    assert "img_v2_abc" in text
    assert calls and calls[0]["type"] == "image"


def test_several_attachments_all_survive() -> None:
    item = {
        "message_id": "om_test",
        "body": {
            "content": json.dumps(
                {
                    "title": "",
                    "content": [[{"tag": "text", "text": "两份都看下"}]],
                    "files": [
                        {"file_key": "file_a", "file_name": "a.pdf"},
                        {"file_key": "file_b", "file_name": "b.zip"},
                    ],
                },
                ensure_ascii=False,
            )
        },
    }
    calls: list = []
    text = handler_with(calls)._handle_post(item)

    assert "file_a" in text and "file_b" in text
    assert len(calls) == 2, f"expected both attachments, got {calls!r}"


def test_a_failed_download_names_the_file() -> None:
    """A silent failure would look like a message that never had an attachment."""
    handler = fb.BotHandler.__new__(fb.BotHandler)
    handler._download_key = lambda *a, **k: ""  # type: ignore[method-assign]

    text = handler._handle_post(REAL_POST_WITH_FILE)
    assert "下载失败" in text and "The Secret Trader.pdf" in text


def test_malformed_payloads_return_a_placeholder_not_an_exception() -> None:
    """D. Raising here would drop the user's message silently."""
    handler = handler_with([])
    for body in ("not json", "[]", "null", "{}", json.dumps({"content": "not-a-list"})):
        item = {"message_id": "om_test", "body": {"content": body}}
        result = handler._handle_post(item)
        assert isinstance(result, str) and result, f"body={body!r} produced {result!r}"


def test_a_post_with_only_attachments_is_not_dropped() -> None:
    """No caption, just a file — still must produce text, or ``handle_message`` skips it."""
    item = {
        "message_id": "om_test",
        "body": {
            "content": json.dumps(
                {"title": "", "content": [], "files": [{"file_key": "file_only", "file_name": "x.pdf"}]},
                ensure_ascii=False,
            )
        },
    }
    text = handler_with([])._handle_post(item)
    assert "file_only" in text


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
        else:
            print(f"ok   {fn.__name__}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
