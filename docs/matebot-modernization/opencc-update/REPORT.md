# Vendored opencc update: MateBot `4c83c36` -> `0ed706d`

Date: 2026-10-19
Scope: `/home/tars/yysapp/AutoAgent/packages/opencc` only
Status: complete, build green, required tests green

## 1. Summary

| Item | Before | After |
|---|---|---|
| Package version | `1.0.2` | `2.1.888` |
| Base upstream commit | `4c83c36` ("perf(repl): ...") | n/a |
| New upstream commit | n/a | `0ed706dd8d54c9715bff2bf7c9444543294f9148` |
| Upstream commits merged | n/a | 177 (`4c83c36..0ed706d`) |
| Upstream diff | n/a | 482 files, +66,576 / -3,965 |
| Local deviations | 20 tree entries | all preserved or consciously superseded |
| MCP-FS | old `McpFsTool` family | new `src/services/mcpfs/*` |
| Build | 25 MB `dist/cli.js` | 21.45 MB `dist/cli.js`, 5,450 modules |
| Required tests | n/a | 18 pass / 0 fail |

The delta document `/home/tars/yysapp/AutoAgent/docs/matebot-modernization/opencc-delta.md` was stale. It described the base as `f04b76d` and MateBot HEAD as `4c83c36`. The current tree shows that AutoAgent was already resynced to `4c83c36` by parent-repo commit `356445c6924d7d0fbd693d2359dc095b1224b750` ("chore(opencc): sync vendored opencc with MateBot 4c83c36", 2026-10-17). The true base for this update was therefore `4c83c36`, not `f04b76d`.

Provenance was re-derived by blob hash. Every sampled AutoAgent file matched `4c83c36`, not the doc's `f04b76d`:

```
$ git -C MateBot/vendor/opencc rev-parse 4c83c36:src/main.tsx
a5838cc2b5f430768c404a862791eb122672ca03        # == AutoAgent src/main.tsx
$ git -C MateBot/vendor/opencc rev-parse 4c83c36:src/utils/systemPrompt.ts
a5aeba5a8a6fb214fd75ae24ed493f69aff36bd5        # == AutoAgent
$ git -C MateBot/vendor/opencc rev-parse 4c83c36:package.json
10020c62b3c9642b5eea14938bdfbd96beb3bf04        # == AutoAgent
```

## 2. Recorded state

```
$ git -C /home/tars/yysapp/MateBot/vendor/opencc log -1 --format='%H %ci %s'
0ed706dd8d54c9715bff2bf7c9444543294f9148 2026-10-19 10:38:23 +0800 Project live MCP connections into CodeAct instead of reconnecting

$ git -C /home/tars/yysapp/MateBot/vendor/opencc status --short
(clean)

$ git -C /home/tars/yysapp/AutoAgent log -1 --format='%H %ci %s' -- packages/opencc
356445c6924d7d0fbd693d2359dc095b1224b750 2026-10-17 12:03:22 +0800 chore(opencc): sync vendored opencc with MateBot 4c83c36
```

Backup created before any modification:

```
/tmp/opencc-backup-1792385079.tar.gz  (19 MB)
```

Additional artifacts used during the merge:

- `/tmp/oc-base-4c83c36` - `git archive 4c83c36`
- `/tmp/oc-head` - `git archive 0ed706d`
- `/tmp/oc-auto-snapshot` - pre-update AutoAgent copy (excluding `node_modules`, `dist`)
- `/tmp/autoagent-local-deviations.patch` - re-derived local patch

## 3. Re-derived local delta at `4c83c36`

`diff -rq /tmp/oc-base-4c83c36 packages/opencc -x node_modules -x dist` produced 20 entries.

Modified (11):

1. `packages/color-diff-napi/package.json`
2. `src/entrypoints/cli.tsx`
3. `src/services/api/client.ts`
4. `src/skills/loadSkillsDir.ts`
5. `src/tools/MemoryTool/MemoryStore.ts`
6. `src/tools/MemoryTool/MemoryTool.ts`
7. `src/tools/MemoryTool/ranking.ts`
8. `src/utils/claudemd.ts`
9. `src/utils/ripgrep.ts`
10. `src/utils/settings/mdm/rawRead.ts`
11. `src/utils/windowsPaths.ts`

