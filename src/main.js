const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, shell, screen,
  desktopCapturer, session, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const settingsStore = require('./settings');
const { Recorder } = require('./recorder');
const { autoUpdater } = require('electron-updater');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ICON = path.join(__dirname, 'ui', 'icon.png');

if (!app.requestSingleInstanceLock()) app.quit();

let settings, recorder, mainWin, audioWin, toastWin, tray;
let quitting = false;
let micMuted = false;
const launchedHidden = process.argv.includes('--hidden');
// Diagnostics go to %APPDATA%\Replix\replix.log (recreated each launch).
let logFile;
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${a.join(' ')}
`;
  try { logFile = logFile || path.join(app.getPath('userData'), 'replix.log'); fs.appendFileSync(logFile, line); } catch {}
};

function display() {
  return screen.getAllDisplays()[settings.monitor] || screen.getPrimaryDisplay();
}

function send(ch, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data);
}

function pushStatus() {
  send('status', recorder.status);
  updateTray();
}

// ---------- windows ----------
function createMain() {
  mainWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 960, minHeight: 600,
    frame: false, backgroundColor: '#07070d', icon: ICON, show: !settings.startMinimized && !launchedHidden,
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (settings.closeToTray === false) { quitting = true; app.quit(); } else mainWin.hide();
  });
}

function createAudio() {
  audioWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'audio', 'preload.js'), backgroundThrottling: false },
  });
  audioWin.loadFile(path.join(__dirname, 'audio', 'audio.html'));
}

function toast(title, body, kind = 'ok') {
  if (settings.showNotifications === false && kind !== 'err') return;
  const d = screen.getPrimaryDisplay().workArea;
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = new BrowserWindow({
      width: 340, height: 86, x: d.x + d.width - 360, y: d.y + 20,
      frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: false,
      alwaysOnTop: true, show: false, webPreferences: { preload: path.join(__dirname, 'ui', 'toast-preload.js') },
    });
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    toastWin.setIgnoreMouseEvents(true);
    toastWin.loadFile(path.join(__dirname, 'ui', 'toast.html'));
    toastWin.webContents.once('did-finish-load', () => toast(title, body, kind));
    return;
  }
  toastWin.webContents.send('toast', { title, body, kind, sound: settings.clipSound !== false });
  toastWin.showInactive();
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastWin && !toastWin.isDestroyed() && toastWin.hide(), 2800);
}

// ---------- tray ----------
function updateTray() {
  if (!tray) return;
  const st = recorder.status;
  tray.setToolTip(`Replix — ${st.recording ? 'Recording' : st.buffering ? 'Replay buffer on' : 'Idle'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Replix', click: () => { mainWin.show(); mainWin.focus(); } },
    { type: 'separator' },
    { label: `Save clip (${settings.clipHotkey || 'no hotkey'})`, enabled: st.buffering, click: () => saveClip() },
    { label: st.recording ? `Stop recording (${settings.recordHotkey})` : `Start recording (${settings.recordHotkey})`, click: toggleRecord },
    { label: st.buffering ? 'Turn replay buffer off' : 'Turn replay buffer on', click: toggleBuffer },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- capture actions ----------
function audioConfig() {
  const { systemAudio, systemVolume, mic, micDeviceId, micVolume, micNoiseSuppression, micEchoCancellation } = settings;
  return { systemAudio, systemVolume, mic, micDeviceId, micVolume, micNoiseSuppression, micEchoCancellation,
    inputs: recorder.audioInputs(settings) };
}

async function startCapture() {
  audioWin.webContents.send('audio:config', audioConfig());
  await recorder.start(settings, display());
}

async function stopCapture() {
  audioWin.webContents.send('audio:stop');
  await recorder.stop();
}

async function toggleBuffer() {
  try { recorder.status.buffering || recorder.wantRunning ? await stopCapture() : await startCapture(); }
  catch (e) { toast('Capture error', e.message, 'err'); }
  pushStatus();
}

let saving = false;
async function saveClip(seconds) {
  if (saving) return;
  saving = true;
  try {
    const out = await recorder.saveClip(seconds);
    toast('Clip saved', path.basename(out));
    send('clips:changed');
  } catch (e) {
    toast('Could not save clip', e.message.split('\n')[0], 'err');
    log(e.message);
  } finally { saving = false; }
}

async function toggleRecord() {
  try {
    if (recorder.status.recording) {
      toast('Saving recording…', 'Finishing file', 'rec');
      const out = await recorder.stopRecording();
      toast('Recording saved', path.basename(out));
      send('clips:changed');
    } else {
      if (!recorder.wantRunning) await startCapture();
      await recorder.startRecording();
      toast('Recording started', `Press ${settings.recordHotkey} to stop`, 'rec');
    }
  } catch (e) { toast('Recording error', e.message.split('\n')[0], 'err'); }
  pushStatus();
}

function toggleMicMute() {
  micMuted = !micMuted;
  audioWin.webContents.send('audio:micMute', micMuted);
  toast(micMuted ? 'Mic muted' : 'Mic unmuted', micMuted ? 'Your voice is not being recorded' : 'Your voice is being recorded', micMuted ? 'err' : 'ok');
  send('micMuted', micMuted);
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  const bind = (key, fn) => {
    if (!key) return;
    try { if (!globalShortcut.register(key, fn)) failed.push(key); } catch { failed.push(key); }
  };
  bind(settings.clipHotkey, () => saveClip());
  bind(settings.shortClipHotkey, () => saveClip(settings.shortClipSeconds));
  bind(settings.recordHotkey, toggleRecord);
  bind(settings.bufferHotkey, toggleBuffer);
  bind(settings.micMuteHotkey, toggleMicMute);
  return failed;
}

function applyStartup() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup, args: ['--hidden'] });
}

