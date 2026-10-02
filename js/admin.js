// Admin mode: editors, chapter management, publishing and distribution setup.
import {
  S, A, $, esc, render, go, toast, modal, confirmDlg, promptDlg, saveContent, saveSettings, saveAdmin,
  setDirty, setBaseVersion, chapterByType, visibleChapters, todayIso, fmtDate, initials, checkUpdates,
} from './app.js';
import { icon } from './icons.js';
import { imgTag, addImageFile, addAudioFile, rotateImage } from './images.js';
import { setConfig, testConnection, publishRemote, makeInvite, buildPackage, autoSetup, publishWeb, uploadMissingMedia } from './sync.js';
import { saveFile, pickMedia, openUrl, copyText, filesFromPaths, onNativeDrop, isTauri, isAndroid } from './platform.js';
import { sha256Hex, utf8 } from './crypto.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const TYPE_LABEL = { blocks: 'Textkapitel', members: 'Mitglieder', history: 'Geschichte', gallery: 'Bildergalerie', song: 'Liedtext' };
const BLOCK_TYPES = [
  ['p', 'Absatz', 'text'], ['h', 'Zwischenüberschrift', 'heading'], ['quote', 'Zitat / Merksatz', 'quote'],
  ['callout', 'Hinweisbox', 'info'], ['table', 'Tabelle', 'table'], ['facts', 'Faktenliste', 'facts'], ['image', 'Bild', 'image'],
];
const WEATHER = ['durchgehend sonnig', 'vorwiegend sonnig', 'wechselhaft', 'bedeckt', 'leichter Regen', 'vorwiegend verregnet'];

/* ---------- path helpers for data-bind ---------- */
function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[k], obj);
  parent[last] = val;
}
function splitIdx(path) { const k = path.split('.'); const i = +k.pop(); return { arr: getPath(S.editing.draft, k.join('.')), i }; }
function rerender() { S.editing.changed = true; render({ keepScroll: true }); }

/* ---------- start editing ---------- */
function startEdit(kind, draft, title, extra = {}) {
  S.editing = { hash: location.hash || '#/', kind, draft, title, changed: false, ...extra };
  render({ keepScroll: false });
}

function editorView() {
  const e = S.editing;
  let body = '';
  if (e.kind === 'chapter') body = edChapter(e.draft);
  if (e.kind === 'year') body = edYear(e.draft);
  if (e.kind === 'club') body = edClub(e.draft);
  return {
    title: 'Bearbeiten',
    html: `<div class="page editor">
      <div class="ed-bar"><h2>${esc(e.title)}</h2>
        ${e.kind === 'year' ? `<button class="btn sm danger" data-act="edDelYear">${icon('trash')}</button>` : ''}
        <button class="btn sm" data-act="edCancel">Abbrechen</button>
        <button class="btn sm primary" data-act="edSave">${icon('check')}Speichern</button></div>
      ${body}
      <div class="btn-row" style="justify-content:flex-end;margin-top:24px"><button class="btn" data-act="edCancel">Abbrechen</button><button class="btn primary" data-act="edSave">${icon('check')}Speichern</button></div>
    </div>`,
  };
}

const inp = (path, val, ph = '', type = 'text') => `<input class="input" type="${type}" data-bind="${path}" value="${esc(val)}" placeholder="${esc(ph)}">`;
const area = (path, val, rows = 3, ph = '') => `<textarea class="input" data-bind="${path}" rows="${Math.max(rows, Math.min(14, Math.ceil(String(val || '').length / 75) + 1))}" placeholder="${esc(ph)}">${esc(val)}</textarea>`;
const field = (label, html, hint = '') => `<label class="field"><span>${label}</span>${html}${hint ? `<small>${hint}</small>` : ''}</label>`;
const moveBtns = (path) => `<button class="icon-btn" data-act="edMove" data-path="${path}" data-d="-1" title="Nach oben">${icon('up')}</button>
  <button class="icon-btn" data-act="edMove" data-path="${path}" data-d="1" title="Nach unten">${icon('down')}</button>
  <button class="icon-btn" data-act="edDel" data-path="${path}" title="Entfernen">${icon('trash')}</button>`;

/* ---------- chapter editors ---------- */
function edChapter(d) {
  let html = `<div class="card pad">
    <div class="grid2">${field('Kapitel-Titel', inp('title', d.title))}${field('Untertitel (optional)', inp('subtitle', d.subtitle || ''))}</div>
    ${d.type === 'history' || d.type === 'gallery' ? field('Einleitung', area('intro', d.intro || '', 2)) : ''}
    ${d.type === 'blocks' ? `<label class="set-row" style="padding:6px 0;border:0"><div class="tx"><b>Absätze als Regel-Aufzählung</b><span>Goldene Raute vor jedem Absatz (wie bei den Grundsätzen)</span></div><span class="switch"><input type="checkbox" data-bind="bullets" ${d.bullets ? 'checked' : ''}><i></i></span></label>` : ''}
  </div><div style="height:16px"></div>`;
  if (d.type === 'blocks') html += edBlocks(d);
  if (d.type === 'members') html += edMembers(d);
  if (d.type === 'song') html += edSong(d);
  if (d.type === 'history' || d.type === 'gallery') html += `<p class="ed-hint">Die einzelnen Jahre bearbeitest du direkt über das jeweilige Jahr (Stift-Symbol) oder „Neues Jahr“.</p>`;
  return html;
}