Added (3):

- `src/entrypoints/engine.ts`
- `src/entrypoints/server.ts`
- `src/entrypoints/server/headlessState.ts`

Removed (6):

- `bun.lock` (workspace root owns the lockfile)
- `CLAUDE.md`
- `findings.md`
- `progress.md`
- `task_plan.md`
- `src/utils/vendor/`

The last three markdown files were pre-existing local removals discovered during re-derivation; they were not in the stale doc. They remained excluded.

Several deviations listed in the stale doc were **already reconciled in `4c83c36`** and therefore did not need reapplication:

- `src/utils/Shell.ts` uses `os.tmpdir()` (`CLAUDE_CODE_TMPDIR || tmpdir()`).
- `src/utils/permissions/filesystem.ts` uses `tmpdir()`.
- `src/redteam/redteam.ts` has no module-level startup banner (only in-function logs).
- `SelfImprovingTool` -> `LearnTool` storage relocation is already in upstream `LearnTool` via `getAutoMemPath()` / `getLearnToolRoot()`.

## 4. Procedure actually used

```bash
# 1. Backup
tar -C /home/tars/yysapp/AutoAgent/packages -czf /tmp/opencc-backup-$(date +%s).tar.gz opencc

# 2. Extract trees
git -C /home/tars/yysapp/MateBot/vendor/opencc archive 4c83c36 | tar -x -C /tmp/oc-base-4c83c36
git -C /home/tars/yysapp/MateBot/vendor/opencc archive HEAD      | tar -x -C /tmp/oc-head

# 3. Replace the vendored tree with HEAD, keeping exclusions
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude bun.lock --exclude CLAUDE.md \
  --exclude findings.md --exclude progress.md --exclude task_plan.md \
  --exclude src/utils/vendor \
  /tmp/oc-head/ /home/tars/yysapp/AutoAgent/packages/opencc/

# 4. Reapply the base->AutoAgent local patch
cd /home/tars/yysapp/AutoAgent/packages/opencc
patch -p1 --forward --fuzz=3 < /tmp/autoagent-local-deviations.patch
```

`patch` applied all hunks except `src/utils/windowsPaths.ts` hunk 4, because upstream had changed the two error strings from "Claude Code" to "opencc". The hunk was reapplied manually, preserving the upstream wording and the local non-exiting fallback behavior.

`src/utils/ripgrep.ts` applied with offsets because upstream rewrote the resolver; the inserted `findAutoAgentRipgrep()` block landed in the correct position (after system-rg selection, before bundled mode). A duplicated `existsSync` import introduced by the patch was removed.

## 5. Decisions on renamed / replaced paths

### 5.1 `SelfImprovingTool` -> `LearnTool`

No port was needed. Upstream `4c83c36` already contains the relocated storage:

- `src/tools/LearnTool/LearnTool.ts:24` imports `getAutoMemPath`
- `:321-326` defines `getLearnToolRoot()` and `getDefaultMemoryDir()`
- `:939` uses `getLearnToolRoot()` as `projectRoot`

This matches the old local `SelfImprovingTool` behavior and is preserved in `0ed706d`.

### 5.2 MemoryTool stale-memory patch

AutoAgent's local MemoryTool change was the older MateBot uncommitted `stale_after` patch. MateBot HEAD now contains a refined, committed version of the same feature:

- `stale_after` schema validation
- `buildQueryContext()` (query n-grams computed once per search)
- `staleTimestamp()` (+Infinity for unparseable dates)
- `staleFactor` demotion in ranking
- `include_stale` opt-in for archiving

**Decision: adopt the HEAD implementation; do not replay the older local patch.** The feature is preserved and improved. One intentional behavior delta: `archiveOldMemories` no longer archives a passed `stale_after` automatically; callers must pass `include_stale: true`. This matches MateBot HEAD and its documented rationale.

### 5.3 Old MCP-FS -> new `services/mcpfs`

At `4c83c36`, the old `McpFsTool` family was upstream code, not an AutoAgent-only addition. `0ed706d` deletes it and replaces it with `src/services/mcpfs/*`:

