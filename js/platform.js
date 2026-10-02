// Bridges to the native shell (Tauri) with browser fallbacks.
const T = () => window.__TAURI__;
export const isTauri = () => !!T();
export const isAndroid = /Android/i.test(navigator.userAgent);
export const APP_VERSION = '1.2.4';

export async function saveFile(name, bytes, ext = 'mbpaket') {
  const t = T();
  if (t && t.dialog && t.fs) {
    const path = await t.dialog.save({ defaultPath: name, filters: [{ name: 'Mottenbande-Datei', extensions: [ext] }] });
    if (!path) return false;
    await t.fs.writeFile(path, bytes);
    return true;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

export function pickFiles({ accept = '*/*', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => { resolve([...input.files]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'wav'];
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav' };

/** Reads files given as native paths (file dialog / drag & drop) into File objects. */
export async function filesFromPaths(paths, kind = 'image') {
  const t = T();
  const files = [];
  for (const p of paths) {
    const path = typeof p === 'string' ? p : p.path || String(p);
    // Desktop: read through the app's own command; Android returns content:// URIs, read by the fs plugin.
    const data = /^content:/.test(path) ? await t.fs.readFile(path) : await t.core.invoke('read_media_file', { path });
    const name = decodeURIComponent(path.split(/[\\/]/).pop() || 'datei');
    const ext = (name.split('.').pop() || '').toLowerCase();
    files.push(new File([data], name, { type: MIME[ext] || (kind === 'audio' ? 'audio/mpeg' : 'image/jpeg') }));
  }
  return files;
}

/** Native drag & drop (desktop app): calls handlers with the dropped file paths. */
export function onNativeDrop({ over, leave, drop }) {
  const t = T();
  if (!t || !t.webview || !t.webview.getCurrentWebview) return false;
  t.webview.getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload || {};
    if (p.type === 'enter' || p.type === 'over') over && over();
    else if (p.type === 'leave') leave && leave();
    else if (p.type === 'drop') drop && drop(p.paths || []);
  });
  return true;
}

/**
 * Picks image or audio files. In the native app the system file dialog is used
 * (reliable multi-select); in a browser a normal file input.
 */
export async function pickMedia(kind = 'image', multiple = false) {
  const t = T();
  const exts = kind === 'audio' ? AUDIO_EXT : IMG_EXT;
  if (t && t.dialog && t.fs && !isAndroid) {
    let sel;
    try {
      sel = await t.dialog.open({ multiple, directory: false, filters: [{ name: kind === 'audio' ? 'Musik' : 'Bilder', extensions: exts }] });
    } catch (e) {
      console.warn('Native file dialog failed, using browser picker', e);
      return pickFiles({ accept: kind === 'audio' ? 'audio/*' : 'image/*', multiple });
    }
    if (!sel) return [];
    return filesFromPaths(Array.isArray(sel) ? sel : [sel], kind);
  }
  return pickFiles({ accept: kind === 'audio' ? 'audio/*,.mp3,.m4a,.ogg,.wav' : 'image/*', multiple });
}

export async function notify(title, body) {
  try {
    const n = T() && T().notification;
    if (n) {
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === 'granted';
      if (ok) n.sendNotification({ title, body });
      return;
    }
    if ('Notification' in window) {
      if (Notification.permission === 'default') await Notification.requestPermission();
      if (Notification.permission === 'granted') new Notification(title, { body, icon: 'content/wappen.png' });
    }
  } catch (e) { console.warn('Benachrichtigung fehlgeschlagen', e); }
}

export async function openUrl(url) {
  const t = T();
  try {
    if (t && t.opener) return await t.opener.openUrl(url);
  } catch (e) { console.warn(e); }
  window.open(url, '_blank', 'noopener');
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