// ---------- clips ----------
const VIDEO_EXT = /\.(mp4|mkv|mov|webm)$/i;
const thumbDir = () => path.join(settings.outputDir, '.thumbs');

function listClips() {
  const dir = settings.outputDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => VIDEO_EXT.test(f)).map((f) => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return { path: p, url: pathToFileURL(p).href, name: f, size: st.size, mtime: st.mtimeMs,
      kind: f.includes('_Recording_') ? 'recording' : 'clip' };
  }).sort((a, b) => b.mtime - a.mtime);
}

function inOutputDir(p) {
  const rel = path.relative(settings.outputDir, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.on('audio:pcm', (_e, key, buf) => recorder.writeAudio(key, Buffer.from(buf)));
  ipcMain.on('audio:log', (_e, m) => log('audio:', m));
  ipcMain.on('audio:ready', () => {
    if (settings.startBufferOnLaunch) startCapture().catch((e) => toast('Capture error', e.message, 'err')).then(pushStatus);
  });

  ipcMain.handle('state', () => ({
    settings, status: recorder.status, version: app.getVersion(), micMuted,
    displays: screen.getAllDisplays().map((d, i) => ({ index: i, label: `Display ${i + 1} — ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}${d.id === screen.getPrimaryDisplay().id ? ' (primary)' : ''}` })),
  }));

  ipcMain.handle('settings:save', async (_e, next) => {
    const prev = settings;
    settings = { ...settings, ...next };
    fs.mkdirSync(settings.outputDir, { recursive: true });
    settingsStore.save(settings);
    const failed = registerHotkeys();
    applyStartup();
    const captureKeys = ['bufferSeconds', 'fps', 'resolution', 'quality', 'encoder', 'codec', 'rateControl', 'bitrateMbps',
      'encoderPreset', 'captureCursor', 'monitor', 'systemAudio', 'mic', 'micDeviceId', 'systemVolume', 'micVolume',
      'splitAudio', 'audioBitrate', 'micNoiseSuppression', 'micEchoCancellation'];
    if (captureKeys.some((k) => prev[k] !== settings[k]) && recorder.wantRunning && !recorder.status.recording) {
      audioWin.webContents.send('audio:config', audioConfig());
      await recorder.restart(settings, display());
    }
    pushStatus();
    return { settings, failedHotkeys: failed };
  });

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.outputDir });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('capture:buffer', toggleBuffer);
  ipcMain.handle('capture:clip', () => saveClip());
  ipcMain.handle('capture:micMute', toggleMicMute);
  ipcMain.handle('capture:record', toggleRecord);

  ipcMain.handle('clips:list', listClips);
  ipcMain.handle('clips:thumb', async (_e, p) => {
    if (!inOutputDir(p)) return null;
    fs.mkdirSync(thumbDir(), { recursive: true });
    const t = path.join(thumbDir(), path.basename(p) + '.jpg');
    if (!fs.existsSync(t) || fs.statSync(t).mtimeMs < fs.statSync(p).mtimeMs) await recorder.thumbnail(p, t).catch(() => null);
    return fs.existsSync(t) ? pathToFileURL(t).href + '?v=' + Math.round(fs.statSync(t).mtimeMs) : null;
  });
  ipcMain.handle('clips:delete', async (_e, p) => {
    if (!inOutputDir(p)) return false;
    await shell.trashItem(p); // Recycle Bin, so it can be restored
    try { fs.unlinkSync(path.join(thumbDir(), path.basename(p) + '.jpg')); } catch {}
    return true;
  });
  ipcMain.handle('clips:rename', (_e, p, name) => {
    if (!inOutputDir(p)) return null;
    const clean = name.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!clean) return null;
    const dest = path.join(path.dirname(p), clean + path.extname(p));
    if (fs.existsSync(dest)) throw new Error('A clip with that name already exists');
    fs.renameSync(p, dest);
    try { fs.unlinkSync(path.join(thumbDir(), path.basename(p) + '.jpg')); } catch {}
    return dest;
  });
  ipcMain.handle('clips:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('clips:openFolder', () => shell.openPath(settings.outputDir));
  ipcMain.handle('clips:trim', async (_e, p, start, end) => {
    if (!inOutputDir(p)) return null;
    const out = await recorder.trim(p, start, end);
    send('clips:changed');
    return out;
  });

  ipcMain.on('win', (_e, action) => {
    if (action === 'min') mainWin.minimize();
    else if (action === 'max') mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize();
    else if (action === 'close') mainWin.hide();
  });
}

