# Recon: MateBot `--matebot` Semantics and Desktop Connection Model

Scope: evidence-only reading of

- `/home/tars/yysapp/MateBot` (Python bridge + vendored `opencc`)
- `/home/tars/yysapp/MateBot/vendor/opencc` at commit `4c83c36` (detached HEAD)
- `/home/tars/yysapp/AutoAgent` (desktop shell + outdated vendored `opencc`)

No source files were modified. All paths below are absolute or repo-relative with an explicit repo prefix.

---

## 1. Commands run

```bash
# Repo / git shape
ls -la /home/tars/yysapp/MateBot /home/tars/yysapp/AutoAgent
cd /home/tars/yysapp/MateBot/vendor/opencc && git status --short && git log --oneline -10
cd /home/tars/yysapp/AutoAgent/packages/opencc && git rev-parse --show-toplevel   # -> /home/tars/yysapp/AutoAgent

# Feature/call-site searches
grep -rn "isMateBotModeEnabled\|MATEBOT_FLAG\|matebot" /home/tars/yysapp/MateBot/vendor/opencc/src
grep -rn "MATEBOT_\|OPENCC_MATEBOT" /home/tars/yysapp/MateBot/vendor/opencc/src

# CLI help (did not start an interactive session)
cd /home/tars/yysapp/AutoAgent/packages/opencc && bun dist/cli.js --help
# MateBot vendor has no node_modules/dist, so `bun run src/entrypoints/cli.tsx --help`
# currently fails at module resolution (`lodash-es/memoize.js`); it was not installed.

# Stream-JSON framing probe (keep_alive only, no model request)
printf '%s\n' '{"type":"keep_alive"}' | timeout 15 bun /home/tars/yysapp/AutoAgent/packages/opencc/dist/cli.js \
  --print --verbose --input-format stream-json --output-format stream-json \
  --include-partial-messages --permission-mode default
# No frames are emitted before a real user turn; examples in section 7 are schema-derived.
```

Existing teammate docs already in this directory: `legacy-inventory.md`, `maxwire-model.md`.

---

## 2. `--matebot` gate

There is one source of truth, `src/utils/matebotMode.ts`:

- `MATEBOT_FLAG = '--matebot'` (`matebotMode.ts:17`).
- `isMateBotModeEnabled()` returns true when `OPENCC_MATEBOT` is truthy **or** argv contains `--matebot` (`matebotMode.ts:22-32`).
- Commander owns the final verdict in the `preAction` hook: `setMateBotMode(thisCommand.opts().matebot === true)` (`src/main.tsx:905-911`). `parsedOverride` outranks the raw scan (`matebotMode.ts:19-41`).
- The flag is registered as a normal option, so it is visible in `--help`:
  `program.option('--matebot', 'Run as a MateBot swarm coordinator with specialist workers and eval/apply gates')` (`src/main.tsx:3802`).

`OPENCC_MATEBOT=1` is therefore sufficient; `--matebot` is the explicit form (README lines 9-20).

---

## 3. What changes in MateBot mode

### 3.1 System prompt becomes the MateBot coordinator prompt

`src/utils/systemPrompt.ts:60-75`: when MateBot mode (or `CLAUDE_CODE_COORDINATOR_MODE`) is on **and** there is no main-thread agent definition, the default system prompt is replaced by `getCoordinatorSystemPrompt()`; `appendSystemPrompt` is still appended after it.

`src/coordinator/coordinatorMode.ts:114-119` defines the prompt: "You are MateBot, the swarm coordinator built on OpenCC." It documents:

- direct capability vs delegation; the coordinator keeps the full ordinary tool pool (`:131-143`);
- worker roles `researcher` / `planner` / `builder` / `evaluator` / `worker` (`:204-215`);
- a quality gate in which an independent `evaluator` must produce a command-backed verdict before apply (`:230-239`);
- cron for durable future work, Memory for stable facts, tasks + eval/apply ledger for transient execution state (`:241-243`);
- parallel worker fan-out guidance (`:245-252`).

`getCoordinatorUserContext()` injects the worker tool list, MCP server names and optional scratchpad directory into the user context (`coordinatorMode.ts:83-112`).

### 3.2 Agent registry is replaced

`src/tools/AgentTool/builtInAgents.ts:41-50`: in MateBot/coordinator mode, `getBuiltInAgents()` returns `getCoordinatorAgents()` instead of the ordinary built-ins.

`src/coordinator/workerAgent.ts` defines exactly five agents:

| Agent | Line | Notes |
|---|---|---|
| `worker` | `:28` | general fallback, tools `['*']` |
| `researcher` | `:34` | no Edit/Write/NotebookEdit |
| `planner` | `:44` | no Edit/Write/NotebookEdit |
| `builder` | `:54` | implementation |
| `evaluator` | `:61` | read-only + background; must end `VERDICT: PASS/FAIL/PARTIAL` |

The shared worker prompt explicitly directs specialists to `rsi`, `manuscript_check`, `kimi_webbridge`, `eval_apply` and `ActorTool` (`workerAgent.ts:6-10`).

### 3.3 Swarm/worker spawning is forced on

`src/utils/agentSwarmsEnabled.ts:30-40`: MateBot mode returns `true` before the external `--agent-teams` opt-in and before the GrowthBook killswitch. This enables teammate/swarm machinery without any Anthropic-hosted gate.

Remote isolation is an independent opt-in: `AgentTool` uses the MateBot WebSocket provider only when `isMateBotRemoteConfigured()` (i.e. `MATEBOT_REMOTE_WS_URL` is set); otherwise it errors for `isolation: "remote"` (`src/tools/AgentTool/AgentTool.tsx:573-623`).

### 3.4 Durable task store is forced on

`src/utils/tasks.ts:134-145`: `isTodoV2Enabled()` returns `true` in MateBot mode, including headless/non-interactive sessions. The comment states the control plane always needs a durable task DAG.

