const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, shell, screen,
  desktopCapturer, session, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const settingsStore = require('./settings');
const { Recorder } = require('./recorder');
const { Watcher, comboMask } = require('./watcher');
const { detectGame, fileSafe } = require('./games');
const { clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ICON = path.join(__dirname, 'ui', 'icon.png');

if (!app.requestSingleInstanceLock()) app.quit();

let settings, recorder, mainWin, audioWin, toastWin, tray, watcher;
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
  const mon = recorder && recorder.monitorOverride != null ? recorder.monitorOverride : settings.monitor;
  return screen.getAllDisplays()[mon] || screen.getPrimaryDisplay();
}

function send(ch, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data);
}

function pushStatus() {
  send('status', { ...recorder.status, game: currentGame && currentGame.name });
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
  // With popups off, the toast window still plays the alert sound, it just stays hidden.
  const popup = settings.showNotifications !== false || kind === 'err';
  if (!popup && settings.clipSound === false) return;
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
  if (!popup) return;
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

// ---------- games ----------
// currentGame: { name, pid, fg } while a game is running; lastGame keeps the name for a while after.
let currentGame = null, lastGame = null, lastGameAt = 0, lastFg = null, gameGoneTimer = null;

function gamePrefix() {
  const name = currentGame ? currentGame.name : Date.now() - lastGameAt < 2 * 60 * 1000 ? lastGame : null;
  return name ? fileSafe(name) : 'Replix';
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function onForeground(fg) {
  // Remember the last app that isn't Replix itself (for "Add as a game").
  if (fg.exe && !/^(replix|electron)$/i.test(fg.exe)) lastFg = fg;
  if (settings.gameDetection === false) return;
  const name = detectGame(fg, settings.customGames || []);
  if (name && (!currentGame || currentGame.pid !== fg.pid)) {
    const switched = !currentGame || currentGame.name !== name;
    currentGame = { name, pid: fg.pid, fg };
    lastGame = name; lastGameAt = Date.now();
    clearTimeout(gameGoneTimer); gameGoneTimer = null;
    log('game detected:', name, fg.exe);
    if (switched) toast(`${name} detected`, recorder.wantRunning ? `Press ${settings.clipHotkey} to clip` : 'Replay buffer starting…', 'ok', true);
    if (settings.gameOnlyBuffer && !recorder.wantRunning) startCapture().catch(() => {}).then(pushStatus);
    else if (settings.captureTarget === 'window') applyCrop(true);
    pushStatus();
  } else if (currentGame && currentGame.pid === fg.pid) {
    currentGame.fg = fg; // window moved/resized
    lastGameAt = Date.now();
  }
}

// Every few seconds: notice when the game process has exited.
setInterval(() => {
  if (!currentGame) return;
  if (alive(currentGame.pid)) { lastGameAt = Date.now(); return; }
  log('game closed:', currentGame.name);
  currentGame = null;
  pushStatus();
  if (settings.gameOnlyBuffer && recorder.wantRunning && !recorder.status.recording && !gameGoneTimer) {
    // Keep the buffer a little longer so a clip right after closing still works.
    gameGoneTimer = setTimeout(() => { gameGoneTimer = null; if (!currentGame && !recorder.status.recording) stopCapture().then(pushStatus); }, 60 * 1000);
  }
  if (settings.captureTarget === 'window') applyCrop(true);
}, 3000);

// Game-window capture: crop the capture to the game's window when it isn't fullscreen.
function cropFor() {
  if (settings.captureTarget !== 'window' || !currentGame || !currentGame.fg) return { crop: null, monitor: settings.monitor };
  const fg = currentGame.fg;
  const displays = screen.getAllDisplays();
  const idx = displays.findIndex((d) => Math.round(d.bounds.x * d.scaleFactor) === fg.mx && Math.round(d.bounds.y * d.scaleFactor) === fg.my);
  const monitor = idx >= 0 ? idx : settings.monitor;
  if (fg.full) return { crop: null, monitor };
  const x = Math.max(0, fg.x - fg.mx), y = Math.max(0, fg.y - fg.my);
  const w = Math.min(fg.w, fg.mw - x) & ~1, h = Math.min(fg.h, fg.mh - y) & ~1;
  if (w < 320 || h < 240) return { crop: null, monitor };
  return { crop: { x, y, w, h, absX: fg.mx + x, absY: fg.my + y }, monitor };
}

let lastCropKey = '';
async function applyCrop(restartIfChanged) {
  const { crop, monitor } = cropFor();
  recorder.crop = crop;
  recorder.monitorOverride = monitor;
  const key = JSON.stringify([crop, monitor]);
  if (restartIfChanged && key !== lastCropKey && recorder.wantRunning && !recorder.status.recording) {
    lastCropKey = key;
    await recorder.restart(captureSettings(), display());
  }
  lastCropKey = key;
}

function captureSettings() {
  return recorder.monitorOverride != null ? { ...settings, monitor: recorder.monitorOverride } : settings;
}

async function startCapture() {
  audioWin.webContents.send('audio:config', audioConfig());
  await applyCrop(false);
  await recorder.start(captureSettings(), display());
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
    const out = await recorder.saveClip(seconds, gamePrefix());
    toast('Clip saved', path.basename(out));
    send('clips:changed');
    cleanupStorage();
  } catch (e) {
    toast('Could not save clip', e.message.split('\n')[0], 'err');
    log(e.message);
  } finally { saving = false; }
}

async function toggleRecord() {
  try {
    if (recorder.status.recording) {
      toast('Saving recording…', 'Finishing file', 'rec');
      const marks = bookmarks;
      bookmarks = [];
      const out = await recorder.stopRecording();
      if (marks.length) setMeta(path.basename(out), { bookmarks: marks });
      toast('Recording saved', marks.length ? `${path.basename(out)} · ${marks.length} bookmark${marks.length === 1 ? '' : 's'}` : path.basename(out), 'ok');
      send('clips:changed');
      cleanupStorage();
    } else {
      if (!recorder.wantRunning) await startCapture();
      bookmarks = [];
      await recorder.startRecording(gamePrefix());
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

// ---------- screenshots + bookmarks ----------
let bookmarks = [];
function addBookmark() {
  if (!recorder.status.recording) return toast('No recording running', 'Bookmarks mark moments in a long recording', 'err');
  const t = Math.max(0, (Date.now() - recorder.recordingStarted) / 1000 - 1);
  bookmarks.push(Math.round(t * 10) / 10);
  toast('Bookmark added', `at ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`, 'mark');
}

async function takeScreenshot() {
  try {
    const { crop, monitor } = cropFor();
    const d = screen.getAllDisplays()[monitor] || screen.getPrimaryDisplay();
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((x) => String(x.display_id) === String(d.id)) || sources[0];
    let img = src.thumbnail;
    if (crop) img = img.crop({ x: crop.x, y: crop.y, width: crop.w, height: crop.h });
    const d2 = new Date(), pad = (n) => String(n).padStart(2, '0');
    const name = `${gamePrefix()}_Screenshot_${d2.getFullYear()}-${pad(d2.getMonth() + 1)}-${pad(d2.getDate())}_${pad(d2.getHours())}-${pad(d2.getMinutes())}-${pad(d2.getSeconds())}.png`;
    fs.writeFileSync(path.join(settings.outputDir, name), img.toPNG());
    toast('Screenshot saved', name, 'shot');
    send('clips:changed');
  } catch (e) { toast('Screenshot failed', e.message, 'err'); }
}

// ---------- controller ----------
let lastPad = 0;
function onPad(b) {
  const hit = (combo) => { const m = comboMask(combo); return m && (b & m) === m && (lastPad & m) !== m; };
  if (hit(settings.padClip)) saveClip();
  if (hit(settings.padRecord)) toggleRecord();
  lastPad = b;
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
  bind(settings.screenshotHotkey, takeScreenshot);
  bind(settings.bookmarkHotkey, addBookmark);
  return failed;
}

function applyStartup() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtStartup, args: ['--hidden'] });
}

// ---------- clips ----------
const VIDEO_EXT = /\.(mp4|mkv|mov|webm|gif|png)$/i;
const thumbDir = () => path.join(settings.outputDir, '.thumbs');

function listClips() {
  const dir = settings.outputDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => VIDEO_EXT.test(f)).map((f) => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    const m = /^(.+?)_(Clip|Recording|Screenshot)_/.exec(f);
    return { path: p, url: pathToFileURL(p).href, name: f, size: st.size, mtime: st.mtimeMs,
      game: m && m[1] !== 'Replix' ? m[1] : null,
      kind: /\.png$/i.test(f) ? 'screenshot' : /\.gif$/i.test(f) ? 'gif' : f.includes('_Recording_') ? 'recording' : 'clip' };
  }).sort((a, b) => b.mtime - a.mtime);
}

