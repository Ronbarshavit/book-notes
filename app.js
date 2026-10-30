// app.js — UI + player. All persistence goes through storage.js.
// v4 (Phase 1): one Listen screen with sheets, several books, a per-book Telegram bot (username only, never a token).
import * as store from './storage.js';
import { parseId3, parseFilename, compareFilenames } from './id3.js';

const { DEFAULT_BOOK, formatTimestamp: fmt } = store;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const audio = $('#audio');
const SPEED_MIN = 0.8, SPEED_MAX = 2, SPEED_STEP = 0.05;
const SKIP_SEC = 15;               // transport and lock screen both skip 15 s
const LEAD_IN_SEC = 3;             // S5: jumping to a note starts a little earlier
const TEXT_SCALES = [0.9, 1, 1.15, 1.3];
const DRAFT_KEY = 'abn-note-draft'; // M2: in-progress note survives reloads and app kills
const BACKUP_NUDGE_AT = 10;        // remind to back up after this many un-backed-up notes
// What the first book's Telegram bot delivers (shown on the source sheet; other books show no numbers).
const KNOWN_SIZES = { [DEFAULT_BOOK.id]: { chapters: 20, mb: 372 } };
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

const state = {
  bookId: DEFAULT_BOOK.id, book: null, books: [],
  tracks: [], missing: new Set(), progress: new Map(), notes: [],
  current: null, objectUrl: null, loadToken: 0, restoring: false,
  speed: 1, lastSaved: 0, note: null, rec: null,
  expectPause: false, importing: false, firstImport: false, leftLoading: false,
  notesById: new Map(), textScale: 1, notesScope: 'chapter', editingBook: null, voiceDurs: new Map(), recStarting: false,
};
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) window.__abn = { state, store }; // L7: debug/test hook, dev hosts only

// ---------------- utilities ----------------
let toastTimer = 0, toastActionFn = null;
function toast(msg, ms = 2400, action = null) {
  const t = $('#toast'), b = $('#toast-action');
  $('#toast-msg').textContent = msg;
  toastActionFn = action ? action.fn : null;
  b.hidden = !action; t.classList.toggle('has-action', !!action);
  if (action) b.textContent = action.label;
  t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').hidden = true; toastActionFn = null; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const trackById = (id) => state.tracks.find((t) => t.id === id);
const dur = () => (isFinite(audio.duration) ? audio.duration : (state.current?.durationSec || 0));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const botOf = (book) => book?.source?.botUsername || '';
function once(el, ev, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); }, bad = () => { cleanup(); rej(el.error || new Error(ev + ' failed')); };
    const timer = setTimeout(() => { cleanup(); rej(new Error('timeout waiting for ' + ev)); }, timeoutMs);
    function cleanup() { clearTimeout(timer); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); }
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });
}

// ---------------- sheets ----------------
const anySheetOpen = () => $$('.sheet-backdrop').some((s) => !s.hidden);
function openPanel(id) { const el = $('#' + id); el.hidden = false; const p = $('.sheet', el); if (p) p.scrollTop = 0; syncViewport(); }
function closePanel(id) { $('#' + id).hidden = true; if (!anySheetOpen() && pendingWorker) reofferUpdate(); }

// ---------------- screens ----------------
// One Listen screen. Before any chapter is stored the staged first run shows instead.
function renderScreens() {
  const firstRun = !state.tracks.length || (state.firstImport && !state.leftLoading);
  $('#first-run').hidden = !firstRun;
  $('#listen').hidden = firstRun;
  $('#dock').hidden = firstRun;
  document.body.classList.toggle('has-dock', !firstRun);
  if (firstRun) {
    const loading = state.firstImport;
    const gate = isIOS && !isStandalone && sessionStorage.getItem('abn-continue-safari') !== '1';
    $('#install-card').hidden = loading || !gate;
    $('#fr-actions').hidden = loading;
    $('#btn-get-book').disabled = gate;
    $('#btn-get-book').classList.toggle('is-disabled', gate);
    $('#fr-get-hint').hidden = !gate;
  } else renderTip();
  syncViewport();
}
async function renderTip() {
  const shown = await store.getMeta('tipShown').catch(() => true);
  $('#first-tip').hidden = !!shown || !state.tracks.length;
}
function dismissTip() { $('#first-tip').hidden = true; store.setMeta('tipShown', true).catch(() => {}); }

// M1/M3: keep layout in step with the *visible* viewport (Safari toolbars, keyboard).
function syncViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  const root = document.documentElement.style;
  root.setProperty('--vvh', Math.round(h) + 'px');
  root.setProperty('--topbar-h', $('.topbar').offsetHeight + 'px');
  const top = vv ? Math.max(0, vv.offsetTop) : 0;
  for (const el of $$('.sheet-backdrop')) el.style.top = top + 'px';
  root.setProperty('--vv-top', top + 'px');
  const kb = vv ? (window.innerHeight - vv.height) > 120 : false;
  $('#note-sheet-panel').classList.toggle('kb', kb);
  if (!$('#note-sheet').hidden) keepSaveVisible();
}
function keepSaveVisible() {
  const panel = $('#note-sheet-panel'), save = $('#btn-note-save');
  const r = save.getBoundingClientRect(), vvh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (r.top < 0 || r.bottom > vvh) panel.scrollTop = 0;
}

// ---------------- books ----------------
async function loadBooks() {
  state.books = await store.listBooks();
  state.book = state.books.find((b) => b.id === state.bookId) || (await store.getBook(state.bookId)) || null;
}
function renderBook() {
  const b = state.book || DEFAULT_BOOK;
  const bot = botOf(b);
  $('#book-title').textContent = b.title;
  $('#fr-title').textContent = b.title;
  document.title = 'Book Notes · ' + b.title;
  $('#row-book-val').textContent = b.title + (state.books.length > 1 ? ` · ${state.books.length} books ›` : ' ›');
  $('#row-bot-val').textContent = bot ? '@' + bot + ' ›' : 'Not set ›';
  // Source sheet: the guided Telegram flow follows this book's bot.
  const url = bot ? store.telegramUrl(bot) : null;
  const link = $('#btn-open-telegram');
  if (url) link.href = url; else link.removeAttribute('href');
  link.closest('li').hidden = !url;
  $('#src-bot-name').textContent = url ? '@' + bot : '';
  $('#src-no-bot').hidden = !!url;
  const k = KNOWN_SIZES[b.id];
  $('#source-sub').textContent = k ? `${k.chapters} chapters · about ${k.mb} MB · stays on this iPhone` : 'Your MP3s stay on this iPhone.';
}
async function renderBooks() {
  const counts = await Promise.all(state.books.map((b) => store.listTracks(b.id).then((t) => t.length).catch(() => 0)));
  $('#book-list').innerHTML = state.books.map((b, i) => {
    const cur = b.id === state.bookId; const bot = botOf(b);
    return `<li><button type="button" class="book-row${cur ? ' current' : ''}" data-book="${esc(b.id)}" aria-current="${cur}">
      <span class="bt">${cur ? '✓ ' : ''}${esc(b.title)}</span>
      <span class="bm">${counts[i] ? plural(counts[i], 'chapter') : 'No chapters yet'}${bot ? ' · @' + esc(bot) : ''}</span></button></li>`;
  }).join('');
}
async function switchBook(id) {
  if (state.note) { toast('Save or cancel your note first'); return false; }
  if (id === state.bookId) return true;
  if (!(await store.getBook(id))) { toast('Book not found'); return false; }
  await savePosition();
  pauseAudio(); audio.removeAttribute('src'); audio.load();
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  state.current = null; state.loadToken++;
  clearMediaMetadata(); // NICE 2: the lock screen must not keep the previous book's chapter
  state.bookId = id; state.notesScope = 'chapter';
  await store.setCurrentBookId(id);
  await loadBooks();
  await openCurrentBook();
  return true;
}
// Loads the current book's chapters, notes and last position into the UI.
async function openCurrentBook() {
  renderBook();
  await refreshLibrary();
  await refreshNotes();
  const last = await store.getLastTrackId(state.bookId);
  if (last && trackById(last) && !state.missing.has(last)) await loadTrack(last, { autoplay: false });
  else renderPlayer();
  renderScreens();
  renderBackupNudge();
}