function edBlocks(d) {
  const blocks = d.blocks.map((b, i) => {
    const p = `blocks.${i}`;
    const [, label, ic] = BLOCK_TYPES.find((t) => t[0] === b.t) || ['', b.t, 'text'];
    let f = '';
    if (b.t === 'p') f = area(`${p}.text`, b.text, 3) + '<small class="muted">Leerzeile = neuer Absatz · **fett** · *kursiv*</small>';
    if (b.t === 'h') f = inp(`${p}.text`, b.text, 'Überschrift');
    if (b.t === 'quote') f = area(`${p}.text`, b.text, 2);
    if (b.t === 'callout') f = field('Titel', inp(`${p}.title`, b.title || '')) + field('Text', area(`${p}.text`, b.text, 3));
    if (b.t === 'facts') {
      f = `<div class="ed-rows">${(b.items || []).map((it, k) => `<div class="r">${inp(`${p}.items.${k}.k`, it.k, 'Bezeichnung')}${inp(`${p}.items.${k}.v`, it.v, 'Wert')}
        <button class="icon-btn" data-act="edDel" data-path="${p}.items.${k}">${icon('x')}</button></div>`).join('')}</div>
        <button class="btn sm" data-act="edPush" data-path="${p}.items" data-kind="fact">${icon('plus')}Zeile</button>`;
    }
    if (b.t === 'table') {
      f = `<div class="ed-rows"><div class="r">${inp(`${p}.head.0`, b.head[0], 'Spalte 1')}${inp(`${p}.head.1`, b.head[1], 'Spalte 2')}<span style="width:44px"></span></div>
        ${(b.rows || []).map((r, k) => `<div class="r"><textarea class="input" rows="2" data-bind="${p}.rows.${k}.0">${esc(r[0])}</textarea><textarea class="input" rows="2" data-bind="${p}.rows.${k}.1">${esc(r[1])}</textarea>
        <button class="icon-btn" data-act="edDel" data-path="${p}.rows.${k}">${icon('x')}</button></div>`).join('')}</div>
        <button class="btn sm" data-act="edPush" data-path="${p}.rows" data-kind="row">${icon('plus')}Zeile</button>`;
    }
    if (b.t === 'image') {
      f = `<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <div style="width:160px;border-radius:10px;overflow:hidden;background:var(--paper-2);aspect-ratio:4/3;display:grid;place-items:center">${b.id ? imgTag(b.id, 'style="width:100%;height:100%;object-fit:contain"') : `<span class="muted">${icon('image')}</span>`}</div>
        <div style="flex:1;min-width:200px">${field('Bildunterschrift', inp(`${p}.caption`, b.caption || ''))}
        <div class="btn-row"><button class="btn sm" data-act="edPickImage" data-path="${p}.id">${icon('upload')}Bild wählen</button>
        ${b.id && b.id !== 'wappen' ? `<button class="btn sm" data-act="edRotate" data-path="${p}.id" data-d="1">${icon('rotR')}Drehen</button>` : ''}
        <label class="btn sm ghost"><input type="checkbox" data-bind="${p}.small" ${b.small ? 'checked' : ''}> klein darstellen</label></div></div></div>`;
    }
    return `<div class="card ed-block"><div class="eh"><span class="lbl">${icon(ic)}${label}</span>${moveBtns(p)}</div>${f}</div>`;
  }).join('');
  return blocks + `<div class="ed-add"><span class="muted small" style="width:100%;text-align:center">Baustein hinzufügen</span>
    ${BLOCK_TYPES.map(([t, l, ic]) => `<button class="btn sm" data-act="edAddBlock" data-t="${t}">${icon(ic)}${l}</button>`).join('')}</div>`;
}

function edMembers(d) {
  return d.members.map((m, i) => {
    const p = `members.${i}`;
    return `<div class="card ed-block"><div class="eh"><span class="lbl">${icon('users')}${esc(m.nick || m.name || 'Neues Mitglied')}</span>${moveBtns(p)}</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div style="text-align:center"><div class="avatar xl" style="margin:4px auto 10px">${m.photo ? imgTag(m.photo, 'alt=""') : esc(initials(m.name))}</div>
          <div class="btn-row" style="justify-content:center"><button class="btn sm" data-act="edPickImage" data-path="${p}.photo">${icon('camera')}Foto</button>
          ${m.photo ? `<button class="btn sm ghost" data-act="edRotate" data-path="${p}.photo" data-d="1" title="Drehen">${icon('rotR')}</button><button class="btn sm ghost" data-act="edClear" data-path="${p}.photo">${icon('x')}</button>` : ''}</div></div>
        <div style="flex:1;min-width:240px">
          <div class="grid2">${field('Name', inp(`${p}.name`, m.name))}${field('Vereinsname', inp(`${p}.nick`, m.nick, 'mind. ein „ä“'))}
          ${field('Geburtsdatum', inp(`${p}.born`, m.born, '', 'date'))}${field('Amt / Rolle', inp(`${p}.role`, m.role || '', 'z. B. Kassenwart'))}</div>
          ${field('Zusatz', inp(`${p}.badge`, m.badge || '', 'z. B. Prospäkt 2026'))}
          ${field('Notiz (optional)', area(`${p}.note`, m.note || '', 2))}
        </div></div></div>`;
  }).join('') + `<div class="ed-add"><button class="btn primary" data-act="edPush" data-path="members" data-kind="member">${icon('plus')}Mitglied hinzufügen</button></div>`;
}

function edSong(d) {
  let n = 0;
  const a = d.audio && d.audio.id ? d.audio : null;
  const audioCard = `<div class="card pad" style="margin-bottom:16px"><div class="eh" style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><b style="flex:1;display:flex;gap:8px;align-items:center">${icon('music')}Musik zum Lied</b></div>
    ${a ? `<p class="muted small" style="margin:0 0 10px">Hinterlegt: ${esc(a.name || 'Audiodatei')}</p>${field('Hinweis unter dem Player', inp('audio.credit', a.credit || '', 'z. B. Melodie: Andreas Fack, 1912'))}` : '<p class="muted small" style="margin:0 0 10px">Eine MP3 (oder M4A/OGG/WAV) hinterlegen – sie erklingt beim Öffnen der Liedseite.</p>'}
    <div class="btn-row"><button class="btn sm" data-act="edPickAudio">${icon('upload')}${a ? 'Andere Datei wählen' : 'Audiodatei wählen'}</button>
    ${a ? `<button class="btn sm danger" data-act="edClearAudio">${icon('trash')}Entfernen</button>` : ''}</div></div>`;
  return audioCard + d.verses.map((v, i) => {
    const p = `verses.${i}`;
    return `<div class="card ed-block"><div class="eh"><span class="lbl">${icon('music')}${v.refrain ? 'Refrain' : `Strophe ${++n}`}</span>
      <label class="btn sm ghost"><input type="checkbox" data-bind="${p}.refrain" ${v.refrain ? 'checked' : ''}> Refrain</label>${moveBtns(p)}</div>
      ${area(`${p}.lines`, v.lines, 4, 'Eine Zeile pro Liedzeile')}</div>`;
  }).join('') + `<div class="ed-add"><button class="btn sm" data-act="edPush" data-path="verses" data-kind="verse">${icon('plus')}Strophe</button>
    <button class="btn sm" data-act="edPush" data-path="verses" data-kind="refrain">${icon('plus')}Refrain</button></div>`;
}

