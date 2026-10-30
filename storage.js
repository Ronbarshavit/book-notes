// storage.js — the only module that talks to IndexedDB.
// Clean, promise-based interface so later features (sync to the box, a
// position-aware chat panel, a Telegram Mini App shell) can reuse it.

export const SCHEMA_VERSION = 1;
export const DB_NAME = 'audiobook-notes';
export const BOOK = Object.freeze({
  id: 'healing-fragmented-selves',
  title: 'Healing the Fragmented Selves of Trauma Survivors',
  author: 'Janina Fisher',
});

// syncState values for notes:
//   'local'  – created on this device, never synced
//   'dirty'  – changed since the last successful sync
//   'synced' – matches the server copy (set by a future sync module)
export const SYNC = Object.freeze({ LOCAL: 'local', DIRTY: 'dirty', SYNCED: 'synced' });

let dbPromise = null;

// Forget the cached connection so the next call re-opens it. Needed after
// versionchange (another tab upgraded the schema), Safari's "connection to
// Indexed Database server lost", or a failed/blocked open.
function resetDb(db) {
  if (db) { try { db.close(); } catch (_) {} }
  dbPromise = null;
}

export function openDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, SCHEMA_VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('meta');                                   // key/value settings
        const tracks = db.createObjectStore('tracks', { keyPath: 'id' }); // track metadata
        tracks.createIndex('byBook', 'bookId');
        db.createObjectStore('audio');                                  // trackId -> Blob (the MP3)
        db.createObjectStore('progress', { keyPath: 'trackId' });       // resume positions
        const notes = db.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('byBook', 'bookId');
        notes.createIndex('byTrack', ['bookId', 'trackIndex']);
        notes.createIndex('bySync', 'syncState');
        db.createObjectStore('voice', { keyPath: 'id' });               // voice-note blobs
        db.createObjectStore('tombstones', { keyPath: 'id' });          // deleted note ids (for sync)
      }
      // Future migrations: if (e.oldVersion < 2) { ... }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { resetDb(db); emit('db-versionchange', {}); };
      db.onclose = () => { if (dbPromise === p) dbPromise = null; }; // closed by the browser
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // Don't reject: the open stays pending and succeeds once the other tab closes.
    req.onblocked = () => emit('db-blocked', {});
  });
  dbPromise = p;
  p.catch(() => { if (dbPromise === p) dbPromise = null; }); // allow a retry later
  return p;
}

function reqP(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function tx(stores, mode, fn, retry = true) {
  const db = await openDb();
  let t;
  try { t = db.transaction(stores, mode); }
  catch (e) {
    // Connection was closed under us (versionchange / Safari connection lost): reopen once.
    if (retry && e && e.name === 'InvalidStateError') { resetDb(db); emit('db-reopened', {}); return tx(stores, mode, fn, false); }
    throw e;
  }
  return new Promise((resolve, reject) => {
    let result, settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    t.oncomplete = () => { settled = true; resolve(result); };
    // t.error is still null while the request's error event is dispatched; use the request's error.
    t.onerror = (ev) => fail((ev && ev.target && ev.target.error) || t.error || new Error('IndexedDB request failed'));
    t.onabort = () => fail(t.error || new Error('Transaction aborted'));
    let r;
    try { r = fn(t); } catch (err) { try { t.abort(); } catch (_) {} fail(err); return; }
    Promise.resolve(r).then((v) => { result = v; }, (err) => { try { t.abort(); } catch (_) {} fail(err); });
  });
}

// ---------- change events (for UI now; sync/chat later) ----------
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type, detail) { for (const fn of listeners) { try { fn({ type, ...detail }); } catch (e) { console.error(e); } } }

// ---------- helpers ----------
export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const trackId = (bookId, trackIndex) => `${bookId}:${trackIndex}`;
const nowIso = () => new Date().toISOString();

// ---------- meta ----------
export const getMeta = (key) => tx('meta', 'readonly', (t) => reqP(t.objectStore('meta').get(key)));
export const setMeta = (key, value) => tx('meta', 'readwrite', (t) => { t.objectStore('meta').put(value, key); });

