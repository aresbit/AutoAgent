# Linux Packaging Playbook: AutoAgent to maxwire-style

Status: blueprint. Nothing in this document is a claim that the target build already works.
Verified-now facts and "to verify in T12" items are labelled explicitly.

Scope: Linux x86_64, Ubuntu 24.04. Reference implementation: `/home/tars/yysapp/maxwire`.
Target implementation: `/home/tars/yysapp/AutoAgent`.

## 0. Evidence baseline

Commands run on 2026-10-17 against the current tree:

| Check | Result |
|---|---|
| Host | Ubuntu 24.04.5 LTS, x86_64, dpkg-deb 1.22.6 |
| `desktop-file-validate packaging/deb/usr/share/applications/autoagent.desktop` | exit 0 |
| `sh -n packaging/deb/usr/bin/autoagent` | exit 0 |
| `sh -n packaging/deb/DEBIAN/postinst` | exit 0 |
| `bash -n scripts/build-deb.sh` | exit 0 |
| Locked Electron version (`bun.lock`) | 41.3.0 |
| `packaging/deb/usr/lib/autoagent/electron-dist/` | absent |
| Size of committed staging tree | 127 MiB |
| `git ls-files packaging/` | includes `usr/lib/autoagent/bun` even though `.gitignore` lists it |

Runtime evidence collected by Atlas lives in `docs/cross-platform/evidence/`:

- `sandbox-fatal.log`: launching without `--no-sandbox` aborts because
  `/usr/lib/autoagent/electron-dist/chrome-sandbox` is not root-owned/4755.
- `wayland-explicit.log`: forcing `--ozone-platform=wayland` fails when no Wayland
  display exists. The launcher must choose Wayland only when `WAYLAND_DISPLAY` is set.
- `x11-*.log`: X11 starts successfully; GPU-related flags are Atlas's call, not this
  document's.

## 1. Current vs maxwire-style target

| Concern | Current AutoAgent | maxwire-style target |
|---|---|---|
| Install root | `/usr/lib/autoagent` (mixed JS, runtime, engine, icons) | `/opt/autoagent/{engine,desktop}`; `/opt` is root-owned |
| Electron | Resolved from system/npx/node_modules; no checksum; not in staged tree | Pinned zip extracted into `/opt/autoagent/desktop`; SHA256 checked |
| Launcher | `find_electron` + `--no-sandbox`, unquoted `$ELECTRON`, `npx electron` fallback | Fixed absolute path, `exec`, no `--no-sandbox`, no system fallback |
| Sandbox | `chrome-sandbox` chmod 755; workaround is `--no-sandbox` | `chrome-sandbox` root:root 4755; postinst verifies; sandbox stays on |
| Build staging | Mutates `packaging/deb` in place; stale files survive | Fresh `mktemp -d` stage; only allowlisted payload; trap cleanup |
| Version authority | 4 conflicting values: `package.json` 0.8.0, `control` 0.8.1, runtime `package.json` 0.2.0, `build-deb.sh` default 0.2.0 | `package.json.version` is the only source; generated into control/app/manifest |
| Metadata | `Suggests: npm, nodejs`; no explicit runtime deps | Explicit Ubuntu 24.04 `Depends`; no build tools |
| preinst | Missing | Stops legacy processes under old/new install roots only |
| postinst | Icon/desktop cache only | Sandbox ownership/mode + hard verification + caches |
| postrm | Missing | Cache refresh only; never touches user data |
| Desktop entry | Missing `TryExec`, `DBusActivatable`, `StartupNotify` | Full entry; validates with `desktop-file-validate` |
| Logs | `$HOME/.local/share/autoagent/autoagent.log` | `$XDG_STATE_HOME/autoagent/logs/desktop.log` |
| Output | `dist/autoagent_<v>_amd64.deb` | `release/autoagent_<v>_amd64.deb` + `.sha256` |
| Publish scripts | Expect `dist/deb/..._all.deb` (never produced) | Consume `release/..._amd64.deb` |
| Update manifest | None | `release/latest.json` with sha512; preserve prior platform entries |