### 3.5 Cron is forced on and durable

`src/tools/ScheduleCronTool/prompt.ts:37-43`: `isKairosCronEnabled()` returns `true` in MateBot mode unless `CLAUDE_CODE_DISABLE_CRON` is truthy. `isDurableCronEnabled()` returns `true` at `:63-66`.

### 3.6 Eval/apply

- `eval_apply` is an ordinary, globally registered tool (`src/tools.ts:37,269`) implementing a persistent SICP-style Lisp meta-interpreter keyed by actor address (`src/tools/EvalApplyTool/EvalApplyTool.ts:1-115`). It has no shell/filesystem/tx/rx primitives.
- The coordinator prompt frames it as a composition DSL, **not** the delivery gate (`coordinatorMode.ts:140`; `docs/matebot-swarm-harness.md:50-60`).
- Delivery gating is prompt/role based: independent `evaluator` + Goal/Task evidence.
- `src/matebot/evalApplyLedger.ts:155` implements a durable ledger under `<project>/.matebot/eval-apply`, but **no non-test module imports it**. `grep -rn "evalApplyLedger" src` finds only `src/matebot/*` and tests. Do not build product behavior on that ledger without first wiring it.

### 3.7 Actor tool

`ActorTool` is also globally registered (`src/tools.ts:38,270`), not gated by MateBot mode. It provides `self`, `peers`, `tx`, `rx`, and shared-resource `resource_offer/list/acquire/release` (`src/tools/ActorTool/ActorTool.ts:20-75`).

### 3.8 What does **not** change

- Permissions: `grep -rn "isMateBotModeEnabled" src` returns only the coordinator, prompt, agent-registry, swarm, task and cron sites above. There is no permission-policy gate. User deny rules still apply (also stated in `docs/matebot-swarm-harness.md:36`).
- The tool pool is not narrowed; the coordinator retains all ordinary tools (`coordinatorMode.ts:131-133`).
- No network/bridge is started by the flag.

---

## 4. Requirements to run `--matebot`

### 4.1 Hard requirements

| Requirement | Evidence |
|---|---|
| A built `dist/cli.js` (or source entrypoint) and a `bun` runtime | `opencc_backend.py:50-56,431-435` |
| A working model endpoint/credentials (`ANTHROPIC_*` / settings / OAuth) | inherited by the child; no MateBot-specific credential |
| A writable config dir for transcripts, actor mailboxes and tasks | `CLAUDE_CONFIG_DIR` is honored (`opencc_backend.py:63-73`; `src/actor/LocalActorMailbox.ts:63`) |
| Nothing else | `--matebot` itself only flips in-process gates (section 2) |

No MateBot bridge, Telegram bridge, Feishu bridge or worker process is required for the coordinator to run.

### 4.2 Optional environment variables

| Variable | Effect | Evidence |
|---|---|---|
| `OPENCC_MATEBOT=1` | same as `--matebot` | `src/utils/matebotMode.ts:22-32` |
| `CLAUDE_CODE_DISABLE_CRON` | disables cron even in MateBot mode | `ScheduleCronTool/prompt.ts:39-41` |
| `CLAUDE_CONFIG_DIR` | transcript + local actor mailbox root | `opencc_backend.py:63-73`, `LocalActorMailbox.ts:63` |
| `MATEBOT_ACTOR_ADDRESS` | stable actor address | `src/actor/currentActor.ts:10-11,37` |
| `MATEBOT_ACTOR_TOKEN` / `MATEBOT_REMOTE_TOKEN` | bearer token for remote actor WS calls | `currentActor.ts:45-50` |
| `OPENCC_ACTOR_NETWORKING=0` | disables actor inbox service | `currentActor.ts:32-42` |
| `MATEBOT_REMOTE_WS_URL`, `MATEBOT_REMOTE_TOKEN` | enables `AgentTool isolation:"remote"` | `MateBotRemoteTransport.ts:328-347` |
| `MATEBOT_WORKER_*` | only for the worker entrypoint | `src/entrypoints/matebot-worker.ts:13-27` |
| `OPENCC_CLI_PATH` | CLI resolution override | `opencc_backend.py:194-221` |
| `OPENCC_BUN_PATH`, `OPENCC_MODEL`, `OPENCC_CWD`, `OPENCC_PREWARM`, `OPENCC_SPAWN_MODE` | MateBot bridge config; `opencc_backend` accepts the values as constructor args (`bun_path`, `model`, `cwd`, `start()`), it does not read these names itself | `feishu_bridge.py:535-541,1465-1493` |

Task state goes to `.claude/scheduled_tasks.json` for durable cron (`ScheduleCronTool/prompt.ts:80`); actor mailboxes default to `$CLAUDE_CONFIG_DIR/actors` (`LocalActorMailbox.ts:63`).

---

## 5. Reference spawn backend: `opencc_backend.py`

This is the reference implementation the desktop backend should copy. All citations are `/home/tars/yysapp/MateBot/opencc_backend.py`.

### 5.1 CLI resolution

Order (`:194-221`):

1. explicit `cli_path` argument
2. `$OPENCC_CLI_PATH`
3. `vendor/opencc/dist/cli.js` relative to this module (`:50-56`)
4. `~/.local/share/opencc/cli.js`
5. `~/.opencc/cli.js`

Failure raises `OpenccSpawnError` with every path tried. `DEFAULT_CLI_PATH` is resolved at import and degrades to candidate 0 (`:224-230`).

`bun_path` is validated with `shutil.which()` or an existing file path before spawn (`:431-435`).

### 5.2 Exact argv

`_spawn()` (`:398-429`):

```
<bun> <cli.js>
  --print
  --verbose
  --input-format stream-json
  --output-format stream-json
  --include-partial-messages
  --include-hook-events
  --dangerously-skip-permissions
  --matebot
  [--model <model>]
  [--append-system-prompt <prompt>]
  [--resume <session_id>]
  [<extra_args>...]
```

