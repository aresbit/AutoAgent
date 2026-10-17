# Vendored opencc Delta and Update Procedure

Scope:

- AutoAgent vendored copy: `/home/tars/yysapp/AutoAgent/packages/opencc`
- MateBot vendored copy: `/home/tars/yysapp/MateBot/vendor/opencc`
- Both report `"name": "claude-js"`, `"version": "1.0.2"` in `package.json`, so version strings cannot be used to detect drift.

No source files were modified. This document records commands, hashes and a reproducible merge procedure.

---

## 1. Commands run

```bash
# Git shape
cd /home/tars/yysapp/MateBot/vendor/opencc && git status --short && git log -1 --format='%H %ci %s'
cd /home/tars/yysapp/AutoAgent && git rev-parse --show-toplevel        # -> /home/tars/yysapp/AutoAgent
cd /home/tars/yysapp/AutoAgent/packages/opencc && git status --short    # clean; no own .git

# Inventory (excluding node_modules, dist, .git)
find ... -type f | sort > /tmp/{a,m}-files.txt
comm -12 /tmp/a-files.txt /tmp/m-files.txt | wc -l
# shared 2964; MateBot-only 331; AutoAgent-only 5

# Hash-based provenance: find which upstream commit contains AutoAgent's blobs
cd /home/tars/yysapp/AutoAgent/packages/opencc
git hash-object src/main.tsx src/utils/systemPrompt.ts package.json
cd /home/tars/yysapp/MateBot/vendor/opencc
git log --all --find-object=<blob> -- <path>
# All three match commit f04b76d ("fix", 2026-04-23 00:24:57 +0800)

# Full-tree confirmation
git archive f04b76d | tar -x -C /tmp/oc-f04b76d
diff -rq /tmp/oc-f04b76d /home/tars/yysapp/AutoAgent/packages/opencc -x node_modules -x dist
# 19 diff entries

# Upstream delta
git diff --stat f04b76d 4c83c36
git diff --name-status f04b76d 4c83c36 | awk '{print $1}' | sort | uniq -c
git rev-list --count f04b76d..4c83c36

# Local build evidence
ls -lh /home/tars/yysapp/AutoAgent/packages/opencc/dist/cli.js   # 25 MB
python3 -c "import json;d=json.load(open('package.json'));print(d['scripts']['build'])"
```

---

## 2. Repository shape and provenance

| Property | AutoAgent copy | MateBot copy |
|---|---|---|
| Path | `/home/tars/yysapp/AutoAgent/packages/opencc` | `/home/tars/yysapp/MateBot/vendor/opencc` |
| Own `.git` | No; tracked by the AutoAgent parent repo | Yes (full checkout, detached HEAD) |
| Parent tracking | Normal directory | Gitlink `mode 160000` at `4c83c365...` (`git ls-files -s vendor/opencc`), no `.gitmodules` |
| Current commit | n/a | `4c83c36` "perf(repl): stop streamed tool input re-running the whole message pipeline", 2026-08-28 |
| Working tree | Clean | 3 modified files (MemoryTool patch, see section 6) |
| Package identity | `claude-js` 1.0.2 | `claude-js` 1.0.2 |
| File count (excl. node_modules/dist) | 2969 | 3295 |
| `dist/cli.js` | Present, 25 MB, built 2026-10-17 | Absent |
| `node_modules` | Present (404 KB of workspace links) | Absent |

Important: MateBot's `.gitignore:35-38` states that `vendor/opencc` is a gitlink with no `.gitmodules`, so a fresh MateBot clone gets an **empty** `vendor/opencc/`. The update must be driven from this workstation's populated checkout (or by fetching the opencc remote directly), not from a fresh MateBot clone.

Provenance of the AutoAgent copy (hash-based, not guessed):

