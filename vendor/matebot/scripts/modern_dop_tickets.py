#!/usr/bin/env python3
"""modern_dop_tickets.py — MateBot's CLI for the modern-dop support machine surface.

Zero third-party dependencies: stdlib urllib only (deliberately, so this runs in
any MateBot environment without touching uv.lock).

Environment
-----------
  MODERN_DOP_BASE_URL         base URL, e.g. http://127.0.0.1:8080
  TDOP_SUPPORT_SERVICE_TOKEN  X-Service-Token for the machine surface

Commands
--------
  list [status]              list tickets (default status=open)
  comment <code> <text>      append a comment to ticket TK-xxxxxx
  resolve <code> [comment]   comment (optional) then set status=resolved

Contract: docs/SUPPORT.md §3 in the modern-dop repo.

The machine surface is `/api/v1/support/*` and keyed by the human-readable
`code` (TK-000123): its consumer is an agent's CLI holding only the code the
Feishu card carries, authenticated by a service token — a different consumer,
key and auth path from the browser/SSO `/api/v2/*` surface. This CLI speaks
only the machine surface.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_STATUS = "open"
DEFAULT_AUTHOR = "MateBot"
DEFAULT_LIMIT = 20
TIMEOUT_SEC = 15

# Machine surface: /api/v1/support/*, X-Service-Token guarded, keyed by code.
MACHINE_TICKETS = "/api/v1/support/tickets"


def fail(msg: str) -> None:
    print(f"modern_dop_tickets: {msg}", file=sys.stderr)
    raise SystemExit(1)


def base_url() -> str:
    url = os.environ.get("MODERN_DOP_BASE_URL", "").strip().rstrip("/")
    if not url:
        fail("MODERN_DOP_BASE_URL is not set")
    return url


def service_token() -> str:
    token = os.environ.get("TDOP_SUPPORT_SERVICE_TOKEN", "").strip()
    if not token:
        fail("TDOP_SUPPORT_SERVICE_TOKEN is not set (machine surface is closed without it)")
    return token


def request(method: str, path: str, body: dict | None = None):
    """Return the decoded JSON payload, unwrapping a {"data": ...} envelope."""
    url = base_url() + path
    headers = {
        "X-Service-Token": service_token(),
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace").strip()
        fail(f"HTTP {exc.code} {method} {path}: {detail}")
    except urllib.error.URLError as exc:
        fail(f"cannot reach {url}: {exc.reason}")
    if not raw.strip():
        return None
    payload = json.loads(raw)
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def cmd_list(argv: list[str]) -> int:
    status = argv[0] if argv else DEFAULT_STATUS
    tickets = request("GET", f"{MACHINE_TICKETS}?status={status}&limit={DEFAULT_LIMIT}")
    if not tickets:
        print(f"no {status} tickets")
        return 0
    for t in tickets:
        code = str(t.get("code", "?"))
        prio = str(t.get("priority", "?"))
        title = str(t.get("title", ""))
        print(f"{code}  {prio:<6}  {t.get('status', '?')}  {title}")
    return 0


def cmd_comment(argv: list[str]) -> int:
    if len(argv) < 2:
        fail("usage: comment <code> <text>")
    code, text = argv[0], " ".join(argv[1:])
    request(
        "POST",
        f"{MACHINE_TICKETS}/{code}/comments",
        {"body": text, "author": DEFAULT_AUTHOR},
    )
    print(f"commented on {code}")
    return 0


def cmd_resolve(argv: list[str]) -> int:
    if not argv:
        fail("usage: resolve <code> [comment]")
    code = argv[0]
    # Confirm the ticket exists first: a typo'd code must fail loudly, not
    # silently 404 on the comment and then 404 again on the status update.
    if request("GET", f"{MACHINE_TICKETS}/{code}") is None:
        fail(f"ticket {code} not found")
    if len(argv) > 1:
        request(
            "POST",
            f"{MACHINE_TICKETS}/{code}/comments",
            {"body": " ".join(argv[1:]), "author": DEFAULT_AUTHOR},
        )
    request("PUT", f"{MACHINE_TICKETS}/{code}", {"status": "resolved"})
    print(f"resolved {code}")
    return 0


COMMANDS = {
    "list": cmd_list,
    "comment": cmd_comment,
    "resolve": cmd_resolve,
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    handler = COMMANDS.get(cmd)
    if handler is None:
        fail(f"unknown command {cmd!r} (list | comment | resolve)")
    return handler(rest)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
