import { BrowserWindow, ipcMain, session, shell, type Session } from 'electron'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_SCHEME,
  artifactProtocolUrl,
  isArtifactId,
  isArtifactVersion,
  parseArtifactUrl,
  type ArtifactBackendAccess,
  type ArtifactProtocolHandler,
} from './artifact-protocol.js'

export interface ArtifactWindowOptions {
  getParent: () => BrowserWindow | null
  /** Loopback backend credentials owned by the main process. */
  getBackend: () => ArtifactBackendAccess | null
  /**
   * Protocol handler installed per artifact partition.  Electron protocol
   * handlers are scoped to a Session, so the isolated `persist:` partition
   * needs its own registration.
   */
  protocolHandler: ArtifactProtocolHandler
  /** Override for tests; defaults to `dist/artifact-preload.cjs`. */
  preloadPath?: string
}

export interface ArtifactRegistry {
  close(): void
}

export function resolveArtifactPreloadPath(): string {
  return fileURLToPath(new URL('./artifact-preload.cjs', import.meta.url))
}

interface ArtifactOpenRequest {
  artifactId: string
  version?: string
  title?: string
}

function parseOpenRequest(request: unknown): ArtifactOpenRequest {
  if (typeof request !== 'object' || request === null) {
    throw new Error('artifact request must be an object')
  }
  const { artifactId, version, title } = request as Record<string, unknown>
  if (!isArtifactId(artifactId)) {
    throw new Error('invalid artifact id')
  }
  const resolvedVersion = version === undefined || version === null ? undefined : version
  if (resolvedVersion !== undefined && !isArtifactVersion(resolvedVersion)) {
    throw new Error('invalid artifact version')
  }
  return {
    artifactId,
    version: resolvedVersion,
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : 'Artifact',
  }
}

/** Ask the backend for the artifact's current revision when none is given. */
async function resolveCurrentVersion(
  backend: ArtifactBackendAccess,
  artifactId: string,
): Promise<string> {
  const response = await fetch(
    `http://127.0.0.1:${backend.port}/api/artifacts/${encodeURIComponent(artifactId)}`,
    {
      headers: {
        authorization: `Bearer ${backend.token}`,
        accept: 'application/json',
      },
    },
  )
  if (!response.ok) {
    throw new Error(`artifact is unavailable (${response.status})`)
  }
  const payload = (await response.json()) as { revision?: unknown }
  if (!isArtifactVersion(payload?.revision)) {
    throw new Error('backend returned an invalid artifact revision')
  }
  return payload.revision
}

function openExternalHttps(raw: string): void {
  try {
    if (new URL(raw).protocol === 'https:') {
      void shell.openExternal(raw)
    }
  } catch {
    // Malformed URLs are simply denied.
  }
}

/**
 * Artifact child window.
 *
 * The child loads only `autoagent-artifact://<id>/v<N>/index.html`; the main
 * process resolves that protocol to backend HTML with a short-lived frame
 * token.  Each artifact gets its own persistent partition (separate origin,
 * storage and permissions) and a dedicated minimal preload.  The main
 * preload/native bridge is never loaded here.
 */
export function registerArtifactWindow(options: ArtifactWindowOptions): ArtifactRegistry {
  let artifactWindow: BrowserWindow | null = null
  let currentArtifactId: string | null = null
  const artifactSessions = new Set<Session>()

  function destroyWindow(): void {
    if (artifactWindow && !artifactWindow.isDestroyed()) {
      artifactWindow.destroy()
    }
    artifactWindow = null
    currentArtifactId = null
  }

  function ensureProtocol(partition: string): void {
    const artifactSession = session.fromPartition(partition)
    if (artifactSessions.has(artifactSession)) return
    artifactSession.protocol.handle(ARTIFACT_SCHEME, options.protocolHandler)
    artifactSessions.add(artifactSession)
  }

  function close(): void {
    destroyWindow()
    for (const artifactSession of artifactSessions) {
      try {
        artifactSession.protocol.unhandle(ARTIFACT_SCHEME)
      } catch {
        // best effort during shutdown
      }
    }
    artifactSessions.clear()
  }

  function createWindow(
    request: ArtifactOpenRequest,
    version: string,
    parent: BrowserWindow | null,
  ): BrowserWindow {
    const partition = `persist:autoagent-artifact-${request.artifactId}`
    ensureProtocol(partition)
    const window = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      title: request.title,
      parent: parent ?? undefined,
      backgroundColor: '#0b0d10',
      webPreferences: {
        preload: options.preloadPath ?? resolveArtifactPreloadPath(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition,
      },
    })

    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show()
    })
    window.on('closed', () => {
      if (artifactWindow === window) {
        artifactWindow = null
        currentArtifactId = null
      }
    })

    // Untrusted artifact documents get no permissions (camera, geolocation,
    // notifications, clipboard, ...).
    const artifactSession = window.webContents.session
    artifactSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    artifactSession.setPermissionCheckHandler(() => false)

    // External links go to the OS browser; never open an Electron window.
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternalHttps(url)
      return { action: 'deny' }
    })

    // In-place navigation is restricted to the artifact scheme and shape.
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      if (parseArtifactUrl(navigationUrl) === null) {
        event.preventDefault()
      }
    })

    window.webContents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    void window.loadURL(artifactProtocolUrl(request.artifactId, version))
    return window
  }

  ipcMain.handle('native:artifact:open', async (_event, request: unknown) => {
    const parsed = parseOpenRequest(request)

    const backend = options.getBackend()
    if (!backend) throw new Error('backend is not ready')

    const version = parsed.version ?? (await resolveCurrentVersion(backend, parsed.artifactId))
    const url = artifactProtocolUrl(parsed.artifactId, version)

    if (artifactWindow && !artifactWindow.isDestroyed() && currentArtifactId === parsed.artifactId) {
      artifactWindow.setTitle(parsed.title ?? 'Artifact')
      await artifactWindow.loadURL(url)
      artifactWindow.show()
      artifactWindow.focus()
      return true
    }

    // A different artifact needs its own isolated partition.
    destroyWindow()
    artifactWindow = createWindow(parsed, version, options.getParent())
    currentArtifactId = parsed.artifactId
    return true
  })

  ipcMain.handle('native:artifact:close', () => {
    destroyWindow()
    return true
  })

  return { close }
}