- `src/main.tsx` blob `e4a06bbb...`, `src/utils/systemPrompt.ts` blob `2059c81b...`, `package.json` blob `f0228986...` all exist in the MateBot opencc object database.
- The trees at `f04b76d` (2026-04-23 "fix") and the AutoAgent copy differ in only **19 entries**.
- The earlier base candidate `5e1f559` (2026-04-07) differs in 54 entries; `f04b76d` is therefore the correct merge base.

So: **AutoAgent copy = upstream `f04b76d` + 19 local deviations**, not an arbitrary old snapshot.

---

## 3. Inventory delta against current MateBot HEAD

Compared file-by-file (excluding node_modules/dist/.git):

- shared files: **2964**
- identical: **2107**
- differing: **857**
- only in MateBot: **331**
- only in AutoAgent: **5**
  - `src/entrypoints/engine.ts`
  - `src/entrypoints/server.ts`
  - `src/entrypoints/server/headlessState.ts`
  - `src/tools/SelfImprovingTool/SelfImprovingTool.ts`
  - `src/tools/SelfImprovingTool/autoCapture.ts`

The 857/331 numbers overstate the work because they compare against the wrong base. The actionable upstream delta is `f04b76d..4c83c36`.

---

## 4. The 19 local deviations from `f04b76d` (must be preserved or consciously dropped)

Reproduce with:

```bash
git -C /home/tars/yysapp/MateBot/vendor/opencc archive f04b76d | tar -x -C /tmp/oc-f04b76d
diff -rq /tmp/oc-f04b76d /home/tars/yysapp/AutoAgent/packages/opencc -x node_modules -x dist
```

### 4.1 Added locally (3 files/dirs)

| Path | Purpose | Evidence |
|---|---|---|
| `src/entrypoints/engine.ts` | Library entrypoint re-exporting `query`, `getTools`, context helpers, etc., for embedding in Electron/Bun | file header |
| `src/entrypoints/server.ts` | Long-running JSON-RPC-over-JSONL stdio server (`cli.js --server`), multiplexes threads | file header lines 1-25 |
| `src/entrypoints/server/headlessState.ts` | Headless bootstrap state for the server | import graph |

Dormant today: `grep -rn -- "--server" src` finds no caller in the desktop backend. Keep the files unless deliberately retiring the server design.

### 4.2 Modified locally (13 files)

| Path | Local change | Category |
|---|---|---|
| `src/entrypoints/cli.tsx` | Fast path: `--server` dynamically imports `./server.js` before CLI/Ink startup | desktop integration |
| `src/services/api/client.ts` | Inject `baseURL: process.env.ANTHROPIC_BASE_URL` into the SDK client | provider/runtime |
| `src/utils/ripgrep.ts` | `AUTOAGENT_RG_PATH` + executable-relative candidates | packaging |
| `src/utils/Shell.ts` | Default temp dir `os.tmpdir()` instead of `/tmp` | Windows/cross-platform |
| `src/utils/permissions/filesystem.ts` | Same `tmpdir()` default | Windows/cross-platform |
| `src/utils/windowsPaths.ts` | `existsSync` instead of `dir`; Windows path resolution fixes | Windows |
| `src/utils/settings/mdm/rawRead.ts` | Use `%SystemRoot%\System32\reg.exe`; hardened exec | Windows |
| `src/utils/claudemd.ts` | Also read `.autoagent/CLAUDE.md` and `.autoagent/rules/*.md` | AutoAgent compatibility |
| `src/skills/loadSkillsDir.ts` | Discover `.autoagent/skills`, skip hidden/`.disabled` dirs | AutoAgent compatibility |
| `src/tools/SelfImprovingTool/SelfImprovingTool.ts` | Learn-tool storage under auto-memory root | AutoAgent compatibility |
| `src/tools/SelfImprovingTool/autoCapture.ts` | Same storage relocation | AutoAgent compatibility |
| `src/redteam/redteam.ts` | Removed the startup ASCII banner printed to stdout | stream-json stdout hygiene |
| `packages/color-diff-napi/package.json` | Pin `highlight.js` to `11.12.0` instead of `latest` | reproducible builds |

