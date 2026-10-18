const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // hotkeys ('' = off)
  clipHotkey: 'F8',
  shortClipHotkey: '',
  shortClipSeconds: 15,
  recordHotkey: 'F9',
  bufferHotkey: '',
  micMuteHotkey: '',
  // replay buffer
  bufferSeconds: 60,
  // video
  monitor: 0,
  resolution: '1080', // 'native' | '1440' | '1080' | '900' | '720' | '480'
  fps: 60,
  codec: 'h264', // 'h264' | 'hevc'
  encoder: 'auto', // 'auto' | 'nvenc' | 'amf' | 'qsv' | 'cpu'
  encoderPreset: 'balanced', // 'speed' | 'balanced' | 'quality'
  rateControl: 'quality', // 'quality' (constant quality) | 'bitrate' (fixed Mbps)
  quality: 'high', // 'low' | 'medium' | 'high' | 'ultra'
  bitrateMbps: 20,
  captureCursor: true,
  // audio
  systemAudio: true,
  systemVolume: 1,
  mic: false,
  micDeviceId: 'default',
  micVolume: 1,
  micNoiseSuppression: true,
  micEchoCancellation: false,
  splitAudio: true, // save game and mic as separate tracks
  audioBitrate: 160,
  // general
  outputDir: '',
  startBufferOnLaunch: true,
  startMinimized: false,
  launchAtStartup: false,
  closeToTray: true,
  showNotifications: true,
  clipSound: true,
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  const s = { ...DEFAULTS, ...saved };
  const legacy = /^h264_(\w+)$/.exec(s.encoder); // v1.0/1.1 stored full encoder names
  if (legacy) s.encoder = legacy[1];
  if (s.encoder === 'libx264') s.encoder = 'cpu';
  if (!s.outputDir) s.outputDir = path.join(app.getPath('videos'), 'Replix');
  fs.mkdirSync(s.outputDir, { recursive: true });
  return s;
}

function save(s) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

module.exports = { load, save, DEFAULTS };
