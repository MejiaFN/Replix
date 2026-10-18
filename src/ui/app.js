const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = window.replix;

let settings = {}, status = {}, clips = [], albums = { albums: [] }, micMuted = false;
let update = { state: 'idle' }, appVersion = '';

const fmtTime = (t, dec = false) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${dec ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')}`;
};
const fmtSize = (b) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' GB' : Math.round(b / (1 << 20)) + ' MB');
const fmtAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 7 * 86400) return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
// Exports and trims are "edited"; screenshots and GIFs keep their own kind.
const kindOf = (c) => (c.kind === 'screenshot' ? 'screenshot' : /_(trim|edit|vertical|gif|\d+MB)_/.test(c.name) ? 'trim' : c.kind);
const KIND_LABEL = { clip: 'CLIP', recording: 'REC', trim: 'EDIT', screenshot: 'SHOT', gif: 'GIF' };
const isImage = (c) => c.kind === 'screenshot' || c.kind === 'gif';
const baseName = (p) => p.split(/[\\/]/).pop();
const isToday = (ms) => new Date(ms).toDateString() === new Date().toDateString();

// ---------- navigation ----------
let current = 'home', prevView = 'home';
function show(view) {
  if (view !== 'player') $('#video').pause();
  if (current !== 'player') prevView = current;
  current = view;
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  const railView = view === 'player' ? prevView : view;
  $$('.rbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === railView));
}
$$('.rbtn').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'clips') openClips({});
  else show(b.dataset.view);
}));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => openClips({})));
$$('[data-win]').forEach((b) => b.addEventListener('click', () => api.win(b.dataset.win)));

// ---------- top bar + hero ----------
let recTimer;
function renderStatus() {
  const on = !!status.buffering, rec = !!status.recording;
  $('#bufferDot').className = 'dot' + (on ? ' on' : '');
  $('#bufferLabel').textContent = on ? 'Replay buffer on' : 'Replay buffer off';
  $('#clipKey').textContent = settings.clipHotkey || '—';
  $('#clipChipLabel').textContent = `Clip ${settings.bufferSeconds >= 60 && settings.bufferSeconds % 60 === 0 ? settings.bufferSeconds / 60 + 'm' : settings.bufferSeconds + 's'}`;
  $('#clipChip').disabled = !on;
  $('#recKey').textContent = settings.recordHotkey || '—';
  $('#recChip').classList.toggle('rec', rec);
  $('#gameChip').hidden = settings.gameDetection === false;
  $('#gameChip').classList.toggle('playing', !!status.game);
  $('#gameLabel').textContent = status.game || 'Waiting for game';
  $('#gameNow').textContent = status.game ? `Playing ${status.game}` : 'No game detected';

  const hero = $('#hero');
  hero.className = 'hero' + (rec ? ' rec' : on ? '' : ' off');
  $('#heroDot').className = 'bigdot' + (rec ? ' rec' : on ? ' on' : '');
  $('#heroTitle').textContent = rec ? 'Recording' : on ? 'Replay buffer is on' : 'Replay buffer is off';
  $('#heroBuffer').textContent = on ? 'Turn off' : 'Turn on';
  $('#heroClip').disabled = !on;
  clearInterval(recTimer);
  const tick = () => {
    const el = fmtTime((Date.now() - status.recordingStarted) / 1000);
    $('#recLabel').textContent = rec ? `Recording ${el}` : 'Long recording';
    $('#heroSub').textContent = rec ? `${el} recorded. Press ${settings.recordHotkey || 'the record hotkey'} to stop.`
      : on ? `Press ${settings.clipHotkey || 'your clip hotkey'} anytime to save the last ${settings.bufferSeconds} seconds.`
      : 'Turn it on to start clipping.';
  };
  tick();
  if (rec) recTimer = setInterval(tick, 1000);
  $('#engineText').textContent = status.encoder
    ? `${status.encoder.replace(/_/g, ' ').toUpperCase()} · ${status.captureMode} capture${status.audioTracks && status.audioTracks.length ? ' · audio: ' + status.audioTracks.join(', ') : ''}` : 'Not capturing';
}
$('#bufferChip').addEventListener('click', () => api.toggleBuffer());
$('#heroBuffer').addEventListener('click', () => api.toggleBuffer());
$('#clipChip').addEventListener('click', () => api.saveClip());
$('#heroClip').addEventListener('click', () => api.saveClip());
$('#recChip').addEventListener('click', () => api.toggleRecord());
$('#micChip').addEventListener('click', () => api.toggleMicMute());
api.onStatus((s) => { status = s; renderStatus(); });

