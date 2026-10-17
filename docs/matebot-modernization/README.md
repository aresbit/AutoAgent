# MateBot Modernization — Documentation Index

Status as of 2026-10-17: **implemented, packaged, and independently verified.**
The final artifact is `release/autoagent_0.8.0_amd64.deb` (SHA256
`b0933a6b402d973bbaa16c78fe4532681b4522e8aa0384e9719f9bb2479a3a35`). The
independent evaluation passes all P0 gates with no P0/P1; the packaged legacy
entry now fails fast with a reinstall instruction instead of hanging. Root-only
install/upgrade/remove and a real-model soak remain unverified.

## Read in this order

| Document | What it answers |
|---|---|
| [architecture.md](architecture.md) | As-built stack, process lifecycle, module layout, ports (including `MateBotEngine`), turn state machine, persistence, security, deep-interface checklist, implemented deviations |
| [implementation-plan.md](implementation-plan.md) | M1–M7 tasks, owners, acceptance commands, rollback, parallelization, v1 scope freeze, M7 result |
| [config-precedence.md](config-precedence.md) | Model/credential/base-URL precedence: desktop override > Claude settings > AutoAgent settings > process env > default |
| [evaluation.md](evaluation.md) | M7 independent evaluation: P0 pass table, P1/P2 findings, unverified gates |
| [api-contract-v1.md](api-contract-v1.md) | Frozen HTTP/SSE surface and DTOs |
| [recon-matebot.md](recon-matebot.md) | Evidence for `--matebot`, argv, persistent child, stream-json, resume |
| [opencc-delta.md](opencc-delta.md) | Provenance of the vendored opencc and the selective three-way merge procedure |
| [legacy-inventory.md](legacy-inventory.md) | Legacy IPC/feature inventory and migration boundary |
| [maxwire-model.md](maxwire-model.md) | Reference desktop/backend patterns extracted from MaxWire |
| [pm-ledger-note.md](pm-ledger-note.md) | One-page stack decision for the PM ledger |

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
  `vendor/README.md`; update opencc with the three-way merge in
  `opencc-delta.md`.
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