- `approval.ts`, `gateway.ts`, `projection.ts`, `runtime.ts`, `scan.ts`, `schema.ts`, `__tests__/mcpfs.test.ts`
- Wired from `CodeActTool`, `goalContinuation`, and `onChangeAppState`

**Decision: adopt the new mcpfs, remove the old files, keep no fallback.** The old files (`src/utils/mcpFilesystem.ts`, `src/utils/mcpFsClient.ts`, `src/tools/McpFsTool/*`) were removed by the HEAD tree. `src/tools.ts` was taken from HEAD and contains no `McpFs*` imports, so there are no dangling imports or duplicate tool names. `src/services/mcpfs/__tests__/mcpfs.test.ts` passes.

### 5.4 Added desktop entrypoints

`engine.ts`, `server.ts`, and `server/headlessState.ts` were kept. MateBot HEAD's `src/server/server.ts` is an auto-generated stub and is not an equivalent replacement.

`server.ts` and `headlessState.ts` required adaptation to the HEAD `QueryEngine`/`AppState` API because `AppState` no longer carries `tools` or `readFileCache`:

- `createAppState()` now returns `{ appState, setAppStateFn, tools, readFileCache }`
- `tools` comes from `getTools(permissionContext)` (cast at the call boundary because `AppState` and `getTools` use two structurally different `ToolPermissionContext` types)
- `readFileCache` is `createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)`
- `server.ts` passes these directly to `new QueryEngine({...})`

These changes remove exactly the three new type errors the entrypoints had after the tree replacement.

## 6. Dependency / lockfile impact

`bun install --frozen-lockfile` inside the package failed:

```
bun install v1.3.13 (bf2e2cec)
Resolving dependencies
Resolved, downloaded and extracted [147]
warn: incorrect peer dependency "web-tree-sitter@0.27.0"
error: lockfile had changes, but lockfile is frozen
note: try re-running without --frozen-lockfile and commit the updated lockfile
```

The workspace root `/home/tars/yysapp/AutoAgent/bun.lock` predated the new HEAD dependencies. **Follow-up (coordinator, 2026-10-19):** it was updated at the repo root with `bun install --lockfile-only` — `bun.lock` changed by 45 insertions / 1 deletion, and `bun install --frozen-lockfile --ignore-scripts` now succeeds (checked 1048 installs across 1172 packages). Commit this lockfile change together with the opencc update.

The verification-time `/tmp/newdeps` symlinks were also removed; the root install recreated `packages/opencc/node_modules/{@ast-grep,@dagrejs,@vscode}` as durable links into the root `.bun` store. After that cleanup, the build and required tests were re-run green (see §7).

Packaging note: the build still marks `@firecrawl/anydoc` external. The new dependencies are either bundled (`@dagrejs/dagre`) or lazily resolved with graceful degradation (ripgrep tiers, ast-grep/tree-sitter). Missing runtime copies degrade search/structural-search features but do not prevent CLI startup.

## 7. Verification

### Build

```
$ bun run build
$ bun build src/entrypoints/cli.tsx --outdir dist --target bun --external @firecrawl/anydoc --minify-whitespace --minify-syntax --feature VOICE_MODE
Bundled 5450 modules in 376ms
  cli.js  21.45 MB  (entry point)
```

### Required tests

```
$ bun test src/services/mcpfs/__tests__/mcpfs.test.ts src/utils/matebotMode.test.ts
 18 pass
 0 fail
 37 expect() calls
Ran 18 tests across 2 files. [841.00ms]
```

Individually: mcpfs 13/13, matebotMode 5/5.

### Typecheck

There is no `typecheck` script in `package.json`. `node_modules/.bin/tsc --noEmit` was run against both trees:

| Tree | Errors |
|---|---|
| Upstream `/tmp/oc-head` | 156 |
| Updated AutoAgent copy | 156 |

The normalized error sets are identical; there are no errors in `engine.ts`, `server.ts`, `headlessState.ts`, or `src/services/mcpfs/`. The 156 errors are pre-existing upstream issues.

### Built CLI

```
$ bun dist/cli.js --version
2.1.888 (opencc)

$ bun dist/cli.js --help
Usage: claude [options] [command] [prompt]
opencc - starts an interactive session by default, use -p/--print for
non-interactive output
...
```

### `--server` fast path