// Book editor: add a book, or rename it / change its Telegram bot.
function openBookEditor(mode, focusBot = false) {
  if (state.note) { toast('Save or cancel your note first'); return; }
  state.editingBook = mode === 'add' ? { mode: 'add' } : { mode: 'edit', id: state.bookId };
  const b = mode === 'add' ? null : state.book;
  $('#book-sheet-title').textContent = mode === 'add' ? 'Add a book' : 'Edit book';
  $('#btn-book-save').textContent = mode === 'add' ? 'Add' : 'Save';
  $('#book-title-input').value = b ? b.title : '';
  $('#bot-input').value = b ? botOf(b) : '';
  validateBookForm();
  openPanel('book-sheet');
  const f = focusBot ? $('#bot-input') : $('#book-title-input');
  try { f.focus({ preventScroll: true }); } catch (_) { f.focus(); }
}
function validateBookForm() {
  const raw = $('#bot-input').value, title = $('#book-title-input').value.trim();
  const msg = $('#bot-msg'), prev = $('#bot-preview'), inp = $('#bot-input');
  let botOk = true;
  if (!raw.trim()) {
    msg.textContent = 'Optional. The bot that sends you this book\u2019s MP3s. Only its public username is kept.';
    msg.classList.remove('bad'); inp.removeAttribute('aria-invalid'); prev.hidden = true;
  } else {
    const r = store.normalizeBotUsername(raw);
    botOk = r.ok;
    if (r.ok) {
      const url = store.telegramUrl(r.value);
      msg.textContent = `✓ “Open in Telegram” will go to @${r.value}`; msg.classList.remove('bad');
      inp.removeAttribute('aria-invalid'); prev.hidden = false; prev.href = url; prev.textContent = url.replace('https://', '');
    } else {
      msg.textContent = r.error; msg.classList.add('bad'); inp.setAttribute('aria-invalid', 'true'); prev.hidden = true;
    }
  }
  $('#btn-book-save').disabled = !botOk || !title;
  return botOk && !!title;
}
async function saveBookForm() {
  if (!validateBookForm()) return;
  const e = state.editingBook; if (!e) return;
  const title = $('#book-title-input').value, botUsername = $('#bot-input').value;
  try {
    if (e.mode === 'add') {
      const b = await store.addBook({ title, botUsername });
      state.editingBook = null; closePanel('book-sheet'); closePanel('books-sheet'); closePanel('more-sheet');
      await switchBook(b.id);
      toast(`Added “${b.title}”. Get its chapters to start.`, 3500);
    } else {
      const b = await store.updateBook(e.id, { title, botUsername });
      state.editingBook = null; closePanel('book-sheet');
      await loadBooks(); renderBook(); renderBooks(); updateMediaMetadata();
      toast(botOf(b) ? `Saved · Telegram: @${botOf(b)}` : 'Saved', 2500);
    }
  } catch (err) { toast(String(err?.message || err), 4000); }
}

// ---------------- library ----------------
async function refreshLibrary() {
  const [tracks, keys, progress] = await Promise.all([store.listTracks(state.bookId), store.audioKeys(), store.bookProgress(state.bookId)]);
  const have = new Set(keys);
  state.tracks = tracks;
  state.missing = new Set(tracks.filter((t) => !have.has(t.id)).map((t) => t.id));
  state.progress = new Map(progress.map((p) => [p.trackId, p]));
  renderLibrary();
}

function renderLibrary() {
  const nMissing = state.missing.size;
  $('#missing-banner').hidden = nMissing === 0;
  if (nMissing) {
    $('#missing-text').textContent = nMissing === state.tracks.length
      ? `All ${nMissing} audio files are gone from this device (iOS can clear website storage). Your notes are safe. Add the MP3s again to keep listening.`
      : `${nMissing} of ${state.tracks.length} chapters need their file again. Your notes are safe.`;
  }
  // "Finish getting the book (n of 20)" when we know how many chapters the bot sends.
  const k = KNOWN_SIZES[state.bookId];
  const have = state.tracks.length;
  $('#btn-finish').hidden = !(k && have > 0 && have < k.chapters && !nMissing && !state.importing);
  if (k) $('#finish-count').textContent = `${have} of ${k.chapters}`;
  const counts = noteCountsByChapter();
  $('#track-list').innerHTML = state.tracks.map((t) => {
    const p = state.progress.get(t.id); const d = t.durationSec || p?.durationSec || 0;
    const pct = d && p ? clamp(Math.round((p.positionSec / d) * 100), 0, 100) : 0;
    const missing = state.missing.has(t.id);
    const cur = state.current?.id === t.id;
    const n = counts.get(t.trackIndex) || 0;
    return `<li><button type="button" class="track${cur ? ' current' : ''}${missing ? ' missing' : ''}" data-track="${esc(t.id)}"${cur ? ' aria-current="true"' : ''}>
      <span class="track-no">${t.trackIndex}</span>
      <span><span class="track-title">${cur ? '▶ ' : ''}${esc(t.title)}</span>
      <span class="track-meta">${missing ? '<span class="tag-missing">file missing</span>' : ''}${d ? `<span>${fmt(d)}</span>` : ''}${pct ? `<span class="bar"><i data-pct="${pct}"></i></span><span>${pct}%</span>` : ''}</span></span>
      <span class="track-notes">${n ? `📝 ${n}` : ''}</span>
    </button></li>`;
  }).join('');
  for (const i of $$('#track-list .bar > i[data-pct]')) i.style.width = i.dataset.pct + '%'; // CSSOM is CSP-safe
}

async function probeDuration(blob) {
  const a = new Audio(); a.preload = 'metadata';
  const url = URL.createObjectURL(blob); a.src = url;
  try { await once(a, 'loadedmetadata', 8000); return isFinite(a.duration) ? Math.round(a.duration * 10) / 10 : null; }
  catch (_) { return null; } finally { a.removeAttribute('src'); a.load(); URL.revokeObjectURL(url); }
}

