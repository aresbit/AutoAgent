// src/artifact-preload.ts
var import_electron = require("electron");
var bridge = {
  callMcpTool: (name, args) => import_electron.ipcRenderer.invoke("autowork:call-mcp-tool", { name, args }),
  askClaude: (prompt, data) => import_electron.ipcRenderer.invoke("autowork:ask-claude", { prompt, data }),
  sample: (prompt, data) => import_electron.ipcRenderer.invoke("autowork:ask-claude", { prompt, data }),
  runScheduledTask: (taskId) => import_electron.ipcRenderer.invoke("autowork:run-scheduled-task", { taskId }),
  navigateHost: (direction) => import_electron.ipcRenderer.invoke("autowork:navigate-host", { direction }),
  openExternalUrl: (url) => import_electron.ipcRenderer.invoke("autowork:open-external-url", { url })
};
function handleAnchorClick(event) {
  if (!event.isTrusted)
    return;
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(target instanceof HTMLAnchorElement))
    return;
  if (target.protocol && target.protocol !== "autowork-artifact:") {
    event.preventDefault();
    bridge.openExternalUrl(target.href);
  }
}
import_electron.contextBridge.exposeInMainWorld("autowork", bridge);
import_electron.contextBridge.exposeInMainWorld("cowork", bridge);
window.addEventListener("click", (event) => {
  if (event.button === 0)
    handleAnchorClick(event);
}, true);
window.addEventListener("auxclick", (event) => {
  if (event.button === 1)
    handleAnchorClick(event);
}, true);
window.addEventListener("mouseup", (event) => {
  if (!event.isTrusted)
    return;
  if (event.button === 3) {
    event.preventDefault();
    bridge.navigateHost("back");
  } else if (event.button === 4) {
    event.preventDefault();
    bridge.navigateHost("forward");
  }
}, true);
