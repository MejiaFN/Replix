const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('replix', {
  state: invoke('state'),
  saveSettings: invoke('settings:save'),
  pickFolder: invoke('pick-folder'),
  toggleBuffer: invoke('capture:buffer'),
  saveClip: invoke('capture:clip'),
  toggleRecord: invoke('capture:record'),
  toggleMicMute: invoke('capture:micMute'),
  onMicMuted: (cb) => ipcRenderer.on('micMuted', (_e, m) => cb(m)),
  listClips: invoke('clips:list'),
  thumb: invoke('clips:thumb'),
  deleteClip: invoke('clips:delete'),
  copyClips: invoke('clips:copyTo'),
  renameClip: invoke('clips:rename'),
  reveal: invoke('clips:reveal'),
  openFolder: invoke('clips:openFolder'),
  trim: invoke('clips:trim'),
  updateState: invoke('update:state'),
  checkUpdate: invoke('update:check'),
  downloadUpdate: invoke('update:download'),
  installUpdate: invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, u) => cb(u)),
  win: (a) => ipcRenderer.send('win', a),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  onClipsChanged: (cb) => ipcRenderer.on('clips:changed', () => cb()),
});
