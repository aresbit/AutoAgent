# MateBot Modernization — Documentation Index

Status as of 2026-10-19: **implemented, packaged, and independently verified.**
The final artifact is `release/autoagent_0.8.0_amd64.deb` (SHA256
`9997eb352629203e0114015dafc85c9bbcaef1ec09e58a73bf934eb60be1824a`). It
includes M5.1 artifacts, M5.2 tool bridge/diff/split/native window, the
integrated terminal T0 (stdlib PTY + WebSocket + xterm), the workspace file
browser T0 (`SafeFileService` + Files tab), the browser preview T0
(`WebContentsView` + fixed IPC + Preview tab), the persistent MCP runtime
T0 (one session per server, status/logs/resources/prompts, approval policy),
and the first highlights tranche (versioned event envelope + delivery gate,
startup/quit timelines, support bundle, boot placeholder).
The packaged legacy entry fails fast with a reinstall instruction. Root-only
install/upgrade/remove, a real-model soak, engine-owned MCP turns (T2), the
PTY supervisor and turn-level outbox, and the full subprocess PTY replacement
(fork-in-uvicorn risk) remain open.

## Read in this order

| Document | What it answers |
|---|---|
| [architecture.md](architecture.md) | As-built stack, process lifecycle, module layout, ports (including `MateBotEngine`), turn state machine, persistence, security, deep-interface checklist, implemented deviations |
| [implementation-plan.md](implementation-plan.md) | M1–M7 tasks, owners, acceptance commands, rollback, parallelization, v1 scope freeze, M7 result |
| [config-precedence.md](config-precedence.md) | Model/credential/base-URL precedence: desktop override > Claude settings > AutoAgent settings > process env > default |
| [evaluation.md](evaluation.md) | M7 independent evaluation: P0 pass table, P1/P2 findings, unverified gates |
| [api-contract-v1.md](api-contract-v1.md) | Frozen HTTP/SSE surface and DTOs |
| [recon-matebot.md](recon-matebot.md) | Evidence for `--matebot`, argv, persistent child, stream-json, resume |
| [opencc-update/REPORT.md](opencc-update/REPORT.md) | Current vendored-opencc update (2.1.888, MateBot HEAD `0ed706d`), local deviations, build/test evidence |
| [opencc-delta.md](opencc-delta.md) | Historical provenance and the original selective three-way merge procedure (stale base) |
| [legacy-inventory.md](legacy-inventory.md) | Legacy IPC/feature inventory and migration boundary |
| [maxwire-model.md](maxwire-model.md) | Reference desktop/backend patterns extracted from MaxWire |
| [pm-ledger-note.md](pm-ledger-note.md) | One-page stack decision for the PM ledger |
| [filesystem/](filesystem/HANDOFF.md) | Claude Desktop file-system recon and the applied T0 reference |
| [browser/](browser/HANDOFF.md) | Claude Desktop preview recon and the applied T0 reference |
| [terminal/](terminal/HANDOFF.md) | Claude Desktop terminal recon and the applied T0 reference (stdlib PTY + xterm) |
| [mcp/](mcp/HANDOFF.md) | Claude Desktop MCP recon, mcp-fs comparison, and the AutoAgent persistent-MCP reference |
| [highlights/](highlights/OVERVIEW.md) | Cross-cutting Claude Desktop design highlights: security, observability, orchestration, UX, with borrow ratings |

## Decisions at a glance

- **Desktop:** Electron thin shell + local Python backend + static React SPA.
- **Backend:** FastAPI + uvicorn + Pydantic v2, framework-independent core.
- **Engine:** **`MateBotEngine` is the default `EnginePort`.** It loads
  `vendor/matebot/opencc_backend.py` `OpenccSession` by path (`importlib`) and
  owns one persistent `--matebot` child per conversation, with max-4 LRU,
  cancel synthesis, ref persistence and death/recreate. `SubprocessEngine` is
  the fallback; `FakeEngine` is for tests/demos.
- **Vendoring:** `vendor/matebot/` at upstream `c0deb163` (core code only);
  `vendor/opencc -> packages/opencc`; built CLI at
  `packages/opencc/dist/cli.js`. Update MateBot with the rsync in
  `vendor/README.md`; update opencc with the procedure and evidence in
  `opencc-update/REPORT.md` (current: 2.1.888, MateBot HEAD `0ed706d`; the
  older `opencc-delta.md` has a stale base).
- **Paths:** data/state stay XDG (`${XDG_CONFIG_HOME:-~/.config}/autoagent`);
  the engine fallback config is independent at `~/.autoagent/settings.json`
  (`AUTOAGENT_CONFIG_DIR` override).
- **Configuration:** desktop override > Claude `settings.json` >
  `~/.autoagent/settings.json` > process env > default; credentials Claude >
  AutoAgent > env; secrets never serialized.
- **Persistence:** SQLite (WAL), sole writer, `autoagent-v2.db`; legacy data
  imported read-only.
- **Frontend:** React 19 + TypeScript + Vite + Tailwind 3.4.19 + shadcn/ui,
  Claude Design System tokens and spring motion.