`--verbose` is mandatory: `src/cli/print.ts:789-795` refuses `--output-format stream-json` without it.

### 5.3 Working directory and environment

- `cwd = cwd or os.getcwd()` (`:274`), passed to `Popen` (`:449-456`).
- Child env = parent env, with `CLAUDE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` removed, and `FORCE_COLOR=0` (`:437-442`). `CLAUDE_CONFIG_DIR` and all model credentials are inherited.
- Streams: stdin/stdout/stderr all `PIPE` (`:449-456`).

### 5.4 Framing

- stdout: one JSON object per line, UTF-8, `\r\n` stripped; blank lines skipped; non-JSON logged to stderr and skipped (`:501-511`).
- stdin: one JSON object per line, explicit `flush()` after each write (`:488-499`).
- Do **not** use `bufsize=0`: the comment at `:446-448` explains `readline()` degenerates to per-byte reads.
- stderr is read line-by-line into a 40-line ring buffer and forwarded to `on_stderr` (`:297,612-617`).

### 5.5 Turn protocol and readiness

- `send(text)` writes `{"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}}` (`:327-345`).
- The process is spawned on first `send()` or eagerly by `start()` (`:316-322,384-396`).
- Prompts sent before the first `system/init` are queued; a drain thread waits up to 60 s for `ready` before writing (`:303-304,476-486`).
- `system/init` sets `ready` (`:521-523`).
- The child stays alive across turns; stdin is not closed between turns. The module docstring at `:10-15` explains that this avoids transcript replay and is load-bearing.
- **Interrupt** sends SIGINT to the child (`:347-353`). There is no per-turn wall-clock timeout.
- `keep_alive` / control frames are accepted by the CLI (`src/cli/structuredIO.ts:349-366`), but this backend does not send them.

### 5.6 `session_id` capture and resume policy

- `session_id` is tracked from every event (`:517-519`), but `on_session_id` is published only after a non-error `result` (`:524-527,543-550`). This prevents a failed startup frame from overwriting a good persisted id.
- Resume gates (`:84-191`):
  - transcript path = `<config dir>/projects/<cwd slug>/<session_id>.jsonl` (`:76-82`);
  - refuse resume if the file is missing/non-regular (`:163-174`);
  - refuse if size >= 25 MiB (`MAX_RESUME_BYTES`, `:94,175-179`);
  - refuse if session age >= 14 days, using the transcript's first record timestamp (`MAX_RESUME_AGE_DAYS`, `:95,116-141,180-185`).
  - A refused resume clears `session_id` and logs the reason (`:417-425`).
- Failed-resume recovery is two-layered:
  1. swallow an early error `result` from a doomed resume (only resumed, no assistant output, within 5 s) (`:552-570`);
  2. if the process exits non-zero in under 25 s while resuming, clear the id and retry once without `--resume`, re-queuing the last prompt (`:246-250,572-604`).
- A later process death is revived in place by the next send, keeping the persisted `session_id` (`:384-396`).

### 5.7 Shutdown

`close()` sets `_closing`, closes stdin, `terminate()`, waits 3 s, then `kill()`, and joins reader threads with a 1 s timeout (`:355-374`). Reader-thread exit calls `on_close(code)` (`:572-604`).

### 5.8 State machine to reimplement

```
UNSPAWNED
  start()/send() -> SPAWNING

SPAWNING
  Popen ok -> WAIT_INIT (pending prompts queued)
  Popen error / bad CLI/bun -> FAILED_SPAWN (raise)

WAIT_INIT
  system/init -> READY, drain pending prompts (max 60 s wait)
  process exit:
    if was resuming and lifetime < 25 s and code != 0
      -> clear session id, re-queue last prompt, SPAWNING (once)
    else -> CLOSED(on_close)

READY
  user frame -> write+flush
  assistant/stream_event/... -> on_event
  result(non-error) -> publish session_id
  early doomed-resume result -> swallow (do not call on_event)
  process exit:
    if was resuming and lifetime < 25 s and code != 0 -> retry clean
    else -> CLOSED(on_close); next send() revives with same object/session_id

CLOSING -> term -> wait 3 s -> kill -> reader threads joined
```

### 5.9 What the Python bridge does on top

- `SessionStore` persists `chat_id -> session_id` atomically under `~/.matecode/sessions/<chat>.json` (`session_store.py:22-81`), validating UUIDs before use (`:26-33`).
- `OpenccSessionRegistry` keeps one process per chat, swaps a renderer per turn but keeps the process, revives dead processes in place, supports prewarm and SIGINT (`feishu_bridge.py:1399-1632`).
- A watchdog rotates/restarts sessions at configured wall-clock times or when RSS exceeds 4 GB (`feishu_bridge.py:1725-1805`). Rotation uses `forget_session=True`; ordinary memory restarts use `--resume` (`:1795-1796`).

---

## 6. Other MateBot connection surfaces

### 6.1 Remote worker WebSocket (execution plane)

Entrypoint: `src/entrypoints/matebot-worker.ts`.

| Property | Value | Evidence |
|---|---|---|
| Default host/port | `127.0.0.1:8787` | `matebot-worker.ts:13,19` |
| Path | `/ws`; `/health` is unauthenticated JSON | `MateBotRemoteWorkerServer.ts:296-316` |
| Protocol version | `v: 1` | `MateBotRemoteTransport.ts:4`; server check `:338-341` |
| Auth | per-frame `"authorization": "Bearer <token>"`, constant-time compare | `MateBotRemoteWorkerServer.ts:69-75,346` |
| Non-loopback without token | refuses to start | `:77-94` |
| Workspace root | `MATEBOT_WORKER_ROOT` or cwd; task cwd must resolve inside it | `:122-135,208-209` |
| Concurrency | default 8 (`MATEBOT_WORKER_CONCURRENCY`) | `matebot-worker.ts:22`; server `:218-221,398-402` |
| Task retention | in-memory, oldest settled evicted above 64 | `:59-60,222-233` |
| Permission mode | `acceptEdits` default | `matebot-worker.ts:24-25,212` |

