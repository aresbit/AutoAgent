# Verification record

Environment: Linux, Python 3.12.3, pytest 9.1.1, ruff 0.17.1, mypy 2.4.0,
TypeScript 5.9.3 (AutoAgent's local `tsc`). Commands were run on 2026-10-19.

No file under `/home/tars/yysapp/AutoAgent` was modified. `/home/tars/yysapp` is
not a git repository, so no git diff is available; the files below are the
complete output of this task.

## Python compile

```
$ cd /home/tars/yysapp/claude-desktop/research/mcp-integration/backend
$ python3 -m py_compile transports.py approval.py connection_manager.py test_mcp_manager.py
$ echo $?
0
```

## pytest

```
$ cd /home/tars/yysapp/claude-desktop/research/mcp-integration/backend
$ pytest -q test_mcp_manager.py
..............                                                           [100%]
14 passed in 5.37s
```

Covered tests:

1. `test_stdio_initialize_list_call_and_cache`
2. `test_reconnect_after_server_exit`
3. `test_reconnect_failure_then_backoff`
4. `test_health_check`
5. `test_disabling_a_server_invalidates_cached_tools`
6. `test_timeout_does_not_kill_the_session`
7. `test_cancellation`
8. `test_tools_list_changed_invalidates_cache`
9. `test_resources_and_prompts`
10. `test_destructive_tool_requires_consent`
11. `test_http_streamable_session_and_sse_response`
12. `test_http_session_expiry_reconnects`
13. `test_legacy_sse_transport`
14. `test_status_events_and_logs`

The tests use a real child process (fake stdio MCP server), a real
`ThreadingHTTPServer` (Streamable HTTP + legacy SSE) and real localhost sockets.
No test imports FastAPI, Pydantic or AutoAgent.

## ruff (lint)

```
$ cd /home/tars/yysapp/AutoAgent/backend
$ uv run ruff check /home/tars/yysapp/claude-desktop/research/mcp-integration/backend
All checks passed!

$ uv run ruff format --check /home/tars/yysapp/claude-desktop/research/mcp-integration/backend
4 files already formatted
```

## mypy (strict)

```
$ cd /home/tars/yysapp/AutoAgent/backend
$ uv run mypy --strict --python-version 3.12 \
    /home/tars/yysapp/claude-desktop/research/mcp-integration/backend/transports.py \
    /home/tars/yysapp/claude-desktop/research/mcp-integration/backend/approval.py \
    /home/tars/yysapp/claude-desktop/research/mcp-integration/backend/connection_manager.py
Success: no issues found in 3 source files
```

The test module is intentionally excluded from strict mypy because pytest
fixtures and the embedded fake-server source are not part of the shipped
adapter; ruff still checks it.

## TypeScript

`frontend/tsconfig.check.json` maps `react`, `react/jsx-runtime` and `csstype`
to AutoAgent's existing `node_modules`; it does not copy or modify dependencies.

```
$ cd /home/tars/yysapp/claude-desktop/research/mcp-integration/frontend
$ /home/tars/yysapp/AutoAgent/frontend/node_modules/.bin/tsc --noEmit -p tsconfig.check.json
$ echo $?
0
```

Strict options in the check config include `strict`, `noUnusedLocals`,
`noUnusedParameters`, `noFallthroughCasesInSwitch` and `forceConsistentCasingInFileNames`.

## Stdlib-only check

`transports.py`, `approval.py` and `connection_manager.py` import only the
Python standard library. They do not import FastAPI, Starlette, Pydantic,
SQLite, httpx/requests or AutoAgent modules. `subprocess` is used with an argv
vector and no `shell=True`.

## Proven failure mode fixed during development

The first test run exposed a real deadlock: the stdio reader thread called the
manager log callback while the connecting thread held the single per-server
lock, so EOF was not delivered and `initialize` timed out. The reference now
uses separate `connect_lock`, state `lock` and `log_lock`, and dispatches
notifications on a worker thread. `test_reconnect_failure_then_backoff` and all
other tests pass after this change.

## Not verified (integration not applied)

- AutoAgent's FastAPI routes and `EventBus` wiring were not modified or run
  against the manager.
- opencc/MateBot engine MCP configuration sync (T2) was not attempted.
- OAuth, MCP Apps/DXT, resource size caps and keyring storage are design items,
  not implemented in this reference.
