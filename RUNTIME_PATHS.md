# Runtime Paths

## Purpose

This document defines the runtime file layout that AutoAgent expects across:

- development workspace runs
- `dist/` runs
- Electron packaged runs via `electron-builder`
- Debian package runs

The source of truth for runtime lookup behavior is:

- [src/runtime-paths.ts](D:/yyscode/AutoAgent/src/runtime-paths.ts)

## Design Rules

1. Runtime resolution must prefer app-local resources before falling back to system tools.
2. Windows and non-Windows binaries use platform-appropriate names.
3. Development, `dist`, and packaged layouts should share the same logical resource names whenever possible.
4. Lookup rules should be centralized in `runtime-paths.ts`, not duplicated across unrelated modules.

## Canonical Resource Types

### Prompt assets

Used for Claude Desktop / Autowork prompt assembly.

Canonical relative location:

- `autowork/assets/upstream/`

Expected files:

- `desktop-system-prompts-extracted.md`
- `claude-desktop-artifacts-mechanism.md`
- `claude-desktop-ui-generation.md`
- `claude-code-internal-mcp-servers.md`

Resolver:

- `resolvePromptAssetsDir()`

### Ripgrep

Used by OpenCC search tools and Glob/Grep behavior.

Canonical runtime filename:

- Windows: `rg.exe`
- Linux/macOS: `rg`

Resolver:

- `resolveRipgrepBinaryPath()`

### Bun runtime

Used when constructing a self-contained default OpenCC command.

Canonical runtime filename:

- Windows: `bun_runtime.exe`
- Linux/macOS: `bun`

Resolver:

- `resolveBundledBunBinaryPath()`

### OpenCC CLI entry

Used by the default `claudeCommand` value.

Canonical runtime location in packaged app:

- `opencc-dist/cli.js`

Resolver:

- `resolveOpenccCliEntryPath()`
- `resolveDefaultOpenccCommandValue()`

### Artifact preload

Used when opening standalone artifact windows.

Canonical runtime filename:

- `artifact-preload.cjs`

Resolver:

- `resolveArtifactPreloadPath()`

### Icons

Canonical runtime filenames:

- Windows shortcut/taskbar icon: `icon.ico`
- App/window icon: `icon.png`

Resolver:

- `resolveRuntimeAssetPath(name)`

## Layouts

## 1. Development Workspace

This is the layout when running from the repository checkout.

Important locations:

- app code: `src/`
- built desktop output: `dist/`
- OpenCC CLI output: `packages/opencc/dist/cli.js`
- prompt assets source: `src/autowork/assets/upstream/`
- prompt assets build output: `dist/autowork/assets/upstream/`
- local runtime binaries: `build-resources/`

Typical resolved paths in dev:

- prompt assets: `src/autowork/assets/upstream/` or `dist/autowork/assets/upstream/`
- ripgrep: `build-resources/rg.exe` or `dist/rg.exe` on Windows, `build-resources/rg` or `dist/rg` on non-Windows
- bun runtime: `build-resources/bun_runtime.exe` or `dist/bun_runtime.exe` on Windows, `build-resources/bun` or `dist/bun` on non-Windows
- OpenCC command:
  - Windows prefers `packages/opencc/opencc.bat`
  - otherwise resolves to bundled bun + `packages/opencc/dist/cli.js`

## 2. Dist Layout

This is the local desktop build output used by `bun run dev` / `bun run start`.

Important locations:

- `dist/main.js`
- `dist/preload.cjs`
- `dist/artifact-preload.cjs`
- `dist/client/`
- `dist/autowork/assets/upstream/`
- `dist/icon.png`
- `dist/icon.ico`
- `dist/rg.exe` or `dist/rg`
- `dist/bun_runtime.exe` or `dist/bun`

This layout exists so runtime resolution works even before full packaging.

## 3. Electron Builder Packaged Layout

Current repository configuration is primarily oriented around Windows packaging.

Relevant package config:

- [package.json](D:/yyscode/AutoAgent/package.json)

Expected packaged runtime structure:

- app JS bundle inside `resources/app.asar/dist/`
- extra resources under `resources/`
- OpenCC CLI bundle under `resources/opencc-dist/`
- icons under `resources/icon.ico` and `resources/icon.png`
- ripgrep under `resources/rg.exe` on Windows
- bun runtime under `resources/bun_runtime.exe` on Windows

Important note:

- `runtime-paths.ts` checks both `resources/...` and `resources/app.asar/dist/...` style locations.

## 4. Debian Package Layout

Debian packaging uses a different filesystem contract from Electron Builder.

Relevant scripts:

- [scripts/build-deb.sh](D:/yyscode/AutoAgent/scripts/build-deb.sh)
- [packaging/deb/usr/bin/autoagent](D:/yyscode/AutoAgent/packaging/deb/usr/bin/autoagent)

Installed layout:

- launcher: `/usr/bin/autoagent`
- engine home: `/opt/autoagent/engine`
- Bun runtime: `/opt/autoagent/engine/bun`
- ripgrep: `/opt/autoagent/engine/rg`
- OpenCC CLI: `/opt/autoagent/engine/cli.js`
- desktop home: `/opt/autoagent/desktop`
- Electron binary: `/opt/autoagent/desktop/electron`
- Chromium helpers: `/opt/autoagent/desktop/chrome-sandbox` (root:root 4755),
  `/opt/autoagent/desktop/chrome_crashpad_handler`
- app bundle: `/opt/autoagent/desktop/resources/app/`
- desktop main: `/opt/autoagent/desktop/resources/app/main.js`
- preload: `/opt/autoagent/desktop/resources/app/preload.cjs`
- artifact preload: `/opt/autoagent/desktop/resources/app/artifact-preload.cjs`
- app package metadata: `/opt/autoagent/desktop/resources/app/package.json`
- icons: `/opt/autoagent/desktop/resources/app/icon.png` (source assets also
  installed under `/usr/share/icons/hicolor/*/apps/autoagent.png`)

The launcher exports:

```sh
AUTOAGENT_ENGINE_DIR=/opt/autoagent/engine
```

`AUTOAGENT_ENGINE_DIR` is the single switch for engine binary resolution. The
launcher sets it when not already set; `runtime-paths.ts` uses it to resolve
`bun`, `rg`, and `cli.js` before any legacy `/usr/lib/autoagent` fallback. This
keeps development and Windows paths working.

Runtime resolution must not depend on system Node, npm, Bun, Electron, or
Python. Logs are written to
`${XDG_STATE_HOME:-$HOME/.local/state}/autoagent/logs/desktop.log`.

## Build Script Staging Rules

Desktop build script:

- [scripts/build-desktop.mjs](D:/yyscode/AutoAgent/scripts/build-desktop.mjs)

Current staging behavior:

- copies prompt assets to `dist/autowork/assets/`
- copies icons to `dist/`
- stages bun runtime to:
  - `build-resources/bun_runtime.exe` and `dist/bun_runtime.exe` on Windows
  - `build-resources/bun` and `dist/bun` on non-Windows
- stages ripgrep to:
  - `build-resources/rg.exe` and `dist/rg.exe` on Windows
  - `build-resources/rg` and `dist/rg` on non-Windows when available

These names are intentionally aligned with `runtime-paths.ts`.

## Resolution Order Summary

### Ripgrep

`resolveRipgrepBinaryPath()` prefers:

1. `AUTOAGENT_RG_PATH`
2. `RG_BIN`
3. `RIPGREP_BIN`
4. packaged Linux engine dir (`AUTOAGENT_ENGINE_DIR`, default
   `/opt/autoagent/engine`)
5. packaged `resources/`
6. local module directory
7. `dist/`
8. `build-resources/`

### Prompt assets

`resolvePromptAssetsDir()` prefers:

1. module-adjacent built assets
2. source assets under `src/autowork/assets/upstream/`
3. built assets under `dist/autowork/assets/upstream/`
4. packaged `app.asar/dist/autowork/assets/upstream/`

### OpenCC default command

`resolveDefaultOpenccCommandValue()` prefers:

1. `AUTOAGENT_CLAUDE_COMMAND`
2. `AUTOAGENT_OPENCC_COMMAND`
3. Windows batch wrapper in dev
4. bundled bun + resolved OpenCC CLI entry (on Linux packaged installs this is
   `AUTOAGENT_ENGINE_DIR/bun` + `AUTOAGENT_ENGINE_DIR/cli.js`)
5. `bun run <cli.js>` on non-Windows dev fallback
6. raw `opencc`

## Maintenance Notes

When adding a new runtime resource:

1. Add its canonical name and lookup rule to `runtime-paths.ts`.
2. Stage it in `scripts/build-desktop.mjs` if it is needed in dev or `dist`.
3. Update packaging scripts if packaged layouts also need it.
4. Update this document.

When changing a runtime filename:

1. Update `runtime-paths.ts`
2. Update `build-desktop.mjs`
3. Update package/installer scripts
4. Re-test:
   - `bun run build:desktop`
   - `bun run dev`
   - packaged app launch
   - artifact window launch
   - prompt asset loading
   - Glob/Grep tool behavior