Client frames (`MateBotRemoteTransport.ts:121-134`):

```
task.start  {v:1, request_id, authorization?, task:{prompt,description,role,cwd?,metadata?}}
task.poll   {v:1, request_id, authorization?, task_id, after}
task.cancel {v:1, request_id, authorization?, task_id}
actor.tx    {v:1, request_id, authorization?, envelope}
actor.rx    {v:1, request_id, authorization?, address, limit}
```

Server frames:

```
task.accepted  {request_id, task_id, title, url, actor_address}
task.snapshot  {request_id, task_id, status, cursor, events[], result?, error?}
task.cancelled {request_id, task_id}
actor.ack      {request_id, envelope_id}
actor.messages {request_id, envelopes[]}
error          {request_id, error}
```

Status values: `queued|running|idle|completed|failed|cancelled` (`MateBotRemoteTransport.ts:6-12`).

Worker spawn behavior (`MateBotRemoteWorkerServer.ts:235-294`):

```
<process.execPath> <cli.tsx>
  --print --verbose
  --output-format stream-json
  --permission-mode <acceptEdits>
  --matebot
```

- The prompt is written as **plain text** to stdin, then stdin is closed (`:266-267`). It is one task per process, not a persistent conversation.
- Env forcibly sets `OPENCC_MATEBOT=1`, `MATEBOT_ACTOR_ADDRESS=ws://127.0.0.1:<port>/ws#remote/<taskId>`, and `MATEBOT_ACTOR_TOKEN` when configured (`:254-259`).
- stdout is parsed as stream-json lines and stored in an in-memory cursor log (`:161-192,270`).
- Client requests time out at 30 s (`MateBotRemoteTransport.ts:240-247`).
- The server has no durable task storage; the coordinator's task graph is the durable layer (`:198-202`).

### 6.2 Actor mailbox / remote actor WS

- Address forms: `actor://team/name`, `name`, `ws(s)://host/ws#team/name` (`src/actor/types.ts:30-70`).
- Local mailbox default root: `join(getClaudeConfigHomeDir(), 'actors')` (`src/actor/LocalActorMailbox.ts:63`); send/receive use file locks and `rx` is an atomic claim (`docs/matebot-actor-protocol.md:16`).
- Envelope: `{v,id,from,to,kind,payload,sentAt,correlationId?,replyTo?,ttlMs?,metadata?}` (`src/actor/types.ts:8-19`).
- Remote WS frames: `actor.tx`/`actor.rx` with `request_id` and optional Bearer token (`docs/matebot-actor-protocol.md:40-48`).
- `ActorWebSocketTransport` opens a new socket per request and closes it after the response (`src/actor/ActorWebSocketTransport.ts:15-74`).

### 6.3 Feishu bridge

- Outbound HTTPS polling only; **no inbound port**. Base `https://open.feishu.cn/open-apis` (`feishu_api.py:37`).
- Auth: `FEISHU_APP_ID` + `FEISHU_APP_SECRET` -> tenant access token, refreshed 30 min before 2 h expiry (`feishu_api.py:43-87`).
- Poll interval default 5 s (`feishu_bridge.py:499,2776+`).
- One long-lived `OpenccSession` per Feishu `chat_id`; same spawn backend and stream-json framing (`feishu_bridge.py:1399-1530`).
- This is a chat HCI adapter, not a service the desktop should call.

### 6.4 Which surface should AutoAgent use?

**Primary (main chat): local child process, not any bridge/worker.**

The desktop backend should spawn and own opencc with the section 5.2 argv, one persistent process per conversation, and speak stream-json over pipes. Reasons:

1. `--matebot` is an in-process CLI mode, not a server protocol.
2. The remote-worker protocol is one-shot task execution (`stdin` closed after the prompt) and loses conversation continuity; it is designed for delegated workers, not the user's chat.
3. Feishu is a separate HCI with its own polling and chat identity; coupling the desktop to it adds an external dependency for no benefit.
4. The reference implementation already encodes the hard parts the desktop needs (readiness, resume, rotation, recovery).

**Secondary (optional remote delegation): client of the worker WS.**

Only when the user wants subagents to execute on another host. Set `MATEBOT_REMOTE_WS_URL` / `MATEBOT_REMOTE_TOKEN`; the coordinator's `AgentTool` then uses `MateBotRemoteTransport` automatically. Do this per-task, not for the main conversation.

**Desktop as worker host: optional, off by default.**

If AutoAgent should accept remote tasks, run `bun src/entrypoints/matebot-worker.ts` (or the built equivalent) bound to `127.0.0.1`, with `MATEBOT_WORKER_TOKEN` whenever the bind address is non-loopback. Do not expose it casually: every accepted `task.start` runs a shell-capable agent with write permissions under the worker root (`MateBotRemoteWorkerServer.ts:79-94,235-267`).

---

## 7. Stream-JSON contract

**Internal wire contract only.** This section is evidence for the adapter implementation (section 8); these frames must not cross the HTTP/SSE boundary.

### 7.1 Input frames (desktop -> CLI stdin)

The union is `StdinMessageSchema = user | control_request | control_response | keep_alive | update_environment_variables` (`src/entrypoints/sdk/controlSchemas.ts:655-662`). `StructuredIO.processLine` enforces `user.message.role === 'user'` (`src/cli/structuredIO.ts:437-462`).

User turn (the shape the reference backend writes; `opencc_backend.py:329-335`):

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Implement X"}]}}
```

Interrupt (alternative to SIGINT):

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}
```

Permission response (only needed if not bypassing permissions):

```json
{"type":"control_response","response":{"request_id":"<id>","subtype":"success","response":{"behavior":"allow","updatedInput":{"...":"..."},"toolUseID":"<tool_use_id>"}}}
```

Keepalive / runtime env update:

