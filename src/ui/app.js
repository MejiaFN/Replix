const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = window.replix;

let settings = {}, status = {}, clips = [], filter = 'all', current = null;

const fmtTime = (t, dec = false) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${dec ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')}`;
};
const fmtSize = (b) => b > 1 << 30 ? (b / (1 << 30)).toFixed(2) + ' GB' : (b / (1 << 20)).toFixed(1) + ' MB';
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------- navigation ----------
function show(view) {
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  $$('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === (view === 'player' ? 'library' : view)));
  if (view !== 'player') $('#video').pause();
}
$$('.nav').forEach((n) => n.addEventListener('click', () => show(n.dataset.view)));
$$('[data-win]').forEach((b) => b.addEventListener('click', () => api.win(b.dataset.win)));

// ---------- capture bar ----------
let recTimer;
function renderStatus() {
  const pulse = $('#pulse');
  pulse.className = 'pulse' + (status.recording ? ' rec' : status.buffering ? ' on' : '');
  $('#stateTitle').textContent = status.recording ? 'Recording' : status.buffering ? 'Replay buffer on' : 'Replay buffer off';
  $('#bufferBtn').classList.toggle('on', !!status.buffering);
  $('#bufferBtn').textContent = status.buffering ? 'Buffer: ON' : 'Buffer: OFF';
  $('#clipBtn').disabled = !status.buffering;
  $('#recBtn').classList.toggle('active', !!status.recording);
  $('#recLabel').textContent = status.recording ? 'Stop' : 'Record';
  clearInterval(recTimer);
  const sub = () => {
    $('#stateSub').textContent = status.recording
      ? `${fmtTime((Date.now() - status.recordingStarted) / 1000)} elapsed · press ${settings.recordHotkey} to stop`
      : status.buffering ? `Press ${settings.clipHotkey} to save the last ${settings.bufferSeconds}s`
      : 'Turn the buffer on to start clipping';
  };
  sub();
  if (status.recording) recTimer = setInterval(sub, 1000);
  $('#engine').innerHTML = status.encoder
    ? `Encoder: <b>${status.encoder.replace('h264_', '').toUpperCase()}</b><br>Capture: <b>${status.captureMode}</b>` : '';
}
$('#bufferBtn').addEventListener('click', () => api.toggleBuffer());
let micMuted = false;
function renderMic() {
  const b = $('#micBtn');
  b.hidden = !settings.mic;
  b.textContent = micMuted ? '🔇 Mic muted' : '🎙 Mic on';
  b.classList.toggle('muted', micMuted);
}
$('#micBtn').addEventListener('click', () => api.toggleMicMute());
api.onMicMuted((m) => { micMuted = m; renderMic(); });
$('#clipBtn').addEventListener('click', () => api.saveClip());
$('#recBtn').addEventListener('click', () => api.toggleRecord());
api.onStatus((s) => { status = s; renderStatus(); });

// ---------- library ----------
async function loadClips() {
  clips = await api.listClips();
  renderGrid();
}

function renderGrid() {
  const q = $('#search').value.toLowerCase();
  const list = clips.filter((c) => (filter === 'all' || c.kind === filter) && c.name.toLowerCase().includes(q));
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#empty').hidden = clips.length > 0;
  for (const c of list) {
    const el = document.createElement('div');
    el.className = 'clip';
    el.innerHTML = `<div class="thumb"><span class="badge ${c.kind}">${c.kind === 'clip' ? 'CLIP' : 'REC'}</span><span class="dur"></span></div>
      <div class="meta"><div class="name"></div><div class="sub">${fmtDate(c.mtime)} · ${fmtSize(c.size)}</div></div>`;
    el.querySelector('.name').textContent = c.name.replace(/\.\w+$/, '');
    el.addEventListener('click', () => openClip(c));
    grid.appendChild(el);
    api.thumb(c.path).then((u) => { if (u) el.querySelector('.thumb').style.backgroundImage = `url("${u}")`; });
    // Read duration from metadata without decoding the whole file.
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = c.url;
    v.onloadedmetadata = () => { el.querySelector('.dur').textContent = fmtTime(v.duration); v.removeAttribute('src'); v.load(); };
  }
}
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  filter = t.dataset.filter;
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  renderGrid();
}));
$('#search').addEventListener('input', renderGrid);
$('#openFolder').addEventListener('click', () => api.openFolder());
api.onClipsChanged(loadClips);

// ---------- player + trim ----------
const video = $('#video');
let trimStart = 0, trimEnd = 0, previewing = false;

function openClip(c) {
  current = c;
  $('#ptitle').textContent = c.name;
  video.src = c.url;
  show('player');
  video.onloadedmetadata = () => { trimStart = 0; trimEnd = video.duration; renderTrim(); video.play(); };
}

