# Source change list

Every file that must change for the `/opt/autoagent` refactor. Paths are absolute
under `/home/tars/yysapp/AutoAgent`.

Nothing here has been applied; this is the edit intent for the implementation task.
Items marked **(new)** do not exist today. `packaging/deb/DEBIAN/preinst` is missing
today (verified).

## Packaging and build

### `scripts/build-deb.sh` — rewrite

Current problems: writes into `packaging/deb` in place, leaves stale files, defaults
to `0.2.0`, `sed -i`s the source control file, `chown -R root:root` on the workspace,
uses an unverified `node_modules/electron/dist`, and has no dependency/leak checks.

New behavior:

1. Resolve `VERSION` from root `package.json` only; reject a conflicting `--version`.
2. Preflight: Linux x86_64, `bun`, `dpkg-deb`, `unzip`, `sha256sum`; run
   `bun install --frozen-lockfile`.
3. `bun run build:desktop`.
4. Download or locate `build-resources/electron-v41.3.0-linux-x64.zip`; verify a
   pinned SHA256 (value to fill in T12); extract into the stage with traversal
   guards.
5. Create `STAGE="$(mktemp -d)"` with `trap 'rm -rf "$STAGE"' EXIT`.
6. Stage `/opt/autoagent/engine/{bun,rg,cli.js}` and
   `/opt/autoagent/desktop/{electron...,resources/app/...}`.
7. Prune Electron locales to `en-US.pak`/`zh-CN.pak`; remove
   `resources/default_app.asar`.
8. Generate `resources/app/package.json` and `DEBIAN/control` in the stage.
9. Install launcher, desktop entry, icons; copy maintainer scripts and `chmod 755`.
10. Normalize ownership via `dpkg-deb --root-owner-group` (drop `chown -R`), modes
    per the playbook, and `chrome-sandbox` 4755.
11. Normalize mtimes with `SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)"`; set
    `TZ=UTC`, `LC_ALL=C`.
12. Build to `release/autoagent_${VERSION}_amd64.deb` with
    `dpkg-deb --root-owner-group --uniform-compression -Zxz --build`.
13. Run `dpkg-deb --info` and `dpkg-deb -c`; assert `chrome-sandbox` mode 4755,
    no `node_modules`/`*.map`/`.git`, no forbidden Depends.
14. Write `release/autoagent_${VERSION}_amd64.deb.sha256`.
15. Do not mutate anything under `packaging/deb/`.

### `packaging/deb/usr/bin/autoagent` — rewrite

Replace the system-Electron discovery, `npx` fallback, `--no-sandbox`, and
`$HOME/.local/share` log with the exact launcher in
`docs/cross-platform/packaging-playbook.md` §2:

- fixed `/opt/autoagent/desktop/electron`;
- `AUTOAGENT_ENGINE_DIR=/opt/autoagent/engine`;
- `--ozone-platform=wayland` only when `WAYLAND_DISPLAY` is non-empty;
- `exec` with quoted paths;
- XDG state log;
- clear error and non-zero exit if the runtime is missing.

### `packaging/deb/DEBIAN/control` — rewrite as a template

- Keep `Package: autoagent`, `Section: devel`, `Priority: optional`.
- `Architecture: amd64`.
- `Version: 0.0.0` placeholder; the build script substitutes the real version in
  the staged copy. The file is no longer a version authority.
- Remove `Suggests: npm, nodejs`.
- Add the explicit Depends line from the playbook §4 (Ubuntu 24.04 `t64` variants).
- Add `Installed-Size` at build time.
- Keep Homepage/Description, but do not claim features that do not exist.
- The build must never `sed -i` this source file.

### `packaging/deb/DEBIAN/preinst` — **(new)**

Scope process cleanup by `/proc/PID/exe` resolving under `/usr/lib/autoagent` or
`/opt/autoagent`. Send TERM, sleep 1, then KILL. Do not match by process name.
Exact script in playbook §5.

### `packaging/deb/DEBIAN/postinst` — rewrite

- `chown root:root` and `chmod 4755 /opt/autoagent/desktop/chrome-sandbox`.
- Refuse symlinked sandbox.
- Hard-fail with actionable text if `test -u` fails (nosuid filesystem, stripped
  archive), instructing `sudo dpkg --configure -a`.
- Refresh desktop database and hicolor icon cache.
- Warn about non-empty legacy `/usr/lib/autoagent`; do not delete operator data.
- Remove the current success banner; dpkg output is not a UI.

### `packaging/deb/DEBIAN/prerm` — **(new, recommended)**

TERM-scoped cleanup of `/opt/autoagent` processes before remove/upgrade. Shares the
same `/proc/PID/exe` predicate as preinst.

### `packaging/deb/DEBIAN/postrm` — **(new)**

Refresh desktop database and icon cache. Never delete user data under `$HOME`.

### `packaging/deb/usr/share/applications/autoagent.desktop` — rewrite

Use the exact entry in playbook §6. Add `TryExec`, `DBusActivatable=false`,
`StartupNotify=true`, `GenericName`, `Comment[zh_CN]`; keep
`StartupWMClass=autoagent`. Must pass `desktop-file-validate`.

### `packaging/deb/usr/lib/autoagent/` — stop tracking / delete from git

The committed tree contains `bun` (99 MiB), `cli.js` (25 MiB), `main.js`,
`client/`, icons, and `package.json` version 0.2.0. These are generated artifacts
and are already listed in `.gitignore` (except they were committed earlier).