```json
{"type":"keep_alive"}
{"type":"update_environment_variables","variables":{"CLAUDE_CODE_SESSION_ACCESS_TOKEN":"..."}}
```

Control subtypes supported by the CLI include `initialize`, `interrupt`, `can_use_tool`, `set_permission_mode`, `set_model`, `set_max_thinking_tokens`, `mcp_status` (`src/entrypoints/sdk/controlSchemas.ts:56-160`).

### 7.2 Output frames (CLI stdout -> desktop)

The full union is `SDKMessageSchema` (`src/entrypoints/sdk/coreSchemas.ts:1854-1880`). The frames that matter to a desktop:

`system/init` (`coreSchemas.ts:1457-1494`; emitted by `src/utils/messages/systemInit.ts:53-95`):

```json
{"type":"system","subtype":"init","cwd":"/work","session_id":"...","tools":["Bash","Read"],
 "mcp_servers":[{"name":"x","status":"connected"}],"model":"...","permissionMode":"default",
 "slash_commands":["..."],"apiKeySource":"...","betas":[],"claude_code_version":"...",
 "output_style":"...","agents":["worker","researcher","planner","builder","evaluator"],
 "skills":["..."],"plugins":[],"uuid":"...","fast_mode_state":"off"}
```

`assistant` final message (`coreSchemas.ts:1347-1356`):

```json
{"type":"assistant","message":{"id":"msg_...","role":"assistant","content":[{"type":"text","text":"..."},{"type":"tool_use","id":"toolu_...","name":"Bash","input":{}}]},"parent_tool_use_id":null,"uuid":"...","session_id":"..."}
```

`stream_event` partial (`coreSchemas.ts:1496-1504`; enabled by `--include-partial-messages`):

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}},"parent_tool_use_id":null,"uuid":"...","session_id":"..."}
```

`user` (tool results and replay) (`coreSchemas.ts:1290-1303`):

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_...","content":"ok","is_error":false}]},"parent_tool_use_id":"...","uuid":"...","session_id":"..."}
```

`result` success (`coreSchemas.ts:1407-1427`):

```json
{"type":"result","subtype":"success","duration_ms":123,"duration_api_ms":100,"is_error":false,"num_turns":2,"result":"final text","stop_reason":"end_turn","total_cost_usd":0.01,"usage":{},"modelUsage":{},"permission_denials":[],"uuid":"...","session_id":"..."}
```

`result` error (`coreSchemas.ts:1428-1455`): same shape, `subtype` in `error_during_execution|error_max_turns|error_max_budget_usd|error_max_structured_output_retries`, `errors: string[]`, no `result`.

`control_request` from CLI (only in permission-prompting modes):

```json
{"type":"control_request","request_id":"...","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{},"tool_use_id":"...","permission_suggestions":[]}}
```

Other frames a desktop UI may render or ignore: `system/compact_boundary`, `system/status`, `system/api_retry`, `system/hook_started|hook_progress|hook_response` (with `--include-hook-events`), `system/tool_progress`, `system/task_started|task_progress|task_notification`, `rate_limit_event`, `auth_status`, `tool_use_summary`, `streamlined_text` (internal), `keep_alive`. They are all part of `SDKMessageSchema` (`coreSchemas.ts:1854-1880`).

### 7.3 Fields the adapter must persist

| Field | Source | Why |
|---|---|---|
| `session_id` | `system/init` and every frame; publish on non-error `result` per `opencc_backend.py:543-550` | `--resume` across restarts |
| `cwd` | init frame + configured workspace | transcript path derivation and remote cwd rules |
| `model`, `permissionMode`, `agents`, `tools`, `skills`, `slash_commands` | init frame | UI capability display and reproducibility |
| `usage`, `modelUsage`, `total_cost_usd`, `duration_ms`, `num_turns`, `stop_reason` | `result` | cost/turn accounting |
| `uuid` / `parent_tool_use_id` | every frame | dedupe, ordering, subagent/thread routing |
| tool events (`assistant.tool_use`, `stream_event.content_block_start`, `user.tool_result`) | assistant/user/stream frames | transcript rendering and audit |
| `permission_denials` | `result` | explain denied tools |
| control `request_id` + responses | control frames | resume-safe permission handling |

Do **not** persist `session_id` from a failed or interrupted first spawn as authoritative; the reference backend waits for a clean `result` (`opencc_backend.py:513-527`).

---

## 8. EnginePort: deep interface and normalized domain events

Hard constraint: the desktop UI/HTTP layer must not consume raw opencc stream-json frames. All opencc-specific knowledge lives behind one **deep interface**, `EnginePort`. This section applies the software-design skill material on information hiding and dependency inversion:

- an ADT/interface should promise behavior, never expose representation (`software-design-skill/references/ch05_抽象数据类型.md:149-188`);
- representation exposure is exactly what makes clients depend on an implementation detail (`ch05:412`);
- high-level modules must depend on abstractions, and details must implement those abstractions (`software-design-skill/references/ch08_设计模式.md:53-62`);
- the concrete CLI adapter is an Adapter in the GoF sense: it translates an incompatible interface into the domain interface (`ch08:417-457`).

### 8.1 Interface (narrow surface, large hidden implementation)

Python form; the TypeScript interface uses the same operations named `startTurn`, `stream`, `cancel`, `status`.

```python
from typing import Protocol, AsyncIterator
from dataclasses import dataclass
from typing import Literal

TurnId = str
ConversationId = str
EventId = str

@dataclass(frozen=True, slots=True)
class StartTurn:
    conversation_id: ConversationId
    text: str
    # Optional domain inputs only; never CLI flags or transport options.
    workspace: str | None = None

@dataclass(frozen=True, slots=True)
class EngineStatus:
    state: Literal["stopped", "starting", "ready", "busy", "degraded"]
    conversation_id: ConversationId | None
    model: str | None
    active_turn_id: TurnId | None
    last_error: str | None          # sanitized, see 8.6

class EnginePort(Protocol):
    async def start_turn(self, request: StartTurn) -> TurnId: ...
    def stream(self, turn_id: TurnId) -> AsyncIterator["DomainEvent"]: ...
    async def cancel(self, turn_id: TurnId) -> None: ...
    def status(self) -> EngineStatus: ...
```

