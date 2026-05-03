import { contextBridge, ipcRenderer, webUtils } from 'electron';

const fetchPrefix = 'electron-fetch:';
const abortChannel = (id: string) => `${fetchPrefix}abort:${id}`;

const preloadIPCRenderer = {
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, listener as any);
    return () => ipcRenderer.off(channel, listener as any);
  },
  once: (channel: string, listener: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, listener as any);
    return () => ipcRenderer.off(channel, listener as any);
  },
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  off: (channel: string, listener: (...args: unknown[]) => void) => ipcRenderer.off(channel, listener as any),
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
  removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
    ipcRenderer.removeListener(channel, listener as any),
};

const preloadAPI = {
  getAccentColor: () => ipcRenderer.invoke('getAccentColor'),
  getLocalSettings: () => ipcRenderer.invoke('getLocalSettings'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  setWindowBackground: (color: string) => ipcRenderer.send('setWindowBackground', color),
  windowReady: () => ipcRenderer.send('windowReady'),
};

const api = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  resolveProvider: (providerId: string, current: unknown) => ipcRenderer.invoke('provider:resolve', providerId, current),
  selectCwd: () => ipcRenderer.invoke('dialog:select-cwd'),
  createChat: () => ipcRenderer.invoke('chat:create'),
  loadChat: (id: string) => ipcRenderer.invoke('chat:load', id),
  listChats: () => ipcRenderer.invoke('chat:list'),
  deleteChat: (id: string) => ipcRenderer.invoke('chat:delete', id),
  branchChat: (id: string) => ipcRenderer.invoke('chat:branch', id),
  sendPrompt: (request: unknown) => ipcRenderer.invoke('agent:send', request),
  stopRun: (runId: string) => ipcRenderer.invoke('agent:stop', runId),
  createArtifact: (input: unknown) => ipcRenderer.invoke('artifact:create', input),
  listArtifacts: () => ipcRenderer.invoke('artifact:list'),
  loadArtifact: (input: unknown) => ipcRenderer.invoke('artifact:load', input),
  loadArtifactSource: (input: unknown) => ipcRenderer.invoke('artifact:source', input),
  openArtifact: (input: unknown) => ipcRenderer.invoke('artifact:open', input),
  autoworkCallMcpTool: (input: unknown) => ipcRenderer.invoke('autowork:call-mcp-tool', input),
  autoworkAskClaude: (input: unknown) => ipcRenderer.invoke('autowork:ask-claude', input),
  autoworkRunScheduledTask: (input: unknown) => ipcRenderer.invoke('autowork:run-scheduled-task', input),
  autoworkNavigateHost: (input: unknown) => ipcRenderer.invoke('autowork:navigate-host', input),
  autoworkOpenExternalUrl: (input: unknown) => ipcRenderer.invoke('autowork:open-external-url', input),
  listArtifactVersions: (input: unknown) => ipcRenderer.invoke('artifact:versions', input),
  exportArtifact: (input: unknown) => ipcRenderer.invoke('artifact:export', input),
  importArtifact: () => ipcRenderer.invoke('artifact:import'),
  onArtifactEvent: (handler: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on('artifact:event', listener);
    return () => ipcRenderer.off('artifact:event', listener);
  },
  listMcpServers: () => ipcRenderer.invoke('mcp:list'),
  saveMcpServer: (server: unknown) => ipcRenderer.invoke('mcp:save', server),
  toggleMcpServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggle', { id, enabled }),
  deleteMcpServer: (id: string) => ipcRenderer.invoke('mcp:delete', { id }),
  discoverMcpTools: (input?: unknown) => ipcRenderer.invoke('mcp:discover', input),
  listSkills: (cwd?: string) => ipcRenderer.invoke('skill:list', cwd),
  toggleSkill: (name: string, enabled: boolean, skillPath?: string) => ipcRenderer.invoke('skill:toggle', name, enabled, skillPath),
  gitStatus: (workDir: string) => ipcRenderer.invoke('workspace:git-status', { workDir }),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  onAgentEvent: (handler: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.off('agent:event', listener);
  },
};

contextBridge.exposeInMainWorld('ipcRenderer', preloadIPCRenderer);
contextBridge.exposeInMainWorld('api', preloadAPI);
contextBridge.exposeInMainWorld('__electronFetchInternal', {
  request: (request: unknown) => ipcRenderer.send(`${fetchPrefix}request`, request),
  onStream: (id: string, callback: (payload: unknown) => void) => {
    ipcRenderer.once(`${fetchPrefix}${id}`, (event) => {
      const port = event.ports[0];
      if (!port) return;
      port.onmessage = (message) => callback(message.data);
      port.start();
    });
  },
  abort: (id: string) => ipcRenderer.send(abortChannel(id)),
});
contextBridge.exposeInMainWorld('autoagent', api);

export type AutoAgentBridge = typeof api;
