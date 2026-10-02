// Mottenbande Jahrbuch – app shell, routing and reading views.
import { kv } from './db.js';
import { icon } from './icons.js';
import { setBundled, setWebMode, imgTag, hydrate, staticSrc } from './images.js';
import { getConfig, setConfig, fetchMeta, pullRemote, parseInvite, readPackage } from './sync.js';
import { notify, pickFiles, APP_VERSION, isTauri } from './platform.js';

// Web version (iPhone/iPad/Mac in the browser): nothing is shipped, members unlock with the invite code.
export const WEB = !isTauri() && (location.hostname.endsWith('github.io') || new URLSearchParams(location.search).has('web'));
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const PLACEHOLDER = { schema: 1, version: 0, updatedAt: '', club: { name: 'Motten Bande', motto: 'Mehr als ein Bierbaum', subtitle: 'Offizielles Vereinsbuch', notice: 'Nur für Mitglieder', since: 2017, tagline: 'Motten forever – forever Motten', event: {} }, chapters: [], years: [], news: [] };
import { sha256Hex } from './crypto.js';

/* ================= State ================= */
export const S = {
  content: null,
  settings: { theme: 'auto', fs: 'm', notify: true, readNews: [], adminOn: false, historyOrder: 'asc', memberSort: 'order', songScale: 1 },
  admin: { pinHash: '', token: '' },
  dirty: false,
  baseVersion: 1,
  sync: null,
  syncInfo: { lastCheck: 0, error: '', checking: false, progress: '' },
  remoteNewer: 0,
  updateNote: null,
  route: { name: 'home', parts: [] },
  editing: null,
  search: '',
};
export const A = {}; // click actions: data-act="name"
const scrollMem = new Map();
const navStack = [];

/* ================= Helpers ================= */
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtInline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
export function paras(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${fmtInline(p).replace(/\n/g, '<br>')}</p>`).join('');
}
export function parseDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
export function fmtDate(iso, long = false) {
  const d = parseDate(iso);
  if (!d) return '';
  return long ? d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
    : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
export function birthdayInfo(iso) {
  const b = parseDate(iso);
  if (!b) return null;
  const t = startOfToday();
  let next = new Date(t.getFullYear(), b.getMonth(), b.getDate());
  if (next < t) next = new Date(t.getFullYear() + 1, b.getMonth(), b.getDate());
  const days = Math.round((next - t) / 86400000);
  const ageNext = next.getFullYear() - b.getFullYear();
  return { days, ageNext, age: days === 0 ? ageNext : ageNext - 1 };
}
export function weatherIcon(w) {
  const s = (w || '').toLowerCase();
  if (/regen|verregnet|nass|gewitter/.test(s)) return 'rain';
  if (/bedeckt|bewölkt|wolk|grau/.test(s)) return 'cloud';
  if (/trocken|heiter|wechsel/.test(s)) return 'sunCloud';
  if (/sonn/.test(s)) return 'sun';
  return 'sunCloud';
}
export const initials = (name) => (name || '?').split(/[\s-]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const visibleChapters = () => S.content.chapters.filter((c) => !c.hidden);
export const chapterNum = (c) => visibleChapters().indexOf(c) + 1;
export const chapterByType = (t) => visibleChapters().find((c) => c.type === t) || S.content.chapters.find((c) => c.type === t);
export const sortedYears = (dir = 'asc') => [...S.content.years].sort((a, b) => (dir === 'asc' ? a.year - b.year : b.year - a.year));
export const unreadNews = () => (S.content.news || []).filter((n) => !S.settings.readNews.includes(n.id)).length;
export function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

/* ================= Persistence ================= */
export async function saveSettings() { await kv.set('settings', S.settings); applyTheme(); }
export async function saveContent({ markDirty = true } = {}) {
  S.content.updatedAt = new Date().toISOString();
  await kv.set('content', S.content);
  if (markDirty) { S.dirty = true; await kv.set('dirty', true); }
}
export async function setDirty(v) { S.dirty = v; await kv.set('dirty', v); }
export async function setBaseVersion(v) { S.baseVersion = v; await kv.set('baseVersion', v); }
export async function saveAdmin() { await kv.set('admin', S.admin); }
function applyTheme() {
  const r = document.documentElement;
  if (S.settings.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.settings.theme);
  r.setAttribute('data-fs', S.settings.fs);
}
export const isAdmin = () => !!S.settings.adminOn;

/* ================= UI primitives ================= */
export function toast(msg, type = 'ok', ms = 3200) {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'err' ? ' err' : '');
  t.innerHTML = icon(type === 'err' ? 'info' : type === 'info' ? 'bell' : 'check') + `<span>${esc(msg)}</span>`;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms);
}

export function modal(html, { onClose, cls = '' } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${cls}" role="dialog"><button class="icon-btn x" data-close>${icon('x')}</button>${html}</div>`;
  const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(v); };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) close(null); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
  ov.close = close;
  const f = ov.querySelector('[autofocus]');
  if (f) setTimeout(() => f.focus(), 50);
  hydrate(ov);
  return ov;
}

export function confirmDlg(title, text, { ok = 'OK', danger = false, cancel = 'Abbrechen' } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><p class="lead">${esc(text)}</p>
      <div class="foot"><button class="btn" data-close>${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
    { onClose: (v) => resolve(v === true) });
    m.querySelector('[data-ok]').onclick = () => m.close(true);
  });
}

export function promptDlg(title, { label = '', value = '', type = 'text', lead = '', ok = 'OK', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2>${lead ? `<p class="lead">${esc(lead)}</p>` : ''}
      <label class="field"><span>${esc(label)}</span>${type === 'textarea'
        ? `<textarea class="input" autofocus placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
        : `<input class="input" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus>`}</label>
      <div class="foot"><button class="btn" data-close>Abbrechen</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`,
    { onClose: (v) => resolve(v === undefined ? null : v) });
    const inp = m.querySelector('.input');
    const done = () => m.close(inp.value);
    m.querySelector('[data-ok]').onclick = done;
    if (type !== 'textarea') inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
  });
}

/* ================= Lightbox ================= */
export function openLightbox(list, index = 0) {
  if (!list.length) return;
  let i = index;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  const canRotate = isAdmin() && list.some((it) => it.year);
  let changed = false;
  lb.innerHTML = `<div class="lb-top"><div class="info"></div>${canRotate ? `<button class="icon-btn" data-rot="-1" title="Nach links drehen">${icon('rotL')}</button><button class="icon-btn" data-rot="1" title="Nach rechts drehen">${icon('rotR')}</button>` : ''}<button class="icon-btn" data-x>${icon('x')}</button></div>
    <div class="lb-stage"><img alt=""><button class="lb-nav prev">${icon('left')}</button><button class="lb-nav next">${icon('right')}</button></div>
    <div class="lb-cap"></div>`;
  const img = lb.querySelector('img');
  const show = async () => {
    const it = list[i];
    lb.querySelector('.info').innerHTML = `${it.year ? `<b>${it.year}</b>` : ''}${i + 1} / ${list.length}`;
    lb.querySelector('.lb-cap').textContent = it.caption || '';
    img.style.opacity = '0.3';
    const { imageUrl } = await import('./images.js');
    img.src = await imageUrl(it.id);
    img.onload = () => { img.style.opacity = '1'; };
    [list[i + 1], list[i - 1]].forEach(async (n) => { if (n) { const p = new Image(); p.src = await imageUrl(n.id); } });
  };
  const move = (d) => { i = (i + d + list.length) % list.length; show(); };
  const close = () => { lb.remove(); document.removeEventListener('keydown', key); if (changed) render({ keepScroll: true }); };
  lb.querySelectorAll('[data-rot]').forEach((btn) => { btn.onclick = async () => {
    const it = list[i];
    const y = S.content.years.find((x) => x.year === it.year);
    const ph = y && y.photos.find((p) => p.id === it.id);
    if (!ph) return;
    btn.disabled = true;
    try {
      const { rotateImage } = await import('./images.js');
      const newId = await rotateImage(it.id, +btn.dataset.rot);
      ph.id = newId; it.id = newId; changed = true;
      await saveContent();
      await show();
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  }; });
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') move(1); if (e.key === 'ArrowLeft') move(-1); };
  lb.querySelector('[data-x]').onclick = close;
  lb.querySelector('.prev').onclick = () => move(-1);
  lb.querySelector('.next').onclick = () => move(1);
  let sx = null, sy = null;
  lb.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; sx = e.clientX; sy = e.clientY; });
  lb.addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();
    sx = null;
  });
  lb.querySelector('.lb-stage').addEventListener('click', (e) => { if (e.target.classList.contains('lb-stage')) close(); });
  document.addEventListener('keydown', key);
  document.body.appendChild(lb);
  show();
}
function yearPhotoList(years) {
  const out = [];
  for (const y of years) for (const p of y.photos) out.push({ id: p.id, caption: p.caption, year: y.year });
  return out;
}