// Albums: { albums: [{ id, name, created, clips: [file names] }] } in userData.
// Clips are referenced by file name so albums survive changing the save folder.
const albumsFile = () => path.join(app.getPath('userData'), 'albums.json');
function loadAlbums() {
  try { return JSON.parse(fs.readFileSync(albumsFile(), 'utf8')); } catch { return { albums: [] }; }
}
function saveAlbums(a) { fs.writeFileSync(albumsFile(), JSON.stringify(a, null, 2)); }
function renameInAlbums(from, to) {
  const a = loadAlbums();
  a.albums.forEach((al) => { al.clips = al.clips.map((c) => (c === from ? to : c)).filter(Boolean); });
  saveAlbums(a);
}

// Per-file extras (bookmarks) keyed by file name, in userData/meta.json.
const metaFile = () => path.join(app.getPath('userData'), 'meta.json');
function loadMeta() { try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch { return {}; } }
function setMeta(name, data) { const m = loadMeta(); m[name] = { ...(m[name] || {}), ...data }; fs.writeFileSync(metaFile(), JSON.stringify(m)); }

// Storage limits: delete the oldest files first (never ones in an album, if protected).
function cleanupStorage() {
  const limit = (Number(settings.storageLimitGB) || 0) * (1 << 30);
  const days = Number(settings.deleteAfterDays) || 0;
  if (!limit && !days) return;
  const protectedNames = new Set(settings.protectAlbums === false ? [] : loadAlbums().albums.flatMap((a) => a.clips));
  const files = listClips().filter((c) => !protectedNames.has(c.name) && !/\.mkv$/i.test(c.name)).sort((a, b) => a.mtime - b.mtime);
  let total = listClips().reduce((n, c) => n + c.size, 0);
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  let removed = 0;
  for (const c of files) {
    const tooOld = cutoff && c.mtime < cutoff;
    if (!tooOld && !(limit && total > limit)) continue;
    try {
      fs.unlinkSync(c.path);
      try { fs.unlinkSync(path.join(thumbDir(), c.name + '.jpg')); } catch {}
      total -= c.size; removed++;
    } catch {}
  }
  if (removed) { log('storage cleanup removed', removed); send('clips:changed'); }
}
setInterval(() => settings && cleanupStorage(), 60 * 60 * 1000);

