// Replix social hub: accounts, game follows, feeds, profiles, likes, comments and posting.
// Talks to Supabase (see supabase/schema.sql); runs after app.js and uses its helpers ($, $$, api, show, fmtAgo…).
const cfg = window.REPLIX_CONFIG || {};
const online = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
const sb = online ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}) : null;

let me = null; // my profile row
let gamesCatalog = [];
const myGames = new Set(), myFollowing = new Set(), myLikes = new Set();
const PAGE = 10;

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const publicUrl = (p) => (p ? sb.storage.from('clips').getPublicUrl(p).data.publicUrl : '');
const gameById = (id) => gamesCatalog.find((g) => g.id === id);
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------- small UI helpers ----------
function avatarHtml(p, cls = '') {
  const name = (p && (p.display_name || p.username)) || '?';
  const hue = [...(p && p.username || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  if (p && p.avatar_url) return `<span class="avatar ${cls}"><img src="${esc(p.avatar_url)}" alt=""></span>`;
  return `<span class="avatar ${cls}" style="background:hsl(${hue} 60% 35%)">${esc(name[0].toUpperCase())}</span>`;
}
function gameIconHtml(g, cls = '') {
  if (!g) return '';
  if (g.image_url) return `<span class="gicon img ${cls}" style="--gc:${esc(g.color)};background-image:url('${esc(g.image_url)}')"></span>`;
  return `<span class="gicon ${cls}" style="--gc:${esc(g.color)}">${esc(g.name.replace(/[^A-Za-z0-9]/g, '')[0] || '?')}</span>`;
}
const shareBase = (cfg.shareBase || '').replace(/\/$/, '');
const clipLink = (id) => `${shareBase}/c/?id=${id}`;
const profileLink = (username) => `${shareBase}/u/?name=${encodeURIComponent(username)}`;
// Social handles -> profile URLs (handles only; never trust a pasted URL).
const SOCIALS = {
  twitch: ['Twitch', (h) => `https://twitch.tv/${h}`], youtube: ['YouTube', (h) => `https://youtube.com/@${h}`],
  tiktok: ['TikTok', (h) => `https://tiktok.com/@${h}`], x: ['X', (h) => `https://x.com/${h}`],
  instagram: ['Instagram', (h) => `https://instagram.com/${h}`], discord: ['Discord', null],
};
const cleanHandle = (h) => String(h || '').trim().replace(/^https?:\/\/\S+\//, '').replace(/^@/, '').replace(/[^\w.\-]/g, '').slice(0, 40);
function openModal(id) { $('#' + id).hidden = false; }
function closeModal(id) { $('#' + id).hidden = true; }
$$('.modal [data-close]').forEach((b) => b.addEventListener('click', () => (b.closest('.modal').hidden = true)));
$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m && m.id !== 'modal') m.hidden = true; }));
function needAccount() {
  if (!online) { alert('Online features are not connected yet.'); return true; }
  if (!me) { openAuth('signin'); return true; }
  return false;
}

// Back navigation for game / profile pages.
const navStack = [];
function go(view) { navStack.push(current === 'player' ? prevView : current); show(view); }
$$('[data-back]').forEach((b) => b.addEventListener('click', () => show(navStack.pop() || 'home')));

// Rail: game/profile pages belong to Home.
const _show = show;
show = function (view) {
  _show(view);
  if (view === 'game' || view === 'profile') $$('.rbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === 'home'));
  $('#acctBtn').classList.toggle('active', view === 'profile' && viewingProfile === (me && me.id));
};

// ---------- session ----------
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  myGames.clear(); myFollowing.clear(); myLikes.clear();
  me = null;
  if (session) {
    const uid = session.user.id;
    const [p, gf, f] = await Promise.all([
      sb.from('profiles').select('*').eq('id', uid).maybeSingle(),
      sb.from('game_follows').select('game_id').eq('user_id', uid),
      sb.from('follows').select('following_id').eq('follower_id', uid),
    ]);
    me = p.data;
    (gf.data || []).forEach((r) => myGames.add(r.game_id));
    (f.data || []).forEach((r) => myFollowing.add(r.following_id));
  }
  renderAccount();
}

