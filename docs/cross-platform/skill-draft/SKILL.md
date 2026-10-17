---
name: electron-linux-packaging
description: Package an Electron (optionally Bun-backed) desktop app for Ubuntu 24.04 on X11 and Wayland with a self-contained /opt layout, SUID chrome-sandbox, explicit runtime dependencies, and a reproducible dpkg-deb pipeline. Use when creating or fixing a .deb for an Electron app, when an app launches only with --no-sandbox, when packaging must not depend on system Node/Electron, or when auditing an existing Debian package for /opt layout, maintainer scripts, desktop integration, and release reproducibility.
---
# Electron Linux Packaging (Ubuntu 24.04, X11 + Wayland)
Goal: one `.deb` that installs the runtime, the Chromium helpers, and the app
payload, launches from the desktop menu with the sandbox enabled, and builds
deterministically. No system Node, Electron, npm, Bun, or Python at runtime.
## Trigger conditions
Use this skill when any of these are true:
- An Electron `.deb` resolves Electron from the system/`npx`, fails with
  `The SUID sandbox helper binary ... is not configured correctly`, or uses
  `--no-sandbox`.
- The app depends on `nodejs`/`npm` at runtime.
- Packaging stages files in-place, or artifacts/checksums are non-deterministic.
- Wayland/X11 window matching, icons, or StartupWMClass are wrong.
Do not use it for Flatpak/Snap/AppImage unless the host policy forbids `.deb`.
## Decision rules
1. **Keep a custom `.deb` builder.** Do not add an electron-builder Linux target
   just to get a deb. electron-builder hides SUID modes, maintainer scripts, and
   exact payload control.
2. **One version authority.** Read the version from the app `package.json`. Generate
   the Debian control version, runtime `package.json`, and manifest from it. Never
   hand-edit a second version.
3. **Self-contained runtime.** Pin the Electron archive by version and SHA256.
   Never copy an unverified `node_modules/electron/dist`, and never fall back to a
   system Electron.
4. **One root.** `/opt/<app>` owns runtime + app. `/usr/bin/<app>` is a thin
   launcher. `/usr/share` owns only desktop integration.
5. **Sandbox on.** `chrome-sandbox` is root:root 4755 and verified in postinst.
   `--no-sandbox` is a bug, not a flag.
6. **Wayland opt-in by session.** Pass `--ozone-platform=wayland` only when
   `WAYLAND_DISPLAY` is set. Forcing Wayland on X11/headless aborts startup.
7. **No build tools at runtime; stage outside the source tree.** If `ldd` or
   `dpkg -f Depends` names a compiler, Node, or Python, the package is wrong.
   `mktemp -d` + trap; the build must leave the repo clean.
## Target layout
```
/opt/<app>/engine/            # optional: bun, rg, cli.js (chmod 755/644)
/opt/<app>/desktop/           # Electron dist
    electron                  755
    chrome-sandbox            4755
    chrome_crashpad_handler   755
    *.so *.pak               644
    locales/{en-US,zh-CN}.pak 644
    resources/app/            # main.js, preload.cjs, client/, assets
        package.json          644  {"main":"main.js","type":"module"}
/usr/bin/<app>                755  launcher
/usr/share/applications/<app>.desktop  644
/usr/share/icons/hicolor/<n>x<n>/apps/<app>.png  644
```

Do not ship `resources/default_app.asar`, `node_modules`, source maps, tests, or
`.git`.

## Launcher

```sh
#!/bin/sh
set -eu
umask 077
APP_DIR="${APP_DIR:-/opt/myapp}"
ELECTRON="$APP_DIR/desktop/electron"
DESKTOP_APP="$APP_DIR/desktop/resources/app"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/myapp"
LOG_DIR="$STATE_HOME/logs"
export MYAPP_ENGINE_DIR="${MYAPP_ENGINE_DIR:-$APP_DIR/engine}"
[ -x "$ELECTRON" ] || { echo "myapp: missing $ELECTRON" >&2; exit 1; }
mkdir -p "$LOG_DIR"
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  exec "$ELECTRON" --ozone-platform=wayland "$DESKTOP_APP" "$@" \
    >>"$LOG_DIR/desktop.log" 2>&1
fi
exec "$ELECTRON" "$DESKTOP_APP" "$@" >>"$LOG_DIR/desktop.log" 2>&1
```