/* ================= Shell ================= */
function renderShell() {
  document.getElementById('app').innerHTML = `
    <div class="app">
      <aside class="sidebar"></aside>
      <div class="main">
        <header class="topbar"></header>
        <div class="adminslot"></div>
        <div class="scroller" id="scroller"></div>
        <nav class="tabbar"></nav>
      </div>
    </div>`;
}

function renderSidebar() {
  const r = S.route;
  const cur = r.name === 'chapter' ? r.parts[0] : r.name;
  const un = unreadNews();
  $('.sidebar').innerHTML = `
    <a class="side-brand" href="#/"><img src="content/wappen.png" alt="Wappen"><div class="t">${esc(S.content.club.name)}</div><div class="s">${esc(S.content.club.motto)}</div></a>
    <div class="side-sep"></div>
    <nav class="side-nav">
      <a class="nav-item ${cur === 'home' ? 'active' : ''}" href="#/">${icon('home')}<span>Startseite</span></a>
      <div class="side-label">Inhalt</div>
      ${visibleChapters().map((c, i) => `<a class="nav-item ${cur === c.id ? 'active' : ''}" href="#/k/${c.id}"><span class="num">${i + 1}</span><span>${esc(c.title)}</span></a>`).join('')}
      <div class="side-label">Mehr</div>
      <a class="nav-item ${cur === 'news' ? 'active' : ''}" href="#/neues">${icon('newspaper')}<span>Neuigkeiten</span>${un ? `<span class="badge">${un}</span>` : ''}</a>
      <a class="nav-item ${cur === 'search' ? 'active' : ''}" href="#/suche">${icon('search')}<span>Suche</span></a>
      <a class="nav-item ${cur === 'settings' ? 'active' : ''}" href="#/mehr">${icon('settings')}<span>Einstellungen</span></a>
      ${isAdmin() ? `<a class="nav-item ${cur === 'admin' ? 'active' : ''}" href="#/admin">${icon('crown')}<span>Verwaltung</span>${S.dirty ? '<span class="badge" style="background:#e0a33a">!</span>' : ''}</a>`
        : WEB ? '' : `<button class="nav-item" data-act="adminLogin">${icon('lock')}<span>Admin-Modus</span></button>`}
    </nav>
    <div class="side-foot">${esc(S.content.club.tagline)}</div>`;
}

const TOP_LEVEL = ['home', 'toc', 'news', 'settings'];
function renderTopbar(title) {
  const r = S.route;
  const gal = chapterByType('gallery');
  const isTop = TOP_LEVEL.includes(r.name) || (r.name === 'chapter' && gal && r.parts[0] === gal.id && !r.parts[1]);
  $('.topbar').innerHTML = `
    ${isTop ? '<img class="crest" src="content/wappen.png" alt="">' : `<button class="icon-btn" data-act="back" aria-label="Zurück">${icon('left')}</button>`}
    <div class="title">${esc(title)}</div>
    <a class="icon-btn" href="#/suche" aria-label="Suche">${icon('search')}</a>`;
  const un = unreadNews();
  const cur = r.name === 'chapter' && gal && r.parts[0] === gal.id ? 'gallery' : r.name === 'chapter' ? 'toc' : r.name;
  $('.tabbar').innerHTML = `
    <a class="tab ${cur === 'home' ? 'active' : ''}" href="#/">${icon('home')}<span>Start</span></a>
    <a class="tab ${cur === 'toc' ? 'active' : ''}" href="#/inhalt">${icon('book')}<span>Kapitel</span></a>
    ${gal ? `<a class="tab ${cur === 'gallery' ? 'active' : ''}" href="#/k/${gal.id}">${icon('camera')}<span>Bilder</span></a>` : ''}
    <a class="tab ${cur === 'news' ? 'active' : ''}" href="#/neues">${icon('newspaper')}<span>Neues</span>${un ? '<i class="dot"></i>' : ''}</a>
    <a class="tab ${cur === 'settings' || cur === 'admin' || cur === 'search' ? 'active' : ''}" href="#/mehr">${icon('more')}<span>Mehr</span></a>`;
}