function renderMic() {
  $('#micChip').hidden = !settings.mic;
  $('#micChip').classList.toggle('muted', micMuted);
  $('#micLabel').textContent = micMuted ? 'Mic muted' : 'Mic on';
}
api.onMicMuted((m) => { micMuted = m; renderMic(); });

// ---------- clip cards ----------
const thumbCache = new Map(), durCache = new Map();

function makeCard(c, { selectable = true } = {}) {
  const k = kindOf(c);
  const el = document.createElement('div');
  el.className = 'clip';
  el.dataset.path = c.path;
  el.innerHTML = `<div class="thumb"><span class="badge k-${k}">${KIND_LABEL[k]}</span>
      ${selectable ? '<button class="sel" title="Select">✓</button>' : ''}
      <span class="play"><svg><use href="#i-play"/></svg></span><span class="dur"></span></div>
    <div class="meta"><div class="name"></div><div class="sub">${c.game ? '<span class="g"></span><i></i>' : ''}<span>${fmtAgo(c.mtime)}</span><i></i><span>${fmtSize(c.size)}</span></div></div>`;
  $('.name', el).textContent = displayName(c);
  if (c.game) $('.g', el).textContent = c.game;
  el.title = c.name;
  const thumb = $('.thumb', el);
  const setThumb = (u) => { if (u) thumb.style.backgroundImage = `url("${u}")`; };
  if (thumbCache.has(c.path + c.mtime)) setThumb(thumbCache.get(c.path + c.mtime));
  else api.thumb(c.path).then((u) => { thumbCache.set(c.path + c.mtime, u); setThumb(u); });
  const durEl = $('.dur', el);
  if (isImage(c)) { durEl.remove(); if (c.kind === 'screenshot') $('.play', el).remove(); }
  else if (durCache.has(c.path + c.mtime)) durEl.textContent = durCache.get(c.path + c.mtime);
  else {
    // Read the duration from metadata without decoding the file.
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = c.url;
    v.onloadedmetadata = () => { const d = fmtTime(v.duration); durCache.set(c.path + c.mtime, d); durEl.textContent = d; v.removeAttribute('src'); v.load(); };
  }
  if (selectable) {
    $('.sel', el).addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(c, e); });
    // While anything is selected, clicking a card selects it instead of opening it.
    el.addEventListener('click', (e) => (selected.size || e.ctrlKey ? toggleSelect(c, e) : openClip(c)));
  } else el.addEventListener('click', () => openClip(c));
  return el;
}

// "Fortnite_Clip_2026-10-17_18-55-02.mp4" -> "Clip 2026-10-17 18-55-02" (the game is shown separately)
function displayName(c) {
  let n = c.name.replace(/\.\w+$/, '');
  if (c.game) n = n.slice(c.game.length + 1);
  return n.replace(/^Replix_/, '').replace(/_/g, ' ');
}

async function loadClips() {
  clips = await api.listClips();
  albums = await api.getAlbums();
  renderHome();
  renderClips();
  renderAlbums();
  renderStorage();
}
api.onClipsChanged(loadClips);

// ---------- home ----------
// Capture summary in the Home sidebar (the feed itself lives in social.js).
function renderHome() {
  $('#statClips').textContent = clips.filter((c) => c.kind === 'clip' || c.kind === 'recording').length;
  $('#statToday').textContent = clips.filter((c) => isToday(c.mtime)).length;
  $('#statSize').textContent = fmtSize(clips.reduce((n, c) => n + c.size, 0));
}

function renderStorage() {
  const bytes = clips.reduce((n, c) => n + c.size, 0);
  $('#railStorageText').textContent = fmtSize(bytes);
  // Ring fills against a soft 50 GB reference so it's a rough "how much" glance.
  const frac = Math.min(1, bytes / (50 * (1 << 30)));
  $('#ringFill').style.strokeDashoffset = String(94.2 * (1 - frac));
  $('#storageText').textContent = `${fmtSize(bytes)} in ${clips.length} file${clips.length === 1 ? '' : 's'}`;
}

// ---------- clips view ----------
let ctx = { album: null, quick: null }, filter = 'all';

