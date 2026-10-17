"""Logging setup with rotation and secret redaction."""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from logging.handlers import RotatingFileHandler
from pathlib import Path

_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)\b(sk-[A-Za-z0-9_-]{8,})\b"),
    re.compile(
        r"(?i)\b(api[_-]?key|token|secret|password|authorization)\b"
        r"(\s*[=:]\s*)([^\s,;&]+)"
    ),
)

REDACTED = "[REDACTED]"


def redact(text: str, secrets: Iterable[str] = ()) -> str:
    """Redact known secret values and common credential shapes.

    Post: the returned string contains no literal secret from ``secrets`` and no
          Bearer/API-key-looking value.
    """

    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, REDACTED)
    for pattern in _PATTERNS:
        if pattern.groups == 3:
            redacted = pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", redacted)
        elif pattern.groups == 2:
            redacted = pattern.sub(lambda m: f"{m.group(1)}{REDACTED}", redacted)
        else:
            redacted = pattern.sub(REDACTED, redacted)
    return redacted


class RedactionFilter(logging.Filter):
    """Redact the fully formatted message before any handler sees it."""

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = tuple(s for s in secrets if s)

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = redact(message, self._secrets)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


def configure_logging(
    log_dir: Path,
    *,
    level: int = logging.INFO,
    secrets: Iterable[str] = (),
    console: bool = True,
) -> logging.Logger:
    """Install rotating file and optional console handlers on the root logger.

    Post: handlers are idempotent for repeated calls in one process; the file is
          UTF-8, rotated at 5 MiB with 3 backups.
    Raises: ``OSError`` when the log directory cannot be created.
    """

    log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    for handler in list(root.handlers):
        if getattr(handler, "_autoagent_handler", False):
            root.removeHandler(handler)
            handler.close()

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )
    redaction = RedactionFilter(secrets)

    file_handler = RotatingFileHandler(
        log_dir / "backend.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(redaction)
    file_handler._autoagent_handler = True  # type: ignore[attr-defined]
    root.addHandler(file_handler)

    if console:
        stream_handler = logging.StreamHandler()
        stream_handler.setFormatter(formatter)
        stream_handler.addFilter(redaction)
        stream_handler._autoagent_handler = True  # type: ignore[attr-defined]
        root.addHandler(stream_handler)

    root.setLevel(level)
    return logging.getLogger("autoagent")
