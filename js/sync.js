// Distribution of updates.
// Admin publishes encrypted content + images to a GitHub repository; member apps
// poll it, decrypt with the club password and store everything locally.
// Repository layout: mb/meta.json (public: version, salt, note), mb/content.bin, mb/img/<id>.bin
import { kv, images } from './db.js';
import { deriveKey, encrypt, decrypt, toB64, fromB64, toB64Url, utf8, fromUtf8, randomBytes } from './crypto.js';
import { isBundled, referencedImages, mimeFor, remoteName, shippedPath } from './images.js';

const ITER = 150000;
const API = 'https://api.github.com';

export async function getConfig() { return (await kv.get('sync')) || null; }
export async function setConfig(cfg) { await kv.set('sync', cfg); }

/* ---------- Invite codes ---------- */
export function makeInvite(cfg, clubName) {
  const data = { o: cfg.owner, r: cfg.repo, b: cfg.branch || 'main', p: cfg.password, n: clubName };
  return 'MB1.' + toB64Url(utf8(JSON.stringify(data)));
}
export function parseInvite(code) {
  const c = (code || '').trim().replace(/\s+/g, '');
  if (!c.startsWith('MB1.')) throw new Error('Das ist kein gültiger Einladungscode (er beginnt mit „MB1.“).');
  try {
    const d = JSON.parse(fromUtf8(fromB64(c.slice(4))));
    if (!d.o || !d.r || !d.p) throw new Error();
    return { owner: d.o, repo: d.r, branch: d.b || 'main', password: d.p, clubName: d.n || '' };
  } catch (e) { throw new Error('Der Einladungscode ist beschädigt. Bitte komplett kopieren.'); }
}

