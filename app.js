// app.js — UI + player. All persistence goes through storage.js.
import * as store from './storage.js';
import { parseId3, parseFilename, compareFilenames } from './id3.js';

const { BOOK, formatTimestamp: fmt } = store;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const audio = $('#audio');
const SPEED_MIN = 0.8, SPEED_MAX = 2, SPEED_STEP = 0.05;
const LEAD_IN_SEC = 3;            // S5: jumping to a note starts a little earlier
const TEXT_SCALES = [0.9, 1, 1.15, 1.3];
const DRAFT_KEY = 'abn-note-draft'; // M2: in-progress note survives reloads and app kills
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);

const state = {
  tracks: [], missing: new Set(), progress: new Map(),
  current: null, objectUrl: null, loadToken: 0, restoring: false,
  speed: 1, lastSaved: 0, view: 'library', note: null, rec: null,
  expectPause: false, importing: false, notesById: new Map(), textScale: 1,
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
function once(el, ev, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); }, bad = () => { cleanup(); rej(el.error || new Error(ev + ' failed')); };
    const timer = setTimeout(() => { cleanup(); rej(new Error('timeout waiting for ' + ev)); }, timeoutMs);
    function cleanup() { clearTimeout(timer); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); }
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });
}

// ---------------- views ----------------
function show(view) {
  state.view = view;
  for (const v of ['library', 'player', 'notes']) {
    $('#view-' + v).hidden = v !== view;
    $('#tab-' + v).setAttribute('aria-selected', String(v === view));
  }
  document.body.classList.toggle('view-player', view === 'player');
  if (view === 'notes') renderNotes();
  window.scrollTo(0, 0);
  syncViewport();
}

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

// ---------------- library ----------------
async function refreshLibrary() {
  const [tracks, keys, progress] = await Promise.all([store.listTracks(), store.audioKeys(), store.allProgress()]);
  const have = new Set(keys);
  state.tracks = tracks;
  state.missing = new Set(tracks.filter((t) => !have.has(t.id)).map((t) => t.id));
  state.progress = new Map(progress.map((p) => [p.trackId, p]));
  renderLibrary();
}

