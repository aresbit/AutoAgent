let e = require(`electron`);
const t = `electron-fetch:`;
const n = (e) => `${t}abort:${e}`;
function r() {
  e.contextBridge.exposeInMainWorld(`__electronFetchInternal`, {
    request: (n) => {
      e.ipcRenderer.send(`${t}request`, n);
    },
    onStream: (n, r) => {
      e.ipcRenderer.once(`${t}${n}`, (e) => {
        let t = e.ports[0];
        if (t) {
          t.onmessage = (e) => {
            r(e.data);
          };
          t.start();
        }
      });
    },
    abort: (t) => {
      e.ipcRenderer.send(n(t));
    },
  });
}
const i = {
  on: (t, n) => {
    e.ipcRenderer.on(t, n);
    return () => {
      e.ipcRenderer.off(t, n);
    };
  },
  once: (t, n) => {
    e.ipcRenderer.once(t, n);
    return () => {
      e.ipcRenderer.off(t, n);
    };
  },
  invoke: (t, ...n) => e.ipcRenderer.invoke(t, ...n),
  send: (t, ...n) => e.ipcRenderer.send(t, ...n),
  off: (t, n) => e.ipcRenderer.off(t, n),
  removeAllListeners: (t) => {
    e.ipcRenderer.removeAllListeners(t);
  },
  removeListener: (t, n) => {
    e.ipcRenderer.removeListener(t, n);
  },
};
const a = {
  getAccentColor: () => e.ipcRenderer.invoke(`getAccentColor`),
  getLocalSettings: () => e.ipcRenderer.invoke(`getLocalSettings`),
  getPathForFile: (t) => e.webUtils.getPathForFile(t),
  setWindowBackground: (t) => {
    e.ipcRenderer.send(`setWindowBackground`, t);
  },
  windowReady: () => {
    e.ipcRenderer.send(`windowReady`);
  },
};
e.contextBridge.exposeInMainWorld(`ipcRenderer`, i);
e.contextBridge.exposeInMainWorld(`api`, a);
r();
exports.preloadAPI = a;
exports.preloadIPCRenderer = i;
