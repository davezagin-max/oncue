// Local storage for sessions, recordings and the uploaded job posting.
// Everything lives in this browser's IndexedDB. Nothing is uploaded anywhere.
// If IndexedDB is unavailable (some private-browsing modes), we fall back to
// memory so the app still works for the current tab.

const DB_NAME = 'oncue';
const DB_VERSION = 1;

let dbPromise = null;
let memoryMode = false;
const memory = { sessions: new Map(), recordings: new Map(), files: new Map() };

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      if (!('indexedDB' in globalThis) || !globalThis.indexedDB) throw new Error('no indexedDB');
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      memoryMode = true;
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('recordings')) {
        const rec = db.createObjectStore('recordings', { keyPath: 'id' });
        rec.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      memoryMode = true;
      resolve(null);
    };
    request.onblocked = () => {
      // Another tab holds an old version open. Keep working in memory.
      memoryMode = true;
      resolve(null);
    };
  });
  return dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

async function runOnce(storeName, mode, fn) {
  const db = await openDb();
  if (!db) return fn(null);
  const tx = db.transaction(storeName, mode);
  const done = mode === 'readwrite' ? txDone(tx) : null;
  done?.catch(() => {}); // surfaced below; avoid an unhandled rejection if fn throws first
  const result = await fn(tx.objectStore(storeName));
  if (done) await done;
  return result;
}

async function withStore(storeName, mode, fn) {
  try {
    return await runOnce(storeName, mode, fn);
  } catch (err) {
    // Safari can drop the database connection (for example after the tab was in
    // the background). Reopen once and retry.
    if (err?.name === 'UnknownError' || err?.name === 'InvalidStateError') {
      try {
        (await dbPromise)?.close();
      } catch {
        /* ignore */
      }
      dbPromise = null;
      return runOnce(storeName, mode, fn);
    }
    throw err;
  }
}

/** True when recordings will survive a page reload. */
export async function isPersistent() {
  await openDb();
  return !memoryMode;
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersist() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* ignore */
  }
  return false;
}

export async function estimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch {
    /* ignore */
  }
  return { usage: 0, quota: 0 };
}

/** Friendly message for storage errors. */
export function storageErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'QuotaExceededError' || /quota/i.test(err?.message || '')) {
    return 'Your browser is out of space for recordings. Download the answers you want to keep, then delete old sessions.';
  }
  return 'This browser could not save the recording. You can still watch it now and download it.';
}

// ---------- Blob packing ----------
// Most browsers store Blobs in IndexedDB directly. A few (older Safari, some
// private modes) throw when cloning a Blob, so we fall back to an ArrayBuffer.

async function putWithBlob(storeName, record, blobField) {
  try {
    await withStore(storeName, 'readwrite', (store) => {
      if (!store) {
        memory[storeName].set(record.id ?? record.key, record);
        return null;
      }
      return promisify(store.put(record));
    });
  } catch (err) {
    const blob = record[blobField];
    if (!(blob instanceof Blob) || err?.name === 'QuotaExceededError') throw err;
    const buffer = await blob.arrayBuffer();
    const packed = { ...record, [blobField]: null, [`${blobField}Buffer`]: buffer, [`${blobField}Type`]: blob.type };
    await withStore(storeName, 'readwrite', (store) => promisify(store.put(packed)));
  }
}

function unpack(record, blobField) {
  if (!record) return record;
  if (!record[blobField] && record[`${blobField}Buffer`]) {
    return {
      ...record,
      [blobField]: new Blob([record[`${blobField}Buffer`]], { type: record[`${blobField}Type`] || '' }),
      [`${blobField}Buffer`]: undefined,
    };
  }
  return record;
}

// ---------- Sessions ----------

export async function saveSession(session) {
  const copy = JSON.parse(JSON.stringify(session));
  return withStore('sessions', 'readwrite', (store) => {
    if (!store) {
      memory.sessions.set(copy.id, copy);
      return null;
    }
    return promisify(store.put(copy));
  });
}

export async function getSession(id) {
  return withStore('sessions', 'readonly', (store) => {
    if (!store) return memory.sessions.get(id) || null;
    return promisify(store.get(id)).then((r) => r || null);
  });
}

export async function listSessions() {
  const all = await withStore('sessions', 'readonly', (store) => {
    if (!store) return [...memory.sessions.values()];
    return promisify(store.getAll());
  });
  return (all || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function deleteSession(id) {
  // Delete the recordings by key in one transaction, without reading the videos.
  await withStore('recordings', 'readwrite', async (store) => {
    if (!store) {
      for (const [key, rec] of memory.recordings) if (rec.sessionId === id) memory.recordings.delete(key);
      return null;
    }
    const keys = await promisify(store.index('sessionId').getAllKeys(id));
    return Promise.all(keys.map((key) => promisify(store.delete(key))));
  });
  return withStore('sessions', 'readwrite', (store) => {
    if (!store) {
      memory.sessions.delete(id);
      return null;
    }
    return promisify(store.delete(id));
  });
}

// ---------- Recordings ----------

/** rec: { id, sessionId, questionId, blob, mimeType, duration, createdAt } */
export async function saveRecording(rec) {
  return putWithBlob('recordings', rec, 'blob');
}

export async function getRecording(id) {
  const rec = await withStore('recordings', 'readonly', (store) => {
    if (!store) return memory.recordings.get(id) || null;
    return promisify(store.get(id)).then((r) => r || null);
  });
  return unpack(rec, 'blob');
}

export async function getRecordingsForSession(sessionId) {
  // Look up the keys through the index, then read each record directly: reading
  // Blobs through an index has crashed some Safari versions.
  const keys = await withStore('recordings', 'readonly', (store) => {
    if (!store) return [...memory.recordings.values()].filter((r) => r.sessionId === sessionId).map((r) => r.id);
    return promisify(store.index('sessionId').getAllKeys(sessionId));
  });
  const recs = [];
  for (const key of keys || []) {
    try {
      const rec = await getRecording(key);
      if (rec) recs.push(rec);
    } catch {
      /* one unreadable recording should not hide the others */
    }
  }
  return recs;
}

export async function deleteRecording(id) {
  return withStore('recordings', 'readwrite', (store) => {
    if (!store) {
      memory.recordings.delete(id);
      return null;
    }
    return promisify(store.delete(id));
  });
}

// ---------- Files (the job posting PDF) ----------

/** file: { key, name, type, size, blob, savedAt } */
export async function saveFile(key, blob, meta = {}) {
  const record = { key, blob, name: meta.name || 'file', type: blob.type, size: blob.size, savedAt: Date.now() };
  return putWithBlob('files', record, 'blob');
}

export async function getFile(key) {
  const rec = await withStore('files', 'readonly', (store) => {
    if (!store) return memory.files.get(key) || null;
    return promisify(store.get(key)).then((r) => r || null);
  });
  return unpack(rec, 'blob');
}

export async function deleteFile(key) {
  return withStore('files', 'readwrite', (store) => {
    if (!store) {
      memory.files.delete(key);
      return null;
    }
    return promisify(store.delete(key));
  });
}
