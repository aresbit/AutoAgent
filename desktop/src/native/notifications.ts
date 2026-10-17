import { ipcMain, Notification } from 'electron'

/** OS notification surface only. */
export function registerNotifications(): void {
  ipcMain.handle('native:notification:is-supported', () => Notification.isSupported())

  ipcMain.handle(
    'native:notification:show',
    (_event, request: { title?: unknown; body?: unknown } | undefined) => {
      if (!Notification.isSupported()) return false
      const title = typeof request?.title === 'string' ? request.title : 'AutoAgent'
      const body = typeof request?.body === 'string' ? request.body : ''
      new Notification({ title, body }).show()
      return true
    },
  )
}
