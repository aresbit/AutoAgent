var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;

// src/preload.ts
var exports_preload = {};
module.exports = __toCommonJS(exports_preload);
var import_electron = require("electron");
var fetchPrefix = "electron-fetch:";
var abortChannel = (id) => `${fetchPrefix}abort:${id}`;
var preloadIPCRenderer = {
  on: (channel, listener) => {
    import_electron.ipcRenderer.on(channel, listener);
    return () => import_electron.ipcRenderer.off(channel, listener);
  },
  once: (channel, listener) => {
    import_electron.ipcRenderer.once(channel, listener);
    return () => import_electron.ipcRenderer.off(channel, listener);
  },
  invoke: (channel, ...args) => import_electron.ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => import_electron.ipcRenderer.send(channel, ...args),
  off: (channel, listener) => import_electron.ipcRenderer.off(channel, listener),
  removeAllListeners: (channel) => import_electron.ipcRenderer.removeAllListeners(channel),
  removeListener: (channel, listener) => import_electron.ipcRenderer.removeListener(channel, listener)
};
var preloadAPI = {
  getAccentColor: () => import_electron.ipcRenderer.invoke("getAccentColor"),
  getLocalSettings: () => import_electron.ipcRenderer.invoke("getLocalSettings"),
  getPathForFile: (file) => import_electron.webUtils.getPathForFile(file),
  setWindowBackground: (color) => import_electron.ipcRenderer.send("setWindowBackground", color),
  windowReady: () => import_electron.ipcRenderer.send("windowReady")
};
var api = {
  bootstrap: () => import_electron.ipcRenderer.invoke("app:bootstrap"),
  saveSettings: (settings) => import_electron.ipcRenderer.invoke("settings:save", settings),
  resolveProvider: (providerId, current) => import_electron.ipcRenderer.invoke("provider:resolve", providerId, current),
  selectCwd: () => import_electron.ipcRenderer.invoke("dialog:select-cwd"),
  createChat: () => import_electron.ipcRenderer.invoke("chat:create"),
  loadChat: (id) => import_electron.ipcRenderer.invoke("chat:load", id),
  listChats: () => import_electron.ipcRenderer.invoke("chat:list"),
  deleteChat: (id) => import_electron.ipcRenderer.invoke("chat:delete", id),
  branchChat: (id) => import_electron.ipcRenderer.invoke("chat:branch", id),
  sendPrompt: (request) => import_electron.ipcRenderer.invoke("agent:send", request),
  stopRun: (runId) => import_electron.ipcRenderer.invoke("agent:stop", runId),
  createArtifact: (input) => import_electron.ipcRenderer.invoke("artifact:create", input),
  listArtifacts: () => import_electron.ipcRenderer.invoke("artifact:list"),
  loadArtifact: (input) => import_electron.ipcRenderer.invoke("artifact:load", input),
  loadArtifactSource: (input) => import_electron.ipcRenderer.invoke("artifact:source", input),
  openArtifact: (input) => import_electron.ipcRenderer.invoke("artifact:open", input),
  autoworkCallMcpTool: (input) => import_electron.ipcRenderer.invoke("autowork:call-mcp-tool", input),
  autoworkAskClaude: (input) => import_electron.ipcRenderer.invoke("autowork:ask-claude", input),
  autoworkRunScheduledTask: (input) => import_electron.ipcRenderer.invoke("autowork:run-scheduled-task", input),
  autoworkNavigateHost: (input) => import_electron.ipcRenderer.invoke("autowork:navigate-host", input),
  autoworkOpenExternalUrl: (input) => import_electron.ipcRenderer.invoke("autowork:open-external-url", input),
  listArtifactVersions: (input) => import_electron.ipcRenderer.invoke("artifact:versions", input),
  exportArtifact: (input) => import_electron.ipcRenderer.invoke("artifact:export", input),
  importArtifact: () => import_electron.ipcRenderer.invoke("artifact:import"),
  onArtifactEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    import_electron.ipcRenderer.on("artifact:event", listener);
    return () => import_electron.ipcRenderer.off("artifact:event", listener);
  },
  listMcpServers: () => import_electron.ipcRenderer.invoke("mcp:list"),
  saveMcpServer: (server) => import_electron.ipcRenderer.invoke("mcp:save", server),
  toggleMcpServer: (id, enabled) => import_electron.ipcRenderer.invoke("mcp:toggle", { id, enabled }),
  deleteMcpServer: (id) => import_electron.ipcRenderer.invoke("mcp:delete", { id }),
  discoverMcpTools: (input) => import_electron.ipcRenderer.invoke("mcp:discover", input),
  listSkills: (cwd) => import_electron.ipcRenderer.invoke("skill:list", cwd),
  toggleSkill: (name, enabled, skillPath) => import_electron.ipcRenderer.invoke("skill:toggle", name, enabled, skillPath),
  gitStatus: (workDir) => import_electron.ipcRenderer.invoke("workspace:git-status", { workDir }),
  openExternal: (url) => import_electron.ipcRenderer.invoke("shell:open-external", url),
  onAgentEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    import_electron.ipcRenderer.on("agent:event", listener);
    return () => import_electron.ipcRenderer.off("agent:event", listener);
  }
};
import_electron.contextBridge.exposeInMainWorld("ipcRenderer", preloadIPCRenderer);
import_electron.contextBridge.exposeInMainWorld("api", preloadAPI);
import_electron.contextBridge.exposeInMainWorld("__electronFetchInternal", {
  request: (request) => import_electron.ipcRenderer.send(`${fetchPrefix}request`, request),
  onStream: (id, callback) => {
    import_electron.ipcRenderer.once(`${fetchPrefix}${id}`, (event) => {
      const port = event.ports[0];
      if (!port)
        return;
      port.onmessage = (message) => callback(message.data);
      port.start();
    });
  },
  abort: (id) => import_electron.ipcRenderer.send(abortChannel(id))
});
import_electron.contextBridge.exposeInMainWorld("autoagent", api);