function renderAccount() {
  $('#railAvatar').outerHTML = me ? avatarHtml(me, 'sm" id="railAvatar') : '<span class="avatar sm" id="railAvatar"><svg><use href="#i-user"/></svg></span>';
  $('#setupNotice').hidden = online;
  $('#signinNotice').hidden = !online || !!me;
  const card = $('#meCard');
  if (!online) {
    card.innerHTML = `<h4>Replix online</h4><p class="muted">Accounts, feeds and posting turn on once the app is connected to its server.</p>`;
  } else if (!me) {
    card.innerHTML = `<h4>Welcome to Replix</h4><p class="muted">Follow your games, post clips and follow your friends.</p>
      <div class="row2"><button class="btn primary small" data-auth="signup">Create account</button><button class="btn ghost small" data-auth="signin">Sign in</button></div>`;
  } else {
    card.innerHTML = `<div class="mehead" data-me>${avatarHtml(me, 'md')}<div><b>${esc(me.display_name || me.username)}</b><span>@${esc(me.username)}</span></div></div>
      <div class="ministats" id="meStats"><div><b>–</b><span>Clips</span></div><div><b>–</b><span>Followers</span></div><div><b>${myFollowing.size}</b><span>Following</span></div></div>`;
    $('[data-me]', card).addEventListener('click', () => openProfile(me.id));
    sb.from('profile_stats').select('*').eq('id', me.id).maybeSingle().then(({ data }) => {
      if (data) $('#meStats').innerHTML = `<div><b>${data.posts}</b><span>Clips</span></div><div><b>${data.followers}</b><span>Followers</span></div><div><b>${data.following}</b><span>Following</span></div>`;
    });
  }
  $$('[data-auth]').forEach((b) => (b.onclick = () => openAuth(b.dataset.auth)));
  renderGameRow();
  renderTrending();
}

$('#acctBtn').addEventListener('click', () => {
  if (!online) return alert('Online features are not connected yet.');
  if (me) openProfile(me.id); else openAuth('signin');
});

// ---------- auth ----------
let authMode = 'signin';
function openAuth(mode) {
  if (!online) return alert('Online features are not connected yet.');
  authMode = mode;
  $$('#authTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
  $$('#authForm [data-only]').forEach((el) => (el.hidden = el.dataset.only !== mode));
  $('#authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  $('#authForm').password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#authErr').textContent = '';
  $('#authErr').className = 'ferr';
  openModal('authModal');
  setTimeout(() => (mode === 'signup' ? $('#authForm').username : $('#authForm').email).focus(), 50);
}
$$('#authTabs button').forEach((b) => b.addEventListener('click', () => openAuth(b.dataset.tab)));

let userCheckT;
$('#authForm').username.addEventListener('input', (e) => {
  const v = e.target.value.trim();
  clearTimeout(userCheckT);
  const hint = $('#userHint');
  if (!v) { hint.textContent = ''; return; }
  if (!/^[A-Za-z0-9_]{3,20}$/.test(v)) { hint.textContent = '3–20 letters, numbers or _'; hint.className = 'bad'; return; }
  userCheckT = setTimeout(async () => {
    const { data } = await sb.rpc('username_available', { name: v });
    hint.textContent = data ? '✓ Available' : 'Taken, try another';
    hint.className = data ? 'good' : 'bad';
  }, 350);
});

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, err = $('#authErr'), btn = $('#authSubmit');
  err.className = 'ferr'; err.textContent = '';
  const email = f.email.value.trim(), password = f.password.value;
  btn.disabled = true;
  try {
    if (authMode === 'signup') {
      const username = f.username.value.trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('Pick a username: 3–20 letters, numbers or _');
      if (!f.agree.checked) throw new Error('Please confirm you are 13+ and agree to the rules');
      const { data: free } = await sb.rpc('username_available', { name: username });
      if (!free) throw new Error('That username is taken');
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
      if (error) throw error;
      if (!data.session) {
        err.className = 'ferr ok';
        err.textContent = 'Almost done! Check your email for a confirmation link, then sign in here.';
        authMode = 'signin'; openAuth('signin'); err.className = 'ferr ok';
        $('#authErr').textContent = 'Check your email for a confirmation link, then sign in.';
        return;
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    closeModal('authModal');
    f.reset();
  } catch (ex) {
    err.textContent = /invalid login/i.test(ex.message) ? 'Wrong email or password' : /not confirmed/i.test(ex.message) ? 'Confirm your email first (check your inbox)' : ex.message;
  } finally { btn.disabled = false; }
});
$('#forgotBtn').addEventListener('click', async () => {
  const email = $('#authForm').email.value.trim();
  if (!email) { $('#authErr').textContent = 'Type your email above first'; return; }
  const { error } = await sb.auth.resetPasswordForEmail(email);
  $('#authErr').className = error ? 'ferr' : 'ferr ok';
  $('#authErr').textContent = error ? error.message : 'If that email has an account, a reset link is on its way.';
});

// ---------- games ----------
function renderGameRow() {
  const row = $('#gameRow');
  const followed = gamesCatalog.filter((g) => myGames.has(g.id));
  const list = followed.length ? followed : gamesCatalog.slice(0, 7);
  row.innerHTML = `<button class="gcircle add" id="addGamesBtn"><span class="gicon xl plus">+</span><b>${followed.length ? 'Add games' : 'Pick games'}</b></button>`
    + list.map((g) => `<button class="gcircle" data-game="${esc(g.id)}">${gameIconHtml(g, 'xl')}<b>${esc(g.name)}</b></button>`).join('');
  $('#addGamesBtn').onclick = openGamesModal;
  $$('[data-game]', row).forEach((b) => (b.onclick = () => openGame(b.dataset.game)));
}

function renderTrending() {
  const box = $('#trendList');
  const list = [...gamesCatalog].sort((a, b) => (myGames.has(b.id) - myGames.has(a.id))).slice(0, 6);
  box.innerHTML = list.map((g) => `<div class="trow" data-game="${esc(g.id)}">${gameIconHtml(g, 'md')}<b>${esc(g.name)}</b>
    <button class="btn small ${myGames.has(g.id) ? 'ghost' : 'primary'}" data-follow-game="${esc(g.id)}">${myGames.has(g.id) ? 'Following' : 'Follow'}</button></div>`).join('');
  $$('.trow', box).forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('button')) openGame(r.dataset.game); }));
  $$('[data-follow-game]', box).forEach((b) => (b.onclick = () => toggleGameFollow(b.dataset.followGame)));
}
$('#allGamesBtn').addEventListener('click', openGamesModal);

