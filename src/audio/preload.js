const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('replixAudio', {
  pcm: (key, buf) => ipcRenderer.send('audio:pcm', key, new Uint8Array(buf)),
  log: (m) => ipcRenderer.send('audio:log', m),
  ready: () => ipcRenderer.send('audio:ready'),
  onConfig: (cb) => ipcRenderer.on('audio:config', (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on('audio:stop', () => cb()),
  onMicMute: (cb) => ipcRenderer.on('audio:micMute', (_e, m) => cb(m)),
});
