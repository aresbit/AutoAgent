# Independent Evaluation — AutoAgent 0.8.0 Linux `.deb` (X11 / Wayland)

- Evaluator: Sentinel (independent adversarial evaluator)
- Date: 2026-10-17
- Repository: `/home/tars/yysapp/AutoAgent` at `8387c3fda917370bdc6df6535e16faacb8504ea9` (working tree contains the implementation changes)
- Artifact: `/home/tars/yysapp/AutoAgent/release/autoagent_0.8.0_amd64.deb`
- Artifact SHA256: `92c206813ac52dbac4bf1f4ad3b278bfe9ee669ac8b7f774835cdf61534b9c6d`
- Method: every claim was re-tested from scratch. No project source, packaging, script, or doc was modified except this file. All scratch trees were created under `mktemp -d` and removed at the end. No `sudo` was used.

## Environment

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS (Noble), kernel `7.0.0-38-generic`, x86_64 |
| Session | X11, `DISPLAY=:1`, `XDG_SESSION_TYPE=x11`, `WAYLAND_DISPLAY` empty |
| Compositor under test | `gnome-shell 46.2` nested Wayland, `dbus-run-session`, isolated `XDG_RUNTIME_DIR` |
| Privileges | non-root (`tars`); `sudo` unavailable/not used |
| Relevant tools | `dpkg-deb`, `bun 1.3.13`, `xprop`, `xwininfo`, `dbus-run-session`, `gnome-shell`, `fakeroot`, `python3`, `jq` |
| Absent tools | `weston`, `cage`, `sway`, `socat` (Python was used for Unix sockets) |
| Root-only verification | not performed (no root); `unshare -r` fails with `write to /proc/self/uid_map: Operation not permitted` |

## Verdict summary

| Check | Result |
|---|---|
| A. Source audit | PASS |
| B. `bun install --frozen-lockfile` | PASS (exit 0) |
| C. Deterministic rebuild | PASS (two rebuilds, identical expected SHA256) |
| D. Debian packaging audit | PASS |
| E. Launcher positive/negative tests | PASS (one P3 edge-case observation) |
| F. X11 runtime smoke | PASS for window/argv/load; PARTIAL for cold-start `ready-to-show` timing (P2) |
| G. Wayland runtime smoke | PASS |
| H. Maintainer scripts | PASS (syntax + static + partial fakeroot simulation); root-only install path UNVERIFIED |
| I. Documentation consistency | PASS (minor stale status text, P3) |

**Overall verdict: PASS.** No P0 failure. One P2 (cold-start first paint exceeds the 1.5 s bar) and two P3 observations. The candidate is safe to apply; the root-only install/upgrade/remove path remains a documented limitation.

---

## A. Source audit

Commands run: `grep -rn "in-process-gpu\|inProcessGpu" src/ scripts/ package.json`; targeted reads of `src/main.ts` and `src/runtime-paths.ts`; the same patterns were re-checked in the packaged `resources/app/main.js`.

| Claim | Evidence | Result |
|---|---|---|
| Linux `in-process-gpu` removed | No match in `src/`, `scripts/`, `package.json`; packaged `main.js` match count = 0. Matches exist only in historical docs/evidence under `docs/cross-platform/` | PASS |
| `show:false` + `show()` on `ready-to-show` | `src/main.ts:2021` (`show: false`); `src/main.ts:2040-2043` (`once('ready-to-show')` then `mainWindow?.show()`) | PASS |
| `setDesktopName('autoagent.desktop')` | `src/main.ts:331`; packaged `main.js` contains `autoagent.desktop` | PASS |
| Bounded renderer recovery | `src/main.ts:2067-2078`: max 2 recoveries, 1000 ms backoff, only `crashed`/`oom`, reset on `did-finish-load` (`2052-2059`) | PASS |
| Engine directory | `src/runtime-paths.ts:8`: `process.env.AUTOAGENT_ENGINE_DIR \|\| (linux ? '/opt/autoagent/engine' : '')`; used for `bun`, `rg`, `cli.js` | PASS |
| Compiled payload matches source | Packaged `main.js` matches all of the above and `/opt/autoagent/engine` | PASS |

## B. Frozen lockfile install

```
$ flock /tmp/autoagent-build.lock bun install --frozen-lockfile
Resolved, downloaded and extracted [104]
Checked 1034 installs across 1137 packages (no changes) [28.40s]
EXIT=0
```