function renderAdminBar() {
  const slot = $('.adminslot');
  if (!isAdmin()) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="admin-bar">${icon('crown')}<span>Admin-Modus</span>
    ${S.dirty ? '<span class="dirty-dot" title="Unveröffentlichte Änderungen"></span><span class="small" style="opacity:.8">Nicht veröffentlicht</span>' : '<span class="small" style="opacity:.6">Alles veröffentlicht</span>'}
    ${S.remoteNewer ? `<span class="chip" style="background:#5a3b12;color:#ffd58a">Server hat v${S.remoteNewer}</span>` : ''}
    <span class="spacer"></span>
    ${S.dirty ? `<button class="btn primary" data-act="publish">${icon('cloudUp')}<span>Veröffentlichen</span></button>` : ''}
    <a class="btn dark" href="#/admin" style="background:#00000040;color:#f1dc9e;border-color:#ffffff22">${icon('settings')}</a></div>`;
}

/* ================= Router ================= */
function parseRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const parts = h.split('/').filter(Boolean);
  const map = { '': 'home', inhalt: 'toc', neues: 'news', suche: 'search', mehr: 'settings', admin: 'admin', k: 'chapter' };
  const name = map[parts[0] || ''] || 'home';
  return { name, parts: parts.slice(1) };
}

export function render({ keepScroll = false } = {}) {
  const sc = $('#scroller');
  const prevHash = sc.dataset.hash;
  if (prevHash !== undefined) scrollMem.set(prevHash, sc.scrollTop);
  const hash = location.hash || '#/';
  const isBack = navStack.length > 1 && navStack[navStack.length - 2] === hash;
  if (isBack) navStack.pop(); else if (navStack[navStack.length - 1] !== hash) navStack.push(hash);
  S.route = parseRoute();
  if (S.editing && S.editing.hash !== hash) S.editing = null;

  let title = S.content.club.name;
  let html = '';
  const r = S.route;
  try {
    if (WEB && !S.sync) html = viewWelcome();
    else if (S.editing) { const res = editorView(); html = res.html; title = res.title; }
    else if (r.name === 'home') html = viewHome();
    else if (r.name === 'toc') { html = viewToc(); title = 'Inhalt'; }
    else if (r.name === 'news') { html = viewNews(); title = 'Neuigkeiten'; }
    else if (r.name === 'search') { html = viewSearch(); title = 'Suche'; }
    else if (r.name === 'settings') { html = viewSettings(); title = 'Mehr'; }
    else if (r.name === 'admin') { const res = window.MB_ADMIN ? window.MB_ADMIN.view() : { html: '', title: '' }; html = res.html; title = res.title; }
    else if (r.name === 'chapter') {
      const c = S.content.chapters.find((x) => x.id === r.parts[0]);
      if (!c) html = `<div class="page"><div class="empty">Kapitel nicht gefunden.</div></div>`;
      else { const res = viewChapter(c, r.parts[1]); html = res.html; title = res.title; }
    }
  } catch (e) {
    console.error(e);
    html = `<div class="page"><div class="card pad"><b>Fehler beim Anzeigen</b><p class="muted">${esc(e.message)}</p></div></div>`;
  }
  sc.innerHTML = html;
  sc.dataset.hash = hash;
  renderSidebar();
  renderTopbar(title);
  renderAdminBar();
  hydrate(sc);
  if (keepScroll) sc.scrollTop = scrollMem.get(hash) || sc.scrollTop;
  else sc.scrollTop = isBack ? scrollMem.get(hash) || 0 : 0;
  if (r.name === 'news' && unreadNews()) {
    S.settings.readNews = (S.content.news || []).map((n) => n.id);
    saveSettings();
    setTimeout(() => { renderSidebar(); renderTopbar(title); }, 1500);
  }
  setupSongAudio();
  if (r.name === 'search') { const inp = $('#searchInput'); if (inp && !matchMedia('(max-width: 900px)').matches) inp.focus(); }
}
function editorView() { return window.MB_ADMIN.editorView(); }

/* ================= Views ================= */
function adminBtn(act, label = 'Bearbeiten', extra = '') {
  return isAdmin() ? `<button class="btn sm" data-act="${act}" ${extra}>${icon('edit')}<span>${label}</span></button>` : '';
}

function chapterHead(c, tools = '') {
  const n = chapterNum(c);
  return `<header class="ch-head"><div class="row">${n ? `<div class="ch-num">${n}</div>` : ''}<div><h1 class="ch-title">${esc(c.title)}</h1>
    ${c.subtitle ? `<div class="ch-sub">${esc(c.subtitle)}</div>` : ''}</div><div class="ch-tools">${tools}</div></div><div class="ch-rule"></div></header>`;
}

function pager(c) {
  const vis = visibleChapters();
  const i = vis.indexOf(c);
  const prev = vis[i - 1], next = vis[i + 1];
  return `<nav class="pager">
    ${prev ? `<a href="#/k/${prev.id}"><span class="lbl">${icon('left')}Vorheriges Kapitel</span><span class="nm">${esc(prev.title)}</span></a>` : '<span></span>'}
    ${next ? `<a class="next" href="#/k/${next.id}"><span class="lbl">Nächstes Kapitel${icon('right')}</span><span class="nm">${esc(next.title)}</span></a>` : ''}
  </nav>`;
}

function viewHome() {
  const c = S.content.club;
  const photos = S.content.years.reduce((n, y) => n + y.photos.length, 0);
  const members = chapterByType('members');
  const memberCount = members ? members.members.length : 0;
  const trees = S.content.years.filter((y) => /bierbaum/i.test(y.text)).length;
  const latest = sortedYears('desc').find((y) => y.photos.length);
  const gal = chapterByType('gallery');

  // countdown
  const ev = c.event || {};
  const evDate = parseDate(ev.date);
  let countdown;
  if (evDate && evDate >= startOfToday()) {
    const days = Math.round((evDate - startOfToday()) / 86400000);
    countdown = `<div class="k">${icon('calendar')}Countdown</div>
      <div class="big">${days === 0 ? 'Heute!' : days}${days ? `<small>${days === 1 ? 'Tag' : 'Tage'}</small>` : ''}</div>
      <div class="d">bis <b>${esc(ev.title || 'zum Waldfest')}</b> · ${fmtDate(ev.date, true)}</div>`;
  } else {
    countdown = `<div class="k">${icon('calendar')}Nächstes Treffen</div><div class="big" style="font-size:30px">${esc(ev.title || 'Waldfest')}</div><div class="d">Termin folgt – der L Präsidäntä gibt Bescheid.</div>`;
  }
  // next birthday
  let bday = '';
  if (members && members.members.length) {
    const list = members.members.map((m) => ({ m, b: birthdayInfo(m.born) })).filter((x) => x.b).sort((a, b) => a.b.days - b.b.days);
    if (list.length) {
      const { m, b } = list[0];
      bday = `<div class="card bday" data-act="member" data-id="${m.id}" style="cursor:pointer">
        <div class="avatar">${m.photo ? imgTag(m.photo, 'alt=""') : esc(initials(m.name))}</div>
        <div><div class="muted small" style="letter-spacing:1.5px;text-transform:uppercase;font-weight:600;display:flex;gap:6px;align-items:center">${icon('cake')}Nächster Geburtstag</div>
        <div style="font-family:var(--serif);font-weight:700;font-size:1.2em;color:var(--gold-text)">${esc(m.nick || m.name)}</div>
        <div class="muted">${b.days === 0 ? `<b style="color:var(--danger)">Heute!</b> – wird ${b.ageNext}` : `wird ${b.ageNext} · ${b.days === 1 ? 'morgen' : `in ${b.days} Tagen`}`}</div></div></div>`;
    }
  }

  const news = (S.content.news || []).slice(0, 2);
  return `
  <section class="hero">
    ${isAdmin() ? `<button class="btn sm" data-act="editClub" style="position:absolute;top:24px;right:24px;z-index:2;background:#0006;color:#f1dc9e;border-color:#ffffff30">${icon('edit')}<span>Bearbeiten</span></button>` : ''}
    <img class="crest" src="content/wappen.png" alt="Wappen">
    <h1>${esc(c.name)}</h1>
    <div class="motto">${esc(c.motto)}</div>
    <div class="orn"><span></span>${icon('star')}<span></span></div>
    <div class="meta">${esc(c.subtitle)} · <b>${esc(c.notice)}</b> · Since ${esc(c.since)}</div>
  </section>
  <div class="home-body">
    <div class="stats">
      <div class="stat"><div class="n">${S.content.years.length}</div><div class="l">Jahre</div></div>
      <div class="stat"><div class="n">${memberCount}</div><div class="l">Mitglieder</div></div>
      <div class="stat"><div class="n">${photos}</div><div class="l">Bilder</div></div>
      <div class="stat"><div class="n">${trees}</div><div class="l">Bierbäume</div></div>
    </div>
    ${S.updateNote ? `<div class="update-banner">${icon('sparkles')}<div style="flex:1"><b>Update erhalten</b> – ${esc(S.updateNote.note || 'Neue Inhalte sind da.')}</div><button class="icon-btn" data-act="dismissUpdate">${icon('x')}</button></div>` : ''}
    ${!S.sync && !isAdmin() ? `<div class="update-banner" style="cursor:pointer" data-act="connect">${icon('bell')}<div style="flex:1"><b>Updates aktivieren</b><br><span class="muted small">Einladungscode vom L Präsidäntä eingeben – dann kommen neue Jahre und Bilder automatisch.</span></div>${icon('right')}</div>` : ''}
    <div class="home-grid">
      <div class="card countdown">${countdown}${icon('beer', 'beer')}</div>
      ${bday}
    </div>
    ${latest && gal ? `<div class="section-title"><h2>Impressionen ${latest.year}</h2><a href="#/k/${gal.id}/${latest.year}">Alle ${latest.photos.length}${icon('right')}</a></div>
      <div class="strip">${latest.photos.slice(0, 12).map((p, i) => `<button data-act="lb" data-year="${latest.year}" data-i="${i}">${imgTag(p.id, 'loading="lazy" alt=""')}</button>`).join('')}</div>` : ''}
    <div class="section-title"><h2>Inhalt</h2></div>
    <div class="toc">${visibleChapters().map((ch, i) => `<a class="card" href="#/k/${ch.id}"><span class="n">${i + 1}</span><span><span class="t">${esc(ch.title)}</span>${ch.type === 'history' || ch.type === 'gallery' ? '<br><span class="s">jährlich erweitert</span>' : ''}</span></a>`).join('')}</div>
    ${news.length ? `<div class="section-title"><h2>Neuigkeiten</h2><a href="#/neues">Alle${icon('right')}</a></div>${news.map(newsCard).join('')}` : ''}
    <div class="home-foot"><img src="content/wappen.png" alt="">${esc(c.tagline)}</div>
  </div>`;
}

function newsCard(n) {
  const unread = !S.settings.readNews.includes(n.id);
  return `<article class="card news-item ${unread ? 'unread' : ''}"><div class="d">${fmtDate(n.date, true)}</div><h3>${esc(n.title)}</h3>${n.text ? `<p>${fmtInline(n.text)}</p>` : ''}
    ${isAdmin() ? `<div class="btn-row" style="margin-top:12px"><button class="btn sm" data-act="editNews" data-id="${n.id}">${icon('edit')}Bearbeiten</button><button class="btn sm danger" data-act="delNews" data-id="${n.id}">${icon('trash')}</button></div>` : ''}</article>`;
}

function viewToc() {
  return `<div class="page"><header class="ch-head"><div class="row"><h1 class="ch-title">Inhalt</h1><div class="ch-tools">${isAdmin() ? `<a class="btn sm" href="#/admin">${icon('settings')}Kapitel verwalten</a>` : ''}</div></div><div class="ch-rule"></div></header>
    <div class="toc" style="grid-template-columns:1fr">${visibleChapters().map((ch, i) => `<a class="card" href="#/k/${ch.id}"><span class="n">${i + 1}</span><span style="flex:1"><span class="t">${esc(ch.title)}</span>${ch.type === 'history' || ch.type === 'gallery' ? '<br><span class="s">jährlich erweitert</span>' : ''}</span>${icon('right')}</a>`).join('')}</div>
    <div class="home-foot"><img src="content/wappen.png" alt="">${esc(S.content.club.tagline)}</div></div>`;
}

function viewNews() {
  const list = S.content.news || [];
  return `<div class="page"><header class="ch-head"><div class="row"><h1 class="ch-title">Neuigkeiten</h1><div class="ch-tools">${isAdmin() ? `<button class="btn sm" data-act="addNews">${icon('plus')}Neuigkeit</button>` : ''}</div></div><div class="ch-rule"></div></header>
    ${list.length ? list.map(newsCard).join('') : '<div class="empty">Noch keine Neuigkeiten.</div>'}</div>`;
}

function viewChapter(c, sub) {
  let body = '';
  let title = c.title;
  if (c.type === 'blocks') body = chapterHead(c, adminBtn('editChapter', 'Bearbeiten', `data-id="${c.id}"`)) + renderBlocks(c);
  else if (c.type === 'members') body = viewMembers(c);
  else if (c.type === 'history') {
    if (sub) { const y = S.content.years.find((x) => String(x.year) === sub); if (y) { title = String(y.year); return { html: viewYear(c, y), title }; } }
    body = viewHistory(c);
  } else if (c.type === 'gallery') body = viewGallery(c, sub);
  else if (c.type === 'song') body = viewSong(c);
  return { html: `<div class="page ${c.type === 'gallery' || c.type === 'members' ? 'wide' : ''}">${body}${pager(c)}</div>`, title };
}

export function renderBlocks(c) {
  const out = (c.blocks || []).map((b) => {
    switch (b.t) {
      case 'p': return paras(b.text);
      case 'h': return `<h3>${fmtInline(b.text)}</h3>`;
      case 'quote': return `<blockquote class="quote">${fmtInline(b.text).replace(/\n/g, '<br>')}</blockquote>`;
      case 'callout': return `<div class="callout">${b.title ? `<div class="ct">${esc(b.title)}</div>` : ''}${paras(b.text)}</div>`;
      case 'facts': return `<div class="facts">${(b.items || []).map((f) => `<div class="fact"><div class="k">${esc(f.k)}</div><div class="v">${fmtInline(f.v)}</div></div>`).join('')}</div>`;
      case 'table': return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${(b.head || []).map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${(b.rows || []).map((r) => `<tr>${r.map((x) => `<td>${fmtInline(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      case 'image': return b.id ? `<figure class="fig ${b.small ? 'small' : ''}">${imgTag(b.id, `alt="${esc(b.caption)}" ${b.small ? '' : 'data-act="lbSingle"'} data-id="${b.id}" data-cap="${esc(b.caption)}" style="${b.small ? '' : 'cursor:zoom-in'}"`)}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>` : '';
      default: return '';
    }
  }).join('');
  return `<div class="prose ${c.bullets ? 'rules' : ''}">${out || '<div class="empty">Noch kein Inhalt.</div>'}</div>`;
}

function memberCard(m) {
  const b = birthdayInfo(m.born);
  const soon = b && b.days <= 14;
  return `<button class="card member" data-act="member" data-id="${m.id}">
    <div class="avatar">${m.photo ? imgTag(m.photo, 'alt=""') : esc(initials(m.name))}</div>
    <div style="min-width:0"><div class="nick">${esc(m.nick)}</div><div class="name">${esc(m.name)}</div>
    <div class="meta">${m.born ? `Geb. ${fmtDate(m.born)}${b ? ` · ${b.age} J.` : ''}` : ''}</div>
    <div class="chips">${m.role ? `<span class="chip">${esc(m.role)}</span>` : ''}${m.badge ? `<span class="chip muted">${esc(m.badge)}</span>` : ''}${soon ? `<span class="chip bday">${icon('cake')}${b.days === 0 ? 'Heute!' : b.days === 1 ? 'Morgen' : `in ${b.days} T.`}</span>` : ''}</div></div>
  </button>`;
}

function viewMembers(c) {
  const sort = S.settings.memberSort;
  let list = [...c.members];
  if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  if (sort === 'bday') list.sort((a, b) => ((birthdayInfo(a.born) || { days: 999 }).days - (birthdayInfo(b.born) || { days: 999 }).days));
  return chapterHead(c, adminBtn('editChapter', 'Bearbeiten', `data-id="${c.id}"`)) + `
    <div class="toolbar"><div class="seg">
      <button class="${sort === 'order' ? 'on' : ''}" data-act="memberSort" data-v="order">Rangfolge</button>
      <button class="${sort === 'name' ? 'on' : ''}" data-act="memberSort" data-v="name">Name</button>
      <button class="${sort === 'bday' ? 'on' : ''}" data-act="memberSort" data-v="bday">Geburtstag</button>
    </div><span class="spacer"></span><span class="muted small">${c.members.length} Mitglieder</span></div>
    <div class="members">${list.map(memberCard).join('')}</div>`;
}

function viewHistory(c) {
  const dir = S.settings.historyOrder;
  const items = sortedYears(dir).map((y) => {
    const first = (y.text || '').split(/\n\s*\n/)[0] || '';
    return `<div class="tl-item"><a class="card tl-card" href="#/k/${c.id}/${y.year}">
      <div class="tl-head"><span class="tl-year">${y.year}</span>${y.weather ? `<span class="chip">${icon(weatherIcon(y.weather))}${esc(y.weather)}</span>` : ''}<span class="spacer"></span>${icon('right')}</div>
      <p class="tl-text">${fmtInline(first)}</p>
      ${y.photos.length ? `<div class="tl-thumbs">${y.photos.slice(0, 5).map((p, i) => `<div class="th">${imgTag(p.id, 'loading="lazy" alt=""')}${i === 4 && y.photos.length > 5 ? `<span class="more">+${y.photos.length - 5}</span>` : ''}</div>`).join('')}</div>` : ''}
    </a></div>`;
  }).join('');
  return chapterHead(c, isAdmin() ? `<button class="btn sm primary" data-act="addYear">${icon('plus')}Neues Jahr</button>` : '') + `
    ${c.intro ? `<p class="ch-sub" style="margin:-10px 0 22px">${esc(c.intro)}</p>` : ''}
    <div class="toolbar"><div class="seg"><button class="${dir === 'asc' ? 'on' : ''}" data-act="histOrder" data-v="asc">Von Anfang an</button><button class="${dir === 'desc' ? 'on' : ''}" data-act="histOrder" data-v="desc">Neueste zuerst</button></div></div>
    <div class="timeline">${items}</div>
    <div class="tl-end">Weiter geht's – die Geschichte ist noch lange nicht zu Ende geschrieben…</div>`;
}

function viewYear(c, y) {
  const years = sortedYears('asc');
  const i = years.indexOf(y);
  const prev = years[i - 1], next = years[i + 1];
  const cover = y.photos[0];
  return `<div class="page">
    <div class="year-hero">${cover ? imgTag(cover.id, 'alt=""') : ''}
      <a class="btn sm back" href="#/k/${c.id}">${icon('left')}Geschichte</a>
      <div class="in"><span class="y">${y.year}</span>${y.weather ? `<span class="chip">${icon(weatherIcon(y.weather))}${esc(y.weather)}</span>` : ''}<span class="spacer"></span>
      ${isAdmin() ? `<button class="btn sm" data-act="editYear" data-year="${y.year}">${icon('edit')}Bearbeiten</button>` : ''}</div>
    </div>
    <div class="prose" style="font-size:1.05em">${paras(y.text) || '<div class="empty">Noch kein Text für dieses Jahr.</div>'}</div>
    ${y.photos.length ? `<div class="g-year"><h2 style="font-size:26px">Impressionen</h2><span class="muted">${y.photos.length} Bilder</span></div>
      <div class="grid">${y.photos.map((p, k) => `<button data-act="lb" data-year="${y.year}" data-i="${k}">${imgTag(p.id, 'loading="lazy" alt=""')}${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}</button>`).join('')}</div>` : ''}
    <nav class="pager">
      ${prev ? `<a href="#/k/${c.id}/${prev.year}"><span class="lbl">${icon('left')}Vorjahr</span><span class="nm">${prev.year}</span></a>` : '<span></span>'}
      ${next ? `<a class="next" href="#/k/${c.id}/${next.year}"><span class="lbl">Folgejahr${icon('right')}</span><span class="nm">${next.year}</span></a>` : ''}
    </nav></div>`;
}

function viewGallery(c, sub) {
  const years = sortedYears('desc').filter((y) => y.photos.length || isAdmin());
  const sel = sub && years.find((y) => String(y.year) === sub) ? sub : 'all';
  const show = sel === 'all' ? years : years.filter((y) => String(y.year) === sel);
  const hist = chapterByType('history');
  const total = years.reduce((n, y) => n + y.photos.length, 0);
  return chapterHead(c, isAdmin() ? `<button class="btn sm primary" data-act="addYear">${icon('plus')}Neues Jahr</button>` : '') + `
    ${c.intro ? `<p class="ch-sub" style="margin:-10px 0 18px">${esc(c.intro)} <span class="muted small">· ${total} Bilder</span></p>` : ''}
    <div class="yearchips"><button class="${sel === 'all' ? 'on' : ''}" data-act="galYear" data-v="">Alle</button>${years.map((y) => `<button class="${String(y.year) === sel ? 'on' : ''}" data-act="galYear" data-v="${y.year}">${y.year}</button>`).join('')}</div>
    ${show.map((y) => `<section>
      <div class="g-year"><h2>${y.year}</h2><span class="muted">${y.photos.length} Bilder</span>
        ${isAdmin() ? `<button class="btn sm" data-act="quickPhotos" data-year="${y.year}" style="margin-left:auto">${icon('upload')}Bilder hinzufügen</button><button class="btn sm" data-act="editYear" data-year="${y.year}">${icon('edit')}</button>`
        : hist ? `<a href="#/k/${hist.id}/${y.year}">Zur Geschichte${icon('right')}</a>` : ''}</div>
      ${y.photos.length ? `<div class="grid">${y.photos.map((p, k) => `<button data-act="lb" data-year="${y.year}" data-i="${k}">${imgTag(p.id, 'loading="lazy" alt=""')}${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}</button>`).join('')}</div>` : '<div class="empty">Noch keine Bilder – „Bilder hinzufügen“ antippen.</div>'}
    </section>`).join('')}
    <div class="tl-end" style="text-align:center;margin-top:30px">Platz für weitere Impressionen…</div>`;
}

function viewSong(c) {
  const sc = S.settings.songScale || 1;
  let n = 0;
  return chapterHead(c, adminBtn('editChapter', 'Bearbeiten', `data-id="${c.id}"`)) + `
    ${c.audio && c.audio.id ? `<div class="card song-player" id="songPlayer" data-ch="${c.id}">
      <button class="sp-play" data-act="songPlay" aria-label="Abspielen">${icon('play')}</button>
      <div class="sp-info"><b>${esc(c.title)}</b><span>${esc(c.audio.credit || 'Melodie zum Mitsingen')}</span>
        <div class="sp-bar" data-act="songSeek"><i></i></div></div>
      <span class="sp-time">0:00</span></div>` : ''}
    <div class="song-tools"><button class="btn sm" data-act="songScale" data-v="-1">${icon('type')}A−</button><button class="btn sm" data-act="songScale" data-v="1">${icon('type')}A+</button></div>
    <div class="song" style="font-size:${sc}em">${(c.verses || []).map((v) => `<div><div class="verse ${v.refrain ? 'refrain' : ''}">${v.refrain ? '' : `<span class="verse-num">${++n}.</span>`}${esc(v.lines)}</div></div>`).join('')}</div>
    <div class="home-foot"><img src="content/wappen.png" alt="">${esc(S.content.club.tagline)}</div>`;
}

/* ---------- Song audio ---------- */
let songAudio = null;
let songAudioId = '';
const fmtTime = (t) => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');
function updatePlayer() {
  const p = $('#songPlayer');
  if (!p || !songAudio) return;
  p.querySelector('.sp-play').innerHTML = icon(songAudio.paused ? 'play' : 'pause');
  p.querySelector('.sp-bar i').style.width = songAudio.duration ? `${(songAudio.currentTime / songAudio.duration) * 100}%` : '0';
  p.querySelector('.sp-time').textContent = fmtTime(songAudio.paused && !songAudio.currentTime ? songAudio.duration : songAudio.currentTime);
  p.classList.toggle('playing', !songAudio.paused);
}
async function setupSongAudio() {
  const p = $('#songPlayer');
  const c = p && S.content.chapters.find((x) => x.id === p.dataset.ch);
  if (!c || !c.audio || !c.audio.id) { if (songAudio) songAudio.pause(); return; }
  if (songAudioId !== c.audio.id) {
    if (songAudio) songAudio.pause();
    const { imageUrl } = await import('./images.js');
    const url = await imageUrl(c.audio.id);
    if (!url) return;
    songAudio = new Audio(url);
    songAudioId = c.audio.id;
    ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata'].forEach((ev) => songAudio.addEventListener(ev, updatePlayer));
    songAudio.addEventListener('ended', () => { songAudio.currentTime = 0; updatePlayer(); });
  }
  updatePlayer();
  if (S.settings.songAutoplay !== false && songAudio.paused && !S.editing) songAudio.play().catch(() => updatePlayer());
}

/* ---------- Search ---------- */
function searchIndex() {
  const out = [];
  for (const c of S.content.chapters) {
    if (c.hidden) continue;
    const href = `#/k/${c.id}`;
    out.push({ where: c.title, text: c.title + ' ' + (c.subtitle || '') + ' ' + (c.intro || ''), href });
    for (const b of c.blocks || []) {
      const t = [b.text, b.title, ...(b.items || []).map((f) => `${f.k}: ${f.v}`), ...(b.rows || []).map((r) => r.join(' – ')), b.caption].filter(Boolean).join('\n');
      if (t) out.push({ where: c.title, text: t, href });
    }
    for (const m of c.members || []) out.push({ where: 'Mitglied', text: `${m.nick} – ${m.name} ${m.role || ''} ${m.badge || ''} ${m.note || ''}`, href, member: m.id });
    for (const v of c.verses || []) out.push({ where: c.title, text: v.lines, href });
  }
  const hist = chapterByType('history');
  for (const y of S.content.years) {
    out.push({ where: `Geschichte ${y.year}`, text: `${y.year} ${y.weather || ''}\n${y.text}`, href: hist ? `#/k/${hist.id}/${y.year}` : '#/' });
    for (const p of y.photos) if (p.caption) out.push({ where: `Bild ${y.year}`, text: p.caption, href: hist ? `#/k/${hist.id}/${y.year}` : '#/' });
  }
  for (const n of S.content.news || []) out.push({ where: 'Neuigkeit', text: `${n.title}\n${n.text}`, href: '#/neues' });
  return out;
}
function snippet(text, q) {
  const t = text.replace(/\s+/g, ' ');
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, i - 60);
  const part = (start > 0 ? '…' : '') + t.slice(start, i + q.length + 110) + (i + q.length + 110 < t.length ? '…' : '');
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return esc(part).replace(re, (m) => `<mark>${m}</mark>`);
}
function searchResults() {
  const q = S.search.trim();
  if (q.length < 2) return '<div class="empty">Mindestens zwei Buchstaben eingeben – z. B. „Bierbaum“, „Tino“ oder „2023“.</div>';
  const res = searchIndex().filter((x) => x.text.toLowerCase().includes(q.toLowerCase()));
  if (!res.length) return `<div class="empty">Nichts gefunden zu „${esc(q)}“.</div>`;
  return `<p class="muted small">${res.length} Treffer</p>` + res.slice(0, 80).map((r) => `<a class="card result" href="${r.href}" ${r.member ? `data-act="member" data-id="${r.member}"` : ''}><div class="w">${esc(r.where)}</div><div class="x">${snippet(r.text, q)}</div></a>`).join('');
}
function viewSearch() {
  return `<div class="page"><div class="search-box">${icon('search')}<input id="searchInput" type="search" placeholder="Im Jahrbuch suchen…" value="${esc(S.search)}" autocomplete="off"></div>
    <div id="searchResults">${searchResults()}</div></div>`;
}

/* ---------- Settings ---------- */
function viewSettings() {
  const st = S.settings;
  const lc = S.syncInfo.lastCheck ? new Date(S.syncInfo.lastCheck).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nie';
  return `<div class="page"><header class="ch-head"><div class="row"><h1 class="ch-title">Einstellungen</h1></div><div class="ch-rule"></div></header>
    <div class="settings-group"><h2>Darstellung</h2><div class="card">
      <div class="set-row"><div class="ic">${icon('moon')}</div><div class="tx"><b>Farbschema</b><span>Hell, dunkel oder wie das Gerät</span></div>
        <div class="seg">${[['auto', 'Auto'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, l]) => `<button class="${st.theme === v ? 'on' : ''}" data-act="setTheme" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="set-row"><div class="ic">${icon('type')}</div><div class="tx"><b>Schriftgröße</b><span>Für bessere Lesbarkeit</span></div>
        <div class="seg">${[['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']].map(([v, l]) => `<button class="${st.fs === v ? 'on' : ''}" data-act="setFs" data-v="${v}">${l}</button>`).join('')}</div></div>
    </div></div>

    <div class="settings-group"><h2>Updates</h2><div class="card">
      <div class="set-row"><div class="ic">${icon(S.sync ? 'cloud' : 'cloud')}</div><div class="tx"><b>${S.sync ? 'Mit dem Verein verbunden' : 'Nicht verbunden'}</b>
        <span>${S.sync ? `Inhaltsstand v${S.content.version} · zuletzt geprüft ${lc}${S.syncInfo.error ? ` · <span style="color:var(--danger)">${esc(S.syncInfo.error)}</span>` : ''}` : 'Einladungscode eingeben, um automatisch Updates zu bekommen'}</span></div>
        ${S.sync ? `<button class="btn sm" data-act="checkNow" ${S.syncInfo.checking ? 'disabled' : ''}>${icon('refresh')}${S.syncInfo.checking ? 'Prüfe…' : 'Prüfen'}</button>` : `<button class="btn sm primary" data-act="connect">${icon('link')}Verbinden</button>`}</div>
      ${S.sync ? `<div class="set-row click" data-act="connect"><div class="ic">${icon('link')}</div><div class="tx"><b>Einladungscode ändern</b><span>Neuen Code vom Admin eingeben</span></div>${icon('right')}</div>` : ''}
      <div class="set-row"><div class="ic">${icon('bell')}</div><div class="tx"><b>Benachrichtigungen</b><span>Hinweis, wenn neue Inhalte da sind</span></div>
        <label class="switch"><input type="checkbox" data-act="toggleNotify" ${st.notify ? 'checked' : ''}><i></i></label></div>
      <div class="set-row"><div class="ic">${icon('music')}</div><div class="tx"><b>Lied automatisch abspielen</b><span>Melodie erklingt beim Öffnen der Liedseite</span></div>
        <label class="switch"><input type="checkbox" data-act="toggleAutoplay" ${st.songAutoplay !== false ? 'checked' : ''}><i></i></label></div>
      <div class="set-row click" data-act="importPkg"><div class="ic">${icon('package')}</div><div class="tx"><b>Update-Paket öffnen</b><span>Eine .mbpaket-Datei (z. B. per WhatsApp bekommen) einspielen</span></div>${icon('right')}</div>
    </div></div>

    <div class="settings-group"><h2>Verwaltung</h2><div class="card">
      ${isAdmin()
        ? `<a class="set-row click" href="#/admin" style="text-decoration:none;color:inherit"><div class="ic">${icon('crown')}</div><div class="tx"><b>Verwaltung öffnen</b><span>Inhalte, Kapitel, Veröffentlichen</span></div>${icon('right')}</a>
           <div class="set-row click" data-act="adminOff"><div class="ic">${icon('logout')}</div><div class="tx"><b>Admin-Modus beenden</b><span>Zurück zur Mitglieder-Ansicht</span></div></div>`
        : WEB ? '<div class="set-row"><div class="tx"><span>Bearbeiten geht nur in der Windows- oder Android-App.</span></div></div>' : `<div class="set-row click" data-act="adminLogin"><div class="ic">${icon('lock')}</div><div class="tx"><b>Admin-Modus</b><span>Nur für den Vorstand – mit PIN</span></div>${icon('right')}</div>`}
    </div></div>

    <div class="settings-group"><h2>Über</h2><div class="card pad" style="text-align:center">
      <img src="content/wappen.png" alt="" style="width:64px;margin:0 auto 10px">
      <div style="font-family:var(--serif);font-weight:900;font-size:22px;color:var(--gold-text)">${esc(S.content.club.name)}</div>
      <div class="muted">${esc(S.content.club.subtitle)} · App ${APP_VERSION} · Inhalt v${S.content.version}</div>
      <div style="font-family:var(--serif);font-style:italic;margin-top:10px">${esc(S.content.club.tagline)}</div>
    </div></div></div>`;
}

/* ================= Updates ================= */
export async function checkUpdates({ manual = false } = {}) {
  if (!S.sync) { if (manual) toast('Noch nicht verbunden – bitte Einladungscode eingeben.', 'info'); return; }
  if (S.syncInfo.checking) return;
  S.syncInfo.checking = true;
  if (S.route.name === 'settings') render({ keepScroll: true });
  try {
    const meta = await fetchMeta(S.sync);
    S.syncInfo.lastCheck = Date.now();
    S.syncInfo.error = '';
    if (!meta) { if (manual) toast('Es wurden noch keine Inhalte veröffentlicht.', 'info'); return; }
    if (meta.version <= S.content.version) { S.remoteNewer = 0; if (manual) toast('Alles aktuell – du hast den neuesten Stand.'); return; }
    if (S.dirty) {
      S.remoteNewer = meta.version;
      if (!manual) return;
      const ok = await confirmDlg('Neuere Version laden?', `Auf dem Server liegt Version ${meta.version}. Deine noch nicht veröffentlichten Änderungen auf diesem Gerät gehen dabei verloren.`, { ok: 'Laden', danger: true });
      if (!ok) return;
    }
    if (manual) toast('Update wird geladen…', 'info');
    const res = await pullRemote(S.sync, S.content.version, { force: true });
    if (!res.content) return;
    S.content = res.content;
    await saveContent({ markDirty: false });
    await setDirty(false);
    await setBaseVersion(res.content.version);
    S.remoteNewer = 0;
    S.updateNote = { version: res.content.version, note: res.meta.note };
    toast(`Update erhalten: ${res.meta.note || 'neue Inhalte'}`);
    if (S.settings.notify) notify(`${S.content.club.name} – Update`, res.meta.note || 'Neue Inhalte im Jahrbuch.');
  } catch (e) {
    console.warn(e);
    S.syncInfo.error = navigator.onLine === false ? 'Offline' : e.message;
    if (manual) toast(S.syncInfo.error, 'err', 5000);
  } finally {
    S.syncInfo.checking = false;
    await kv.set('syncInfo', { lastCheck: S.syncInfo.lastCheck });
    render({ keepScroll: true });
  }
}

/** Unlocks the yearbook with an invite code: verifies it, downloads the latest content and stores the connection. */
async function connectWithCode(code, onProgress) {
  const cfg = parseInvite(code);
  const meta = await fetchMeta(cfg);
  if (!meta) throw new Error('Der Verein hat noch keine Inhalte veröffentlicht – bitte später nochmal versuchen.');
  const res = await pullRemote(cfg, 0, { force: true, onProgress }); // also checks the password
  S.sync = { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, password: cfg.password };
  await setConfig(S.sync);
  if (res.content && (WEB || res.content.version >= S.content.version)) {
    S.content = res.content;
    await saveContent({ markDirty: false });
    await setDirty(false);
    await setBaseVersion(res.content.version);
  }
  S.syncInfo.lastCheck = Date.now();
  await kv.set('syncInfo', { lastCheck: S.syncInfo.lastCheck });
}

async function connectDialog(prefill = '') {
  const m = modal(`<h2>Mit dem Verein verbinden</h2>
    <p class="lead">Den Einladungscode bekommst du vom L Präsidäntä (z. B. per WhatsApp). Einfach komplett hier einfügen.</p>
    <label class="field"><span>Einladungscode</span><textarea class="input" id="invite" rows="4" placeholder="MB1.…" autofocus>${esc(prefill)}</textarea></label>
    <div class="small muted" id="connMsg"></div>
    <div class="foot"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="doConnect">${icon('link')}Verbinden</button></div>`);
  m.querySelector('#doConnect').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = 'Prüfe…';
    try {
      await connectWithCode(m.querySelector('#invite').value, (d, n) => { m.querySelector('#connMsg').textContent = `Lade Bilder ${d} von ${n}…`; });
      m.close();
      toast('Verbunden! Updates kommen ab jetzt automatisch.');
      render();
    } catch (err) {
      btn.disabled = false; btn.innerHTML = `${icon('link')}Verbinden`;
      toast(err.message, 'err', 6000);
    }
  };
}

function viewWelcome() {
  return `<section class="hero welcome-hero">
    <img class="crest" src="content/wappen.png" alt="Wappen">
    <h1>${esc(S.content.club.name)}</h1>
    <div class="motto">${esc(S.content.club.motto)}</div>
    <div class="orn"><span></span>${icon('star')}<span></span></div>
    <div class="card pad welcome-card">
      <h2>Willkommen, Motte!</h2>
      <p class="muted">Das Jahrbuch ist nur für Mitglieder. Füge den Einladungscode ein, den du vom L Präsidäntä bekommen hast.</p>
      <textarea class="input" id="welcomeCode" rows="3" placeholder="MB1.…"></textarea>
      <button class="btn primary" data-act="welcomeConnect" style="width:100%;margin-top:12px">${icon('unlock')}Jahrbuch freischalten</button>
      <div id="welcomeProg" style="display:none;margin-top:14px"><div class="small muted" id="welcomeMsg">Prüfe Code…</div><div class="progress"><i id="welcomeBar"></i></div></div>
      ${IOS && !STANDALONE ? `<div class="callout" style="margin:18px 0 0"><div class="ct">Tipp fürs iPhone</div><p>In Safari unten auf <b>Teilen</b> tippen → <b>Zum Home-Bildschirm</b>. Dann hast du das Jahrbuch wie eine App, und die Inhalte bleiben dauerhaft gespeichert.</p></div>` : ''}
    </div>
  </section>`;
}

async function importPackage() {
  const [file] = await pickFiles({ accept: '.mbpaket,application/octet-stream,application/json,*/*' });
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pw = S.sync ? S.sync.password : '';
  let content;
  try {
    content = await readPackage(bytes, pw);
  } catch (e) {
    if (e.needPassword || /Passwort/.test(e.message)) {
      pw = await promptDlg('Vereinspasswort', { label: 'Passwort', type: 'password', lead: 'Dieses Paket ist verschlüsselt.' });
      if (!pw) return;
      try { content = await readPackage(bytes, pw); } catch (e2) { toast(e2.message, 'err', 5000); return; }
    } else { toast(e.message, 'err', 5000); return; }
  }
  if ((content.version || 0) < S.content.version) {
    const ok = await confirmDlg('Älteres Paket', `Das Paket hat Version ${content.version}, du hast bereits Version ${S.content.version}. Trotzdem einspielen?`, { ok: 'Einspielen' });
    if (!ok) return;
  }
  S.content = content;
  await saveContent({ markDirty: false });
  await setBaseVersion(content.version);
  await setDirty(false);
  S.updateNote = { version: content.version, note: 'Update-Paket eingespielt' };
  toast(`Paket eingespielt – Version ${content.version}`);
  render();
}

async function adminLogin() {
  if (!S.admin.pinHash) {
    const m = modal(`<h2>Admin-PIN festlegen</h2><p class="lead">Mit dieser PIN schaltest du auf diesem Gerät den Bearbeitungsmodus frei.</p>
      <label class="field"><span>Neue PIN (mind. 4 Zeichen)</span><input class="input" type="password" id="p1" autofocus inputmode="numeric"></label>
      <label class="field"><span>PIN wiederholen</span><input class="input" type="password" id="p2" inputmode="numeric"></label>
      <div class="foot"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="ok">${icon('unlock')}Festlegen</button></div>`);
    m.querySelector('#ok').onclick = async () => {
      const a = m.querySelector('#p1').value, b = m.querySelector('#p2').value;
      if (a.length < 4) return toast('Die PIN muss mindestens 4 Zeichen haben.', 'err');
      if (a !== b) return toast('Die PINs stimmen nicht überein.', 'err');
      S.admin.pinHash = await sha256Hex('mb:' + a);
      await saveAdmin();
      S.settings.adminOn = true; await saveSettings();
      m.close(); toast('Admin-Modus aktiv'); go('#/admin');
    };
    return;
  }
  const pin = await promptDlg('Admin-Modus', { label: 'PIN', type: 'password', ok: 'Entsperren' });
  if (pin === null) return;
  if ((await sha256Hex('mb:' + pin)) !== S.admin.pinHash) return toast('Falsche PIN.', 'err');
  S.settings.adminOn = true; await saveSettings();
  toast('Admin-Modus aktiv'); render();
}

/* ================= Actions ================= */
Object.assign(A, {
  back: () => { if (navStack.length > 1) history.back(); else go('#/'); },
  lb: (el) => {
    const y = S.content.years.find((x) => String(x.year) === el.dataset.year);
    if (!y) return;
    openLightbox(yearPhotoList([y]), +el.dataset.i);
  },
  lbSingle: (el) => openLightbox([{ id: el.dataset.id, caption: el.dataset.cap }], 0),
  member: (el, e) => {
    e.preventDefault();
    const c = S.content.chapters.find((x) => x.type === 'members');
    const m = c && c.members.find((x) => x.id === el.dataset.id);
    if (!m) return;
    const b = birthdayInfo(m.born);
    modal(`<div class="member-detail">
      <div class="avatar xl">${m.photo ? imgTag(m.photo, 'alt=""') : esc(initials(m.name))}</div>
      <div class="nick">${esc(m.nick)}</div><div class="name">${esc(m.name)}</div>
      <div class="btn-row" style="justify-content:center;margin-top:10px">${m.role ? `<span class="chip">${esc(m.role)}</span>` : ''}${m.badge ? `<span class="chip muted">${esc(m.badge)}</span>` : ''}</div>
      <div class="facts">${m.born ? `<div class="fact"><div class="k">Geboren</div><div class="v">${fmtDate(m.born, true)}</div></div>` : ''}
        ${b ? `<div class="fact"><div class="k">Alter</div><div class="v">${b.age} Jahre</div></div><div class="fact"><div class="k">Nächster Geburtstag</div><div class="v">${b.days === 0 ? 'Heute!' : b.days === 1 ? 'Morgen' : `in ${b.days} Tagen`} (${b.ageNext})</div></div>` : ''}</div>
      ${m.note ? `<div class="prose" style="text-align:left">${paras(m.note)}</div>` : ''}
    </div>`);
  },
  songPlay: () => { if (!songAudio) return; if (songAudio.paused) songAudio.play().catch((e) => toast('Abspielen nicht möglich: ' + e.message, 'err')); else songAudio.pause(); },
  songSeek: (el, e) => { if (!songAudio || !songAudio.duration) return; const r = el.getBoundingClientRect(); songAudio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * songAudio.duration; },
  toggleAutoplay: (el) => { S.settings.songAutoplay = el.checked; saveSettings(); },
  memberSort: (el) => { S.settings.memberSort = el.dataset.v; saveSettings(); render({ keepScroll: true }); },
  histOrder: (el) => { S.settings.historyOrder = el.dataset.v; saveSettings(); render({ keepScroll: true }); },
  galYear: (el) => { const g = chapterByType('gallery'); history.replaceState(null, '', `#/k/${g.id}${el.dataset.v ? '/' + el.dataset.v : ''}`); render({ keepScroll: true }); },
  songScale: (el) => { S.settings.songScale = Math.min(2, Math.max(0.8, (S.settings.songScale || 1) + 0.1 * +el.dataset.v)); saveSettings(); render({ keepScroll: true }); },
  setTheme: (el) => { S.settings.theme = el.dataset.v; saveSettings(); render({ keepScroll: true }); },
  setFs: (el) => { S.settings.fs = el.dataset.v; saveSettings(); render({ keepScroll: true }); },
  toggleNotify: (el) => { S.settings.notify = el.checked; saveSettings(); if (el.checked) notify(S.content.club.name, 'Benachrichtigungen sind aktiv.'); },
  checkNow: () => checkUpdates({ manual: true }),
  connect: () => connectDialog(),
  welcomeConnect: async (el) => {
    const code = $('#welcomeCode').value;
    el.disabled = true;
    $('#welcomeProg').style.display = 'block';
    try {
      await connectWithCode(code, (d, n) => { $('#welcomeMsg').textContent = `Lade Bilder ${d} von ${n}…`; $('#welcomeBar').style.width = `${Math.round((d / n) * 100)}%`; });
      toast('Willkommen im Jahrbuch!');
      go('#/');
    } catch (e) {
      el.disabled = false;
      $('#welcomeProg').style.display = 'none';
      toast(e.message, 'err', 6000);
    }
  },
  importPkg: () => importPackage(),
  adminLogin: () => adminLogin(),
  adminOff: async () => { S.settings.adminOn = false; await saveSettings(); toast('Admin-Modus beendet'); go('#/mehr'); },
  dismissUpdate: () => { S.updateNote = null; render({ keepScroll: true }); },
});