- `git rm -r --cached packaging/deb/usr/lib/autoagent`
- Delete the directory from the working tree once the new builder is in place.
- Do not keep a second copy of `package.json`; generate it in the stage.

### `packaging/deb/usr/share/icons/hicolor/` — stop tracking / generate

The seven PNGs are copies of `assets/icon_*.png`. Generate them during the build
from `assets/`; do not commit duplicate binaries. Keep `assets/` as the source.

### `package.json` — edit scripts only

- Keep the custom `.deb` pipeline. Do **not** add a `build.linux` electron-builder
  target; doing so would create two competing Linux layouts.
- Add `"package:deb": "bash scripts/build-deb.sh"`.
- Optionally add `"package:deb:verify": "bash scripts/verify-deb.sh"` if the
  completion gate is extracted into a script.
- Leave `build.win` and `build.nsis` unchanged.
- `version` stays the single authority for both Windows and Linux.

### `scripts/make-update-manifest.mjs` — **(new, optional)**

Only if release metadata is published. Port maxwire's
`tools/make_update_manifest.py` semantics:

- version from root `package.json`;
- `--deb`, `--out`, `--notes`;
- streaming SHA-512;
- refuse empty input;
- preserve the previous non-built platform's entry.

If no updater will consume it, skip this file and keep `sha256` next to the deb.

### `scripts/publish.sh` — edit

- Change `DEB_NAME="autoagent_${VERSION}_all.deb"` and
  `DEB_PATH="dist/deb/..."` to
  `release/autoagent_${VERSION}_amd64.deb`.
- Remove the `sed -i` on `packaging/deb/DEBIAN/control`; version is bumped in
  `package.json` only.
- Remove `packaging/deb/DEBIAN/control` from the version-bump commit.
- Verify the deb exists before tagging; upload the `.sha256` alongside the deb.

### `scripts/setup-apt-repo.sh` — edit

- `DEB_DIR` from `dist/deb` to `release`.
- Generate the Packages index under `binary-amd64`, not `binary-all`.
- Set `Architectures: amd64` in the Release file.
- Keep the existing dual directory creation or remove the unused `binary-all`.

### `scripts/build-desktop.mjs` — no change required for packaging

It already emits `dist/main.js`, `preload.cjs`, `artifact-preload.cjs`,
`dist/client/`, `dist/autowork/assets/`, and stages bun/rg into `build-resources/`.
The new builder must consume these outputs rather than re-running the engines.
If the pinned Electron download is moved here, keep it out of the app payload.

## Runtime

### `src/runtime-paths.ts` — edit

Add an engine-dir resolution used by all three binary lookups:

```ts
const engineDir =
  process.env.AUTOAGENT_ENGINE_DIR ||
  (process.platform === 'linux' ? '/opt/autoagent/engine' : '');
```

- `resolveRipgrepBinaryPath`: add `join(engineDir, 'rg')` before the legacy
  `/usr/lib/autoagent` fallbacks.
- `resolveBundledBunBinaryPath`: add `join(engineDir, 'bun')`.
- `resolveOpenccCliEntryPath`: add `join(engineDir, 'cli.js')`.
- Keep all existing candidates so development and Windows paths still work.
- Do not hardcode `/opt` in more than this one place.

### `src/main.ts` — startup block only (coordinate with Atlas)

- `app.setName('autoagent')`: keep.
- `app.setDesktopName('autoagent')` → `app.setDesktopName('autoagent.desktop')` so
  Wayland resolves `/usr/share/applications/autoagent.desktop`. Verify in T12.
- `app.commandLine.appendSwitch('in-process-gpu')` on Linux (lines ~311-313):
  Atlas owns the runtime decision. Packaging recommendation: remove it and let
  Chromium use its normal GPU process unless measurements justify keeping it. Do
  not change Windows flags.
- Wayland selection stays in the launcher, not `main.ts`.
- Do not change single-instance, shutdown, or IPC behavior as part of packaging.

### `src/engine-client.ts` — no change expected

It consumes `resolveDefaultOpenccCommandValue()`. Once `runtime-paths.ts` resolves
`/opt/autoagent/engine`, the spawned command becomes
`"/opt/autoagent/engine/bun" run "/opt/autoagent/engine/cli.js" ...`.

## Documentation and repository hygiene

### `docs/cross-platform/README.md` — **(new)**

Index for this playbook, the change list, the skill draft, and Atlas's evidence
logs.

### `README.md` — edit

Update the installation section: `/opt/autoagent` instead of `/usr/lib/autoagent`,
deb name `autoagent_<version>_amd64.deb`, and the current version.

### `RUNTIME_PATHS.md` — edit

Replace the Linux layout section (currently `/usr/lib/autoagent/*`) with the
`/opt/autoagent` layout and `AUTOAGENT_ENGINE_DIR`.

### `.gitignore` — edit

Remove the now-unneeded `packaging/deb/usr/lib/autoagent/...` entries once the
directory is gone. Keep `build-resources/`, `release/`, and `dist/`. Ensure
`build-resources/electron-v*-linux-x64.zip` stays ignored (it is a large binary).

### `docs/cross-platform/evidence/` — no change

Owned by Atlas. Reference it from the playbook; do not edit the logs.

## Files that must NOT change

- `src/renderer/**`, `src/preload.ts`, `src/artifact-preload.ts`: no UI redesign.
- `packages/opencc/**` except the built `dist/cli.js` consumed by packaging.
- `build.win` / NSIS configuration.
- User data formats and session paths.