`bun.lock` pins `highlight.js@11.12.0` (plus the transitive `cli-highlight/highlight.js@10.7.3`), and `--frozen-lockfile` did not modify it. **PASS.**

## C. Deterministic rebuild

| Run | Command | Exit | Elapsed | SHA256 |
|---|---|---|---|---|
| Pre-test artifact | `sha256sum release/autoagent_0.8.0_amd64.deb` | 0 | — | `92c2068...b9c6d` (matches expected) |
| Rebuild 1 | `timeout 900 bash scripts/build-deb.sh` | 0 | 20 s | `92c2068...b9c6d` |
| Rebuild 2 | `timeout 900 bash scripts/build-deb.sh` | 0 | 20 s | `92c2068...b9c6d` |

Before/after comparison: `DETERMINISTIC_SAME`. The build sets `SOURCE_DATE_EPOCH` from the git commit, normalizes timestamps, uses `--root-owner-group --uniform-compression -Zxz`, and re-verifies the archive after creation. Frozen install is executed inside the build under the same lock. **PASS.**

## D. Debian packaging audit

```
Package: autoagent
Architecture: amd64
Version: 0.8.0
Installed-Size: 394893
Depends: libc6 (>= 2.38), libgtk-3-0t64 | libgtk-3-0, libatk1.0-0t64 | libatk1.0-0,
  libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatspi2.0-0t64 | libatspi2.0-0,
  libcairo2, libcups2t64 | libcups2, libdrm2, libgbm1, libnss3, libpango-1.0-0,
  libx11-6, libxcomposite1, libxdamage1, libxfixes3, libxkbcommon0, libxrandr2,
  libxss1, libxtst6, libasound2t64 | libasound2, libnotify4, xdg-utils
```

| Check | Result | Evidence |
|---|---|---|
| amd64, version 0.8.0 | PASS | `dpkg-deb -f` fields above |
| Explicit Ubuntu 24.04 `Depends` | PASS | `libc6 (>= 2.38)` and `t64` alternatives; no `nodejs`, `npm`, `python3`, `build-essential`, `unzip` |
| Exactly one setuid path | PASS | `dpkg-deb -c`: `-rwsr-xr-x root/root 15248 ./opt/autoagent/desktop/chrome-sandbox`; `awk '$1 ~ /^-..s/' | wc -l` = 1 |
| Forbidden content | PASS | No `node_modules`, `*.map`, `.git*`, `*.ts`, `*.tsx`, or `default_app.asar` |
| Locales | PASS | Only `en-US.pak` and `zh-CN.pak` (plus the `locales/` directory) |
| Standalone layout | PASS | Only `/opt/autoagent/{engine,desktop}` runtime trees; `/usr/bin/autoagent` launcher; no `/usr/lib/autoagent` payload |
| Modes after extraction | PASS | `chrome-sandbox 4755`, `electron 755`, `chrome_crashpad_handler 755`, `engine/bun 755`, `engine/rg 755`, `engine/cli.js 644`, `usr/bin/autoagent 755`, `resources/app/main.js 644` |
| `ldd` unresolved libs | PASS | `ldd electron` (101 lines) has no `not found` |
| Desktop entry | PASS | `desktop-file-validate` returns valid; `Exec=/usr/bin/autoagent`, `StartupWMClass=autoagent` |
| Maintainer scripts in control archive | PASS | `preinst`, `postinst`, `prerm`, `postrm` present, mode 755 |

## E. Launcher tests (stub Electron)

A stub `desktop/electron` recorded argv and the environment. `AUTOAGENT_APP_DIR` pointed at a temporary tree. The extracted launcher was used (`/tmp/.../extract/usr/bin/autoagent`).

| Case | Environment | Exit | Result |
|---|---|---|---|
| 1 | no `DISPLAY`, no `WAYLAND_DISPLAY` | 1 | `AutoAgent: no display available...`; stub not invoked |
| 2 | `WAYLAND_DISPLAY=wayland-0`, socket missing, `DISPLAY=:99` | 0 | X11 chosen; argv = `resources/app` only (no ozone flag); log records fallback |
| 3 | live Wayland Unix socket, `DISPLAY=:99` | 0 | argv = `--ozone-platform=wayland resources/app`; Wayland chosen |
| 4 | empty app dir | 1 | `AutoAgent: missing .../desktop/electron`; stub not invoked |
| 5 | absolute `WAYLAND_DISPLAY` to live socket, `XDG_RUNTIME_DIR` unset | 0 | **Fallback to X11 despite a live socket** (see P3) |
| 6 | live Wayland socket, `DISPLAY` unset | 0 | Wayland chosen; ozone flag present |
| 7 | `WAYLAND_DISPLAY` missing socket, `DISPLAY` unset | 1 | Clear error; stub not invoked |
| 8 | preset `AUTOAGENT_ENGINE_DIR=/custom/engine` | 0 | Preserved in child environment |