## 2. Exact target filesystem layout

```
/opt/autoagent/                                  root:root 755
├── engine/                                      root:root 755
│   ├── bun                                      root:root 755   (stripped)
│   ├── rg                                       root:root 755   (stripped)
│   └── cli.js                                   root:root 644
└── desktop/                                     root:root 755
    ├── electron                                 root:root 755
    ├── chrome-sandbox                           root:root 4755
    ├── chrome_crashpad_handler                  root:root 755
    ├── lib*.so, *.pak, icudtl.dat, ...          root:root 644
    ├── locales/                                 root:root 755
    │   ├── en-US.pak                            root:root 644
    │   └── zh-CN.pak                            root:root 644
    └── resources/
        └── app/                                 root:root 755
            ├── package.json                     root:root 644
            ├── main.js                          root:root 644
            ├── preload.cjs                      root:root 644
            ├── artifact-preload.cjs             root:root 644
            ├── icon.png                         root:root 644
            ├── client/                          root:root 755
            │   ├── index.html                   root:root 644
            │   ├── app.js                       root:root 644
            │   └── style.css                    root:root 644
            └── autowork/assets/upstream/*.md    root:root 644
/usr/bin/autoagent                               root:root 755
/usr/share/applications/autoagent.desktop        root:root 644
/usr/share/icons/hicolor/<size>x<size>/apps/autoagent.png  root:root 644
/usr/share/pixmaps/autoagent.png                 root:root 644 (optional)
/usr/share/doc/autoagent/copyright               root:root 644
```

Rules:

- `main.js` must be the app entry referenced by
  `/opt/autoagent/desktop/resources/app/package.json` (`"main": "main.js"`).
- `bun`, `rg`, `cli.js` live in `engine/` so they are visibly runtime data, not app
  assets. `src/runtime-paths.ts` must resolve them from `AUTOAGENT_ENGINE_DIR`
  (set by the launcher) or `/opt/autoagent/engine`.
- No `node_modules`, source maps, tests, `.git`, `*.ts`, or build caches may enter
  the package.
- Do not ship `resources/default_app.asar`.
- Keep `LICENSES.chromium.html` and Electron license files for compliance.

Launcher (`/usr/bin/autoagent`):

```sh
#!/bin/sh
set -eu
umask 077

APP_DIR="${AUTOAGENT_APP_DIR:-/opt/autoagent}"
ELECTRON="$APP_DIR/desktop/electron"
DESKTOP_APP="$APP_DIR/desktop/resources/app"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/autoagent"
LOG_DIR="$STATE_HOME/logs"

export AUTOAGENT_ENGINE_DIR="${AUTOAGENT_ENGINE_DIR:-$APP_DIR/engine}"

[ -x "$ELECTRON" ] || { echo "AutoAgent: missing $ELECTRON" >&2; exit 1; }
[ -f "$DESKTOP_APP/main.js" ] || { echo "AutoAgent: missing $DESKTOP_APP/main.js" >&2; exit 1; }

mkdir -p "$LOG_DIR"
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  exec "$ELECTRON" --ozone-platform=wayland "$DESKTOP_APP" "$@" \
    >>"$LOG_DIR/desktop.log" 2>&1
fi
exec "$ELECTRON" "$DESKTOP_APP" "$@" >>"$LOG_DIR/desktop.log" 2>&1
```

Why this shape:

- `exec` means signals and exit status belong to Electron, matching maxwire's intent.
- Wayland is selected only when `WAYLAND_DISPLAY` is non-empty; this avoids the
  `wayland-explicit.log` failure on X11/headless sessions.
- No `--no-sandbox`, no `npx`, no PATH search. A missing runtime is a packaging bug,
  not something to paper over at launch time.

## 3. Permission matrix

