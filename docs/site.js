// Shared helpers for the public Replix pages. Reads public data from Supabase's REST API
// with the public anon key (the database's security rules only allow reading here).
const RX = {
  url: 'https://bjgxcrjyftmlyzccbfda.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJqZ3hjcmp5ZnRtbHl6Y2NiZmRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyODgzODUsImV4cCI6MjEwNzg2NDM4NX0.d1jIX4onFd_4yWrJnIaqixtypfQJWUiiMzsfo5shdcc',
  download: 'https://github.com/MejiaFN/Replix/releases/latest',
};
async function rxGet(path) {
  const r = await fetch(`${RX.url}/rest/v1/${path}`, { headers: { apikey: RX.key, Authorization: `Bearer ${RX.key}` } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
const rxFile = (p) => (p ? `${RX.url}/storage/v1/object/public/clips/${p.split('/').map(encodeURIComponent).join('/')}` : '');
const rxEsc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function rxAvatar(p) {
  if (p.avatar_url) return `<span class="avatar"><img src="${rxEsc(p.avatar_url)}" alt=""></span>`;
  const n = p.display_name || p.username || '?';
  return `<span class="avatar">${rxEsc(n[0].toUpperCase())}</span>`;
}
function rxAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const SOC = { twitch: ['Twitch', (h) => `https://twitch.tv/${h}`], youtube: ['YouTube', (h) => `https://youtube.com/@${h}`],
  tiktok: ['TikTok', (h) => `https://tiktok.com/@${h}`], x: ['X', (h) => `https://x.com/${h}`],
  instagram: ['Instagram', (h) => `https://instagram.com/${h}`], discord: ['Discord', null] };
document.querySelectorAll('[data-download]').forEach((a) => (a.href = RX.download));