function openClips(next) {
  ctx = { album: next.album || null, quick: next.quick || null, game: next.game || null };
  filter = next.filter || 'all';
  $$('#filterSeg button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  clearSelection();
  renderClips();
  show('clips');
}

function currentAlbum() { return ctx.album ? albums.albums.find((a) => a.id === ctx.album) : null; }

function visibleClips() {
  const q = $('#search').value.toLowerCase();
  const al = currentAlbum();
  let list = clips.filter((c) => (filter === 'all' || kindOf(c) === filter) && c.name.toLowerCase().includes(q));
  if (al) list = list.filter((c) => al.clips.includes(baseName(c.path)));
  if (ctx.quick === 'today') list = list.filter((c) => isToday(c.mtime));
  if (ctx.game) list = list.filter((c) => c.game === ctx.game);
  const sort = $('#sortSel').value;
  const cmp = { new: (a, b) => b.mtime - a.mtime, old: (a, b) => a.mtime - b.mtime, big: (a, b) => b.size - a.size, name: (a, b) => a.name.localeCompare(b.name) }[sort];
  return list.sort(cmp);
}

let visible = [];
function renderClips() {
  const al = currentAlbum();
  if (ctx.album && !al) ctx.album = null;
  $('#clipsTitle').textContent = al ? al.name : ctx.game || (ctx.quick === 'today' ? 'Today' : 'Clips');
  $('#albumBack').hidden = !al && !ctx.quick && !ctx.game;
  $('#selRemove').hidden = !al;
  visible = visibleClips();
  const g = $('#grid');
  g.replaceChildren(...visible.map((c) => makeCard(c)));
  $('#itemCount').textContent = `${visible.length} item${visible.length === 1 ? '' : 's'}`;
  const empty = visible.length === 0;
  $('#clipsEmpty').hidden = !empty;
  $('#clipsEmptyTitle').textContent = al ? 'This album is empty' : clips.length ? 'No matches' : 'No clips yet';
  $('#clipsEmptyText').textContent = al ? 'Select clips in the library and choose "Add to album".'
    : clips.length ? 'Try a different filter or search.' : `Press ${settings.clipHotkey || 'your clip hotkey'} while playing to save a clip.`;
  renderSelection();
}
$$('#filterSeg button').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.filter;
  $$('#filterSeg button').forEach((x) => x.classList.toggle('active', x === b));
  renderClips();
}));
$('#search').addEventListener('input', renderClips);
$('#sortSel').addEventListener('change', renderClips);
$('#openFolder').addEventListener('click', () => api.openFolder());
$('#albumBack').addEventListener('click', () => show('albums'));

// ---------- selection ----------
const selected = new Set();
let lastPicked = -1;

function toggleSelect(c, e) {
  const i = visible.indexOf(c);
  if (e && e.shiftKey && lastPicked >= 0 && i >= 0) {
    const [a, b] = [Math.min(lastPicked, i), Math.max(lastPicked, i)];
    visible.slice(a, b + 1).forEach((x) => selected.add(x.path));
  } else if (selected.has(c.path)) selected.delete(c.path);
  else selected.add(c.path);
  lastPicked = i;
  renderSelection();
}

function renderSelection() {
  for (const p of [...selected]) if (!clips.some((c) => c.path === p)) selected.delete(p);
  $$('#grid > .clip').forEach((el) => el.classList.toggle('selected', selected.has(el.dataset.path)));
  $('#grid').classList.toggle('selecting', selected.size > 0);
  $('#selbar').hidden = selected.size === 0;
  const bytes = clips.filter((c) => selected.has(c.path)).reduce((n, c) => n + c.size, 0);
  $('#selCount').textContent = `${selected.size} selected · ${fmtSize(bytes)}`;
  $('#selAll').textContent = visible.length && visible.every((c) => selected.has(c.path)) ? 'Select none' : 'Select all';
  if (!selected.size) $('#albumMenu').hidden = true;
}
function clearSelection() { selected.clear(); lastPicked = -1; renderSelection(); }

$('#selClear').addEventListener('click', clearSelection);
$('#selAll').addEventListener('click', () => {
  if (visible.every((c) => selected.has(c.path))) visible.forEach((c) => selected.delete(c.path));
  else visible.forEach((c) => selected.add(c.path));
  renderSelection();
});
$('#selReveal').addEventListener('click', () => { const p = [...selected][0]; if (p) api.reveal(p); });
$('#selCopy').addEventListener('click', async () => {
  const n = await api.copyClips([...selected]);
  if (n) { $('#selCount').textContent = `Copied ${n} file${n === 1 ? '' : 's'} ✓`; setTimeout(renderSelection, 1800); }
});
$('#selDelete').addEventListener('click', async () => {
  const n = selected.size;
  if (!confirm(`Move ${n} clip${n === 1 ? '' : 's'} to the Recycle Bin?`)) return;
  for (const p of selected) await api.deleteClip(p);
  selected.clear();
  await loadClips();
});
$('#selRemove').addEventListener('click', async () => {
  const al = currentAlbum();
  if (!al) return;
  const names = [...selected].map(baseName);
  al.clips = al.clips.filter((c) => !names.includes(c));
  albums = await api.setAlbums(albums);
  selected.clear();
  renderClips();
  renderAlbums();
});