function setImporting(on) {
  state.importing = on;
  for (const inp of $$('.file-input')) { inp.disabled = on; inp.closest('label')?.classList.toggle('is-disabled', on); }
}
const MB = (b) => (b / 1048576).toFixed(0);
async function addFiles(fileList) {
  if (state.importing) return;
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|m4b|aac|mp4)$/i.test(f.name));
  if (!files.length) { toast('No audio files were selected'); return; }
  const bookId = state.bookId;
  closePanel('source-sheet'); closePanel('more-sheet'); closePanel('chapters-sheet');
  setImporting(true);
  state.firstImport = state.tracks.length === 0; state.leftLoading = false;
  renderScreens();
  const prog = $('#import-progress'), line = $('#import-line'), bar = $('#import-bar'), sub = $('#import-sub');
  prog.hidden = false; prog.classList.remove('warn'); $('#btn-start-first').hidden = true;
  sub.textContent = 'Keep Book Notes open until it finishes.';
  const total = files.reduce((a, f) => a + f.size, 0) || 1;
  let added = 0; const failed = [];
  try {
    const persisted = await store.requestPersistence();
    if (persisted === false) console.info('navigator.storage.persist() was not granted');
    const parsed = [];
    for (const [i, f] of files.entries()) {
      line.textContent = `Reading ${i + 1} of ${files.length}…`; bar.value = 0;
      let tags = {}; try { tags = await parseId3(f); } catch (_) {}
      parsed.push({ file: f, tags, fn: parseFilename(f.name) });
    }
    const nums = parsed.map((p) => p.tags.trackNo).filter((n) => n > 0);
    const useId3 = nums.length === parsed.length && new Set(nums).size === nums.length;
    if (useId3) parsed.sort((a, b) => a.tags.trackNo - b.tags.trackNo);
    else parsed.sort((a, b) => compareFilenames(a.file.name, b.file.name));
    const byFileName = new Map(state.tracks.map((t) => [t.fileName, t]));
    const byTitle = new Map(state.tracks.map((t) => [t.title, t]));
    const usedIdx = new Set(state.tracks.map((t) => t.trackIndex));
    let nextIdx = Math.max(0, ...usedIdx) + 1;
    let done = 0, quota = false, privateMode = false;
    for (const [i, p] of parsed.entries()) {
      line.textContent = `Chapter ${i + 1} of ${parsed.length} · ${MB(done)} / ${MB(total)} MB`;
      bar.value = done / total;
      if (quota || privateMode) { failed.push(p.file.name); continue; }
      try {
        const title = p.tags.title || p.fn.title;
        const existing = byFileName.get(p.file.name) || byTitle.get(title);
        // Never let a new, unmatched file take over an existing chapter's slot (and its notes).
        let trackIndex;
        if (existing) trackIndex = existing.trackIndex;
        else if (useId3 && !usedIdx.has(p.tags.trackNo)) trackIndex = p.tags.trackNo;
        else trackIndex = nextIdx++;
        usedIdx.add(trackIndex); nextIdx = Math.max(nextIdx, trackIndex + 1);
        // Copy bytes so the blob survives iOS deleting the picker's temp file (M3: kept on purpose).
        // Files are written one at a time and the ArrayBuffer is not retained past this iteration.
        const blob = new Blob([await p.file.arrayBuffer()], { type: p.file.type || 'audio/mpeg' });
        const durationSec = await probeDuration(blob);
        await store.putTrack({
          id: store.trackId(bookId, trackIndex), bookId, trackIndex, title,
          album: p.tags.album || null, artist: p.tags.artist || null,
          fileName: p.file.name, size: p.file.size, mime: blob.type, durationSec, addedAt: new Date().toISOString(),
        }, blob);
        added++;
        // Loading view: as soon as one chapter is stored the listener may start.
        if (state.firstImport && bookId === state.bookId) {
          await refreshLibrary();
          if (!state.leftLoading) $('#btn-start-first').hidden = false;
        }
      } catch (e) {
        console.error(e); failed.push(p.file.name);
        if (e && e.name === 'QuotaExceededError') quota = true;
        // M7: Safari Private Browsing refuses to store Blobs in IndexedDB.
        if (e && /preparing Blob|BlobURLs are not yet supported/i.test(e.message || '')) privateMode = true;
      }
      done += p.file.size; bar.value = done / total;
    }
    $('#btn-start-first').hidden = true;
    if (failed.length) {
      prog.classList.add('warn');
      line.textContent = `Saved ${added} of ${parsed.length} files`;
      sub.textContent = privateMode
        ? 'Safari Private Browsing can’t store audio files. Open this page in a normal (non-private) Safari tab, or from the Home Screen app, and add the files there.'
        : (quota ? 'Not enough storage space. ' : '') + 'Not saved: ' + failed.join(', ') + '. Add them again to retry.';
    } else prog.hidden = true;
  } finally { setImporting(false); state.firstImport = false; }
  if (bookId !== state.bookId) return; // the user switched books mid-import; that book's list is fresh on return
  await refreshLibrary();
  updateStorageInfo();
  toast(failed.length ? `Saved ${added} of ${added + failed.length} files` : `Added ${plural(added, 'chapter')}`, failed.length ? 5000 : 2000);
  if (!state.current && state.tracks.length) {
    const last = await store.getLastTrackId(state.bookId);
    const first = (last && trackById(last) && !state.missing.has(last)) ? last : state.tracks.find((t) => !state.missing.has(t.id))?.id;
    if (first) await loadTrack(first, { autoplay: false });
  } else renderPlayer();
  renderScreens();
}
async function startDuringImport() {
  state.leftLoading = true; $('#btn-start-first').hidden = true;
  renderScreens();
  const first = state.tracks.find((t) => !state.missing.has(t.id));
  if (first) await loadTrack(first.id, { autoplay: true });
}

async function updateStorageInfo() {
  const i = await store.storageInfo();
  const mb = (b) => (b / 1048576).toFixed(0) + ' MB';
  const parts = [];
  if (i.usage != null) parts.push(`Using ${mb(i.usage)}${i.quota ? ` of ~${mb(i.quota)}` : ''}.`);
  parts.push(i.persisted ? 'Storage is persistent.' : 'Storage is not marked persistent; add this app to your Home Screen so iOS keeps the files.');
  $('#storage-info').textContent = parts.join(' ');
}

// ---------------- player ----------------
// M6: iOS can invalidate a blob: URL (memory pressure, long background). Reload the
// chapter from IndexedDB once at the saved position; if that fails too, say so.
let audioErrRetry = { id: null, at: 0 };
async function onAudioError() {
  const t = state.current;
  if (!t || !audio.getAttribute('src') || state.restoring) return;
  const code = audio.error ? audio.error.code : 0;
  const pos = audio.currentTime || state.progress.get(t.id)?.positionSec || 0;
  if (audioErrRetry.id === t.id && Date.now() - audioErrRetry.at < 15000) {
    pauseAudio(); renderPlayer();
    toast(code === 4 ? 'This chapter can’t be played. The file may be damaged; add it again from ⋯ More.' : 'This chapter can’t be played right now. Add it again from ⋯ More.', 6000);
    return;
  }
  audioErrRetry = { id: t.id, at: Date.now() };
  console.warn('audio error, reloading from storage', code);
  const ok = await loadTrack(t.id, { position: pos, autoplay: false });
  if (ok) toast('Playback was interrupted. Reloaded the chapter; tap play to continue.', 4000);
}

async function loadTrack(id, { position = null, autoplay = false } = {}) {
  const t = trackById(id);
  if (!t) return false;
  if (state.current && state.current.id !== id) await savePosition();
  const token = ++state.loadToken;
  const blob = await store.getAudio(id);
  if (token !== state.loadToken) return false;
  state.current = t;
  if (!blob) {
    // Stop the previous chapter so its audio can't be saved/stamped under this chapter's id.
    pauseAudio(); audio.removeAttribute('src'); audio.load();
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    state.missing.add(id); renderPlayer(); renderLibrary(); toast('This chapter’s file is missing. Add it again from ⋯ More.'); return false;
  }
  state.restoring = true;
  if (!audio.paused) state.expectPause = true;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(blob);
  audio.src = state.objectUrl;
  const saved = await store.getProgress(id);
  try { await once(audio, 'loadedmetadata'); } catch (e) { state.restoring = false; toast('Could not open this file'); return false; }
  if (token !== state.loadToken) return false;
  if (!t.durationSec && isFinite(audio.duration)) { t.durationSec = Math.round(audio.duration * 10) / 10; store.updateTrack(t); }
  let pos = position ?? (saved?.positionSec || 0);
  if (position == null && audio.duration && pos >= audio.duration - 2) pos = 0; // finished → start over
  audio.currentTime = clamp(pos, 0, Math.max(0, (audio.duration || pos) - 0.5));
  audio.defaultPlaybackRate = state.speed; audio.playbackRate = state.speed;
  state.restoring = false;
  store.setLastTrackId(t.bookId || state.bookId, id);
  updateMediaMetadata();
  renderPlayer(); renderLibrary();
  if (autoplay) await play();
  return true;
}

async function play() {
  if (!state.current) { toast('Choose a chapter first'); openChapters(); return; }
  if (!audio.src) { await loadTrack(state.current.id, { autoplay: true }); return; }
  audio.playbackRate = state.speed;
  try { await audio.play(); } catch (e) { console.warn('play() rejected', e); toast('Tap play to start'); }
}
function pauseAudio() { if (!audio.paused) state.expectPause = true; audio.pause(); }
function togglePlay() { if (audio.paused) play(); else pauseAudio(); }
function showInterrupt(on) { $('#interrupt-hint').hidden = !on; }
function setAudioSession(type) { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) {} }
function skip(sec) {
  if (!state.current || !audio.src) return;
  audio.currentTime = clamp(audio.currentTime + sec, 0, dur() || 0);
  renderTime(); updatePositionState();
}
function setSpeed(v) {
  state.speed = clamp(Math.round(v / SPEED_STEP) * SPEED_STEP, SPEED_MIN, SPEED_MAX);
  state.speed = Math.round(state.speed * 100) / 100;
  audio.defaultPlaybackRate = state.speed; audio.playbackRate = state.speed;
  store.setMeta('speed', state.speed);
  renderSpeed(); renderTime(); updatePositionState();
}

async function savePosition() {
  if (!state.current || state.restoring || !audio.src || !isFinite(audio.currentTime)) return;
  state.lastSaved = Date.now();
  const p = { trackId: state.current.id, positionSec: Math.round(audio.currentTime * 10) / 10, durationSec: dur() || null };
  state.progress.set(p.trackId, p);
  try { await store.setProgress(p.trackId, p.positionSec, p.durationSec); } catch (e) { console.warn(e); }
}

