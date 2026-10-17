# PM Ledger Note — Backend Stack Decision

Date: 2026-10-17
Author: Blueprint
Decision status: implemented and evaluated; recorded for the PM ledger
Full rationale: `architecture.md` §2; result: `evaluation.md`

## Decision

Adopt **FastAPI + uvicorn + Pydantic v2** for the local backend HTTP adapter.
The application core remains framework-independent (no FastAPI/SQLite/subprocess
imports in `domain/` or `application/`). Use **SQLite (WAL)** as the single
writer. The default engine is **`MateBotEngine`**, which loads the vendored
`vendor/matebot/opencc_backend.py` `OpenccSession` by path and keeps **one
persistent `--matebot` child per conversation**; `SubprocessEngine` is the
fallback and `FakeEngine` is for tests/demos.

Paths: backend default data dir `~/.autoagent`; desktop userData
`${XDG_CONFIG_HOME:-~/.config}/autoagent`; AutoAgent engine config
`~/.autoagent/settings.json` (`AUTOAGENT_CONFIG_DIR` override). Configuration
follows `config-precedence.md`.

## Why (short)

1. The frozen API contract is already expressed as Pydantic DTOs; stdlib would
   duplicate validation, serialization, error mapping and SSE framing.
2. Typed request validation at the boundary (422 before the handler), OpenAPI
   for frontend type generation, and `TestClient`/`httpx` integration tests.
3. SSE is a first-class `StreamingResponse`; the stdlib alternative requires
   hand-written chunking, disconnect detection and thread shutdown.
4. MaxWire's stdlib backend optimizes for zero dependencies on factory
   machines; this project optimizes for a typed, layered domain and parallel
   frontend/backend implementation. The MaxWire *shape* (thin shell, health,
   port negotiation, SPA) is preserved.
5. Reusing the vendored `OpenccSession` keeps the proven spawn/readiness/resume
   behavior instead of reimplementing it; the adapter isolates it behind
   `EnginePort`.

## Costs accepted

- ~10 transitive runtime packages, pinned by `backend/uv.lock`.
- Nuitka packaging is proven (`scripts/build-backend.sh`), but the backend
  binary is **not byte-reproducible** ([eval §B]). Verify semantics, not hashes.
- Vendored `OpenccSession` surface coupling: update `vendor/matebot` with the
  documented rsync and re-run the `--matebot` smoke test.
- FastAPI and Nuitka are installed through `uv` only; no global `pip install`.

## Consequences

- Python 3.12, uv 0.11.28; `uv sync --frozen` is the only install path.
- CI enforces the framework-free core with import-linter.
- The HTTP layer is replaceable in one adapter module without touching services.
- SSE uses a sync generator in `StreamingResponse`; the engine turn is drained
  by a `TurnRunner`, so a disconnected client cannot corrupt persistence.
- The packaged `AUTOAGENT_LEGACY=1` rollback is currently P1-broken
  ([eval §Findings P1]); do not delete legacy source until it is fixed.

## Evidence

- `docs/matebot-modernization/api-contract-v1.md` §3, §5.
- `docs/matebot-modernization/maxwire-model.md` §1–§5.
- `~/.claude/skills/software-design-skill/references/ch09_Python_Web应用开发.md`
  lines 95–105, 159–192, 255–373 (specification as types, layering, DI).
- Environment: Python 3.12.3, uv 0.11.28; FastAPI and Nuitka are installed via
  `uv` (`backend/uv.lock`), not system-wide.
- Implemented result: `backend/` + `desktop/` + `frontend/`; independent
  evaluation in `docs/matebot-modernization/evaluation.md` (P0 pass, P1
  packaged rollback, P2 Nuitka non-determinism / 36 routes).

## Coordinator action

Copy this note into the PM ledger as an architecture decision. Do not call
`pm-tool` from this task.