// "Add to album" menu
$('#selAlbum').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#albumMenu');
  if (!m.hidden) { m.hidden = true; return; }
  m.innerHTML = '';
  const newBtn = document.createElement('button');
  newBtn.className = 'new';
  newBtn.innerHTML = '<svg class="ic"><use href="#i-plus"/></svg>New album…';
  newBtn.addEventListener('click', async () => {
    m.hidden = true;
    const name = await prompt2('New album', 'Create');
    if (name) addToAlbum(createAlbum(name));
  });
  m.appendChild(newBtn);
  if (albums.albums.length) m.appendChild(document.createElement('hr'));
  for (const al of albums.albums) {
    const b = document.createElement('button');
    b.innerHTML = '<svg class="ic"><use href="#i-albums"/></svg><span></span>';
    $('span', b).textContent = `${al.name} (${al.clips.length})`;
    b.addEventListener('click', () => { m.hidden = true; addToAlbum(al); });
    m.appendChild(b);
  }
  m.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menuwrap')) $('#albumMenu').hidden = true;
  if (!e.target.closest('.album')) $$('.album .menu').forEach((m) => (m.hidden = true));
});

function createAlbum(name) {
  const al = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, created: Date.now(), clips: [] };
  albums.albums.unshift(al);
  return al;
}
async function addToAlbum(al) {
  const names = [...selected].map(baseName).filter((n) => !al.clips.includes(n));
  al.clips.push(...names);
  albums = await api.setAlbums(albums);
  $('#selCount').textContent = `Added ${names.length} to "${al.name}" ✓`;
  setTimeout(renderSelection, 1600);
  renderAlbums();
}

document.addEventListener('keydown', (e) => {
  if (current !== 'clips' || e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape' && selected.size) clearSelection();
  if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); visible.forEach((c) => selected.add(c.path)); renderSelection(); }
  if (e.key === 'Delete' && selected.size) $('#selDelete').click();
});

// ---------- albums view ----------
$$('[data-quick]').forEach((b) => b.addEventListener('click', () => {
  const q = b.dataset.quick;
  openClips(q === 'today' ? { quick: 'today' } : { filter: q });
}));

function renderGames() {
  const groups = new Map();
  for (const c of clips) if (c.game) { if (!groups.has(c.game)) groups.set(c.game, []); groups.get(c.game).push(c); }
  const g = $('#gameGrid');
  g.innerHTML = '';
  $('#gamesHead').hidden = g.hidden = groups.size === 0;
  for (const [game, items] of [...groups].sort((a, b) => b[1][0].mtime - a[1][0].mtime)) {
    const el = document.createElement('div');
    el.className = 'album game';
    el.innerHTML = `<div class="cover"><svg><use href="#i-game"/></svg></div><div class="ameta"><b></b><span>${items.length} item${items.length === 1 ? '' : 's'} · ${fmtSize(items.reduce((n, c) => n + c.size, 0))}</span></div>`;
    $('b', el).textContent = game;
    const cover = items.find((c) => c.kind !== 'gif') || items[0];
    api.thumb(cover.path).then((u) => { if (u) { const cv = $('.cover', el); cv.style.backgroundImage = `url("${u}")`; $('svg', cv).remove(); } });
    el.addEventListener('click', () => openClips({ game }));
    g.appendChild(el);
  }
}

