const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', {
  onToast: (cb) => ipcRenderer.on('toast', (_e, t) => cb(t)),
});
