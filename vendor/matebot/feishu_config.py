"""配置加载器 — 读取 feishu_config.yaml + 外部密钥文件 + 环境变量，提供统一配置接口。

密钥存储在 ~/Documents/config/feishu-meeting-assistant/secrets.yaml
不在 git 仓库内，保证安全。

优先级: 环境变量 > 主配置文件 > 密钥文件
"""

import os
import yaml
from typing import Optional


# 配置文件路径
_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.join(_PROJECT_ROOT, "feishu_config.yaml")
_SECRETS_PATH = os.path.expanduser("~/Documents/config/feishu-meeting-assistant/secrets.yaml")


class ConfigError(Exception):
    """配置错误。"""
    pass


def _load_yaml(path: str) -> dict:
    """加载 YAML 文件，不存在时返回空字典。"""
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _apply_env_overrides(config: dict) -> dict:
    """环境变量覆盖（最高优先级）。"""
    overrides = {
        "feishu_app_id": os.environ.get("FEISHU_APP_ID"),
        "feishu_app_secret": os.environ.get("FEISHU_APP_SECRET"),
        "chat_id": os.environ.get("FEISHU_CHAT_ID"),
        "user_open_id": os.environ.get("FEISHU_USER_OPEN_ID"),
    }
    for key, value in overrides.items():
        if value:
            config[key] = value
    return config


def _load_raw() -> dict:
    """加载主配置 + 合并密钥文件 + 环境变量覆盖。"""
    if not os.path.exists(_CONFIG_PATH):
        raise ConfigError(
            f"配置文件不存在: {_CONFIG_PATH}\n"
            f"请复制 feishu_config.yaml.example 为 feishu_config.yaml 并填入实际值。"
        )

    config = _load_yaml(_CONFIG_PATH)

    # 合并外部密钥（密钥文件中的字段会覆盖主配置中的同名字段）
    secrets = _load_yaml(_SECRETS_PATH)
    if secrets:
        config.update(secrets)

    # 环境变量最高优先级
    config = _apply_env_overrides(config)

    return config


# ── 模块级缓存 ──────────────────────────────────
_config: Optional[dict] = None


def load_config() -> dict:
    """加载并缓存配置。"""
    global _config
    if _config is None:
        _config = _load_raw()
    return _config


def reload_config() -> dict:
    """强制重新加载配置（清除缓存）。"""
    global _config
    _config = None
    return load_config()


# ── 便捷访问 ────────────────────────────────────

def get_feishu_app_id() -> str:
    """飞书应用 App ID。"""
    return load_config().get("feishu_app_id", "")


def get_feishu_app_secret() -> str:
    """飞书应用 App Secret。"""
    return load_config().get("feishu_app_secret", "")


def get_chat_id() -> str:
    """返回配置的 chat_id，空字符串表示自动发现。"""
    return load_config().get("chat_id", "")


def get_user_open_id() -> str:
    """飞书用户 Open ID（用于自动发现 P2P chat）。"""
    return load_config().get("user_open_id", "")


def get_poll_interval() -> int:
    """轮询间隔（秒）。"""
    return load_config().get("poll_interval_sec", 5)


def get_desktop_notify() -> bool:
    """是否启用 notify-send 桌面弹窗。"""
    return load_config().get("desktop_notify", True)


# ── OpenCC 便捷访问 ─────────────────────────────

def is_opencc_spawn_mode() -> bool:
    """是否优先使用 spawn 模式（stream-json 直连）。"""
    return load_config().get("opencc_spawn_mode", True)


def get_opencc_cli_path() -> str:
    """OpenCC CLI 路径，空字符串表示自动检测。"""
    return load_config().get("opencc_cli_path", "")


def get_opencc_bun_path() -> str:
    """bun 运行时路径。"""
    return load_config().get("opencc_bun_path", "bun")


def get_opencc_model() -> str:
    """OpenCC 模型，空字符串表示使用 CLI 默认。"""
    return load_config().get("opencc_model", "")


def get_opencc_cwd() -> str:
    """OpenCC 工作目录，空字符串表示使用当前目录。"""
    return load_config().get("opencc_cwd", "")