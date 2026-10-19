# Applied deviations

Scope: AutoAgent local deviations applied on top of MateBot `0ed706dd8d54c9715bff2bf7c9444543294f9148`
True base: MateBot `4c83c36` (AutoAgent parent commit `356445c`), not the stale doc's `f04b76d`.

Legend:

- **Kept** - local change re-applied after the tree replacement.
- **Upstream-equivalent** - deviation already matched upstream at the current base; no reapplication needed.
- **Superseded** - an older local version of a feature was replaced by a newer upstream implementation.
- **Removed** - local file intentionally absent from the vendored copy.

## A. Added files (kept)

| Path | How preserved | Verification |
|---|---|---|
| `src/entrypoints/engine.ts` | Copied from pre-update AutoAgent tree. | Direct `import()` succeeds; exports `query`, `getTools`, context helpers, etc. |
| `src/entrypoints/server.ts` | Copied, then adapted to the HEAD `QueryEngine` API. | `bun dist/cli.js --server` answers `initialize` with `serverVersion: 2.1.888`. |
| `src/entrypoints/server/headlessState.ts` | Copied, then adapted: returns `tools` and a real `FileStateCache` instead of putting them on `AppState`. | Direct `import()` succeeds; tsc reports no errors in the file. |

`server.ts` / `headlessState.ts` adaptation details:

- `AppState` no longer has `tools` or `readFileCache`.
- `createAppState()` now returns `{ appState, setAppStateFn, tools, readFileCache }`.
- `tools` is produced by `getTools(permissionContext)`.
- `readFileCache` is `createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)`.
- `new QueryEngine({...})` receives both directly.

## B. Modified files (kept)

| Path | Local behavior preserved | Evidence |
|---|---|---|
| `src/entrypoints/cli.tsx` | `--server` fast path dynamically imports `./server.js` before CLI/Ink startup. | `grep -n -- '--server'` -> line 135 |
| `src/services/api/client.ts` | Injects `baseURL: process.env.ANTHROPIC_BASE_URL` into the SDK client. | `grep -c ANTHROPIC_BASE_URL` -> 2 |
| `src/utils/ripgrep.ts` | `AUTOAGENT_RG_PATH` and executable-relative/`/usr` rg candidate lookup. | `grep -c AUTOAGENT_RG_PATH` -> 1; block sits after system-rg selection and before bundled mode |
| `src/utils/settings/mdm/rawRead.ts` | Uses `%SystemRoot%\System32\reg.exe`; hardened `execFile` wrapper that resolves instead of throwing. | `grep -c System32` -> 1 |
| `src/utils/windowsPaths.ts` | `existsSync` instead of `dir`; PATH/PATHEXT scan; Git Bash fallbacks; invalid `CLAUDE_CODE_GIT_BASH_PATH` logs and continues instead of exiting. | `grep -c existsSync` -> 2; local hunk re-applied manually around upstream text changes |
| `src/utils/claudemd.ts` | Reads `.autoagent/CLAUDE.md` and `.autoagent/rules/*.md`. | `grep -c .autoagent` -> 4 |
| `src/skills/loadSkillsDir.ts` | Discovers `.autoagent/skills`; skips hidden directories; applies to project and additional dirs. | `grep -c .autoagent` -> 4 |
| `packages/color-diff-napi/package.json` | Pins `highlight.js` to `11.12.0` instead of `latest`. | `grep -c 11.12.0` -> 1 |

## C. Upstream-equivalent deviations (no reapplication needed)

These were listed in the stale delta doc but already match upstream at `4c83c36` / `0ed706d`.

| Path | State in updated tree |
|---|---|
| `src/utils/Shell.ts` | `process.env.CLAUDE_CODE_TMPDIR \|\| tmpdir()` |
| `src/utils/permissions/filesystem.ts` | `process.env.CLAUDE_CODE_TMPDIR \|\| tmpdir()` |
| `src/redteam/redteam.ts` | No module-level startup banner; only in-function `console.log` calls |
| `src/tools/LearnTool/*` | Replaces `SelfImprovingTool`; storage uses `getAutoMemPath()` / `getLearnToolRoot()` |

The `SelfImprovingTool` -> `LearnTool` port therefore required no new work: the relocated storage behavior is already present in the upstream base.

## D. Superseded deviation: MemoryTool stale-memory patch

AutoAgent's pre-update MemoryTool patch was the older MateBot uncommitted `stale_after` change. MateBot HEAD contains a newer committed version of the same feature:

- `stale_after` date validation in `MemoryTool.ts`
- `staleTimestamp()` in `ranking.ts`
- `buildQueryContext()` so query n-grams are built once per search
- `softMatchWeight` / `softMatchThreshold` Dice matching
- `staleFactor` search demotion
- `include_stale` opt-in for archive

**Decision:** adopt HEAD's implementation instead of replaying the older patch.

Behavior delta to note: archive-on-expired-`stale_after` is now opt-in (`include_stale: true`). Stale memories are still demoted in search by default. `stale_after` values must now parse as dates.

Verification: all of the above symbols are present in the updated `src/tools/MemoryTool/` files (grep evidence in `REPORT.md` section 7).

## E. MCP-FS decision

At `4c83c36` the old MCP-FS files were upstream code, not AutoAgent-only additions. `0ed706d` deletes them and adds `src/services/mcpfs/*`.

**Decision:** adopt the new mcpfs. Do not keep the old files as a fallback and do not keep old `tools.ts` registrations.

Removed by adopting HEAD:

- `src/utils/mcpFilesystem.ts`
- `src/utils/mcpFsClient.ts`
- `src/tools/McpFsTool/McpFsTool.ts`
- `src/tools/McpFsTool/McpFsDiscoverTool.ts`
- `src/tools/McpFsTool/McpFsReadTool.ts`
- `src/tools/McpFsTool/McpFsExecTool.ts`
- old `McpFs*` imports/registrations in `src/tools.ts`
- old MCP-FS docs and helper scripts (`docs/mcp-fs-capabilities.md`, `docs/mcpfs-tool-family-architecture.md`, `scripts/chatwise-to-mcpfs.ts`, `src/utils/mcpBridge.mjs`)

New wiring, taken from HEAD:

- `src/services/mcpfs/{approval,gateway,projection,runtime,scan,schema}.ts`
- `src/services/mcpfs/__tests__/mcpfs.test.ts`
- imported by `src/tools/CodeActTool/CodeActTool.ts`, `src/utils/goalContinuation.ts`, `src/state/onChangeAppState.ts`

Result: no duplicate/conflicting tool names, no dangling imports in `tools.ts`, and the mcpfs end-to-end test passes (13/13).

## F. Removed entries (kept removed)

| Path | Status |
|---|---|
| `bun.lock` | absent (workspace root owns the lockfile) |
| `CLAUDE.md` | absent |
| `findings.md` | absent (pre-existing local removal found during re-derivation) |
| `progress.md` | absent (pre-existing local removal found during re-derivation) |
| `task_plan.md` | absent (pre-existing local removal found during re-derivation) |
| `src/utils/vendor/` | absent (ripgrep binary resolved from runtime paths instead) |

## G. Deviation checklist output

```
cli --server: 2
client ANTHROPIC_BASE_URL: 2
ripgrep AUTOAGENT_RG_PATH: 1
claudemd .autoagent: 4
loadSkillsDir .autoagent: 4
rawRead System32: 1
windowsPaths existsSync: 2
LearnTool getAutoMemPath: 3
color-diff pin: 1
Shell tmpdir: 1
filesystem tmpdir: 2
entrypoints added: 3
mcpfs files: 6
```