Static content checks: launcher uses fixed `APP_DIR=/opt/autoagent` by default; exports `AUTOAGENT_ENGINE_DIR`; contains no `--no-sandbox`, `npx`, or PATH-based Electron fallback; passes `--ozone-platform=wayland` only on the live-socket branch. **PASS**, with the absolute-path edge case noted.

## F. X11 runtime smoke test

Artifact extracted to a temp directory. Because the extracted `chrome-sandbox` is owned by the current user (not root), the normal (packaged-argv) run correctly refuses to start:

```
AutoAgent: launching on X11 (:1)
FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166: The SUID sandbox helper
binary was found, but is not configured correctly. Rather than run without sandboxing
I'm aborting now. ... chrome-sandbox is owned by root and has mode 4755.
EXIT=133, elapsed 100 ms
```

This is an artifact-ownership artifact of extraction, not a packaging defect: the archive stores `root/root 4755`, and `postinst` re-applies it. Normal-path argv does **not** contain `--no-sandbox` (confirmed by the stub-argv tests and the launcher log reaching the sandbox FATAL).

Test-harness-only follow-up: the same extracted launcher with `--no-sandbox` appended (clearly **not** a packaging claim), `DISPLAY=:1`, isolated `HOME`/`XDG_STATE_HOME`:

- Window appeared: `xwininfo -root -tree` showed `0x8000004 "AutoAgent": ("autoagent" "autoagent") 1200x870+14+49`; `_NET_CLIENT_LIST` contained `0x8000004`.
- Process args in the test run contained `--no-sandbox` (injected by the harness only). The launcher itself never adds it.

| Run (profile state) | `did-finish-load` | `ready-to-show` | GPU error lines* | Window |
|---|---|---|---|---|
| Cold (first run, fresh `HOME`) | 657 ms | 2271 ms | 0 | yes |
| Cold (fresh `HOME`, repeat) | 621 ms | 2256 ms | 0 | yes |
| Cold (fresh `HOME`, repeat) | 624 ms | 2341 ms | 0 | yes |
| Warm (same `HOME`, run 2) | 384 ms | 386 ms | 0 | yes |
| Warm (same `HOME`, run 3) | 370 ms | 373 ms | 0 | yes |

\* `grep -cE 'Context lost|MakeCurrent|OzoneImageBacking|Exiting GPU process|GPU process isn't usable'`.

Assessment: `did-finish-load` (370–657 ms) is well inside 1500 ms. `ready-to-show` is inside 1500 ms only when warm (373–386 ms); cold first launch is 2.26–2.34 s, so the stated 1500 ms assertion is **not met on a cold profile**. No GPU error storm. Check F is therefore **PARTIAL** (P2, not a P0 acceptance item).

## G. Wayland runtime smoke test

Nested compositor started exactly as specified:

```
dbus-run-session -- env HOME=<tmp> XDG_RUNTIME_DIR=<tmp/run> DISPLAY=:1 \
  gnome-shell --nested --wayland --no-x11 --sm-disable
libmutter-Message: Running GNOME Shell (using mutter 46.2) as a Wayland display server
libmutter-Message: Using Wayland display name 'wayland-0'
```

`wayland-0` socket was ready in 2.3 s. The extracted app was then launched with `WAYLAND_DISPLAY=wayland-0`, `XDG_RUNTIME_DIR` set, `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` unset, isolated `HOME`/`XDG_STATE_HOME`, and the same test-harness-only `--no-sandbox`.

```
/proc/<pid>/cmdline:
electron --ozone-platform=wayland .../resources/app --no-sandbox
OZONE_ARG_PRESENT
```

| Metric | Measured | Threshold | Result |
|---|---|---|---|
| `--ozone-platform=wayland` in argv | present | required | PASS |
| `Context lost\|MakeCurrent\|OzoneImageBacking` over 10 s | 0 | < 50 | PASS |
| `did-finish-load` | 659 ms | <= 2000 ms | PASS |
| `ready-to-show` | 858 ms | (informational) | PASS |
| App stayed alive 10 s | yes | — | PASS |