function renderTrim() {
  const d = video.duration || 1;
  const a = (trimStart / d) * 100, b = (trimEnd / d) * 100;
  $('#hStart').style.left = a + '%';
  $('#hEnd').style.left = b + '%';
  $('#trimsel').style.left = a + '%';
  $('#trimsel').style.width = (b - a) + '%';
  $('#tStart').textContent = fmtTime(trimStart, true);
  $('#tEnd').textContent = fmtTime(trimEnd, true);
  $('#tLen').textContent = fmtTime(trimEnd - trimStart);
}

video.addEventListener('timeupdate', () => {
  $('#playhead').style.left = ((video.currentTime / (video.duration || 1)) * 100) + '%';
  if (previewing && video.currentTime >= trimEnd) { video.pause(); previewing = false; }
});

function timeAt(e) {
  const r = $('#trimbar').getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (video.duration || 0);
}
function drag(handle, apply) {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const move = (ev) => { apply(timeAt(ev)); renderTrim(); };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}
drag($('#hStart'), (t) => { trimStart = Math.min(t, trimEnd - 0.5); video.currentTime = trimStart; });
drag($('#hEnd'), (t) => { trimEnd = Math.max(t, trimStart + 0.5); video.currentTime = trimEnd; });
$('#trimbar').addEventListener('mousedown', (e) => { video.currentTime = timeAt(e); });
$('#setStart').addEventListener('click', () => { trimStart = Math.min(video.currentTime, trimEnd - 0.5); renderTrim(); });
$('#setEnd').addEventListener('click', () => { trimEnd = Math.max(video.currentTime, trimStart + 0.5); renderTrim(); });
$('#previewTrim').addEventListener('click', () => { video.currentTime = trimStart; previewing = true; video.play(); });
$('#saveTrim').addEventListener('click', async () => {
  const btn = $('#saveTrim');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await api.trim(current.path, trimStart, trimEnd);
    btn.textContent = 'Saved ✓';
  } catch (e) { alert('Trim failed: ' + e.message); btn.textContent = 'Save trimmed copy'; }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Save trimmed copy'; }, 1500);
});
$('#backBtn').addEventListener('click', () => { video.removeAttribute('src'); video.load(); show('library'); });
$('#revealBtn').addEventListener('click', () => api.reveal(current.path));
$('#deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Move "${current.name}" to the Recycle Bin?`)) return;
  video.removeAttribute('src'); video.load();
  await api.deleteClip(current.path);
  show('library');
  loadClips();
});
$('#renameBtn').addEventListener('click', () => {
  const t = $('#ptitle');
  const input = document.createElement('input');
  input.className = 'search';
  input.value = current.name.replace(/\.\w+$/, '');
  t.replaceChildren(input);
  input.focus(); input.select();
  const done = async (commit) => {
    if (commit && input.value.trim()) {
      const pos = video.currentTime;
      video.removeAttribute('src'); video.load(); // release the file handle
      try {
        const dest = await api.renameClip(current.path, input.value);
        await loadClips();
        const c = clips.find((x) => x.path === dest);
        if (c) { current = c; video.src = c.url; video.currentTime = pos; }
      } catch (e) { alert(e.message); video.src = current.url; }
    }
    t.textContent = current.name;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(false));
});

// ---------- settings ----------
const form = $('#settingsForm');

function fillSettings() {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name];
  }
  updateLabels();
  $('#clipKey').textContent = $('#emptyKey').textContent = settings.clipHotkey || '—';
  $('#recKey').textContent = settings.recordHotkey || '—';
  renderMic();
}
// Rough MB per minute at 1080p60 for the size hint (scaled by resolution and FPS).
const QUALITY_MBPS = { low: 6, medium: 10, high: 16, ultra: 28 };
const RES_SCALE = { native: 1.2, 1440: 1.7, 1080: 1, 900: 0.72, 720: 0.5, 480: 0.25 };

function updateLabels() {
  const v = form.elements;
  $('#bufVal').textContent = `${v.bufferSeconds.value}s`;
  $('#shortVal').textContent = `${v.shortClipSeconds.value}s`;
  $('#brVal').textContent = `${v.bitrateMbps.value} Mbps`;
  $('#sysVal').textContent = `${Math.round(v.systemVolume.value * 100)}%`;
  $('#micVal').textContent = `${Math.round(v.micVolume.value * 100)}%`;
  const mode = v.rateControl.value;
  $$('[data-show]').forEach((el) => (el.hidden = el.dataset.show !== mode));
  let mbps = mode === 'bitrate' ? Number(v.bitrateMbps.value)
    : QUALITY_MBPS[v.quality.value] * (RES_SCALE[v.resolution.value] || 1) * (Number(v.fps.value) / 60);
  if (mode !== 'bitrate' && v.codec.value === 'hevc') mbps *= 0.65;
  const perMin = (mbps * 60) / 8;
  $('#sizeHint').textContent = `About ${Math.round(perMin)} MB per minute · a ${v.bufferSeconds.value}s clip ≈ ${Math.round(perMin * v.bufferSeconds.value / 60)} MB`
    + (mode === 'bitrate' ? '' : ' (busy scenes use more)');
}
form.addEventListener('input', updateLabels);
form.addEventListener('change', updateLabels);