// ---------- tracks + audio ----------
export async function listTracks(bookId = BOOK.id) {
  const all = await tx('tracks', 'readonly', (t) => reqP(t.objectStore('tracks').index('byBook').getAll(bookId)));
  return all.sort((a, b) => a.trackIndex - b.trackIndex);
}
export async function putTrack(track, blob) {
  await tx(['tracks', 'audio'], 'readwrite', (t) => {
    t.objectStore('tracks').put(track);
    if (blob) t.objectStore('audio').put(blob, track.id);
  });
  emit('tracks-changed', { trackId: track.id });
}
export const updateTrack = (track) => tx('tracks', 'readwrite', (t) => { t.objectStore('tracks').put(track); });
export const getAudio = (id) => tx('audio', 'readonly', (t) => reqP(t.objectStore('audio').get(id)));
export const audioKeys = () => tx('audio', 'readonly', (t) => reqP(t.objectStore('audio').getAllKeys()));
export async function removeAllAudio(bookId = BOOK.id) {
  const tracks = await listTracks(bookId);
  await tx('audio', 'readwrite', (t) => { for (const tr of tracks) t.objectStore('audio').delete(tr.id); });
  emit('tracks-changed', {});
}

// ---------- progress ----------
export const getProgress = (id) => tx('progress', 'readonly', (t) => reqP(t.objectStore('progress').get(id)));
export const allProgress = () => tx('progress', 'readonly', (t) => reqP(t.objectStore('progress').getAll()));
export const setProgress = (id, positionSec, durationSec) => tx('progress', 'readwrite', (t) => {
  t.objectStore('progress').put({ trackId: id, positionSec, durationSec: durationSec || null, updatedAt: nowIso() });
});

// ---------- notes ----------
export async function listNotes(bookId = BOOK.id) {
  const all = await tx('notes', 'readonly', (t) => reqP(t.objectStore('notes').index('byBook').getAll(bookId)));
  return all.sort((a, b) => a.trackIndex - b.trackIndex || a.positionSec - b.positionSec || a.createdAt.localeCompare(b.createdAt));
}
export const getNote = (id) => tx('notes', 'readonly', (t) => reqP(t.objectStore('notes').get(id)));

export async function addNote({ bookId = BOOK.id, trackIndex, trackTitle, positionSec, text = '', audioBlobId = null }) {
  const ts = nowIso();
  const note = {
    id: uuid(), schemaVersion: SCHEMA_VERSION, bookId, trackIndex, trackTitle,
    positionSec: Math.max(0, Math.round(positionSec * 10) / 10),
    text, audioBlobId, createdAt: ts, updatedAt: ts, syncState: SYNC.LOCAL,
  };
  await tx('notes', 'readwrite', (t) => { t.objectStore('notes').put(note); });
  emit('note-added', { note });
  return note;
}

export async function updateNote(id, patch) {
  const note = await tx('notes', 'readwrite', async (t) => {
    const s = t.objectStore('notes');
    const cur = await reqP(s.get(id));
    if (!cur) throw new Error('Note not found');
    const allowed = ['text', 'audioBlobId', 'positionSec'];
    for (const k of allowed) if (k in patch) cur[k] = patch[k];
    cur.updatedAt = nowIso();
    if (cur.syncState === SYNC.SYNCED) cur.syncState = SYNC.DIRTY;
    s.put(cur);
    return cur;
  });
  emit('note-updated', { note });
  return note;
}

export async function deleteNote(id) {
  // Read and delete in one transaction so a concurrent edit can't orphan a voice blob.
  const gone = await tx(['notes', 'voice', 'tombstones'], 'readwrite', async (t) => {
    const note = await reqP(t.objectStore('notes').get(id));
    if (!note) return false;
    t.objectStore('notes').delete(id);
    if (note.audioBlobId) t.objectStore('voice').delete(note.audioBlobId);
    // Only notes that ever reached the server need a tombstone.
    if (note.syncState !== SYNC.LOCAL) t.objectStore('tombstones').put({ id, bookId: note.bookId, deletedAt: nowIso() });
    return true;
  });
  if (gone) emit('note-deleted', { id });
}