| Path | Owner:group | Mode |
|---|---|---|
| `/opt` | root:root | 755 |
| `/opt/autoagent` | root:root | 755 |
| `/opt/autoagent/engine` | root:root | 755 |
| `/opt/autoagent/engine/bun` | root:root | 755 |
| `/opt/autoagent/engine/rg` | root:root | 755 |
| `/opt/autoagent/engine/cli.js` | root:root | 644 |
| `/opt/autoagent/desktop` | root:root | 755 |
| `/opt/autoagent/desktop/electron` | root:root | 755 |
| `/opt/autoagent/desktop/chrome-sandbox` | root:root | **4755** |
| `/opt/autoagent/desktop/chrome_crashpad_handler` | root:root | 755 |
| `/opt/autoagent/desktop/*.so`, `*.pak`, data files | root:root | 644 |
| `/opt/autoagent/desktop/resources/app/**` (dirs) | root:root | 755 |
| `/opt/autoagent/desktop/resources/app/**` (files) | root:root | 644 |
| `/usr/bin/autoagent` | root:root | 755 |
| `/usr/share/applications/autoagent.desktop` | root:root | 644 |
| `/usr/share/icons/hicolor/**/autoagent.png` | root:root | 644 |
| `DEBIAN/control` | root:root | 644 |
| `DEBIAN/{preinst,postinst,prerm,postrm}` | root:root | 755 |

Rules:

- Exactly one setuid file: `chrome-sandbox` (4755). Nothing else may be setuid.
- `dpkg-deb --root-owner-group` supplies root ownership; do not run
  `chown -R root:root` on the build workspace.
- Re-apply 4755 in postinst because archive extraction by some tools and non-root
  build hosts can lose the bit.
- All directories 755, all regular data files 644, executables 755. Avoid `a+rwX`.

## 4. Ubuntu 24.04 dependency set

Target `Depends` line (one logical line in `DEBIAN/control`):

```
Depends: libc6 (>= 2.38), libgtk-3-0t64 | libgtk-3-0, libatk1.0-0t64 | libatk1.0-0, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatspi2.0-0t64 | libatspi2.0-0, libcairo2, libcups2t64 | libcups2, libdrm2, libgbm1, libnss3, libpango-1.0-0, libx11-6, libxcomposite1, libxdamage1, libxfixes3, libxkbcommon0, libxrandr2, libxss1, libxtst6, libasound2t64 | libasound2, libnotify4, xdg-utils
```

Notes:

- The `t64` alternates are the Ubuntu 24.04 time_t transition names; keep the
  fallback names for derivative/sid compatibility, exactly as maxwire does.
- `xdg-utils` is a real runtime dependency (desktop integration/openExternal).
- `libnotify4` is required for native notifications used by the desktop app.
- This list is the blueprint baseline. T12 must confirm with:
  `ldd /opt/autoagent/desktop/electron | grep 'not found'` and
  `apt-get -s install ./release/autoagent_<v>_amd64.deb`.

Must **not** be runtime dependencies:

- `nodejs`, `npm`, `bun`, `electron`, `typescript`, `ripgrep` (the system package),
  `python3`.
- `build-essential`, `gcc`, `g++`, `make`, `pkg-config`, any `*-dev` package,
  `unzip`, `curl`, `wget`, `git`, `rsync`, `jq`, `dpkg-dev`, `xz-utils`.
- `Suggests: npm, nodejs` must be removed. The current control has it.

## 5. Maintainer scripts

### preinst (new file)

Purpose: stop processes from the old install before files are replaced. Scope is
strictly "executable resolves under `/usr/lib/autoagent` or `/opt/autoagent`".

```sh
#!/bin/sh
set -e

process_is_ours() {
  [ -r "/proc/$1/exe" ] || return 1
  exe="$(readlink -f "/proc/$1/exe" 2>/dev/null)" || return 1
  case "$exe" in
    /usr/lib/autoagent/*|/opt/autoagent/*) return 0 ;;
    *) return 1 ;;
  esac
}

stop_ours() {
  signal="$1"
  for proc_dir in /proc/[0-9]*; do
    pid="${proc_dir#/proc/}"
    [ "$pid" = "$$" ] && continue
    process_is_ours "$pid" || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

stop_ours TERM
sleep 1
stop_ours KILL
exit 0
```

