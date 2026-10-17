import { BrowserWindow, ipcMain, shell } from 'electron'

export interface ArtifactWindowOptions {
  preloadPath: string
  getParent: () => BrowserWindow | null
  /** Only URLs on the currently selected backend port are allowed. */
  allowedPort: () => number | null
}

export interface ArtifactRegistry {
  close(): void
}

function isAllowedArtifactUrl(raw: string, allowedPort: number | null): boolean {
  if (allowedPort === null) return false
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    return loopback && Number(url.port) === allowedPort
  } catch {
    return false
  }
}

/**
 * Artifact child window: sandboxed, no node integration, same minimal preload,
 * same backend origin only. External links are handed to the OS browser.
 */
export function registerArtifactWindow(options: ArtifactWindowOptions): ArtifactRegistry {
  let artifactWindow: BrowserWindow | null = null

  function close(): void {
    if (artifactWindow && !artifactWindow.isDestroyed()) {
      artifactWindow.close()
    }
    artifactWindow = null
  }

  ipcMain.handle('native:artifact:open', (_event, request: { url?: unknown; title?: unknown } | undefined) => {
    const rawUrl = request?.url
    if (typeof rawUrl !== 'string' || !isAllowedArtifactUrl(rawUrl, options.allowedPort())) {
      throw new Error('artifact URL must point at the local backend')
    }
    const title = typeof request?.title === 'string' ? request.title : 'Artifact'

    if (artifactWindow && !artifactWindow.isDestroyed()) {
      void artifactWindow.loadURL(rawUrl)
      artifactWindow.setTitle(title)
      artifactWindow.show()
      artifactWindow.focus()
      return true
    }

    const parent = options.getParent()
    const window = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      title,
      parent: parent ?? undefined,
      backgroundColor: '#0b0d10',
      webPreferences: {
        preload: options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })

    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      if (artifactWindow === window) artifactWindow = null
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('mailto:')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      if (navigationUrl !== rawUrl) event.preventDefault()
    })
    void window.loadURL(rawUrl)
    artifactWindow = window
    return true
  })

  ipcMain.handle('native:artifact:close', () => {
    close()
    return true
  })

  return { close }
}
