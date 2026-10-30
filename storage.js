// storage.js — the only module that talks to IndexedDB.
// Clean, promise-based interface so later features (sync to the box, a
// position-aware chat panel, a Telegram Mini App shell) can reuse it.

// DB schema 2 (app v4 / Phase 1): adds the `books` store (several books, each with
// its own audio `source`). Schema 1 databases are upgraded in place; nothing moves,
// because tracks, notes and progress were already keyed by bookId.
export const SCHEMA_VERSION = 2;
export const DB_NAME = 'audiobook-notes';
// The first book. Its id is what every schema-1 record already carries.
export const DEFAULT_BOOK = Object.freeze({
  id: 'healing-fragmented-selves',
  title: 'Healing the Fragmented Selves of Trauma Survivors',
  author: 'Janina Fisher',
  botUsername: 'Healingthefragbot',
});
export const BOOK = DEFAULT_BOOK; // back-compat alias (v3 code / tests)

// ---------- Telegram bot usernames (Phase 1: a t.me link only, never a token) ----------
// Accepts "name_bot", "@name_bot", "t.me/name_bot", "https://t.me/name_bot" (and telegram.me).
// Valid: 5-32 chars of [A-Za-z0-9_], ending in "bot" (any case), as Telegram requires.
export function normalizeBotUsername(input) {
  let v = String(input ?? '').trim();
  v = v.replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i, '').replace(/^@+/, '').replace(/[/?#].*$/, '');
  if (!v) return { ok: false, value: '', error: 'Enter the bot’s username, like Healingthefragbot.' };
  if (!/^[A-Za-z0-9_]+$/.test(v)) return { ok: false, value: v, error: 'Use only letters, numbers and _ .' };
  if (v.length < 5 || v.length > 32) return { ok: false, value: v, error: 'A bot username is 5 to 32 characters.' };
  if (!/bot$/i.test(v)) return { ok: false, value: v, error: 'A Telegram bot username ends in “bot”.' };
  return { ok: true, value: v, error: '' };
}
export const telegramUrl = (bot) => { const r = normalizeBotUsername(bot); return r.ok ? `https://t.me/${r.value}` : null; };
// Phase 2 keeps this shape: proxyUrl will point at a private Worker; null = guided Telegram -> Files flow.
export function telegramSource(botUsername) {
  const r = normalizeBotUsername(botUsername);
  return { type: 'telegram', botUsername: r.ok ? r.value : '', proxyUrl: null };
}
const BOOK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const isBookId = (id) => typeof id === 'string' && BOOK_ID_RE.test(id);
function seedBookRecord(ts) {
  return { id: DEFAULT_BOOK.id, title: DEFAULT_BOOK.title, author: DEFAULT_BOOK.author,
    source: telegramSource(DEFAULT_BOOK.botUsername), createdAt: ts, updatedAt: ts };
}

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
      if (e.oldVersion < 2) {
        // v1 -> v2: add books, seed the first book, make "last chapter" per book.
        // Existing tracks/notes/progress/voice/meta stay exactly where they are.
        const t = req.transaction, ts = new Date().toISOString();
        db.createObjectStore('books', { keyPath: 'id' }).put(seedBookRecord(ts));
        const meta = t.objectStore('meta');
        meta.put(DEFAULT_BOOK.id, 'currentBookId');
        meta.put(e.oldVersion, 'migratedFromSchema');
        const g = meta.get('lastTrackId');
        g.onsuccess = () => { if (typeof g.result === 'string') meta.put(g.result, `lastTrackId:${DEFAULT_BOOK.id}`); };
      }
      // Future migrations: if (e.oldVersion < 3) { ... }
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
// Last chapter is per book (`lastTrackId:<bookId>`). The schema-1 key `lastTrackId` is
// still read for the first book and kept in step, so nothing older is ever lost.
export async function getLastTrackId(bookId = DEFAULT_BOOK.id) {
  const v = await getMeta(`lastTrackId:${bookId}`);
  if (typeof v === 'string') return v;
  return bookId === DEFAULT_BOOK.id ? ((await getMeta('lastTrackId')) ?? null) : null;
}
export const setLastTrackId = (bookId, id) => tx('meta', 'readwrite', (t) => {
  t.objectStore('meta').put(id, `lastTrackId:${bookId}`);
  if (bookId === DEFAULT_BOOK.id) t.objectStore('meta').put(id, 'lastTrackId');
});

// ---------- books ----------
export async function listBooks() {
  const all = await tx('books', 'readonly', (t) => reqP(t.objectStore('books').getAll()));
  return all.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.title.localeCompare(b.title));
}
export const getBook = (id) => tx('books', 'readonly', (t) => reqP(t.objectStore('books').get(id)));
function slug(title) {
  return String(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'book';
}
function cleanTitle(t) { return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 200); }
// Adds a book. botUsername is optional ('' = no Telegram link yet); if given it must be valid.
export async function addBook({ title, author = '', botUsername = '' }) {
  const tt = cleanTitle(title);
  if (!tt) throw new Error('Give the book a title.');
  let source = { type: 'telegram', botUsername: '', proxyUrl: null };
  if (String(botUsername).trim()) { const r = normalizeBotUsername(botUsername); if (!r.ok) throw new Error(r.error); source = telegramSource(r.value); }
  const ts = nowIso();
  const book = { id: `${slug(tt)}-${uuid().slice(0, 6)}`, title: tt, author: cleanTitle(author), source, createdAt: ts, updatedAt: ts };
  await tx('books', 'readwrite', (t) => { t.objectStore('books').add(book); });
  emit('books-changed', { book });
  return book;
}
// Rename a book and/or change (add, switch, clear) its Telegram bot.
export async function updateBook(id, { title, author, botUsername } = {}) {
  const book = await tx('books', 'readwrite', async (t) => {
    const s = t.objectStore('books'); const cur = await reqP(s.get(id));
    if (!cur) throw new Error('Book not found');
    if (title !== undefined) { const tt = cleanTitle(title); if (!tt) throw new Error('Give the book a title.'); cur.title = tt; }
    if (author !== undefined) cur.author = cleanTitle(author);
    if (botUsername !== undefined) {
      if (String(botUsername).trim()) { const r = normalizeBotUsername(botUsername); if (!r.ok) throw new Error(r.error); cur.source = { ...(cur.source || {}), ...telegramSource(r.value), proxyUrl: cur.source?.proxyUrl ?? null }; }
      else cur.source = { ...(cur.source || {}), type: 'telegram', botUsername: '', proxyUrl: cur.source?.proxyUrl ?? null };
    }
    cur.updatedAt = nowIso(); s.put(cur); return cur;
  });
  emit('books-changed', { book });
  return book;
}
export const getCurrentBookId = () => getMeta('currentBookId');
export const setCurrentBookId = (id) => setMeta('currentBookId', id);