Do not kill by process name alone: other Electron apps also use `electron`.

### postinst

```sh
#!/bin/sh
set -e

SANDBOX=/opt/autoagent/desktop/chrome-sandbox

if [ ! -f "$SANDBOX" ]; then
  echo "AutoAgent: missing $SANDBOX" >&2
  exit 1
fi
if [ -L "$SANDBOX" ]; then
  echo "AutoAgent: refusing symlinked chrome-sandbox: $SANDBOX" >&2
  exit 1
fi

chown root:root "$SANDBOX"
chmod 4755 "$SANDBOX"

if [ ! -u "$SANDBOX" ]; then
  echo "AutoAgent: chrome-sandbox is not setuid after chmod 4755." >&2
  echo "  Cause is usually a nosuid filesystem or a stripped archive." >&2
  echo "  Fix the mount/permissions, then run: sudo dpkg --configure -a" >&2
  exit 1
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

# Legacy layout from <=0.8.x. dpkg removes files it owned; report leftovers
# instead of deleting a directory that may contain operator-created content.
if [ -d /usr/lib/autoagent ]; then
  echo "AutoAgent: legacy /usr/lib/autoagent remains; review and remove it manually." >&2
fi

exit 0
```

Fail loudly: a package that installs but cannot launch Electron with the sandbox is
worse than a failed configuration step.

### prerm (recommended, new file)

Terminate remaining `/opt/autoagent` processes before removal/upgrade. Same scoped
`process_is_ours` helper as preinst, TERM only. No KILL needed here; preinst has the
KILL fallback for upgrades.

### postrm

```sh
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
```

Never delete `~/.config/autoagent`, `~/.local/share/autoagent`, `~/.autoagent`, or
`~/.claude` on removal.

## 6. Desktop entry

```
[Desktop Entry]
Type=Application
Version=1.0
Name=AutoAgent
GenericName=AI Coding Agent
Comment=AI-powered coding agent desktop
Comment[zh_CN]=AI 编程助手桌面端
Exec=/usr/bin/autoagent
TryExec=/usr/bin/autoagent
Icon=autoagent
Terminal=false
DBusActivatable=false
StartupNotify=true
StartupWMClass=autoagent
Categories=Development;IDE;
Keywords=AI;agent;code;LLM;Claude;
```

Requirements:

- `TryExec` must point at the launcher so the entry disappears from menus if the
  package is half-removed.
- `DBusActivatable=false` because there is no D-Bus service file. Leaving it unset
  can make some launchers wait for a name that never appears.
- `StartupNotify=true` is correct; the app creates its window after a short delay.
- `StartupWMClass=autoagent` must match the X11 WM_CLASS produced by
  `app.setName('autoagent')`. Verify with `xprop WM_CLASS` in T12.
- Wayland uses the desktop file name. `src/main.ts` currently calls
  `app.setDesktopName('autoagent')`; change it to `'autoagent.desktop'` and verify
  under a real Wayland session in T12.
- `desktop-file-validate` must stay at exit 0.

## 7. Build pipeline design

Single entry point: `scripts/build-deb.sh`. It is a builder, not a workspace mutator.

### Preflight

```bash
set -euo pipefail
command -v bun >/dev/null
command -v dpkg-deb >/dev/null
command -v unzip >/dev/null
command -v sha256sum >/dev/null
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]
bun install --frozen-lockfile
```

### Version

```bash
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
case "$VERSION" in *[!0-9.+~-]*|'') echo "invalid version: $VERSION" >&2; exit 1 ;; esac
```

No positional version argument. Optional `--version` must equal `package.json`; any
mismatch is a hard failure. Generated values (control, runtime `package.json`,
manifest) all come from this one variable.

### Electron runtime