// ---------- updates ----------
// Checks GitHub Releases (see "publish" in package.json). Only the installed
// (Setup.exe) build can update itself; dev runs and the portable exe just report it.
let updateState = { state: 'idle' };
function setUpdate(u) { updateState = u; send('update', u); }

function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => setUpdate({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ ...updateState, state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ state: 'ready', version: i.version });
    toast('Update ready', `Replix ${i.version} installs when you restart`);
  });
  autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: String(e && e.message || e).split('\n')[0] }));

  ipcMain.handle('update:state', () => updateState);
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate().catch(() => {}));
  ipcMain.handle('update:install', async () => {
    quitting = true;
    app._stopping = true;
    await recorder.stop().catch(() => {});
    autoUpdater.quitAndInstall(false, true);
  });

  checkForUpdates();
  setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
}

function checkForUpdates() {
  if (!app.isPackaged) return setUpdate({ state: 'error', message: 'Updates only work in the installed app' });
  if (process.env.PORTABLE_EXECUTABLE_FILE) return setUpdate({ state: 'error', message: "The portable version can't self-update; use the installer" });
  if (['downloading', 'ready'].includes(updateState.state)) return;
  return autoUpdater.checkForUpdates().catch(() => {});
}

// ---------- boot ----------
app.whenReady().then(() => {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'replix.log'), ''); } catch {}
  settings = settingsStore.load();
  recorder = new Recorder(ffmpegPath, path.join(app.getPath('temp'), 'replix'));
  recorder.on('status', pushStatus);
  recorder.on('log', (m) => log(m));
  recorder.on('error', (m) => { toast('Capture stopped', m.split('\n').slice(-2).join(' ').slice(0, 120), 'err'); log(m); pushStatus(); });

  // System audio: hand Chromium's getDisplayMedia a screen source with WASAPI loopback audio.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'display-capture'].includes(perm)));

  setupIpc();
  setupUpdater();
  createMain();
  createAudio();

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', () => { mainWin.show(); mainWin.focus(); });
  updateTray();

  applyStartup();
  const failed = registerHotkeys();
  if (failed.length) toast('Hotkey unavailable', `${failed.join(', ')} is used by another app. Change it in Settings.`, 'err');
});

app.on('second-instance', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
app.on('before-quit', (e) => {
  quitting = true;
  if (recorder && (recorder.wantRunning || recorder.status.recording) && !app._stopping) {
    e.preventDefault();
    app._stopping = true;
    recorder.stop().finally(() => app.quit());
  }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {});