### 4.3 Removed locally (3 entries)

| Path | Reason |
|---|---|
| `bun.lock` | Parent AutoAgent workspace owns the single lockfile |
| `CLAUDE.md` | Avoid shipping repo-specific agent instructions in the desktop bundle |
| `src/utils/vendor/` | Vendored `ripgrep` binary; AutoAgent resolves `rg` from `build-resources`/runtime path instead |

### 4.4 Rename hazard

Upstream renamed `src/tools/SelfImprovingTool/SelfImprovingTool.ts` to `src/tools/LearnTool/LearnTool.ts` (`R054` in `f04b76d..4c83c36`) and deleted `SelfImprovingTool/autoCapture.ts`. The AutoAgent local storage changes above must be **ported to LearnTool** during the merge, or the memory-storage behavior silently regresses.

---

## 5. Upstream delta `f04b76d..4c83c36`

```bash
git -C /home/tars/yysapp/MateBot/vendor/opencc diff --stat f04b76d 4c83c36
# 1183 files changed, 88611 insertions(+), 7143 deletions(-)
git -C ... rev-list --count f04b76d..4c83c36
# 161 commits
git diff --name-status f04b76d 4c83c36 | awk '{print $1}' | sort | uniq -c
# 327 A, 854 M, 1 D, 1 R054
```

MateBot-relevant additions (non-exhaustive):

- `src/utils/matebotMode.ts` and `matebotMode.test.ts`
- `src/coordinator/` worker agents (the ordinary `src/coordinator/` directory existed in `f04b76d`, but the MateBot prompt/registry semantics are new)
- `src/actor/` (11 files): runtime, local mailbox, WebSocket transport, Lisp meta-interpreter, resource registry, types
- `src/matebot/` (6 files): eval/apply ledger, shared project root, race worker/tests
- `src/remote/MateBotRemoteWorkerServer.ts`, `MateBotRemoteTransport.ts`
- `src/entrypoints/matebot-worker.ts`
- `src/tools/ActorTool/`, `src/tools/EvalApplyTool/`
- `src/tools/GoalTool/`, `src/tools/LearnTool/`, `src/tools/MythosTool/`, `src/tools/PMTool/`, `src/tools/SETool/`, `src/tools/RedoTool/`, `src/services/rsi/`, `src/tools/ManuscriptCheckTool/`, `src/tools/KimiWebBridgeTool/`, `src/tools/QuantVerifyTool/`, `src/tools/SSHRemoteTool/`, `src/tools/WideResearchTool/`, and more
- `docs/matebot-actor-protocol.md`, `docs/matebot-swarm-harness.md`, plus 23 other docs
- Build/deps changes:
  - `build`: adds `--external @firecrawl/anydoc --minify-whitespace --minify-syntax`
  - `matebot`, `matebot:worker` scripts
  - runtime dependencies `@firecrawl/anydoc ^0.1.3`, `@llamaindex/liteparse ^2.0.3`

The new tools are globally registered in `src/tools.ts` (e.g. `EvalApplyTool`/`ActorTool` at `src/tools.ts:269-270`); they are not gated by `--matebot`.

### 5.1 Packaging consequence of the new build

AutoAgent's Electron packaging ships only:

```json
"files": ["dist/**/*", "package.json", "packages/opencc/dist/**/*", "packages/opencc/package.json"]
"extraResources": [{"from": "packages/opencc/dist", "to": "opencc-dist"}]
```

Both new dependencies are loaded lazily with graceful degradation:

- `@firecrawl/anydoc` for office documents (`src/utils/anydoc.ts:74`; failure message at `:135`)
- `@llamaindex/liteparse` for PDFs (`src/utils/pdf.ts:34`, with a fallback path when absent)