Other log lines were benign harness-environment errors (`Failed to connect to the bus` because `DBUS_SESSION_BUS_ADDRESS` was intentionally unset, and `vaInitialize failed` with no libva). No `did-fail-load`, no `render-process-gone`, no FATAL.

## H. Maintainer scripts

| Check | Result | Evidence |
|---|---|---|
| `sh -n` syntax | PASS | `preinst`, `postinst`, `prerm`, `postrm`, launcher all OK; `dash -n` launcher OK |
| preinst/prerm process scope | PASS | Only PIDs whose `/proc/PID/exe` resolves under `/usr/lib/autoagent/*` or `/opt/autoagent/*`; preinst sends TERM, sleeps 1 s, then KILL |
| postinst sandbox enforcement | PASS | Refuses missing/symlinked sandbox; `chown root:root`; `chmod 4755`; hard-fails (`exit 1`) if `[ ! -u "$SANDBOX" ]`, with a `dpkg --configure -a` remediation hint |
| postrm isolation | PASS | Only refreshes desktop/icon caches; never reads, writes, or deletes `$HOME` |
| Legacy path | PASS | Warns about a leftover `/usr/lib/autoagent`; does not delete operator data |
| Partial runtime simulation | PASS (logic-only) | Under `fakeroot`, a temp-rewritten `postinst` changed `755 tars:tars` to `4755 root:root` and exited 0; symlinked sandbox exited 1; missing sandbox exited 1 |
| Real dpkg install/upgrade/remove | NOT VERIFIED | Requires root; `unshare -r` unavailable (`uid_map` EPERM) |

The temp-rewritten `postinst` was used only because the real script hardcodes `/opt/autoagent`; the package's own script was not modified. This validates control flow, not actual `dpkg`/filesystem semantics.

## I. Documentation consistency

| Check | Result | Evidence |
|---|---|---|
| README install root | PASS | `README.md:86-91` lists `/opt/autoagent/engine`, `/opt/autoagent/desktop`, `/usr/bin/autoagent`, desktop entry, icons |
| RUNTIME_PATHS install layout | PASS | `RUNTIME_PATHS.md:181-205` lists `/opt/autoagent/...`; the only `/usr/lib/autoagent` text is an explicit legacy-fallback note |
| No current `in-process-gpu` claim | PASS | README and RUNTIME_PATHS contain no such claim; `docs/cross-platform/README.md` and `root-cause.md` describe it as the removed P0 and retain historical evidence |
| Packaging skill | PASS | `/home/tars/.claude/skills/electron-linux-packaging/SKILL.md` exists (11 KB) |
| Stale status text | P3 | `docs/cross-platform/implementation-log.md:15-30` still says `Pending — Sentinel`; `root-cause.md` and `source-change-list.md` intentionally quote the old `/usr/lib/autoagent` layout as history |

---

## Findings and exact remediation

### P0 — none

All P0 acceptance thresholds pass: setuid count = 1 at `chrome-sandbox`; no forbidden Depends; `--ozone-platform=wayland` present under Wayland; 0 GPU storm errors; X11 window appears; rebuild is byte-identical; frozen install exits 0; no in-process-gpu in source or payload.

### P2 — cold-start first paint exceeds 1.5 s

Measured `ready-to-show` on a fresh profile: 2256–2341 ms (three independent cold runs) versus 373–386 ms warm. `did-finish-load` is only 621–657 ms. The window is deliberately hidden until `ready-to-show`, so the user-visible first paint inherits the cold delay.

Exact remediation (one of):
1. Call `mainWindow.show()` on `did-finish-load` instead of `ready-to-show` (already 621–657 ms cold), keeping `ready-to-show` as an idempotent backup; or
2. Keep the `ready-to-show` handler and add a bounded fallback, e.g. after `BrowserWindow` creation:
   ```ts
   const showFallback = setTimeout(() => mainWindow?.show(), 1500);
   mainWindow.once('ready-to-show', () => { clearTimeout(showFallback); mainWindow?.show(); });
   ```
3. If the 1.5 s bar is only intended for warm starts, document that explicitly and re-baseline the claim (cold ~2.3 s, warm ~0.38 s).

### P3 — absolute `WAYLAND_DISPLAY` ignores a live socket when `XDG_RUNTIME_DIR` is unset — **RESOLVED** (post-fix re-check, 2026-10-17)

> Status after the targeted re-check: fixed in the launcher (line 25 is now `if [ -S "$WAYLAND_SOCKET" ]; then`) and independently re-verified. The text below records the original finding and the suggested remediation.