/* ---------- Reading (members + admin) ---------- */
function rawUrl(cfg, path) {
  return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch || 'main'}/${path}`;
}

async function fetchBytes(cfg, path, { fresh = false, token = '' } = {}) {
  if (fresh) {
    // Contents API is not CDN-cached -> sees new versions immediately.
    try {
      const headers = { Accept: 'application/vnd.github.raw' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch || 'main')}`, { headers, cache: 'no-store' });
      if (r.status === 404) return null;
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch (e) { /* fall back to raw */ }
  }
  const r = await fetch(rawUrl(cfg, path) + (fresh ? `?t=${Date.now()}` : ''), { cache: fresh ? 'no-store' : 'default' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Server antwortet nicht (${r.status}).`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function fetchMeta(cfg, token) {
  const b = await fetchBytes(cfg, 'mb/meta.json', { fresh: true, token });
  return b ? JSON.parse(fromUtf8(b)) : null;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

/**
 * Downloads and decrypts the remote content if it is newer than localVersion.
 * Returns null (nothing new) or { content, meta }.
 */
export async function pullRemote(cfg, localVersion, { force = false, onProgress } = {}) {
  const meta = await fetchMeta(cfg);
  if (!meta) return { empty: true };
  if (!force && meta.version <= localVersion) return { meta, upToDate: true };
  const key = await deriveKey(cfg.password, meta.salt, meta.iter || ITER);
  const bin = await fetchBytes(cfg, 'mb/content.bin', { fresh: true });
  if (!bin) throw new Error('Inhaltsdatei fehlt auf dem Server.');
  const content = JSON.parse(fromUtf8(await decrypt(key, bin)));
  const have = new Set(await images.keys());
  const missing = referencedImages(content).filter((id) => !isBundled(id) && !have.has(id));
  let done = 0;
  await mapLimit(missing, 4, async (id) => {
    const b = await fetchBytes(cfg, `mb/img/${remoteName(id)}.bin`);
    if (b) await images.set(id, new Blob([await decrypt(key, b)], { type: mimeFor(content, id) }));
    done++;
    onProgress && onProgress(done, missing.length);
  });
  return { content, meta, images: missing.length };
}

/* ---------- Publishing (admin) ---------- */
async function gh(cfg, token, method, path, body) {
  const r = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty body */ }
  return { ok: r.ok, status: r.status, data };
}

function ghError(res, what) {
  if (res.status === 401) return new Error('Der Zugangsschlüssel (Token) ist ungültig oder abgelaufen.');
  if (res.status === 403) return new Error('Keine Schreibrechte – der Token braucht das Recht „public_repo“ bzw. „Contents: Read and write“.');
  if (res.status === 404) return new Error('Repository nicht gefunden – Name/Besitzer prüfen.');
  return new Error(`${what} fehlgeschlagen (${res.status}${res.data && res.data.message ? ': ' + res.data.message : ''}).`);
}

/** Finds the GitHub user of the token and creates the data repository if it does not exist yet. */
export async function autoSetup(token, repo = 'mottenbande-daten') {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const u = await fetch(`${API}/user`, { headers, cache: 'no-store' });
  if (u.status === 401) throw new Error('Der Token ist ungültig oder abgelaufen.');
  if (!u.ok) throw new Error(`GitHub antwortet nicht (${u.status}).`);
  const owner = (await u.json()).login;
  const r = await fetch(`${API}/repos/${owner}/${repo}`, { headers, cache: 'no-store' });
  let created = false;
  let branch = 'main';
  if (r.status === 404) {
    const c = await fetch(`${API}/user/repos`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: repo, description: 'Mottenbande Jahrbuch – verschlüsselte Inhalte', private: false, auto_init: true }),
    });
    if (c.status === 403 || c.status === 404) throw new Error('Der Token darf keine Repositories anlegen – beim Erstellen das Häkchen „public_repo“ setzen.');
    if (!c.ok) throw new Error(`Repository konnte nicht angelegt werden (${c.status}).`);
    branch = (await c.json()).default_branch || 'main';
    created = true;
    await new Promise((res) => setTimeout(res, 1500)); // GitHub needs a moment for the first commit
  } else if (r.ok) {
    const info = await r.json();
    branch = info.default_branch || 'main';
    if (info.private) throw new Error(`Das Repository „${repo}“ ist privat – bitte auf „Public“ stellen (die Inhalte sind verschlüsselt).`);
  } else throw new Error(`GitHub antwortet nicht (${r.status}).`);
  return { owner, repo, branch, created };
}

export async function testConnection(cfg, token) {
  const res = await gh(cfg, token, 'GET', '');
  if (!res.ok) throw ghError(res, 'Verbindung');
  if (res.data.permissions && !res.data.permissions.push) throw new Error('Der Token hat keine Schreibrechte für dieses Repository.');
  const meta = await fetchMeta(cfg, token);
  if (meta) {
    const key = await deriveKey(cfg.password, meta.salt, meta.iter || ITER);
    const bin = await fetchBytes(cfg, 'mb/content.bin', { fresh: true, token });
    if (bin) await decrypt(key, bin); // throws if the password does not match
  }
  return { private: res.data.private, meta };
}

async function getHead(cfg, token) {
  const branch = cfg.branch || 'main';
  let ref = await gh(cfg, token, 'GET', `/git/ref/heads/${branch}`);
  if (!ref.ok && (ref.status === 404 || ref.status === 409)) {
    // Empty repository: create a first file so that a branch exists.
    const init = await gh(cfg, token, 'PUT', '/contents/README.md', {
      message: 'Mottenbande Jahrbuch – Datenablage',
      content: toB64(utf8('# Mottenbande Jahrbuch\n\nVerschlüsselte Inhalte der Mottenbande-App. Nur mit Vereinspasswort lesbar.\n')),
      branch,
    });
    if (!init.ok) throw ghError(init, 'Repository vorbereiten');
    ref = await gh(cfg, token, 'GET', `/git/ref/heads/${branch}`);
  }
  if (!ref.ok) throw ghError(ref, 'Branch lesen');
  const commitSha = ref.data.object.sha;
  const commit = await gh(cfg, token, 'GET', `/git/commits/${commitSha}`);
  if (!commit.ok) throw ghError(commit, 'Commit lesen');
  const tree = await gh(cfg, token, 'GET', `/git/trees/${commit.data.tree.sha}?recursive=1`);
  const paths = new Set(tree.ok ? tree.data.tree.map((t) => t.path) : []);
  return { commitSha, treeSha: commit.data.tree.sha, paths };
}

async function createBlob(cfg, token, bytes) {
  const res = await gh(cfg, token, 'POST', '/git/blobs', { content: toB64(bytes), encoding: 'base64' });
  if (!res.ok) throw ghError(res, 'Hochladen');
  return res.data.sha;
}

/**
 * Publishes content (already bumped to the new version by the caller) and all
 * images that are not on the server yet. Uses one single commit.
 */
export async function publishRemote(cfg, token, content, { note = '', baseVersion = 0, force = false, onProgress } = {}) {
  const step = (msg, p) => onProgress && onProgress(msg, p);
  step('Verbinde mit Server…', 0.02);
  const head = await getHead(cfg, token);
  const remoteMeta = head.paths.has('mb/meta.json') ? await fetchMeta(cfg, token) : null;
  if (remoteMeta && remoteMeta.version > baseVersion && !force) {
    const err = new Error(`Auf dem Server liegt bereits eine neuere Version (${remoteMeta.version}), die auf diesem Gerät noch nicht geladen wurde.`);
    err.conflict = true; err.remoteVersion = remoteMeta.version;
    throw err;
  }
  const salt = remoteMeta ? remoteMeta.salt : toB64(randomBytes(16));
  const iter = remoteMeta ? remoteMeta.iter || ITER : ITER;
  if (remoteMeta) {
    // Make sure the password still matches the data on the server.
    const bin = await fetchBytes(cfg, 'mb/content.bin', { fresh: true, token });
    if (bin) await decrypt(await deriveKey(cfg.password, salt, iter), bin);
  }
  const version = Math.max(content.version || 1, remoteMeta ? remoteMeta.version + 1 : 2);
  content.version = version;
  const key = await deriveKey(cfg.password, salt, iter);

  // All media (also the photos shipped with the apps) go to the server once, so the web version can show them.
  const upload = referencedImages(content).filter((id) => id !== 'wappen' && !head.paths.has(`mb/img/${remoteName(id)}.bin`));
  const entries = [];
  let done = 0;
  await mapLimit(upload, 3, async (id) => {
    let blob = await images.get(id);
    if (!blob && isBundled(id)) { const r = await fetch(shippedPath(id)); if (r.ok) blob = await r.blob(); }
    if (!blob) { done++; return; }
    const encBytes = await encrypt(key, new Uint8Array(await blob.arrayBuffer()));
    const sha = await createBlob(cfg, token, encBytes);
    entries.push({ path: `mb/img/${remoteName(id)}.bin`, mode: '100644', type: 'blob', sha });
    done++;
    step(`Bilder hochladen ${done}/${upload.length}`, 0.05 + 0.8 * (done / upload.length));
  });

  step('Inhalte verschlüsseln…', 0.88);
  const contentSha = await createBlob(cfg, token, await encrypt(key, utf8(JSON.stringify(content))));
  const meta = { app: 'mottenbande', version, updatedAt: content.updatedAt, note, salt, iter, schema: content.schema || 1 };
  const metaSha = await createBlob(cfg, token, utf8(JSON.stringify(meta, null, 1)));
  entries.push({ path: 'mb/content.bin', mode: '100644', type: 'blob', sha: contentSha });
  entries.push({ path: 'mb/meta.json', mode: '100644', type: 'blob', sha: metaSha });

  step('Veröffentlichen…', 0.94);
  const tree = await gh(cfg, token, 'POST', '/git/trees', { base_tree: head.treeSha, tree: entries });
  if (!tree.ok) throw ghError(tree, 'Speichern');
  const commit = await gh(cfg, token, 'POST', '/git/commits', {
    message: `Version ${version}${note ? ': ' + note : ''}`, tree: tree.data.sha, parents: [head.commitSha],
  });
  if (!commit.ok) throw ghError(commit, 'Speichern');
  const upd = await gh(cfg, token, 'PATCH', `/git/refs/heads/${cfg.branch || 'main'}`, { sha: commit.data.sha });
  if (!upd.ok) throw ghError(upd, 'Veröffentlichen');
  step('Fertig', 1);
  return { version, uploaded: upload.length };
}

/** Uploads media that is referenced but not on the server yet (no new content version). */
export async function uploadMissingMedia(cfg, token, { onProgress } = {}) {
  const meta = await fetchMeta(cfg, token);
  if (!meta) return 0;
  const head = await getHead(cfg, token);
  const key = await deriveKey(cfg.password, meta.salt, meta.iter || ITER);
  const bin = await fetchBytes(cfg, 'mb/content.bin', { fresh: true, token });
  const content = JSON.parse(fromUtf8(await decrypt(key, bin)));
  const missing = referencedImages(content).filter((id) => id !== 'wappen' && !head.paths.has(`mb/img/${remoteName(id)}.bin`));
  if (!missing.length) return 0;
  const entries = [];
  let done = 0;
  await mapLimit(missing, 3, async (id) => {
    let blob = await images.get(id);
    if (!blob && isBundled(id)) { const r = await fetch(shippedPath(id)); if (r.ok) blob = await r.blob(); }
    if (blob) {
      const sha = await createBlob(cfg, token, await encrypt(key, new Uint8Array(await blob.arrayBuffer())));
      entries.push({ path: `mb/img/${remoteName(id)}.bin`, mode: '100644', type: 'blob', sha });
    }
    done++;
    onProgress && onProgress(`Fotos für die Web-Version hochladen ${done}/${missing.length}`, done / missing.length);
  });
  if (!entries.length) return 0;
  const tree = await gh(cfg, token, 'POST', '/git/trees', { base_tree: head.treeSha, tree: entries });
  if (!tree.ok) throw ghError(tree, 'Speichern');
  const commit = await gh(cfg, token, 'POST', '/git/commits', { message: `${entries.length} Fotos ergänzt`, tree: tree.data.sha, parents: [head.commitSha] });
  if (!commit.ok) throw ghError(commit, 'Speichern');
  const upd = await gh(cfg, token, 'PATCH', `/git/refs/heads/${cfg.branch || 'main'}`, { sha: commit.data.sha });
  if (!upd.ok) throw ghError(upd, 'Veröffentlichen');
  return entries.length;
}

/* ---------- Web version (GitHub Pages) ---------- */
/**
 * Puts the web app files into the root of the data repository (one commit) and
 * switches on GitHub Pages. files: [{ path, bytes }]. Returns { url, pagesOk }.
 */
export async function publishWeb(cfg, token, files, { onProgress } = {}) {
  const step = (msg, p) => onProgress && onProgress(msg, p);
  step('Verbinde mit GitHub…', 0.02);
  const head = await getHead(cfg, token);
  const entries = [];
  let done = 0;
  await mapLimit(files, 4, async (f) => {
    const sha = await createBlob(cfg, token, f.bytes);
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha });
    done++;
    step(`Dateien hochladen ${done}/${files.length}`, 0.05 + 0.8 * (done / files.length));
  });
  step('Veröffentlichen…', 0.9);
  const tree = await gh(cfg, token, 'POST', '/git/trees', { base_tree: head.treeSha, tree: entries });
  if (!tree.ok) throw ghError(tree, 'Speichern');
  const commit = await gh(cfg, token, 'POST', '/git/commits', { message: 'Web-Version aktualisiert', tree: tree.data.sha, parents: [head.commitSha] });
  if (!commit.ok) throw ghError(commit, 'Speichern');
  const upd = await gh(cfg, token, 'PATCH', `/git/refs/heads/${cfg.branch || 'main'}`, { sha: commit.data.sha });
  if (!upd.ok) throw ghError(upd, 'Veröffentlichen');

  step('GitHub Pages einschalten…', 0.95);
  let pagesOk = false;
  let url = `https://${cfg.owner.toLowerCase()}.github.io/${cfg.repo}/`;
  const existing = await gh(cfg, token, 'GET', '/pages');
  if (existing.ok) pagesOk = true;
  else {
    const en = await gh(cfg, token, 'POST', '/pages', { source: { branch: cfg.branch || 'main', path: '/' } });
    pagesOk = en.ok || en.status === 409;
  }
  const info = await gh(cfg, token, 'GET', '/pages');
  if (info.ok && info.data.html_url) url = info.data.html_url.endsWith('/') ? info.data.html_url : info.data.html_url + '/';
  step('Fertig', 1);
  return { url, pagesOk };
}

/* ---------- Offline update packages (.mbpaket) ---------- */
export async function buildPackage(content, password) {
  const ids = referencedImages(content).filter((id) => !isBundled(id));
  const imgs = {};
  for (const id of ids) {
    const blob = await images.get(id);
    if (blob) imgs[id] = toB64(new Uint8Array(await blob.arrayBuffer()));
  }
  const payload = utf8(JSON.stringify({ content, images: imgs }));
  const pkg = { format: 'mottenbande-paket', v: 1, created: new Date().toISOString(), version: content.version, encrypted: !!password };
  if (password) {
    pkg.salt = toB64(randomBytes(16));
    pkg.iter = ITER;
    pkg.data = toB64(await encrypt(await deriveKey(password, pkg.salt, ITER), payload));
  } else {
    pkg.data = toB64(payload);
  }
  return utf8(JSON.stringify(pkg));
}

export async function readPackage(bytes, password) {
  let pkg;
  try { pkg = JSON.parse(fromUtf8(bytes)); } catch (e) { throw new Error('Diese Datei ist kein Mottenbande-Paket.'); }
  if (pkg.format !== 'mottenbande-paket') throw new Error('Diese Datei ist kein Mottenbande-Paket.');
  let raw = fromB64(pkg.data);
  if (pkg.encrypted) {
    if (!password) { const e = new Error('Für dieses Paket wird das Vereinspasswort benötigt.'); e.needPassword = true; throw e; }
    raw = await decrypt(await deriveKey(password, pkg.salt, pkg.iter || ITER), raw);
  }
  const { content, images: imgs } = JSON.parse(fromUtf8(raw));
  for (const [id, b64] of Object.entries(imgs || {})) {
    await images.set(id, new Blob([fromB64(b64)], { type: mimeFor(content, id) }));
  }
  return content;
}