Depth check: four public operations hide CLI resolution, argv/env construction, `--matebot`, `--resume`, readiness gating, pending-prompt queueing, the early-exit/resume retry state machine, process revival, transcript rotation, SIGINT, stderr capture, NDJSON parsing, frame deduplication and error translation. The reference implementation of that hidden machinery is `opencc_backend.py:233-617`; the UI sees none of it.

### 8.2 ADT contract (AF / RI)

Abstract value: an ordered stream of observable conversation effects for one turn.

- **AF**: a `DomainEvent` sequence denotes what the user/UI can observe — streamed text, tool activity, final outcome and cost — for one `turn_id`, with all transport/process detail erased.
- **RI** (must hold for every event the adapter emits):
  1. `event_id`, `conversation_id`, `turn_id`, `seq`, `occurred_at` are non-empty; `seq` is strictly increasing within a turn.
  2. A turn has `turn.started` first and exactly one terminal event (`turn.completed | turn.failed | turn.cancelled`).
  3. Every `tool.finished` has a preceding `tool.started` with the same `tool_call_id`; no tool finishes twice.
  4. `usage` appears at most once per turn and before the terminal event when the engine reports it.
  5. No event contains raw SDK/stream-json frames, `control_*` envelopes, PIDs, argv, file paths to transcripts, or `session_id`.
  6. All timestamps are UTC ISO-8601; all textual payloads are already sanitized by the adapter.

These invariants are the adapter's postconditions; they are testable with recorded fixtures and a fake `EnginePort` (ch05:445-447 shows the homomorphism/property-testing approach for exactly this kind of contract).

### 8.3 Normalized event envelope and variants

Every event is a flat JSON object with the same envelope. `type` is the discriminator the SSE/UI layer switches on.

```json
{
  "event_id": "evt_...",
  "conversation_id": "conv_...",
  "turn_id": "turn_...",
  "seq": 17,
  "occurred_at": "2026-10-17T12:00:00.000Z",
  "type": "text.delta"
}
```

Required variants:

```json
{"type":"turn.started","model":"...","workspace":"/work"}
{"type":"text.delta","text":"Hello","block_index":0}
{"type":"tool.started","tool_call_id":"toolu_...","name":"Bash","input":{"command":"ls"},"input_truncated":false}
{"type":"tool.finished","tool_call_id":"toolu_...","name":"Bash","status":"ok","output":"...","output_truncated":false,"duration_ms":42}
{"type":"usage","input_tokens":123,"output_tokens":45,"cache_read_tokens":0,"cache_write_tokens":0,"total_cost_usd":0.0012,"model":"...","model_usage":{}}
{"type":"turn.completed","message":"final text","stop_reason":"end_turn","model":"..."}
{"type":"turn.failed","code":"engine_error","message":"sanitized reason","retryable":true,"detail_ref":"eng_err_..."}
{"type":"turn.cancelled","reason":"user"}
```

`turn.cancelled` is added to the requested set because `cancel()` is part of `EnginePort` and cancellation is neither success nor failure. Optional variants (`turn.status`, `usage.warning`, `diagnostic`) may be added behind the same envelope; they must not require UI changes to existing types.

Common correlation fields:

| Field | Purpose |
|---|---|
| `event_id` | idempotency / dedupe on reconnect |
| `conversation_id` | conversation scope |
| `turn_id` | turn scope; all events of one turn share it |
| `seq` | total order within the turn |
| `occurred_at` | UI ordering/telemetry |
| `tool_call_id` | join `tool.started` to `tool.finished` |
| `parent_tool_call_id` | optional subagent/worker nesting |

### 8.4 Raw frame -> domain event mapping

Raw frame names and schemas are cited in section 7. The adapter is the only module allowed to read them.

| Raw opencc frame | Emitted domain event | Rule |
|---|---|---|
| `system/init` (`coreSchemas.ts:1457-1494`) | none | Adapter stores `session_id`, `model`, `cwd`, capabilities internally; it may update `EngineStatus` but never forwards the frame. |
| `stream_event` / `content_block_delta` / `text_delta` (`coreSchemas.ts:1496-1504`) | `text.delta` | Preferred streaming path. One delta per raw delta. |
| `stream_event` / `content_block_start` / `tool_use` | `tool.started` | Emitted as soon as the tool block opens; dedupe by `content_block.id`. |
| `assistant` `tool_use` block (`coreSchemas.ts:1347-1356`) | `tool.started` (fallback) | Only if partial messages are unavailable or the id was not already seen; first wins. |
| `assistant` `text` block | `text.delta` (fallback only) | If any `stream_event` text was seen for the turn, do **not** re-emit the assistant text (prevents double rendering). |
| `user` `tool_result` block (`coreSchemas.ts:1290-1303`) | `tool.finished` | `status = is_error ? "error" : "ok"`; join by `tool_use_id`. |
| `result` success (`coreSchemas.ts:1407-1427`) | `usage`, then `turn.completed` | Use `usage`, `modelUsage`, `total_cost_usd`, `duration_ms`, `stop_reason`, `result`. If no text was emitted at all, emit one `text.delta` from `result` before completing. |
| `result` error (`coreSchemas.ts:1428-1455`) | `usage` (if present), then `turn.failed` | Map `subtype`/`errors` per 8.5. |
| `control_request` `can_use_tool` (`controlSchemas.ts:578-584`) | none by default; optional `permission.requested` | With the recommended bypass/accept policy the adapter answers internally. If the product later adds approvals, expose a domain event, never the raw control envelope. |
| `system/status` (compacting), `system/compact_boundary` | optional `turn.status` | UI may show a compaction indicator; no raw metadata. |
| `rate_limit_event` | `usage.warning` / `EngineStatus.degraded` | Do not leak provider-specific rate-limit structures. |
| `system/hook_*`, `system/task_*`, `system/tool_progress`, `auth_status`, `tool_use_summary` | optional `diagnostic` | Kept off the core event stream; rendered only if the UI opts in. |
| `keep_alive` | none | Heartbeat only. |
| process exit before `result` | `turn.failed` (`engine_crashed`) | Synthesize a terminal event; close any open tools as `cancelled`. |
| CLI/bun resolution or spawn failure | `turn.failed` (`engine_unavailable`) | Sanitized message; retry policy stays inside the adapter. |
| doomed `--resume` error result (`opencc_backend.py:552-570`) | none | Swallowed and retried invisibly; the UI sees only the clean retry. |
| unknown/unparseable line | none + internal log | Emit `turn.failed` (`protocol_error`) only if the turn cannot continue; never forward the line. |