function openGamesModal() {
  if (!online) return alert('Online features are not connected yet.');
  $('#gameSearch').value = '';
  renderGamePick();
  openModal('gamesModal');
  setTimeout(() => $('#gameSearch').focus(), 50);
}
function renderGamePick() {
  const q = $('#gameSearch').value.toLowerCase();
  $('#gamePick').innerHTML = gamesCatalog.filter((g) => g.name.toLowerCase().includes(q)).map((g) => `
    <button class="gpick art ${myGames.has(g.id) ? 'on' : ''}" data-follow-game="${esc(g.id)}">
      ${g.image_url ? `<span class="gart" style="background-image:url('${esc(g.image_url)}')"></span>`
        : `<span class="gart noart" style="--gc:${esc(g.color)}">${esc(g.name.replace(/[^A-Za-z0-9]/g, '')[0] || '?')}</span>`}
      <b>${esc(g.name)}</b><span>${myGames.has(g.id) ? '✓ Following' : 'Follow'}</span></button>`).join('');
  $$('#gamePick [data-follow-game]').forEach((b) => (b.onclick = () => toggleGameFollow(b.dataset.followGame)));
}
$('#gameSearch').addEventListener('input', renderGamePick);

async function toggleGameFollow(id) {
  if (needAccount()) return;
  const on = myGames.has(id);
  if (on) myGames.delete(id); else myGames.add(id);
  renderGameRow(); renderTrending(); if (!$('#gamesModal').hidden) renderGamePick();
  if (viewingGame === id) renderGameFollowBtn();
  const { error } = on
    ? await sb.from('game_follows').delete().eq('user_id', me.id).eq('game_id', id)
    : await sb.from('game_follows').insert({ user_id: me.id, game_id: id });
  if (error) { alert(error.message); if (on) myGames.add(id); else myGames.delete(id); renderGameRow(); renderTrending(); }
  else if (feedMode === 'foryou' && current === 'home') loadFeed(true);
}

let viewingGame = null;
async function openGame(id) {
  const g = gameById(id);
  if (!g) return;
  viewingGame = id;
  $('#gameIcon').outerHTML = gameIconHtml(g, 'big" id="gameIcon');
  $('#gameName').textContent = g.name;
  $('#gameHero').style.setProperty('--gc', g.color);
  $('#gameHero').style.setProperty('--art', g.image_url ? `url('${g.image_url}')` : 'none');
  $('#gameHero').classList.toggle('hasart', !!g.image_url);
  $('#gameMeta').textContent = '';
  renderGameFollowBtn();
  go('game');
  const [{ count: followers }, { count: posts }] = await Promise.all([
    sb.from('game_follows').select('*', { count: 'exact', head: true }).eq('game_id', id),
    sb.from('posts').select('*', { count: 'exact', head: true }).eq('game_id', id),
  ]);
  $('#gameMeta').textContent = `${followers || 0} follower${followers === 1 ? '' : 's'} · ${posts || 0} clip${posts === 1 ? '' : 's'}`;
  const { data } = await sb.from('post_feed').select('*').eq('game_id', id).order('created_at', { ascending: false }).limit(30);
  await loadMyLikes(data || []);
  $('#gameFeed').replaceChildren(...(data || []).map(postCard));
  $('#gameFeedEmpty').hidden = (data || []).length > 0;
}
function renderGameFollowBtn() {
  const on = myGames.has(viewingGame);
  const b = $('#gameFollowBtn');
  b.textContent = on ? 'Following' : 'Follow';
  b.className = 'btn ' + (on ? 'ghost' : 'primary');
  b.onclick = () => toggleGameFollow(viewingGame);
}

// ---------- feed ----------
let feedMode = 'foryou', feedCursor = null, feedLoading = false;
$$('#feedTabs button').forEach((b) => b.addEventListener('click', () => {
  feedMode = b.dataset.feed;
  $$('#feedTabs button').forEach((x) => x.classList.toggle('active', x === b));
  loadFeed(true);
}));
$('#feedMore').addEventListener('click', () => loadFeed(false));