```bash
ELECTRON_VERSION="41.3.0"
ELECTRON_ZIP="${PROJECT_DIR}/build-resources/electron-v${ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_SHA256="<fill with sha256sum of the official v41.3.0 linux-x64 zip>"
```

Rules:

- Download or vendor the official zip; do not copy an unverified `node_modules/electron/dist`.
- Refuse to build if the file is absent or the SHA256 differs.
- Extract with a path-traversal guard (reject members whose resolved path escapes
  the destination), as `tools/package_deb.py` does.
- Keep `electron`, `chrome_crashpad_handler`, `chrome-sandbox`; prune locales to
  `en-US.pak` and `zh-CN.pak`; delete `resources/default_app.asar`.
- Do not `strip` Electron or Chromium helper binaries.

`sha256sum` value: **to verify in T12** by downloading the official
`v41.3.0/electron-v41.3.0-linux-x64.zip` and recording the digest in the script.
Do not invent a digest.

### Staging

```bash
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/opt/autoagent/engine" \
         "$STAGE/opt/autoagent/desktop/resources/app" \
         "$STAGE/usr/bin" \
         "$STAGE/usr/share/applications" \
         "$STAGE/usr/share/icons/hicolor"
```

Then, in order:

1. `bun run build:desktop`.
2. Install `dist/main.js`, `dist/preload.cjs`, `dist/artifact-preload.cjs`,
   `dist/client/`, `dist/autowork/assets/`, `assets/icon.png` into
   `resources/app/`.
3. Install `packages/opencc/dist/cli.js` into `engine/cli.js`.
4. Install bundled `bun` into `engine/bun`; install `rg` into `engine/rg`.
5. Generate `resources/app/package.json`:
   `{"name":"autoagent","version":"<VERSION>","type":"module","main":"main.js"}`.
6. Extract Electron into `desktop/`; prune; set modes.
7. Install launcher, desktop entry, icons, copyright.
8. Generate `DEBIAN/control` from the template with `Version`, `Installed-Size`.
9. Install maintainer scripts.
10. Normalize permissions (section 3).

No `rsync` requirement; `cp -a`/`install` is enough and is present everywhere.

### Determinism

```bash
export TZ=UTC
export LC_ALL=C
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
find "$STAGE" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +
dpkg-deb --root-owner-group --uniform-compression -Zxz \
  --build "$STAGE" "$OUTPUT_DIR/autoagent_${VERSION}_amd64.deb"
```

- `--root-owner-group` replaces the current `chown -R root:root`.
- Explicit `-Zxz` avoids host/default-compressor drift.
- Normalize mtimes before packaging.
- Emit `autoagent_<version>_amd64.deb.sha256`.

### Leakage checks

Before `dpkg-deb`:

```bash
! find "$STAGE" \( -name node_modules -o -name '*.map' -o -name '.git*' \
    -o -name '*.ts' -o -name '*.tsx' \) -print -quit | grep -q .
! grep -R -- '--no-sandbox' "$STAGE/usr/bin" "$STAGE/opt"
```

After `dpkg-deb`:

```bash
! dpkg-deb -f "$DEB" Depends | grep -E 'nodejs|npm|python3|build-essential|unzip'
```

### Artifact naming

```
release/autoagent_<VERSION>_amd64.deb
release/autoagent_<VERSION>_amd64.deb.sha256
release/latest.json
```

`amd64`, not `all`: the payload contains x86_64 ELF binaries.

### Update manifest

AutoAgent has no updater today. Generate the manifest anyway as release metadata,
using the maxwire rules:

```json
{
  "version": "0.8.0",
  "notes": "",
  "linux": {
    "fileName": "autoagent_0.8.0_amd64.deb",
    "sha512": "<hex>",
    "version": "0.8.0"
  }
}
```

- Stream-hash the file with SHA-512 (do not load the deb into memory).
- Refuse to generate when the manifest version, `package.json`, generated control,
  and runtime `package.json` disagree.
- When regenerating on a machine that only built one platform, preserve the
  previous entry for the missing platform instead of emitting a partial manifest.