The launcher builds the correct absolute socket path but gates acceptance on a non-empty `XDG_RUNTIME_DIR`:

```sh
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$WAYLAND_SOCKET" ]; then
```

Exact remediation: when `WAYLAND_DISPLAY` is absolute, do not require `XDG_RUNTIME_DIR`:

```sh
case "$WAYLAND_DISPLAY" in
  /*) WAYLAND_SOCKET="$WAYLAND_DISPLAY"; NEED_RUNTIME=0 ;;
  *)  WAYLAND_SOCKET="${XDG_RUNTIME_DIR:-}/$WAYLAND_DISPLAY"; NEED_RUNTIME=1 ;;
esac
if { [ "$NEED_RUNTIME" -eq 0 ] || [ -n "${XDG_RUNTIME_DIR:-}" ]; } && [ -S "$WAYLAND_SOCKET" ]; then
```

Normal Wayland sessions always set `XDG_RUNTIME_DIR`, so this does not affect the tested session.

### P3 — stale verification status in the implementation log

`docs/cross-platform/implementation-log.md` still says `Pending — Sentinel` for completed rows. Exact remediation: update those rows to `Verified — Sentinel, 2026-10-17` and link this report.

## Limitations

1. **No root:** actual `apt`/`dpkg` install, upgrade, configure, and remove were not executed. `postinst`'s real `chown root:root` and the resulting SUID launch were not reproduced end-to-end. The partial fakeroot simulation validates the script's control flow only.
2. **Extracted sandbox ownership:** direct execution from the extraction directory necessarily aborts at the SUID check because the extracted file is owned by `tars`. This is expected and is not evidence against the package; the archive itself records `root/root 4755`.
3. **Wayland window visibility:** window visibility was inferred from `window created` + `ready-to-show` + a live process, not from a compositor-specific window query. `did-finish-load` and `ready-to-show` are direct app-side evidence.
4. **Test-only flag:** all successful GUI runs used `--no-sandbox` injected by the harness solely to bypass the extraction-ownership problem. The packaged launcher and desktop entry do not contain that flag, and the normal path was verified to reject sandbox misconfiguration rather than silently degrade.
5. **Timing variance:** cold timings are dominated by one-time cache/font/shader initialization in a fresh `HOME`; warm timings are reported separately.

## Handoff

- **Verdict: PASS** (independent re-verification; expected SHA256 reproduced twice).
- **P0:** none.
- **P1:** none.
- **P2:** cold-profile `ready-to-show` 2.26–2.34 s exceeds the 1.5 s assertion (warm 0.37–0.39 s passes).
- **P3:** absolute `WAYLAND_DISPLAY` + unset `XDG_RUNTIME_DIR` falls back to X11 despite a live socket; stale "Pending — Sentinel" status text in `docs/cross-platform/implementation-log.md`.
- **Remains unverified:** real root install/upgrade/remove, postinst's real `chown`/SUID launch under `/opt/autoagent`, and direct window-manager visibility under the nested Wayland compositor.
- **Safe to apply:** yes. The artifact is deterministic, dependency-clean, leak-free, has exactly one correctly-rooted setuid helper, selects Wayland only with a live socket (and passes the ozone flag), falls back cleanly to X11, and shows no GPU context-loss storm. The P2/P3 items are non-blocking improvements.

## Cleanup

All test processes (Electron, nested `gnome-shell`, `dbus-run-session`, Python socket listeners) were terminated and verified absent; the temporary tree and build logs were removed.

---

# Post-fix re-check (2026-10-17)

Targeted re-evaluation after Anvil changed only `packaging/deb/usr/bin/autoagent` line 25 from `if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -S "$WAYLAND_SOCKET" ]; then` to `if [ -S "$WAYLAND_SOCKET" ]; then`. Everything below was independently re-run from scratch; the previous findings above are retained unchanged except for the P3 launcher status now marked RESOLVED.

## New artifact

| Item | Value |
|---|---|
| Path | `/home/tars/yysapp/AutoAgent/release/autoagent_0.8.0_amd64.deb` |
| Size | 109,712,608 bytes |
| SHA256 | `b43f51624d5c1ef7642fc13630a15d7e274b03f206af02469f766c02b035ebc9` |
| Expected SHA256 | `b43f51624d5c1ef7642fc13630a15d7e274b03f206af02469f766c02b035ebc9` |
| Match | YES |

## 1. Packaged launcher

Extracted with `dpkg-deb -x` and compared byte-for-byte with the source template:

- Packaged launcher SHA256 `6564b97ac3267e8ae64c23b87ce17467d83cd4e514c95c245702c347950f9efc` equals the source `packaging/deb/usr/bin/autoagent`.
- Packaged line 25: `  if [ -S "$WAYLAND_SOCKET" ]; then` (the new condition).
- `grep -n -- '--no-sandbox\|npx\|PATH'` on the packaged launcher: no matches.
- Modes: launcher 755, `chrome-sandbox` 4755, Electron/bun/rg 755.

## 2. Launcher stub matrix (re-run)

| Case | Environment | Exit | Result |
|---|---|---|---|
| 1 (the former P3) | absolute `WAYLAND_DISPLAY` to live Unix socket, `XDG_RUNTIME_DIR` **unset**, `DISPLAY=:99` | 0 | `--ozone-platform=wayland` + app path; log says Wayland; **P3 fixed** |
| 2 | relative live socket + `XDG_RUNTIME_DIR`, `DISPLAY=:99` | 0 | `--ozone-platform=wayland`; Wayland chosen |
| 3 | missing socket + `DISPLAY=:99` | 0 | X11 chosen; no ozone flag; fallback logged |
| 4 | no `DISPLAY`, no `WAYLAND_DISPLAY` | 1 | Clear "no display available" error; stub not invoked |
| 5 | missing runtime | 1 | Clear missing-Electron error; stub not invoked |
| 6 | absolute live socket, `DISPLAY` unset | 0 | `--ozone-platform=wayland`; Wayland chosen |

**P3 launcher defect: RESOLVED.** No new launcher regressions.

## 3. Determinism and packaging re-audit

| Check | Result |
|---|---|
| Rebuild (`timeout 900 bash scripts/build-deb.sh`) | exit 0, 34 s |
| SHA before rebuild | `b43f5162...035ebc9` |
| SHA after rebuild | `b43f5162...035ebc9` |
| Determinism | SAME (matches expected) |
| Size after rebuild | 109,712,608 bytes |
| Package / Arch / Version | `autoagent` / `amd64` / `0.8.0` |
| Setuid paths | exactly 1: `-rwsr-xr-x root/root 15248 ./opt/autoagent/desktop/chrome-sandbox` |
| Forbidden deps (`nodejs\|npm\|python3\|build-essential\|unzip`) | none |
| Forbidden paths (`node_modules`, `*.map`, `.git`, `default_app.asar`, `*.ts[x]`) | none |
| Locales | only `en-US.pak`, `zh-CN.pak` |
| `ldd` missing libraries | none |

## 4. Runtime regression

Sandbox caveat unchanged: extraction produces a `chrome-sandbox` owned by the current user, so the packaged argv correctly aborts at the SUID check; the GUI runs below used a test-harness-only appended `--no-sandbox` (not a packaging claim).

| Session | Evidence | Result |
|---|---|---|
| X11 (`DISPLAY=:1`) | Normal path: exit 133 with the expected SUID FATAL. Test-only run: window `0x8000004 "AutoAgent": ("autoagent" "autoagent") 1200x870`; `did-finish-load` 605 ms; `ready-to-show` 2230 ms (cold, same P2 as before); GPU error count 0 | PASS |
| Wayland (nested gnome-shell 46.2) | `wayland-0` ready in 0.3 s; argv contains `--ozone-platform=wayland`; `did-finish-load` 665 ms; `ready-to-show` 870 ms; `Context lost\|MakeCurrent\|OzoneImageBacking` count 0 over 10 s; FATAL count 0 | PASS |

## Post-fix verdict

- **New hash reproduced:** yes (`b43f51624d5c1ef7642fc13630a15d7e274b03f206af02469f766c02b035ebc9`, byte-identical on rebuild).
- **P3 resolved:** yes; the absolute-`WAYLAND_DISPLAY` live-socket case now execs with `--ozone-platform=wayland`.
- **Regression:** PASS (X11 window appears with 0 GPU errors; Wayland uses the ozone flag with 0 context-loss errors; deterministic rebuild and packaging invariants unchanged).
- **Final verdict: PASS.** No P0/P1. The previously reported P2 (cold-profile `ready-to-show` ~2.23–2.34 s) remains, non-blocking; the unrelated P3 documentation-status item remains. Root-only install/upgrade/remove is still unverified (no root).

## Re-check cleanup

All Electron, nested `gnome-shell`, `dbus-run-session`, and Python socket-listener processes were terminated and verified absent; the temporary re-check tree and build log were removed. No project file was modified except this report.