// ---------- tracks + audio ----------
export async function listTracks(bookId = DEFAULT_BOOK.id) {
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
export async function removeAllAudio(bookId = DEFAULT_BOOK.id) {
  const tracks = await listTracks(bookId);
  await tx('audio', 'readwrite', (t) => { for (const tr of tracks) t.objectStore('audio').delete(tr.id); });
  emit('tracks-changed', {});
}

// ---------- progress ----------
export const getProgress = (id) => tx('progress', 'readonly', (t) => reqP(t.objectStore('progress').get(id)));
export const allProgress = () => tx('progress', 'readonly', (t) => reqP(t.objectStore('progress').getAll()));
export const bookProgress = async (bookId) => (await allProgress()).filter((p) => typeof p.trackId === 'string' && p.trackId.startsWith(bookId + ':'));
export const setProgress = (id, positionSec, durationSec) => tx('progress', 'readwrite', (t) => {
  t.objectStore('progress').put({ trackId: id, positionSec, durationSec: durationSec || null, updatedAt: nowIso() });
});

// ---------- notes ----------
export async function listNotes(bookId = DEFAULT_BOOK.id) {
  const all = await tx('notes', 'readonly', (t) => reqP(t.objectStore('notes').index('byBook').getAll(bookId)));
  return all.sort((a, b) => a.trackIndex - b.trackIndex || a.positionSec - b.positionSec || a.createdAt.localeCompare(b.createdAt));
}
export const getNote = (id) => tx('notes', 'readonly', (t) => reqP(t.objectStore('notes').get(id)));

export async function addNote({ bookId = DEFAULT_BOOK.id, trackIndex, trackTitle, positionSec, text = '', audioBlobId = null }) {
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

// Undo for deleteNote: put the note (and its voice clip) back exactly as it was.
export async function restoreNote(note, voice = null) {
  await tx(['notes', 'voice'], 'readwrite', (t) => {
    if (voice && note.audioBlobId) t.objectStore('voice').put({ ...voice, id: note.audioBlobId });
    t.objectStore('notes').put(voice || !note.audioBlobId ? note : { ...note, audioBlobId: null });
  });
  emit('note-added', { note });
}

// Atomic create/update of a note plus its voice blob: either everything commits or nothing does.
export async function saveNoteAtomic({ id = null, bookId = DEFAULT_BOOK.id, trackIndex, trackTitle, positionSec, text = '', voice = null, keepVoiceId = null }) {
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

async function bookOrDefault(bookId) {
  const b = await getBook(bookId).catch(() => null);
  if (b) return b;
  return bookId === DEFAULT_BOOK.id ? seedBookRecord(nowIso()) : { id: bookId, title: 'Book', author: '', source: null };
}

export async function buildExport(bookId = DEFAULT_BOOK.id) {
  const book = await bookOrDefault(bookId);
  const notes = await listNotes(bookId);
  const exportedAt = nowIso();
  const json = {
    schemaVersion: SCHEMA_VERSION,
    app: 'audiobook-notes-pwa',
    bookId, bookTitle: book.title, author: book.author, exportedAt,
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
  let md = `# Notes: ${book.title}\n\n_${book.author ? book.author + ' · ' : ''}${notes.length} note${notes.length === 1 ? '' : 's'} · exported ${exportedAt}_\n`;
  let lastTrack = null;
  for (const n of notes) {
    if (n.trackIndex !== lastTrack) { md += `\n## ${n.trackIndex}. ${n.trackTitle}\n\n`; lastTrack = n.trackIndex; }
    const text = (n.text || '').trim().replace(/\n/g, '\n  ') || '_(voice note only)_';
    md += `- **[${formatTimestamp(n.positionSec)}]** ${text}${n.audioBlobId && n.text ? ' _(+ voice note)_' : ''}\n`;
  }
  return { json, markdown: md, count: notes.length };
}

// ---------- full backup / restore (H5) ----------
// A backup is everything except the MP3s themselves: every book (title, author and its
// audio `source`, never a token), its notes (+ voice clips as base64), listening progress,
// the chapter list (so re-added files land in the same slots), and settings.
// Import merges by id, newest wins, in one transaction.
//   backupVersion 1 (app v3): one book, top-level bookId/tracks/notes/progress/settings.
//   backupVersion 2 (app v4): `books: [{ book, tracks, notes, progress, lastTrackId }]`, shared `voice`.
// Both import, as does the notes-only JSON export (no `kind`).
export const BACKUP_KIND = 'backup';
export const BACKUP_VERSION = 2;
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
const TRACK_FIELDS = ({ id, bookId: b, trackIndex, title, album, artist, fileName, size, mime, durationSec, addedAt }) =>
  ({ id, bookId: b, trackIndex, title, album, artist, fileName, size, mime, durationSec, addedAt });
export async function buildBackup() {
  let books = await listBooks();
  if (!books.length) books = [seedBookRecord(nowIso())];
  const voice = {}, parts = [];
  for (const book of books) {
    const notes = await listNotes(book.id);
    for (const n of notes) {
      if (!n.audioBlobId) continue;
      const v = await getVoice(n.audioBlobId);
      if (v && v.blob) voice[n.audioBlobId] = { mime: v.mime || v.blob.type, durationSec: v.durationSec ?? null, createdAt: v.createdAt || null, size: v.blob.size, data: await blobToB64(v.blob) };
    }
    parts.push({
      book: { id: book.id, title: book.title, author: book.author || '', source: book.source ? { type: book.source.type, botUsername: book.source.botUsername || '', proxyUrl: book.source.proxyUrl ?? null } : null, createdAt: book.createdAt },
      tracks: (await listTracks(book.id)).map(TRACK_FIELDS), notes, progress: await bookProgress(book.id),
      lastTrackId: await getLastTrackId(book.id),
    });
  }
  const settings = {};
  for (const k of ['speed', 'textScale', 'currentBookId']) { const v = await getMeta(k); if (v !== undefined) settings[k] = v; }
  return { app: 'audiobook-notes-pwa', kind: BACKUP_KIND, backupVersion: BACKUP_VERSION, schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(), books: parts, voice, settings };
}

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : null);
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 10000 ? n : null; };
const posNum = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null; };
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

// Accepts a v2 or v1 full backup, or the notes-only JSON export (no voice/progress).
// Each book's data goes into that book (matched by id); an unknown book is created.
// A file without any book id (none were ever written) goes into `fallbackBookId`.
export async function importBackup(obj, { fallbackBookId = DEFAULT_BOOK.id } = {}) {
  if (!obj || typeof obj !== 'object' || obj.app !== 'audiobook-notes-pwa') throw new Error('This is not a Book Notes backup file');
  const full = obj.kind === BACKUP_KIND;
  if (!(Number(obj.schemaVersion ?? 1) <= SCHEMA_VERSION) || Number(obj.backupVersion ?? 1) > BACKUP_VERSION) throw new Error('This backup is from a newer version of the app');
  const ts = nowIso();
  // Normalise both layouts to a list of per-book parts.
  let raws;
  if (full && Array.isArray(obj.books)) raws = obj.books.filter((x) => x && typeof x === 'object').map((x) => ({ ...x, book: x.book && typeof x.book === 'object' ? x.book : {} }));
  else {
    const id = obj.bookId === undefined ? fallbackBookId : obj.bookId;
    raws = [{ book: { id, title: obj.bookTitle, author: obj.author }, tracks: obj.tracks, notes: obj.notes, progress: obj.progress,
      lastTrackId: obj.settings && typeof obj.settings === 'object' ? obj.settings.lastTrackId : null }];
  }
  const parts = [];
  let booksSkipped = 0;
  for (const raw of raws) {
    const bookId = raw.book.id;
    if (!isBookId(bookId)) { booksSkipped++; continue; }
    const rb = raw.book;
    const bot = rb.source && typeof rb.source === 'object' ? normalizeBotUsername(rb.source.botUsername) : { ok: false };
    const book = {
      id: bookId, title: cleanTitle(str(rb.title, 300) || '') || (bookId === DEFAULT_BOOK.id ? DEFAULT_BOOK.title : 'Imported book'),
      author: cleanTitle(str(rb.author, 300) || '') || (bookId === DEFAULT_BOOK.id ? DEFAULT_BOOK.author : ''),
      // Only a validated bot username survives; proxyUrl is not trusted from files (Phase 2 sets it in-app).
      source: { type: 'telegram', botUsername: bot.ok ? bot.value : (bookId === DEFAULT_BOOK.id && !rb.source ? DEFAULT_BOOK.botUsername : ''), proxyUrl: null },
      createdAt: iso(rb.createdAt) || ts, updatedAt: ts,
    };
    const notes = [];
    for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
      if (!n || typeof n !== 'object') continue;
      const id = str(n.id, 100), trackIndex = posInt(n.trackIndex), positionSec = posNum(n.positionSec);
      if (!id || trackIndex == null || positionSec == null) continue;
      notes.push({
        id, schemaVersion: SCHEMA_VERSION, bookId, trackIndex, trackTitle: str(full ? n.trackTitle : n.chapter, 300) || str(n.chapter, 300) || `Track ${trackIndex}`,
        positionSec: Math.round(positionSec * 10) / 10, text: str(n.text, 100000) || '',
        audioBlobId: full ? str(n.audioBlobId, 100) : null,
        createdAt: iso(n.createdAt) || ts, updatedAt: iso(n.updatedAt) || iso(n.createdAt) || ts,
        syncState: Object.values(SYNC).includes(n.syncState) ? n.syncState : SYNC.LOCAL,
      });
    }
    const tracks = [];
    for (const t of full && Array.isArray(raw.tracks) ? raw.tracks : []) {
      const trackIndex = posInt(t && t.trackIndex); if (trackIndex == null) continue;
      tracks.push({ id: trackId(bookId, trackIndex), bookId, trackIndex, title: str(t.title, 300) || `Track ${trackIndex}`,
        album: str(t.album, 300), artist: str(t.artist, 300), fileName: str(t.fileName, 500), size: posNum(t.size),
        mime: str(t.mime, 100), durationSec: posNum(t.durationSec), addedAt: iso(t.addedAt) || ts });
    }
    const re = new RegExp(`^${bookId}:\\d+$`);
    const progress = [];
    for (const p of full && Array.isArray(raw.progress) ? raw.progress : []) {
      const id = str(p && p.trackId, 200), pos = posNum(p && p.positionSec);
      if (!id || pos == null || !re.test(id)) continue;
      progress.push({ trackId: id, positionSec: pos, durationSec: posNum(p.durationSec), updatedAt: iso(p.updatedAt) || ts });
    }
    const last = full ? str(raw.lastTrackId, 200) : null;
    parts.push({ book, notes, tracks, progress, last: last && re.test(last) ? last : null });
  }
  if (!parts.length) throw new Error('This backup has no book this app can read');
  // Decode voice clips before the transaction (keeps the transaction short).
  const voice = new Map();
  for (const n of parts.flatMap((p) => p.notes)) {
    if (!n.audioBlobId) continue;
    const v = full && obj.voice && typeof obj.voice === 'object' && obj.voice[n.audioBlobId];
    if (!v || typeof v.data !== 'string') { n.audioBlobId = null; continue; }
    const mime = /^audio\/[\w.+-]+(;[\w=.,\s-]+)?$/i.test(v.mime || '') ? v.mime : 'audio/mp4';
    try { voice.set(n.audioBlobId, { id: n.audioBlobId, blob: b64ToBlob(v.data, mime), mime, durationSec: posNum(v.durationSec), createdAt: iso(v.createdAt) || n.createdAt }); }
    catch (_) { n.audioBlobId = null; }
  }
  const st = full && obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
  const res = { notes: 0, notesSkipped: 0, voice: 0, progress: 0, tracks: 0, settings: 0, booksAdded: 0, booksSkipped, bookIds: parts.map((p) => p.book.id) };
  await tx(['books', 'notes', 'voice', 'progress', 'tracks', 'meta'], 'readwrite', async (t) => {
    const bs = t.objectStore('books'), ns = t.objectStore('notes'), vs = t.objectStore('voice'), ps = t.objectStore('progress'), ts_ = t.objectStore('tracks'), ms = t.objectStore('meta');
    for (const part of parts) {
      const curBook = await reqP(bs.get(part.book.id));
      if (!curBook) { bs.put(part.book); res.booksAdded++; }
      else if (!curBook.source?.botUsername && part.book.source.botUsername) { bs.put({ ...curBook, source: { ...curBook.source, ...part.book.source, proxyUrl: curBook.source?.proxyUrl ?? null }, updatedAt: ts }); }
      for (const n of part.notes) {
        const cur = await reqP(ns.get(n.id));
        if (cur && cur.updatedAt >= n.updatedAt) { res.notesSkipped++; continue; } // local copy is as new or newer
        const v = n.audioBlobId && voice.get(n.audioBlobId);
        if (v) { vs.put(v); res.voice++; }
        if (cur && cur.audioBlobId && cur.audioBlobId !== n.audioBlobId) vs.delete(cur.audioBlobId);
        ns.put(n); res.notes++;
      }
      for (const tr of part.tracks) { if (!(await reqP(ts_.get(tr.id)))) { ts_.put(tr); res.tracks++; } }
      for (const p of part.progress) {
        const cur = await reqP(ps.get(p.trackId));
        if (!cur || !(cur.updatedAt >= p.updatedAt)) { ps.put(p); res.progress++; }
      }
      if (part.last && !(await reqP(ms.get(`lastTrackId:${part.book.id}`)))) {
        ms.put(part.last, `lastTrackId:${part.book.id}`);
        if (part.book.id === DEFAULT_BOOK.id) ms.put(part.last, 'lastTrackId');
        res.settings++;
      }
    }
    const speed = Number(st.speed);
    if (Number.isFinite(speed) && speed >= 0.5 && speed <= 3) { ms.put(speed, 'speed'); res.settings++; }
    const scale = Number(st.textScale);
    if (Number.isFinite(scale) && scale >= 0.8 && scale <= 1.5) { ms.put(scale, 'textScale'); res.settings++; }
  });
  emit('notes-imported', res); emit('tracks-changed', {}); emit('books-changed', {});
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