Because the upstream build marks `@firecrawl/anydoc` external, a bundled `dist/cli.js` will not contain it. Choose one:

1. **Bundle it**: drop `--external @firecrawl/anydoc` from the build script (native binary concerns apply to liteparse, which is already dynamically imported), or
2. **Ship it**: add the two packages (plus platform optional dependencies) under `extraResources`/`files` and ensure Bun resolves them from the app resources directory.

If neither is done, the CLI still starts; only PDF/office extraction degrades. Do not let that regression go unnoticed in packaging tests.

---

## 6. MateBot's uncommitted MemoryTool patch

`git -C /home/tars/yysapp/MateBot/vendor/opencc status --short`:

```
 M src/tools/MemoryTool/MemoryStore.ts
 M src/tools/MemoryTool/MemoryTool.ts
 M src/tools/MemoryTool/ranking.ts
```

`git diff --stat`: 3 files, +103/-9. It adds:

- optional `staleAfter` / `stale_after` frontmatter and tool input
- character n-gram Dice soft matching (`softMatchWeight`, `softMatchThreshold`)
- `staleFactor` demotion in ranking
- archive-on-expiry behavior

This patch is **not in any commit**, so `git archive 4c83c36` will not include it. Decide explicitly whether AutoAgent wants it:

- If yes: capture it with `git -C /home/tars/yysapp/MateBot/vendor/opencc diff > /tmp/matebot-memorytool.patch` and apply after the merge; resolve the LearnTool rename separately.
- If no: document the exclusion so a later "MateBot parity" test does not treat it as a regression.

---

## 7. Recommended update procedure: selective three-way merge

**Do not do a blind subtree replace.** The local fork contains desktop transport, Windows fixes, `.autoagent` compatibility, ripgrep resolution and a provider fix; a replace silently loses them. Conversely, copying only the new MateBot files leaves the 161-commit upstream delta and the SelfImproving->Learn rename unmerged.

### Step 0 — Freeze local state

```bash
cd /home/tars/yysapp/AutoAgent
git status --short
git add -A packages/opencc && git commit -m "chore(opencc): snapshot before MateBot rebase"   # only if needed
```

Record the local patch set:

```bash
git -C /home/tars/yysapp/AutoAgent diff f04b76d-snapshot -- packages/opencc > /tmp/autoagent-opencc-local.patch
```

(If the repo has no `f04b76d` ref, use the 19-file list in section 4 as the checklist instead.)

### Step 1 — Materialize the three trees

```bash
UP=/home/tars/yysapp/MateBot/vendor/opencc
AUTO=/home/tars/yysapp/AutoAgent/packages/opencc

rm -rf /tmp/oc-base /tmp/oc-theirs /tmp/oc-merge
mkdir -p /tmp/oc-base /tmp/oc-theirs /tmp/oc-merge

# Merge base: the exact upstream snapshot AutoAgent forked from
git -C "$UP" archive f04b76d | tar -x -C /tmp/oc-base

# Theirs: current MateBot working tree, INCLUDING the uncommitted MemoryTool patch
git -C "$UP" diff > /tmp/matebot-working-tree.patch
git -C "$UP" archive 4c83c36 | tar -x -C /tmp/oc-theirs
( cd /tmp/oc-theirs && git init -q && git apply /tmp/matebot-working-tree.patch )

# Ours: current AutoAgent copy
rsync -a --exclude node_modules --exclude dist "$AUTO"/ /tmp/oc-merge/
```

### Step 2 — Perform a real three-way merge

Create a scratch git repo whose history has base as the common ancestor:

```bash
cd /tmp/oc-merge
git init -q
git checkout -qb base
rsync -a --delete /tmp/oc-base/ /tmp/oc-merge/
git add -A && git commit -qm "base f04b76d"

git checkout -qb ours
rsync -a --delete --exclude .git --exclude node_modules --exclude dist "$AUTO"/ /tmp/oc-merge/
git add -A && git commit -qm "AutoAgent local"

git checkout -q base
git checkout -qb theirs
rsync -a --delete --exclude .git --exclude node_modules --exclude dist /tmp/oc-theirs/ /tmp/oc-merge/
git add -A && git commit -qm "MateBot 4c83c36 + working tree"

git checkout -q ours
git merge theirs
```