// Atomic create/update of a note plus its voice blob: either everything commits or nothing does.
export async function saveNoteAtomic({ id = null, bookId = BOOK.id, trackIndex, trackTitle, positionSec, text = '', voice = null, keepVoiceId = null }) {
  const ts = nowIso();
  const pos = Math.max(0, Math.round(positionSec * 10) / 10);
  const note = await tx(['notes', 'voice'], 'readwrite', async (t) => {
    const notes = t.objectStore('notes'), voices = t.objectStore('voice');
    let cur = id ? await reqP(notes.get(id)) : null;
    if (id && !cur) throw new Error('Note not found');
    let audioBlobId = keepVoiceId;
    if (voice) { audioBlobId = uuid(); voices.put({ id: audioBlobId, blob: voice.blob, mime: voice.mime || voice.blob.type, durationSec: voice.durationSec ?? null, createdAt: ts }); }
    if (cur && cur.audioBlobId && cur.audioBlobId !== audioBlobId) voices.delete(cur.audioBlobId);
    cur = cur
      ? { ...cur, text, audioBlobId, positionSec: pos, updatedAt: ts, syncState: cur.syncState === SYNC.SYNCED ? SYNC.DIRTY : cur.syncState }
      : { id: uuid(), schemaVersion: SCHEMA_VERSION, bookId, trackIndex, trackTitle, positionSec: pos, text, audioBlobId, createdAt: ts, updatedAt: ts, syncState: SYNC.LOCAL };
    notes.put(cur);
    return cur;
  });
  emit(id ? 'note-updated' : 'note-added', { note });
  return note;
}

// ---------- voice blobs ----------
export async function putVoice(blob, mime, durationSec = null) {
  const id = uuid();
  await tx('voice', 'readwrite', (t) => { t.objectStore('voice').put({ id, blob, mime: mime || blob.type, durationSec, createdAt: nowIso() }); });
  return id;
}
export const getVoice = (id) => tx('voice', 'readonly', (t) => reqP(t.objectStore('voice').get(id)));
export const deleteVoice = (id) => tx('voice', 'readwrite', (t) => { t.objectStore('voice').delete(id); });