function renderSpeed() {
  const s = state.speed.toFixed(2) + '×';
  $('#speed-val').textContent = s; $('#speed-btn-val').textContent = s; $('#speed-row-val').textContent = s;
  $('#speed-pill').hidden = Math.abs(state.speed - 1) < 0.001; // the pill only appears when speed ≠ 1
  for (const b of $$('#speed-presets button')) b.setAttribute('aria-pressed', String(Math.abs(+b.dataset.speed - state.speed) < 0.001));
}
function renderTime() {
  const d = dur(), c = audio.src ? audio.currentTime : 0;
  const sc = $('#scrubber');
  if (!sc.matches(':active')) { sc.max = String(Math.floor(d)); sc.value = String(Math.floor(c)); }
  sc.style.setProperty('--pct', (d ? clamp((+sc.value / Math.floor(d)) * 100, 0, 100) : 0).toFixed(2) + '%');
  $('#t-cur').textContent = fmt(c);
  // Time left is real listening time at the current speed.
  $('#t-left').textContent = '-' + fmt(Math.max(0, d - c) / (state.speed || 1));
  $('#note-at').textContent = 'at ' + fmt(c);
}
function renderPlayer() {
  const t = state.current;
  if (t) {
    const i = state.tracks.findIndex((x) => x.id === t.id);
    $('#now-index').textContent = `Chapter ${i + 1} of ${state.tracks.length}${state.missing.has(t.id) ? ' · file missing' : ''} ▾`;
    $('#now-title').textContent = t.title;
  } else {
    $('#now-index').textContent = state.tracks.length ? `${plural(state.tracks.length, 'chapter')} ▾` : 'No chapters yet';
    $('#now-title').textContent = state.tracks.length ? 'Pick a chapter' : 'Get the book to start';
  }
  const playing = !audio.paused;
  $('#ico-play').toggleAttribute('hidden', playing); $('#ico-pause').toggleAttribute('hidden', !playing);
  $('#btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  renderTime(); renderSpeed(); renderChip();
}

// ---------------- Media Session (lock screen) ----------------
function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || !state.current) return;
  const art = (p, s) => ({ src: new URL(p, location.href).href, sizes: s, type: 'image/png' });
  const b = state.book || DEFAULT_BOOK;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.current.title, artist: state.current.artist || b.author || '', album: b.title,
    artwork: [art('icons/icon-192.png', '192x192'), art('icons/icon-512.png', '512x512')],
  });
  updatePositionState();
}
function clearMediaMetadata() {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; } catch (_) {}
  try { navigator.mediaSession.setPositionState?.(); } catch (_) {}
}
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = dur();
  if (!d || !isFinite(audio.currentTime)) return;
  try { navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: clamp(audio.currentTime, 0, d) }); } catch (_) {}
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    // S7: lock-screen/AirPods play while a new note is open keeps the book paused; Save resumes.
    play: () => { if (state.note?.mode === 'new') { state.note.wasPlaying = true; toast('Finish the note first. Save resumes playback.', 3000); return; } play(); },
    pause: () => pauseAudio(), stop: () => pauseAudio(),
    seekbackward: (d) => skip(-(d.seekOffset || SKIP_SEC)),
    seekforward: (d) => skip(d.seekOffset || SKIP_SEC), // v4: 15/15, same as the in-app transport
    seekto: (d) => { if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime); else audio.currentTime = d.seekTime; updatePositionState(); },
    // previoustrack/nexttrack deliberately NOT set: on iOS that would replace the
    // lock-screen skip buttons, which are more useful for an audiobook.
  };
  for (const [a, fn] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(a, fn); } catch (_) {} }
}

// ---------------- note sheet (＋ Note / 🎙 Speak) ----------------
const voiceSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
const VOICE_MIMES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
function pickVoiceMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return VOICE_MIMES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
}
function blankNote(extra) {
  return { voiceBlob: null, voiceMime: null, voiceDur: null, existingVoiceId: null, removeVoice: false, origText: '', voiceMode: false, bookId: state.bookId, ...extra };
}
// M3: everything up to focus()/getUserMedia runs synchronously inside the tap, so iOS raises the keyboard / mic prompt.
function openNewNote({ voice = false } = {}) {
  if (!state.current || !audio.src) { toast('Start a chapter first'); return; }
  if (state.note) return;
  if (voice && !voiceSupported) { toast('Voice notes aren’t supported in this browser. Type instead.', 3500); voice = false; }
  dismissTip();
  const wasPlaying = !audio.paused;
  pauseAudio();
  const positionSec = Math.round(audio.currentTime * 10) / 10;
  state.note = blankNote({ mode: 'new', wasPlaying, voiceMode: voice, track: { trackIndex: state.current.trackIndex, title: state.current.title }, positionSec });
  openSheet('');
  if (voice) toggleRecording();
}
function openEditNote(id) {
  const n = state.notesById.get(id); if (!n || state.note) return;
  state.note = blankNote({ mode: 'edit', id, bookId: n.bookId, wasPlaying: false, track: { trackIndex: n.trackIndex, title: n.trackTitle }, positionSec: n.positionSec,
    existingVoiceId: n.audioBlobId, origText: n.text || '' });
  openSheet(n.text);
  if (n.audioBlobId) store.getVoice(n.audioBlobId).then((v) => { if (v && state.note?.id === id && !state.note.voiceBlob && !state.note.removeVoice) showVoicePreview(v.blob); });
}
function renderStamp() {
  const n = state.note;
  $('#sheet-stamp').innerHTML = `Note at <b>${fmt(n.positionSec)}</b> · ${esc(n.track.title)}`;
}
function setVoiceMode(on) {
  if (state.note) state.note.voiceMode = on;
  $('#note-sheet-panel').classList.toggle('voice-mode', on);
}
function openSheet(text) {
  const n = state.note;
  $('#sheet-title').textContent = n.mode === 'edit' ? 'Edit note' : (n.voiceMode ? 'Voice note' : 'New note');
  $('#btn-note-save').textContent = n.mode === 'new' && n.wasPlaying ? 'Save & resume ▶' : 'Save';
  $('#btn-note-delete').hidden = n.mode !== 'edit';
  renderStamp();
  const ta = $('#note-text');
  ta.value = text || '';
  hideVoicePreview();
  $('#btn-rec').hidden = !voiceSupported; $('#voice-unsupported').hidden = voiceSupported;
  showRecUI(false);
  setVoiceMode(!!n.voiceMode);
  $('#note-sheet').hidden = false;
  $('#note-sheet-panel').scrollTop = 0;
  if (!n.voiceMode) { try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); } }
  syncViewport();
}
function closeSheet() {
  stopRecording(true);
  $('#note-sheet').hidden = true;
  hideVoicePreview(); setVoiceMode(false);
  const resume = state.note?.wasPlaying; state.note = null;
  if (pendingWorker && !anySheetOpen()) reofferUpdate();
  return resume;
}
// ---- M2: draft autosave + undoable cancel
function saveDraft() {
  const n = state.note; if (!n) return;
  const text = $('#note-text').value;
  try {
    if (!text.trim() && !n.voiceBlob && !n.removeVoice) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 2, bookId: n.bookId, mode: n.mode, id: n.id || null, track: n.track, positionSec: n.positionSec,
      existingVoiceId: n.existingVoiceId || null, origText: n.origText || '', text, hasVoice: !!n.voiceBlob, removeVoice: !!n.removeVoice, savedAt: Date.now() }));
  } catch (_) {}
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (_) {} store.clearDraftVoice().catch(() => {}); }
// The unsaved voice clip lives in IndexedDB (too big for localStorage) so it survives a reload too.
function persistDraftVoice() {
  const n = state.note; if (!n) return;
  saveDraft();
  if (n.voiceBlob) store.setDraftVoice({ blob: n.voiceBlob, mime: n.voiceMime, durationSec: n.voiceDur ?? null }).catch((e) => console.warn('draft voice not saved', e));
  else store.clearDraftVoice().catch(() => {});
}
function loadDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return null; } }
function draftDirty() {
  const n = state.note; if (!n) return false;
  const text = $('#note-text').value.trim();
  return !!(n.voiceBlob || n.removeVoice || (n.mode === 'new' ? text : text !== (n.origText || '').trim()));
}
async function cancelNote() {
  const n = state.note; if (!n) return;
  if (state.rec) await stopRecording(false); // keep the recording so Undo can bring it back
  const snap = draftDirty() ? { note: { ...n, voiceMode: false }, text: $('#note-text').value } : null;
  clearDraft();
  const resume = closeSheet();
  if (resume) play();
  if (snap) toast('Note discarded', 6000, { label: 'Undo', fn: () => reopenDraft(snap) });
}
function reopenDraft(snap) {
  if (state.note) return;
  const n = snap.note;
  if (n.bookId !== state.bookId) { toast('That note belongs to another book'); return; }
  if (n.mode === 'new') { n.wasPlaying = !audio.paused; pauseAudio(); }
  state.note = n;
  openSheet(snap.text);
  if (n.voiceBlob) showVoicePreview(n.voiceBlob);
  persistDraftVoice();
}
async function restoreDraftOnBoot() {
  const d = loadDraft(); if (!d || !d.track) return;
  let v = null;
  if (d.hasVoice) { try { v = await store.getDraftVoice(); } catch (_) {} }
  if (!d.text && !(v && v.blob) && !d.removeVoice) { clearDraft(); return; }
  if (state.note) return;
  // v1 drafts (before books) belong to the first book.
  const bookId = d.bookId && (await store.getBook(d.bookId)) ? d.bookId : DEFAULT_BOOK.id;
  if (bookId !== state.bookId) { const prev = state.note; await switchBook(bookId); if (prev) return; }
  state.note = blankNote({ mode: d.mode === 'edit' ? 'edit' : 'new', id: d.id, bookId, wasPlaying: false, track: d.track, positionSec: d.positionSec,
    existingVoiceId: d.existingVoiceId, origText: d.origText || '' });
  if (d.removeVoice) state.note.removeVoice = true;
  openSheet(d.text || '');
  if (v && v.blob) {
    Object.assign(state.note, { voiceBlob: v.blob, voiceMime: v.mime || v.blob.type, voiceDur: v.durationSec ?? null, removeVoice: false });
    showVoicePreview(v.blob);
  }
  toast(v && v.blob ? 'Restored your unsaved note and voice clip' : 'Restored your unsaved note', 3000);
}
function nudge(sec) {
  const n = state.note; if (!n) return;
  const max = state.current && n.track.trackIndex === state.current.trackIndex ? dur() : Infinity;
  n.positionSec = clamp(Math.round((n.positionSec + sec) * 10) / 10, 0, max || Infinity);
  renderStamp(); saveDraft();
}

