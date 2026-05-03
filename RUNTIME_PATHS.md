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

Relevant script:

- [scripts/build-deb.sh](D:/yyscode/AutoAgent/scripts/build-deb.sh)

Installed layout:

- launcher: `/usr/bin/autoagent`
- app home: `/usr/lib/autoagent`
- desktop main: `/usr/lib/autoagent/main.js`
- preload: `/usr/lib/autoagent/preload.cjs`
- artifact preload: `/usr/lib/autoagent/artifact-preload.cjs` if copied in future builds
- OpenCC CLI: `/usr/lib/autoagent/cli.js`
- bun runtime: `/usr/lib/autoagent/bun`
- ripgrep: `/usr/lib/autoagent/rg`
- icons: `/usr/lib/autoagent/icon.png`

Current runtime-paths support includes explicit Debian lookups for:

- `/usr/lib/autoagent/cli.js`
- `/usr/lib/autoagent/bun`

Ripgrep resolution on Debian is also compatible because OpenCC has its own internal app-local lookup behavior for `/usr/lib/autoagent/rg`.

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
4. packaged `resources/`
5. local module directory
6. `dist/`
7. `build-resources/`

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
4. bundled bun + resolved OpenCC CLI entry
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
