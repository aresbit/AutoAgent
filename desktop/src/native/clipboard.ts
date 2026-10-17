import { clipboard, ipcMain, nativeImage } from 'electron'

/** Clipboard text/image only; no filesystem paths or arbitrary buffers. */
export function registerClipboard(): void {
  ipcMain.handle('native:clipboard:read-text', () => clipboard.readText())

  ipcMain.handle('native:clipboard:write-text', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('text must be a string')
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('native:clipboard:read-image', () => {
    const image = clipboard.readImage()
    return image.isEmpty() ? null : image.toDataURL()
  })

  ipcMain.handle('native:clipboard:write-image', (_event, dataUrl: unknown) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('dataUrl must be a data:image/* URL')
    }
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('could not decode image')
    clipboard.writeImage(image)
    return true
  })
}