function renderAlbums() {
  renderGames();
  const g = $('#albumGrid');
  g.innerHTML = '';
  $('#albumsEmpty').hidden = albums.albums.length > 0;
  for (const al of albums.albums) {
    const items = clips.filter((c) => al.clips.includes(baseName(c.path)));
    const el = document.createElement('div');
    el.className = 'album';
    el.innerHTML = `<div class="cover"><svg><use href="#i-albums"/></svg></div>
      <div class="ameta"><b></b><span>${items.length} clip${items.length === 1 ? '' : 's'} · ${fmtSize(items.reduce((n, c) => n + c.size, 0))}</span></div>
      <button class="amore" title="Album options">···</button>
      <div class="menu" hidden><button data-a="rename">Rename</button><button data-a="delete">Delete album</button></div>`;
    $('b', el).textContent = al.name;
    if (items[0]) api.thumb(items[0].path).then((u) => { if (u) { const cv = $('.cover', el); cv.style.backgroundImage = `url("${u}")`; cv.innerHTML = ''; } });
    el.addEventListener('click', () => openClips({ album: al.id }));
    $('.amore', el).addEventListener('click', (e) => { e.stopPropagation(); const m = $('.menu', el); m.hidden = !m.hidden; });
    $('[data-a=rename]', el).addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = await prompt2('Rename album', 'Save', al.name);
      if (name) { al.name = name; albums = await api.setAlbums(albums); renderAlbums(); }
    });
    $('[data-a=delete]', el).addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete the album "${al.name}"? The clips stay in your library.`)) return;
      albums.albums = albums.albums.filter((a) => a !== al);
      albums = await api.setAlbums(albums);
      renderAlbums();
    });
    g.appendChild(el);
  }
}
async function newAlbum() {
  const name = await prompt2('Create album', 'Create');
  if (!name) return;
  createAlbum(name);
  albums = await api.setAlbums(albums);
  renderAlbums();
}
$('#newAlbum').addEventListener('click', newAlbum);
$('#newAlbum2').addEventListener('click', newAlbum);

// Small in-app prompt (window.prompt isn't available in Electron).
function prompt2(title, okText, value = '') {
  return new Promise((resolve) => {
    $('#mTitle').textContent = title;
    $('#mOk').textContent = okText;
    const inp = $('#mInput');
    inp.value = value;
    $('#modal').hidden = false;
    inp.focus(); inp.select();
    const done = (v) => {
      $('#modal').hidden = true;
      $('#mOk').onclick = $('#mCancel').onclick = inp.onkeydown = null;
      resolve(v && v.trim() ? v.trim().slice(0, 60) : null);
    };
    $('#mOk').onclick = () => done(inp.value);
    $('#mCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
  });
}

// ---------- player + trim ----------
const video = $('#video');
let playing = null, trimStart = 0, trimEnd = 0, previewing = false;

let tracks = 0, marks = [];
async function openClip(c) {
  playing = c;
  $('#pname').textContent = c.name;
  const img = isImage(c);
  $('#imgView').hidden = !img;
  video.hidden = img;
  $('#trimPanel').hidden = img;
  $('#marks').innerHTML = '';
  $('#cropbox')?.remove();
  if (img) { $('#imgView').src = c.url + '?v=' + c.mtime; video.removeAttribute('src'); show('player'); return; }
  video.src = c.url;
  show('player');
  video.onloadedmetadata = () => { trimStart = 0; trimEnd = video.duration; renderTrim(); renderMarks(); video.play(); };
  [tracks, { bookmarks: marks = [] }] = await Promise.all([api.clipTracks(c.path), api.getMeta(c.name)]);
  $('#volGroup').hidden = tracks === 0;
  $('#micVolWrap').hidden = tracks < 3;
  $('#gameVolWrap').firstChild.textContent = tracks >= 3 ? 'Game ' : 'Volume ';
  renderMarks();
  updateExportUi();
}

function renderMarks() {
  const box = $('#marks');
  box.innerHTML = '';
  if (!video.duration) return;
  for (const t of marks) {
    const m = document.createElement('div');
    m.className = 'mark';
    m.style.left = (t / video.duration) * 100 + '%';
    m.title = `Bookmark at ${fmtTime(t)}`;
    m.addEventListener('mousedown', (e) => { e.stopPropagation(); video.currentTime = t; });
    box.appendChild(m);
  }
}

// Export panel
function updateExportUi() {
  const gif = $('#exFormat').value === 'gif';
  $('#exSizeWrap').hidden = gif;
  $('#volGroup').hidden = gif || tracks === 0;
  $('#cropPosWrap').hidden = $('#exCrop').value !== 'vertical';
  $('#gameVolVal').textContent = Math.round($('#gameVol').value * 100) + '%';
  $('#micVolVal').textContent = Math.round($('#micVol').value * 100) + '%';
  drawCropBox();
}
function drawCropBox() {
  $('#cropbox')?.remove();
  if ($('#exCrop').value !== 'vertical' || !video.videoWidth) return;
  // Where the video is actually drawn inside the element (letterboxed).
  const r = video.getBoundingClientRect(), wrap = $('.videowrap').getBoundingClientRect();
  const scale = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
  const vw = video.videoWidth * scale, vh = video.videoHeight * scale;
  const vx = r.left - wrap.left + (r.width - vw) / 2, vy = r.top - wrap.top + (r.height - vh) / 2;
  const cw = vh * 9 / 16, x = vx + (vw - cw) * Number($('#exCropX').value);
  const b = document.createElement('div');
  b.className = 'cropbox'; b.id = 'cropbox';
  Object.assign(b.style, { left: x + 'px', top: vy + 'px', width: cw + 'px', height: vh + 'px' });
  $('.videowrap').appendChild(b);
}
['#exFormat', '#exCrop', '#exCropX', '#gameVol', '#micVol'].forEach((sel) => $(sel).addEventListener('input', updateExportUi));
addEventListener('resize', drawCropBox);
$('#exportBtn').addEventListener('click', async () => {
  const btn = $('#exportBtn'), label = btn.lastChild;
  btn.disabled = true; label.textContent = 'Exporting…';
  try {
    await api.exportClip(playing.path, {
      start: trimStart, end: trimEnd, format: $('#exFormat').value, targetMB: Number($('#exSize').value),
      crop: $('#exCrop').value, cropX: Number($('#exCropX').value), gameVol: Number($('#gameVol').value), micVol: Number($('#micVol').value),
    });
    label.textContent = 'Saved to library ✓';
  } catch (e) { alert('Export failed: ' + e.message); }
  setTimeout(() => { btn.disabled = false; label.textContent = 'Export selection'; }, 1800);
});
$('#shareBtn').addEventListener('click', async () => {
  const btn = $('#shareBtn'), label = btn.lastChild;
  btn.disabled = true; label.textContent = 'Uploading…';
  try {
    const r = await api.shareDiscord(playing.path);
    label.textContent = r && r.url ? 'Link copied ✓' : 'Shared ✓';
  } catch (e) {
    label.textContent = 'Share to Discord';
    alert(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
  setTimeout(() => { btn.disabled = false; label.textContent = 'Share to Discord'; }, 2500);
});
function closePlayer() { video.removeAttribute('src'); video.load(); show(prevView); }

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
  btn.disabled = true; btn.lastChild.textContent = 'Saving…';
  try { await api.trim(playing.path, trimStart, trimEnd); btn.lastChild.textContent = 'Saved ✓'; }
  catch (e) { alert('Trim failed: ' + e.message); }
  setTimeout(() => { btn.disabled = false; btn.lastChild.textContent = 'Save trimmed copy'; }, 1500);
});
$('#backBtn').addEventListener('click', closePlayer);
$('#revealBtn').addEventListener('click', () => api.reveal(playing.path));
$('#deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Move "${playing.name}" to the Recycle Bin?`)) return;
  video.removeAttribute('src'); video.load();
  await api.deleteClip(playing.path);
  show(prevView);
  loadClips();
});
$('#renameBtn').addEventListener('click', () => {
  const t = $('#pname');
  const input = document.createElement('input');
  input.value = playing.name.replace(/\.\w+$/, '');
  t.replaceChildren(input);
  input.focus(); input.select();
  let finished = false;
  const done = async (commit) => {
    if (finished) return;
    finished = true;
    if (commit && input.value.trim() && input.value.trim() !== playing.name.replace(/\.\w+$/, '')) {
      const pos = video.currentTime;
      video.removeAttribute('src'); video.load(); // release the file handle
      try {
        const dest = await api.renameClip(playing.path, input.value);
        await loadClips();
        const c = clips.find((x) => x.path === dest);
        if (c) { playing = c; video.src = c.url; video.currentTime = pos; }
      } catch (e) { alert(e.message); video.src = playing.url; }
    }
    t.textContent = playing.name;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
});
document.addEventListener('keydown', (e) => {
  if (current === 'player' && e.key === 'Escape' && !e.target.matches('input')) closePlayer();
});

// ---------- settings ----------
const form = $('#settingsForm');
let savedSnapshot = '';

$$('.sbtn').forEach((b) => b.addEventListener('click', () => openSection(b.dataset.sec)));
function openSection(sec) {
  $$('.sbtn').forEach((x) => x.classList.toggle('active', x.dataset.sec === sec));
  $$('.sec').forEach((s) => (s.hidden = s.dataset.sec !== sec));
  $('.setpane').scrollTop = 0;
}
$('#setSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  let first = null;
  $$('.sbtn').forEach((b) => {
    const sec = $(`.sec[data-sec="${b.dataset.sec}"]`);
    const hit = q && (b.textContent + ' ' + sec.textContent).toLowerCase().includes(q);
    b.classList.toggle('match', !!hit);
    if (hit && !first) first = b.dataset.sec;
  });
  if (first) openSection(first);
});

