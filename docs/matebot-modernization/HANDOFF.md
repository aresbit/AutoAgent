# Handoff — AutoAgent MateBot / Artifacts

Last updated: 2026-10-17

## Durable state (survives an OpenCC restart)

| State | Location |
|---|---|
| PM ledger | `pm_matebot_charter.md`, `pm_decisions.md` |
| SE ledger | `task_plan_matebot.md` |
| Architecture/plan/eval | `docs/matebot-modernization/` |
| Team actor mailboxes | `~/.claude/actors/autoagent-matebot-modernization/` |
| Reusable skills | `~/.claude/skills/matebot-opencc-desktop/`, `electron-linux-packaging/`, `modern-c-makefile/` |
| Build entry | `Makefile` (`make help`) |
| Artifact | `release/autoagent_0.8.0_amd64.deb` |

The actor mailbox files preserve each member's message history. The team config
itself is session-scoped: after an OpenCC restart, run `TeamDelete`, then
`TeamCreate` with the same name, and respawn the same member names
(`connectors`, `gallery-2`, `shell`, `packager`, `verifier`). Point them at this
file + the ledgers. The live LLM contexts/processes are not durable, but no
code/ledger state is lost.

## Current milestone

M5.1 Artifacts:

- P0: materialization, immutable `v<N>` versions + manifest (`sha256`, `uri`,
  `mimeType`, `current`), versions/restore/verify, SSE order
  `message.completed → artifact.created|updated → turn.completed`, safe
  `ArtifactFrame`, chat card, panel versions, `/api/events` refresh.
- P1: CSP-independent artifact frame endpoint:
  `POST /api/artifacts/{id}/frame-token` → short-lived HMAC URL;
  `GET /api/artifacts/{id}/frame?version&exp&sig` → artifact HTML with its own
  CSP + injected resize reporter. `HEAD` is supported. Frame URL never carries
  the launch token. The panel uses `iframe src`; the chat card keeps a static
  `srcDoc` preview.
- Verified locally: backend **226 pytest**, frontend **71 Vitest**, typecheck,
  build; live frame GET/HEAD 200 + CSP, tamper/expiry 401.
- Deferred: MCP tool bridge/consent, custom-protocol artifact child window,
  diff/split, export UI (P1); A2UI subset (P2).

## Next steps

1. Rebuild the `.deb` with the frame endpoint (the current artifact mtime is
   before that fix): `bash scripts/build-deb.sh`, then
   `bash scripts/smoke-packaged.sh`.
2. Independent Verifier re-check: packaged frame-token/frame, CSP, panel
   interaction, resize, no token leak, X11/Wayland.
3. Update `evaluation.md`/`delivery.md` and commit/push the M5.1 work.
4. Deferred P1/P2 as above.

## Notes

- Data/state use XDG; the engine fallback config is `~/.autoagent/settings.json`.
- Engine default is `matebot`; vendored `vendor/matebot` is read-only.
- The packaged legacy entry fails fast; rollback is reinstalling the previous
  `.deb`.
