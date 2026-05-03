import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const moduleDir = dirname(__filename);
const appRootDir = dirname(moduleDir);

function existingPath(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function appAsarDistDir(): string[] {
  const resources = process.resourcesPath;
  if (!resources) return [];
  return [
    join(resources, 'app.asar', 'dist'),
    join(resources, 'app.asar.unpacked', 'dist'),
    join(resources, 'dist'),
  ];
}

export function ripgrepExecutableNames(platform = process.platform): string[] {
  return platform === 'win32' ? ['rg.exe', 'rg'] : ['rg', 'rg.exe'];
}

export function resolveRipgrepBinaryPath(): string | null {
  const names = ripgrepExecutableNames();
  return existingPath([
    process.env.AUTOAGENT_RG_PATH,
    process.env.RG_BIN,
    process.env.RIPGREP_BIN,
    ...names.map((name) => process.resourcesPath ? join(process.resourcesPath, name) : null),
    ...names.map((name) => join(moduleDir, name)),
    ...names.map((name) => join(appRootDir, 'dist', name)),
    ...names.map((name) => join(appRootDir, 'build-resources', name)),
  ]);
}

export function resolvePromptAssetsDir(): string {
  const candidates = [
    join(moduleDir, 'autowork', 'assets', 'upstream'),
    join(moduleDir, 'assets', 'upstream'),
    join(appRootDir, 'src', 'autowork', 'assets', 'upstream'),
    join(appRootDir, 'dist', 'autowork', 'assets', 'upstream'),
    ...appAsarDistDir().map((dir) => join(dir, 'autowork', 'assets', 'upstream')),
  ];
  const resolved = existingPath(candidates.map((candidate) => join(candidate, 'desktop-system-prompts-extracted.md')))
    ?.replace(/[\\/]desktop-system-prompts-extracted\.md$/i, '');
  if (!resolved) {
    throw new Error(`Autowork prompt assets not found. Tried: ${candidates.join(' | ')}`);
  }
  return resolved;
}

export function resolveArtifactPreloadPath(): string {
  return existingPath([
    join(moduleDir, 'artifact-preload.cjs'),
    join(appRootDir, 'dist', 'artifact-preload.cjs'),
    ...appAsarDistDir().map((dir) => join(dir, 'artifact-preload.cjs')),
  ]) || join(moduleDir, 'artifact-preload.cjs');
}

export function resolveRuntimeAssetPath(name: string): string {
  return existingPath([
    process.resourcesPath ? join(process.resourcesPath, name) : null,
    join(moduleDir, name),
    join(appRootDir, 'dist', name),
    join(appRootDir, 'assets', name),
    ...appAsarDistDir().map((dir) => join(dir, name)),
  ]) || name;
}

export function resolveBundledBunBinaryPath(): string | null {
  const names = process.platform === 'win32'
    ? ['bun_runtime.exe', 'bun.exe', 'bun']
    : ['bun', 'bun_runtime', 'bun_runtime.exe'];
  return existingPath([
    ...names.map((name) => process.resourcesPath ? join(process.resourcesPath, name) : null),
    ...names.map((name) => join(moduleDir, name)),
    ...names.map((name) => join(appRootDir, 'build-resources', name)),
    ...names.map((name) => join(appRootDir, 'dist', name)),
    '/usr/lib/autoagent/bun',
    ...names.map((name) => join('/usr', 'bin', name)),
    ...names.map((name) => join('/usr', 'local', 'bin', name)),
    ...names.map((name) => join(process.env.HOME || '/root', '.bun', 'bin', name)),
  ]);
}

export function resolveOpenccCliEntryPath(): string | null {
  return existingPath([
    process.resourcesPath ? join(process.resourcesPath, 'opencc-dist', 'cli.js') : null,
    process.resourcesPath ? join(process.resourcesPath, 'cli.js') : null,
    join(moduleDir, 'cli.js'),
    join(appRootDir, 'packages', 'opencc', 'dist', 'cli.js'),
    '/usr/lib/autoagent/cli.js',
  ]);
}

export function resolveOpenccBatchWrapperPath(): string | null {
  if (process.platform !== 'win32') return null;
  return existingPath([
    join(appRootDir, 'packages', 'opencc', 'opencc.bat'),
  ]);
}

export function resolveDefaultOpenccCommandValue(): string {
  if (process.env.AUTOAGENT_CLAUDE_COMMAND?.trim()) return process.env.AUTOAGENT_CLAUDE_COMMAND;
  if (process.env.AUTOAGENT_OPENCC_COMMAND?.trim()) return process.env.AUTOAGENT_OPENCC_COMMAND;

  const batchWrapper = resolveOpenccBatchWrapperPath();
  if (batchWrapper) return `"${batchWrapper}"`;

  const cliEntry = resolveOpenccCliEntryPath();
  const bunBinary = resolveBundledBunBinaryPath();
  if (cliEntry && bunBinary) {
    return `"${bunBinary}" run "${cliEntry}" --dangerously-skip-permissions`;
  }
  if (cliEntry && process.platform !== 'win32') {
    return `bun run "${cliEntry}" --dangerously-skip-permissions`;
  }

  return 'opencc';
}
