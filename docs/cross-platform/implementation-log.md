# Implementation log

Target: `/opt/autoagent` layout, sandbox enabled, no `in-process-gpu` on Linux,
window shown on `ready-to-show`. Source edit intent:
[source-change-list.md](source-change-list.md). Playbook:
[packaging-playbook.md](packaging-playbook.md).

Sentinel's full independent report is [evaluation.md](evaluation.md). The targeted
post-fix re-check landed on 2026-10-17 with **final verdict PASS**; P3 is resolved
and the artifact reproduced byte-identically. The final artifact is
`/home/tars/yysapp/AutoAgent/release/autoagent_0.8.0_amd64.deb`,
SHA256 `b43f51624d5c1ef7642fc13630a15d7e274b03f206af02469f766c02b035ebc9`,
size 109,712,608 bytes.

All rows below are `Verified — Sentinel` except root-only
install/upgrade/remove, which remains unverified because the evaluation had no
root. P2 cold-start timing remains a non-blocking open finding.

## Files and changes

| File | Intended change | Owner | Verification status |
|---|---|---|---|
| `/home/tars/yysapp/AutoAgent/src/main.ts` | Remove the Linux `app.commandLine.appendSwitch('in-process-gpu')` block (lines ~311-313); keep Windows flags unchanged. Change `app.setDesktopName('autoagent')` to `app.setDesktopName('autoagent.desktop')`. Create the main window with `show: false` and show it on `ready-to-show`. | Kiln | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/src/runtime-paths.ts` | Resolve an engine directory from `AUTOAGENT_ENGINE_DIR`, defaulting to `/opt/autoagent/engine` on Linux. Use it for `bun`, `rg`, and `cli.js` before legacy `/usr/lib/autoagent` fallbacks. Keep all existing development and Windows candidates. | Kiln | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/scripts/build-deb.sh` | Rewrite: single version source (root `package.json`, `amd64`), pinned Electron 41.3.0 archive with SHA256, fresh `mktemp -d` stage, stage `/opt/autoagent/{engine,desktop}`, prune locales and `default_app.asar`, generate control/app `package.json`, run in-build assertions, emit `release/autoagent_<version>_amd64.deb` and `.sha256`. Do not mutate `packaging/deb/`. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/usr/bin/autoagent` | Fixed `/opt/autoagent/desktop/electron`, `AUTOAGENT_ENGINE_DIR=/opt/autoagent/engine`, Wayland only when `WAYLAND_DISPLAY` is set, quoted `exec`, XDG state log, no `--no-sandbox`, no `npx`/PATH fallback. **P3 resolved (independently re-verified):** an absolute `WAYLAND_DISPLAY` is accepted without requiring `XDG_RUNTIME_DIR`, and a missing socket falls back to X11 when `DISPLAY` is set. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/DEBIAN/control` | `amd64`; explicit Ubuntu 24.04 `Depends` with `t64` alternatives; remove `Suggests: npm, nodejs`; generated `Version`/`Installed-Size`; no runtime `nodejs`/`npm`/`bun`/`electron`/`python3`/build tools. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/DEBIAN/preinst` | New. Stop only processes whose `/proc/PID/exe` resolves under `/usr/lib/autoagent` or `/opt/autoagent`: TERM, sleep 1, KILL. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/DEBIAN/postinst` | `chown root:root` and `chmod 4755` the sandbox, refuse symlinks, hard-fail if not setuid, refresh desktop/icon caches, warn about legacy `/usr/lib/autoagent`. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/DEBIAN/prerm` | New. Scoped TERM cleanup of `/opt/autoagent` processes before upgrade/remove. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/DEBIAN/postrm` | New. Refresh desktop/icon caches only; never delete user data under `$HOME`. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/usr/share/applications/autoagent.desktop` | Add `TryExec`, `DBusActivatable=false`, `StartupNotify=true`, `GenericName`, zh_CN comment; keep `StartupWMClass=autoagent`; pass `desktop-file-validate`. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/usr/lib/autoagent/` | Stop tracking generated runtime artifacts (Bun, `cli.js`, JS bundles, icons, app `package.json`); build stages these instead. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/packaging/deb/usr/share/icons/hicolor/` | Stop tracking duplicate PNGs; generate from `assets/` during the build. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/package.json` | Add `package:deb` script only. Keep the custom `.deb` pipeline and Windows targets unchanged; `version` remains the single authority. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/scripts/publish.sh` | Publish `release/autoagent_<version>_amd64.deb` and `.sha256`; remove `sed -i` on `control` and the `all`-arch name. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/scripts/setup-apt-repo.sh` | Index from `release/`, use `binary-amd64`, set `Architectures: amd64`. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/.gitignore` | Remove obsolete `packaging/deb/usr/lib/autoagent/...` entries once the directory is gone; keep `release/`, `dist/`, `build-resources/`. | Anvil | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/docs/cross-platform/README.md` | Index, rationale, status, open items. | Scribe | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/docs/cross-platform/implementation-log.md` | This file. | Scribe | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/README.md` | Linux installation section: `/opt/autoagent` layout, `autoagent_<version>_amd64.deb`, `sudo apt install ./release/...`. Windows section unchanged. | Scribe | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/yysapp/AutoAgent/RUNTIME_PATHS.md` | Linux packaged layout `/opt/autoagent/{engine,desktop}` and `AUTOAGENT_ENGINE_DIR`; keep Windows/dev layouts. | Scribe | Verified — Sentinel ([evaluation.md](evaluation.md)) |
| `/home/tars/.claude/skills/electron-linux-packaging/SKILL.md` | Installed from `docs/cross-platform/skill-draft/SKILL.md` (248 lines). | Scribe | Verified — Sentinel ([evaluation.md](evaluation.md)) |

## Not expected to change

`src/renderer/**`, `src/preload.ts`, `src/artifact-preload.ts`,
`packages/opencc/**` (except the built `cli.js` consumed by packaging), Windows
`build.win`/NSIS configuration, and user data formats.

## Verification ownership

- Kiln: runtime behavior (GPU switch, `ready-to-show`, engine resolution).
- Anvil: package structure, sandbox mode, dependencies, maintainer scripts,
  reproducible build, desktop integration.
- Sentinel: independent evaluation. It must exercise a clean Ubuntu 24.04
  install on both X11 and Wayland, upgrade with the old app running, and
  uninstall with user data preserved.

Do not edit a status in this table to `Verified` based on a local smoke test.
Record the command and result in the handoff and let Sentinel confirm.

## Rollback

Rollback is a package downgrade; it does not require reverting source files.

```sh
# Reinstall the previously working .deb.
sudo apt install --allow-downgrades ./autoagent_<previous-version>_amd64.deb
```

If apt cannot resolve a downgrade, remove and install explicitly:

```sh
sudo apt remove autoagent
sudo apt install ./autoagent_<previous-version>_amd64.deb
```

Notes:

- The previous package installs under `/usr/lib/autoagent`; the new package
  installs under `/opt/autoagent`. Both paths can coexist during the transition.
  `preinst` only stops processes whose executable resolves under one of those two
  roots.
- User configuration and session data under `$HOME` (for example
  `~/.config/autoagent`, `~/.autoagent`, and any session files) are not package
  payload. Upgrade, downgrade, and removal must not delete them.
- The new launcher writes logs to
  `${XDG_STATE_HOME:-$HOME/.local/state}/autoagent/logs/desktop.log`. The old
  `~/.local/share/autoagent/autoagent.log` is left in place; it is not read by
  the new launcher.
- A rollback restores the previous launcher, which uses `--no-sandbox` and
  system/`npx` Electron discovery. Treat rollback as a temporary recovery step,
  not a fixed state.
