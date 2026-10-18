const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  clipHotkey: 'F8',
  recordHotkey: 'F9',
  bufferSeconds: 60,
  fps: 60,
  resolution: '1080', // 'native' | '1440' | '1080' | '720'
  quality: 'high', // 'low' | 'medium' | 'high'
  encoder: 'auto', // 'auto' | 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'libx264'
  monitor: 0,
  outputDir: '',
  systemAudio: true,
  systemVolume: 1,
  mic: false,
  micDeviceId: 'default',
  micVolume: 1,
  startBufferOnLaunch: true,
  startMinimized: false,
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  const s = { ...DEFAULTS, ...saved };
  if (!s.outputDir) s.outputDir = path.join(app.getPath('videos'), 'Replix');
  fs.mkdirSync(s.outputDir, { recursive: true });
  return s;
}

function save(s) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

module.exports = { load, save, DEFAULTS };
