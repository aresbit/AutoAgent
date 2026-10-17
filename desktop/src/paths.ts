import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_DIR_NAME = 'autoagent'
export const WINDOWS_APP_DIR_NAME = 'AutoAgent'

/**
 * Directory that contains this module (desktop/src in development,
 * desktop/dist in a built tree). Both are one level below `desktop/`.
 */
export function desktopDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

export function repoRoot(): string {
  return resolve(desktopDir(), '..')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined
}

/**
 * Mutable application data (SQLite, engine config). Never the install dir.
 * Mirrors architecture.md §3.2:
 *   Linux  ${XDG_CONFIG_HOME:-~/.config}/autoagent
 *   macOS  ~/Library/Application Support/autoagent
 *   Win32  %LOCALAPPDATA%\AutoAgent
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env.AUTOAGENT_DATA_DIR)
  if (override) return resolve(override)

  if (process.platform === 'win32') {
    const base = nonEmpty(env.LOCALAPPDATA) ?? join(homedir(), 'AppData', 'Local')
    return join(base, WINDOWS_APP_DIR_NAME)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
  }
  const base = nonEmpty(env.XDG_CONFIG_HOME) ?? join(homedir(), '.config')
  return join(base, APP_DIR_NAME)
}

/**
 * Logs, runtime pid/heartbeat files, and the desktop log. Never the install dir.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env.AUTOAGENT_STATE_DIR)
  if (override) return resolve(override)

  if (process.platform === 'win32') {
    const base = nonEmpty(env.LOCALAPPDATA) ?? join(homedir(), 'AppData', 'Local')
    return join(base, WINDOWS_APP_DIR_NAME)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
  }
  const base = nonEmpty(env.XDG_STATE_HOME) ?? join(homedir(), '.local', 'state')
  return join(base, APP_DIR_NAME)
}

export interface AppPaths {
  dataDir: string
  stateDir: string
  logDir: string
  runtimeDir: string
  desktopLogFile: string
  backendLogFile: string
  heartbeatFile: string
  backendPidFile: string
}

/**
 * Immutable install layout. The .deb launcher exports AUTOAGENT_APP_DIR and
 * AUTOAGENT_PACKAGED=1; development leaves both unset and uses `uv run`.
 *
 * Pre: overrides, when present, are non-empty paths.
 * Post: every path is absolute and derived from one root.
 */
export interface InstallPaths {
  appDir: string
  packaged: boolean
  backendDir: string
  backendBinary: string
  frontendDist: string
  engineDir: string
  bunPath: string
  openccCliPath: string
}

export function resolveInstallPaths(env: NodeJS.ProcessEnv = process.env): InstallPaths {
  const appDir = resolve(nonEmpty(env.AUTOAGENT_APP_DIR) ?? '/opt/autoagent')
  const packagedFlag = nonEmpty(env.AUTOAGENT_PACKAGED)
  const packaged = packagedFlag !== undefined
    ? packagedFlag === '1' || packagedFlag.toLowerCase() === 'true'
    : nonEmpty(env.AUTOAGENT_APP_DIR) !== undefined
  const engineDir = resolve(nonEmpty(env.AUTOAGENT_ENGINE_DIR) ?? join(appDir, 'engine'))
  const exe = process.platform === 'win32' ? '.exe' : ''

  return {
    appDir,
    packaged,
    backendDir: join(appDir, 'backend'),
    backendBinary: join(appDir, 'backend', `autoagent-backend${exe}`),
    frontendDist: resolve(
      nonEmpty(env.AUTOAGENT_FRONTEND_DIST) ?? join(appDir, 'frontend', 'dist'),
    ),
    engineDir,
    bunPath: resolve(nonEmpty(env.AUTOAGENT_BUN_PATH) ?? join(engineDir, `bun${exe}`)),
    openccCliPath: resolve(
      nonEmpty(env.AUTOAGENT_OPENCC_CLI_PATH) ?? join(engineDir, 'opencc-dist', 'cli.js'),
    ),
  }
}

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const dataDir = resolveDataDir(env)
  const stateDir = resolveStateDir(env)
  const logDir = join(stateDir, 'logs')
  // Electron's userData and the heartbeat live under the config/data root.
  const runtimeDir = join(dataDir, 'runtime')
  // The backend (paths.py) writes its pid under the state runtime dir.
  return {
    dataDir,
    stateDir,
    logDir,
    runtimeDir,
    desktopLogFile: join(logDir, 'desktop.log'),
    backendLogFile: join(logDir, 'backend.log'),
    heartbeatFile: join(runtimeDir, 'desktop.heartbeat'),
    backendPidFile: join(stateDir, 'runtime', 'backend.pid'),
  }
}
