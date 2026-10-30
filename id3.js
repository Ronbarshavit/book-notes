// id3.js — minimal ID3v2.2/2.3/2.4 text-frame reader + filename fallback.
const FRAMES = { TIT2: 'title', TT2: 'title', TRCK: 'track', TRK: 'track', TALB: 'album', TAL: 'album', TPE1: 'artist', TP1: 'artist' };

const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

function decodeText(b) {
  if (!b.length) return '';
  const enc = b[0];
  let body = b.subarray(1), label = 'utf-8';
  if (enc === 0) label = 'iso-8859-1';
  else if (enc === 1) {
    if (body[0] === 0xfe && body[1] === 0xff) { label = 'utf-16be'; body = body.subarray(2); }
    else { label = 'utf-16le'; if (body[0] === 0xff && body[1] === 0xfe) body = body.subarray(2); }
  } else if (enc === 2) label = 'utf-16be';
  try { return new TextDecoder(label).decode(body).replace(/\u0000+$/g, '').split('\u0000')[0].trim(); }
  catch (_) { return ''; }
}

export async function parseId3(blob) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const ver = head[3], flags = head[5];
  const size = synchsafe(head, 6);
  const buf = new Uint8Array(await blob.slice(10, 10 + Math.min(size, 4 * 1024 * 1024)).arrayBuffer());
  let p = 0;
  if (flags & 0x40) p = ver === 4 ? synchsafe(buf, 0) : be32(buf, 0) + 4;
  const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
  const out = {};
  while (p + hdrLen <= buf.length) {
    const id = String.fromCharCode(...buf.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const fsize = ver === 2 ? (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5] : ver === 4 ? synchsafe(buf, p + 4) : be32(buf, p + 4);
    const start = p + hdrLen, end = start + fsize;
    if (fsize <= 0 || end > buf.length) break;
    const key = FRAMES[id];
    if (key && !out[key]) out[key] = decodeText(buf.subarray(start, end));
    p = end;
  }
  if (out.track) { const m = /^\s*(\d+)/.exec(out.track); out.trackNo = m ? parseInt(m[1], 10) : null; }
  return out;
}

// "10a - Chapter 8 - Foo (part 1).mp3" -> { num: 10, suffix: 'a', title: 'Chapter 8 - Foo (part 1)' }
export function parseFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = /^\s*(\d+)\s*([a-z])?(?![a-z])\s*[-.)]*\s*(.*)$/i.exec(base);
  if (!m) return { num: null, suffix: '', title: base };
  return { num: parseInt(m[1], 10), suffix: (m[2] || '').toLowerCase(), title: (m[3] || base).trim() || base };
}

export function compareFilenames(a, b) {
  const x = parseFilename(a), y = parseFilename(b);
  if (x.num != null && y.num != null && x.num !== y.num) return x.num - y.num;
  if (x.num != null && y.num == null) return -1;
  if (x.num == null && y.num != null) return 1;
  if (x.suffix !== y.suffix) return x.suffix < y.suffix ? -1 : 1;
  return a.localeCompare(b, undefined, { numeric: true });
}