- If a silent self-updater is later required, copy maxwire's model
  (`/usr/bin/autoagent-update` + a narrowly scoped polkit rule that validates
  sha512 and `Package: autoagent`). Do not add it in this refactor.

## 8. Migration checklist (ordered by risk)

| # | Risk | Change | Verification | Rollback |
|---|---|---|---|---|
| 1 | Losing a working build while removing committed artifacts | Stop committing `packaging/deb/usr/lib/autoagent/*` and Electron-free staging output; build into `release/` | `git ls-files packaging` contains only source-controlled packaging files | `git checkout <tag> -- packaging/`; old deb remains in release |
| 2 | Launcher cannot start (sandbox/Wayland) | Rewrite launcher; fix chrome-sandbox | Run X11 and Wayland sessions; `xprop WM_CLASS`; no `--no-sandbox` in process args | Reinstall previous `.deb` |
| 3 | Path migration breaks engine lookup | Move to `/opt/autoagent/{engine,desktop}`; update `runtime-paths.ts` | Launch, send one prompt; `ps` shows `/opt/autoagent/engine/bun .../cli.js` | Reinstall previous `.deb`; old path restored |
| 4 | Missing/incorrect dependencies | Replace `Suggests` with explicit `Depends` | `apt-get -s install ./deb`; `ldd ... | grep 'not found'` | Reinstall previous `.deb` |
| 5 | Maintainer scripts break install/upgrade | Add preinst/postinst/prerm/postrm | Fresh install, upgrade-with-app-running, remove | `sudo dpkg --configure -a`; reinstall previous `.deb` |
| 6 | preinst kills unrelated processes | Scope by `/proc/PID/exe` prefix | Run an unrelated Electron app during upgrade | Reinstall previous `.deb`; fix scope before retry |
| 7 | Version drift | Single version source + hard assertions | `grep -R '0\.2\.0\|0\.8\.1' packaging dist` returns nothing stale | Revert version commit |
| 8 | Desktop integration (icons/WM class) | New `.desktop`, `setDesktopName` | `desktop-file-validate`; icon visible; taskbar groups correctly | Reinstall previous `.deb` |
| 9 | Publish/apt scripts reference old artifact names | Update `publish.sh`, `setup-apt-repo.sh` | Dry-run `publish.sh --dry-run`; `dpkg-scanpackages` | Revert scripts |

Release gate: steps 1-8 must pass before `publish.sh` is used.

Rollback procedure:

```bash
# Keep the previous artifact in release/ before starting.
sudo apt install --allow-downgrades ./release/autoagent_<old-version>_amd64.deb
sudo dpkg --configure -a
```

User data under `$HOME` is never touched by install, upgrade, or removal, so a
rollback restores the previous binary without a data migration.

## 9. Verification commands (completion gate)

```bash
set -euo pipefail
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
DEB="release/autoagent_${VERSION}_amd64.deb"

test -f "$DEB"
dpkg-deb --info "$DEB"
dpkg-deb -f "$DEB" Package           # autoagent
dpkg-deb -f "$DEB" Architecture      # amd64
dpkg-deb -f "$DEB" Version           # $VERSION
dpkg-deb -f "$DEB" Depends | grep -Ev 'nodejs|npm|python3|build-essential|unzip'

# Exactly one SUID file, the sandbox helper.
dpkg-deb -c "$DEB" | awk '$1 ~ /^-..s/ {print}'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
dpkg-deb -x "$DEB" "$TMP"

test -x "$TMP/opt/autoagent/desktop/electron"
test -x "$TMP/opt/autoagent/engine/bun"
test -x "$TMP/opt/autoagent/engine/rg"
test -f "$TMP/opt/autoagent/engine/cli.js"
test -f "$TMP/opt/autoagent/desktop/resources/app/main.js"
test ! -e "$TMP/opt/autoagent/desktop/resources/default_app.asar"
test -f "$TMP/usr/share/applications/autoagent.desktop"

desktop-file-validate "$TMP/usr/share/applications/autoagent.desktop"
! find "$TMP" \( -name node_modules -o -name '*.map' -o -name '.git*' \) -print -quit | grep -q .
! ldd "$TMP/opt/autoagent/desktop/electron" | grep -q 'not found'

apt-get -s install "./$DEB" >/dev/null
```