Rules: quote every path; `exec` so signals/exit status belong to Electron; no PATH
search; no `npx`; no `--no-sandbox`.

## Debian control (Ubuntu 24.04)

```
Package: myapp
Version: <from package.json>
Section: devel
Priority: optional
Architecture: amd64
Maintainer: ...
Installed-Size: <generated>
Depends: libc6 (>= 2.38), libgtk-3-0t64 | libgtk-3-0, libatk1.0-0t64 | libatk1.0-0, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatspi2.0-0t64 | libatspi2.0-0, libcairo2, libcups2t64 | libcups2, libdrm2, libgbm1, libnss3, libpango-1.0-0, libx11-6, libxcomposite1, libxdamage1, libxfixes3, libxkbcommon0, libxrandr2, libxss1, libxtst6, libasound2t64 | libasound2, libnotify4, xdg-utils
Description: ...
```

Never depend on: `nodejs`, `npm`, `bun`, `electron`, `python3`, `ripgrep`,
`build-essential`, `*-dev`, `unzip`, `curl`, `wget`, `git`, `rsync`, `jq`,
`dpkg-dev`. Remove `Suggests: npm, nodejs`.

Verify: `ldd /opt/<app>/desktop/electron | grep 'not found'` must be empty, and
`apt-get -s install ./release/<app>_<v>_amd64.deb` must resolve.

## Maintainer scripts

`preinst`: stop only processes whose `/proc/PID/exe` resolves under
`/usr/lib/<app>/*` or `/opt/<app>/*`; TERM, sleep 1, KILL. Never match by process
name alone (other Electron apps exist).

`postinst`:

```sh
#!/bin/sh
set -e
SB=/opt/myapp/desktop/chrome-sandbox
[ -f "$SB" ] && [ ! -L "$SB" ] || { echo "missing/symlinked $SB" >&2; exit 1; }
chown root:root "$SB"
chmod 4755 "$SB"
[ -u "$SB" ] || {
  echo "chrome-sandbox is not setuid; check nosuid mounts" >&2
  echo "then run: sudo dpkg --configure -a" >&2
  exit 1
}
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
exit 0
```

`postrm`: refresh the same two caches. Never delete user config/data.

## Desktop entry

```
[Desktop Entry]
Type=Application
Name=My App
Exec=/usr/bin/myapp
TryExec=/usr/bin/myapp
Icon=myapp
Terminal=false
DBusActivatable=false
StartupNotify=true
StartupWMClass=myapp
Categories=Development;
```

- `TryExec` must exist.
- `DBusActivatable=false` unless a D-Bus service file is shipped.
- `StartupWMClass` must match the X11 WM_CLASS (`app.setName`).
- Wayland matches the desktop file name: call
  `app.setDesktopName('myapp.desktop')` before `app.whenReady()`.

## Reproducible build

```bash
set -euo pipefail
VERSION="$(bun -e 'console.log(require("./package.json").version)')"
bun install --frozen-lockfile
ELECTRON_VERSION=41.3.0
ZIP="build-resources/electron-v${ELECTRON_VERSION}-linux-x64.zip"
EXPECTED_SHA256="<pinned>"
[ -f "$ZIP" ] || curl -fL -o "$ZIP" \
  "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"
[ "$(sha256sum "$ZIP" | cut -d' ' -f1)" = "$EXPECTED_SHA256" ] || {
  echo "Electron checksum mismatch" >&2; exit 1; }
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/opt/myapp/desktop" "$STAGE/usr/bin" \
         "$STAGE/DEBIAN" "$STAGE/usr/share/applications"
unzip -q "$ZIP" -d "$STAGE/opt/myapp/desktop"
find "$STAGE/opt/myapp/desktop/locales" -name '*.pak' \
  ! -name en-US.pak ! -name zh-CN.pak -delete
rm -f "$STAGE/opt/myapp/desktop/resources/default_app.asar"
```