```
$ printf '%s\n%s\n' '{"id":1,"method":"initialize","params":{}}' '{"method":"initialized"}' \
    | bun dist/cli.js --server
{"id":1,"result":{"platformFamily":"linux","platformOs":"linux","serverVersion":"2.1.888","capabilities":{"threads":true,"streaming":true}}}
```

Direct module loads also succeed:

```
engine.ts exports: asSystemPrompt,createAssistantAPIErrorMessage,createSystemMessage,createUserMessage,
findToolByName,getAPIProvider,getGitStatus,getSystemContext,getTools,getUserContext,
normalizeMessagesForAPI,query
headlessState.ts exports: createAppState,createCanUseTool
```

### Bundle markers

```
matebot                15
mcpfs                  4
--server               1
ANTHROPIC_BASE_URL     15
AUTOAGENT_RG_PATH      1
.autoagent             3
dist/cli.js            21 MB
```

### Working-tree status

```
$ git -C /home/tars/yysapp/AutoAgent status --short -- packages/opencc | wc -l
225
$ git -C ... status --short -- packages/opencc | awk '{print $1}' | sort | uniq -c
     73 ??
     10 D
    142 M
```

The whole repo reports 264 dirty entries; the remaining 39 are the pre-existing unrelated user changes outside `packages/opencc` and were not touched. `bun.lock` and root `package.json` are unchanged.

Changed paths by directory (old local vs new tree, 222 `diff -rq` entries): `src/utils` 39, `src/tools` 30, `src/components` 28, `src/hooks` 9, `src/services` 8, `src/ink` 7, `src/commands` 4, `src/actor` 4, `src/entrypoints` 3, plus deletions of the old MCP-FS files and docs.

### Extra test (pre-existing failure)

`bun test src/tools/GoalTool/__tests__/goalDecision.test.ts` fails with:

```
SyntaxError: Export named 'slowLogging' not found in module '.../src/utils/slowOperations.ts'
```

The same test fails identically on pristine upstream `/tmp/oc-head`, so it is not caused by this update.

## 8. Remaining risks

1. **Root lockfile — resolved in follow-up.** `bun install --lockfile-only` updated `bun.lock` (45 insertions, 1 deletion); `bun install --frozen-lockfile --ignore-scripts` succeeds. Commit the lockfile with the opencc update.
2. **Verification-time dependency symlinks — resolved in follow-up.** Stale `packages/opencc/node_modules/{@ast-grep,@dagrejs,@vscode}` links to `/tmp/newdeps` were removed and recreated by the root install; `find ... -lname '*newdeps*'` returns 0. Rebuild after cleanup: 5,450 modules, 21.45 MB; required tests 18 pass / 0 fail.
3. **Server API adaptation.** The desktop JSON-RPC server was ported to the HEAD `QueryEngine` constructor and `AppState` shape by typecheck and an `initialize` smoke test. A full `turn/start` was not exercised because it requires model credentials and would make network API calls.
4. **MemoryTool behavior delta.** Automatic archive-on-expired-`stale_after` became opt-in (`include_stale: true`). This is MateBot HEAD behavior; any desktop caller relying on the old automatic path must pass the flag.
5. **Pre-existing typecheck errors.** 156 upstream errors remain; they are not introduced by this update and do not block the Bun build.
6. **Do not run a blind `git clean` in the AutoAgent repo.** The parent tree has unrelated dirty user work.

## 9. Rollback

The backup captures the exact pre-update tree, including `dist/` and `node_modules/`:

```bash
rm -rf /home/tars/yysapp/AutoAgent/packages/opencc
tar -C /home/tars/yysapp/AutoAgent/packages -xzf /tmp/opencc-backup-1792385079.tar.gz
```

If only the temporary dependency links need removal:

```bash
rm -f /home/tars/yysapp/AutoAgent/packages/opencc/node_modules/@ast-grep \
      /home/tars/yysapp/AutoAgent/packages/opencc/node_modules/@dagrejs \
      /home/tars/yysapp/AutoAgent/packages/opencc/node_modules/@vscode \
      /home/tars/yysapp/AutoAgent/packages/opencc/node_modules/ripgrep \
      /home/tars/yysapp/AutoAgent/packages/opencc/node_modules/web-tree-sitter
```

No commit was made.