(`rsync --delete` is deliberate: it carries local deletions and upstream renaming/deletion semantics into the merge.)

### Step 3 — Resolve conflicts using the checklist

- Keep the 3 local additions (`engine.ts`, `server.ts`, `server/headlessState.ts`) unless retiring them.
- Re-apply or keep the 13 local modifications. `cli.tsx`, `ripgrep.ts`, `windowsPaths.ts`, `Shell.ts`, `filesystem.ts`, `mdm/rawRead.ts`, `claudemd.ts`, `loadSkillsDir.ts`, `client.ts`, `redteam.ts` and `color-diff-napi/package.json` should merge cleanly or with small conflicts.
- **Port SelfImprovingTool storage changes to LearnTool** (section 4.4).
- Decide on `CLAUDE.md` and `src/utils/vendor/`: upstream will re-add them; the local fork intentionally removed them. Keep them out if that was deliberate, and make sure the ripgrep fallback still works without the vendored binary.
- `bun.lock` is not part of the nested package; keep it out. The root `AutoAgent/bun.lock` must be regenerated.
- Keep `--matebot` and coordinator semantics from theirs; do not overwrite `src/coordinator/`, `src/actor/`, `src/matebot/`, `src/remote/` with local content.

### Step 4 — Reconcile `package.json`

Take upstream's:

```json
"scripts": {
  "build": "bun build src/entrypoints/cli.tsx --outdir dist --target bun --external @firecrawl/anydoc --minify-whitespace --minify-syntax",
  "matebot": "bun run src/entrypoints/cli.tsx --matebot",
  "matebot:worker": "bun run src/entrypoints/matebot-worker.ts"
},
"dependencies": {
  "@firecrawl/anydoc": "^0.1.3",
  "@llamaindex/liteparse": "^2.0.3"
}
```

Keep the local `color-diff-napi` pin (`highlight.js: 11.12.0`). If bundling is preferred over shipping node_modules, remove `--external @firecrawl/anydoc`.

### Step 5 — Install and build

```bash
# Workspace-level install: packages/opencc is a Bun workspace of AutoAgent
cd /home/tars/yysapp/AutoAgent
# If registry.npmjs.org is slow/unreachable, add registry=https://registry.npmmirror.com/ to bunfig
bun install

cd packages/opencc
bun run build            # -> dist/cli.js
```

The MateBot build uses `--minify-whitespace --minify-syntax`; verify the CLI still starts after minification. The previous AutoAgent build did not minify; the new `dist/cli.js` may have a different size, so update any size assumptions in packaging scripts.

### Step 6 — Verify `--matebot` without starting a session

```bash
cd /home/tars/yysapp/AutoAgent/packages/opencc
bun dist/cli.js --version
bun dist/cli.js --help | grep -E -- '--matebot|--input-format|--output-format|--include-partial-messages'
grep -c 'OPENCC_MATEBOT' dist/cli.js
# expected: --matebot is listed; grep count >= 1
```

Also verify coordinator assets survived minification:

```bash
bun dist/cli.js --help | grep -E -- '--resume|--append-system-prompt|--dangerously-skip-permissions'
```

### Step 7 — Smoke test one turn

```bash
printf '%s\n' \
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with OK"}]}}' | \
timeout 120 bun dist/cli.js \
  --print --verbose \
  --input-format stream-json --output-format stream-json \
  --include-partial-messages --dangerously-skip-permissions \
  --matebot | head -20
```

Expected:

- first frame is `system/init` with `agents` containing `worker`, `researcher`, `planner`, `builder`, `evaluator`;
- at least one `assistant` and one `result`;
- `result.subtype == "success"` for a clean turn.

Run this against a scratch `CLAUDE_CONFIG_DIR` so it does not pollute the user's transcripts.

### Step 8 — Package and smoke test the packaged app

- Update `package.json` packaging if external deps are shipped.
- Confirm `opencc-dist/cli.js` is present in the installed app and starts with the bundled `bun`.
- Test the absence of `node_modules`: PDF/office reads should degrade, not crash the CLI.
- Re-run the desktop turn to confirm `--matebot` survives `extraResources` copying.

---

## 8. Verification checklist

| Check | Command | Expected |
|---|---|---|
| Upstream base is correct | `git hash-object src/main.tsx` | matches `e4a06bbb...` at `f04b76d` |
| Local deviations preserved | `diff -rq /tmp/oc-base <auto>/packages/opencc -x node_modules -x dist` | same 19 entries (or fewer if intentionally retired) |
| MateBot features present | `ls src/utils/matebotMode.ts src/actor/types.ts src/entrypoints/matebot-worker.ts` | all exist |
| SelfImproving changes ported | `grep -n "getLearnToolRoot" src/tools/LearnTool/*.ts` | present if the local behavior is wanted |
| Build succeeds | `bun run build` | exit 0, `dist/cli.js` produced |
| Flag present | `bun dist/cli.js --help \| grep -- --matebot` | one line |
| Coordinator init | smoke test section 7, step 7 | init `agents` list has 5 roles |
| Packaging | install package, run turn | child process starts from `opencc-dist/cli.js` |
| Lockfile | `git diff bun.lock` | only expected new deps |

---

## 9. Size, regeneration and licensing concerns

### Size

- Source (excluding node_modules/dist): AutoAgent 30 MB vs upstream base 55 MB; the difference is largely the removed `src/utils/vendor/ripgrep/x64-linux/rg` and other vendored assets.
- `dist/cli.js`: 25 MB in the current checkout (unminified). The upstream minified build may be smaller; measure before/after and update release-size expectations.
- New runtime deps (`@firecrawl/anydoc`, `@llamaindex/liteparse`) add install time and, if shipped, package size. liteparse has native platform binaries.

### Regeneration

- `dist/` is a build artifact. Do not hand-edit it; always regenerate from source.
- The nested `packages/opencc` must not grow a second `bun.lock`; the AutoAgent root lockfile is authoritative.
- MateBot's `bunfig.toml` pins `registry.npmmirror.com` because some lock entries otherwise fall back to npmjs and stall. If AutoAgent's install is slow, mirror that setting at the AutoAgent root (do not copy the nested file blindly).

### Licensing / provenance

- Neither vendored tree contains `LICENSE`, `COPYING` or `NOTICE` files.
- The upstream README describes opencc as a reverse-engineered reconstruction of Anthropic's Claude Code CLI (`README.md:3`).
- AutoAgent ships `packages/opencc/dist/**/*` in its desktop package (`AutoAgent/package.json:19-29`) and bundles it into `extraResources`.
- Recommendation: complete a legal/licensing review before distributing a new build, and record the exact upstream commit (`4c83c36` plus local patch) in release metadata. This document makes no legal conclusion.

---

## 10. Recommendation summary

1. Treat `f04b76d` as the merge base and `4c83c36` + the uncommitted MemoryTool patch as the target.
2. Perform a selective three-way merge, preserving the 19 local deviations listed in section 4; do not replace the subtree.
3. Port SelfImprovingTool storage changes to LearnTool.
4. Adopt the upstream build script/deps, then rebuild and verify `--matebot` via `--help` and a one-turn smoke test.
5. Resolve external-dependency packaging before release.
6. Keep a checked-in local-patch checklist and re-run it after every future upstream bump; version numbers are identical on both sides, so commits and blob hashes are the only reliable identity.
