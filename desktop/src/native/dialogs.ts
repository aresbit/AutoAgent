import { BrowserWindow, dialog, ipcMain, type FileFilter, type OpenDialogOptions, type SaveDialogOptions } from 'electron'

export interface NativeFileFilter {
  name: string
  extensions: string[]
}

export interface OpenFileRequest {
  title?: string
  defaultPath?: string
  filters?: NativeFileFilter[]
  directory?: boolean
  multiple?: boolean
}

export interface SaveFileRequest {
  title?: string
  defaultPath?: string
  filters?: NativeFileFilter[]
  nameFieldLabel?: string
}

export interface MessageRequest {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title?: string
  message: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
}

function safeFilters(filters: NativeFileFilter[] | undefined): FileFilter[] | undefined {
  if (!Array.isArray(filters)) return undefined
  return filters
    .filter((filter) => filter && typeof filter.name === 'string' && Array.isArray(filter.extensions))
    .map((filter) => ({
      name: filter.name,
      extensions: filter.extensions.filter((extension) => typeof extension === 'string'),
    }))
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Native open/save/message dialogs. No generic channel is exposed. */
export function registerDialogs(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('native:dialog:open', async (_event, request: OpenFileRequest = {}) => {
    const options: OpenDialogOptions = {
      title: safeString(request.title),
      defaultPath: safeString(request.defaultPath),
      filters: safeFilters(request.filters),
      properties: [
        request.directory ? 'openDirectory' : 'openFile',
        ...(request.multiple ? (['multiSelections'] as const) : []),
      ],
    }
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return { canceled: result.canceled, filePaths: result.filePaths }
  })

  ipcMain.handle('native:dialog:save', async (_event, request: SaveFileRequest = {}) => {
    const options: SaveDialogOptions = {
      title: safeString(request.title),
      defaultPath: safeString(request.defaultPath),
      filters: safeFilters(request.filters),
    }
    const window = getWindow()
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    return { canceled: result.canceled, filePath: result.filePath ?? null }
  })

  ipcMain.handle('native:dialog:message', async (_event, request: MessageRequest) => {
    if (!request || typeof request.message !== 'string') {
      throw new Error('message is required')
    }
    const options = {
      type: request.type ?? 'info',
      title: safeString(request.title) ?? 'AutoAgent',
      message: request.message,
      detail: safeString(request.detail),
      buttons: Array.isArray(request.buttons)
        ? request.buttons.filter((button): button is string => typeof button === 'string')
        : undefined,
      defaultId: Number.isInteger(request.defaultId) ? request.defaultId : undefined,
      cancelId: Number.isInteger(request.cancelId) ? request.cancelId : undefined,
    }
    const window = getWindow()
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    return { response: result.response, checkboxChecked: result.checkboxChecked }
  })
}