async function loadFeed(reset) {
  if (!online || feedLoading) return;
  feedLoading = true;
  const feed = $('#feed');
  if (reset) { feedCursor = null; feed.innerHTML = '<div class="loading">Loading clips…</div>'; }
  let q = sb.from('post_feed').select('*').order('created_at', { ascending: false }).limit(PAGE);
  if (feedCursor) q = q.lt('created_at', feedCursor);
  let filtered = true;
  if (feedMode === 'following') {
    if (!me || !myFollowing.size) filtered = null;
    else q = q.in('user_id', [...myFollowing]);
  } else if (feedMode === 'foryou' && me && (myGames.size || myFollowing.size)) {
    const parts = [];
    if (myGames.size) parts.push(`game_id.in.(${[...myGames].join(',')})`);
    if (myFollowing.size) parts.push(`user_id.in.(${[...myFollowing].join(',')})`);
    if (me) parts.push(`user_id.eq.${me.id}`);
    q = q.or(parts.join(','));
  } else filtered = false;

  const { data, error } = filtered === null ? { data: [] } : await q;
  feedLoading = false;
  if (reset) feed.innerHTML = '';
  if (error) { feed.innerHTML = `<div class="loading">Couldn't load clips: ${esc(error.message)}</div>`; return; }
  await loadMyLikes(data);
  data.forEach((p) => feed.appendChild(postCard(p)));
  if (data.length) feedCursor = data[data.length - 1].created_at;
  $('#feedMore').hidden = data.length < PAGE;
  const empty = reset && !data.length;
  $('#feedEmpty').hidden = !empty;
  if (empty) {
    $('#feedEmptyTitle').textContent = feedMode === 'following' ? (me ? 'Follow some people' : 'Sign in to follow people') : 'No clips yet';
    $('#feedEmptyText').textContent = feedMode === 'following' ? 'Clips from people you follow show up here.' : 'Be the first: open a clip in your library and press Post.';
  }
}

async function loadMyLikes(posts) {
  if (!me || !posts.length) return;
  const { data } = await sb.from('likes').select('post_id').eq('user_id', me.id).in('post_id', posts.map((p) => p.id));
  (data || []).forEach((r) => myLikes.add(r.post_id));
}

function postCard(p) {
  const g = gameById(p.game_id);
  const el = document.createElement('article');
  el.className = 'post';
  el.innerHTML = `
    <header>
      <button class="who" data-user="${p.user_id}">${avatarHtml(p, 'md')}<div><b>${esc(p.display_name || p.username)}</b><span>@${esc(p.username)} · ${fmtAgo(new Date(p.created_at).getTime())}</span></div></button>
      <div class="spacer"></div>
      ${g ? `<button class="gchip" data-game="${esc(g.id)}">${gameIconHtml(g, 'sm')}${esc(g.name)}</button>` : ''}
      <div class="menuwrap"><button class="tbtn more"><svg class="ic"><use href="#i-more"/></svg></button>
        <div class="menu" hidden>
          <button data-a="share"><svg class="ic"><use href="#i-share"/></svg>Copy share link</button>
          <button data-a="link"><svg class="ic"><use href="#i-link"/></svg>Copy video file link</button>
          ${me && me.id === p.user_id ? '<button data-a="delete"><svg class="ic"><use href="#i-trash"/></svg>Delete post</button>' : '<button data-a="report"><svg class="ic"><use href="#i-flag"/></svg>Report</button>'}
        </div></div>
    </header>
    <div class="ptitle2">${esc(p.title)}</div>
    <div class="media" style="background-image:url('${esc(publicUrl(p.thumb_path))}')">
      <span class="play big"><svg><use href="#i-play"/></svg></span>${p.duration ? `<span class="dur">${fmtTime(p.duration)}</span>` : ''}
    </div>
    <footer>
      <button class="act like ${myLikes.has(p.id) ? 'on' : ''}"><svg class="ic"><use href="#i-heart"/></svg><span>${p.like_count}</span></button>
      <button class="act cm"><svg class="ic"><use href="#i-chat"/></svg><span>${p.comment_count}</span></button>
    </footer>
    <div class="comments" hidden><div class="clist"></div>
      <form class="cform"><input maxlength="500" placeholder="${me ? 'Add a comment…' : 'Sign in to comment'}"><button class="btn primary small">Send</button></form></div>`;

  $('.who', el).onclick = () => openProfile(p.user_id);
  if (g) $('.gchip', el).onclick = () => openGame(g.id);
  // Load the video only when someone presses play.
  $('.media', el).onclick = () => {
    const m = $('.media', el);
    m.innerHTML = `<video src="${esc(publicUrl(p.video_path))}" controls autoplay playsinline></video>`;
    m.style.backgroundImage = '';
    m.onclick = null;
  };
  const menu = $('.menu', el);
  $('.more', el).onclick = (e) => { e.stopPropagation(); $$('.post .menu').forEach((x) => x !== menu && (x.hidden = true)); menu.hidden = !menu.hidden; };
  $$('[data-a]', menu).forEach((b) => b.addEventListener('click', async () => {
    menu.hidden = true;
    if (b.dataset.a === 'link') { await navigator.clipboard.writeText(publicUrl(p.video_path)); flash('Video file link copied'); }
    if (b.dataset.a === 'share') { await navigator.clipboard.writeText(clipLink(p.id)); flash('Share link copied: anyone can watch it in a browser'); }
    if (b.dataset.a === 'report') {
      if (needAccount()) return;
      const reason = await prompt2('Why are you reporting this clip?', 'Report');
      if (reason) { const { error } = await sb.from('reports').insert({ reporter_id: me.id, post_id: p.id, reason }); alert(error ? error.message : 'Thanks, the clip was reported.'); }
    }
    if (b.dataset.a === 'delete') {
      if (!confirm('Delete this post? The clip stays on your PC.')) return;
      await sb.storage.from('clips').remove([p.video_path, p.thumb_path].filter(Boolean));
      const { error } = await sb.from('posts').delete().eq('id', p.id);
      if (error) alert(error.message); else el.remove();
    }
  }));

  const likeBtn = $('.like', el);
  likeBtn.onclick = async () => {
    if (needAccount()) return;
    const on = myLikes.has(p.id), span = $('span', likeBtn);
    if (on) myLikes.delete(p.id); else myLikes.add(p.id);
    likeBtn.classList.toggle('on', !on);
    span.textContent = Number(span.textContent) + (on ? -1 : 1);
    const { error } = on ? await sb.from('likes').delete().eq('user_id', me.id).eq('post_id', p.id)
      : await sb.from('likes').insert({ user_id: me.id, post_id: p.id });
    if (error && !/duplicate/i.test(error.message)) { likeBtn.classList.toggle('on', on); span.textContent = Number(span.textContent) + (on ? 1 : -1); if (on) myLikes.add(p.id); else myLikes.delete(p.id); }
  };

  const box = $('.comments', el);
  $('.cm', el).onclick = async () => {
    box.hidden = !box.hidden;
    if (!box.hidden) loadComments(p, el);
  };
  $('.cform', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (needAccount()) return;
    const inp = $('input', e.target), body = inp.value.trim();
    if (!body) return;
    inp.disabled = true;
    const { error } = await sb.from('comments').insert({ post_id: p.id, user_id: me.id, body });
    inp.disabled = false;
    if (error) return alert(error.message);
    inp.value = '';
    const n = $('.cm span', el); n.textContent = Number(n.textContent) + 1;
    loadComments(p, el);
  });
  return el;
}
document.addEventListener('click', (e) => { if (!e.target.closest('.post .menuwrap')) $$('.post .menu').forEach((m) => (m.hidden = true)); });

