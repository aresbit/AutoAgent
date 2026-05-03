import { contextBridge, ipcRenderer } from 'electron';

type HostDirection = 'back' | 'forward';

const bridge = {
  callMcpTool: (name: string, args?: unknown) => ipcRenderer.invoke('autowork:call-mcp-tool', { name, args }),
  askClaude: (prompt: string, data?: unknown) => ipcRenderer.invoke('autowork:ask-claude', { prompt, data }),
  sample: (prompt: string, data?: unknown) => ipcRenderer.invoke('autowork:ask-claude', { prompt, data }),
  runScheduledTask: (taskId: string) => ipcRenderer.invoke('autowork:run-scheduled-task', { taskId }),
  navigateHost: (direction: HostDirection) => ipcRenderer.invoke('autowork:navigate-host', { direction }),
  openExternalUrl: (url: string) => ipcRenderer.invoke('autowork:open-external-url', { url }),
};

function handleAnchorClick(event: MouseEvent) {
  if (!event.isTrusted) return;
  const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(target instanceof HTMLAnchorElement)) return;
  if (target.protocol && target.protocol !== 'autowork-artifact:') {
    event.preventDefault();
    void bridge.openExternalUrl(target.href);
  }
}

contextBridge.exposeInMainWorld('autowork', bridge);
contextBridge.exposeInMainWorld('cowork', bridge);

window.addEventListener('click', (event) => {
  if (event.button === 0) handleAnchorClick(event);
}, true);

window.addEventListener('auxclick', (event) => {
  if (event.button === 1) handleAnchorClick(event);
}, true);

window.addEventListener('mouseup', (event) => {
  if (!event.isTrusted) return;
  if (event.button === 3) {
    event.preventDefault();
    void bridge.navigateHost('back');
  } else if (event.button === 4) {
    event.preventDefault();
    void bridge.navigateHost('forward');
  }
}, true);