Text canonicalization rule: the adapter picks **one** text source per turn — stream deltas when present, otherwise assistant blocks, otherwise `result.result`. It must not concatenate all three.

Tool lifecycle rule: on terminal failure/cancel, the adapter synthesizes `tool.finished` with `status: "cancelled"` for every open `tool_call_id` before the terminal event, preserving RI 3.

### 8.5 Error code mapping

| Raw condition | Domain `code` | `retryable` |
|---|---|---|
| `result.subtype == "error_during_execution"` | `engine_error` | depends; default `true` |
| `error_max_turns` | `max_turns_reached` | false |
| `error_max_budget_usd` | `budget_exceeded` | false |
| `error_max_structured_output_retries` | `invalid_output` | false |
| assistant `error` = `authentication_failed` / `billing_error` | `model_auth` / `model_billing` | false |
| assistant `error` = `rate_limit` | `model_rate_limit` | true |
| assistant `error` = `server_error` / `unknown` | `model_unavailable` | true |
| assistant `error` = `max_output_tokens` | `model_output_limit` | true |
| process died before `result` | `engine_crashed` | true |
| CLI/bun missing or unspawnable | `engine_unavailable` | false until config changes |
| user cancel | `turn.cancelled` (not `turn.failed`) | n/a |
| unparseable stdout / protocol violation | `protocol_error` | true |

`detail_ref` points to an internal diagnostic record (stderr tail, spawn count, exit code). The raw detail stays in logs; the HTTP body only carries the sanitized code/message.

### 8.6 What must stay hidden from the HTTP API, and why

| Hidden detail | Why it must not cross the boundary |
|---|---|
| CLI path, bun path, `--matebot`, `--resume`, `--append-system-prompt`, `--model`, `--permission-mode`, `--dangerously-skip-permissions`, `--include-partial-messages`, extra args | These are representation. Exposing them makes the API contract change whenever the engine changes and lets untrusted clients alter security-relevant behavior (ch05:412; ch08:57-62). |
| `session_id`, transcript path, `CLAUDE_CONFIG_DIR` | Resume authority and conversation history location. Exposing them enables session fixation/forgery and leaks user filesystem layout. Persist and use them only inside the adapter. |
| Raw stream-json frames and their schema (`system/init`, `stream_event`, `result`, `control_request`) | Coupling the UI/HTTP contract to a reverse-engineered CLI wire format makes every upstream bump a breaking API change. The adapter is the only anticorruption layer. |
| `control_request` / `control_response`, permission suggestions, `tool_use_id` envelopes | Permission protocol is a CLI host concern. The API exposes the policy outcome (`permission_denied` / `tool.finished` status), not the negotiation. |
| Process PID, exit code, spawn count, restart/retry counters, ready-gate state, pending queue length | Operational internals; useful for logs and `EngineStatus`, not for API clients. Exposing them encourages clients to depend on scheduling behavior. |
| Resume rotation thresholds (25 MiB / 14 days), early-exit window (25 s), resume-failure window (5 s) | Policy that must be tunable without changing clients. |
| `stderr` text, argv dumps, environment, API keys, base URL, tokens | Sensitive data and paths. Only sanitized error codes/messages may leave. |
| Actor mailbox paths, worker URL/token, remote WS protocol details | Separate security domains; expose them only as opt-in configuration, never through turn events. |
| `uuid`, `parent_tool_use_id`, `total_cost_usd` in raw form | Replaced by domain correlation IDs and the `usage` event with a stable schema. |

This is information hiding in the ADT sense: clients depend on the abstract event algebra and four operations, not on the concrete wire protocol. It is also dependency inversion: the UI layer imports `EnginePort`, and `OpenccStreamJsonAdapter` (plus a fake in tests) implements it.

### 8.7 HTTP/SSE shape

```
POST /api/conversations/{conversation_id}/turns
  {"text": "..."} -> 202 {"turn_id": "...", "events_url": "/api/turns/{turn_id}/events"}

GET /api/turns/{turn_id}/events        # SSE; event: <domain type>, data: <DomainEvent JSON>
POST /api/turns/{turn_id}/cancel       # 202
GET /api/engine/status                 # EngineStatus (sanitized)
```

The SSE payload is exactly the normalized event. The browser never sees `--matebot`, `--resume`, raw frames, process state or `session_id`.

### 8.8 Adapter responsibilities and test seam

`OpenccStreamJsonAdapter implements EnginePort` owns:

1. one persistent process per conversation and the readiness gate (`opencc_backend.py:476-486`);
2. argv/env/CLI resolution and `--resume` policy (`:194-221,398-456,417-428`);
3. the retry/restart state machine (`:552-604`);
4. NDJSON parsing, frame dedupe and normalization (this section);
5. internal `session_id` persistence and rotation, never exposed;
6. sanitized diagnostics.

