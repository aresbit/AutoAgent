import { app, BrowserWindow, dialog, protocol } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BackendManager, acquireSingleInstanceLock, generateToken } from './backend-manager.js'
import { createLogger, type Logger } from './logging.js'
import {
  registerArtifactWindow,
  resolveArtifactPreloadPath,
  type ArtifactRegistry,
} from './native/artifact.js'
import {
  ARTIFACT_SCHEME,
  createArtifactProtocolHandler,
  registerArtifactScheme,
} from './native/artifact-protocol.js'
import { registerClipboard } from './native/clipboard.js'
import { registerDialogs } from './native/dialogs.js'
import { registerNotifications } from './native/notifications.js'
import { registerShell } from './native/shell.js'
import { registerTheme } from './native/theme.js'
import { repoRoot, resolveAppPaths } from './paths.js'
import { createMainWindow, registerWindowIpc } from './window.js'

const STARTUP_ERROR_DIALOG_TIMEOUT_MS = 60_000
const isWindows = process.platform === 'win32'

const paths = resolveAppPaths()
app.setName('AutoAgent')
if (!isWindows) {
  const linuxApp = app as typeof app & { setDesktopName?: (name: string) => void }
  linuxApp.setDesktopName?.('autoagent.desktop')
} else {
  app.setAppUserModelId('com.autoagent.desktop')
}
// Stable userData before ready; never the install directory.
app.setPath('userData', paths.dataDir)

// Privileged custom scheme for artifact child windows.  This must run before
// the app is ready; `protocol.handle` is installed once the backend is up.
registerArtifactScheme(protocol)

let artifactProtocolRegistered = false

const logger: Logger = createLogger(paths.desktopLogFile, {
  console: process.env.AUTOAGENT_LOG_CONSOLE === '1',
})

let mainWindow: BrowserWindow | null = null
let manager: BackendManager | null = null
let artifactRegistry: ArtifactRegistry | null = null
let shuttingDown = false
let shutdownPromise: Promise<void> | null = null

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('native:single-instance:focus')
}

async function showStartupError(message: string): Promise<void> {
  logger.error('startup.failed', { message })
  try {
    const shown = dialog.showMessageBox({
      type: 'error',
      title: 'AutoAgent 启动失败',
      message,
      detail: `日志：${paths.desktopLogFile}`,
      buttons: ['退出'],
    })
    await Promise.race([
      shown,
      new Promise((resolve) => setTimeout(resolve, STARTUP_ERROR_DIALOG_TIMEOUT_MS)),
    ])
  } catch {
    // A headless environment may not have a dialog backend; the log has detail.
  }
}

async function boot(): Promise<void> {
  logger.info('app.start', {
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    pid: process.pid,
  })

  const token = generateToken()
  logger.registerSecret(token)

  manager = new BackendManager({
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    logDir: paths.logDir,
    heartbeatFile: paths.heartbeatFile,
    backendPidFile: paths.backendPidFile,
    // Older/architecture-layout backend wrote its pid under <data>/runtime.
    alternateBackendPidFiles: [join(paths.dataDir, 'runtime', 'backend.pid')],
    backendLogFile: paths.backendLogFile,
    logger,
    repoRoot: repoRoot(),
    token,
    backendCommand: process.env.AUTOAGENT_BACKEND_CMD,
    onExit: (info) => {
      logger.warn('backend.unexpected-exit', { code: info.code, signal: info.signal, reason: info.reason })
      void shutdown(info.code === 0 ? 0 : 1, 'backend exited')
    },
  })

  const handle = await manager.start()

  const artifactProtocolHandler = createArtifactProtocolHandler({
    getBackend: () => (manager ? { port: manager.port, token: manager.token } : null),
    onError: (event, detail) => logger.warn(event, { detail }),
  })
  // Default session (and per-artifact partitions registered by the window).
  protocol.handle(ARTIFACT_SCHEME, artifactProtocolHandler)
  artifactProtocolRegistered = true

  registerWindowIpc(() => mainWindow)
  registerDialogs(() => mainWindow)
  registerClipboard()
  registerShell()
  registerNotifications()
  registerTheme()
  artifactRegistry = registerArtifactWindow({
    preloadPath: resolveArtifactPreloadPath(),
    getParent: () => mainWindow,
    getBackend: () => (manager ? { port: manager.port, token: manager.token } : null),
    protocolHandler: artifactProtocolHandler,
  })

  mainWindow = createMainWindow({
    port: handle.port,
    token,
    logger,
    onFatal: (reason) => void shutdown(1, reason),
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  logger.info('app.ready', {
    port: handle.port,
    backendPid: handle.pid,
    bootId: handle.bootId,
  })
}

async function shutdown(code: number, reason = 'requested'): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = (async () => {
    logger.info('app.shutdown.begin', { code, reason })
    try {
      artifactRegistry?.close()
      artifactRegistry = null
    } catch {
      // best effort
    }
    try {
      if (artifactProtocolRegistered) {
        protocol.unhandle(ARTIFACT_SCHEME)
        artifactProtocolRegistered = false
      }
    } catch {
      // best effort
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy()
      }
      mainWindow = null
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.destroy()
      }
    } catch {
      // best effort
    }
    try {
      await manager?.shutdown(reason)
    } catch (error) {
      logger.error('app.shutdown.backend-error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    logger.info('app.shutdown.done', { code, reason })
    await logger.flush()
    app.exit(code)
  })()
  return shutdownPromise
}

function registerAppLifecycle(): void {
  app.on('second-instance', () => {
    focusMainWindow()
  })

  app.on('window-all-closed', () => {
    void shutdown(0, 'window-all-closed')
  })

  app.on('before-quit', (event) => {
    if (!shuttingDown) {
      event.preventDefault()
      void shutdown(0, 'before-quit')
    }
  })

  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'))
}

async function main(): Promise<void> {
  logPathNotice()

  const acquired = await acquireSingleInstanceLock(
    () => app.requestSingleInstanceLock(),
    { logger },
  )
  if (!acquired) {
    logger.error('app.quit', { reason: 'single-instance lock unavailable' })
    await logger.flush()
    app.quit()
    return
  }

  registerAppLifecycle()

  app.whenReady().then(async () => {
    try {
      await boot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await showStartupError(message)
      await shutdown(1, 'startup failure')
    }
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    await showStartupError(message)
    await shutdown(1, 'whenReady failure')
  })
}

function logPathNotice(): void {
  // The logger is file-backed; this line ensures the log file directory exists
  // before the first async write and records the version marker.
  void mkdir(paths.logDir, { recursive: true }).catch(() => undefined)
  logger.info('app.log-init', { version: app.getVersion() })
}

void main().catch(async (error) => {
  logger.error('app.fatal', {
    message: error instanceof Error ? error.message : String(error),
  })
  await logger.flush()
  app.exit(1)
})