- **Security:** loopback only, per-launch token (`?token=` → HttpOnly cookie),
  Origin check, no shell interpolation, one permission source.
- **Packaging:** `/opt/autoagent/{desktop,backend,engine,frontend,vendor/matebot}`;
  the launcher exports `AUTOAGENT_MATEBOT_VENDOR_DIR`; the backend defaults to
  `matebot`; `--runtime-check` reports `matebotVendorExists`.
- **Workspace files:** `SafeFileService` is the only filesystem adapter; the
  SPA sends a root id plus a relative path and never sees an absolute path.
  Writes are atomic with SHA-256 CAS; symlinks are refused; limits are 2 MiB
  read / 1 MiB write by default. `AUTOAGENT_FILES=0` omits the routes.
- **Preview:** `PreviewManager` owns one `WebContentsView` per tab in a
  dedicated partition. The origin allowlist is empty by default
  (`AUTOAGENT_PREVIEW_ORIGINS`), local roots are opt-in
  (`AUTOAGENT_PREVIEW_ROOT`), and `AUTOAGENT_PREVIEW=0` fails closed.
- **MCP:** `McpConnectionManager` owns one persistent session per server over
  stdio / Streamable HTTP / legacy SSE. `SqliteMcpRegistry` keeps SQLite as the
  source of truth; `AUTOAGENT_MCP_PERSISTENT=0` restores the short-lived client.
  Destructive tools require process-local approval; engine turns do not yet
  consume these servers (T2).
- **Rollback:** `AUTOAGENT_LEGACY=1` in development. In the package it fails
  fast with a clear message; to roll back, reinstall the previous `.deb`.

## Verified environment

| Tool | Version / status |
|---|---|
| Ubuntu | 24.04 |
| Python | 3.12.3 |
| uv | 0.11.28; `backend/uv.lock` committed |
| Bun | 1.3.13 |
| Node | 18.19.1 |
| FastAPI | installed via `uv sync --frozen` |
| Nuitka | installed as a build dependency; standalone backend built |

## Milestones

| Milestone | Outcome | Status |
|---|---|---|
| M1 | opencc `--matebot` synced; vendored MateBot; backend skeleton + health | done |
| M2 | `MateBotEngine` default, SSE turn, cancel, recovery, SQLite, config precedence | done |
| M3 | Electron thin shell + dev run + legacy switch | done |
| M4 | Modern chat UI | done |
| M5 | Parity panels (skills/MCP/workspace/artifacts) | done |
| M6 | Nuitka `.deb`, X11/Wayland | done; backend binary non-deterministic |
| M7 | Independent evaluation | done; P0 pass, P1 rollback, unverified root install/soak |
| M5.1 | Artifacts: materialization, immutable versions, safe frame | done |
| M5.2 | Artifact tool bridge/consent, diff/split, native window | done |
| T0 | Integrated terminal: stdlib PTY + WebSocket + xterm | done; fork-in-uvicorn risk noted |
| F0 | Workspace files: root-scoped `SafeFileService`, atomic writes/CAS, Files tab | done; update/reveal routes retry |
| P0 | Browser preview: `WebContentsView`, fixed IPC, `autoagent-preview://`, Preview tab | done; empty origin allowlist by default |
| M0 | Persistent MCP runtime: one session per server, status/logs/resources/prompts, approval | done; engine-owned turns are T2 |
| O0 | Highlights tranche 1: event envelope/gate, startup/quit timelines, support bundle, boot placeholder | done; PTY supervisor and turn outbox remain |

## First commands

```bash
cd /home/tars/yysapp/AutoAgent

# Backend gates
cd backend
uv sync --frozen
uv run pytest -q
uv run ruff check src tests
uv run mypy src
uv run lint-imports

# Runtime check: default engine is matebot; vendor resolves
AUTOAGENT_MATEBOT_VENDOR_DIR="$PWD/../vendor/matebot" \
AUTOAGENT_BUN_PATH="$(command -v bun)" \
AUTOAGENT_OPENCC_CLI_PATH="$PWD/../packages/opencc/dist/cli.js" \
  uv run python -m autoagent_backend --runtime-check

# Dev app
cd ..
bun run build:modern
bun run dev:modern

# Rollback (development)
AUTOAGENT_LEGACY=1 bun run dev:legacy

# Package
bash scripts/build-backend.sh
bash scripts/build-deb.sh
bash scripts/smoke-packaged.sh
```

## Open items before legacy deletion

1. Run a root `dpkg -i` / upgrade / remove and the installed setuid sandbox on a
   disposable Ubuntu 24.04 machine.
2. Run a real-model engine turn and the 8 h / 200-turn soak.
3. Accept the Nuitka non-determinism and the 42-route deviation
   (`architecture.md` §11.1).

## Residual risks

1. Nuitka backend non-determinism.
2. Root install/upgrade/remove unverified.
3. Vendored `OpenccSession` surface coupling on rsync updates.
4. Long-run/real-model behavior and actor networking.
