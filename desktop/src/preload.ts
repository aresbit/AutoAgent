import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * Native-only preload. Fixed channels only:
 * window controls, dialogs, clipboard, shell, notifications, theme, artifact
 * child window, navigation history and single-instance focus.
 *
 * Deliberately absent: generic invoke/send, filesystem, SQL, exec, fetch,
 * settings/business methods. The SPA talks to the backend over HTTP.
 */

function subscribe<Payload>(
  channel: string,
  handler: (payload: Payload) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, payload: Payload): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const windowControls = Object.freeze({
  minimize: (): Promise<void> => ipcRenderer.invoke('native:window:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('native:window:toggle-maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('native:window:close'),
  setFullScreen: (fullscreen: boolean): Promise<boolean> =>
    ipcRenderer.invoke('native:window:set-fullscreen', Boolean(fullscreen)),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('native:window:is-maximized'),
  onStateChanged: (handler: (state: { maximized: boolean; fullscreen: boolean }) => void): (() => void) =>
    subscribe('native:window:state-changed', handler),
})

const dialogs = Object.freeze({
  openFile: (request: unknown = {}): Promise<{ canceled: boolean; filePaths: string[] }> =>
    ipcRenderer.invoke('native:dialog:open', request),
  openDirectory: (request: unknown = {}): Promise<{ canceled: boolean; filePaths: string[] }> =>
    ipcRenderer.invoke('native:dialog:open', { ...(request as object), directory: true }),
  saveFile: (request: unknown = {}): Promise<{ canceled: boolean; filePath: string | null }> =>
    ipcRenderer.invoke('native:dialog:save', request),
  message: (request: unknown): Promise<{ response: number; checkboxChecked: boolean }> =>
    ipcRenderer.invoke('native:dialog:message', request),
})

const clipboard = Object.freeze({
  readText: (): Promise<string> => ipcRenderer.invoke('native:clipboard:read-text'),
  writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('native:clipboard:write-text', text),
  readImage: (): Promise<string | null> => ipcRenderer.invoke('native:clipboard:read-image'),
  writeImage: (dataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke('native:clipboard:write-image', dataUrl),
})

const shell = Object.freeze({
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('native:shell:open-external', url),
  showItemInFolder: (path: string): Promise<boolean> =>
    ipcRenderer.invoke('native:shell:show-item', path),
})

const notifications = Object.freeze({
  isSupported: (): Promise<boolean> => ipcRenderer.invoke('native:notification:is-supported'),
  show: (title: string, body = ''): Promise<boolean> =>
    ipcRenderer.invoke('native:notification:show', { title, body }),
})

const theme = Object.freeze({
  get: (): Promise<{ source: 'system' | 'light' | 'dark'; shouldUseDarkColors: boolean; accentColor: string | null }> =>
    ipcRenderer.invoke('native:theme:get'),
  set: (source: 'system' | 'light' | 'dark'): Promise<unknown> =>
    ipcRenderer.invoke('native:theme:set', source),
  onChange: (handler: (state: {
    source: 'system' | 'light' | 'dark'
    shouldUseDarkColors: boolean
    accentColor: string | null
  }) => void): (() => void) => subscribe('native:theme:changed', handler),
})

const artifact = Object.freeze({
  open: (url: string, title?: string): Promise<boolean> =>
    ipcRenderer.invoke('native:artifact:open', { url, title }),
  close: (): Promise<boolean> => ipcRenderer.invoke('native:artifact:close'),
})

const navigation = Object.freeze({
  back: (): Promise<void> => ipcRenderer.invoke('native:navigation:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('native:navigation:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('native:navigation:reload'),
  canGoBack: (): Promise<boolean> => ipcRenderer.invoke('native:navigation:can-go-back'),
  canGoForward: (): Promise<boolean> => ipcRenderer.invoke('native:navigation:can-go-forward'),
})

const api = Object.freeze({
  window: windowControls,
  dialogs,
  clipboard,
  shell,
  notifications,
  theme,
  artifact,
  navigation,
  onFocusRequested: (handler: () => void): (() => void) =>
    subscribe('native:single-instance:focus', handler),
})

contextBridge.exposeInMainWorld('autoagentNative', api)

export type AutoAgentNativeApi = typeof api