Tests should inject a fake `EnginePort` into the HTTP layer and feed recorded NDJSON fixtures into the real adapter. Assert the section 8.2 RI properties, including: exactly one terminal event; no `tool.finished` without `tool.started`; monotonic `seq`; no forbidden keys (`session_id`, `uuid`, `request`/`response`, `cli`, `argv`, `pid`) in any emitted event.

---

## 9. Recommendation

### 9.1 Chosen connection model

```
Renderer (HTTP/SSE)
  <- DomainEvent only (section 8.3)
  <- EnginePort (startTurn/stream/cancel/status)
desktop backend
  -> EnginePort implementation: OpenccStreamJsonAdapter
    -> SessionManager (one OpenccSession per conversation)
      -> persistent child: bun dist/cli.js ... --matebot
         stdin/stdout: NDJSON stream-json (hidden)
         stderr: ring buffer / log (hidden)
         cwd: workspace, env: inherited + CLAUDE_CONFIG_DIR
         resume: persisted session_id, gated by 25 MiB / 14 days (hidden)
  -> optional: MateBotRemoteTransport -> remote worker WS
```

The renderer and HTTP contract depend only on `EnginePort` and `DomainEvent`; the adapter imports `opencc_backend`-equivalent machinery and is the only place that knows stream-json exists (section 8.6).

The desktop should be a **coordinator host**, not a worker host, by default. It owns the main conversation and local subagents. Remote workers are opt-in per environment.

### 9.2 Exact engine argv

```
<bun> <dist/cli.js>
  --print --verbose
  --input-format stream-json
  --output-format stream-json
  --include-partial-messages
  --include-hook-events
  --dangerously-skip-permissions
  --matebot
  [--model <model>]
  [--append-system-prompt <prompt>]
  [--resume <uuid>]
```

Notes for the current AutoAgent code:

- `src/engine-client.ts:395-444` already builds most flags but never adds `--matebot`, and it appends `--permission-mode default` while the resolved default command already contains `--dangerously-skip-permissions` (`src/runtime-paths.ts:124-127`). Pick one permission source before enabling MateBot mode.
- `src/engine-client.ts:366,386` closes stdin and kills the process after every query, which contradicts the "one process per chat" requirement. Move to a long-lived session object (or make `server.ts` the transport) before relying on coordinator continuity.
- `src/main.ts:1946-1948` already persists `session_id` from `result`; keep that behavior and add the resume-rotation gates.

### 9.3 Environment

- Always inherit the parent env, but strip `CLAUDE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and set `FORCE_COLOR=0` (reference behavior, `opencc_backend.py:437-442`).
- Set `CLAUDE_CONFIG_DIR` to the desktop's app config dir (`~/.autoagent` today, `src/engine-client.ts:446-451`). Transcripts, actor mailboxes and the resume lookup all depend on it.
- No `MATEBOT_*` variable is required for a local coordinator.
- Remote delegation only: `MATEBOT_REMOTE_WS_URL`, `MATEBOT_REMOTE_TOKEN`.

### 9.4 Top risks

1. **Per-query process churn**: current `EngineClient` kills the process after each turn; coordinator mode loses worker context and incurs cold start. Fix before shipping.
2. **Permission conflict**: `--dangerously-skip-permissions` (from settings command) plus `--permission-mode` may conflict and changes the security posture. Choose one explicit policy.
3. **The eval/apply ledger is dead code**: `src/matebot/evalApplyLedger.ts` has no consumers. The "quality gate" is prompt + evaluator agent only.
4. **Remote worker is one-shot and in-memory**: don't use it for the user's main chat; tasks vanish on worker restart and there is no durable cursor.
5. **Resume bloat**: without the 25 MiB / 14 day gates, long-lived chats can inflate RSS and stall startup (`opencc_backend.py:85-95`).
6. **Actor networking defaults on**: `OPENCC_ACTOR_NETWORKING` defaults to enabled (`currentActor.ts:23-43`). Confirm that is desired for desktop sessions.
7. **Worker security**: a non-loopback worker without a token refuses to start; do not weaken that guard. Every task is remote execution under the worker root.
8. **Representation leakage**: the existing `EngineClient` exposes mapped CLI-ish event types (`tool_start`, `text_delta`, `interrupted`) directly to `main.ts` (`src/engine-client.ts:244-283`). Route these through `EnginePort`/`DomainEvent` instead of growing the raw mapping table in the UI.

---

## 10. Handoff summary

- **Connection model**: local persistent child process per conversation, NDJSON stream-json over pipes; desktop acts as coordinator. Remote worker WS only for explicitly delegated remote agents. Feishu bridge is unrelated to the desktop transport.
- **Deep interface**: UI/HTTP depends only on `EnginePort` (`startTurn`/`stream`/`cancel`/`status`) and the normalized `DomainEvent` set in section 8.3; raw stream-json, argv, resume, retries and process state stay inside the adapter.
- **Engine argv**: section 9.2; `--matebot` plus `--print --verbose --input-format stream-json --output-format stream-json --include-partial-messages --include-hook-events --dangerously-skip-permissions`, optional `--model`, `--append-system-prompt`, `--resume`.
- **Engine env**: inherit; scrub `CLAUDE_SESSION_ID`/`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`; `FORCE_COLOR=0`; set `CLAUDE_CONFIG_DIR`. No required `MATEBOT_*`.
- **Raw contract (internal only)**: input `user` + control envelopes; output `system/init`, `assistant`, `user` (tool results), `stream_event`, `result`, control requests and telemetry frames. The adapter persists `session_id`, model/usage and tool lifecycle internally and emits `text.delta`, `tool.started`, `tool.finished`, `usage`, `turn.completed`, `turn.failed` (plus `turn.cancelled`) externally.
- **Opencc update**: see `opencc-delta.md`; AutoAgent's copy is upstream `f04b76d` plus 19 local deviations, while MateBot vendors `4c83c36` plus an uncommitted MemoryTool patch. Selective three-way merge, not a blind replacement.