function readForm() {
  const next = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') next[el.name] = el.checked;
    else if ('num' in el.dataset) next[el.name] = Number(el.value);
    else if ('json' in el.dataset) next[el.name] = JSON.parse(el.value || '[]');
    else next[el.name] = el.value;
  }
  return next;
}
function fillSettings() {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else if ('json' in el.dataset) el.value = JSON.stringify(settings[el.name] || []);
    else el.value = settings[el.name];
  }
  $('#outDirText').textContent = settings.outputDir;
  renderCustomGames();
  savedSnapshot = JSON.stringify(readForm());
  updateLabels();
  renderMic();
  $('#savebar').hidden = true;
}

const PRESETS = {
  low: { resolution: '720', fps: 30, rateControl: 'quality', quality: 'medium' },
  standard: { resolution: '1080', fps: 60, rateControl: 'quality', quality: 'high' },
  high: { resolution: 'native', fps: 60, rateControl: 'quality', quality: 'high' },
};
// Rough Mbps at 1080p60 for the size estimate (scaled by resolution and FPS).
const QUALITY_MBPS = { low: 6, medium: 10, high: 16, ultra: 28 };
const RES_SCALE = { native: 1.7, 1440: 1.7, 1080: 1, 900: 0.72, 720: 0.5, 480: 0.25 };
const RES_LABEL = { native: 'Native', 1440: '1440p', 1080: '1080p', 900: '900p', 720: '720p', 480: '480p' };

