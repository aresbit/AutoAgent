/**
 * Entrypoint switch. Exactly one main module runs.
 *
 * Legacy mode loads the untouched legacy Electron entry and never imports the
 * modern lifecycle. In a built tree this file lives at desktop/dist/entry.js;
 * the required source specifier is `../../src/main.js`, and the legacy bundle
 * produced by the root build is `<repo>/dist/main.js`.
 *
 * Packaged builds do not ship either legacy path. Attempting the imports there
 * would fail asynchronously and leave an Electron process hanging with no
 * window, so packaged mode fails fast with an actionable message instead.
 */
const LEGACY_UNAVAILABLE_MESSAGE =
  'Legacy mode is not shipped in this package. To roll back, reinstall the previous .deb.'

interface ElectronAppLike {
  isPackaged?: boolean
  isReady?: () => boolean
  whenReady?: () => Promise<void>
  exit?: (code: number) => void
}

interface ElectronDialogLike {
  showMessageBox?: (options: {
    type: 'error'
    title: string
    message: string
    buttons: string[]
  }) => Promise<unknown> | unknown
}

interface ElectronLike {
  app?: ElectronAppLike
  dialog?: ElectronDialogLike
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

async function loadElectron(): Promise<ElectronLike | null> {
  try {
    return (await import('electron')) as unknown as ElectronLike
  } catch {
    return null
  }
}

async function isPackagedMode(): Promise<boolean> {
  if (process.env.AUTOAGENT_PACKAGED === '1') return true
  const electron = await loadElectron()
  return electron?.app?.isPackaged === true
}

async function loadLegacy(): Promise<void> {
  try {
    await import('../../src/main.js')
  } catch (error) {
    if (!isModuleNotFound(error)) throw error
    await import('../../dist/main.js')
  }
}

/**
 * Write the stderr line, optionally show a native (non-blocking, bounded) error
 * box, then exit non-zero. No backend is ever started on this path.
 */
async function failLegacyUnavailable(): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stderr.write(`autoagent: ${LEGACY_UNAVAILABLE_MESSAGE}\n`, () => resolve())
  })

  const electron = await loadElectron()
  const app = electron?.app
  const dialog = electron?.dialog

  if (dialog?.showMessageBox) {
    try {
      if (app?.isReady && !app.isReady()) {
        await Promise.race([app.whenReady?.() ?? Promise.resolve(), delay(3_000)])
      }
      // showErrorBox is modal and can hang unattended machines; race a normal
      // message box against a short timer so shutdown is always bounded.
      await Promise.race([
        Promise.resolve(dialog.showMessageBox({
          type: 'error',
          title: 'AutoAgent',
          message: LEGACY_UNAVAILABLE_MESSAGE,
          buttons: ['退出'],
        })),
        delay(3_000),
      ])
    } catch {
      // A headless environment has no dialog backend; stderr already carries it.
    }
  }

  if (app?.exit) app.exit(1)
  process.exit(1)
}

async function boot(): Promise<void> {
  if (process.env.AUTOAGENT_LEGACY === '1') {
    if (await isPackagedMode()) {
      await failLegacyUnavailable()
      return
    }
    await loadLegacy()
    return
  }
  await import('./main.js')
}

void boot().catch((error: unknown) => {
  process.stderr.write(`autoagent entry failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
