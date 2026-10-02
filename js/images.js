// Image resolution (bundled files vs. locally stored blobs) and upload processing.
import { images } from './db.js';
import { uuid } from './crypto.js';

let bundled = new Set();
let webMode = false; // web version: nothing but the crest is shipped, everything comes from the server
const urlCache = new Map();

export function setWebMode(on) { webMode = !!on; }
export function setBundled(list) { bundled = new Set(list); bundled.add('wappen'); }
export function isBundled(id) { return id === 'wappen' || (!webMode && (bundled.has(id) || String(id).startsWith('content/'))); }

/** Path of a shipped file (used when the admin uploads it for the web version). */
export function shippedPath(id) {
  if (String(id).startsWith('content/')) return id;
  return `content/img/${id}.jpg`;
}

/** File name of a media item on the server. */
export const remoteName = (id) => String(id).replace(/[^A-Za-z0-9-]/g, '_');

/** Synchronous path for images shipped with the app, otherwise ''. */
export function staticSrc(id) {
  if (!id) return '';
  if (id === 'wappen') return 'content/wappen.png';
  if (!webMode && id.startsWith('content/')) return id; // file shipped with the app
  if (!webMode && bundled.has(id)) return `content/img/${id}.jpg`;
  return urlCache.get(id) || '';
}

/** HTML for an <img>; locally stored images are filled in by hydrate(). */
export function imgTag(id, attrs = '') {
  const src = staticSrc(id);
  return src ? `<img src="${src}" ${attrs}>` : `<img data-img="${id}" ${attrs}>`;
}

export async function imageUrl(id) {
  const s = staticSrc(id);
  if (s) return s;
  const blob = await images.get(id);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

export async function hydrate(root = document) {
  const list = root.querySelectorAll('img[data-img]:not([src])');
  await Promise.all([...list].map(async (el) => {
    const url = await imageUrl(el.dataset.img);
    if (url) el.src = url; else el.alt = 'Bild fehlt';
  }));
}

export function forget(id) {
  const u = urlCache.get(id);
  if (u) URL.revokeObjectURL(u);
  urlCache.delete(id);
}

/** Resize + compress a picked image file and store it. Returns the new image id. */
export async function addImageFile(file, maxSide = 1920, quality = 0.85) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden: ' + file.name));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Bild konnte nicht umgewandelt werden: ' + file.name);
  const id = uuid();
  await images.set(id, blob);
  return id;
}

/** Rotates an image by 90° steps (dir: 1 = clockwise, -1 = counter-clockwise) and stores it as a new image. */
export async function rotateImage(id, dir = 1) {
  const url = await imageUrl(id);
  if (!url) throw new Error('Bild nicht gefunden');
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
    el.src = url;
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = h; canvas.height = w;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(h / 2, w / 2);
  ctx.rotate((dir > 0 ? 90 : -90) * Math.PI / 180);
  ctx.drawImage(img, -w / 2, -h / 2);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  const newId = uuid();
  await images.set(newId, blob);
  return newId;
}

/** Stores an audio file (mp3, m4a, ogg, wav) unchanged. Returns its id. */
export async function addAudioFile(file) {
  if (file.size > 25 * 1048576) throw new Error('Die Audiodatei ist zu groß (max. 25 MB).');
  const id = 'audio-' + uuid();
  await images.set(id, new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' }));
  return id;
}

/** MIME type of a stored media file, as recorded in the content. */
export function mimeFor(content, id) {
  for (const c of content.chapters || []) if (c.audio && c.audio.id === id) return c.audio.mime || 'audio/mpeg';
  return 'image/jpeg';
}

/** Every media id (images + audio) referenced by the content. */
export function referencedImages(content) {
  const ids = new Set();
  for (const y of content.years || []) for (const p of y.photos || []) ids.add(p.id);
  for (const c of content.chapters || []) {
    for (const b of c.blocks || []) if (b.t === 'image' && b.id) ids.add(b.id);
    for (const m of c.members || []) if (m.photo) ids.add(m.photo);
    if (c.audio && c.audio.id) ids.add(c.audio.id);
  }
  ids.delete('');
  return [...ids];
}