function edYear(d) {
  return `<div class="card pad">
    <div class="grid2">${field('Jahr', inp('year', d.year, '', 'number'))}${field('Wetter', inp('weather', d.weather || '', 'z. B. durchgehend sonnig'))}</div>
    <div class="btn-row" style="margin:-6px 0 14px">${WEATHER.map((w) => `<button class="chip muted" data-act="edWeather" data-v="${w}" style="cursor:pointer">${w}</button>`).join('')}</div>
    ${field('Was ist passiert?', area('text', d.text, 8, 'Freitag…\n\nSamstag…\n\nWaldfest…'), 'Leerzeile = neuer Absatz · **fett** · *kursiv*')}
  </div>
  <div class="section-title" style="margin-top:28px"><h2>Bilder <span class="muted small">(${d.photos.length})</span></h2></div>
  <div class="dropzone" data-act="edAddPhotos" id="dropzone">${icon('upload')}<b>Bilder hinzufügen</b><br><span class="small muted">Antippen zum Auswählen – am PC auch per Drag &amp; Drop. Mehrere auf einmal möglich, Bilder werden automatisch verkleinert.<br><b>Bilder vom Handy:</b> erst auf den PC kopieren, dann von dort einfügen.</span></div>
  <div class="ph-grid">${d.photos.map((ph, i) => `<div class="ph">
    <div class="im">${imgTag(ph.id, 'loading="lazy" alt=""')}${i === 0 ? `<span class="chip cover" style="background:var(--gold);color:#1f180d">${icon('star')}Titelbild</span>` : ''}</div>
    <input data-bind="photos.${i}.caption" value="${esc(ph.caption)}" placeholder="Bildunterschrift…">
    <div class="acts"><button data-act="edMove" data-path="photos.${i}" data-d="-1" title="Nach vorne">${icon('left')}</button>
      <button data-act="edRotate" data-path="photos.${i}.id" data-d="-1" title="Nach links drehen">${icon('rotL')}</button>
      <button data-act="edCover" data-i="${i}" title="Als Titelbild">${icon('star')}</button>
      <button data-act="edRotate" data-path="photos.${i}.id" data-d="1" title="Nach rechts drehen">${icon('rotR')}</button>
      <button data-act="edMove" data-path="photos.${i}" data-d="1" title="Nach hinten">${icon('right')}</button>
      <button class="del" data-act="edDel" data-path="photos.${i}" title="Löschen">${icon('trash')}</button></div></div>`).join('')}</div>`;
}

function edClub(d) {
  return `<div class="card pad">
    <div class="grid2">${field('Vereinsname', inp('name', d.name))}${field('Motto', inp('motto', d.motto))}
    ${field('Untertitel', inp('subtitle', d.subtitle))}${field('Hinweis', inp('notice', d.notice))}
    ${field('Gegründet', inp('since', d.since, '', 'number'))}${field('Schlusszeile', inp('tagline', d.tagline))}</div></div>
    <div class="section-title"><h2>Nächstes Treffen</h2></div>
    <div class="card pad"><div class="grid2">${field('Bezeichnung', inp('event.title', d.event.title, 'z. B. Waldfest 2027'))}${field('Datum', inp('event.date', d.event.date, '', 'date'), 'Für den Countdown auf der Startseite')}</div></div>`;
}

/* ---------- images in editor ---------- */
const PHONE_HINT = 'Keine Bilder übernommen. Bilder direkt vom Handy (per USB-Kabel) kann Windows nicht weitergeben – bitte den Ordner zuerst auf den PC kopieren (z. B. auf den Desktop) und von dort einfügen.';

function progressToast() {
  let box = document.querySelector('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = icon('upload') + '<span></span>';
  box.appendChild(t);
  return { set: (msg) => { t.querySelector('span').textContent = msg; }, done: () => t.remove() };
}

async function processFiles(files) {
  const ids = [];
  const imgs = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(f.name));
  if (!imgs.length) { if (files.length) toast('Keine Bilddateien erkannt.', 'err'); return ids; }
  const pt = progressToast();
  const failed = [];
  let n = 0;
  for (const f of imgs) {
    pt.set(`Bilder werden verarbeitet: ${n + 1} von ${imgs.length}`);
    try { ids.push(await addImageFile(f)); } catch (e) { console.warn(e); failed.push(f.name); }
    n++;
  }
  pt.done();
  if (failed.length) {
    const heic = failed.some((x) => /\.hei[cf]$/i.test(x));
    toast(`${failed.length} Bild(er) nicht lesbar: ${failed.slice(0, 3).join(', ')}${heic ? ' – iPhone-Fotos (HEIC) bitte als JPG speichern' : ''}`, 'err', 7000);
  }
  return ids;
}

async function addPhotosToDraft(files) {
  const ids = await processFiles(files);
  if (!ids.length) return;
  S.editing.draft.photos.push(...ids.map((id) => ({ id, caption: '' })));
  rerender();
  toast(`${ids.length} Bild${ids.length > 1 ? 'er' : ''} hinzugefügt – Speichern nicht vergessen`);
}

// Drag & drop onto the dropzone
// Drag & drop: in the year editor files can be dropped anywhere; elsewhere drops are ignored
// (otherwise the app window would navigate to the dropped file).
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
const dropTarget = () => (S.editing && S.editing.kind === 'year' ? document.getElementById('dropzone') : null);
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const z = dropTarget();
  e.dataTransfer.dropEffect = z ? 'copy' : 'none';
  if (z) z.classList.add('over');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) { const z = dropTarget(); if (z) z.classList.remove('over'); } });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const z = dropTarget();
  if (!z) { if (S.editing || S.settings.adminOn) toast('Bilder bitte im Jahres-Editor ablegen (Jahr → Bearbeiten).', 'info'); return; }
  z.classList.remove('over');
  addPhotosToDraft([...e.dataTransfer.files]);
});
// Desktop app: Windows delivers dropped files natively (as paths) instead of HTML drop events.
onNativeDrop({
  over: () => { const z = dropTarget(); if (z) z.classList.add('over'); },
  leave: () => { const z = dropTarget(); if (z) z.classList.remove('over'); },
  drop: async (paths) => {
    const z = dropTarget();
    if (z) z.classList.remove('over');
    if (!z) { if (S.settings.adminOn) toast('Bilder bitte im Jahres-Editor ablegen (Jahr → Bearbeiten).', 'info'); return; }
    try { await addPhotosToDraft(await filesFromPaths(paths, 'image')); } catch (e) { toast('Bilder konnten nicht geladen werden: ' + (e.message || e), 'err', 8000); }
  },
});

// Two-way binding of editor fields
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!S.editing || !el.dataset || !el.dataset.bind) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') v = v === '' ? '' : Number(v);
  setPath(S.editing.draft, el.dataset.bind, v);
  S.editing.changed = true;
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (S.editing && el.dataset && el.dataset.bind && el.type === 'checkbox') { setPath(S.editing.draft, el.dataset.bind, el.checked); S.editing.changed = true; }
});

/* ---------- year helpers ---------- */
async function addYear() {
  const next = Math.max(new Date().getFullYear(), ...S.content.years.map((y) => y.year + 1));
  const v = await promptDlg('Neues Jahr anlegen', { label: 'Jahr', type: 'number', value: String(next), ok: 'Anlegen' });
  if (v === null) return;
  const year = parseInt(v, 10);
  if (!year || year < 1900 || year > 2200) return toast('Bitte ein gültiges Jahr eingeben.', 'err');
  const hist = chapterByType('history');
  if (!hist) return toast('Es gibt kein Geschichts-Kapitel.', 'err');
  let y = S.content.years.find((x) => x.year === year);
  if (!y) {
    y = { year, weather: '', text: '', photos: [] };
    S.content.years.push(y);
    await saveContent();
  }
  const hash = `#/k/${hist.id}/${year}`;
  location.hash = hash;
  S.editing = { hash, kind: 'year', draft: clone(y), title: `Jahr ${year}`, changed: false, year };
  render();
}