function inOutputDir(p) {
  const rel = path.relative(settings.outputDir, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------- Discord ----------
// Uploads a clip to the user's Discord webhook (squeezing it under the 10 MB limit if needed)
// and copies the attachment link.
async function shareToDiscord(p) {
  const hook = (settings.discordWebhook || '').trim();
  if (!/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(hook)) throw new Error('Add your Discord webhook link in Settings → Sharing first');
  if (!inOutputDir(p)) throw new Error('Not a Replix clip');
  const LIMIT = 10 * 1024 * 1024;
  let file = p, temp = null;
  if (fs.statSync(p).size > LIMIT * 0.97) {
    if (/\.png$/i.test(p)) throw new Error('Screenshot is over 10 MB');
    const dur = await new Promise((resolve) => require('child_process').execFile(ffmpegPath, ['-hide_banner', '-i', p], { windowsHide: true },
      (_e, _o, err) => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err || ''); resolve(m ? m[1] * 3600 + m[2] * 60 + Number(m[3]) : 30); }));
    temp = await recorder.exportClip(p, { start: 0, end: dur, targetMB: 9.3, tracks: await recorder.audioTrackCount(p) });
    file = temp;
  }
  try {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: `🎬 ${path.basename(p).replace(/\.\w+$/, '').replace(/_/g, ' ')}` }));
    form.append('files[0]', new Blob([fs.readFileSync(file)]), path.basename(file));
    const res = await fetch(hook + (hook.includes('?') ? '&' : '?') + 'wait=true', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Discord said ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const msg = await res.json();
    const url = msg.attachments && msg.attachments[0] && msg.attachments[0].url;
    if (url) clipboard.writeText(url);
    toast('Shared to Discord', url ? 'Link copied to clipboard' : 'Posted', 'ok');
    return { url };
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch {} }
  }
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
      'splitAudio', 'audioBitrate', 'micNoiseSuppression', 'micEchoCancellation', 'captureTarget'];
    if (captureKeys.some((k) => prev[k] !== settings[k]) && recorder.wantRunning && !recorder.status.recording) {
      audioWin.webContents.send('audio:config', audioConfig());
      await applyCrop(false);
      await recorder.restart(captureSettings(), display());
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
    renameInAlbums(path.basename(p), null);
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
    renameInAlbums(path.basename(p), path.basename(dest));
    return dest;
  });
  ipcMain.handle('albums:get', () => loadAlbums());
  ipcMain.handle('albums:set', (_e, a) => { saveAlbums(a); return a; });
  ipcMain.handle('clips:copyTo', async (_e, paths) => {
    const r = await dialog.showOpenDialog(mainWin, { title: 'Copy clips to…', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return 0;
    let n = 0;
    for (const p of paths.filter(inOutputDir)) {
      let dest = path.join(r.filePaths[0], path.basename(p));
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(r.filePaths[0], `${path.parse(p).name} (${i})${path.extname(p)}`);
      await fs.promises.copyFile(p, dest);
      n++;
    }
    return n;
  });
  ipcMain.handle('clips:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('clips:openFolder', () => shell.openPath(settings.outputDir));
  ipcMain.handle('meta:get', (_e, name) => loadMeta()[name] || {});
  ipcMain.handle('clips:tracks', (_e, p) => (inOutputDir(p) ? recorder.audioTrackCount(p) : 0));
  ipcMain.handle('clips:export', async (_e, p, opts) => {
    if (!inOutputDir(p)) return null;
    const out = await recorder.exportClip(p, { ...opts, tracks: await recorder.audioTrackCount(p) });
    send('clips:changed');
    return out;
  });
  ipcMain.handle('share:discord', async (_e, p) => shareToDiscord(p));
  ipcMain.handle('capture:screenshot', takeScreenshot);
  ipcMain.handle('games:current', () => ({ current: currentGame && currentGame.name, fg: lastFg && { exe: lastFg.exe, title: lastFg.title } }));
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
  watcher = new Watcher();
  watcher.on('foreground', onForeground);
  watcher.on('pad', onPad);
  watcher.start();
  cleanupStorage();
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