let voiceUrl = null;
function showVoicePreview(blob) {
  if (voiceUrl) URL.revokeObjectURL(voiceUrl);
  voiceUrl = URL.createObjectURL(blob);
  $('#voice-audio').src = voiceUrl; $('#voice-preview').hidden = false; $('#btn-rec').hidden = true;
}
function hideVoicePreview() {
  const a = $('#voice-audio'); a.pause(); a.removeAttribute('src');
  if (voiceUrl) { URL.revokeObjectURL(voiceUrl); voiceUrl = null; }
  $('#voice-preview').hidden = true; if (voiceSupported) $('#btn-rec').hidden = false;
}
function showRecUI(on) {
  $('#rec-panel').hidden = !on;
  $('#note-sheet-panel').classList.toggle('is-recording', on);
  $('#btn-rec').classList.toggle('recording', on);
  $('#rec-label').textContent = on ? '■ Stop recording' : '🎙 Speak instead';
  if (on) $('#rec-time').textContent = '0:00';
}
// A live level meter so the listener can see the mic is hearing them.
let meter = null;
function startMeter(stream) {
  stopMeter();
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  try {
    const ctx = new AC(); const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser();
    an.fftSize = 512; src.connect(an);
    const buf = new Uint8Array(an.fftSize); const bar = $('#rec-level');
    const m = meter = { ctx, raf: 0 };
    const tick = () => {
      if (meter !== m) return;
      an.getByteTimeDomainData(buf);
      let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x - 128));
      const lvl = Math.min(1, peak / 64);
      bar.style.transform = `scaleX(${Math.max(0.03, lvl).toFixed(3)})`;
      bar.dataset.level = lvl.toFixed(2);
      m.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { console.warn('meter unavailable', e); }
}
function stopMeter() {
  if (!meter) return;
  cancelAnimationFrame(meter.raf); meter.ctx.close().catch(() => {}); meter = null;
  $('#rec-level').style.transform = 'scaleX(0.03)';
}

async function toggleRecording() {
  if (state.rec) { stopRecording(false); return; }
  if (state.recStarting) return;
  state.recStarting = true;
  let stream;
  setAudioSession('play-and-record'); // S11
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) {
    setAudioSession('playback'); state.recStarting = false;
    toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied. You can type the note instead.' : 'Microphone unavailable: ' + e.message, 4000);
    if (state.note?.voiceMode) { setVoiceMode(false); $('#sheet-title').textContent = 'New note'; const ta = $('#note-text'); try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); } }
    return;
  }
  state.recStarting = false;
  const stopStream = () => { stream.getTracks().forEach((t) => t.stop()); setAudioSession('playback'); };
  if (!state.note || state.rec) { stopStream(); return; } // L3: sheet closed while the permission prompt was up
  const mime = pickVoiceMime();
  let rec;
  try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (_) {
    try { rec = new MediaRecorder(stream); }
    catch (e) { stopStream(); toast('Recording isn’t supported here: ' + e.message, 4000); return; } // L3: don't leak the mic
  }
  const chunks = []; const started = Date.now();
  const r = state.rec = { rec, stream, chunks, started, discard: false, timer: 0, resolve: null };
  r.done = new Promise((res) => { r.resolve = res; });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(r.timer);
    setAudioSession('playback'); // S11: leave play-and-record routing
    try {
      if (r.discard || !state.note) return;
      const type = rec.mimeType || mime || chunks[0]?.type || 'audio/mp4';
      const blob = new Blob(chunks, { type });
      if (!blob.size) { toast('Nothing was recorded'); return; }
      Object.assign(state.note, { voiceBlob: blob, voiceMime: type, voiceDur: Math.round((Date.now() - started) / 100) / 10, removeVoice: false });
      showVoicePreview(blob);
      persistDraftVoice();
    } finally { r.resolve(); }
  };
  rec.start();
  showRecUI(true); startMeter(stream);
  r.timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $('#rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 600) stopRecording(false); // 10 min cap
  }, 250);
}
// Resolves when the recorder has really stopped and the blob is attached (no fixed delay).
function stopRecording(discard) {
  const r = state.rec; if (!r) return Promise.resolve();
  state.rec = null; r.discard = discard;
  try { if (r.rec.state !== 'inactive') r.rec.stop(); else { r.stream.getTracks().forEach((t) => t.stop()); r.resolve(); } } catch (_) { r.resolve(); }
  stopMeter(); showRecUI(false);
  if (!discard && state.note?.voiceMode) setVoiceMode(false); // the text box appears so a few words can be added
  return Promise.race([r.done, new Promise((res) => setTimeout(res, 3000))]); // safety net only
}

async function saveNote() {
  const n = state.note; if (!n) return;
  const btn = $('#btn-note-save'); if (btn.disabled) return;
  btn.disabled = true; $('#btn-voice-done').disabled = true;
  try {
    if (state.rec) await stopRecording(false);
    const text = $('#note-text').value.trim();
    const keepsOldVoice = n.existingVoiceId && !n.removeVoice && !n.voiceBlob;
    if (!text && !n.voiceBlob && !keepsOldVoice) { toast('Type a note or record a voice note'); return; }
    const exists = n.mode !== 'new' && !!(await store.getNote(n.id));
    // One transaction for note + voice: either everything commits or nothing does.
    await store.saveNoteAtomic({
      id: exists ? n.id : null, bookId: n.bookId, trackIndex: n.track.trackIndex, trackTitle: n.track.title,
      positionSec: n.positionSec, text,
      voice: n.voiceBlob ? { blob: n.voiceBlob, mime: n.voiceMime, durationSec: n.voiceDur } : null,
      keepVoiceId: keepsOldVoice ? n.existingVoiceId : null,
    });
  } catch (e) {
    console.error(e);
    // Keep the sheet (and the draft) so nothing typed or recorded is lost.
    toast(e?.name === 'QuotaExceededError' ? 'Storage is full. Note NOT saved.' : 'Note NOT saved: ' + String(e?.message ?? e), 7000);
    return;
  } finally { btn.disabled = false; $('#btn-voice-done').disabled = false; }
  clearDraft();
  const at = fmt(n.positionSec), voiceOnly = !!n.voiceBlob && !$('#note-text').value.trim();
  const resume = closeSheet();
  toast(`${voiceOnly ? 'Voice note' : 'Note'} saved at ${at}`);
  await refreshNotes();
  if (resume) play();
}
async function deleteFromSheet() {
  const n = state.note; if (!n || n.mode !== 'edit') return;
  const note = await store.getNote(n.id);
  const voice = note?.audioBlobId ? await store.getVoice(note.audioBlobId) : null;
  clearDraft(); closeSheet();
  if (!note) { await refreshNotes(); return; }
  await store.deleteNote(note.id);
  await refreshNotes();
  toast('Note deleted', 6000, { label: 'Undo', fn: async () => { await store.restoreNote(note, voice); await refreshNotes(); toast('Note restored'); } });
}