/* ---------- publish ---------- */
async function publishDialog() {
  if (!S.sync || !S.admin.token) {
    toast('Bitte zuerst die Verbindung einrichten (Verwaltung → Verteilung).', 'err', 4500);
    go('#/admin');
    setTimeout(() => { const el = $('#dist'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 300);
    return;
  }
  const m = modal(`<h2>Änderungen veröffentlichen</h2>
    <p class="lead">Alle Mitglieder bekommen das Update automatisch beim nächsten Öffnen der App.</p>
    <label class="field"><span>Was ist neu?</span><input class="input" id="pubTitle" placeholder="z. B. Bilder vom Waldfest 2026 sind online" autofocus></label>
    <label class="field"><span>Details (optional)</span><textarea class="input" id="pubText" rows="3"></textarea></label>
    <label class="btn-row" style="gap:10px;margin-bottom:6px"><span class="switch"><input type="checkbox" id="pubNews" checked><i></i></span><span>Auch als Neuigkeit in der App anzeigen</span></label>
    <div id="pubProg" style="display:none"><div class="small muted" id="pubMsg">Starte…</div><div class="progress"><i id="pubBar"></i></div></div>
    <div class="foot"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="pubGo">${icon('cloudUp')}Jetzt veröffentlichen</button></div>`);
  const run = async (force = false) => {
    const title = m.querySelector('#pubTitle').value.trim();
    const text = m.querySelector('#pubText').value.trim();
    if (!title) { toast('Bitte kurz beschreiben, was neu ist.', 'err'); return; }
    const btn = m.querySelector('#pubGo');
    btn.disabled = true;
    m.querySelector('#pubProg').style.display = 'block';
    const copy = clone(S.content);
    copy.updatedAt = new Date().toISOString();
    if (m.querySelector('#pubNews').checked) copy.news = [{ id: 'n' + Date.now(), date: todayIso(), title, text }, ...(copy.news || [])];
    try {
      const res = await publishRemote(S.sync, S.admin.token, copy, {
        note: title, baseVersion: S.baseVersion, force,
        onProgress: (msg, p) => { m.querySelector('#pubMsg').textContent = msg; m.querySelector('#pubBar').style.width = `${Math.round(p * 100)}%`; },
      });
      S.content = copy;
      S.settings.readNews = (copy.news || []).map((n) => n.id);
      await saveSettings();
      await saveContent({ markDirty: false });
      await setDirty(false);
      await setBaseVersion(res.version);
      S.remoteNewer = 0;
      m.close();
      toast(`Veröffentlicht – Version ${res.version}${res.uploaded ? ` · ${res.uploaded} Bilder hochgeladen` : ''}`, 'ok', 5000);
      render({ keepScroll: true });
    } catch (e) {
      btn.disabled = false;
      m.querySelector('#pubProg').style.display = 'none';
      if (e.conflict) {
        const ok = await confirmDlg('Neuere Version auf dem Server', `${e.message} Wenn du trotzdem veröffentlichst, wird diese Version überschrieben.`, { ok: 'Trotzdem veröffentlichen', danger: true });
        if (ok) run(true);
      } else toast(e.message, 'err', 6000);
    }
  };
  m.querySelector('#pubGo').onclick = () => run(false);
}

/* ---------- admin dashboard ---------- */
function viewAdmin() {
  if (!S.settings.adminOn) return { title: 'Verwaltung', html: `<div class="page"><div class="empty">Nur im Admin-Modus verfügbar.</div></div>` };
  const cfg = S.sync || { owner: '', repo: 'mottenbande-daten', branch: 'main', password: '' };
  const ready = !!(S.sync && S.admin.token);
  const chapters = S.content.chapters;
  let num = 0;
  return {
    title: 'Verwaltung',
    html: `<div class="page">
    <header class="ch-head"><div class="row"><h1 class="ch-title">Verwaltung</h1></div><div class="ch-rule"></div></header>

    <div class="card status-card">
      <div><div class="muted small" style="letter-spacing:1.5px;text-transform:uppercase;font-weight:700">Inhaltsstand</div><div class="big">v${S.content.version}</div></div>
      <div style="flex:1;min-width:200px">${S.dirty ? '<b style="color:#c07a12">Unveröffentlichte Änderungen</b><br><span class="muted small">Die Mitglieder sehen sie erst nach dem Veröffentlichen.</span>' : '<b>Alles veröffentlicht</b><br><span class="muted small">Mitglieder haben den aktuellen Stand.</span>'}
        ${!ready ? '<br><span class="small" style="color:var(--danger)">Verteilung ist noch nicht eingerichtet (siehe unten).</span>' : ''}</div>
      <button class="btn primary" data-act="publish" ${S.dirty ? '' : 'disabled'}>${icon('cloudUp')}Veröffentlichen</button>
      ${ready ? `<button class="btn" data-act="checkNow">${icon('refresh')}Server prüfen</button>` : ''}
    </div>

    <div class="section-title"><h2>Schnellaktionen</h2></div>
    <div class="quick">
      <button class="card" data-act="addYear">${icon('calendar')}Neues Jahr anlegen</button>
      <button class="card" data-act="pickYearPhotos">${icon('camera')}Bilder hinzufügen</button>
      <button class="card" data-act="addNews">${icon('newspaper')}Neuigkeit schreiben</button>
      <button class="card" data-act="editMembers">${icon('users')}Mitglieder bearbeiten</button>
      <button class="card" data-act="editClub">${icon('crown')}Vereinsdaten &amp; Termin</button>
    </div>

    <div class="section-title"><h2>Kapitel</h2><button class="btn sm" data-act="addChapter" style="margin-left:auto">${icon('plus')}Neues Kapitel</button></div>
    <div class="card ch-list">${chapters.map((c, i) => `<div class="row ${c.hidden ? 'hidden' : ''}">
      <span class="n">${c.hidden ? '–' : ++num}</span><span class="t">${esc(c.title)}<br><span class="muted small" style="font-weight:400">${TYPE_LABEL[c.type] || c.type}</span></span>
      <button class="icon-btn" data-act="chMove" data-i="${i}" data-d="-1" title="Nach oben">${icon('up')}</button>
      <button class="icon-btn" data-act="chMove" data-i="${i}" data-d="1" title="Nach unten">${icon('down')}</button>
      <button class="icon-btn" data-act="chHide" data-i="${i}" title="${c.hidden ? 'Einblenden' : 'Ausblenden'}">${icon(c.hidden ? 'eyeOff' : 'eye')}</button>
      <button class="icon-btn" data-act="editChapter" data-id="${c.id}" title="Bearbeiten">${icon('edit')}</button>
      ${c.type === 'blocks' || c.type === 'song' ? `<button class="icon-btn" data-act="chDel" data-i="${i}" title="Löschen">${icon('trash')}</button>` : '<span style="width:36px"></span>'}
    </div>`).join('')}</div>

    <div class="section-title" id="dist"><h2>Verteilung an die Mitglieder</h2></div>
    <div class="card pad">
      <p style="margin-top:0" class="muted">Die Inhalte werden <b>verschlüsselt</b> in einem kostenlosen GitHub-Speicher abgelegt. Nur wer das Vereinspasswort hat (steckt im Einladungscode), kann sie lesen.</p>
      ${ready ? `<div class="update-banner" style="margin:0 0 16px">${icon('check')}<div style="flex:1"><b>Eingerichtet</b> – Repository <b>${esc(cfg.owner)}/${esc(cfg.repo)}</b>. Neue Inhalte gehen mit „Veröffentlichen“ an alle.</div></div>` : `
      <div class="callout" style="margin-top:0"><div class="ct">Schnell-Einrichtung (2 Schritte)</div>
        <ol class="steps" style="margin:10px 0 4px">
          <li>Bei GitHub angemeldet <a href="#" data-act="openUrl" data-url="https://github.com/settings/tokens/new?scopes=public_repo&description=Mottenbande%20App">Token erstellen</a> → Ablauf „No expiration“ wählen, Häkchen <b>public_repo</b> ist schon gesetzt → ganz unten „Generate token“ → Token kopieren.</li>
          <li>Token hier einfügen, ein Vereinspasswort ausdenken und „Alles automatisch einrichten“ antippen. Die App legt den Speicher an, veröffentlicht die erste Version und erzeugt den Einladungscode.</li>
        </ol></div>`}
      <div class="grid2">
        <label class="field"><span>Token (nur auf diesem Gerät gespeichert)</span><input class="input" id="cfgToken" type="password" value="${esc(S.admin.token)}" placeholder="ghp_…" autocomplete="off"></label>
        <label class="field"><span>Vereinspasswort</span><input class="input" id="cfgPw" type="password" value="${esc(cfg.password)}" placeholder="frei wählbar, mind. 8 Zeichen" autocomplete="off">
          <small>Nach der ersten Veröffentlichung nicht mehr ändern.</small></label>
      </div>
      <div class="btn-row">
        ${ready ? '' : `<button class="btn primary" data-act="autoSetup">${icon('sparkles')}Alles automatisch einrichten</button>`}
        <button class="btn" data-act="showSecrets">${icon('eye')}Anzeigen</button>
        <button class="btn ${ready ? 'primary' : ''}" data-act="makeInvite" ${S.sync ? '' : 'disabled'}>${icon('link')}Einladungscode erzeugen</button></div>
      <details style="margin-top:16px"><summary style="cursor:pointer;font-weight:700;color:var(--gold-text)">Erweitert (manuell eintragen)</summary>
        <div class="grid2" style="margin-top:12px">
          <label class="field"><span>GitHub-Benutzername</span><input class="input" id="cfgOwner" value="${esc(cfg.owner)}" autocapitalize="off"></label>
          <label class="field"><span>Repository</span><input class="input" id="cfgRepo" value="${esc(cfg.repo)}" autocapitalize="off"></label>
          <label class="field"><span>Branch</span><input class="input" id="cfgBranch" value="${esc(cfg.branch || 'main')}" autocapitalize="off"></label>
        </div>
        <button class="btn" data-act="saveConn">${icon('check')}Speichern &amp; testen</button>
      </details>
    </div>

    <div class="section-title"><h2>Web-Version für iPhone &amp; Mac</h2></div>
    <div class="card pad">
      <p style="margin-top:0" class="muted">Apple-Nutzer öffnen das Jahrbuch im Browser (Safari) und legen es auf den Home-Bildschirm. Sie bekommen dieselben Inhalte und Updates – freigeschaltet mit dem Einladungscode.</p>
      ${cfg.webUrl ? `<div class="code-box" style="margin-bottom:12px">${esc(cfg.webUrl)}</div>` : ''}
      <div class="btn-row">
        <button class="btn ${cfg.webUrl ? '' : 'primary'}" data-act="publishWeb" ${ready ? '' : 'disabled'}>${icon('cloudUp')}${cfg.webUrl ? 'Web-Version aktualisieren' : 'Web-Version veröffentlichen'}</button>
        ${cfg.webUrl ? `<button class="btn" data-act="openUrl" data-url="${esc(cfg.webUrl)}">${icon('link')}Öffnen</button>` : ''}
      </div>
      ${ready ? '' : '<p class="small muted" style="margin-bottom:0">Zuerst die Verteilung einrichten (oben).</p>'}
    </div>

    <div class="section-title"><h2>Update-Paket (ohne Internet)</h2></div>
    <div class="card">
      <div class="set-row click" data-act="exportPkg"><div class="ic">${icon('download')}</div><div class="tx"><b>Update-Paket speichern</b><span>Komplette Inhalte inkl. neuer Bilder als Datei – z. B. per WhatsApp verschicken oder als Sicherung</span></div>${icon('right')}</div>
      <div class="set-row click" data-act="importPkg"><div class="ic">${icon('package')}</div><div class="tx"><b>Update-Paket / Sicherung einspielen</b><span>Eine .mbpaket-Datei laden</span></div>${icon('right')}</div>
      <div class="set-row click" data-act="resetSeed"><div class="ic">${icon('refresh')}</div><div class="tx"><b>Auf Original-Jahrbuch zurücksetzen</b><span>Lokale Inhalte durch die mitgelieferte Fassung ersetzen</span></div>${icon('right')}</div>
    </div>

    <div class="section-title"><h2>Sicherheit</h2></div>
    <div class="card">
      <div class="set-row click" data-act="changePin"><div class="ic">${icon('key')}</div><div class="tx"><b>Admin-PIN ändern</b></div>${icon('right')}</div>
      <div class="set-row click" data-act="adminOff"><div class="ic">${icon('logout')}</div><div class="tx"><b>Admin-Modus beenden</b></div></div>
    </div>
  </div>`,
  };
}

/* ---------- actions ---------- */
async function commitEdit() {
  const e = S.editing;
  const d = e.draft;
  if (e.kind === 'chapter') {
    const i = S.content.chapters.findIndex((c) => c.id === e.id);
    if (!d.title.trim()) return toast('Bitte einen Titel eingeben.', 'err');
    S.content.chapters[i] = d;
  }
  if (e.kind === 'year') {
    const year = parseInt(d.year, 10);
    if (!year) return toast('Bitte ein gültiges Jahr eingeben.', 'err');
    if (year !== e.year && S.content.years.some((y) => y.year === year)) return toast(`Das Jahr ${year} gibt es schon.`, 'err');
    d.year = year;
    const i = S.content.years.findIndex((y) => y.year === e.year);
    S.content.years[i] = d;
    if (year !== e.year) { S.editing = null; await saveContent(); toast('Gespeichert'); go(`#/k/${chapterByType('history').id}/${year}`); return; }
  }
  if (e.kind === 'club') S.content.club = d;
  S.editing = null;
  await saveContent();
  toast('Gespeichert – zum Verteilen „Veröffentlichen“ antippen');
  render({ keepScroll: false });
}

function newItem(kind) {
  if (kind === 'fact') return { k: '', v: '' };
  if (kind === 'row') return ['', ''];
  if (kind === 'member') return { id: 'm' + Date.now(), name: '', nick: '', born: '', badge: `Prospäkt ${new Date().getFullYear()}`, role: '', note: '', photo: '' };
  if (kind === 'verse') return { lines: '', refrain: false };
  if (kind === 'refrain') { const last = [...S.editing.draft.verses].reverse().find((v) => v.refrain); return { lines: last ? last.lines : '', refrain: true }; }
  return {};
}

Object.assign(A, {
  publish: () => publishDialog(),
  edSave: () => commitEdit(),
  edCancel: async () => {
    if (S.editing.changed && !(await confirmDlg('Änderungen verwerfen?', 'Deine Änderungen an dieser Seite gehen verloren.', { ok: 'Verwerfen', danger: true }))) return;
    S.editing = null; render();
  },
  edMove: (el) => {
    const { arr, i } = splitIdx(el.dataset.path);
    const j = i + +el.dataset.d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    rerender();
  },
  edDel: async (el) => {
    const { arr, i } = splitIdx(el.dataset.path);
    const it = arr[i];
    const hasContent = typeof it === 'object' && JSON.stringify(it).replace(/["{}\[\],:]|false|true/g, '').length > 30;
    if (hasContent && !(await confirmDlg('Wirklich entfernen?', 'Dieser Eintrag wird entfernt (erst beim Speichern endgültig).', { ok: 'Entfernen', danger: true }))) return;
    arr.splice(i, 1);
    rerender();
  },
  edPush: (el) => { getPath(S.editing.draft, el.dataset.path).push(newItem(el.dataset.kind)); rerender(); },
  edAddBlock: (el) => {
    const t = el.dataset.t;
    const b = { t };
    if (t === 'p' || t === 'h' || t === 'quote') b.text = '';
    if (t === 'callout') { b.title = ''; b.text = ''; }
    if (t === 'facts') b.items = [{ k: '', v: '' }];
    if (t === 'table') { b.head = ['', '']; b.rows = [['', '']]; }
    if (t === 'image') { b.id = ''; b.caption = ''; }
    S.editing.draft.blocks.push(b);
    rerender();
    setTimeout(() => { const s = $('#scroller'); s.scrollTop = s.scrollHeight; }, 30);
  },
  edPickImage: async (el) => {
    const [file] = await pickMedia('image', false);
    if (!file) return;
    const [id] = await processFiles([file]);
    if (id) { setPath(S.editing.draft, el.dataset.path, id); rerender(); }
  },
  edRotate: async (el) => {
    const id = getPath(S.editing.draft, el.dataset.path);
    if (!id) return;
    el.disabled = true;
    try { setPath(S.editing.draft, el.dataset.path, await rotateImage(id, +el.dataset.d)); rerender(); } catch (e) { toast(e.message, 'err'); el.disabled = false; }
  },
  edPickAudio: async () => {
    const [file] = await pickMedia('audio', false);
    if (!file) return;
    try {
      const id = await addAudioFile(file);
      const old = S.editing.draft.audio || {};
      S.editing.draft.audio = { id, mime: file.type || 'audio/mpeg', name: file.name, credit: old.credit || '' };
      rerender();
      toast('Musik hinterlegt – Speichern nicht vergessen');
    } catch (e) { toast(e.message, 'err'); }
  },
  edClearAudio: () => { delete S.editing.draft.audio; rerender(); },
  edClear: (el) => { setPath(S.editing.draft, el.dataset.path, ''); rerender(); },
  edAddPhotos: async () => {
    try { const files = await pickMedia('image', true); if (files.length) await addPhotosToDraft(files); else if (isTauri() && !isAndroid) toast(PHONE_HINT, 'info', 9000); } catch (e) { toast('Bilder konnten nicht geladen werden: ' + (e.message || e), 'err', 8000); }
  },
  edCover: (el) => { const ph = S.editing.draft.photos; const [x] = ph.splice(+el.dataset.i, 1); ph.unshift(x); rerender(); },
  edWeather: (el) => { S.editing.draft.weather = el.dataset.v; rerender(); },
  edDelYear: async () => {
    const y = S.editing.year;
    if (!(await confirmDlg(`Jahr ${y} löschen?`, 'Text und alle Bilder dieses Jahres werden entfernt.', { ok: 'Löschen', danger: true }))) return;
    S.content.years = S.content.years.filter((x) => x.year !== y);
    S.editing = null;
    await saveContent();
    toast(`Jahr ${y} gelöscht`);
    go(`#/k/${chapterByType('history').id}`);
  },
  editChapter: (el) => {
    const c = S.content.chapters.find((x) => x.id === el.dataset.id);
    if (!c) return;
    const target = `#/k/${c.id}`;
    if (location.hash !== target) location.hash = target;
    const d = clone(c);
    if (d.type === 'blocks' && !d.blocks) d.blocks = [];
    if (d.type === 'song' && !d.verses) d.verses = [];
    S.editing = { hash: target, kind: 'chapter', id: c.id, draft: d, title: c.title, changed: false };
    render();
  },
  editMembers: () => { const c = chapterByType('members'); if (c) A.editChapter({ dataset: { id: c.id } }); },
  editYear: (el) => {
    const y = S.content.years.find((x) => String(x.year) === el.dataset.year);
    const hist = chapterByType('history');
    const hash = `#/k/${hist.id}/${y.year}`;
    if (location.hash !== hash) location.hash = hash;
    S.editing = { hash, kind: 'year', draft: clone(y), title: `Jahr ${y.year}`, changed: false, year: y.year };
    render();
  },
  editClub: () => {
    const d = clone(S.content.club);
    d.event = d.event || { title: '', date: '' };
    if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
    S.editing = { hash: location.hash || '#/', kind: 'club', draft: d, title: 'Vereinsdaten & Termin', changed: false };
    render();
  },
  addYear: () => addYear(),
  quickPhotos: async (el) => {
    const y = S.content.years.find((x) => String(x.year) === el.dataset.year);
    let files;
    try { files = await pickMedia('image', true); } catch (e) { toast('Bilder konnten nicht geladen werden: ' + (e.message || e), 'err', 8000); return; }
    if (!files.length) { if (isTauri() && !isAndroid) toast(PHONE_HINT, 'info', 9000); return; }
    const ids = await processFiles(files);
    if (!ids.length) return;
    y.photos.push(...ids.map((id) => ({ id, caption: '' })));
    await saveContent();
    toast(`${ids.length} Bild${ids.length > 1 ? 'er' : ''} zu ${y.year} hinzugefügt`);
    render({ keepScroll: true });
  },
  pickYearPhotos: () => {
    const years = [...S.content.years].sort((a, b) => b.year - a.year);
    const m = modal(`<h2>Bilder hinzufügen</h2><p class="lead">Zu welchem Jahr gehören die Bilder?</p>
      <div class="btn-row">${years.map((y) => `<button class="btn" data-y="${y.year}">${y.year}</button>`).join('')}<button class="btn primary" data-new>${icon('plus')}Neues Jahr</button></div>`);
    m.querySelectorAll('[data-y]').forEach((b) => { b.onclick = () => { m.close(); A.quickPhotos({ dataset: { year: b.dataset.y } }); }; });
    m.querySelector('[data-new]').onclick = () => { m.close(); addYear(); };
  },
  addNews: () => newsDialog(null),
  editNews: (el) => newsDialog((S.content.news || []).find((n) => n.id === el.dataset.id)),
  delNews: async (el) => {
    if (!(await confirmDlg('Neuigkeit löschen?', 'Sie verschwindet beim nächsten Veröffentlichen auch bei den Mitgliedern.', { ok: 'Löschen', danger: true }))) return;
    S.content.news = S.content.news.filter((n) => n.id !== el.dataset.id);
    await saveContent(); render({ keepScroll: true });
  },
  chMove: async (el) => {
    const arr = S.content.chapters; const i = +el.dataset.i; const j = i + +el.dataset.d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    await saveContent(); render({ keepScroll: true });
  },
  chHide: async (el) => { const c = S.content.chapters[+el.dataset.i]; c.hidden = !c.hidden; await saveContent(); render({ keepScroll: true }); },
  chDel: async (el) => {
    const c = S.content.chapters[+el.dataset.i];
    if (!(await confirmDlg(`„${c.title}“ löschen?`, 'Das Kapitel wird komplett entfernt. Tipp: Ausblenden geht auch.', { ok: 'Löschen', danger: true }))) return;
    S.content.chapters.splice(+el.dataset.i, 1);
    await saveContent(); render({ keepScroll: true });
  },
  addChapter: () => {
    const m = modal(`<h2>Neues Kapitel</h2>
      <label class="field"><span>Titel</span><input class="input" id="nc" placeholder="z. B. Rezepte, Wanderrouten, Chronik…" autofocus></label>
      <label class="field"><span>Art</span><select class="input" id="nt"><option value="blocks">Textkapitel (Absätze, Tabellen, Bilder…)</option><option value="song">Liedtext</option></select></label>
      <div class="foot"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="ok">${icon('plus')}Anlegen</button></div>`);
    m.querySelector('#ok').onclick = async () => {
      const title = m.querySelector('#nc').value.trim();
      if (!title) return toast('Bitte einen Titel eingeben.', 'err');
      const type = m.querySelector('#nt').value;
      const id = title.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
      const c = type === 'song' ? { id, type, title, subtitle: '', verses: [{ lines: '', refrain: false }] } : { id, type, title, blocks: [{ t: 'p', text: '' }] };
      S.content.chapters.push(c);
      await saveContent();
      m.close();
      A.editChapter({ dataset: { id } });
    };
  },
  openUrl: (el) => openUrl(el.dataset.url),
  showSecrets: () => { ['#cfgToken', '#cfgPw'].forEach((s) => { const el = $(s); if (el) el.type = el.type === 'password' ? 'text' : 'password'; }); },
  autoSetup: async (el) => {
    const token = $('#cfgToken').value.trim();
    const password = $('#cfgPw').value;
    if (!token) return toast('Bitte zuerst den Token einfügen.', 'err');
    if (password.length < 8) return toast('Das Vereinspasswort sollte mindestens 8 Zeichen haben.', 'err');
    el.disabled = true;
    const step = (t) => { el.innerHTML = t; };
    try {
      step('Prüfe GitHub-Konto…');
      const r = await autoSetup(token);
      const cfg = { owner: r.owner, repo: r.repo, branch: r.branch, password };
      step('Prüfe Speicher…');
      const info = await testConnection(cfg, token);
      S.sync = cfg; S.admin.token = token;
      await setConfig(cfg); await saveAdmin();
      if (info.meta) {
        toast(`Verbunden – auf dem Server liegt bereits Version ${info.meta.version}.`, 'ok', 5000);
        if (info.meta.version > S.content.version) S.remoteNewer = info.meta.version;
      } else {
        step('Erste Version wird veröffentlicht…');
        const copy = clone(S.content);
        copy.updatedAt = new Date().toISOString();
        const res = await publishRemote(cfg, token, copy, { note: 'Das Jahrbuch ist online', baseVersion: S.baseVersion,
          onProgress: (msg) => step(msg) });
        S.content = copy;
        await saveContent({ markDirty: false });
        await setDirty(false);
        await setBaseVersion(res.version);
        toast(`Fertig eingerichtet – Version ${res.version} ist online`, 'ok', 5000);
      }
      render({ keepScroll: true });
      A.makeInvite();
    } catch (e) {
      toast(e.message, 'err', 7000);
      el.disabled = false;
      el.innerHTML = `${icon('sparkles')}Alles automatisch einrichten`;
    }
  },
  saveConn: async (el) => {
    const cfg = {
      owner: $('#cfgOwner').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/.*$/, ''),
      repo: $('#cfgRepo').value.trim(),
      branch: $('#cfgBranch').value.trim() || 'main',
      password: $('#cfgPw').value,
    };
    const token = $('#cfgToken').value.trim();
    if (!cfg.owner || !cfg.repo || !token) return toast('Bitte Benutzername, Repository und Token ausfüllen.', 'err');
    if (cfg.password.length < 8) return toast('Das Vereinspasswort sollte mindestens 8 Zeichen haben.', 'err');
    el.disabled = true; el.innerHTML = 'Teste…';
    try {
      const info = await testConnection(cfg, token);
      S.sync = cfg; S.admin.token = token;
      await setConfig(cfg); await saveAdmin();
      if (!S.dirty && !info.meta) await setDirty(true); // first time: offer the initial publication
      toast(info.meta ? `Verbunden – auf dem Server liegt Version ${info.meta.version}` : 'Verbunden – jetzt „Veröffentlichen“ für die erste Version', 'ok', 5000);
      if (info.private) toast('Hinweis: Das Repository ist privat – Mitglieder können dann keine Updates laden. Bitte auf „Public“ stellen.', 'err', 8000);
      if (info.meta && info.meta.version > S.content.version) S.remoteNewer = info.meta.version;
    } catch (e) {
      toast(e.message, 'err', 6000);
    }
    render({ keepScroll: true });
  },
  publishWeb: async (el) => {
    if (!S.sync || !S.admin.token) return;
    const m = modal(`<h2>Web-Version veröffentlichen</h2><p class="lead">Die App lädt sich selbst als Web-Version in deinen GitHub-Speicher und schaltet GitHub Pages ein. Fotos und Texte liegen dort nur verschlüsselt.</p>
      <div class="small muted" id="wMsg">Starte…</div><div class="progress"><i id="wBar"></i></div>`);
    const prog = (msg, p) => { const a = m.querySelector('#wMsg'), b = m.querySelector('#wBar'); if (a) a.textContent = msg; if (b) b.style.width = `${Math.round(p * 100)}%`; };
    try {
      const list = await fetch('web-files.json', { cache: 'no-store' }).then((r) => r.json());
      const files = [];
      for (const p of list) files.push({ path: p, bytes: new Uint8Array(await (await fetch(p, { cache: 'no-store' })).arrayBuffer()) });
      files.push({ path: '.nojekyll', bytes: utf8('') });
      const res = await publishWeb(S.sync, S.admin.token, files, { onProgress: (msg, p) => prog(msg, p * 0.5) });
      const n = await uploadMissingMedia(S.sync, S.admin.token, { onProgress: (msg, p) => prog(msg, 0.5 + p * 0.5) });
      S.sync.webUrl = res.url;
      await setConfig(S.sync);
      m.close();
      if (res.pagesOk) {
        toast(`Web-Version ist online${n ? ` (${n} Fotos ergänzt)` : ''} – in 1–2 Minuten erreichbar`, 'ok', 7000);
      } else {
        const m2 = modal(`<h2>Noch ein Klick bei GitHub</h2><p class="lead">Die Dateien sind hochgeladen, GitHub Pages konnte aber nicht automatisch eingeschaltet werden.</p>
          <ol class="steps"><li>Unten auf „GitHub öffnen“ tippen.</li><li>Bei <b>Branch</b> „${esc(S.sync.branch || 'main')}“ und „/ (root)“ wählen → <b>Save</b>.</li><li>1–2 Minuten warten, fertig.</li></ol>
          <div class="foot"><button class="btn primary" id="gh">${icon('link')}GitHub öffnen</button></div>`);
        m2.querySelector('#gh').onclick = () => openUrl(`https://github.com/${S.sync.owner}/${S.sync.repo}/settings/pages`);
      }
      render({ keepScroll: true });
    } catch (e) {
      m.close();
      toast(e.message, 'err', 7000);
    }
  },
  makeInvite: async () => {
    if (!S.sync) return;
    const code = makeInvite(S.sync, S.content.club.name);
    const web = S.sync.webUrl ? `${S.sync.webUrl}#/einladung/${code}` : '';
    const text = `Hallo Motte! Hier ist das Mottenbande-Jahrbuch.\n\nAndroid & Windows: App installieren, dann unter „Mehr → Verbinden“ diesen Code einfügen:\n${code}${web ? `\n\niPhone, iPad & Mac: einfach diesen Link in Safari öffnen und „Zum Home-Bildschirm“ wählen:\n${web}` : ''}`;
    const m = modal(`<h2>Einladungscode</h2><p class="lead">Diesen Code an die Mitglieder schicken (z. B. in die WhatsApp-Gruppe). Er enthält das Vereinspasswort – also nur an Mitglieder!</p>
      <div class="code-box">${esc(code)}</div>
      <div class="foot"><button class="btn" id="cpCode">${icon('copy')}Nur Code kopieren</button><button class="btn primary" id="cpText">${icon('copy')}Nachricht kopieren</button></div>`);
    m.querySelector('#cpCode').onclick = async () => { await copyText(code); toast('Code kopiert'); };
    m.querySelector('#cpText').onclick = async () => { await copyText(text); toast('Nachricht kopiert – jetzt in WhatsApp einfügen'); };
  },
  exportPkg: async () => {
    let pw = S.sync ? S.sync.password : '';
    if (!pw) {
      pw = await promptDlg('Paket verschlüsseln?', { label: 'Passwort (leer lassen = unverschlüsselt)', type: 'password', lead: 'Ohne Vereinspasswort kann jeder mit der Datei die Inhalte sehen.', ok: 'Weiter' });
      if (pw === null) return;
    }
    toast('Paket wird erstellt…', 'info');
    try {
      const bytes = await buildPackage(S.content, pw);
      const ok = await saveFile(`Mottenbande-Jahrbuch-v${S.content.version}-${todayIso()}.mbpaket`, bytes);
      if (ok) toast(`Paket gespeichert (${(bytes.length / 1048576).toFixed(1)} MB)`);
    } catch (e) { toast('Speichern nicht möglich: ' + e.message, 'err', 6000); }
  },
  resetSeed: async () => {
    if (!(await confirmDlg('Zurücksetzen?', 'Alle lokalen Inhalte werden durch das Original-Jahrbuch ersetzt. Selbst hinzugefügte Bilder bleiben gespeichert, sind aber nicht mehr eingebunden.', { ok: 'Zurücksetzen', danger: true }))) return;
    const seed = await fetch('content/seed.json').then((r) => r.json());
    seed.version = S.content.version;
    S.content = seed;
    await saveContent();
    toast('Original-Jahrbuch wiederhergestellt');
    render();
  },
  changePin: () => {
    const m = modal(`<h2>Admin-PIN ändern</h2>
      <label class="field"><span>Aktuelle PIN</span><input class="input" type="password" id="o" autofocus></label>
      <label class="field"><span>Neue PIN</span><input class="input" type="password" id="n1"></label>
      <label class="field"><span>Neue PIN wiederholen</span><input class="input" type="password" id="n2"></label>
      <div class="foot"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="ok">Ändern</button></div>`);
    m.querySelector('#ok').onclick = async () => {
      if ((await sha256Hex('mb:' + m.querySelector('#o').value)) !== S.admin.pinHash) return toast('Aktuelle PIN ist falsch.', 'err');
      const a = m.querySelector('#n1').value;
      if (a.length < 4) return toast('Mindestens 4 Zeichen.', 'err');
      if (a !== m.querySelector('#n2').value) return toast('Die PINs stimmen nicht überein.', 'err');
      S.admin.pinHash = await sha256Hex('mb:' + a); await saveAdmin();
      m.close(); toast('PIN geändert');
    };
  },
});

function newsDialog(n) {
  const m = modal(`<h2>${n ? 'Neuigkeit bearbeiten' : 'Neuigkeit schreiben'}</h2>
    <label class="field"><span>Überschrift</span><input class="input" id="nt" value="${esc(n ? n.title : '')}" autofocus></label>
    <label class="field"><span>Datum</span><input class="input" id="nd" type="date" value="${esc(n ? n.date : todayIso())}"></label>
    <label class="field"><span>Text</span><textarea class="input" id="nx" rows="5">${esc(n ? n.text : '')}</textarea></label>
    <div class="foot"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="ok">${icon('check')}Speichern</button></div>`);
  m.querySelector('#ok').onclick = async () => {
    const title = m.querySelector('#nt').value.trim();
    if (!title) return toast('Bitte eine Überschrift eingeben.', 'err');
    const item = { id: n ? n.id : 'n' + Date.now(), title, date: m.querySelector('#nd').value || todayIso(), text: m.querySelector('#nx').value.trim() };
    S.content.news = S.content.news || [];
    if (n) Object.assign(n, item); else S.content.news.unshift(item);
    S.content.news.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!S.settings.readNews.includes(item.id)) { S.settings.readNews.push(item.id); saveSettings(); }
    await saveContent();
    m.close(); toast('Gespeichert'); render({ keepScroll: true });
  };
}

window.MB_ADMIN = { view: viewAdmin, editorView };
