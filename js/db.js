// Local persistence (IndexedDB): key/value store + image blobs.
const DB_NAME = 'mottenbande';
const DB_VERSION = 1;
let dbPromise = null;
const memory = { kv: new Map(), images: new Map() }; // fallback if IndexedDB is unavailable
let useMemory = false;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { useMemory = true; resolve(null); };
    } catch (e) { useMemory = true; resolve(null); }
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db || useMemory) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function store(name) {
  return {
    get: (k) => tx(name, 'readonly', (s) => (s ? s.get(k) : { result: memory[name].get(k) })).then((r) => (useMemory ? memory[name].get(k) : r)),
    set: (k, v) => (useMemory ? Promise.resolve(memory[name].set(k, v)) : tx(name, 'readwrite', (s) => s.put(v, k))),
    del: (k) => (useMemory ? Promise.resolve(memory[name].delete(k)) : tx(name, 'readwrite', (s) => s.delete(k))),
    keys: () => (useMemory ? Promise.resolve([...memory[name].keys()]) : tx(name, 'readonly', (s) => s.getAllKeys())),
  };
}

export const kv = store('kv');
export const images = store('images');
export async function hasImage(id) { return !!(await images.get(id)); }