// ---------------- notes (chip + sheet) ----------------
function noteCountsByChapter() {
  const m = new Map(); for (const n of state.notes) m.set(n.trackIndex, (m.get(n.trackIndex) || 0) + 1); return m;
}
async function refreshNotes() {
  state.notes = await store.listNotes(state.bookId);
  state.notesById = new Map(state.notes.map((n) => [n.id, n]));
  // Voice clip lengths for the ▶ m:ss chips (read once per refresh; clips stay in IndexedDB).
  const ids = state.notes.map((n) => n.audioBlobId).filter((id) => id && !state.voiceDurs.has(id));
  for (const id of ids) { try { const v = await store.getVoice(id); state.voiceDurs.set(id, v?.durationSec || null); } catch (_) {} }
  renderChip();
  if (!$('#notes-sheet').hidden) renderNotes();
  if (!$('#chapters-sheet').hidden) renderLibrary();
  renderBackupNudge();
}
function renderChip() {
  const t = state.current;
  const here = t ? state.notes.filter((n) => n.trackIndex === t.trackIndex) : [];
  let txt;
  if (!state.notes.length) txt = 'No notes yet · tap ＋ Note while listening';
  else if (!here.length) txt = `No notes in this chapter · ${plural(state.notes.length, 'note')} in the book`;
  else {
    const last = here.reduce((a, b) => ((b.createdAt || '') > (a.createdAt || '') ? b : a));
    txt = `${plural(here.length, 'note')} in this chapter · last at ${fmt(last.positionSec)}`;
  }
  $('#chip-text').textContent = txt;
}
function noteRow(n) {
  const vd = n.audioBlobId ? state.voiceDurs.get(n.audioBlobId) : null;
  return `<article class="note" data-note="${esc(n.id)}">
    <button type="button" class="ts" data-jump="${esc(n.id)}" aria-label="Play from ${fmt(n.positionSec)}, starting ${LEAD_IN_SEC} seconds earlier"><span aria-hidden="true">▶</span><span class="ts-time">${fmt(n.positionSec)}</span></button>
    <button type="button" class="note-text${n.text ? '' : ' voice-only'}" data-edit="${esc(n.id)}" aria-label="Edit note">${n.text ? esc(n.text) : 'Voice note · tap to add text'}</button>
    ${n.audioBlobId ? `<button type="button" class="voice-chip" data-voice="${esc(n.audioBlobId)}" aria-label="Play voice note"><span aria-hidden="true">🎧</span> ${vd ? fmt(vd) : 'Voice'}</button>` : ''}
  </article>`;
}
function renderNotes() {
  const t = state.current;
  const here = t ? state.notes.filter((n) => n.trackIndex === t.trackIndex) : [];
  if (!t) state.notesScope = 'all';
  const scope = state.notesScope;
  $('#seg-chapter').textContent = `This chapter (${here.length})`;
  $('#seg-all').textContent = `All chapters (${state.notes.length})`;
  $('#seg-chapter').setAttribute('aria-selected', String(scope === 'chapter'));
  $('#seg-all').setAttribute('aria-selected', String(scope === 'all'));
  $('#seg-chapter').disabled = !t;
  const list = scope === 'chapter' ? here : state.notes;
  $('#notes-empty').hidden = list.length > 0;
  $('#notes-empty').textContent = scope === 'chapter' && state.notes.length ? 'No notes in this chapter yet.' : 'No notes yet. Tap ＋ Note while listening.';
  $('#notes-help').hidden = !list.length;
  $('#btn-export-md').disabled = !state.notes.length;
  if (scope === 'chapter') { $('#notes-list').innerHTML = list.map(noteRow).join(''); return; }
  const groups = new Map();
  for (const n of list) { if (!groups.has(n.trackIndex)) groups.set(n.trackIndex, { title: n.trackTitle, items: [] }); groups.get(n.trackIndex).items.push(n); }
  $('#notes-list').innerHTML = [...groups.entries()].map(([idx, g]) => `
    <section class="note-group" data-track-index="${idx}"><h3>${idx}. ${esc(g.title)}</h3>${g.items.map(noteRow).join('')}</section>`).join('');
}
function openNotes() { renderNotes(); openPanel('notes-sheet'); }
function openChapters() { renderLibrary(); openPanel('chapters-sheet'); const c = $('#track-list .current'); if (c) c.scrollIntoView({ block: 'center' }); }
async function jumpToNote(id) {
  const n = state.notesById.get(id) || await store.getNote(id); if (!n) return;
  const tid = store.trackId(n.bookId, n.trackIndex);
  const target = Math.max(0, n.positionSec - LEAD_IN_SEC);
  if (!trackById(tid) || state.missing.has(tid)) { toast('Re-add this chapter’s file to jump there', 3500); return; }
  closePanel('notes-sheet');
  if (state.current?.id === tid && audio.src) { audio.currentTime = target; renderTime(); updatePositionState(); await play(); }
  else await loadTrack(tid, { position: target, autoplay: true });
}
let voicePlayer = null;
async function playVoice(blobId, btn) {
  const icon = btn.querySelector('span[aria-hidden]');
  const setPlaying = on => { btn.classList.toggle('is-playing', on); if (icon) icon.textContent = on ? '❚❚' : '🎧'; btn.setAttribute('aria-label', on ? 'Pause voice note' : 'Play voice note'); };
  if (voicePlayer && !voicePlayer.paused) { voicePlayer.pause(); document.querySelectorAll('.voice-chip.is-playing').forEach(b => { b.classList.remove('is-playing'); const i = b.querySelector('span[aria-hidden]'); if (i) i.textContent = '🎧'; b.setAttribute('aria-label', 'Play voice note'); }); if (voicePlayer.dataset.blob === blobId) return; }
  const v = await store.getVoice(blobId); if (!v) { toast('Voice note not found'); return; }
  pauseAudio();
  voicePlayer = voicePlayer || new Audio();
  if (voicePlayer.dataset.url) URL.revokeObjectURL(voicePlayer.dataset.url);
  voicePlayer.dataset.url = voicePlayer.src = URL.createObjectURL(v.blob);
  voicePlayer.dataset.blob = blobId;
  voicePlayer.onended = () => setPlaying(false);
  setPlaying(true);
  try { await voicePlayer.play(); } catch (e) { toast('Could not play voice note'); setPlaying(false); }
}

async function loadSettings() {
  const sp = Number(await store.getMeta('speed'));
  state.speed = Number.isFinite(sp) && sp > 0 ? clamp(sp, SPEED_MIN, SPEED_MAX) : 1;
  const ts = Number(await store.getMeta('textScale'));
  applyTextScale(TEXT_SCALES.includes(ts) ? ts : 1);
}