function activePreset(v) {
  return Object.keys(PRESETS).find((k) => Object.entries(PRESETS[k]).every(([f, val]) => String(v[f]) === String(val))) || 'custom';
}
function updateLabels() {
  const v = readForm();
  $('#brVal').textContent = `${v.bitrateMbps} Mbps`;
  $('#sysVal').textContent = `${Math.round(v.systemVolume * 100)}%`;
  $('#micVal').textContent = `${Math.round(v.micVolume * 100)}%`;
  $$('[data-show]').forEach((el) => (el.hidden = el.dataset.show !== v.rateControl));
  const p = activePreset(v);
  $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === p));
  $('#customDesc').textContent = `${RES_LABEL[v.resolution]} · ${v.fps} FPS`;
  let mbps = v.rateControl === 'bitrate' ? v.bitrateMbps : QUALITY_MBPS[v.quality] * (RES_SCALE[v.resolution] || 1) * (v.fps / 60);
  if (v.rateControl !== 'bitrate' && v.codec === 'hevc') mbps *= 0.65;
  const perMin = (mbps * 60) / 8;
  $('#sizeHint').textContent = `About ${Math.round(perMin)} MB per minute · a ${v.bufferSeconds}s clip is around ${Math.round((perMin * v.bufferSeconds) / 60)} MB`
    + (v.rateControl === 'bitrate' ? '' : ' (busy scenes use more)');
  $('#savebar').hidden = JSON.stringify(v) === savedSnapshot;
  $('#saveMsg').textContent = 'You have unsaved changes';
}
form.addEventListener('input', updateLabels);
form.addEventListener('change', updateLabels);
$$('.preset').forEach((b) => b.addEventListener('click', () => {
  const p = PRESETS[b.dataset.preset];
  if (p) for (const [k, val] of Object.entries(p)) form.elements[k].value = val;
  $('#customBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  updateLabels();
}));
$('#revertBtn').addEventListener('click', fillSettings);

// Controller combos (View/Back + a button)
const PAD_COMBOS = [['', 'Off'], ['back+a', 'View + A'], ['back+b', 'View + B'], ['back+x', 'View + X'], ['back+y', 'View + Y'],
  ['back+rb', 'View + RB'], ['back+lb', 'View + LB'], ['back+rs', 'View + Right stick click'], ['back+start', 'View + Menu']];
$$('.padsel').forEach((sel) => { sel.innerHTML = PAD_COMBOS.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); });

// Custom games
function renderCustomGames() {
  const list = JSON.parse(form.elements.customGames.value || '[]');
  const box = $('#customList');
  box.innerHTML = '';
  for (const g of list) {
    const row = document.createElement('div');
    row.className = 'cg';
    row.innerHTML = '<svg class="ic"><use href="#i-game"/></svg><b></b><span></span><button type="button" title="Remove">✕</button>';
    $('b', row).textContent = g.name;
    $('span', row).textContent = g.exe + '.exe';
    $('button', row).addEventListener('click', () => {
      form.elements.customGames.value = JSON.stringify(list.filter((x) => x !== g));
      renderCustomGames(); updateLabels();
    });
    box.appendChild(row);
  }
}
let lastApp = null;
async function refreshLastApp() {
  const r = await api.currentGame();
  lastApp = r.fg;
  $('#lastApp').textContent = lastApp && lastApp.exe ? `${lastApp.title || lastApp.exe} (${lastApp.exe}.exe)` : 'None yet';
}
setInterval(() => { if (current === 'settings' && !$('.sec[data-sec="games"]').hidden) refreshLastApp(); }, 2000);
$('#addGameBtn').addEventListener('click', async () => {
  await refreshLastApp();
  if (!lastApp || !lastApp.exe || /^(replix|electron)$/i.test(lastApp.exe)) return alert('Open your game first, then come back and click this.');
  const name = await prompt2('Game name', 'Add', (lastApp.title || lastApp.exe).replace(/\s+[-–|]\s+.*$/, '').slice(0, 40));
  if (!name) return;
  const list = JSON.parse(form.elements.customGames.value || '[]').filter((g) => g.exe.toLowerCase() !== lastApp.exe.toLowerCase());
  list.push({ name, exe: lastApp.exe });
  form.elements.customGames.value = JSON.stringify(list);
  renderCustomGames(); updateLabels();
});

