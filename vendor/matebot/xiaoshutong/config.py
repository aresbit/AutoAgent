"""小书童共享配置加载器。

优先级: 环境变量 > config.yaml > 默认值。
密钥从飞书 API 使用环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（与 MateBot 一致）。
"""

from __future__ import annotations

import os
import yaml
from pathlib import Path
from typing import Any, Dict, Optional

_DIR = Path(__file__).resolve().parent
_CONFIG_PATH = _DIR / "config.yaml"
_TOKEN_FILE_DEFAULT = _DIR / ".tokens.json"


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _resolve_token_path(raw: Optional[str]) -> Path:
    if raw:
        p = Path(raw).expanduser()
        return p if p.is_absolute() else _DIR / p
    return _TOKEN_FILE_DEFAULT


class Config:
    """小书童配置。字段与 config.yaml 一一对应。"""

    def __init__(self, raw: Dict[str, Any]):
        self.raw = raw
        self.data_dir: Path = _DIR / (raw.get("data_dir", "data"))
        self.token_file: Path = _resolve_token_path(raw.get("token_file"))
        self.claude_cli: str = raw.get("claude_cli", "")
        self.claude_bun: str = raw.get("claude_bun", "bun")
        self.dangerously_skip_permissions: bool = bool(
            raw.get("dangerously_skip_permissions", True)
        )
        self.fetch_hours: float = float(raw.get("fetch_hours", 1))
        self.initial_backfill_hours: float = float(
            raw.get("initial_backfill_hours", 24)
        )
        self.pagination_page_size: int = int(raw.get("pagination_page_size", 100))

        chat_filters = raw.get("chat_filters", {}) or {}
        self.chat_filters_enabled: bool = bool(chat_filters.get("enabled", False))
        self.include_keywords: list = chat_filters.get("include_keywords", []) or []
        self.exclude_keywords: list = chat_filters.get("exclude_keywords", []) or []
        self.max_chats: int = int(chat_filters.get("max_chats", 30))

        self.send_chat: str = raw.get("send_chat", "") or ""
        self.send_title: str = raw.get("send_title", "小书童")

    @property
    def feishu_app_id(self) -> str:
        return os.environ.get("FEISHU_APP_ID", "")

    @property
    def feishu_app_secret(self) -> str:
        return os.environ.get("FEISHU_APP_SECRET", "")

    @property
    def send_chat_id(self) -> str:
        """发送目标 chat_id：配置 > 环境变量。"""
        return self.send_chat or os.environ.get("FEISHU_CHAT_ID", "")

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.token_file.parent.mkdir(parents=True, exist_ok=True)


def load_config() -> Config:
    return Config(_load_yaml(_CONFIG_PATH))


def ensure_config_exists() -> None:
    if not _CONFIG_PATH.exists():
        raise FileNotFoundError(
            f"配置文件不存在: {_CONFIG_PATH}\n"
            f"请参考 config.yaml 模板创建。"
        )