/* ================= Boot ================= */
async function boot() {
  const [bundled, stored, settings, admin, dirty, base, syncCfg, syncInfo] = await Promise.all([
    fetch('content/bundled.json').then((r) => r.json()),
    kv.get('content'), kv.get('settings'), kv.get('admin'), kv.get('dirty'), kv.get('baseVersion'), getConfig(), kv.get('syncInfo'),
  ]);
  setBundled(WEB ? [] : bundled);
  setWebMode(WEB);
  S.content = stored || (WEB ? JSON.parse(JSON.stringify(PLACEHOLDER)) : await fetch('content/seed.json').then((r) => r.json()));
  if (!stored) await kv.set('content', S.content);
  else if (!WEB && !(await kv.get('migrated-audio-1'))) {
    // App 1.1: song recordings shipped with the app are added to existing content once.
    const seed = await fetch('content/seed.json').then((r) => r.json());
    for (const sc of seed.chapters) {
      const c = S.content.chapters.find((x) => x.id === sc.id);
      if (sc.audio && c && !c.audio) c.audio = sc.audio;
    }
    await kv.set('content', S.content);
    await kv.set('migrated-audio-1', true);
  }
  Object.assign(S.settings, settings || {});
  Object.assign(S.admin, admin || {});
  S.dirty = !!dirty;
  S.baseVersion = base || S.content.version;
  S.sync = syncCfg;
  if (syncInfo) S.syncInfo.lastCheck = syncInfo.lastCheck || 0;
  applyTheme();
  await import('./admin.js');
  // Invite link (…#/einladung/MB1.xyz): unlock directly
  const inv = /^#\/einladung\/(.+)$/.exec(location.hash);
  if (inv) history.replaceState(null, '', '#/');
  renderShell();
  render();
  if (inv) {
    const code = decodeURIComponent(inv[1]);
    if (WEB && !S.sync) { const ta = $('#welcomeCode'); if (ta) { ta.value = code; A.welcomeConnect($('[data-act="welcomeConnect"]')); } }
    else connectDialog(code);
  }
  if (WEB && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const fn = A[el.dataset.act];
    if (fn) { if (el.tagName === 'A' && el.dataset.act !== 'member') e.preventDefault(); fn(el, e); }
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('input[data-act]');
    if (el && A[el.dataset.act]) A[el.dataset.act](el, e);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'searchInput') {
      S.search = e.target.value;
      const box = $('#searchResults');
      if (box) box.innerHTML = searchResults();
    }
  });
  window.addEventListener('hashchange', () => render());

  const splash = $('.splash');
  if (splash) { splash.classList.add('hide'); setTimeout(() => splash.remove(), 600); }

  // Automatic update checks: at start, when the app comes back, every 30 min.
  setTimeout(() => checkUpdates(), 1200);
  setInterval(() => checkUpdates(), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - S.syncInfo.lastCheck > 5 * 60 * 1000) checkUpdates();
  });
  window.addEventListener('online', () => checkUpdates());
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').innerHTML = `<div style="padding:40px;font-family:sans-serif"><h2>Die App konnte nicht starten</h2><pre>${esc(e.stack || e.message)}</pre></div>`;
});

export { isTauri, staticSrc };