// ---------------- full backup / restore (H5) ----------------
async function deliverFile(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  } catch (e) { if (e && e.name === 'AbortError') return false; console.warn('share failed, falling back to download', e); }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
async function backupAll() {
  const btns = [$('#btn-backup'), $('#btn-backup-nudge')]; for (const b of btns) b.disabled = true;
  try {
    if (state.current) await savePosition();
    const b = await store.buildBackup();
    const blob = new Blob([JSON.stringify(b)], { type: 'application/json' });
    const ok = await deliverFile(blob, `book-notes-backup-${stamp()}.json`);
    if (!ok) return;
    await store.setMeta('lastBackupAt', b.exportedAt);
    await store.setMeta('backupNudgeLater', 0);
    renderBackupInfo(); renderBackupNudge();
    const notes = b.books.reduce((a, x) => a + x.notes.length, 0), pos = b.books.reduce((a, x) => a + x.progress.length, 0);
    toast(`Backed up ${plural(b.books.length, 'book')}, ${notes} notes, ${Object.keys(b.voice).length} voice clips and ${pos} positions`, 3500);
  } catch (e) { console.error(e); toast('Backup failed: ' + (e.message || e), 5000); }
  finally { for (const b of btns) b.disabled = false; }
}
async function restoreBackup(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch (_) { toast('That file isn’t a Book Notes backup (not valid JSON).', 5000); return; }
  try {
    closePanel('more-sheet'); closePanel('source-sheet');
    const r = await store.importBackup(obj, { fallbackBookId: state.bookId });
    await loadSettings(); renderSpeed();
    await loadBooks();
    // On a fresh install, open the restored book rather than an empty one.
    if (!state.tracks.length && !state.notes.length && r.bookIds?.length && !r.bookIds.includes(state.bookId)) await switchBook(r.bookIds[0]);
    else {
      renderBook(); await refreshLibrary(); await refreshNotes();
      if (!state.current) {
        const last = await store.getLastTrackId(state.bookId);
        if (last && trackById(last) && !state.missing.has(last)) await loadTrack(last, { autoplay: false });
        else renderPlayer();
      }
      renderScreens();
    }
    updateStorageInfo();
    const extra = r.notesSkipped ? ` (${r.notesSkipped} already up to date)` : '';
    const books = r.booksAdded ? ` · ${plural(r.booksAdded, 'book')} added` : '';
    toast(`Restored ${r.notes} notes, ${r.voice} voice clips, ${r.progress} positions${extra}${books}`, 5000);
  } catch (e) { console.error(e); toast('Restore failed: ' + (e.message || e), 6000); }
}
async function renderBackupInfo() {
  const at = await store.getMeta('lastBackupAt').catch(() => null);
  $('#backup-info').textContent = at ? `Last: ${new Date(at).toLocaleDateString()} ›` : 'Last: never ›';
}
// After 10+ notes nobody has backed up, a quiet card suggests a backup. "Later" waits for 10 more.
async function renderBackupNudge() {
  const el = $('#backup-nudge');
  try {
    const [at, later] = await Promise.all([store.getMeta('lastBackupAt'), store.getMeta('backupNudgeLater')]);
    const since = at || '';
    const all = (await Promise.all(state.books.map((b) => store.listNotes(b.id)))).flat();
    const fresh = all.filter((n) => (n.updatedAt || n.createdAt || '') > since).length;
    const need = Math.max(BACKUP_NUDGE_AT, (Number(later) || 0) + BACKUP_NUDGE_AT);
    el.hidden = fresh < need;
    el.dataset.fresh = String(fresh);
    $('#backup-nudge-text').textContent = `${fresh} notes aren’t backed up yet. iPhone can clear website storage.`;
  } catch (_) { el.hidden = true; }
}
async function backupLater() {
  const n = Number($('#backup-nudge').dataset.fresh) || 0;
  await store.setMeta('backupNudgeLater', n); $('#backup-nudge').hidden = true;
}

// ---------------- export ----------------
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
async function exportNotes(kind) {
  const { json, markdown, count } = await store.buildExport(state.bookId);
  if (!count) { toast('No notes to export yet'); return; }
  const isMd = kind === 'md';
  const body = isMd ? markdown : JSON.stringify(json, null, 2);
  const type = isMd ? 'text/markdown' : 'application/json';
  const name = `book-notes-${stamp()}.${isMd ? 'md' : 'json'}`;
  const pre = $('#export-preview'); pre.hidden = false; pre.textContent = body;
  const blob = new Blob([body], { type });
  if (!(await deliverFile(blob, name))) return;
  toast(`Exported ${count} notes as ${isMd ? 'Markdown' : 'JSON'}`);
}

// ---------------- text size (S8) ----------------
function applyTextScale(v) {
  state.textScale = v;
  document.documentElement.style.setProperty('--text-scale', String(v));
  $('#text-size-val').textContent = Math.round(v * 100) + '%';
  $('#btn-text-smaller').disabled = v <= TEXT_SCALES[0];
  $('#btn-text-larger').disabled = v >= TEXT_SCALES[TEXT_SCALES.length - 1];
  syncViewport();
}
function stepTextScale(dir) {
  const i = TEXT_SCALES.indexOf(state.textScale);
  const v = TEXT_SCALES[clamp((i < 0 ? 1 : i) + dir, 0, TEXT_SCALES.length - 1)];
  applyTextScale(v); store.setMeta('textScale', v);
}

