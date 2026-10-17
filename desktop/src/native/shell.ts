import { ipcMain, shell } from 'electron'

function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

/** Only OS-native shell operations a browser cannot do itself. */
export function registerShell(): void {
  ipcMain.handle('native:shell:open-external', async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || !isAllowedExternalUrl(rawUrl)) {
      throw new Error('refusing to open non-http(s)/mailto URL')
    }
    await shell.openExternal(rawUrl)
    return true
  })

  ipcMain.handle('native:shell:show-item', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('filePath must be a non-empty string')
    }
    shell.showItemInFolder(filePath)
    return true
  })
}