// ---------- export ----------
export function formatTimestamp(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export async function buildExport(bookId = BOOK.id) {
  const notes = await listNotes(bookId);
  const exportedAt = nowIso();
  const json = {
    schemaVersion: SCHEMA_VERSION,
    app: 'audiobook-notes-pwa',
    bookId, bookTitle: BOOK.title, author: BOOK.author, exportedAt,
    notes: notes.map((n) => ({
      id: n.id,
      chapter: n.trackTitle,
      trackIndex: n.trackIndex,
      timestamp: formatTimestamp(n.positionSec),
      positionSec: n.positionSec,
      text: n.text,
      hasVoiceNote: !!n.audioBlobId,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    })),
  };
  let md = `# Notes: ${BOOK.title}\n\n_${BOOK.author} · ${notes.length} note${notes.length === 1 ? '' : 's'} · exported ${exportedAt}_\n`;
  let lastTrack = null;
  for (const n of notes) {
    if (n.trackIndex !== lastTrack) { md += `\n## ${n.trackIndex}. ${n.trackTitle}\n\n`; lastTrack = n.trackIndex; }
    const text = (n.text || '').trim().replace(/\n/g, '\n  ') || '_(voice note only)_';
    md += `- **[${formatTimestamp(n.positionSec)}]** ${text}${n.audioBlobId && n.text ? ' _(+ voice note)_' : ''}\n`;
  }
  return { json, markdown: md, count: notes.length };
}

// ---------- full backup / restore (H5) ----------
// A backup is everything except the MP3s themselves: notes (+ voice clips as base64),
// listening progress, the chapter list (so re-added files land in the same slots),
// and settings. Import merges by id, newest wins, in one transaction.
export const BACKUP_KIND = 'backup';
export const BACKUP_VERSION = 1;
const SETTING_KEYS = ['speed', 'textScale', 'lastTrackId'];
async function blobToB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBlob(b64, type) {
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type });
}
export async function buildBackup(bookId = BOOK.id) {
  const notes = await listNotes(bookId);
  const tracks = await listTracks(bookId);
  const progress = (await allProgress()).filter((p) => typeof p.trackId === 'string' && p.trackId.startsWith(bookId + ':'));
  const voice = {};
  for (const n of notes) {
    if (!n.audioBlobId) continue;
    const v = await getVoice(n.audioBlobId);
    if (v && v.blob) voice[n.audioBlobId] = { mime: v.mime || v.blob.type, durationSec: v.durationSec ?? null, createdAt: v.createdAt || null, size: v.blob.size, data: await blobToB64(v.blob) };
  }
  const settings = {};
  for (const k of SETTING_KEYS) { const v = await getMeta(k); if (v !== undefined) settings[k] = v; }
  return {
    app: 'audiobook-notes-pwa', kind: BACKUP_KIND, backupVersion: BACKUP_VERSION, schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(), bookId, bookTitle: BOOK.title, author: BOOK.author,
    tracks: tracks.map(({ id, bookId: b, trackIndex, title, album, artist, fileName, size, mime, durationSec, addedAt }) =>
      ({ id, bookId: b, trackIndex, title, album, artist, fileName, size, mime, durationSec, addedAt })),
    notes, voice, progress, settings,
  };
}

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : null);
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 10000 ? n : null; };
const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null; };
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

