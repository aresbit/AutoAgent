import { BrowserWindow, ipcMain, nativeTheme, systemPreferences } from 'electron'

export interface ThemeState {
  source: 'system' | 'light' | 'dark'
  shouldUseDarkColors: boolean
  accentColor: string | null
}

function readAccentColor(): string | null {
  try {
    const raw = systemPreferences.getAccentColor()
    if (typeof raw !== 'string' || raw.length < 6) return null
    return `#${raw.slice(0, 6)}`
  } catch {
    return null
  }
}

function currentTheme(): ThemeState {
  return {
    source: nativeTheme.themeSource,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    accentColor: readAccentColor(),
  }
}

function broadcast(): void {
  const state = currentTheme()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('native:theme:changed', state)
    }
  }
}

/** Theme source, dark-mode flag and system accent colour. */
export function registerTheme(): void {
  ipcMain.handle('native:theme:get', () => currentTheme())

  ipcMain.handle('native:theme:set', (_event, source: unknown) => {
    if (source !== 'system' && source !== 'light' && source !== 'dark') {
      throw new Error('theme source must be system, light or dark')
    }
    nativeTheme.themeSource = source
    broadcast()
    return currentTheme()
  })

  nativeTheme.on('updated', broadcast)
}