Generate control and the runtime `package.json` from `$VERSION`. Then normalize:

```bash
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/usr/bin/myapp"
chmod 755 "$STAGE/opt/myapp/desktop/electron"
chmod 755 "$STAGE/opt/myapp/desktop/chrome_crashpad_handler"
chmod 4755 "$STAGE/opt/myapp/desktop/chrome-sandbox"
chmod 755 "$STAGE/DEBIAN"/{preinst,postinst,prerm,postrm} 2>/dev/null || true
export TZ=UTC LC_ALL=C
export SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"
find "$STAGE" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
dpkg-deb --root-owner-group --uniform-compression -Zxz \
  --build "$STAGE" "release/myapp_${VERSION}_amd64.deb"
sha256sum "release/myapp_${VERSION}_amd64.deb" \
  > "release/myapp_${VERSION}_amd64.deb.sha256"
```

Do not strip Electron or Chromium helpers. Stripping optional Bun/ripgrep binaries
is acceptable only if the smoke test still passes.

## Required checks

```bash
DEB="release/myapp_${VERSION}_amd64.deb"

dpkg-deb --info "$DEB"
dpkg-deb -f "$DEB" Architecture | grep -qx amd64
dpkg-deb -f "$DEB" Depends | grep -Ev 'nodejs|npm|python3|build-essential|unzip'
dpkg-deb -c "$DEB" | awk '$1 ~ /^-..s/ {print}'   # exactly one: chrome-sandbox

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
dpkg-deb -x "$DEB" "$TMP"
test -x "$TMP/opt/myapp/desktop/electron"
test -f "$TMP/opt/myapp/desktop/resources/app/main.js"
test ! -e "$TMP/opt/myapp/desktop/resources/default_app.asar"
desktop-file-validate "$TMP/usr/share/applications/myapp.desktop"
! find "$TMP" \( -name node_modules -o -name '*.map' -o -name '.git*' \) -print -quit | grep -q .
! ldd "$TMP/opt/myapp/desktop/electron" | grep -q 'not found'
```

Runtime smoke test:

- Install on a clean Ubuntu 24.04 VM/container.
- X11 and Wayland sessions both launch; Wayland is never forced on X11.
  `pgrep -af /opt/myapp/desktop/electron` must show no `--no-sandbox`.
- Upgrade while the old instance runs: old processes gone, new binary launched.
- `xprop WM_CLASS` and the taskbar icon match the desktop entry.

## Completion gate

Do not report success until all are true:

- [ ] `dpkg-deb --info` shows `amd64`, the intended version, and no
      Node/npm/Bun/Python/build-tool `Depends`.
- [ ] Exactly one setuid path: root-owned `/opt/<app>/desktop/chrome-sandbox` at
      4755; postinst's `test -u` passes.
- [ ] Launcher contains no `--no-sandbox`, no `npx`, no PATH fallback.
- [ ] Wayland is selected only under `WAYLAND_DISPLAY`.
- [ ] `desktop-file-validate`, the extraction check, and `ldd` all pass; no
      `node_modules`, maps, or `.git` in the package.
- [ ] Fresh install, upgrade-with-running-app, and remove all pass.
- [ ] User config/data survives remove.
- [ ] Artifact is named `release/<app>_<version>_amd64.deb` with a SHA256 file.

## Anti-patterns

- `chmod 755 chrome-sandbox` plus `--no-sandbox`, or `|| true` around sandbox setup.
- Installing into `/usr/lib`, committing generated artifacts, or `sed -i` on a
  tracked control file with multiple version sources.
- `npx electron`, system `/usr/bin/electron`, or `node_modules` at runtime.
- An `all`-architecture `.deb` containing ELF binaries.
- Killing processes by name during upgrade.
- Shipping every locale "just in case", or adding a splash screen to hide startup
  latency instead of fixing the launch path.
