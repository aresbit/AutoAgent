// src/preload.ts
import { contextBridge, ipcRenderer, webUtils } from "electron";
var fetchPrefix = "electron-fetch:";
var abortChannel = (id) => `${fetchPrefix}abort:${id}`;
var preloadIPCRenderer = {
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
  once: (channel, listener) => {
    ipcRenderer.once(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  off: (channel, listener) => ipcRenderer.off(channel, listener),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener)
};
var preloadAPI = {
  getAccentColor: () => ipcRenderer.invoke("getAccentColor"),
  getLocalSettings: () => ipcRenderer.invoke("getLocalSettings"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  setWindowBackground: (color) => ipcRenderer.send("setWindowBackground", color),
  windowReady: () => ipcRenderer.send("windowReady")
};
var api = {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  resolveProvider: (providerId, current) => ipcRenderer.invoke("provider:resolve", providerId, current),
  selectCwd: () => ipcRenderer.invoke("dialog:select-cwd"),
  createChat: () => ipcRenderer.invoke("chat:create"),
  loadChat: (id) => ipcRenderer.invoke("chat:load", id),
  listChats: () => ipcRenderer.invoke("chat:list"),
  deleteChat: (id) => ipcRenderer.invoke("chat:delete", id),
  branchChat: (id) => ipcRenderer.invoke("chat:branch", id),
  sendPrompt: (request) => ipcRenderer.invoke("agent:send", request),
  stopRun: (runId) => ipcRenderer.invoke("agent:stop", runId),
  listMcpServers: () => ipcRenderer.invoke("mcp:list"),
  saveMcpServer: (server) => ipcRenderer.invoke("mcp:save", server),
  toggleMcpServer: (id, enabled) => ipcRenderer.invoke("mcp:toggle", { id, enabled }),
  deleteMcpServer: (id) => ipcRenderer.invoke("mcp:delete", { id }),
  discoverMcpTools: (input) => ipcRenderer.invoke("mcp:discover", input),
  listSkills: (cwd) => ipcRenderer.invoke("skill:list", cwd),
  toggleSkill: (name, enabled) => ipcRenderer.invoke("skill:toggle", name, enabled),
  gitStatus: (workDir) => ipcRenderer.invoke("workspace:git-status", { workDir }),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  onAgentEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.off("agent:event", listener);
  }
};
contextBridge.exposeInMainWorld("ipcRenderer", preloadIPCRenderer);
contextBridge.exposeInMainWorld("api", preloadAPI);
contextBridge.exposeInMainWorld("__electronFetchInternal", {
  request: (request) => ipcRenderer.send(`${fetchPrefix}request`, request),
  onStream: (id, callback) => {
    ipcRenderer.once(`${fetchPrefix}${id}`, (event) => {
      const port = event.ports[0];
      if (!port)
        return;
      port.onmessage = (message) => callback(message.data);
      port.start();
    });
  },
  abort: (id) => ipcRenderer.send(abortChannel(id))
});
contextBridge.exposeInMainWorld("autoagent", api);
