import { BrowserWindow, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { buildAppUrl } from './backend-manager.js'
import { redactSecrets, type Logger } from './logging.js'

export interface MainWindowOptions {
  port: number
  token: string
  logger: Logger
  /** Called when renderer recovery is exhausted. */
  onFatal: (reason: string) => void
}

const RECOVERY_LIMIT = 3
const RECOVERY_WINDOW_MS = 60_000

export function resolvePreloadPath(): string {
  return fileURLToPath(new URL('./preload.cjs', import.meta.url))
}

function isExternalHttp(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:')
}

function appOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

function openExternalSafely(url: string): void {
  if (isExternalHttp(url)) {
    void shell.openExternal(url)
  }
}

/**
 * BrowserWindow with a sandboxed renderer. The token is only ever in the
 * loaded URL's query string; it is never logged.
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { port, token, logger } = options
  const origin = appOrigin(port)
  const recoveries: number[] = []

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    title: 'AutoAgent',
    webPreferences: {
      preload: resolvePreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: process.env.AUTOAGENT_DEVTOOLS === '1',
    },
  })

  const sendState = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('native:window:state-changed', {
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
    })
  }

  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
  window.on('maximize', sendState)
  window.on('unmaximize', sendState)
  window.on('enter-full-screen', sendState)
  window.on('leave-full-screen', sendState)

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    let allowed = false
    try {
      allowed = new URL(url).origin === origin
    } catch {
      allowed = false
    }
    if (!allowed) {
      event.preventDefault()
      openExternalSafely(url)
    }
  })

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error('window.renderer-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
    const now = Date.now()
    while (recoveries.length > 0 && now - (recoveries[0] ?? 0) > RECOVERY_WINDOW_MS) {
      recoveries.shift()
    }
    if (recoveries.length >= RECOVERY_LIMIT) {
      options.onFatal(`renderer crashed ${recoveries.length + 1} times`)
      return
    }
    recoveries.push(now)
    if (!window.isDestroyed()) {
      setTimeout(() => {
        if (!window.isDestroyed()) void window.reload()
      }, 500)
    }
  })

  window.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    logger.warn('window.load-failed', {
      code,
      description,
      url: redactSecrets(failedUrl.split('?')[0] ?? ''),
    })
  })

  logger.info('window.load', { origin, preload: resolvePreloadPath() })
  void window.loadURL(buildAppUrl(port, token))
  return window
}

/** Fixed window-control and history channels used by the preload allowlist. */
export function registerWindowIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('native:window:minimize', () => {
    getWindow()?.minimize()
  })

  ipcMain.handle('native:window:toggle-maximize', () => {
    const window = getWindow()
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle('native:window:close', () => {
    getWindow()?.close()
  })

  ipcMain.handle('native:window:set-fullscreen', (_event, fullscreen: unknown) => {
    const window = getWindow()
    if (!window) return false
    window.setFullScreen(Boolean(fullscreen))
    return window.isFullScreen()
  })

  ipcMain.handle('native:window:is-maximized', () => getWindow()?.isMaximized() ?? false)

  ipcMain.handle('native:navigation:back', () => {
    const window = getWindow()
    if (window?.webContents.canGoBack()) window.webContents.goBack()
  })

  ipcMain.handle('native:navigation:forward', () => {
    const window = getWindow()
    if (window?.webContents.canGoForward()) window.webContents.goForward()
  })

  ipcMain.handle('native:navigation:reload', () => {
    getWindow()?.webContents.reload()
  })

  ipcMain.handle('native:navigation:can-go-back', () => getWindow()?.webContents.canGoBack() ?? false)
  ipcMain.handle('native:navigation:can-go-forward', () => getWindow()?.webContents.canGoForward() ?? false)
}