// ---------------- wiring ----------------
function closeAllSheets({ keepNote = true } = {}) {
  for (const s of $$('.sheet-backdrop')) {
    if (keepNote && (s.id === 'note-sheet' || s.id === 'book-sheet')) continue;
    s.hidden = true;
  }
  if (!anySheetOpen() && pendingWorker) reofferUpdate();
}
function openSource() {
  if (state.note) { toast('Save or cancel your note first'); return; }
  closePanel('more-sheet'); closePanel('chapters-sheet');
  renderBook(); openPanel('source-sheet');
}
async function openBooks() { await loadBooks(); await renderBooks(); openPanel('books-sheet'); }
function bindUI() {
  // L4: surface storage failures from fire-and-forget writes instead of losing them silently.
  let lastStorageWarn = 0;
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason; console.warn('unhandled', r);
    if (r && /QuotaExceeded|InvalidState|UnknownError|DataError/.test(r.name || '') && Date.now() - lastStorageWarn > 30000) {
      lastStorageWarn = Date.now(); toast('Couldn’t save to storage: ' + (r.message || r.name), 5000);
    }
  });
  // Sheets: [data-close] buttons, and a tap on the dimmed backdrop (not for the note / book editors: no accidental discard).
  for (const s of $$('.sheet-backdrop')) {
    s.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { closePanel(s.id); return; }
      if (e.target === s && s.id !== 'note-sheet' && s.id !== 'book-sheet') closePanel(s.id);
    });
  }
  for (const inp of $$('.file-input')) inp.addEventListener('change', async (e) => { const f = e.target.files; if (f && f.length) await addFiles(f); e.target.value = ''; });
  for (const inp of $$('.restore-input')) inp.addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) await restoreBackup(f); });

  // First run
  $('#btn-get-book').addEventListener('click', () => { if (!$('#btn-get-book').disabled) openSource(); });
  $('#btn-continue-safari').addEventListener('click', () => { sessionStorage.setItem('abn-continue-safari', '1'); renderScreens(); });
  $('#btn-start-first').addEventListener('click', startDuringImport);
  $('#btn-tip-ok').addEventListener('click', dismissTip);
  $('#btn-finish').addEventListener('click', openSource);

  // Listen screen
  $('#btn-chapters').addEventListener('click', openChapters);
  $('#btn-notes').addEventListener('click', openNotes);
  $('#btn-more').addEventListener('click', () => { renderBook(); renderBackupInfo(); updateStorageInfo(); openPanel('more-sheet'); });
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-back15').addEventListener('click', () => skip(-SKIP_SEC));
  $('#btn-fwd15').addEventListener('click', () => skip(SKIP_SEC));
  $('#speed-pill').addEventListener('click', () => openPanel('speed-sheet'));
  $('#btn-backup-nudge').addEventListener('click', backupAll);
  $('#btn-backup-later').addEventListener('click', backupLater);
  const sc = $('#scrubber');
  sc.addEventListener('input', () => { $('#t-cur').textContent = fmt(+sc.value); });
  sc.addEventListener('change', () => { if (audio.src) { audio.currentTime = +sc.value; updatePositionState(); } });
  $('#btn-note').addEventListener('click', () => openNewNote({ voice: false }));
  $('#btn-speak').addEventListener('click', () => openNewNote({ voice: true }));

  // Chapters sheet
  $('#track-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-track]'); if (!b) return;
    const id = b.dataset.track;
    if (state.missing.has(id)) { toast('This file is missing. Add it again with “Add or replace chapters”.'); return; }
    closePanel('chapters-sheet');
    if (state.current?.id === id && audio.src) play(); else await loadTrack(id, { autoplay: true });
  });
  $('#btn-chapters-add').addEventListener('click', openSource);

  // Notes sheet
  $('#seg-chapter').addEventListener('click', () => { state.notesScope = 'chapter'; renderNotes(); });
  $('#seg-all').addEventListener('click', () => { state.notesScope = 'all'; renderNotes(); });
  $('#notes-list').addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.jump) jumpToNote(t.dataset.jump);
    else if (t.dataset.edit) openEditNote(t.dataset.edit);
    else if (t.dataset.voice) playVoice(t.dataset.voice, t);
  });
  $('#btn-export-md').addEventListener('click', () => exportNotes('md'));

  // Note sheet
  $('#btn-note-save').addEventListener('click', saveNote);
  $('#btn-voice-done').addEventListener('click', saveNote);
  $('#btn-note-cancel').addEventListener('click', cancelNote);
  $('#btn-note-delete').addEventListener('click', deleteFromSheet);
  $('#note-text').addEventListener('input', saveDraft);
  $('#nudge-minus').addEventListener('click', () => nudge(-5));
  $('#nudge-plus').addEventListener('click', () => nudge(5));
  $('#btn-rec').addEventListener('click', toggleRecording);
  $('#btn-voice-remove').addEventListener('click', () => { if (state.note) Object.assign(state.note, { voiceBlob: null, removeVoice: true }); hideVoicePreview(); persistDraftVoice(); });

  // ⋯ More
  $('#row-book').addEventListener('click', openBooks);
  $('#row-bot').addEventListener('click', () => openBookEditor('edit', true));
  $('#btn-speed').addEventListener('click', () => openPanel('speed-sheet'));
  $('#btn-text-smaller').addEventListener('click', () => stepTextScale(-1));
  $('#btn-text-larger').addEventListener('click', () => stepTextScale(1));
  $('#row-share').addEventListener('click', () => exportNotes('md'));
  $('#btn-backup').addEventListener('click', backupAll);
  $('#row-chapters-add').addEventListener('click', openSource);
  $('#btn-export-json').addEventListener('click', () => exportNotes('json'));
  $('#btn-remove-audio').addEventListener('click', async () => {
    const title = (state.book || DEFAULT_BOOK).title;
    if (!confirm(`Remove the audio of “${title}” from this device? Your notes and positions are kept.`)) return;
    await savePosition(); pauseAudio(); audio.removeAttribute('src'); audio.load();
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    await store.removeAllAudio(state.bookId); await refreshLibrary(); renderPlayer(); updateStorageInfo(); toast('Audio removed');
  });

  // Source sheet, books, book editor
  $('#btn-src-set-bot').addEventListener('click', () => openBookEditor('edit', true));
  $('#book-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-book]'); if (!b) return;
    if (b.dataset.book === state.bookId) { closePanel('books-sheet'); return; }
    if (await switchBook(b.dataset.book)) { closeAllSheets(); toast(`Switched to “${state.book?.title}”`); }
  });
  $('#btn-edit-book').addEventListener('click', () => openBookEditor('edit'));
  $('#btn-add-book').addEventListener('click', () => openBookEditor('add'));
  $('#btn-book-cancel').addEventListener('click', () => { state.editingBook = null; closePanel('book-sheet'); });
  $('#btn-book-save').addEventListener('click', saveBookForm);
  $('#bot-input').addEventListener('input', validateBookForm);
  $('#book-title-input').addEventListener('input', validateBookForm);
  for (const id of ['#bot-input', '#book-title-input']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBookForm(); } });

  // Speed sheet
  $('#btn-slower').addEventListener('click', () => setSpeed(state.speed - SPEED_STEP));
  $('#btn-faster').addEventListener('click', () => setSpeed(state.speed + SPEED_STEP));
  $('#speed-presets').addEventListener('click', (e) => { const b = e.target.closest('[data-speed]'); if (b) { setSpeed(+b.dataset.speed); closePanel('speed-sheet'); closePanel('more-sheet'); } }); // NICE 1: one tap back to Listen
  $('#btn-speed-done').addEventListener('click', () => closePanel('speed-sheet'));
  $('#toast-action').addEventListener('click', () => { const fn = toastActionFn; hideToast(); if (fn) fn(); });

  audio.addEventListener('timeupdate', () => { renderTime(); if (!audio.paused && Date.now() - state.lastSaved > 5000) savePosition(); });
  audio.addEventListener('play', () => {
    showInterrupt(false);
    if (state.note?.mode === 'new') { state.note.wasPlaying = true; pauseAudio(); toast('Finish the note first. Save resumes playback.', 3000); return; } // S7
    renderPlayer(); updatePositionState(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  audio.addEventListener('pause', () => {
    // S11: a pause we didn't ask for (call, Siri, another app) gets a visible hint.
    const expected = state.expectPause || audio.ended || state.restoring; state.expectPause = false;
    if (!expected && state.current) showInterrupt(true);
    renderPlayer(); savePosition(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  audio.addEventListener('seeked', () => { savePosition(); updatePositionState(); });
  audio.addEventListener('ratechange', () => { if (!state.restoring && Math.abs(audio.playbackRate - state.speed) > 0.001 && audio.playbackRate) audio.playbackRate = state.speed; updatePositionState(); });
  audio.addEventListener('durationchange', renderTime);
  audio.addEventListener('error', onAudioError); // M6
  audio.addEventListener('ended', async () => {
    await savePosition(); renderLibrary();
    const i = state.tracks.findIndex((t) => t.id === state.current?.id);
    const next = state.tracks.slice(i + 1).find((t) => !state.missing.has(t.id));
    if (next) await loadTrack(next.id, { position: 0, autoplay: true });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePosition(); });
  window.addEventListener('pagehide', () => { savePosition(); });
  if (window.visualViewport) { visualViewport.addEventListener('resize', syncViewport); visualViewport.addEventListener('scroll', syncViewport); }
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', syncViewport);
  if (navigator.audioSession && 'onstatechange' in navigator.audioSession) {
    navigator.audioSession.onstatechange = () => { if (navigator.audioSession.state === 'interrupted') showInterrupt(true); };
  }
  store.subscribe((ev) => {
    if (ev.type === 'db-reopened') { toast('Reconnected to storage', 2000); return; }
    if (ev.type === 'db-versionchange') toast('The app was updated in another window. Reload to continue.', 8000);
  });
}

// H1: if another toast replaced the update prompt, offer it again once the user is idle.
let pendingWorker = null;
function reofferUpdate() {
  setTimeout(() => {
    const w = pendingWorker;
    if (!w || w.state !== 'installed' || state.note || anySheetOpen() || !$('#toast-action').hidden) return;
    toast('A new version is ready.', 10 * 60 * 1000, { label: 'Update', fn: () => { if (state.note) { toast('Save or cancel your note first'); return; } w.postMessage('SKIP_WAITING'); } });
  }, 3000);
}
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing to reload
    reloading = true; savePosition().finally(() => location.reload());
  });
  const offer = (w) => {
    if (!w || !navigator.serviceWorker.controller) return;
    pendingWorker = w;
    toast('A new version is ready.', 10 * 60 * 1000, { label: 'Update', fn: () => {
      if (state.note) { toast('Save or cancel your note first'); return; }
      w.postMessage('SKIP_WAITING');
    } });
  };
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('SW registration failed', e));
}

async function boot() {
  bindUI();
  syncViewport();
  setupMediaSession();
  setAudioSession('playback');
  try { await store.openDb(); } catch (e) {
    console.error(e);
    toast(e && e.name === 'VersionError'
      ? 'This copy of the app is older than your saved data. Close other Book Notes tabs and reload.'
      : 'Storage is unavailable in this browser mode', 8000);
    return;
  }
  await loadSettings();
  renderSpeed();
  const cur = await store.getCurrentBookId().catch(() => null);
  state.bookId = cur && (await store.getBook(cur)) ? cur : DEFAULT_BOOK.id;
  await loadBooks();
  await openCurrentBook();
  updateStorageInfo(); renderBackupInfo();
  await restoreDraftOnBoot();
  registerSW();
  document.documentElement.dataset.ready = '1';
}
boot();