async function loadMics() {
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch {}
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch {}
  $('#micSel').innerHTML = '';
  for (const d of devs) {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || 'Microphone';
    $('#micSel').appendChild(o);
  }
  if (!devs.length) $('#micSel').innerHTML = '<option value="default">Default microphone</option>';
  $('#micSel').value = settings.micDeviceId || 'default';
  savedSnapshot = JSON.stringify(readForm());
}

// Hotkey capture -> Electron accelerator string.
const KEYMAP = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': 'Plus' };
$$('.hotkey').forEach((inp) => {
  inp.placeholder = 'Off';
  inp.addEventListener('focus', () => { inp.classList.add('listening'); inp.dataset.prev = inp.value; inp.value = ''; inp.placeholder = 'Press keys…'; });
  inp.addEventListener('blur', () => {
    inp.classList.remove('listening'); inp.placeholder = 'Off';
    if (inp.dataset.pending !== '1') inp.value = inp.dataset.prev;
    inp.dataset.pending = '';
    updateLabels();
  });
  inp.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') { inp.value = ''; inp.dataset.pending = '1'; inp.blur(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    let key = KEYMAP[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    if (e.code.startsWith('Numpad')) key = 'num' + e.code.slice(6).toLowerCase().replace('decimal', 'dec');
    inp.value = [...mods, key].join('+');
    inp.dataset.pending = '1';
    inp.blur();
  });
});

$('#pickDir').addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (p) { form.elements.outputDir.value = p; $('#outDirText').textContent = p; updateLabels(); }
});
$('#openDir').addEventListener('click', () => api.openFolder());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = readForm();
  const keys = ['clipHotkey', 'shortClipHotkey', 'recordHotkey', 'bufferHotkey', 'micMuteHotkey', 'screenshotHotkey', 'bookmarkHotkey'].map((k) => next[k]).filter(Boolean);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) { $('#saveMsg').textContent = `⚠ ${dup} is used for two actions`; return; }
  const r = await api.saveSettings(next);
  settings = r.settings;
  fillSettings();
  renderStatus();
  loadClips();
  if (r.failedHotkeys.length) {
    $('#savebar').hidden = false;
    $('#saveMsg').textContent = `⚠ ${r.failedHotkeys.join(', ')} is taken by another app. Pick a different key.`;
  }
});

// ---------- updates ----------
function renderUpdate() {
  const btn = $('#updateBtn');
  $('#updateBar').hidden = update.state !== 'downloading';
  $('#updateFill').style.width = (update.percent || 0) + '%';
  btn.disabled = ['checking', 'downloading'].includes(update.state);
  btn.className = 'btn small ' + (['available', 'ready'].includes(update.state) ? 'primary' : 'ghost');
  const hasNew = ['available', 'ready'].includes(update.state);
  $('#updateDot').hidden = $('#updateDot2').hidden = !hasNew;
  $('#updateTitle').textContent = `Replix ${appVersion}`;
  const [text, label] = {
    idle: ['', 'Check for updates'],
    checking: ['Checking for updates…', 'Checking…'],
    latest: ["You're on the latest version ✓", 'Check for updates'],
    available: [`Version ${update.version} is available`, 'Download update'],
    downloading: [`Downloading ${update.version || ''}… ${update.percent || 0}%`, 'Downloading…'],
    ready: [`Version ${update.version} is ready to install`, 'Restart & update'],
    error: [update.message || 'Update check failed', 'Try again'],
  }[update.state] || ['', 'Check for updates'];
  $('#updateText').textContent = text;
  btn.textContent = label;
  $('#verText').textContent = `Replix ${appVersion}`;
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
  $('#monitorSel').innerHTML = st.displays.map((d) => `<option value="${d.index}">${d.label}</option>`).join('');
  fillSettings();
  renderStatus();
  update = await api.updateState();
  renderUpdate();
  await loadClips();
  loadMics();
})();