// Accepts a full backup or the older notes-only JSON export (no voice/progress).
export async function importBackup(obj) {
  if (!obj || typeof obj !== 'object' || obj.app !== 'audiobook-notes-pwa') throw new Error('This is not a Book Notes backup file');
  const full = obj.kind === BACKUP_KIND;
  if (!(Number(obj.schemaVersion) <= SCHEMA_VERSION)) throw new Error('This backup is from a newer version of the app');
  if ((obj.bookId || BOOK.id) !== BOOK.id) throw new Error('This backup is for a different book');
  const bookId = BOOK.id, ts = nowIso();
  const notes = [];
  for (const raw of Array.isArray(obj.notes) ? obj.notes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = str(raw.id, 100), trackIndex = posInt(raw.trackIndex), positionSec = posNum(raw.positionSec);
    if (!id || trackIndex == null || positionSec == null) continue;
    notes.push({
      id, schemaVersion: SCHEMA_VERSION, bookId, trackIndex, trackTitle: str(full ? raw.trackTitle : raw.chapter, 300) || `Track ${trackIndex}`,
      positionSec: Math.round(positionSec * 10) / 10, text: str(raw.text, 100000) || '',
      audioBlobId: full ? str(raw.audioBlobId, 100) : null,
      createdAt: iso(raw.createdAt) || ts, updatedAt: iso(raw.updatedAt) || iso(raw.createdAt) || ts,
      syncState: Object.values(SYNC).includes(raw.syncState) ? raw.syncState : SYNC.LOCAL,
    });
  }
  // Decode voice clips before the transaction (keeps the transaction short).
  const voice = new Map();
  if (full && obj.voice && typeof obj.voice === 'object') {
    for (const n of notes) {
      const v = n.audioBlobId && obj.voice[n.audioBlobId];
      if (!v || typeof v.data !== 'string') { n.audioBlobId = null; continue; }
      const mime = /^audio\/[\w.+-]+(;[\w=.,\s-]+)?$/i.test(v.mime || '') ? v.mime : 'audio/mp4';
      try { voice.set(n.audioBlobId, { id: n.audioBlobId, blob: b64ToBlob(v.data, mime), mime, durationSec: posNum(v.durationSec), createdAt: iso(v.createdAt) || n.createdAt }); }
      catch (_) { n.audioBlobId = null; }
    }
  }
  const tracks = [];
  for (const raw of full && Array.isArray(obj.tracks) ? obj.tracks : []) {
    const trackIndex = posInt(raw && raw.trackIndex); if (trackIndex == null) continue;
    tracks.push({ id: trackId(bookId, trackIndex), bookId, trackIndex, title: str(raw.title, 300) || `Track ${trackIndex}`,
      album: str(raw.album, 300), artist: str(raw.artist, 300), fileName: str(raw.fileName, 500), size: posNum(raw.size),
      mime: str(raw.mime, 100), durationSec: posNum(raw.durationSec), addedAt: iso(raw.addedAt) || ts });
  }
  const progress = [];
  for (const raw of full && Array.isArray(obj.progress) ? obj.progress : []) {
    const id = str(raw && raw.trackId, 200), pos = posNum(raw && raw.positionSec);
    if (!id || pos == null || !new RegExp(`^${bookId}:\\d+$`).test(id)) continue;
    progress.push({ trackId: id, positionSec: pos, durationSec: posNum(raw.durationSec), updatedAt: iso(raw.updatedAt) || ts });
  }
  const st = full && obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
  const res = { notes: 0, notesSkipped: 0, voice: 0, progress: 0, tracks: 0, settings: 0 };
  await tx(['notes', 'voice', 'progress', 'tracks', 'meta'], 'readwrite', async (t) => {
    const ns = t.objectStore('notes'), vs = t.objectStore('voice'), ps = t.objectStore('progress'), ts_ = t.objectStore('tracks'), ms = t.objectStore('meta');
    for (const n of notes) {
      const cur = await reqP(ns.get(n.id));
      if (cur && cur.updatedAt >= n.updatedAt) { res.notesSkipped++; continue; } // local copy is as new or newer
      const v = n.audioBlobId && voice.get(n.audioBlobId);
      if (v) { vs.put(v); res.voice++; }
      if (cur && cur.audioBlobId && cur.audioBlobId !== n.audioBlobId) vs.delete(cur.audioBlobId);
      ns.put(n); res.notes++;
    }
    for (const tr of tracks) { if (!(await reqP(ts_.get(tr.id)))) { ts_.put(tr); res.tracks++; } }
    for (const p of progress) {
      const cur = await reqP(ps.get(p.trackId));
      if (!cur || !(cur.updatedAt >= p.updatedAt)) { ps.put(p); res.progress++; }
    }
    const speed = Number(st.speed);
    if (Number.isFinite(speed) && speed >= 0.5 && speed <= 3) { ms.put(speed, 'speed'); res.settings++; }
    const scale = Number(st.textScale);
    if (Number.isFinite(scale) && scale >= 0.8 && scale <= 1.5) { ms.put(scale, 'textScale'); res.settings++; }
    const last = str(st.lastTrackId, 200);
    if (last && new RegExp(`^${bookId}:\\d+$`).test(last) && !(await reqP(ms.get('lastTrackId')))) { ms.put(last, 'lastTrackId'); res.settings++; }
  });
  emit('notes-imported', res); emit('tracks-changed', {});
  return res;
}

// ---------- unsaved-draft voice clip (survives reload / app kill) ----------
export const setDraftVoice = (v) => tx('meta', 'readwrite', (t) => { t.objectStore('meta').put(v, 'draftVoice'); });
export const getDraftVoice = () => getMeta('draftVoice');
export const clearDraftVoice = () => tx('meta', 'readwrite', (t) => { t.objectStore('meta').delete('draftVoice'); });

// ---------- storage persistence ----------
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return null;
  try { if (await navigator.storage.persisted()) return true; return await navigator.storage.persist(); } catch (_) { return null; }
}
export async function storageInfo() {
  const out = { persisted: null, usage: null, quota: null };
  try { if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted(); } catch (_) {}
  try { if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } } catch (_) {}
  return out;
}