Install/upgrade/remove:

```bash
sudo apt install "./release/autoagent_${VERSION}_amd64.deb"
test -u /opt/autoagent/desktop/chrome-sandbox
pgrep -af '/opt/autoagent/desktop/electron'
# launch from menu and from a terminal; confirm no --no-sandbox in pgrep output
sudo apt remove autoagent
test ! -e /usr/bin/autoagent
test -d "$HOME/.config/autoagent"   # user data preserved
```

Mark as **to verify in T12** until executed on both X11 and Wayland:

- Electron 41.3.0 zip SHA256 value.
- `ldd` dependency completeness on a clean Ubuntu 24.04 container/VM.
- `StartupWMClass` / `setDesktopName('autoagent.desktop')` matching.
- Upgrade while the old app is running.
- Wayland launch without forcing the platform on X11.
- Performance effect of removing the Linux `in-process-gpu` switch (Atlas owns it).

## 10. Skill-to-insight mapping

| Insight used here | Source skill | How it was applied |
|---|---|---|
| Kill latency; no artificial fallback/probing on the launch path | `apple-design/SKILL.md` §1 | Launcher `exec`s one known binary; no `npx`/PATH search; logs are written once |
| Reduced-motion and accessibility are non-negotiable, but feedback remains | `apple-design/SKILL.md` §14 | No splash/animation added; installer failures are explicit text, not silent; desktop entry remains keyboard/menu reachable |
| Craft and predictability: same cause, same result | `apple-design/SKILL.md` §16 | Fixed layout, one version source, deterministic modes/ownership |
| No gratuitous UI redesign | `apple-design`, `elegant-claude-skill` | Packaging-only refactor; `main.ts` changes limited to startup identity/flags |
| UI don'ts: no infinite spinner, no decorative motion, no internal ticket IDs in user-facing text | `elegant-claude-skill/SKILL.md` §"必须默认植入" and "代码卫生" | Installer/log messages are plain, actionable, and contain no ticket IDs; no loading UI added |
| Single exit surface / one source of truth | `elegant-claude-skill/SKILL.md` §"代码卫生" | One launcher, one app entry, one version source, one manifest generator |
| Declarative packaging and single metadata source | `modern-python-skill/reference/ch08` §4.10 | `package.json` is authoritative; control/runtime package.json generated, not hand-edited |
| Lock dependencies and record a manifest | `modern-python-skill/reference/ch15` §2.6 | `bun install --frozen-lockfile`; Electron zip SHA256; deb SHA256/SHA512 manifest |
| Functional core / imperative shell; fail fast | `modern-python-skill/reference/ch15` §2.4 | Thin shell launcher; postinst exits non-zero instead of silently degrading the sandbox |
| Logs to stderr/state, results to stdout; don't only log failures | `modern-python-skill/reference/ch15` §2.8 | Launcher logs to XDG state; postinst prints explicit remediation; deb build prints artifact digest |
| Build produces a deployable `dist/`, verified before deploy | `webapp-building/SKILL.md` §3-4 | Fresh stage → artifact → `dpkg-deb --info/-c` and extraction checks before release |
| Minification/tree-shaking counterpart for packaging | `webapp-building/SKILL.md` §3 | Prune Electron locales, remove `default_app.asar`, ship only allowlisted JS/assets |

## 11. Explicit non-goals

- No redesign of the renderer or app UI.
- No change to the agent engine protocol or session format.
- No adoption of electron-builder for Linux. Keep the custom `.deb` pipeline: it is
  the only way to control `/opt`, SUID `chrome-sandbox`, maintainer scripts, and
  exact payload pruning. `package.json.build` stays Windows-only.
- No silent auto-updater unless a separate requirement asks for it.