async function loadComments(p, el) {
  const list = $('.clist', el);
  list.innerHTML = '<div class="loading small">Loading…</div>';
  const { data, error } = await sb.from('comments').select('*, profiles(username, display_name, avatar_url)').eq('post_id', p.id).order('created_at').limit(100);
  if (error) { list.textContent = error.message; return; }
  list.innerHTML = data.length ? '' : '<div class="muted small">No comments yet.</div>';
  for (const c of data) {
    const row = document.createElement('div');
    row.className = 'comment';
    row.innerHTML = `${avatarHtml(c.profiles, 'sm')}<div><b data-user="${c.user_id}">${esc(c.profiles.display_name || c.profiles.username)}</b> <span class="muted">${fmtAgo(new Date(c.created_at).getTime())}</span><p>${esc(c.body)}</p></div>
      ${me && me.id === c.user_id ? '<button class="cdel" title="Delete">✕</button>' : ''}`;
    $('b', row).onclick = () => openProfile(c.user_id);
    const del = $('.cdel', row);
    if (del) del.onclick = async () => { await sb.from('comments').delete().eq('id', c.id); const n = $('.cm span', el); n.textContent = Math.max(0, Number(n.textContent) - 1); row.remove(); };
    list.appendChild(row);
  }
}

// ---------- profiles ----------
let viewingProfile = null, viewingUsername = '';
$('#profShareBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(profileLink(viewingUsername));
  flash('Profile link copied');
});