// Settings tabs
$$('.settab').forEach((t) => t.addEventListener('click', () => {
  $$('.settab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.settings .card').forEach((c) => (c.hidden = c.dataset.tab !== t.dataset.tab));
}));
$$('.settings .card').forEach((c) => (c.hidden = c.dataset.tab !== 'hotkeys'));

async function loadMics() {
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch {}
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  $('#micSel').innerHTML = '';
  for (const d of devs) {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || 'Microphone';
    $('#micSel').appendChild(o);
  }
  $('#micSel').value = settings.micDeviceId || 'default';
}

// Hotkey capture -> Electron accelerator string.
const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };
$$('.hotkey').forEach((inp) => {
  inp.placeholder = 'Off';
  inp.addEventListener('focus', () => { inp.classList.add('listening'); inp.dataset.prev = inp.value; inp.value = 'Press keys…'; });
  inp.addEventListener('blur', () => { inp.classList.remove('listening'); if (inp.value === 'Press keys…') inp.value = inp.dataset.prev; });
  inp.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') { inp.value = ''; inp.blur(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    let key = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    if (e.code.startsWith('Numpad')) key = 'num' + e.code.slice(6).toLowerCase().replace('decimal', 'dec').replace('add', 'add');
    inp.value = [...mods, key].join('+');
    inp.blur();
  });
});

$('#pickDir').addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (p) form.elements.outputDir.value = p;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') next[el.name] = el.checked;
    else if ('num' in el.dataset) next[el.name] = Number(el.value);
    else next[el.name] = el.value;
  }
  const keys = ['clipHotkey', 'shortClipHotkey', 'recordHotkey', 'bufferHotkey', 'micMuteHotkey'].map((k) => next[k]).filter(Boolean);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) { $('#saveMsg').textContent = `⚠ ${dup} is used for two actions. Pick different keys.`; return; }
  const r = await api.saveSettings(next);
  settings = r.settings;
  fillSettings();
  renderStatus();
  loadClips();
  $('#saveMsg').textContent = r.failedHotkeys.length
    ? `⚠ ${r.failedHotkeys.join(', ')} is taken by another app — pick a different key.` : 'Saved ✓';
  setTimeout(() => ($('#saveMsg').textContent = ''), 4000);
});

// ---------- updates ----------
let update = { state: 'idle' }, appVersion = '';
function renderUpdate() {
  const box = $('#update'), btn = $('#updateBtn'), text = $('#updateText');
  box.className = 'update' + (update.state === 'available' || update.state === 'ready' ? ' available' : '');
  $('#updateBar').hidden = update.state !== 'downloading';
  $('#updateFill').style.width = (update.percent || 0) + '%';
  btn.disabled = ['checking', 'downloading'].includes(update.state);
  const v = `Version ${appVersion}`;
  ({
    idle: () => { text.textContent = v; btn.textContent = 'Check for updates'; },
    checking: () => { text.textContent = v; btn.textContent = 'Checking…'; },
    latest: () => { text.textContent = `${v} · up to date ✓`; btn.textContent = 'Check for updates'; },
    available: () => { text.textContent = `Update available: v${update.version}`; btn.textContent = '⬇ Download update'; },
    downloading: () => { text.textContent = `Downloading v${update.version || ''}… ${update.percent || 0}%`; btn.textContent = 'Downloading…'; },
    ready: () => { text.textContent = `v${update.version} downloaded`; btn.textContent = '↻ Restart & update'; },
    error: () => { text.textContent = `${v} · ${update.message || 'Update check failed'}`; btn.textContent = 'Try again'; },
  }[update.state] || (() => {}))();
}
$('#updateBtn').addEventListener('click', () => {
  if (update.state === 'available') api.downloadUpdate();
  else if (update.state === 'ready') api.installUpdate();
  else api.checkUpdate();
});
api.onUpdate((u) => { update = u; renderUpdate(); });

// ---------- boot ----------
(async () => {
  const st = await api.state();
  settings = st.settings; status = st.status; appVersion = st.version; micMuted = !!st.micMuted;
  update = await api.updateState(); renderUpdate();
  $('#monitorSel').innerHTML = st.displays.map((d) => `<option value="${d.index}">${d.label}</option>`).join('');
  fillSettings();
  renderStatus();
  loadClips();
  loadMics();
})();