function renderLibrary() {
  const has = state.tracks.length > 0;
  $('#empty-state').hidden = has;
  $('#install-steps').hidden = !(isIOS && !isStandalone);
  if (!isIOS) $('#picker-hint').textContent = 'Select all 20 files at once. You can add more later.';
  $('#library-list-wrap').hidden = !has;
  const nMissing = state.missing.size;
  $('#missing-banner').hidden = nMissing === 0;
  if (nMissing) {
    $('#missing-text').textContent = nMissing === state.tracks.length
      ? `All ${nMissing} audio files are gone from this device (iOS can clear website storage). Your notes are safe. Re-add the MP3s to keep listening.`
      : `${nMissing} of ${state.tracks.length} chapters need their file again. Your notes are safe.`;
  }
  $('#track-list').innerHTML = state.tracks.map((t) => {
    const p = state.progress.get(t.id); const d = t.durationSec || p?.durationSec || 0;
    const pct = d && p ? clamp(Math.round((p.positionSec / d) * 100), 0, 100) : 0;
    const missing = state.missing.has(t.id);
    const cur = state.current?.id === t.id;
    return `<li><button type="button" class="track${cur ? ' current' : ''}${missing ? ' missing' : ''}" data-track="${esc(t.id)}">
      <span class="track-no">${t.trackIndex}</span>
      <span><span class="track-title">${esc(t.title)}</span>
      <span class="track-meta">${missing ? '<span class="tag-missing">file missing</span>' : ''}${d ? `<span>${fmt(d)}</span>` : ''}${pct ? `<span class="bar"><i data-pct="${pct}"></i></span><span>${pct}%</span>` : ''}</span></span>
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
  setImporting(true);
  const prog = $('#import-progress'), line = $('#import-line'), bar = $('#import-bar'), sub = $('#import-sub');
  prog.hidden = false; prog.classList.remove('warn');
  sub.textContent = 'Keep this screen open until it finishes.';
  const total = files.reduce((a, f) => a + f.size, 0) || 1;
  let added = 0; const failed = [];
  try {
    const persisted = await store.requestPersistence();
    if (persisted === false) console.info('navigator.storage.persist() was not granted');
    const parsed = [];
    for (const [i, f] of files.entries()) {
      line.textContent = `Reading tags ${i + 1} / ${files.length}…`; bar.value = 0;
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
      line.textContent = `Saving ${i + 1} / ${parsed.length} · ${MB(done)} / ${MB(total)} MB`;
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
        // Files are written one at a time and the ArrayBuffer is not retained past this iteration,
        // so peak memory stays around one chapter.
        const blob = new Blob([await p.file.arrayBuffer()], { type: p.file.type || 'audio/mpeg' });
        const durationSec = await probeDuration(blob);
        await store.putTrack({
          id: store.trackId(BOOK.id, trackIndex), bookId: BOOK.id, trackIndex, title,
          album: p.tags.album || null, artist: p.tags.artist || null,
          fileName: p.file.name, size: p.file.size, mime: blob.type, durationSec, addedAt: new Date().toISOString(),
        }, blob);
        added++;
      } catch (e) {
        console.error(e); failed.push(p.file.name);
        if (e && e.name === 'QuotaExceededError') quota = true;
        // M7: Safari Private Browsing refuses to store Blobs in IndexedDB.
        if (e && /preparing Blob|BlobURLs are not yet supported/i.test(e.message || '')) privateMode = true;
      }
      done += p.file.size; bar.value = done / total;
    }
    if (failed.length) {
      prog.classList.add('warn');
      line.textContent = `Saved ${added} of ${parsed.length} files`;
      sub.textContent = privateMode
        ? 'Safari Private Browsing can’t store audio files. Open this page in a normal (non-private) Safari tab, or from the Home Screen app, and add the files there.'
        : (quota ? 'Not enough storage space. ' : '') + 'Not saved: ' + failed.join(', ') + '. Add them again to retry.';
    } else prog.hidden = true;
  } finally { setImporting(false); }
  await refreshLibrary();
  updateStorageInfo();
  toast(failed.length ? `Saved ${added} of ${added + failed.length} files` : `Added ${added} file${added === 1 ? '' : 's'}`, failed.length ? 5000 : 2000);
  if (!state.current && state.tracks.length) {
    const last = await store.getMeta('lastTrackId');
    const first = (last && trackById(last) && !state.missing.has(last)) ? last : state.tracks.find((t) => !state.missing.has(t.id))?.id;
    if (first) await loadTrack(first, { autoplay: false });
  } else if (state.current && state.missing.size === 0) { renderPlayer(); }
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
    toast(code === 4 ? 'This chapter can’t be played. The file may be damaged; try re-adding it in the Library.' : 'This chapter can’t be played right now. Try re-adding it in the Library.', 6000);
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
    state.missing.add(id); renderPlayer(); renderLibrary(); toast('This chapter’s file is missing. Re-add it in the Library.'); return false;
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
  store.setMeta('lastTrackId', id);
  updateMediaMetadata();
  renderPlayer(); renderLibrary();
  if (autoplay) await play();
  return true;
}

async function play() {
  if (!state.current) { show('library'); toast('Choose a chapter first'); return; }
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
async function stepTrack(dir) {
  if (!state.current) return;
  const i = state.tracks.findIndex((t) => t.id === state.current.id);
  let j = i + dir;
  while (state.tracks[j] && state.missing.has(state.tracks[j].id)) j += dir; // skip chapters whose file is gone
  const next = state.tracks[j];
  if (next) await loadTrack(next.id, { autoplay: !audio.paused });
  else if (state.tracks[i + dir]) toast('The next chapter’s file is missing. Re-add it in the Library.');
}
function setSpeed(v) {
  state.speed = clamp(Math.round(v / SPEED_STEP) * SPEED_STEP, SPEED_MIN, SPEED_MAX);
  state.speed = Math.round(state.speed * 100) / 100;
  audio.defaultPlaybackRate = state.speed; audio.playbackRate = state.speed;
  store.setMeta('speed', state.speed);
  renderSpeed(); updatePositionState();
}

async function savePosition() {
  if (!state.current || state.restoring || !audio.src || !isFinite(audio.currentTime)) return;
  state.lastSaved = Date.now();
  const p = { trackId: state.current.id, positionSec: Math.round(audio.currentTime * 10) / 10, durationSec: dur() || null };
  state.progress.set(p.trackId, p);
  try { await store.setProgress(p.trackId, p.positionSec, p.durationSec); } catch (e) { console.warn(e); }
}

function renderSpeed() {
  $('#speed-val').textContent = state.speed.toFixed(2) + '×';
  $('#speed-btn-val').textContent = state.speed.toFixed(2) + '×';
  for (const b of $$('#speed-presets button')) b.setAttribute('aria-pressed', String(Math.abs(+b.dataset.speed - state.speed) < 0.001));
}
function renderTime() {
  const d = dur(), c = audio.src ? audio.currentTime : 0;
  const sc = $('#scrubber');
  if (!sc.matches(':active')) { sc.max = String(Math.floor(d)); sc.value = String(Math.floor(c)); }
  sc.style.setProperty('--pct', (d ? clamp((+sc.value / Math.floor(d)) * 100, 0, 100) : 0).toFixed(2) + '%');
  $('#t-cur').textContent = fmt(c);
  $('#t-left').textContent = '-' + fmt(Math.max(0, d - c));
  $('#note-at').textContent = 'at ' + fmt(c);
}
function renderPlayer() {
  const t = state.current;
  $('#player-empty').hidden = !!t || state.tracks.length > 0;
  if (t) {
    const i = state.tracks.findIndex((x) => x.id === t.id);
    $('#now-index').textContent = `Track ${t.trackIndex}${state.tracks.length ? ` · ${i + 1} of ${state.tracks.length} loaded` : ''}`;
    $('#now-title').textContent = t.title;
    $('#now-missing').hidden = !state.missing.has(t.id);
    $('#btn-prev').disabled = i <= 0; $('#btn-next').disabled = i >= state.tracks.length - 1;
  } else {
    $('#now-index').textContent = state.tracks.length ? 'Nothing playing' : 'No files yet';
    $('#now-title').textContent = state.tracks.length ? 'Pick a chapter in the Library' : 'Add your MP3 files in the Library';
  }
  const playing = !audio.paused;
  $('#ico-play').toggleAttribute('hidden', playing); $('#ico-pause').toggleAttribute('hidden', !playing);
  $('#btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  renderTime(); renderSpeed();
}

// ---------------- Media Session (lock screen) ----------------
function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || !state.current) return;
  const art = (p, s) => ({ src: new URL(p, location.href).href, sizes: s, type: 'image/png' });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.current.title, artist: state.current.artist || BOOK.author, album: BOOK.title,
    artwork: [art('icons/icon-192.png', '192x192'), art('icons/icon-512.png', '512x512')],
  });
  updatePositionState();
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
    seekbackward: (d) => skip(-(d.seekOffset || 15)),
    seekforward: (d) => skip(d.seekOffset || 30),
    seekto: (d) => { if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime); else audio.currentTime = d.seekTime; updatePositionState(); },
    // previoustrack/nexttrack deliberately NOT set: on iOS that would replace the
    // lock-screen skip buttons, which are more useful for an audiobook.
  };
  for (const [a, fn] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(a, fn); } catch (_) {} }
}

// ---------------- notes sheet ----------------
const voiceSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
const VOICE_MIMES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
function pickVoiceMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return VOICE_MIMES.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
}

function blankNote(extra) {
  return { voiceBlob: null, voiceMime: null, voiceDur: null, existingVoiceId: null, removeVoice: false, origText: '', ...extra };
}
// M3: everything up to focus() runs synchronously inside the tap, so iOS raises the keyboard.
function openNewNote() {
  if (!state.current || !audio.src) { toast('Start a chapter first'); return; }
  if (state.note) return;
  const wasPlaying = !audio.paused;
  pauseAudio();
  const positionSec = Math.round(audio.currentTime * 10) / 10;
  state.note = blankNote({ mode: 'new', wasPlaying, track: { trackIndex: state.current.trackIndex, title: state.current.title }, positionSec });
  openSheet('');
}
function openEditNote(id) {
  const n = state.notesById.get(id); if (!n || state.note) return;
  state.note = blankNote({ mode: 'edit', id, wasPlaying: false, track: { trackIndex: n.trackIndex, title: n.trackTitle }, positionSec: n.positionSec,
    existingVoiceId: n.audioBlobId, origText: n.text || '' });
  openSheet(n.text);
  if (n.audioBlobId) store.getVoice(n.audioBlobId).then((v) => { if (v && state.note?.id === id && !state.note.voiceBlob && !state.note.removeVoice) showVoicePreview(v.blob); });
}
function renderStamp() {
  const n = state.note;
  $('#sheet-stamp').innerHTML = `Track ${n.track.trackIndex} · ${esc(n.track.title)} · <b>${fmt(n.positionSec)}</b>`;
}
function openSheet(text) {
  $('#sheet-title').textContent = state.note.mode === 'new' ? 'New note' : 'Edit note';
  $('#btn-note-save').textContent = state.note.mode === 'new' && state.note.wasPlaying ? 'Save & resume' : 'Save';
  renderStamp();
  const ta = $('#note-text');
  ta.value = text || '';
  hideVoicePreview();
  $('#btn-rec').hidden = !voiceSupported; $('#voice-unsupported').hidden = voiceSupported;
  $('#rec-label').textContent = 'Record voice note'; $('#btn-rec').classList.remove('recording'); $('#rec-time').hidden = true;
  $('#note-sheet').hidden = false;
  $('#note-sheet-panel').scrollTop = 0;
  try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }
  syncViewport();
}
function closeSheet() {
  stopRecording(true);
  $('#note-sheet').hidden = true;
  hideVoicePreview();
  const resume = state.note?.wasPlaying; state.note = null;
  if (pendingWorker) reofferUpdate();
  return resume;
}
// ---- M2: draft autosave + undoable cancel
function saveDraft() {
  const n = state.note; if (!n) return;
  const text = $('#note-text').value;
  try {
    if (!text.trim() && !n.voiceBlob && !n.removeVoice) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, mode: n.mode, id: n.id || null, track: n.track, positionSec: n.positionSec,
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
  const snap = draftDirty() ? { note: { ...n }, text: $('#note-text').value } : null;
  clearDraft();
  const resume = closeSheet();
  if (resume) play();
  if (snap) toast('Note discarded', 6000, { label: 'Undo', fn: () => restoreNote(snap) });
}
function restoreNote(snap) {
  if (state.note) return;
  const n = snap.note;
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
  state.note = blankNote({ mode: d.mode === 'edit' ? 'edit' : 'new', id: d.id, wasPlaying: false, track: d.track, positionSec: d.positionSec,
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

async function toggleRecording() {
  if (state.rec) { stopRecording(false); return; }
  let stream;
  setAudioSession('play-and-record'); // S11
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { setAudioSession('playback'); toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied' : 'Microphone unavailable: ' + e.message, 4000); return; }
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
  $('#btn-rec').classList.add('recording'); $('#rec-label').textContent = 'Stop recording'; $('#rec-time').hidden = false;
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
  $('#btn-rec').classList.remove('recording'); $('#rec-label').textContent = 'Record voice note'; $('#rec-time').hidden = true;
  return Promise.race([r.done, new Promise((res) => setTimeout(res, 3000))]); // safety net only
}

async function saveNote() {
  const n = state.note; if (!n) return;
  const btn = $('#btn-note-save'); if (btn.disabled) return;
  btn.disabled = true;
  try {
    if (state.rec) await stopRecording(false);
    const text = $('#note-text').value.trim();
    const keepsOldVoice = n.existingVoiceId && !n.removeVoice && !n.voiceBlob;
    if (!text && !n.voiceBlob && !keepsOldVoice) { toast('Type a note or record a voice note'); return; }
    const exists = n.mode !== 'new' && !!(await store.getNote(n.id));
    // One transaction for note + voice: either everything commits or nothing does.
    await store.saveNoteAtomic({
      id: exists ? n.id : null, bookId: BOOK.id, trackIndex: n.track.trackIndex, trackTitle: n.track.title,
      positionSec: n.positionSec, text,
      voice: n.voiceBlob ? { blob: n.voiceBlob, mime: n.voiceMime, durationSec: n.voiceDur } : null,
      keepVoiceId: keepsOldVoice ? n.existingVoiceId : null,
    });
  } catch (e) {
    console.error(e);
    // Keep the sheet (and the draft) so nothing typed or recorded is lost.
    toast(e?.name === 'QuotaExceededError' ? 'Storage is full. Note NOT saved.' : 'Note NOT saved: ' + String(e?.message ?? e), 7000);
    return;
  } finally { btn.disabled = false; }
  clearDraft();
  const at = fmt(n.positionSec);
  const resume = closeSheet();
  toast(`Note saved at ${at}`);
  if (state.view === 'notes') renderNotes();
  if (resume) play();
}

// ---------------- notes list ----------------
let voicePlayer = null;
async function renderNotes() {
  const notes = await store.listNotes();
  $('#notes-count').textContent = notes.length ? `(${notes.length})` : '';
  $('#notes-empty').hidden = notes.length > 0;
  const groups = new Map();
  for (const n of notes) { if (!groups.has(n.trackIndex)) groups.set(n.trackIndex, { title: n.trackTitle, items: [] }); groups.get(n.trackIndex).items.push(n); }
  state.notesById = new Map(notes.map((n) => [n.id, n]));
  $('#notes-list').innerHTML = [...groups.entries()].map(([idx, g]) => `
    <section class="note-group" data-track-index="${idx}">
      <h3>${idx}. ${esc(g.title)}</h3>
      ${g.items.map((n) => `<article class="note" data-note="${esc(n.id)}">
        <div class="note-body">
          <button type="button" class="ts" data-jump="${esc(n.id)}" aria-label="Play from ${fmt(n.positionSec)}, starting ${LEAD_IN_SEC} seconds earlier"><span aria-hidden="true">▶</span><span class="ts-time">${fmt(n.positionSec)}</span></button>
          <div class="note-text${n.text ? '' : ' voice-only'}">${n.text ? esc(n.text) : 'Voice note'}</div>
        </div>
        <div class="note-actions">
          ${n.audioBlobId ? `<button type="button" class="btn btn-quiet" data-voice="${esc(n.audioBlobId)}">▶ Voice</button>` : ''}
          <button type="button" class="btn btn-quiet" data-edit="${esc(n.id)}">Edit</button>
          <button type="button" class="btn btn-danger-quiet" data-del="${esc(n.id)}">Delete</button>
        </div>
      </article>`).join('')}
    </section>`).join('');
}
async function jumpToNote(id) {
  const n = state.notesById.get(id) || await store.getNote(id); if (!n) return;
  const tid = store.trackId(n.bookId, n.trackIndex);
  const target = Math.max(0, n.positionSec - LEAD_IN_SEC);
  if (!trackById(tid) || state.missing.has(tid)) { toast('Re-add this chapter’s file to jump there', 3500); return; }
  show('player');
  if (state.current?.id === tid && audio.src) { audio.currentTime = target; renderTime(); updatePositionState(); await play(); }
  else await loadTrack(tid, { position: target, autoplay: true });
}
async function playVoice(blobId, btn) {
  if (voicePlayer && !voicePlayer.paused) { voicePlayer.pause(); btn.textContent = '▶ Voice'; return; }
  const v = await store.getVoice(blobId); if (!v) { toast('Voice note not found'); return; }
  pauseAudio();
  voicePlayer = voicePlayer || new Audio();
  if (voicePlayer.dataset.url) URL.revokeObjectURL(voicePlayer.dataset.url);
  voicePlayer.dataset.url = voicePlayer.src = URL.createObjectURL(v.blob);
  voicePlayer.onended = () => { btn.textContent = '▶ Voice'; };
  btn.textContent = '❚❚ Voice';
  try { await voicePlayer.play(); } catch (e) { toast('Could not play voice note'); btn.textContent = '▶ Voice'; }
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
  const btn = $('#btn-backup'); btn.disabled = true;
  try {
    if (state.current) await savePosition();
    const b = await store.buildBackup();
    const blob = new Blob([JSON.stringify(b)], { type: 'application/json' });
    const ok = await deliverFile(blob, `book-notes-backup-${stamp()}.json`);
    if (!ok) return;
    await store.setMeta('lastBackupAt', b.exportedAt);
    renderBackupInfo();
    toast(`Backed up ${b.notes.length} notes, ${Object.keys(b.voice).length} voice clips and ${b.progress.length} positions`, 3500);
  } catch (e) { console.error(e); toast('Backup failed: ' + (e.message || e), 5000); }
  finally { btn.disabled = false; }
}
async function restoreBackup(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch (_) { toast('That file isn’t a Book Notes backup (not valid JSON).', 5000); return; }
  try {
    const r = await store.importBackup(obj);
    await loadSettings(); renderSpeed();
    await refreshLibrary(); await renderNotes();
    if (!state.current) {
      const last = await store.getMeta('lastTrackId');
      if (last && trackById(last) && !state.missing.has(last)) await loadTrack(last, { autoplay: false });
      else renderPlayer();
    }
    updateStorageInfo();
    const extra = r.notesSkipped ? ` (${r.notesSkipped} already up to date)` : '';
    toast(`Restored ${r.notes} notes, ${r.voice} voice clips, ${r.progress} positions${extra}`, 5000);
  } catch (e) { console.error(e); toast('Restore failed: ' + (e.message || e), 6000); }
}
async function renderBackupInfo() {
  const at = await store.getMeta('lastBackupAt').catch(() => null);
  $('#backup-info').textContent = at ? `Last backup: ${new Date(at).toLocaleString()}` : 'No backup yet. iPhone can clear app storage; a backup file keeps your notes safe.';
}

// ---------------- export ----------------
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
async function exportNotes(kind) {
  const { json, markdown, count } = await store.buildExport();
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
function bindUI() {
  // L4: surface storage failures from fire-and-forget writes instead of losing them silently.
  let lastStorageWarn = 0;
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason; console.warn('unhandled', r);
    if (r && /QuotaExceeded|InvalidState|UnknownError|DataError/.test(r.name || '') && Date.now() - lastStorageWarn > 30000) {
      lastStorageWarn = Date.now(); toast('Couldn’t save to storage: ' + (r.message || r.name), 5000);
    }
  });
  for (const b of $$('.tabbar button')) b.addEventListener('click', () => show(b.dataset.view));
  for (const inp of $$('.file-input')) inp.addEventListener('change', async (e) => { const f = e.target.files; if (f && f.length) await addFiles(f); e.target.value = ''; });
  $('#track-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-track]'); if (!b) return;
    const id = b.dataset.track;
    if (state.missing.has(id)) { toast('This file is missing. Tap “Re-add files”.'); return; }
    show('player');
    if (state.current?.id === id && audio.src) play(); else await loadTrack(id, { autoplay: true });
  });
  $('#btn-remove-audio').addEventListener('click', async () => {
    if (!confirm('Remove all audio files from this device? Your notes and positions are kept.')) return;
    await savePosition(); pauseAudio(); audio.removeAttribute('src'); audio.load();
    if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
    await store.removeAllAudio(); await refreshLibrary(); renderPlayer(); updateStorageInfo(); toast('Audio removed');
  });
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-back30').addEventListener('click', () => skip(-30));
  $('#btn-back15').addEventListener('click', () => skip(-15));
  $('#btn-fwd15').addEventListener('click', () => skip(15));
  $('#btn-fwd30').addEventListener('click', () => skip(30));
  $('#btn-prev').addEventListener('click', () => stepTrack(-1));
  $('#btn-next').addEventListener('click', () => stepTrack(1));
  $('#btn-slower').addEventListener('click', () => setSpeed(state.speed - SPEED_STEP));
  $('#btn-faster').addEventListener('click', () => setSpeed(state.speed + SPEED_STEP));
  $('#speed-presets').addEventListener('click', (e) => { const b = e.target.closest('[data-speed]'); if (b) setSpeed(+b.dataset.speed); });
  $('#btn-speed').addEventListener('click', () => { $('#speed-sheet').hidden = false; syncViewport(); });
  $('#btn-speed-done').addEventListener('click', () => { $('#speed-sheet').hidden = true; });
  $('#speed-sheet').addEventListener('click', (e) => { if (e.target.id === 'speed-sheet') $('#speed-sheet').hidden = true; });
  $('#btn-text-smaller').addEventListener('click', () => stepTextScale(-1));
  $('#btn-text-larger').addEventListener('click', () => stepTextScale(1));
  $('#toast-action').addEventListener('click', () => { const fn = toastActionFn; hideToast(); if (fn) fn(); });
  const sc = $('#scrubber');
  sc.addEventListener('input', () => { $('#t-cur').textContent = fmt(+sc.value); });
  sc.addEventListener('change', () => { if (audio.src) { audio.currentTime = +sc.value; updatePositionState(); } });
  $('#btn-note').addEventListener('click', openNewNote);
  $('#btn-note-save').addEventListener('click', saveNote);
  $('#btn-note-cancel').addEventListener('click', cancelNote);
  // M2: taps outside the sheet do nothing (no accidental discard while walking).
  $('#note-sheet').addEventListener('click', (e) => { if (e.target.id === 'note-sheet') e.preventDefault(); });
  $('#note-text').addEventListener('input', saveDraft);
  $('#nudge-minus').addEventListener('click', () => nudge(-5));
  $('#nudge-plus').addEventListener('click', () => nudge(5));
  $('#btn-rec').addEventListener('click', toggleRecording);
  $('#btn-voice-remove').addEventListener('click', () => { if (state.note) Object.assign(state.note, { voiceBlob: null, removeVoice: true }); hideVoicePreview(); persistDraftVoice(); });
  $('#notes-list').addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.jump) jumpToNote(t.dataset.jump);
    else if (t.dataset.edit) openEditNote(t.dataset.edit);
    else if (t.dataset.voice) playVoice(t.dataset.voice, t);
    else if (t.dataset.del) { if (confirm('Delete this note?')) { await store.deleteNote(t.dataset.del); renderNotes(); toast('Note deleted'); } }
  });
  $('#btn-backup').addEventListener('click', backupAll);
  for (const inp of $$('.restore-input')) inp.addEventListener('change', async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) await restoreBackup(f); });
  $('#btn-export-md').addEventListener('click', () => exportNotes('md'));
  $('#btn-export-json').addEventListener('click', () => exportNotes('json'));

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
    if (ev.type.startsWith('note') && state.view === 'notes') renderNotes();
    if (ev.type === 'db-reopened') { toast('Reconnected to storage', 2000); return; }
    if (ev.type === 'db-versionchange') toast('The app was updated in another window. Reload to continue.', 8000);
  });
}

// H1: if another toast replaced the update prompt, offer it again once the user is idle.
let pendingWorker = null;
function reofferUpdate() {
  setTimeout(() => {
    const w = pendingWorker;
    if (!w || w.state !== 'installed' || state.note || !$('#toast-action').hidden) return;
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
  await refreshLibrary();
  renderSpeed();
  const last = await store.getMeta('lastTrackId');
  if (last && trackById(last) && !state.missing.has(last)) { await loadTrack(last, { autoplay: false }); show('player'); }
  else { renderPlayer(); show('library'); }
  updateStorageInfo(); renderBackupInfo();
  await restoreDraftOnBoot();
  registerSW();
  document.documentElement.dataset.ready = '1';
}
boot();