// Small confirmation bubble at the bottom of the window.
function flash(text) {
  let el = $('#flash');
  if (!el) { el = document.createElement('div'); el.id = 'flash'; document.body.appendChild(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(flash.t);
  flash.t = setTimeout(() => el.classList.remove('show'), 2400);
}
async function openProfile(id) {
  if (!online) return;
  viewingProfile = id;
  go('profile');
  $('#profGrid').innerHTML = ''; $('#profEmpty').hidden = true;
  const [{ data: p }, { data: st }, { data: posts }] = await Promise.all([
    sb.from('profiles').select('*').eq('id', id).maybeSingle(),
    sb.from('profile_stats').select('*').eq('id', id).maybeSingle(),
    sb.from('post_feed').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(60),
  ]);
  if (!p) return;
  const mine = me && me.id === id;
  $('#profAvatar').outerHTML = avatarHtml(p, 'xl" id="profAvatar');
  $('#profName').textContent = p.display_name || p.username;
  $('#profHandle').textContent = '@' + p.username;
  $('#profBio').textContent = p.bio || '';
  viewingUsername = p.username;
  const hero = $('.profhero');
  hero.style.setProperty('--gc', p.accent_color || '#00e5ff');
  hero.style.setProperty('--art', p.banner_url ? `url('${p.banner_url}')` : 'none');
  hero.classList.toggle('hasart', !!p.banner_url);
  $('#view-profile').style.setProperty('--accent', p.accent_color || '#00e5ff');
  const links = p.links || {};
  $('#profLinks').innerHTML = Object.keys(SOCIALS).filter((k) => links[k]).map((k) =>
    `<button class="plink" data-k="${k}" title="${esc(SOCIALS[k][0])}"><b>${esc(SOCIALS[k][0])}</b>${esc(links[k])}</button>`).join('');
  $$('#profLinks .plink').forEach((b) => (b.onclick = async () => {
    const [, url] = SOCIALS[b.dataset.k], h = links[b.dataset.k];
    if (url) api.openExternal(url(h)); else { await navigator.clipboard.writeText(h); flash('Discord username copied'); }
  }));
  const favs = (p.favorite_games || []).map(gameById).filter(Boolean);
  $('#profFav').hidden = !favs.length;
  $('#profFav').innerHTML = favs.length ? '<span class="pfl">Favorite games</span>' + favs.map((g) =>
    `<button class="favcard" data-game="${esc(g.id)}" style="--gc:${esc(g.color)}${g.image_url ? `;background-image:url('${esc(g.image_url)}')` : ''}"><b>${esc(g.name)}</b></button>`).join('') : '';
  $$('#profFav .favcard').forEach((b) => (b.onclick = () => openGame(b.dataset.game)));
  $('#profPosts').textContent = st ? st.posts : 0;
  $('#profFollowers').textContent = st ? st.followers : 0;
  $('#profFollowing').textContent = st ? st.following : 0;
  $('#profFollowBtn').hidden = mine;
  $('#profEditBtn').hidden = !mine;
  $('#profSignOut').hidden = !mine;
  renderProfileFollowBtn();
  $('#acctBtn').classList.toggle('active', mine);
  $('#profGrid').replaceChildren(...(posts || []).map((x) => {
    const c = document.createElement('div');
    c.className = 'clip';
    c.innerHTML = `<div class="thumb" style="background-image:url('${esc(publicUrl(x.thumb_path))}')"><span class="play"><svg><use href="#i-play"/></svg></span>${x.duration ? `<span class="dur">${fmtTime(x.duration)}</span>` : ''}</div>
      <div class="meta"><div class="name">${esc(x.title)}</div><div class="sub">${x.game_name ? `<span>${esc(x.game_name)}</span><i></i>` : ''}<span>♥ ${x.like_count}</span><i></i><span>${fmtAgo(new Date(x.created_at).getTime())}</span></div></div>`;
    c.onclick = () => showPostModal(x);
    return c;
  }));
  $('#profEmpty').hidden = (posts || []).length > 0;
}
function renderProfileFollowBtn() {
  const on = myFollowing.has(viewingProfile), b = $('#profFollowBtn');
  b.textContent = on ? 'Following' : 'Follow';
  b.className = 'btn ' + (on ? 'ghost' : 'primary');
}
$('#profFollowBtn').addEventListener('click', async () => {
  if (needAccount()) return;
  const id = viewingProfile, on = myFollowing.has(id);
  if (on) myFollowing.delete(id); else myFollowing.add(id);
  renderProfileFollowBtn();
  const n = $('#profFollowers'); n.textContent = Number(n.textContent) + (on ? -1 : 1);
  const { error } = on ? await sb.from('follows').delete().eq('follower_id', me.id).eq('following_id', id)
    : await sb.from('follows').insert({ follower_id: me.id, following_id: id });
  if (error) { alert(error.message); if (on) myFollowing.add(id); else myFollowing.delete(id); renderProfileFollowBtn(); }
  renderAccount();
});
$('#profSignOut').addEventListener('click', async () => { await sb.auth.signOut(); show('home'); });

// A profile grid item opens the full post (with likes/comments) in a modal-like view.
function showPostModal(p) {
  let m = $('#postView');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal'; m.id = 'postView';
    m.innerHTML = '<div class="mbox post-modal"><button class="mclose" data-close>✕</button><div class="pv"></div></div>';
    document.body.appendChild(m);
    $('[data-close]', m).onclick = () => { $('.pv', m).innerHTML = ''; m.hidden = true; };
    m.addEventListener('mousedown', (e) => { if (e.target === m) { $('.pv', m).innerHTML = ''; m.hidden = true; } });
  }
  loadMyLikes([p]).then(() => { $('.pv', m).replaceChildren(postCard(p)); m.hidden = false; $('.pv .media', m).click(); });
}

// Edit profile
$('#profEditBtn').addEventListener('click', () => {
  $('#editAvatar').outerHTML = avatarHtml(me, 'lg" id="editAvatar');
  $('#editName').value = me.display_name || '';
  $('#editBio').value = me.bio || '';
  $('#editErr').textContent = '';
  pendingAvatar = null; pendingBanner = undefined;
  editAccent = me.accent_color || '#00e5ff';
  editFavs = [...(me.favorite_games || [])];
  renderBannerPrev(me.banner_url);
  renderSwatches();
  renderFavPick();
  $$('[data-link]').forEach((i) => (i.value = (me.links || {})[i.dataset.link] || ''));
  openModal('profileModal');
});
let pendingAvatar = null, pendingBanner, editAccent = '#00e5ff', editFavs = [];
const ACCENTS = ['#00e5ff', '#8b5cf6', '#ff3d71', '#22c55e', '#f59e0b', '#3b82f6', '#ef4444', '#ec4899', '#14b8a6', '#eab308'];
function renderBannerPrev(url) {
  const b = $('#editBanner');
  b.style.backgroundImage = url ? `url('${url}')` : '';
  b.style.setProperty('--gc', editAccent);
  $('#bannerClear').hidden = !url;
}
function renderSwatches() {
  const box = $('#swatches');
  box.innerHTML = ACCENTS.map((c) => `<button type="button" class="sw ${c === editAccent ? 'on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('')
    + `<label class="sw custom ${ACCENTS.includes(editAccent) ? '' : 'on'}" style="--c:${editAccent}" title="Custom color"><input type="color" value="${editAccent}">+</label>`;
  $$('.sw[data-c]', box).forEach((b) => (b.onclick = () => { editAccent = b.dataset.c; renderSwatches(); renderBannerPrev(bannerUrlNow()); }));
  $('input', box).oninput = (e) => { editAccent = e.target.value; renderSwatches(); renderBannerPrev(bannerUrlNow()); };
}
function bannerUrlNow() {
  if (pendingBanner === null) return null;
  if (pendingBanner) return URL.createObjectURL(new Blob([pendingBanner], { type: 'image/jpeg' }));
  return me.banner_url;
}
function renderFavPick() {
  $('#favPick').innerHTML = gamesCatalog.filter((g) => g.id !== 'other').map((g) =>
    `<button type="button" class="fp ${editFavs.includes(g.id) ? 'on' : ''}" data-id="${esc(g.id)}">${gameIconHtml(g, 'sm')}${esc(g.name)}</button>`).join('');
  $$('#favPick .fp').forEach((b) => (b.onclick = () => {
    const id = b.dataset.id;
    if (editFavs.includes(id)) editFavs = editFavs.filter((x) => x !== id);
    else if (editFavs.length < 3) editFavs.push(id);
    else { $('#editErr').textContent = 'You can pin up to 3 games'; return; }
    $('#editErr').textContent = '';
    renderFavPick();
  }));
}
$('#bannerBtn').addEventListener('click', async () => {
  try {
    const bytes = await api.pickImage('banner');
    if (!bytes) return;
    pendingBanner = bytes;
    renderBannerPrev(bannerUrlNow());
  } catch (e) { $('#editErr').textContent = cleanErr(e); }
});
$('#bannerClear').addEventListener('click', () => { pendingBanner = null; renderBannerPrev(null); });
$('#avatarBtn').addEventListener('click', async () => {
  try {
    const bytes = await api.pickImage();
    if (!bytes) return;
    pendingAvatar = bytes;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    $('#editAvatar').outerHTML = `<span class="avatar lg" id="editAvatar"><img src="${url}" alt=""></span>`;
  } catch (e) { $('#editErr').textContent = cleanErr(e); }
});
$('#editSave').addEventListener('click', async () => {
  const btn = $('#editSave'); btn.disabled = true;
  try {
    const links = {};
    $$('[data-link]').forEach((i) => { const h = cleanHandle(i.value); if (h) links[i.dataset.link] = h; });
    const patch = { display_name: $('#editName').value.trim() || me.username, bio: $('#editBio').value.trim(),
      accent_color: editAccent, favorite_games: editFavs, links };
    if (pendingBanner === null) patch.banner_url = null;
    else if (pendingBanner) {
      const bpath = `${me.id}/banner-${Date.now()}.jpg`;
      const { error } = await sb.storage.from('clips').upload(bpath, new Blob([pendingBanner], { type: 'image/jpeg' }), { contentType: 'image/jpeg' });
      if (error) throw error;
      patch.banner_url = publicUrl(bpath);
    }
    if (pendingAvatar) {
      const path = `${me.id}/avatar-${Date.now()}.jpg`;
      const { error } = await sb.storage.from('clips').upload(path, new Blob([pendingAvatar], { type: 'image/jpeg' }), { contentType: 'image/jpeg' });
      if (error) throw error;
      patch.avatar_url = publicUrl(path);
    }
    const { error } = await sb.from('profiles').update(patch).eq('id', me.id);
    if (error) throw error;
    Object.assign(me, patch);
    closeModal('profileModal');
    renderAccount();
    openProfile(me.id);
  } catch (e) { $('#editErr').textContent = cleanErr(e); }
  btn.disabled = false;
});

// Suggestions: recent posters you don't follow yet.
async function loadSuggestions() {
  const { data } = await sb.from('post_feed').select('user_id, username, display_name, avatar_url').order('created_at', { ascending: false }).limit(40);
  const seen = new Set(), people = [];
  for (const r of data || []) {
    if (seen.has(r.user_id) || (me && r.user_id === me.id) || myFollowing.has(r.user_id)) continue;
    seen.add(r.user_id); people.push(r);
    if (people.length >= 5) break;
  }
  $('#suggestCard').hidden = !people.length;
  $('#suggestList').innerHTML = people.map((u) => `<div class="trow" data-user="${u.user_id}">${avatarHtml(u, 'md')}<div class="tname"><b>${esc(u.display_name || u.username)}</b><span>@${esc(u.username)}</span></div></div>`).join('');
  $$('#suggestList .trow').forEach((r) => (r.onclick = () => openProfile(r.dataset.user)));
}

// ---------- posting ----------
$('#postBtn').addEventListener('click', () => {
  if (needAccount()) return;
  if (!/\.mp4$/i.test(playing.name)) return alert('Only video clips (MP4) can be posted.');
  $('#postTitle').value = displayName(playing).replace(/^(Clip|Recording) \d{4}-\d\d-\d\d \d\d-\d\d-\d\d$/, '');
  const guess = gamesCatalog.find((g) => playing.game && g.name.toLowerCase() === playing.game.toLowerCase());
  $('#postGame').innerHTML = gamesCatalog.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  $('#postGame').value = guess ? guess.id : 'other';
  $('#postPrev').innerHTML = `<div class="thumb" style="background-image:url('${esc(thumbCache.get(playing.path + playing.mtime) || '')}')"></div><div><b>${esc(playing.name)}</b><span>${fmtSize(playing.size)}${playing.size > 45 * 1048576 ? ' · will be shrunk to fit' : ''}</span></div>`;
  $('#postErr').textContent = '';
  $('#postErr').className = 'ferr';
  openModal('postModal');
  setTimeout(() => $('#postTitle').focus(), 50);
});
$('#postSubmit').addEventListener('click', async () => {
  const title = $('#postTitle').value.trim();
  const err = $('#postErr'), btn = $('#postSubmit'), label = btn.lastChild;
  if (!title) { err.textContent = 'Give your clip a title'; return; }
  btn.disabled = true; err.className = 'ferr ok';
  const id = crypto.randomUUID();
  const vPath = `${me.id}/${id}.mp4`, tPath = `${me.id}/${id}.jpg`;
  try {
    label.textContent = 'Preparing…'; err.textContent = 'Getting your clip ready…';
    const prep = await api.prepareUpload(playing.path);
    label.textContent = 'Uploading…'; err.textContent = `Uploading ${fmtSize(prep.size)}…`;
    const up = await sb.storage.from('clips').upload(vPath, new Blob([prep.video], { type: 'video/mp4' }), { contentType: 'video/mp4' });
    if (up.error) throw up.error;
    if (prep.thumb) await sb.storage.from('clips').upload(tPath, new Blob([prep.thumb], { type: 'image/jpeg' }), { contentType: 'image/jpeg' });
    const { error } = await sb.from('posts').insert({ id, user_id: me.id, game_id: $('#postGame').value, title,
      video_path: vPath, thumb_path: prep.thumb ? tPath : null, duration: prep.duration, size_bytes: prep.size });
    if (error) throw error;
    closeModal('postModal');
    feedMode = 'latest';
    $$('#feedTabs button').forEach((x) => x.classList.toggle('active', x.dataset.feed === 'latest'));
    $('#video').pause();
    show('home');
    loadFeed(true);
  } catch (e) {
    err.className = 'ferr';
    err.textContent = /exceeded|too large|413/i.test(cleanErr(e)) ? 'That clip is too big to upload. Trim it shorter and try again.' : cleanErr(e);
    sb.storage.from('clips').remove([vPath, tPath]).catch(() => {});
  } finally { btn.disabled = false; label.textContent = 'Post'; }
});

// ---------- boot ----------
(async () => {
  if (!online) { renderAccount(); $('#feedTabs').hidden = true; return; }
  const { data } = await sb.from('games').select('*').order('name');
  gamesCatalog = (data || []).sort((a, b) => (a.id === 'other') - (b.id === 'other'));
  await loadMe();
  loadFeed(true);
  loadSuggestions();
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
      setTimeout(async () => { await loadMe(); loadFeed(true); loadSuggestions(); }, 0);
    }
  });
})();
