const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('replixAudio', {
  pcm: (buf) => ipcRenderer.send('audio:pcm', new Uint8Array(buf)),
  log: (m) => ipcRenderer.send('audio:log', m),
  ready: () => ipcRenderer.send('audio:ready'),
  onConfig: (cb) => ipcRenderer.on('audio:config', (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on('audio:stop', () => cb()),
});
