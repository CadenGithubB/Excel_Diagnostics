#!/usr/bin/env node
// excel_diagnostics_cli.mjs - search an excel_diagnostics.sh bundle from a terminal, without a browser.
// Run:  node excel_diagnostics_cli.mjs help      (or: deno run -A excel_diagnostics_cli.mjs help)
// Built by build.py from src/core.js, src/cli.js, src/request.js and src/cli_main.js; edit those, not this file.
'use strict';
/* Excel diagnostics log viewer - indexing and search core.
 *
 * Runs in a Web Worker. Nothing here touches the network: bundles are read with File/Blob APIs only.
 *
 * Built to cope with multi-gigabyte logs: log text is never held in JavaScript strings. Each log file
 * stays a Blob (the file on disk, or a zip member inflated once into a browser-managed Blob), and only a
 * compact per-row index (time, byte range, level, process, ...) lives in memory. Filters on indexed
 * columns run on that index; text and regex searches stream the Blobs in 8 MB slices.
 */
const Core = (() => {
  const LATIN1 = new TextDecoder('latin1');     // one character per byte, so string indexes are byte offsets
  const UTF8 = new TextDecoder('utf-8');
  const CHUNK = 8 << 20;
  const SEV = ['Debug', 'Info', 'Notice', 'Warning', 'Error', 'Fault'];
  const SEV_OF = {
    debug: 0, verbose: 0, verboseex: 0, vrb: 0, trace: 0,
    info: 1, medium: 1, nrm: 1, activitycreateevent: 1, stateevent: 1, '': 1,
    default: 2, notice: 2, high: 2,
    warning: 3, warn: 3, wrn: 3, monitorable: 3, lossevent: 3, diag: 3, report: 3,
    error: 4, err: 4, unexpected: 4, hang: 4, spin: 4, jetsam: 4, 'force quit': 4,
    fault: 5, critical: 5, fatal: 5, assert: 5, crash: 5, panic: 5,
  };
  // The severity of a level name this tool knows by that name (SEV_OF), or -1: for the command-line tool, which says
  // what a level name sent in place of a severity is counted as
  const levelSev = (name) => { const k = String(name).toLowerCase(); return Object.hasOwn(SEV_OF, k) ? SEV_OF[k] : -1; };
  function sevOf(name) {
    const k = name.toLowerCase();
    if (k in SEV_OF) return SEV_OF[k];
    if (/fault|fatal|critical|assert|panic|crash/.test(k)) return 5;
    if (/err|unexpected|exception|fail/.test(k)) return 4;
    if (/warn|loss/.test(k)) return 3;
    if (/debug|verbose|trace/.test(k)) return 0;
    return 1;
  }

  // ---------- small helpers ----------
  const copyStr = (s) => s.split('').join('');          // detach from the 8 MB chunk string it was sliced from
  const CP1252 = new Map();                             // reverse of the latin1 decoder for bytes 0x80-0x9F
  for (let b = 0x80; b < 0xA0; b++) CP1252.set(LATIN1.decode(new Uint8Array([b])), b);
  function fixUtf8(s) {                                 // latin1-decoded UTF-8 -> proper string
    if (!/[^\x00-\x7f]/.test(s)) return s;
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i] = c < 256 ? c : (CP1252.get(s[i]) || 63); }
    return UTF8.decode(b);
  }
  const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  function concat(list, total) { const out = new Uint8Array(total); let o = 0; for (const a of list) { out.set(a, o); o += a.length; } return out; }
  function lowerBound(a, x, lo, hi) { while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(a, x, lo, hi) { while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }

  class Dict {                                          // string <-> small integer id; id 0 is always ''
    constructor(max) { this.max = max; this.map = new Map([['', 0]]); this.names = ['']; }
    id(s) {
      let i = this.map.get(s);
      if (i === undefined) {
        if (this.names.length >= this.max && s !== '(other)') return this.id('(other)');
        i = this.names.length;
        this.map.set(copyStr(s), i);
        this.names.push(fixUtf8(copyStr(s)));
      }
      return i;
    }
  }

  // ---------- timestamps ----------
  const d2 = (s, i) => (s.charCodeAt(i) - 48) * 10 + s.charCodeAt(i + 1) - 48;
  function daysFromCivil(y, m, d) {
    y -= m <= 2;
    const era = Math.floor(y / 400), yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  }
  let cY = 0, cM = 0, cD = 0, cDays = 0;                // consecutive rows nearly always share a date
  function ymd(y, m, d) {
    if (y !== cY || m !== cM || d !== cD) {
      if (!(y > 1990 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return NaN;
      cY = y; cM = m; cD = d; cDays = daysFromCivil(y, m, d);
    }
    return cDays * 86400000;
  }
  function isoAt(s, p) {                                // "YYYY-MM-DD?HH:MM:SS[.ffffff]" at p -> ms as if UTC, NaN if malformed
    if (s.charCodeAt(p + 4) !== 45) return NaN;
    const h = d2(s, p + 11), mi = d2(s, p + 14), sec = d2(s, p + 17);
    if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60 && sec >= 0 && sec < 62)) return NaN;
    let t = ymd(d2(s, p) * 100 + d2(s, p + 2), d2(s, p + 5), d2(s, p + 8)) + h * 3600000 + mi * 60000 + sec * 1000;
    if (s.charCodeAt(p + 19) === 46) {
      let scale = 100, i = p + 20, c;
      while ((c = s.charCodeAt(i) - 48) >= 0 && c <= 9 && scale >= 0.0001) { t += c * scale; scale /= 10; i++; }
    }
    return t;
  }
  function offStr(z) {                                  // "-0500", "+05:30", "-05" -> minutes east of UTC
    const m = /^([-+])(\d\d):?(\d\d)?$/.exec(z);
    return m ? (m[1] === '-' ? -1 : 1) * (m[2] * 60 + (+m[3] || 0)) : NaN;
  }
  // A time as somebody wrote it, in parts: y, mo and d (absent for a time of day alone), h, mi and s (each absent
  // when not written), and z, the offset, Z or UTC (absent when not written), each as the digits written. Each part
  // has to be one that can be: a month from 01 to 12, a day that month has, an hour from 00 to 23, a minute and a
  // second from 00 to 59, and an offset from -12:00 to +14:00 with its minutes from 00 to 59. Left to Date, 2026-13-45
  // would be read as 2027-02-14 and 09:00:99 as 09:01:39. timeBad says each part that is not, as a clause, and whether
  // the offset is one of them. The command-line tool (parseTime in cli.js) and the page's From and To boxes both
  // check a time here, and both read only the moments from TIME_FIRST to TIME_LAST: any moment between them is
  // written with a year of four digits on any clock, so a time printed from it reads back.
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const daysIn = (y, mo) => { const d = new Date(0); d.setUTCFullYear(y, mo, 0); return d.getUTCDate(); };      // mo from 1
  const offsetOk = (z) => /^(z|utc)$/i.test(z) || (+z.replace(/^[+-](\d\d):?(\d\d)$/, '$2') <= 59 && offStr(z) >= -720 && offStr(z) <= 840);
  const TIME_FIRST = Date.UTC(1000, 0, 2), TIME_LAST = Date.UTC(9999, 11, 30, 23, 59, 59, 999);
  function timeBad(p) {
    const bad = [], dated = p.y !== undefined, inMonth = Math.min(12, Math.max(1, +p.mo || 1));
    if (dated && (+p.mo < 1 || +p.mo > 12)) bad.push(`the month is ${p.mo}, and months run from 01 to 12`);
    if (dated && +p.d < 1) bad.push(`the day is ${p.d}, and days run from 01`);
    else if (dated && +p.d > daysIn(+p.y, inMonth)) bad.push(+p.mo >= 1 && +p.mo <= 12 ? `the day is ${p.d}, and ${MONTH_NAMES[+p.mo - 1]} ${p.y} has days 01 to ${daysIn(+p.y, +p.mo)}` : `the day is ${p.d}, and no month has more than 31 days`);
    if (p.h !== undefined && +p.h > 23) bad.push(`the hour is ${p.h}, and hours run from 00 to 23`);
    if (p.mi !== undefined && +p.mi > 59) bad.push(`the minute is ${p.mi}, and minutes run from 00 to 59`);
    if (p.s !== undefined && +p.s > 59) bad.push(`the second is ${p.s}, and seconds run from 00 to 59`);
    const zoneBad = p.z !== undefined && !offsetOk(p.z);
    if (zoneBad) bad.push(`the offset is ${p.z}, and offsets run from -12:00 to +14:00, with minutes from 00 to 59`);
    return { bad, zoneBad };
  }
  function stamp(t, digits = 3) {                       // UTC ms -> "YYYY-MM-DD HH:MM:SS.fff"
    // Past milliseconds, count in the smallest unit shown and round: a time read from ".123456" is held as a float
    // a hair under it, and cutting that off would print .123455.
    const unit = digits > 3 ? 10 ** (digits - 3) : 1, n = digits > 3 ? Math.round(t * unit) : Math.floor(t);
    const d = new Date(Math.floor(n / unit)), z = (v, w = 2) => String(v).padStart(w, '0');
    let s = `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
    if (digits > 3) s += '.' + z(n - Math.floor(n / (1000 * unit)) * 1000 * unit, digits);
    else if (digits) s += '.' + z(Math.floor((t - Math.floor(t / 1000) * 1000) * 10 ** (digits - 3)), digits);
    return s;
  }

  // ---------- zip (central directory + raw deflate via DecompressionStream) ----------
  // Reads zip64, and also repairs what `ditto -c -k` (the collector's zipper) writes instead of zip64: plain
  // 32-bit sizes and offsets that silently wrap around once a file or the archive passes 4 GB.
  const GB4 = 4294967296;
  // MOST, when given, is how many members the caller will take: a zip that lists more stops being read there and
  // is refused, before an object is made for each of what can be millions of tiny records.
  async function readZip(file, most = Infinity) {
    const size = file.size, tailLen = Math.min(size, 65557 + 20);
    const tail = new Uint8Array(await file.slice(size - tailLen).arrayBuffer());
    const dv = new DataView(tail.buffer);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('This does not look like a zip file (no end-of-central-directory record).');
    let cdSize = dv.getUint32(e + 12, true), cdOff = size - tailLen + e - cdSize;     // not the stored offset: that one wraps
    if (e >= 20 && dv.getUint32(e - 20, true) === 0x07064b50) {
      const zOff = Number(dv.getBigUint64(e - 12, true));
      const z = new DataView(await file.slice(zOff, zOff + 56).arrayBuffer());
      if (z.getUint32(0, true) === 0x06064b50) { cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true)); }
    }
    const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const c = new DataView(cd.buffer);
    const out = [];
    let p = 0;
    while (p + 46 <= cd.length && c.getUint32(p, true) === 0x02014b50) {
      const method = c.getUint16(p + 10, true);
      let csize = c.getUint32(p + 20, true), usize = c.getUint32(p + 24, true), hdr = c.getUint32(p + 42, true);
      const n = c.getUint16(p + 28, true), m = c.getUint16(p + 30, true), k = c.getUint16(p + 32, true);
      const name = UTF8.decode(cd.subarray(p + 46, p + 46 + n));
      for (let x = p + 46 + n; x + 4 <= p + 46 + n + m;) {
        const id = c.getUint16(x, true), len = c.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xFFFFFFFF) { usize = Number(c.getBigUint64(q, true)); q += 8; }
          if (csize === 0xFFFFFFFF) { csize = Number(c.getBigUint64(q, true)); q += 8; }
          if (hdr === 0xFFFFFFFF) hdr = Number(c.getBigUint64(q, true));
        }
        x += 4 + len;
      }
      p += 46 + n + m + k;
      if (out.length >= most) throw Object.assign(new Error(`This zip lists more than ${most} members.`), { tooMany: true });
      out.push({ path: name, size: usize, csize, method, hdr, next: null, cdOff });

    }
    for (let i = 0; i + 1 < out.length; i++) out[i].next = out[i + 1];
    return out.filter((x) => !x.path.endsWith('/'));
  }
  async function locate(file, e) {                      // true position of an entry's local header
    if (e.at !== undefined) return e.at;
    for (let pos = e.hdr; pos + 30 <= e.cdOff; pos += GB4) {      // the stored offset may be short by a multiple of 4 GB
      const b = new Uint8Array(await file.slice(pos, pos + 30 + 1024).arrayBuffer()), h = new DataView(b.buffer);
      if (b.length < 30 || h.getUint32(0, true) !== 0x04034b50) continue;
      const n = h.getUint16(26, true);
      if (UTF8.decode(b.subarray(30, 30 + n)) !== e.path) continue;
      e.data = pos + 30 + n + h.getUint16(28, true);
      return (e.at = pos);
    }
    throw new Error(`Corrupt zip: cannot find ${e.path}`);
  }
  async function zipData(file, e) {                     // -> Blob (stored) or ReadableStream of inflated bytes
    await locate(file, e);
    const end = e.next ? await locate(file, e.next) : e.cdOff;
    const room = end - e.data - e.csize;                // 4 GB or more unaccounted for before the next entry: the size wrapped
    if (room >= GB4) e.csize += Math.floor(room / GB4) * GB4;
    const raw = file.slice(e.data, e.data + e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`Unsupported zip compression method ${e.method}: ${e.path}`);
    return raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  }

  // Inflated zip members have to live somewhere searchable. Small ones become in-memory Blobs. Large ones are
  // written to the origin-private file system, because browsers refuse to hold several GB of Blob data: Chrome
  // accepts the Blob and then fails every read of it. Each session gets its own folder, marked as in use by a
  // Web Lock; the page deletes folders whose lock is free (see sweepTemp in app.js).
  async function openStore() {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory || !navigator.locks || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) return null;
      const root = await navigator.storage.getDirectory();
      const name = `xldiag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      navigator.locks.request(name, () => new Promise(() => {}));     // never resolves: held until this worker ends
      return { dir: await root.getDirectoryHandle(name, { create: true }), seq: 0, blobBytes: 0, diskBytes: 0 };
    } catch (err) { return null; }
  }
  const TOO_BIG = 'This zip holds more log data than the browser could unpack into temporary storage. Unzip it and drop the folder instead; the logs are then read in place.';

  class Entry {                                         // one file of the bundle
    constructor(path, size, blob, zip) { this.path = path; this.size = size; this.cached = blob || null; this.zip = zip || null; }
    async blob() {
      if (this.cached) return this.cached;
      const r = await zipData(this.zip.file, this.zip.e);
      return typeof r.getReader === 'function' ? new Response(r).blob() : (this.cached = r);
    }
    async *chunks(keep, store) {                        // sequential read; keep = remember the inflated bytes for later slicing
      if (!this.cached) {
        const r = await zipData(this.zip.file, this.zip.e);
        if (typeof r.getReader !== 'function') this.cached = r;
        else {
          const reader = r.getReader(), parts = [];
          const disk = keep && store && (this.zip.e.csize > 16 << 20 || store.blobBytes > 384 << 20);
          let pend = [], pendSize = 0, done = false, fh = null, ah = null, pos = 0;
          try {
            if (disk) { fh = await store.dir.getFileHandle(`f${store.seq++}`, { create: true }); ah = await fh.createSyncAccessHandle(); }
            for (;;) {
              const { done: end, value } = await reader.read();
              if (end) { done = true; break; }
              if (ah) { if (ah.write(value, { at: pos }) !== value.length) throw new Error(TOO_BIG); pos += value.length; }
              else if (keep) { pend.push(value); pendSize += value.length; if (pendSize >= 32 << 20) { parts.push(new Blob(pend)); pend = []; pendSize = 0; } }
              yield value;
            }
          } catch (err) {
            throw (err && (err.name === 'QuotaExceededError' || err.name === 'NotReadableError') ? new Error(TOO_BIG) : err);
          } finally {
            if (!done) reader.cancel().catch(() => {});
            if (ah) { try { ah.flush(); } catch (err) { /* reported by the size check below */ } ah.close(); }
          }
          if (fh) { this.cached = await fh.getFile(); store.diskBytes += this.cached.size; if (this.cached.size !== pos) throw new Error(TOO_BIG); }
          else if (keep) {
            if (pend.length) parts.push(new Blob(pend));
            this.cached = new Blob(parts);
            if (store) store.blobBytes += this.cached.size;
            try { if (this.cached.size) await this.cached.slice(this.cached.size - 1).arrayBuffer(); } catch (err) { throw new Error(TOO_BIG); }
          }
          if (keep) this.size = this.cached.size;
          return;
        }
      }
      const b = this.cached;
      for (let o = 0; o < b.size; o += CHUNK) yield new Uint8Array(await b.slice(o, o + CHUNK).arrayBuffer());
    }
    async head(n) {
      if (this.cached) return new Uint8Array(await this.cached.slice(0, n).arrayBuffer());
      const got = []; let len = 0;
      for await (const c of this.chunks(false)) { got.push(c); len += c.length; if (len >= n) break; }
      return concat(got, len).subarray(0, n);
    }
  }

  // ---------- per-file row index ----------
  class Source {
    constructor(id, entry, parser) {
      this.id = id; this.entry = entry; this.path = entry.path; this.parser = parser;
      this.n = 0; this.cap = 0; this.lastOm = NaN;
      // Room for rows is made when the first row arrives, sized from the file: every source exists before any is
      // read, and a bundle can hold tens of thousands of files of a line or two each
      // A zip member's size is what the zip claims, and a zip can claim gigabytes for a one-line file: room for
      // rows is sized from a file's real size only, and for a zip member starts small and grows as rows come
      this.first = entry.zip ? 1024 : Math.max(8, Math.min(4 << 20, Math.ceil(entry.size / 200)));
      this.alloc(0);
    }
    alloc(cap) {
      const grow = (A, old) => { const a = new A(cap); if (old) a.set(old.subarray(0, this.n)); return a; };
      this.off = grow(Float64Array, this.off); this.len = grow(Uint32Array, this.len); this.t = grow(Float64Array, this.t);
      this.lvl = grow(Uint8Array, this.lvl); this.proc = grow(Uint16Array, this.proc); this.pid = grow(Int32Array, this.pid);
      this.sub = grow(Uint16Array, this.sub); this.cat = grow(Uint16Array, this.cat); this.tags = grow(Uint16Array, this.tags);
      this.cap = cap;
    }
    push(off, len, t, lvl, proc, pid, sub, cat, tags) {
      // No memory left for more rows is not a fault in the line being read: it is marked, so that it stops the load
      if (this.n === this.cap) { try { this.alloc(this.cap ? this.cap * 2 : this.first); } catch (err) { throw Object.assign(err, { noRoom: true }); } }
      const i = this.n++;
      this.off[i] = off; this.len[i] = len; this.t[i] = t; this.lvl[i] = lvl; this.proc[i] = proc;
      this.pid[i] = pid; this.sub[i] = sub; this.cat[i] = cat; this.tags[i] = tags;
    }
    extend(end) {                                       // a continuation line belongs to the previous row
      if (this.n) this.len[this.n - 1] = Math.min(end - this.off[this.n - 1], 0xFFFFFFFF);
    }
  }

  // ---------- parsers: line(src, s, p, e, off) indexes one line; fields(text) splits a row for display ----------
  // The next tab at or after i, or e (where the line ends) when the line has none. The last answer is kept: a line
  // without tabs would otherwise make every call search on to the next tab anywhere in the chunk, nine times a line.
  let tabIn = null, tabFrom = 0, tabAt = 0;
  const tab = (s, i, e) => {
    if (i > e) return e;
    if (s !== tabIn || i < tabFrom || i > tabAt) { const j = s.indexOf('\t', i); tabIn = s; tabFrom = i; tabAt = j < 0 ? Infinity : j; }
    return tabAt > e ? e : tabAt;
  };
  const fld = (s, a, b) => (a >= b ? '' : s.substring(a, b));
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const unescTsv = (s) => s.replace(/\\([nrt\\])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '' : '\\'));

  function unifiedTsv(ds) {                             // unified_logs/*.tsv written by label_entries
    const { lvl, proc, sub, cat } = ds.dict;
    const masks = new Map([['', 0]]);
    const maskOf = (str) => {
      let m = masks.get(str);
      if (m === undefined) { m = 0; for (const name of str.split(',')) m |= 1 << ds.tagId(name); masks.set(copyStr(str), m); }
      return m;
    };
    return {
      kind: 'unified', group: 'macOS unified log', short: 'unified', tagged: true,
      line(src, s, p, e, off) {
        const c = s.charCodeAt(p);
        if (c < 48 || c > 57) { if (c !== 0 && !s.startsWith('local_time\t', p)) src.extend(off + e - p); return; }
        const t1 = tab(s, p, e), t2 = tab(s, t1 + 1, e), t3 = tab(s, t2 + 1, e), t4 = tab(s, t3 + 1, e), t5 = tab(s, t4 + 1, e),
          t6 = tab(s, t5 + 1, e), t7 = tab(s, t6 + 1, e), t8 = tab(s, t7 + 1, e), t9 = tab(s, t8 + 1, e);
        let t = isoAt(s, t1 + 1);
        const oc = s.charCodeAt(t1 - 5);
        if (oc === 43 || oc === 45) {                   // local_time ends in +HHMM / -HHMM: learn the Mac's UTC offset
          const om = (oc === 45 ? -1 : 1) * (d2(s, t1 - 4) * 60 + d2(s, t1 - 2));
          if (om === om) {
            if (t !== t) t = isoAt(s, p) - om * 60000;
            if (om !== src.lastOm && t === t) { src.lastOm = om; ds.zone.push([t, om]); }
          }
        }
        src.push(off, e - p, t, lvl.id(fld(s, t2 + 1, t3)), proc.id(fld(s, t3 + 1, t4)), fld(s, t4 + 1, t5) | 0,
          sub.id(fld(s, t6 + 1, t7)), cat.id(fld(s, t7 + 1, t8)), maskOf(fld(s, t8 + 1, t9)));
      },
      fields(text) {
        const f = text.split('\t');
        return { msg: unescTsv(f.slice(9).join('\t')), extra: { 'Local time': f[0], Sender: f[5] } };
      },
    };
  }

  function unifiedJson(ds) {                            // raw `log --style ndjson` lines (collector ran without jq)
    const { lvl, proc, sub, cat } = ds.dict;
    const bit = (name) => 1 << ds.tagId(name);
    return {
      kind: 'unified', group: 'macOS unified log', short: 'unified',
      line(src, s, p, e, off) {
        if (s.charCodeAt(p) !== 123) { if (s.charCodeAt(p) !== 0) src.extend(off + e - p); return; }
        let j;
        try { j = JSON.parse(s.substring(p, e)); } catch (err) { return; }
        if (!j || typeof j.timestamp !== 'string') return;
        const ts = j.timestamp, om = offStr(ts.slice(-5));
        let t = isoAt(ts, 0);
        if (om === om) { t -= om * 60000; if (om !== src.lastOm && t === t) { src.lastOm = om; ds.zone.push([t, om]); } }
        // A field is text only when the file says so as text: a number or a list where a name is expected is taken
        // as written, never called as a string (one such line used to stop the whole bundle from opening)
        const image = str(j.processImagePath), name = basename(image), m = str(j.eventMessage);
        let tags = 0;
        if (name === 'Microsoft Excel') tags |= bit('excel');
        else {
          if (image.includes('/Microsoft Excel.app/')) tags |= bit('excel-helper');
          if (/excel/i.test(m)) tags |= bit('mentions-excel');
        }
        if (name === 'Microsoft Error Reporting' || name === 'Microsoft AutoUpdate' || name === 'Microsoft Update Assistant') tags |= bit('microsoft');
        // The kernel, spindump, ReportCrash and osanalyticshelper are taken by what a process cannot choose (process ID 0,
        // the program's full path), as the collector takes them: any process can be named like them
        if (image === '/usr/sbin/spindump') tags |= bit('hang-report');
        if (((image === '/kernel' || j.processID === 0) && /memorystatus|jetsam|compressor|swap/i.test(m))
          || ((image === '/System/Library/CoreServices/ReportCrash' || image === '/System/Library/CoreServices/osanalyticshelper') && /jetsam/i.test(m))) tags |= bit('memory');
        // Why the Mac last shut down is taken only from the kernel (its program is /kernel, its process ID 0), as the
        // collector takes it: any process can log the same words
        if ((image === '/kernel' || j.processID === 0) && /previous shutdown cause/i.test(m)) tags |= bit('restart');
        if (j.eventType === 'lossEvent') tags |= bit('logs-dropped');
        const pid = (typeof j.processID === 'number' ? j.processID : parseInt(str(j.processID), 10)) | 0;
        src.push(off, e - p, t, lvl.id(str(j.messageType) || str(j.eventType)), proc.id(name), pid, sub.id(str(j.subsystem)), cat.id(str(j.category)), tags);
      },
      fields(text) {
        try {
          const j = JSON.parse(text);
          return { msg: str(j.eventMessage), extra: { 'Local time': str(j.timestamp), Sender: basename(str(j.senderImagePath)), 'Process path': str(j.processImagePath) } };
        } catch (err) { return { msg: text, extra: {} }; }
      },
    };
  }

  function officeUls(ds, path) {                        // Office's own diagnostics: Timestamp Process TID Area Category EventID Level Message Correlation
    const { lvl, proc, sub, cat } = ds.dict;
    const app = (/Diagnostics\/([^/]+)\//i.exec(path) || [0, 'Office'])[1];
    const nice = app.charAt(0).toUpperCase() + app.slice(1).toLowerCase();
    return {
      kind: 'office', group: `${nice} diagnostics`, short: nice.toLowerCase(),
      line(src, s, p, e, off) {
        const c = s.charCodeAt(p);
        if (c < 48 || c > 57 || s.charCodeAt(p + 2) !== 47) { if (c !== 0 && !s.startsWith('Timestamp\t', p)) src.extend(off + e - p); return; }
        let t = ymd(d2(s, p + 6) * 100 + d2(s, p + 8), d2(s, p), d2(s, p + 3)) + d2(s, p + 11) * 3600000 + d2(s, p + 14) * 60000 + d2(s, p + 17) * 1000;
        if (s.charCodeAt(p + 19) === 46) t += d2(s, p + 20) * 10 + s.charCodeAt(p + 22) - 48;
        const t1 = tab(s, p, e), t2 = tab(s, t1 + 1, e), t3 = tab(s, t2 + 1, e), t4 = tab(s, t3 + 1, e), t5 = tab(s, t4 + 1, e),
          t6 = tab(s, t5 + 1, e), t7 = tab(s, t6 + 1, e);
        let name = fld(s, t1 + 1, t2), pid = 0;
        const k = name.indexOf(' (0x');
        if (k > 0) { pid = parseInt(name.substring(k + 4), 16) | 0; name = name.substring(0, k); }
        if (name === 'EXCEL') name = 'Microsoft Excel';   // what macOS calls the same process, so one filter covers both logs
        src.push(off, e - p, t, lvl.id(fld(s, t6 + 1, t7)), proc.id(name), pid, sub.id(fld(s, t3 + 1, t4)), cat.id(fld(s, t4 + 1, t5)), 0);
      },
      fields(text) {
        const f = text.split('\t');
        return { msg: f.slice(7, Math.max(8, f.length - 1)).join('\t'), extra: { 'Thread (TID)': f[2], 'Event ID': f[5], Correlation: f.length > 8 ? f[f.length - 1] : '' } };
      },
    };
  }

  // Tags worked out from what an entry says, in every source, so they also appear in bundles collected before the
  // collector wrote them. Keep in step with TAG_PERMISSIONS_RX and TAG_STORAGE_RX in excel_diagnostics.sh.
  // Both look for refusals and failures, not the bare words: "storage" alone is mostly cookie stores and telemetry
  // names. Entries from tccd (the macOS privacy-permission service) are tagged permissions by process, in indexSource.
  // A collector that writes these tags itself says so in manifest.tsv, and its unified-log .tsv files are then taken
  // as they are: those are the files that reach gigabytes, and working the tags out again would double their load time.
  const CONTENT_TAGS = [
    ['permissions', /kTCCService|\bdeny\(|denied\b|\bforbidden\b|not permitted|not authori[sz]ed|unauthori[sz]ed|(?:unsatisfied|missing|requires|have|without) entitlement|\bEPERM\b|\bEACCES\b|NSCocoaErrorDomain Code=(?:257|513)\b/i],
    ['storage', /no space left|\bENOSPC\b|(?:disk|volume|device) (?:is |was )?(?:almost |nearly )?full|\b(?:out of|low on|not enough|insufficient|low) (?:disk |free |storage )?space|quota exceeded|input\/output error|\bI\/O error|read-only file ?system|NSCocoaErrorDomain Code=(?:640|642)\b|NSPOSIXErrorDomain Code=(?:5|28|30|69)\b|0x800[37]0070\b/i],
  ];
  // Running those two over every log would triple the time to open a bundle. These find candidates first: a short
  // piece of each phrase that starts on an uncommon character, so the regex engine can skip ahead quickly, with a
  // look-behind where the piece alone is common ("space", "full"). Only the few hundred entries they find get the
  // real test above. They are split in two because one long alternation ran slower than two shorter ones in V8.
  // Every phrase above needs a piece here; test/core_test.js checks that each one is found.
  const CONTENT_HINTS = [
    /y\((?<=\b[dD]eny\()|[dD]enied\b|[pP]ermitted(?<=[nN]ot permitted)|uthori[sz]ed(?<=(?:[nN]ot a|[uU]na)uthori[sz]ed)|ntitlement(?<=(?:[uU]nsatisfied|[mM]issing|[rR]equires|have|[wW]ithout) [eE]ntitlement)|Code=\d+\b(?<=NSCocoaErrorDomain Code=(?:257|513|640|642)|NSPOSIXErrorDomain Code=(?:5|28|30|69))|[fF]ull\b(?<=(?:[dD]isk|[vV]olume|[dD]evice) (?:is |was )?(?:almost |nearly )?full)|[qQ]uota exceeded|put\/output error|-only file ?system/g,
    /kTCC|bidden\b(?<=\b[fF]orbidden)|(?:PERM|ACCES|NOSPC)\b(?<=\bE(?:PERM|ACCES|NOSPC))|pace\b(?<=(?:[oO]ut of|[lL]ow on|[nN]ot enough|[iI]nsufficient|[lL]ow) (?:disk |free |storage )?space|[nN]o space)|I\/O error|800[37]0070\b/g,
  ];

  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const RX_KINDS = [
    { kind: 'autoupdate', group: 'Microsoft AutoUpdate', short: 'autoupdate', need: 0.6,
      rx: /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \[([^\]]*)\] <(\w+)> /,
      map: (m) => ({ t: isoAt(m[1], 0), proc: m[2], lvl: m[3] }) },
    { kind: 'onedrive', group: 'OneDrive', short: 'onedrive', need: 0.6,
      rx: /^(\d\d)-(\d\d)-(\d\d),(\d\d:\d\d:\d\d\.\d{3}),\d*,[^,]*,[^,]*,([^,]*),[^,]*,[^,]*,(\w*),/,
      map: (m) => ({ t: isoAt(`20${m[3]}-${m[1]}-${m[2]} ${m[4]}`, 0), om: 0, proc: 'OneDrive', sub: m[5].replace(/\(\d+\)$/, ''), lvl: m[6] }) },
    { kind: 'install', group: 'Install history', short: 'install', need: 0.6, zone: true,
      rx: /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)([-+]\d\d) \S+ ([^\[:]+)(?:\[(\d+)\])?: /,
      map: (m) => ({ t: isoAt(m[1], 0), om: offStr(m[2]), proc: m[3], pid: +m[4] || 0 }) },
    { kind: 'power', group: 'Sleep / wake', short: 'power', need: 0.6, zone: true,
      rx: /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([-+]\d{4}) (Wake Requests|\S+)\s*/,       // "Wake Requests" is a list of scheduled wakes, not a wake
      map: (m) => ({ t: isoAt(m[1], 0), om: offStr(m[2]), proc: 'powerd', cat: m[3], lvl: 'Default' }) },
    { kind: 'text', group: 'Other logs', short: '', need: 0.6,
      rx: /^\[?(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:[.,]\d+)?)(Z|\s?[-+]\d\d:?\d\d(?!\d))?\]?[ \t:|-]*/,
      map(m, head) {
        const lv = /\b(fatal|critical|error|warn(?:ing)?|info|notice|debug|trace|verbose)\b/i.exec(head.substr(m[0].length, 80));
        return { t: isoAt(m[1].replace(',', '.'), 0), om: m[2] ? (m[2] === 'Z' ? 0 : offStr(m[2].trim())) : undefined, lvl: lv ? cap1(lv[1]) : '' };
      } },
  ];
  function rxKind(ds, spec, path) {                     // logs whose lines start with a timestamp matched by a regex
    const D = ds.dict;
    return {
      kind: spec.kind, group: spec.group, short: spec.short || basename(path),
      line(src, s, p, e, off) {
        const head = s.substring(p, Math.min(e, p + 300)), m = spec.rx.exec(head);
        if (!m) { if (s.charCodeAt(p) !== 0) src.extend(off + e - p); return; }
        const r = spec.map(m, head);
        if (r.om === undefined) r.t = -r.t;             // local time without an offset: stored negative, fixed up once the Mac's zone is known
        else if (r.om === r.om) { r.t -= r.om * 60000; if (spec.zone && r.om !== src.lastOm && r.t === r.t) { src.lastOm = r.om; ds.zone.push([r.t, r.om]); } }
        src.push(off, e - p, r.t, D.lvl.id(r.lvl || ''), D.proc.id(r.proc || ''), r.pid | 0, D.sub.id(r.sub || ''), D.cat.id(r.cat || ''), 0);
      },
      fields(text) { const m = spec.rx.exec(text); return { msg: m ? text.slice(m[0].length) : text, extra: {} }; },
    };
  }

  function reportKind(ds) {                             // one synthetic row per crash/hang/diag report in the bundle
    const D = ds.dict;
    return {
      kind: 'report', group: 'Crash and hang reports', short: 'report',
      line(src, s, p, e, off) {
        const t1 = tab(s, p, e), t2 = tab(s, t1 + 1, e), t3 = tab(s, t2 + 1, e);
        src.push(off, e - p, isoAt(s, p), D.lvl.id(fld(s, t1 + 1, t2)), D.proc.id(fld(s, t2 + 1, t3)), 0, 0, D.cat.id('report'), 0);
      },
      fields(text) {
        const f = text.split('\t');
        return { msg: `${f[1]}: ${basename(f[3] || '')}${f[4] ? ' - ' + f[4] : ''}`, extra: { file: f[3] } };
      },
    };
  }

  // Where a collector writes the three kinds of log that speak for the system
  const OWN_PLACE = {
    unified: /^(?:unified_logs\/[^/]+|unified_last30m|repro\/unified_live_unfiltered)\.(?:tsv|ndjson)$/,
    power: /^system\/sleep_wake\.txt$/,
    install: /^system\/install_history_microsoft\.txt$/,
  };
  // Where a collector puts the reports that only macOS writes: its copies of the system's own report folders
  const SYSTEM_REPORTS = /^reports\/Library_Logs_DiagnosticReports(?:_Retired)?\/[^/]+$/;
  // How much of a CrashReporter file written out as text is read for its ForceQuitDate lines (addReports)
  const FORCE_QUIT_READ = 65536;
  function sniffText(ds, path, head) {                  // a log with times at the start of its lines, of no particular kind, or nothing
    const spec = RX_KINDS[RX_KINDS.length - 1], lines = head.split(/\r?\n/).filter(Boolean).slice(0, 25);
    const hits = lines.filter((l) => spec.rx.test(l)).length;
    return lines.length && hits >= Math.max(1, Math.ceil((lines.length - 1) * spec.need)) ? rxKind(ds, spec, path) : null;
  }
  function sniff(ds, path, head) {
    if (head.startsWith('local_time\tutc_time\t')) return unifiedTsv(ds);
    if (head.startsWith('Timestamp\tProcess\tTID\t') || /^\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d\.\d{3}\t/.test(head)) return officeUls(ds, path);
    const lines = head.split(/\r?\n/).filter(Boolean).slice(0, 25);
    if (!lines.length) return null;
    if (lines[0][0] === '{' && /"timestamp"\s*:/.test(lines[0]) && /"(eventMessage|processImagePath|eventType)"\s*:/.test(lines[0])) return unifiedJson(ds);
    for (const spec of RX_KINDS) {
      const hits = lines.filter((l) => spec.rx.test(l)).length;
      if (hits >= Math.max(1, Math.ceil(lines.length * spec.need))) return rxKind(ds, spec, path);
    }
    return null;
  }

  // Where the bundle is among the paths given. A collector's bundle is the folder with manifest.tsv or bundle_info.tsv
  // at its top. It may sit inside folders that hold nothing else (a folder picked one level up, a zip unpacked into a
  // folder of its own), and beside it at each level may lie the zip the collector made of it and that zip's
  // checksum. Returns the folder's path with its closing slash ('' when the files were given with no folder), the
  // numbers of the packaging files beside it, and how many of those are zips; or null when no such folder is found.
  function bundleFolder(paths) {
    const aside = new Set();
    let prefix = '', zips = 0;
    for (let depth = 0; depth < 8; depth++) {
      let folder = null, own = false, several = false;
      const beside = [];
      for (let i = 0; i < paths.length; i++) {
        if (aside.has(i)) continue;
        const rest = paths[i].slice(prefix.length), cut = rest.indexOf('/');
        if (cut < 0) { if (rest === 'manifest.tsv' || rest === 'bundle_info.tsv') own = true; else beside.push(i); }
        else if (folder === null) folder = rest.slice(0, cut);
        else if (folder !== rest.slice(0, cut)) several = true;
      }
      if (own) return { prefix, aside, zips };
      // Only one folder is stepped into, and only past packaging: among several folders, or beside other files, none is singled out
      if (folder === null || several || !beside.every((i) => /\.zip(?:\.sha256)?$/i.test(paths[i]))) return null;
      for (const i of beside) { aside.add(i); if (/\.zip$/i.test(paths[i])) zips++; }
      prefix += folder + '/';
    }
    return null;
  }

  // ---------- dataset ----------
  class Dataset {
    constructor() {
      this.dict = { lvl: new Dict(250), proc: new Dict(65000), sub: new Dict(65000), cat: new Dict(65000) };
      this.tagNames = []; this.zone = []; this.entries = []; this.sources = []; this.reportList = [];
      this.run = 0; this.textCache = null; this.view = new Uint32Array(0); this.lastBlob = null;
      this.collector = false; this.unread = 0;
    }
    tagId(name) {
      let i = this.tagNames.indexOf(name);
      if (i < 0) { if (this.tagNames.length >= 16) return 15; i = this.tagNames.push(copyStr(name)) - 1; }
      return i;
    }
    zoneAt(t) {                                         // the Mac's UTC offset (minutes) at UTC time t
      const z = this.zone;
      if (!z.length) return -new Date(t).getTimezoneOffset();
      let lo = 0, hi = z.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (z[m][0] <= t) lo = m + 1; else hi = m; }
      return z[Math.max(0, lo - 1)][1];
    }
    localToUtc(t) { return t - this.zoneAt(t - this.zoneAt(t) * 60000) * 60000; }

    async load(inputs, progress) {
      // inputs: [{path, blob}] - one zip, or the files of an unzipped bundle, or loose log files.
      // loose: true marks a zip that is known to be one of a bundle's own files, to be listed and not opened.
      // What macOS and its Finder leave in folders and zips: set aside before anything is decided from the names given.
      // .localized marks Desktop, Documents and Downloads; "Icon" and a carriage return holds a folder's own icon.
      const clutter = /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$|\.localized$|Icon\r$)/;
      const given = inputs.filter((f) => !clutter.test(f.path)), notes = [];
      const asEntry = (f) => new Entry(f.path.replace(/^\/+/, ''), f.blob.size, f.blob);
      // The collector leaves three things side by side: the bundle's folder, its zip and the zip's checksum. Given
      // together, or inside the folder that holds them, the folder is the bundle and the other two are set aside.
      let zips = [], name, found = bundleFolder(given.map((f) => f.path.replace(/^\/+/, '')));
      if (found) this.entries = given.filter((f, i) => !found.aside.has(i)).map(asEntry);
      else {
        // A zip is the bundle only when it was given by itself, or with nothing beside it but its checksum. A zip among
        // other files is one of those files: a bundle can hold a zip that was lying in a folder the collector copied,
        // and opening that in place of the bundle would show whatever its writer chose under the bundle's name.
        const zipsGiven = given.filter((f) => !f.loose && /\.zip$/i.test(f.path));
        if (zipsGiven.length > 1 && zipsGiven.length === given.length) throw new Error('Open one bundle at a time (several .zip files were given).');
        const beside = zipsGiven.length === 1 ? `${basename(zipsGiven[0].path)}.sha256`.toLowerCase() : '';
        zips = zipsGiven.length === 1 && given.every((f) => f === zipsGiven[0] || basename(f.path).toLowerCase() === beside) ? zipsGiven : [];
        if (zips.length === 1) {
          progress({ phase: 'Reading the zip directory' });
          const file = zips[0].blob;
          name = basename(zips[0].path).replace(/\.zip$/i, '');
          for (const e of await readZip(file)) if (!clutter.test(e.path)) this.entries.push(new Entry(e.path, e.size, null, { file, e }));
          found = bundleFolder(this.entries.map((en) => en.path));        // the same, for a zip made of that folder
          if (found) this.entries = this.entries.filter((en, i) => !found.aside.has(i));
        } else this.entries = given.map(asEntry);
      }
      if (!this.entries.length) throw new Error('No files found in what was dropped.');
      if (found) {
        for (const en of this.entries) en.path = en.path.slice(found.prefix.length);
        const folder = basename(found.prefix.slice(0, -1));
        if (folder && (!name || /^Excel_Diagnostics/.test(folder))) name = folder;
        if (found.aside.size) {
          // Counts only: a note is read as this tool's own sentence, so it carries no name taken from the bundle
          const nz = found.zips, ns = found.aside.size - nz, n = found.aside.size;
          const what = [nz && `${nz} .zip file${nz === 1 ? '' : 's'}`, ns && `${ns} checksum file${ns === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
          notes.push(`This bundle was read from its folder. ${what} that came with it ${n === 1 ? 'was' : 'were'} not opened and ${n === 1 ? 'is' : 'are'} not among the files shown.`);
        }
      } else {
        const root = this.entries[0].path.split('/')[0] + '/';       // strip the top-level folder everything is in
        if (this.entries.length > 1 ? this.entries.every((en) => en.path.startsWith(root)) : this.entries[0].path.startsWith(root)) {
          for (const en of this.entries) en.path = en.path.slice(root.length);
          if (!name || /^Excel_Diagnostics/.test(root)) name = root.slice(0, -1);
        }
      }
      this.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      this.name = name || (this.entries.length === 1 ? this.entries[0].path : 'Log files');

      // Which files are logs with timestamps? Decide from each candidate's first bytes.
      const paths = new Set(this.entries.map((en) => en.path));
      const collector = this.collector = paths.has('manifest.tsv') || paths.has('bundle_info.tsv');
      let skippedBaseline = 0;
      progress({ phase: 'Looking for log files' });
      for (const en of this.entries) {
        if (!en.size || !/\.(tsv|ndjson|log|txt)$|\.log\.[^/]*$/i.test(en.path)) continue;
        if (en.path.startsWith('repro/baseline/') && paths.has('repro/final/' + en.path.slice(15))) { skippedBaseline++; continue; }
        const head = LATIN1.decode(await en.head(4096));
        let parser = sniff(this, en.path, head);
        // In a collector's bundle the place decides what a file may be. The macOS log, the sleep and wake history and
        // the install history are what the collector wrote where it writes them. A file anywhere else that looks like
        // one of them was lying in a folder the collector copied: it is an ordinary log under its own name, and the
        // Mac's time zone is not learned from it.
        if (parser && collector && OWN_PLACE[parser.kind] && !OWN_PLACE[parser.kind].test(en.path)) parser = sniffText(this, en.path, head);
        if (parser) this.sources.push(new Source(this.sources.length, en, parser));
      }
      if (skippedBaseline) notes.push(`${skippedBaseline} log file(s) under repro/baseline are not on the timeline because repro/final holds a later copy of the same file.`);

      const manifest = this.entries.find((en) => en.path === 'manifest.tsv');
      this.collectorTags = !!manifest && /^unified_log_tags\t[^\n]*\bpermissions\b[^\n]*\bstorage\b/m.test(LATIN1.decode(await manifest.head(16384)));
      this.store = zips.length ? await openStore() : null;
      const total = this.sources.reduce((a, s) => a + s.entry.size, 0);
      let done = 0;
      for (const src of this.sources) {
        await this.indexSource(src, (n) => { done += n; progress({ phase: 'Indexing', label: src.path, done, total }); });
      }
      this.zone.sort((a, b) => a[0] - b[0]);
      this.zone = this.zone.filter((z, i, all) => !i || z[1] !== all[i - 1][1]);     // keep only the moments the offset changed
      await this.addReports();
      if (this.unread) notes.push(`${this.unread} line${this.unread === 1 ? '' : 's'} in this bundle's logs could not be read as ${this.unread === 1 ? 'an entry' : 'entries'} and ${this.unread === 1 ? 'is' : 'are'} not on the timeline.`);
      progress({ phase: 'Merging the timeline' });
      this.finalize();
      {                                                   // each report's own row, so the page can go straight to it
        const rs = this.sources.find((s) => s.parser.kind === 'report'), G = this.g;
        if (rs) for (let i = 0; i < G.n; i++) if (G.F[i] === rs.id && this.reportList[G.R[i]]) this.reportList[G.R[i]].pos = i;
      }
      // When the bundle was collected, if it says. A time written without an offset can only be placed when the logs
      // give the Mac's zone; without that it is left out, not guessed from the zone of whoever is looking.
      const peek = async (path) => { const en = this.entries.find((e) => e.path === path); return en && en.size ? UTF8.decode(await en.head(16384)) : ''; };
      const utc = /^collected_utc\t(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/m.exec(await peek('bundle_info.tsv'));
      const said = /^- Collected:\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/m.exec(await peek('summary.md'));
      this.collected = utc ? isoAt(utc[1], 0) : said && this.zone.length ? this.localToUtc(isoAt(said[1], 0)) : NaN;
      this.end = this.collected > this.t1 && this.g.n ? this.collected : this.t1;      // all time runs to the collection, so its mark can be seen
      const odl = this.entries.filter((en) => /\.(odl|odlgz|odlsent|aodl)$/i.test(en.path)).length;
      const offsets = [...new Set(this.zone.map((z) => z[1]))];
      if (offsets.length > 1) {
        const name = (om) => `UTC${om < 0 ? '-' : '+'}${String(Math.abs(om) / 60 | 0).padStart(2, '0')}:${String(Math.abs(om) % 60).padStart(2, '0')}`;
        notes.push(`The Mac's clock changed UTC offset during this period (${offsets.map(name).join(', ')}), from daylight saving or a time zone change. Local times can appear to jump backwards or forwards at those moments; switch "Times in" to UTC for a steady clock.`);
      }
      if (this.store && this.store.diskBytes) {
        notes.push(`To make them searchable, ${(this.store.diskBytes / 1073741824).toFixed(1)} GB of logs from the zip were unpacked into this browser's private storage for this page. They are deleted when you open another bundle or next open this page. Dropping the unzipped folder instead avoids the copy.`);
      }
      if (odl) notes.push(`${odl} OneDrive .odl/.odlgz/.odlsent/.aodl files are in Microsoft's obfuscated binary format; they are listed under Files but cannot be searched here.`);
      return this.info(notes);
    }

    async indexSource(src, onBytes) {
      const parser = src.parser, D = this.dict;
      let carry = null, base = 0, pend = [], pendLen = 0;
      const flush = (final) => {
        if (carry) { pend.unshift(carry); pendLen += carry.length; carry = null; }
        if (!pendLen) return;
        const buf = pend.length === 1 ? pend[0] : concat(pend, pendLen);
        pend = []; pendLen = 0;
        const s = LATIN1.decode(buf), n = s.length;
        let p = 0;
        const first = src.n;                              // entries from here on start in this chunk
        for (;;) {
          let e = s.indexOf('\n', p);
          if (e < 0) { if (!final || p >= n) break; e = n; }
          // A line the parser cannot get through is left out and counted. It does not stop the file, or the bundle,
          // from opening: load() says how many there were.
          if (e > p) { try { parser.line(src, s, p, e, base + p); } catch (err) { if (err && err.noRoom) throw err; this.unread++; } }
          p = e + 1;
          if (p >= n) { p = Math.min(p, n); break; }
        }
        // Content tags. tccd and its subsystem log nothing but privacy-permission decisions.
        const work = src.n > 0 && !(parser.tagged && this.collectorTags);
        const tccd = D.proc.map.get('tccd'), tcc = D.sub.map.get('com.apple.TCC');
        if (work && (tccd !== undefined || tcc !== undefined)) {
          for (let r = first; r < src.n; r++) if (src.proc[r] === tccd || (tcc !== undefined && src.sub[r] === tcc)) src.tags[r] |= 1 << this.tagId('permissions');
        }
        for (const hint of work ? CONTENT_HINTS : []) {
          let row = Math.max(0, first - 1);               // a continuation line can belong to the previous chunk's last entry
          hint.lastIndex = 0;
          for (let m; (m = hint.exec(s)) && m.index < p;) {
            const at = base + m.index;
            if (at < src.off[row]) continue;              // before the first entry: a header line
            while (row + 1 < src.n && src.off[row + 1] <= at) row++;
            const a = src.off[row] - base, b = Math.min(p, a + src.len[row]);
            if (m.index < b) {
              const text = s.substring(Math.max(0, a), b);
              for (const [name, rx] of CONTENT_TAGS) if (rx.test(text)) src.tags[row] |= 1 << this.tagId(name);
            }
            hint.lastIndex = Math.max(b, m.index + 1);
          }
        }
        if (p < n) carry = buf.slice(p);
        base += p;
      };
      for await (const chunk of src.entry.chunks(true, this.store)) {
        pend.push(chunk); pendLen += chunk.length; onBytes(chunk.length);
        if (pendLen >= 4 << 20) flush(false);
      }
      flush(true);
      for (const k of ['off', 'len', 't', 'lvl', 'proc', 'pid', 'sub', 'cat', 'tags']) src[k] = src[k].slice(0, src.n);
      src.cap = src.n;
    }

    // Lays one crash, hang or other diagnostic report out as it was recorded: labelled facts from its header, the stack
    // the report itself singles out (the thread it marks as crashed, or a hang's heaviest stack), and the images it
    // lists. `what` is the short form that goes on the timeline, so those recorded words can be searched for there.
    // Nothing is added to what the report says, and nothing in it is named as a cause.
    // In a collector's bundle the place decides here too, for what only the collector or only the system writes.
    // The collector's hang mode writes its capture of Excel at the top of the bundle: a file of that name in a folder
    // that was copied from the Mac is not that capture, and is an ordinary file. Jetsam and panic reports are written
    // by macOS into the system's report folder, which the collector copies to reports/Library_Logs_DiagnosticReports
    // (and ..._Retired): a file anywhere else that says it is one is listed as a report of no particular kind.
    // Both patterns below have one group, the capture's kind.
    captureAt(path) { return (this.collector ? /^excel_(spindump|sample)\.txt$/i : /(?:^|\/)excel_(spindump|sample)\.txt$/i).exec(path); }
    isReport(path) { return /\.(ips|crash|diag|hang|spin|panic|shutdownstall)$/i.test(path) || !!this.captureAt(path); }
    async readReport(en, cap = 8 << 20) {
      const file = basename(en.path), ext = (/\.(ips|crash|diag|hang|spin|panic|shutdownstall)$/i.exec(en.path) || [0, ''])[1].toLowerCase();
      const capture = this.captureAt(en.path);            // taken by the collector's hang mode
      let text = UTF8.decode(await en.head(8192));
      const json = text[0] === '{';
      if (en.size > 8192) text = UTF8.decode(await en.head(json ? cap : Math.min(cap, 1 << 20)));    // a JSON body has to be read whole to be read at all
      const out = { path: en.path, t: NaN, proc: '', what: [], facts: [], stack: null, images: [], size: en.size, read: Math.min(en.size, json ? cap : Math.min(cap, 1 << 20)), headerOnly: false,
        kind: capture ? cap1(capture[1]) : { ips: 'Report', crash: 'Crash', diag: 'Diag', hang: 'Hang', spin: 'Spin', panic: 'Panic', shutdownstall: 'Hang' }[ext] || 'Report' };
      // A value that cannot be made into text (a list nested past what String() can follow) is left out with its fact.
      // Every value read from the report's JSON has had what is nested past JSON_DEPTH in it taken out (shallow), so
      // this is a second guard only.
      const asText = (v) => { try { return String(v); } catch (err) { return ''; } };
      const fact = (label, value) => { value = value == null || value === false ? '' : asText(value).replace(/\s+/g, ' ').trim(); if (value) out.facts.push([label, value]); return value; };
      const join = (...parts) => parts.filter(Boolean).join(' ');
      const stampOf = (str) => { const m = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?) ?([-+]\d{4})/.exec(str || ''); return m ? isoAt(m[1], 0) - offStr(m[2]) * 60000 : NaN; };
      let body = text, parsed = null;
      if (json) {                                         // a one-line JSON header, then a JSON body (crash, jetsam) or a text one
        const nl = text.indexOf('\n');
        let h = null;
        try { h = shallow(JSON.parse(nl > 0 ? text.slice(0, nl) : text)); } catch (err) { /* not a header after all */ }
        if (h && typeof h === 'object') {
          body = nl > 0 ? text.slice(nl + 1) : '';
          out.t = stampOf(h.timestamp); out.proc = h.app_name || h.name || '';
          if (h.bug_type === '309' || h.bug_type === '109') out.kind = 'Crash';
          else if (h.bug_type === '298') out.kind = 'Jetsam';
          else if (h.bug_type === '288' || h.bug_type === '388') out.kind = 'Hang';
          if (h.bug_type) out.what.push(`bug type ${h.bug_type}`);
          if (h.app_version) out.what.push(`version ${h.app_version}`);
          if (h.os_version) out.what.push(h.os_version);
          fact('Report time', h.timestamp); fact('Report type', h.bug_type && `bug type ${h.bug_type}`);
          fact('App', join(h.app_name || h.name, h.app_version && `version ${h.app_version}`, h.build_version && `(${h.build_version})`));
          fact('macOS', h.os_version);
          if (out.read >= en.size) { try { parsed = shallow(JSON.parse(body)); } catch (err) { /* a text body, handled below */ } }
          else if (/^\s*\{/.test(body)) { out.headerOnly = true; body = ''; }      // a JSON body too large to read whole: only its header line is laid out
        }
      }
      if (parsed && typeof parsed === 'object') {
        const b = parsed, ex = b.exception || {}, term = b.termination || {}, bi = b.bundleInfo || {};
        const threads = Array.isArray(b.threads) ? b.threads : [], imgs = Array.isArray(b.usedImages) ? b.usedImages : [];
        const who = (name, pid) => (name ? `${name}${pid != null ? ` [${pid}]` : ''}` : '');
        fact('Process', who(b.procName, b.pid)); fact('Path', b.procPath);
        fact('Version', join(bi.CFBundleShortVersionString, bi.CFBundleVersion && `(${bi.CFBundleVersion})`)); fact('Identifier', bi.CFBundleIdentifier);
        fact('Launched', b.procLaunch); fact('Captured', b.captureTime);
        fact('Mac model', b.modelCode); fact('Processor type', b.cpuType);
        if ('translated' in b) fact('Running under Rosetta', b.translated ? 'yes' : 'no');
        fact('Parent process', who(b.parentProc, b.parentPid)); fact('Responsible process', who(b.responsibleProc, b.responsiblePid));
        fact('Exception type', join(ex.type, ex.signal && `(${ex.signal})`)); fact('Exception subtype', ex.subtype); fact('Exception codes', ex.codes);
        fact('Termination', [term.namespace && `namespace ${term.namespace}`, term.code != null && `code ${term.code}`, term.indicator].filter(Boolean).join(', '));
        fact('Termination reasons', Array.isArray(term.reasons) ? term.reasons.join('; ') : '');
        fact('Terminated by', who(term.byProc, term.byPid));
        if (b.asi && typeof b.asi === 'object') fact('Application-specific information', Object.entries(b.asi).map(([lib, said]) => `${lib}: ${[].concat(said).join(' ')}`).join(' | '));
        const ft = Number.isInteger(b.faultingThread) ? b.faultingThread : threads.findIndex((t) => t && t.triggered), th = threads[ft];
        const str = (v) => (v == null ? '' : String(v)), image = (im) => str((im || {}).name) || basename(str((im || {}).path));
        out.images = imgs.slice(0, 3000).map((im) => ({ name: image(im), path: str((im || {}).path), version: str((im || {}).CFBundleShortVersionString), id: str((im || {}).CFBundleIdentifier), arch: str((im || {}).arch) }));
        if (th && typeof th === 'object') {
          // A crash report says which thread crashed. Other reports of the same shape only name a thread, so the page does no more.
          const crash = out.kind === 'Crash';
          fact(crash ? 'Thread marked as crashed' : 'Thread the report names', [String(ft), th.name && `"${th.name}"`, th.queue && `queue ${th.queue}`].filter(Boolean).join(', '));
          const all = Array.isArray(th.frames) ? th.frames : [];
          out.stack = { title: crash ? `Thread ${ft}, the one the report marks as crashed` : `Thread ${ft}, the one the report names`, more: Math.max(0, all.length - 200), frames: all.slice(0, 200).map((fr) => {
            const f = fr && typeof fr === 'object' ? fr : {};
            return { image: image(imgs[f.imageIndex]) || '?', symbol: str(f.symbol), offset: f.symbol ? (f.symbolLocation != null ? `+ ${f.symbolLocation}` : '') : (f.imageOffset != null ? `+ ${f.imageOffset}` : ''),
              source: f.sourceFile ? `${f.sourceFile}${f.sourceLine ? `:${f.sourceLine}` : ''}` : '' };
          }) };
        }
        if (threads.length) fact('Threads in the report', threads.length);
        if (imgs.length) fact('Images listed', imgs.length);
        if (b.largestProcess) { fact('Largest process, as recorded', b.largestProcess); out.what.push(`largest process ${b.largestProcess}`); }
        if (Array.isArray(b.processes)) fact('Processes listed', b.processes.length);
        if (ex.type) out.what.push(join(ex.type, ex.signal && `(${ex.signal})`));
        if (ex.subtype) out.what.push(String(ex.subtype));
        if (term.indicator) out.what.push(String(term.indicator));
        if (out.stack && out.stack.frames.length) out.what.push(`thread ${ft}: ${out.stack.frames.slice(0, 6).map((f) => f.symbol || f.image).join(' < ')}`);
      } else if (body) {                                  // a text report: the header lines Apple's reports use, and the stack block it leads with
        const head = body.slice(0, 65536);
        const get = (key) => ((new RegExp(`^${key.replace('/', '\\/')}:[ \\t]+(.+)$`, 'm').exec(head) || [])[1] || '').trim();
        if (out.t !== out.t) out.t = stampOf(get('Date/Time'));
        if (!out.proc) out.proc = (get('Command') || get('Process')).replace(/(?<!\s)\s+\[\d+\]$/, '');
        for (const key of ['Process', 'Command', 'Path', 'Identifier', 'Version', 'Code Type', 'Architecture', 'Parent Process', 'Parent', 'Responsible', 'PID', 'Date/Time', 'End time', 'OS Version', 'Hardware model',
          'Event', 'Action taken', 'CPU', 'Wakeups', 'Writes', 'Duration', 'Steps', 'Crashed Thread', 'Exception Type', 'Exception Codes', 'Exception Note', 'Termination Reason', 'Terminating Process',
          'Time Awake Since Boot', 'Active cpus', 'Memory size', 'Free disk space', 'Advisory levels', 'Total CPU Time']) fact(key, get(key));
        for (const key of ['Event', 'Exception Type', 'Termination Reason', 'Action taken', 'Duration', 'Crashed Thread']) { const v = get(key).replace(/\s+/g, ' '); if (v) out.what.push(`${key}: ${v}`); }
        const start = /^Thread \d+ Crashed.*$|^[ \t]*Heaviest stack for .*$|^Call graph:[ \t]*$/m.exec(body);
        if (start) {
          const rest = body.slice(start.index + start[0].length).replace(/^\r?\n/, ''), block = rest.slice(0, (/\r?\n[ \t]*\r?\n/.exec(rest) || { index: rest.length }).index).split(/\r?\n/);
          out.stack = { title: start[0].trim().replace(/:$/, ''), lines: block.slice(0, 150), more: Math.max(0, block.length - 150) };
          // A few of its lines go on the timeline, so that a function name shown here can be searched for there. A
          // crashed thread lists its innermost frame first; a heaviest stack and a call graph list it last.
          const few = (/^Thread/.test(start[0]) ? block.slice(0, 6) : block.slice(-6)).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
          if (few.length) out.what.push(`${out.stack.title}: ${few.join(' | ')}`.slice(0, 900));
        }
        // How many threads and images a text report lists, as a JSON one says it, counted line by line in what was
        // read: a thread is a "Thread N:" or "Thread N Crashed:" line of a crash report (each N once) or an indented
        // "Thread 0x..." line of a spindump, and an image is a line under a "Binary Images:" line, to the next empty one.
        const numbered = new Set();
        let spun = 0, images = 0, inImages = false;
        for (const l of body.split(/\r?\n/)) {
          if (inImages) { if (l.trim()) { images++; continue; } inImages = false; }
          const m = /^Thread (\d+)(?: Crashed)?:/.exec(l);
          if (m) numbered.add(m[1]);
          else if (/^\s+Thread 0x[0-9a-fA-F]+\b/.test(l)) spun++;
          else if (l.trim() === 'Binary Images:') inImages = true;
        }
        // Counted in what was read: when that is not the whole report, the label says so
        const part = out.read < en.size;
        if (numbered.size + spun) fact(part ? 'Threads in the part read' : 'Threads in the report', numbered.size + spun);
        if (images) fact(part ? 'Images listed in the part read' : 'Images listed', images);
      }
      if (/^JetsamEvent/i.test(file)) out.kind = 'Jetsam';
      if (/^(ExcessiveResource|.*\.(cpu|wakeups|diskwrites)_resource)/i.test(file)) out.kind = 'Diag';
      if (this.collector && (out.kind === 'Jetsam' || out.kind === 'Panic') && !SYSTEM_REPORTS.test(en.path)) out.kind = 'Report';
      if (out.t !== out.t) {                              // no time inside: use the one in the file name, which is in the Mac's local time
        const m = /(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)(\d\d)/.exec(file);
        if (m) out.t = this.localToUtc(isoAt(`${m[1]} ${m[2]}:${m[3]}:${m[4]}`, 0));
      }
      if (!out.proc) out.proc = capture ? 'Microsoft Excel' : file.replace(/[-_.]20\d\d-.*$/, '').replace(/\.[a-z]+$/i, '');
      return out;
    }
    async report(path) {                                // one report, for the page's Reports tab
      const en = this.entries.find((e) => e.path === path);
      if (!en) throw new Error(`There is no file ${path} in this bundle.`);
      if (this.isReport(path)) return this.readReport(en);
      const listed = this.reportList.find((r) => r.path === path) || {};
      return { path, t: listed.t, proc: listed.proc || '', kind: listed.kind || 'Report', what: [], facts: [], stack: null, images: [], size: en.size, read: en.size };
    }

    async addReports() {                                // crash, hang and diagnostic reports become timeline events
      const lines = [];
      const add = (t, kind, proc, path, what) => {
        if (t !== t) return;
        // One report is one line here, whatever its name, its process name or its path holds: a line break or a tab
        // in one of them would otherwise make a row of its own, with a time, a kind and a file of the writer's choosing
        const one = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
        what = one(what); kind = one(kind); proc = one(proc);
        lines.push(`${stamp(t)}\t${kind}\t${proc}\t${one(path)}\t${what}`);
        this.reportList.push({ t, kind, proc, path, what });      // also handed to the page, for its Reports tab and the marks on its charts
      };
      for (const en of this.entries) {
        const file = basename(en.path);
        if (this.isReport(en.path)) {
          let r;                                         // a report this cannot make sense of is still listed, by its file name
          try { r = await this.readReport(en); } catch (err) { r = null; }
          if (!r) {
            const m = /(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)(\d\d)/.exec(file);
            r = { t: m ? this.localToUtc(isoAt(`${m[1]} ${m[2]}:${m[3]}:${m[4]}`, 0)) : NaN, kind: 'Report', proc: file.replace(/[-_.]20\d\d-.*$/, '').replace(/\.[a-z]+$/i, ''), what: ['could not be read as a report'] };
          }
          add(r.t, r.kind, r.proc, en.path, r.what.join('; '));
        } else if (/CrashReporter\/[^/]+\.txt$/i.test(en.path)) {
          // One entry for each ForceQuitDate the file holds, each said as what it is among them: a file can hold several.
          // At most FORCE_QUIT_READ bytes of it are read, and what is said of a file longer than that is said of the part
          // read: the file can hold more times past it, and a later one.
          const text = UTF8.decode(await en.head(FORCE_QUIT_READ)), where = en.size > FORCE_QUIT_READ ? `in the first ${FORCE_QUIT_READ.toLocaleString('en-US')} bytes of this file` : 'this file records';
          const at = [...text.matchAll(/"ForceQuitDate" => (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([-+]\d{4})/g)].map((m) => isoAt(m[1], 0) - offStr(m[2]) * 60000);
          const latest = at.reduce((a, t) => (t > a ? t : a), -Infinity);
          for (const t of at) {
            add(t, 'Force quit', file.replace(/_(?:[0-9A-F-]{36}|redacted-hardware-uuid)\.txt$/i, ''), en.path, at.length === 1 ? `the one force-quit time ${where}`
              : `${t === latest ? 'the latest' : 'one'} of the ${at.length} force-quit times ${where}`);
          }
        }
      }
      if (!lines.length) return;
      const blob = new Blob([lines.join('\n') + '\n']);
      const en = new Entry('(crash and hang reports)', blob.size, blob);
      en.virtual = true;
      const src = new Source(this.sources.length, en, reportKind(this));
      this.sources.push(src);
      await this.indexSource(src, () => {});
    }

    finalize() {
      const S = this.sources;
      let N = 0;
      for (const src of S) {
        const t = src.t, n = src.n;
        let last = NaN;
        for (let i = 0; i < n; i++) if (t[i] < 0) t[i] = this.localToUtc(-t[i]);
        for (let i = 0; i < n; i++) { if (t[i] === t[i]) last = t[i]; else t[i] = last; }
        for (let i = n - 1; i >= 0; i--) { if (t[i] === t[i]) last = t[i]; else t[i] = last; }
        if (n && t[0] !== t[0]) t.fill(0);
        src.perm = null;
        for (let i = 1; i < n; i++) {
          if (t[i] < t[i - 1]) {                        // rare: a few out-of-order entries
            const perm = new Uint32Array(n);
            for (let k = 0; k < n; k++) perm[k] = k;
            src.perm = perm.sort((a, b) => t[a] - t[b] || a - b);
            break;
          }
        }
        src.t0 = n ? t[src.perm ? src.perm[0] : 0] : NaN;
        src.t1 = n ? t[src.perm ? src.perm[n - 1] : n - 1] : NaN;
        N += n;
      }
      // F is the number of the file a row came from. There can be more files than sixteen bits count: a copied folder
      // may hold any number of small logs, and a number that wrapped would show a row under another file's name and text.
      const G = this.g = { n: N, T: new Float64Array(N), F: new Uint32Array(N), R: new Uint32Array(N), L: new Uint8Array(N),
        P: new Uint16Array(N), PID: new Int32Array(N), S: new Uint16Array(N), C: new Uint16Array(N), G: new Uint16Array(N) };
      // k-way merge by time, then by file number. Files are mostly disjoint in time, so rows are copied in runs from one
      // file while it stays the earliest. A heap of the files, ordered by each one's next time, gives that file and the
      // one after it, so the work for a run does not grow with the number of files.
      const cur = new Uint32Array(S.length), next = new Float64Array(S.length), heap = new Uint32Array(S.length);
      const key = (f) => { const s = S[f], c = cur[f]; return s.t[s.perm ? s.perm[c] : c]; };
      const before = (a, b) => next[a] < next[b] || (next[a] === next[b] && a < b);
      let hn = 0;
      const sink = (i) => {                               // move the file at i down to where the heap's order holds
        const f = heap[i];
        for (;;) {
          let c = 2 * i + 1;
          if (c >= hn) break;
          if (c + 1 < hn && before(heap[c + 1], heap[c])) c++;
          if (!before(heap[c], f)) break;
          heap[i] = heap[c]; i = c;
        }
        heap[i] = f;
      };
      const rise = (i) => {
        const f = heap[i];
        while (i > 0) { const up = (i - 1) >> 1; if (!before(f, heap[up])) break; heap[i] = heap[up]; i = up; }
        heap[i] = f;
      };
      for (let f = 0; f < S.length; f++) if (S[f].n) { next[f] = key(f); heap[hn] = f; rise(hn++); }
      let o = 0;
      while (hn) {
        const m = heap[0];
        heap[0] = heap[--hn];
        if (hn) sink(0);
        const m2 = hn ? heap[0] : -1, k2 = hn ? next[m2] : Infinity;      // the file that comes next, and its time
        const s = S[m], perm = s.perm, n = s.n, t = s.t;
        let c = cur[m];
        do {                                              // the heap's first file always gives at least one row
          const r = perm ? perm[c] : c, tv = t[r];
          G.T[o] = tv; G.F[o] = m; G.R[o] = r; G.L[o] = s.lvl[r]; G.P[o] = s.proc[r]; G.PID[o] = s.pid[r];
          G.S[o] = s.sub[r]; G.C[o] = s.cat[r]; G.G[o] = s.tags[r];
          o++; c++;
          if (c < n) { const tn = t[perm ? perm[c] : c]; if (tn > k2 || (tn === k2 && m2 < m)) break; }
        } while (c < n);
        cur[m] = c;
        if (c < n) { next[m] = key(m); heap[hn] = m; rise(hn++); }
      }
      for (const s of S) { s.t = s.lvl = s.proc = s.pid = s.sub = s.cat = s.tags = s.perm = null; }
      this.t0 = N ? G.T[0] : 0;
      this.t1 = N ? G.T[N - 1] : 0;
      const D = this.dict;
      this.lvlSev = Uint8Array.from(D.lvl.names, sevOf);
      const order = ['unified', 'office', 'report', 'autoupdate', 'onedrive', 'install', 'power', 'text'];
      this.groups = [...new Set(S.slice().sort((a, b) => order.indexOf(a.parser.kind) - order.indexOf(b.parser.kind)).map((s) => s.parser.group))];
      // A copied folder can give any number of groups (Excel-format logs in each of its app folders are a group of their
      // own), so each file's group is looked up in a map made once, and kept in as many bits as the file number it is read by
      const groupNo = new Map(this.groups.map((g, i) => [g, i]));
      this.srcGroup = Uint32Array.from(S, (s) => groupNo.get(s.parser.group));
      this.facets = [
        { name: 'sev', col: G.L, table: this.lvlSev, n: SEV.length },
        { name: 'group', col: G.F, table: this.srcGroup, n: this.groups.length },
        { name: 'tag', col: G.G, bits: true, n: 16 },
        { name: 'proc', col: G.P, n: D.proc.names.length },
        { name: 'sub', col: G.S, n: D.sub.names.length },
        { name: 'cat', col: G.C, n: D.cat.names.length },
        { name: 'lvl', col: G.L, n: D.lvl.names.length },
        { name: 'file', col: G.F, n: S.length },
      ];
    }

    info(notes) {
      const D = this.dict, srcOf = new Map(this.sources.map((s) => [s.entry, s]));
      const main = this.sources.filter((s) => s.n && (s.parser.kind === 'unified' || s.parser.kind === 'office'));
      const focus = main.length ? [Math.min(...main.map((s) => s.t0)) - 60000, Math.max(...main.map((s) => s.t1)) + 60000] : null;
      return {
        name: this.name, total: this.g.n, t0: this.t0, t1: this.t1, end: this.end, zone: this.zone, notes,
        focus: focus && focus[1] - focus[0] < 0.8 * (this.t1 - this.t0) ? focus : null,
        files: this.entries.map((en, i) => { const s = srcOf.get(en); return { i, path: en.path, size: en.size, src: s ? s.id : -1, rows: s ? s.n : 0 }; }),
        sources: this.sources.map((s) => ({ id: s.id, path: s.path, kind: s.parser.kind, group: s.parser.group, short: s.parser.short, rows: s.n, t0: s.t0, t1: s.t1, size: s.entry.size, virtual: !!s.entry.virtual })),
        names: { sev: SEV, group: this.groups, tag: this.tagNames, proc: D.proc.names, sub: D.sub.names, cat: D.cat.names, lvl: D.lvl.names, file: this.sources.map((s) => s.path) },
        lvlSev: Array.from(this.lvlSev), reports: this.reportList,
      };
    }
    // What the bundle records about the Mac and about the collection itself, as labelled facts: [{ label, value, path }],
    // where path is the file each was read from. bundle_info.tsv is used when the collector wrote one; otherwise the
    // same facts are picked out of the command output that older collectors saved. Nothing is worked out or judged.
    async facts() {
      const read = async (path) => { const en = this.entries.find((e) => e.path === path); return en && en.size ? UTF8.decode(await en.head(131072)) : ''; };
      const pick = (text, rx) => ((rx.exec(text) || [])[1] || '').trim();
      const out = [], add = (label, value, path) => { value = String(value || '').replace(/\s+/g, ' ').trim(); if (value) out.push({ label, value, path: path || '' }); };
      const B = 'bundle_info.tsv', SUM = 'summary.md', SYS = 'system/system_info.txt', VER = 'office/versions.txt', MAN = 'manifest.tsv';
      const bi = new Map((await read(B)).split(/\r?\n/).map((l) => l.split('\t')).filter((f) => f.length >= 2 && f[1]).map((f) => [f[0], f.slice(1).join(' ')]));
      const short = (text) => text.split('\n').filter((l) => l.length <= 400).join('\n');       // the patterns below are for lines of ordinary length
      const sum = await read(SUM), sys = short(await read(SYS)), ver = await read(VER), man = await read(MAN);
      const both = (a, b) => (a && b ? `${a} (${b})` : a || b || '');
      const first = (...tries) => tries.find((t) => t[0]) || ['', ''];      // the first source that has the fact: [value, path]

      add('Collected', ...first([both(bi.get('collected_local'), bi.get('collected_utc') && `${bi.get('collected_utc')} UTC`), B], [pick(sum, /^- Collected:\s*(.+)$/m), SUM], [pick(sys, /^=== Collected ===\r?\n(.+)$/m), SYS]));
      add('Collector mode', ...first([bi.get('mode'), B], [pick(sum, /^- Mode:\s*(.+)$/m), SUM], [pick(this.name, /^Excel_Diagnostics_(collect|hang|repro|watch)_/), '']));
      add('Log search window', pick(sum, /^- Incident window:\s*(.+)$/m), SUM);
      const version = first([bi.get('collector_version'), B], [pick(sum, /^- Collector version:\s*(.+)$/m), SUM]);
      if (man || sum) add('Collector version', version[0] || 'not recorded in this bundle (collectors before 1.5.0 did not write it)', version[1]);
      // Before 1.5.0 the collector replaced only home folder names and email addresses, so its row is not called "names hidden"
      const red = /^redaction\t([^\t\n]*)\t?([^\n]*)$/m.exec(man);
      if (man) add(red && !version[0] ? 'Redaction, as the collector recorded it' : 'Names hidden', red ? `${red[1]}: ${red[2]}` : 'not asked for', MAN);
      add('macOS', ...first([both(bi.get('macos_version'), bi.get('macos_build')), B], [both(pick(sys, /^ProductVersion:\s*(.+)$/m), pick(sys, /^BuildVersion:\s*(.+)$/m)), SYS]));
      add('Mac', ...first([both(bi.get('model_name'), bi.get('model_identifier')), B], [both(pick(sys, /^[ \t]*Model Name:\s*(.+)$/m), pick(sys, /^[ \t]*Model Identifier:\s*(.+)$/m)), SYS]));
      const cores = pick(sys, /^[ \t]*Total Number of Cores:\s*(.+)$/m);
      add('Processor', ...first([bi.get('chip'), B], [[pick(sys, /^[ \t]*(?:Chip|Processor Name):\s*(.+)$/m), cores && cores.replace(/^(\d+)/, '$1 cores')].filter(Boolean).join(', '), SYS]));
      add('Memory installed', ...first([bi.get('memory'), B], [pick(sys, /^[ \t]*Memory:\s*(.+)$/m), SYS]));
      const df = /^\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+%)\s.*\s(\/System\/Volumes\/Data|\/)\s*$/m.exec(sys.split('\n').filter((l) => /\/System\/Volumes\/Data\s*$/.test(l)).concat(sys.split('\n').filter((l) => /\s\/\s*$/.test(l)))[0] || '');
      if (df) add('Startup disk', `${df[3]} available of ${df[1]}, ${df[4]} of capacity in use (${df[5]})`, SYS);
      const up = /\bup\s+(.+?),\s+\d+\s+users?,\s+load averages?:\s*(.+)$/m.exec(sys);
      if (up) { add('Uptime when collected', up[1], SYS); add('Load averages when collected', `${up[2].trim()} (over 1, 5 and 15 minutes)`, SYS); }
      add('Excel', ...first([both(bi.get('excel_version'), bi.get('excel_build')), B], [pick(ver, /^Microsoft Excel:\s*(.+)$/m), VER]));
      // written as the collector starts, before anything else it does: whether a process of the console user's ran Excel then
      add('Excel running when the collector started', bi.get('excel_running'), B);
      const others = [...ver.matchAll(/^(Microsoft (?:Word|PowerPoint|Outlook|Teams)|OneDrive):\s*(.+)$/gm)].map((m) => `${m[1].replace(/^Microsoft /, '')} ${m[2].trim()}`);
      add('Other Office apps', others.join(', '), VER);
      return out;
    }

    // Things the bundle records that are worth seeing against the count of entries over time, for the page's main chart:
    //   marks    moments: each report, the first entry from each Excel process, restarts and shutdowns, install activity,
    //            and when the bundle was collected
    //   asleep   each sleep in the sleep and wake history, for as long as its own line says it lasted
    //   cover    the spans the macOS log and Excel's own logs in the bundle cover, so that a stretch with no entries
    //            can be told apart from a stretch the bundle has no log for
    // Each is a recorded time or a span between two recorded times. Nothing is inferred about why. The first 500 Excel
    // process IDs are followed, and excelPidsCut is true when the logs have entries under more.
    async marks() {
      if (this.markCache) return this.markCache;
      const G = this.g, D = this.dict, S = this.sources, kindOf = S.map((s) => s.parser.kind);
      const out = { marks: [], asleep: [], cover: { unified: [], office: [] }, collected: this.collected, searched: false, excelPidsCut: false };
      // Each read to its first MB, as the command-line tool reads them, without a line cut short where the read ends
      const read = async (path) => {
        const en = this.entries.find((e) => e.path === path);
        if (!en || !en.size) return '';
        const text = UTF8.decode(await en.head(1 << 20));
        return en.size > 1 << 20 ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
      };
      for (const r of this.reportList) out.marks.push({ t: r.t, kind: 'report', text: r.kind === 'Force quit' ? `Force quit recorded: ${r.proc}` : `${r.kind === 'Report' ? 'Report' : `${r.kind} report`}: ${r.proc}` });

      const xl = D.proc.map.get('Microsoft Excel'), runs = new Map(), power = [], installs = [];
      for (let i = 0; i < G.n; i++) {
        const k = kindOf[G.F[i]];
        if (k === 'power') power.push([G.T[i], D.cat.names[G.C[i]]]);
        else if (k === 'install') installs.push(G.T[i]);
        else if (G.P[i] === xl && G.PID[i] > 0 && (k === 'unified' || k === 'office')) {
          const run = runs.get(G.PID[i]);
          if (run) run.t1 = G.T[i]; else if (runs.size < 500) runs.set(G.PID[i], { t: G.T[i], t1: G.T[i] }); else out.excelPidsCut = true;
        }
      }
      // pid and t1 (its last entry) are for the command-line tool's summary; the page draws t
      for (const [pid, run] of runs) out.marks.push({ t: run.t, t1: run.t1, kind: 'excel', pid, text: `First entry from Microsoft Excel with process ID ${pid}` });
      for (const [t, what] of power) if (what === 'Start' || what === 'Shutdown' || what === 'Restart') out.marks.push({ t, kind: 'power', text: `${what}, in the sleep and wake history` });
      for (const s of S) {                                // a Sleep line ends with how long that sleep lasted: "... 7699 secs"
        if (kindOf[s.id] !== 'power') continue;
        // Line by line, and only lines of ordinary length: one pattern over the whole file is slow on a long line.
        // The start of the line is matched by itself and the length is read back from the line's end, digit by digit:
        // one pattern for both tries every place in the line where the number might begin.
        for (const line of UTF8.decode(await s.entry.head(8 << 20)).split('\n')) {
          const m = line.length > 400 ? null : /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([-+]\d{4}) Sleep\s/.exec(line);
          if (!m) continue;
          const text = line.trimEnd();                    // spaces after "secs" are not part of it
          if (!text.endsWith(' secs')) continue;
          const end = text.length - 5;
          let from = end;
          while (from > m[0].length && text.charCodeAt(from - 1) >= 48 && text.charCodeAt(from - 1) <= 57) from--;
          const secs = +text.slice(from, end), t = isoAt(m[1], 0) - offStr(m[2]) * 60000;
          if (from < end && t === t && secs > 0) out.asleep.push([t, t + secs * 1000]);
        }
      }
      for (let i = 0; i < installs.length;) {             // install history lines come in bursts: one mark for each burst
        let j = i;
        while (j + 1 < installs.length && installs[j + 1] - installs[j] <= 600000) j++;
        out.marks.push({ t: installs[i], t1: installs[j], kind: 'install', text: `Install history: ${j - i + 1} ${j === i ? 'line that mentions' : 'lines that mention'} Microsoft, Excel or Office` });
        i = j + 1;
      }

      if (out.collected === out.collected) out.marks.push({ t: out.collected, kind: 'collected', text: 'This bundle was collected' });

      // The macOS log is collected a day at a time, and each file covers at least from its first entry to its last.
      // Where the collector recorded that a day's search ran to the end ("ok (N entries)"), that day is covered to
      // its end, or to the moment of collection, however few entries it holds; and from its start as well when the
      // bundle has macOS log entries from before that day, which shows macOS still had logs that far back. A span covers
      // its two ends, and the next day starts at midnight: so a day is covered to the millisecond before it.
      // (a line is read whole whatever it holds, a line separator among it)
      const status = new Map((await read('unified_logs/collection_status.txt')).split(/\r?\n/).map((l) => /^(\d{4}-\d\d-\d\d) \| (.*)$/s.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
      const manifest = await read('manifest.tsv');
      const unified = S.filter((s) => s.n && kindOf[s.id] === 'unified'), earliest = Math.min(...unified.map((s) => s.t0));
      const end = out.collected === out.collected ? out.collected : this.t1;
      for (const s of unified) {
        const day = (/(?:^|\/)unified_logs\/(\d{4}-\d\d-\d\d)\.[a-z]+$/.exec(s.path) || [])[1];
        if (day && /^ok \(/.test(status.get(day) || '')) {
          const start = isoAt(`${day} 00:00:00`, 0), from = this.localToUtc(start);
          out.cover.unified.push([earliest < from ? from : s.t0, Math.max(s.t1, Math.min(this.localToUtc(start + 86400000) - 1, end))]);
        } else if (/(?:^|\/)unified_last30m\.[a-z]+$/.test(s.path) && /^unified_last30m\tcomplete\b/m.test(manifest)) {
          out.cover.unified.push([Math.min(s.t0, end - 1800000), Math.max(s.t1, end)]);      // a hang capture searches the half hour before it
        } else out.cover.unified.push([s.t0, s.t1]);
      }
      // A day that was searched to the end and held nothing has no file, but was covered all the same, provided
      // the bundle shows macOS still had logs that far back.
      for (const [day, st] of status) {
        const start = isoAt(`${day} 00:00:00`, 0), from = this.localToUtc(start);
        if (/^ok, nothing found/.test(st) && earliest < from) out.cover.unified.push([from, Math.min(this.localToUtc(start + 86400000) - 1, Math.max(end, from))]);
      }
      // The collector looked for macOS logs, whatever it got: with none at all, the whole chart is a stretch without them
      out.searched = status.size > 0 || /unified_logs\/collection_status\.txt|access check \|/.test([...status.values()].join('\n')) || /^unified_(?:logs|last30m)\t/m.test(manifest) || this.entries.some((e) => /(?:^|\/)unified_logs\/collection_status\.txt$/.test(e.path));
      const office = S.filter((s) => s.n && kindOf[s.id] === 'office' && s.parser.group === 'Excel diagnostics');
      if (office.length) out.cover.office.push([Math.min(...office.map((s) => s.t0)), Math.max(...office.map((s) => s.t1))]);
      const merge = (list) => {                           // sorted, with touching and overlapping spans joined
        const res = [];
        for (const [a, b] of list.filter(([a, b]) => a === a && b >= a).sort((x, y) => x[0] - y[0])) { const last = res[res.length - 1]; if (last && a <= last[1] + 1000) last[1] = Math.max(last[1], b); else res.push([a, b]); }
        return res;
      };
      out.cover.unified = merge(out.cover.unified); out.cover.office = merge(out.cover.office); out.asleep = merge(out.asleep);
      out.marks = out.marks.filter((m) => m.t === m.t).sort((a, b) => a.t - b.t);
      return (this.markCache = out);
    }

    tagTimes(name, nb) {                                // when entries carrying a tag occur: counts per time bin across their own span
      const G = this.g, bit = this.tagNames.indexOf(name), bins = new Array(nb).fill(0);
      let first = -1, last = -1, total = 0;
      if (bit >= 0) for (let i = 0; i < G.n; i++) if ((G.G[i] >> bit) & 1) { if (first < 0) first = i; last = i; total++; }
      if (!total) return { total: 0, t0: 0, t1: 0, nb, bins };
      const t0 = G.T[first], t1 = Math.max(G.T[last], t0 + 1000), scale = nb / (t1 - t0);
      for (let i = first; i <= last; i++) if ((G.G[i] >> bit) & 1) bins[Math.min(nb - 1, Math.floor((G.T[i] - t0) * scale))]++;
      return { total, t0, t1, nb, bins };
    }

    // ----- search -----
    // notes: sentences about the search text itself, for the page to show. A soft note only matters when nothing matched
    // (the text may be exactly what was meant); the others are always worth saying.
    compile(text, cs) {
      const out = { text: [], fields: [], hl: [], err: null, tokens: [], notes: [] };
      const FIELDS_SAID = 'process:, level:, pid:, subsystem:, category:, tag: and source:';
      const near = (word) => {                            // the field name a misspelling is closest to, if any
        let best = null, bestD = 3;
        for (const name of ['process', 'level', 'severity', 'pid', 'subsystem', 'category', 'tag', 'source', 'file']) {
          if (Math.abs(name.length - word.length) > 2) continue;
          const row = Array.from({ length: name.length + 1 }, (_, i) => i);
          for (let i = 1; i <= word.length; i++) {
            let prev = row[0]; row[0] = i;
            for (let j = 1; j <= name.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (word[i - 1] === name[j - 1] ? 0 : 1)); prev = keep; }
          }
          if (row[name.length] < bestD) { bestD = row[name.length]; best = name; }
        }
        return word.length >= 3 && bestD <= (word.length < 6 ? 1 : 2) ? best : null;
      };
      const plain = (word) => {                           // a bare word that looks like something else was meant
        const w = word.replace(/^-/, '');
        let m2;
        if (/^(level|lvl|sev|severity|process|proc|pid|subsystem|sub|area|category|cat|tag|source|src|file):$/i.test(w)) {
          const eg = { level: 'error', pid: '4121', tag: 'memory', source: 'unified' }[FIELD[w.slice(0, -1).toLowerCase()]] || 'excel';
          out.notes.push({ text: `"${w}" has nothing after the colon, so it was searched for as plain text. Write the value straight after it with no space, for example ${w.toLowerCase()}${eg}.` });
        } else if ((m2 = /^([a-z_]+):(.+)$/i.exec(w))) {
          const guess = near(m2[1].toLowerCase());
          out.notes.push({ soft: !guess, text: `"${m2[1]}:" is not a field, so "${w}" was searched for as plain text. ${guess ? `Did you mean ${guess}:${m2[2]}? ` : ''}The fields are ${FIELDS_SAID}` });
        } else if (w[0] === '"' && w.length > 1) {
          out.notes.push({ text: `The quotation mark in ${w} is never closed, so each word was searched for on its own, quotation mark included. Close the phrase: "like this".` });
        } else if (w[0] === '/' && w.length > 1 && w.indexOf('/', 1) < 0) {
          out.notes.push({ soft: true, text: `${w} was searched for as plain text. A regular expression needs a closing slash: ${w}/` });
        }
      };
      const FIELD = { level: 'level', lvl: 'level', sev: 'level', severity: 'level', process: 'process', proc: 'process', pid: 'pid',
        subsystem: 'subsystem', sub: 'subsystem', area: 'subsystem', category: 'category', cat: 'category', tag: 'tag', source: 'source', src: 'source', file: 'source' };
      const tok = new RegExp(TERM.source, TERM.flags);
      let m;
      while ((m = tok.exec(text)) !== null) {
        const neg = m[1] === '-', field = m[2] && FIELD[m[2].toLowerCase()];
        const lit = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[6];
        out.tokens.push(m[0]);
        if (field) { out.fields.push({ neg, field, value: (lit !== undefined ? lit : m[4] || '').toLowerCase(), said: m[0] }); continue; }
        if (lit === '' || (lit === undefined && m[4] === undefined)) continue;
        if (m[6] !== undefined) plain(m[0]);
        const src = m[4] !== undefined ? m[4] : escapeRx(lit);
        const flags = 'm' + (cs && !m[5] ? '' : 'i');
        let re;
        try { re = new RegExp(src, 'g' + flags); } catch (err) {
          out.err = `Invalid regular expression /${src}/ - ${err.message}`;
          out.notes.push({ text: `/${src}/ is not a valid regular expression (${String(err.message).replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '')}), so it was left out of the search. To search for those characters as plain text, put them in quotation marks.` });
          continue;
        }
        // A word or a phrase is one fixed string, which JavaScript's own reader finds in time that grows with the
        // text only. A /regex/ is read by this tool's reader (rxCompile), one line at a time. Each is matched with
        // the text of an entry as it is shown, read as UTF-8 (scanText): a word that has a character past ASCII
        // (wide) can only match an entry that has one too, and is looked for in each such entry on its own.
        if (m[4] === undefined) {
          out.text.push(/[^\x00-\x7f]/.test(src) ? { neg, re, wide: new RegExp(src, flags) } : { neg, re, one: new RegExp(src, flags) });
          if (!neg) out.hl.push({ src, flags: flags.replace('m', '') });
          continue;
        }
        const rx = rxCompile(src, flags);
        if (rx.why) { out.notes.push({ text: RX_LEFT_OUT[rx.why](src, rx) }); continue; }
        out.text.push({ neg, re, rx });
        if (!neg) out.hl.push({ src, flags: flags.replace('m', ''), rx: true });
      }
      return out;
    }

    async scanText(src, lo, hi, terms, run, onBytes) {    // -> one byte per row of src: 1 where the text terms match
      const bm = new Uint8Array(src.n), { off, len } = src, blob = await src.entry.blob();
      let r = lo;
      while (r < hi) {
        if (run !== this.run) throw new Error('superseded');
        const start = off[r];
        const rEnd = Math.min(hi, Math.max(r + 1, upperBound(off, start + CHUNK, r, hi)));
        const end = off[rEnd - 1] + len[rEnd - 1];
        const buf = new Uint8Array(await blob.slice(start, end).arrayBuffer()), s = LATIN1.decode(buf);
        const acc = new Uint8Array(rEnd - r).fill(1), hit = new Uint8Array(rEnd - r);
        // Each row is matched as its entry is shown (readRows): read as UTF-8, without the line ends and NULs at its
        // end. A row of ASCII only reads the same in s, one character a byte; a row with a byte past ASCII (wide) is
        // read again as UTF-8, once, when a term needs it.
        const tail = (j) => { const a = off[j] - start; let b = a + len[j]; while (b > a) { const c = s.charCodeAt(b - 1); if (c !== 13 && c !== 10 && c !== 0) break; b--; } return b; };
        let wideAt = null;
        const wideRows = () => {
          if (wideAt) return wideAt;
          const wide = wideAt = new Uint8Array(rEnd - r);
          const past = /[^\x00-\x7f]/g;
          for (let row = r, m; (m = past.exec(s)) !== null;) {
            const pos = start + m.index, j = upperBound(off, pos, row, rEnd) - 1;
            if (pos < off[j] + len[j]) wide[j - r] = 1;
            if (j + 1 >= rEnd) break;
            row = j + 1; past.lastIndex = Math.max(past.lastIndex, off[row] - start);
          }
          return wide;
        };
        const shown = [];
        const shownText = (j) => {                      // the row as its entry is shown, for wide rows only
          if (shown[j - r] === undefined) { const t = UTF8.decode(buf.subarray(off[j] - start, off[j] - start + len[j])); let b = t.length; while (b > 0) { const c = t.charCodeAt(b - 1); if (c !== 13 && c !== 10 && c !== 0) break; b--; } shown[j - r] = t.slice(0, b); }
          return shown[j - r];
        };
        for (const term of terms) {
          hit.fill(0);
          if (term.rx || term.wide) {                   // each row on its own, so nothing is read across rows
            const w = wideRows();
            for (let j = r; j < rEnd; j++) {
              if (w[j - r]) { const t = shownText(j); if (term.rx ? term.rx.test(t, 0, t.length) : term.wide.test(t)) hit[j - r] = 1; }
              else if (term.rx && term.rx.test(s, off[j] - start, tail(j))) hit[j - r] = 1;
            }
            if (term.neg) for (let k = 0; k < acc.length; k++) acc[k] &= hit[k] ^ 1;
            else for (let k = 0; k < acc.length; k++) acc[k] &= hit[k];
            continue;
          }
          const re = term.re;
          re.lastIndex = 0;
          let row = r, m;
          while ((m = re.exec(s)) !== null) {           // jump from match to match; each hit marks its row and skips to the next row
            const pos = start + m.index, j = upperBound(off, pos, row, rEnd) - 1, rowEnd = tail(j) + start;
            if (pos < rowEnd) {
              if (pos + m[0].length <= rowEnd) hit[j - r] = 1;
              else if (term.one.test(s.substring(off[j] - start, rowEnd - start))) hit[j - r] = 1;
            }
            if (j + 1 >= rEnd) break;
            row = j + 1;
            re.lastIndex = off[row] - start;
          }
          if (term.neg) for (let k = 0; k < acc.length; k++) acc[k] &= hit[k] ^ 1;
          else for (let k = 0; k < acc.length; k++) acc[k] &= hit[k];
        }
        bm.set(acc, r);
        onBytes(end - start);
        r = rEnd;
      }
      return bm;
    }

    // q.dry: only count what would match, leaving the current view and the search cache as they are. The page uses it
    // to say what each condition is holding back when nothing matches.
    async query(q, progress) {
      const run = q.dry ? this.run : ++this.run, started = Date.now();
      const G = this.g, N = G.n, S = this.sources, D = this.dict;
      const c = this.compile(q.text || '', !!q.cs);
      const i0 = q.t0 != null ? lowerBound(G.T, q.t0, 0, N) : 0;
      const i1 = q.t1 != null ? lowerBound(G.T, q.t1, 0, N) : N;

      // facet selections
      const act = this.facets.map((f) => {
        const sel = (q.facets && q.facets[f.name]) || {}, a = { f, on: false, inc: null, exc: null, incMask: 0, excMask: 0, counts: new Uint32Array(f.n) };
        if (f.bits) { for (const v of sel.inc || []) a.incMask |= 1 << v; for (const v of sel.exc || []) a.excMask |= 1 << v; a.on = !!(a.incMask || a.excMask); }
        else {
          if (sel.inc && sel.inc.length) { a.inc = new Uint8Array(f.n); for (const v of sel.inc) a.inc[v] = 1; }
          if (sel.exc && sel.exc.length) { a.exc = new Uint8Array(f.n); for (const v of sel.exc) a.exc[v] = 1; }
          a.on = !!(a.inc || a.exc);
        }
        return a;
      });
      // field:value terms
      const preds = [];
      for (const t of c.fields) {
        const v = t.value, keep = t.neg ? 0 : 1;
        const table = (names, also) => Uint8Array.from(names, (nm, i) => (nm.toLowerCase().includes(v) || (also && also(i)) ? 1 : 0));
        if (t.field === 'pid') preds.push({ col: G.PID, eq: parseInt(v, v.startsWith('0x') ? 16 : 10), keep });
        else if (t.field === 'tag') { let mask = 0; this.tagNames.forEach((nm, i) => { if (nm.toLowerCase().includes(v)) mask |= 1 << i; }); preds.push({ col: G.G, mask, keep }); }
        else if (t.field === 'level') preds.push({ col: G.L, keep,   // prefix match: level:fault must not match "Default"
          table: Uint8Array.from(D.lvl.names, (nm, i) => (v && (nm.toLowerCase().startsWith(v) || SEV[this.lvlSev[i]].toLowerCase().startsWith(v)) ? 1 : 0)) });
        else if (t.field === 'process') preds.push({ col: G.P, table: table(D.proc.names), keep });
        else if (t.field === 'subsystem') preds.push({ col: G.S, table: table(D.sub.names), keep });
        else if (t.field === 'category') preds.push({ col: G.C, table: table(D.cat.names), keep });
        else if (t.field === 'source') preds.push({ col: G.F, file: true, table: Uint8Array.from(S, (s) => (`${s.path}\n${s.parser.group}\n${s.parser.short}`.toLowerCase().includes(v) ? 1 : 0)), keep });
        // a field whose value names nothing in this bundle can only give no entries (or, negated, hide none): say so
        const p = preds[preds.length - 1], effect = t.neg ? 'it hides nothing' : 'it matches no entries';
        const list = (names) => names.filter(Boolean).slice(0, 24).join(', ');
        const like = (names) => { const hit = names.filter((nm) => nm && v.length >= 3 && nm.toLowerCase().includes(v.slice(0, 3))).slice(0, 8); return hit.length ? `Names here that are close: ${hit.join(', ')}.` : ''; };
        if (t.field === 'pid') { if (p.eq !== p.eq) c.notes.push({ text: `${t.said}: pid: needs a number, for example pid:4121, so ${effect}.` }); }
        // plain: the same note without the names taken from the bundle, for a reader that must not be handed a
        // sentence the bundle helped to write (the request layer, whose reader is a model); names: which list it left out
        else if (t.field === 'tag') { if (!p.mask) { const plain = `${t.said}: no tag in this bundle contains "${v}", so ${effect}.`; c.notes.push({ plain, names: 'tag', text: `${plain} The tags here are ${list(this.tagNames)}.` }); } }
        else if (!p.table.some((x) => x)) {
          const where = { level: `The levels here are ${list([...new Set(SEV.concat(D.lvl.names))])}. level: matches from the start of the name.`,
            process: like(D.proc.names), subsystem: like(D.sub.names), category: like(D.cat.names), source: `The sources here are ${list(this.groups)}; source: also matches file paths.` }[t.field];
          // field: lets the page or the command line add where its own list of these names is
          const plain = `${t.said}: no ${t.field} in this bundle ${t.field === 'level' ? 'starts with' : 'contains'} "${v}", so ${effect}.`;
          c.notes.push({ field: t.field, plain, names: t.field, text: `${plain}${where ? ' ' + where.trim() : ''}` });
        }
      }

      // text terms: scan only files the other filters leave in play, and only the rows inside the time window
      let bms = null, skipped = null;
      if (c.text.length) {
        const fileOk = S.map((s, f) => {
          for (const a of act) {
            if (!a.on || a.f.col !== G.F) continue;
            const v = a.f.table ? a.f.table[f] : f;
            if ((a.inc && !a.inc[v]) || (a.exc && a.exc[v])) return false;
          }
          return preds.every((p) => !p.file || p.table[f] === p.keep);
        });
        const lo = new Float64Array(S.length).fill(Infinity), hi = new Float64Array(S.length).fill(-1);
        for (let i = i0; i < i1; i++) { const f = G.F[i], r = G.R[i]; if (r < lo[f]) lo[f] = r; if (r > hi[f]) hi[f] = r; }
        const key = JSON.stringify(c.text.map((t) => [t.neg, t.re.source, t.re.flags]));
        let tc = this.textCache;
        if (!tc || tc.key !== key) { tc = { key, files: new Map() }; if (!q.dry) this.textCache = tc; }
        const cache = tc.files, jobs = [];
        let total = 0, done = 0;
        for (let f = 0; f < S.length; f++) {
          if (!fileOk[f] || hi[f] < 0) continue;
          const have = cache.get(f);
          if (have && have.lo <= lo[f] && have.hi > hi[f]) continue;
          const a = have ? Math.min(have.lo, lo[f]) : lo[f], b = have ? Math.max(have.hi, hi[f] + 1) : hi[f] + 1;
          jobs.push({ f, a, b });
          total += S[f].off[b - 1] + S[f].len[b - 1] - S[f].off[a];
        }
        for (const job of jobs) {
          const bm = await this.scanText(S[job.f], job.a, job.b, c.text, run, (n) => { done += n; if (!q.dry) progress({ phase: 'Searching', label: S[job.f].path, done, total, search: true }); });
          cache.set(job.f, { bm, lo: job.a, hi: job.b });
        }
        if (run !== this.run) throw new Error('superseded');
        bms = S.map((s, f) => (fileOk[f] && cache.has(f) ? cache.get(f).bm : null));
        skipped = fileOk.map((ok, f) => !ok && hi[f] >= 0);     // deselected files were not searched: their counts are unknown
      }

      const nb = Math.max(1, q.bins | 0 || 120), h0 = q.t0 != null ? q.t0 : this.t0, h1 = q.t1 != null ? q.t1 : this.end + 1;
      const hist = new Uint32Array(nb * 3), scale = nb / Math.max(1, h1 - h0), lvlSev = this.lvlSev;
      const only = q.only ? Uint32Array.from(q.only).filter((i) => i >= i0 && i < i1) : null;
      const view = new Uint32Array(only ? only.length : i1 - i0);
      let n = 0;
      const nAct = act.length, nPred = preds.length;
      const test = (i) => {
        if (bms) { const bm = bms[G.F[i]]; if (!bm || !bm[G.R[i]]) return; }
        for (let k = 0; k < nPred; k++) {
          const p = preds[k], v = p.col[i];
          if ((p.table ? p.table[v] : p.mask !== undefined ? (v & p.mask ? 1 : 0) : v === p.eq ? 1 : 0) !== p.keep) return;
        }
        let fails = 0, failK = -1;
        for (let k = 0; k < nAct; k++) {
          const a = act[k];
          if (!a.on) continue;
          const f = a.f, v = f.table ? f.table[f.col[i]] : f.col[i];
          const ok = f.bits ? (!a.incMask || (v & a.incMask) !== 0) && (v & a.excMask) === 0 : (!a.inc || a.inc[v] === 1) && !(a.exc && a.exc[v] === 1);
          if (!ok) { if (++fails > 1) return; failK = k; }
        }
        // a row failing exactly one facet still counts for that facet, so its other values show what selecting them would add
        for (let k = fails ? failK : 0, end = fails ? failK + 1 : nAct; k < end; k++) {
          const a = act[k], f = a.f, v = f.table ? f.table[f.col[i]] : f.col[i];
          if (f.bits) { for (let b = 0, x = v; x; b++, x >>>= 1) if (x & 1) a.counts[b]++; } else a.counts[v]++;
        }
        if (fails) return;
        view[n++] = i;
        let b = ((G.T[i] - h0) * scale) | 0;
        if (b >= nb) b = nb - 1; else if (b < 0) b = 0;
        const sv = lvlSev[G.L[i]];
        hist[b * 3 + (sv >= 4 ? 2 : sv === 3 ? 1 : 0)]++;
      };
      if (only) for (let k = 0; k < only.length; k++) test(only[k]);
      else for (let i = i0; i < i1; i++) test(i);
      if (q.dry) return { count: n };
      this.view = view.subarray(0, n);

      const facets = {};
      for (const a of act) {
        const sel = (q.facets && q.facets[a.f.name]) || {}, chosen = new Set([...(sel.inc || []), ...(sel.exc || [])]);
        const name = a.f.name, always = name === 'sev' || name === 'group' || (name === 'file' && S.length <= 80);
        let ids = [];
        for (let v = 0; v < a.counts.length; v++) if (a.counts[v] || chosen.has(v) || (always && (name !== 'file' || S[v].n))) ids.push(v);
        const all = ids.length;
        if (name === 'sev') ids.reverse(); else if (!always) ids.sort((x, y) => a.counts[y] - a.counts[x] || x - y);
        if (ids.length > 60) ids = ids.slice(0, 60).concat(ids.slice(60).filter((v) => chosen.has(v)));
        const unknown = (v) => skipped && a.f.col === G.F && skipped.some((sk, f) => sk && (a.f.table ? a.f.table[f] : f) === v);
        facets[name] = { values: ids.map((v) => [v, unknown(v) ? -1 : a.counts[v]]), all };
      }
      const res = { count: n, total: N, hist: { t0: h0, t1: h1, nb, bins: Array.from(hist) }, facets, hl: c.hl, err: c.err, notes: c.notes, tokens: c.tokens, ms: Date.now() - started };
      if (q.anchor != null) { res.anchorIndex = Math.min(Math.max(0, n - 1), lowerBound(this.view, q.anchor, 0, n)); res.anchorExact = n > 0 && this.view[res.anchorIndex] === q.anchor; }
      return res;
    }

    // ----- reading rows back -----
    async readRows(positions, capBytes) {
      const G = this.g, items = positions.map((i) => ({ i, s: G.F[i], r: G.R[i] })), by = new Map();
      for (const it of items) { if (!by.has(it.s)) by.set(it.s, []); by.get(it.s).push(it); }
      await Promise.all([...by].map(async ([s, list]) => {
        const src = this.sources[s], blob = await src.entry.blob();
        let a = Infinity, b = 0;
        for (const it of list) { it.off = src.off[it.r]; it.full = src.len[it.r]; it.len = Math.min(it.full, capBytes); a = Math.min(a, it.off); b = Math.max(b, it.off + it.len); }
        if (b - a <= 4 << 20) {
          const buf = new Uint8Array(await blob.slice(a, b).arrayBuffer());
          for (const it of list) it.text = UTF8.decode(buf.subarray(it.off - a, it.off - a + it.len));
        } else {
          await Promise.all(list.map(async (it) => { it.text = UTF8.decode(await blob.slice(it.off, it.off + it.len).arrayBuffer()); }));
        }
      }));
      return items.map((it) => {
        let end = it.text.length;                           // line ends and NULs off the end, counted from the end
        for (; end > 0; end--) { const c = it.text.charCodeAt(end - 1); if (c !== 13 && c !== 10 && c !== 0) break; }
        const i = it.i, text = end === it.text.length ? it.text : it.text.slice(0, end), f = this.sources[it.s].parser.fields(text);
        return { row: [i, G.T[i], G.F[i], G.L[i], G.P[i], G.PID[i], G.S[i], G.C[i], G.G[i], f.msg, it.full > it.len ? 1 : 0], extra: f.extra, raw: text, off: it.off };
      });
    }
    async rows(start, count) {
      const v = this.view, end = Math.min(v.length, start + count);
      return (await this.readRows(Array.from(v.subarray(Math.max(0, start), Math.max(0, end))), 2048)).map((x) => x.row);
    }
    async row(pos) { return (await this.readRows([pos], 2 << 20))[0]; }
    seek(t) {                                           // index in the current view of the first row at or after time t
      const v = this.view, T = this.g.T;
      let lo = 0, hi = v.length;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (T[v[m]] < t) lo = m + 1; else hi = m; }
      return Math.min(lo, Math.max(0, v.length - 1));
    }
    findSev(from, dir, min) {                           // next row in the view at or above a severity
      const v = this.view, L = this.g.L, sv = this.lvlSev;
      for (let k = from + dir; k >= 0 && k < v.length; k += dir) if (sv[L[v[k]]] >= min) return k;
      return -1;
    }
    async exportTsv(progress, positions) {              // the current view, or just the given entries
      const run = this.run, v = positions ? Uint32Array.from(positions) : this.view, names = this.info([]).names;
      // One entry is one row: a tab, a line feed and a carriage return in a field are written as \t, \n and \r. A field
      // that begins with = + - or @ gets an apostrophe in front, because a spreadsheet would run it as a formula. So
      // does one that begins with a quotation mark: a spreadsheet reads on from there to the next quotation mark,
      // across tabs and line ends, and every entry in between would land inside that one cell.
      const clean = (s) => { s = String(s).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n').replace(/\r/g, '\\r'); return /^[=+\-@"]/.test(s) ? `'${s}` : s; };

      const parts = ['utc_time\tseverity\tlevel\tsource\tprocess\tpid\tsubsystem\tcategory\ttags\tmessage\n'];
      for (let start = 0; start < v.length; start += 2000) {
        if (run !== this.run) throw new Error('superseded');
        const got = await this.readRows(Array.from(v.subarray(start, Math.min(v.length, start + 2000))), 1 << 20);
        parts.push(new Blob([got.map(({ row: r }) => [stamp(r[1], 6), SEV[this.lvlSev[r[3]]], names.lvl[r[3]], names.file[r[2]], names.proc[r[4]], r[5] || '',
          names.sub[r[6]], names.cat[r[7]], names.tag.filter((_, b) => r[8] >> b & 1).join(','), r[9]].map(clean).join('\t') + '\n').join('')]));
        progress({ phase: 'Exporting', done: start, total: v.length, search: true });
      }
      return new Blob(parts, { type: 'text/tab-separated-values' });
    }
    async fileChunk(i, offset, len) {                   // raw bytes of any bundle file, for the file browser
      const en = this.entries[i];
      let blob = en.cached;
      if (!blob) {
        if (!this.lastBlob || this.lastBlob.i !== i) this.lastBlob = { i, blob: await en.blob() };
        blob = this.lastBlob.blob;
      }
      return { bytes: await blob.slice(offset, offset + len).arrayBuffer(), size: blob.size, offset };
    }
  }

  // ---------- a JSON value read from a bundle ----------
  // The value with every list or object nested more than JSON_DEPTH deep in it made '' in its place. String(), join()
  // and a template follow a nested list as deep as it goes, and throw on one nested past what they can follow, which
  // would leave a whole report unread for one of its values. Walked with a list of its own, so no depth is too deep.
  const JSON_DEPTH = 32;
  function shallow(v) {
    if (!v || typeof v !== 'object') return v;
    const todo = [[v, 0]];
    while (todo.length) {
      const [o, d] = todo.pop();
      for (const k of Object.keys(o)) { const x = o[k]; if (x && typeof x === 'object') { if (d + 1 >= JSON_DEPTH) o[k] = ''; else todo.push([x, d + 1]); } }
    }
    return v;
  }

  // ---------- the terms of a search ----------
  // One term each: a word, a phrase in quotation marks, a /regex/, and a field such as process:excel, each with a minus
  // before it or not. compile() reads a search's text a term at a time by this, and queryTerms() counts the terms, so a
  // caller that bounds how many a search has counts them as the search reads them (a phrase of many words is one).
  const TERM = /(-?)(?:(level|lvl|sev|severity|process|proc|pid|subsystem|sub|area|category|cat|tag|source|src|file):)?(?:"((?:[^"\\]|\\.)*)"|\/((?:[^\/\\]|\\.)+)\/(i?)(?=\s|$)|(\S+))/gi;
  const queryTerms = (text) => { const tok = new RegExp(TERM.source, TERM.flags), s = String(text); let n = 0; while (tok.exec(s)) n++; return n; };

  // ---------- a /regex/, read by this tool ----------
  // A /regex/ term is not handed to JavaScript's own reader. That one tries one way of matching after another, and a
  // pattern such as (a|aa)+z, (a+){2,30}z or \s+$ has, on some lines, more ways than any search has time for. This
  // reader takes a pattern as JavaScript reads it (with the i and m flags as given, without u, s, y or v) and follows
  // every way at once, so it reads each character of a line once, in steps no more than the pattern is long:
  //  - rxCompile(src, flags) gives a reader, or { why } for a pattern it does not read: 'look' for one with a
  //    look-ahead or look-behind ((?= (?! (?<= (?<!), 'back' for one with a back-reference (\1, \k<name>), both of
  //    which need more than one pass, and 'big' for one that is more than RX_MOST steps long as rxSize counts them
  //    (each counted repeat such as {2,30} written out as that many copies, with more for each | and for each copy
  //    that may be left out), with counted: whether it has a counted repeat;
  //  - reader.test(s, a, b): whether the pattern matches in s from a to b, as it would in that part on its own;
  //  - reader.find(s, from, most): [start, end] of the first match at or after from, or null (also when more than
  //    `most` steps would be taken, each step being one place in the pattern looked at, reader.steps saying how many
  //    were): for marking matches on the page. It starts and ends where JavaScript's match would.
  // It is read as a set of states that the pattern can be in (built as they are met, and kept up to a fixed number);
  // what JavaScript itself reads is used only to check that the pattern is one (new RegExp, which matches nothing).
  const RX_MOST = 2000;
  const RX_LT = [[10, 10], [13, 13], [0x2028, 0x2029]], RX_WORD = [[48, 57], [65, 90], [95, 95], [97, 122]], RX_DIGIT = [[48, 57]];
  const RX_SPACE = [[9, 13], [32, 32], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]];
  function rxNorm(rs) {                                 // ranges [lo, hi] of UTF-16 code units, sorted, with touching ones joined
    const out = [];
    for (const [a, b] of rs.slice().sort((x, y) => x[0] - y[0])) { const l = out[out.length - 1]; if (l && a <= l[1] + 1) l[1] = Math.max(l[1], b); else out.push([a, b]); }
    return out;
  }
  function rxNot(rs) { const out = []; let c = 0; for (const [a, b] of rs) { if (a > c) out.push([c, a - 1]); c = b + 1; } if (c <= 0xffff) out.push([c, 0xffff]); return out; }
  // The i flag: two code units match when their canonical forms are the same, a form being the code unit in upper
  // case, kept as it is when that takes more than one code unit or would take it from outside ASCII into it
  let rxCanon = null, rxSame = null, rxSameAt = null;   // each code unit's form; the code units of each form, by form
  function rxFold(rs) {                                 // every code unit that the i flag matches with one in rs (sorted)
    if (!rxCanon) {
      rxCanon = new Uint16Array(65536);
      for (let c = 0; c < 65536; c++) { const u = String.fromCharCode(c).toUpperCase(); rxCanon[c] = u.length !== 1 || (c >= 128 && u.charCodeAt(0) < 128) ? c : u.charCodeAt(0); }
      rxSameAt = new Int32Array(65537);
      for (let c = 0; c < 65536; c++) rxSameAt[rxCanon[c] + 1]++;
      for (let k = 1; k <= 65536; k++) rxSameAt[k] += rxSameAt[k - 1];
      rxSame = new Uint16Array(65536);
      const at = rxSameAt.slice(0, 65536);
      for (let c = 0; c < 65536; c++) rxSame[at[rxCanon[c]]++] = c;
    }
    let size = 0;
    for (const [a, b] of rs) size += b - a + 1;
    if (size > 4096) {
      const want = new Uint8Array(65536), out = [];
      for (const [a, b] of rs) for (let c = a; c <= b; c++) want[rxCanon[c]] = 1;
      for (let c = 0, lo = -1; c <= 65536; c++) { const on = c < 65536 && want[rxCanon[c]] === 1; if (on && lo < 0) lo = c; else if (!on && lo >= 0) { out.push([lo, c - 1]); lo = -1; } }
      return out;
    }
    const out = [];
    for (const [a, b] of rs) for (let c = a; c <= b; c++) { const v = rxCanon[c]; for (let k = rxSameAt[v]; k < rxSameAt[v + 1]; k++) out.push([rxSame[k], rxSame[k]]); }
    return rxNorm(out);
  }
  // The pattern as a tree: { t: 'set', rs } (one code unit from these ranges), { t: 'as', k } (^, $, \b or \B, k
  // saying which and whether m applies), { t: 'cat', items }, { t: 'alt', items } and { t: 'rep', min, max, greedy, item }.
  // Read as JavaScript reads a pattern without the u flag, old forms included: \8 is 8, \07 is an octal escape, a
  // { that starts no {n,m} is itself, and \c not before a letter is a backslash. A group's own flags, (?i:...), hold in it.
  const RX_QB = /\{(\d+)(?:(,)(\d*))?\}/y, RX_FLAGS = /\?([ims]*)(?:-([ims]*))?:/y;
  function rxParse(src, ic0, multi0) {
    let groups = 0, named = false;                      // how many groups capture, and whether one is named: \2 and \k read by it
    for (let k = 0, inCls = false; k < src.length; k++) {
      const c = src[k];
      if (c === '\\') k++;
      else if (inCls) { if (c === ']') inCls = false; }
      else if (c === '[') inCls = true;
      else if (c === '(') { if (src[k + 1] !== '?') groups++; else if (src[k + 2] === '<' && src[k + 3] !== '=' && src[k + 3] !== '!') { groups++; named = true; } }
    }
    let i = 0, ic = ic0, multi = multi0, dotAll = false, counted = false;
    const stop = (why) => { throw { rxWhy: why }; };
    const one = (rs) => ({ t: 'set', rs: ic ? rxFold(rxNorm(rs)) : rxNorm(rs) });
    const hexAt = (n) => { const h = src.substr(i, n); return h.length === n && /^[0-9a-fA-F]+$/.test(h) ? parseInt(h, 16) : -1; };
    const octal = () => {                               // an old-style octal escape, from its first digit: \0 to \377
      let v = src.charCodeAt(i++) - 48;
      if (src[i] >= '0' && src[i] <= '7') { v = v * 8 + src.charCodeAt(i++) - 48; if (v < 32 && src[i] >= '0' && src[i] <= '7') v = v * 8 + src.charCodeAt(i++) - 48; }
      return v;
    };
    function escape(inCls) {                            // after a backslash: { rs }, { c } or { as }
      const e = src[i++];
      switch (e) {
        case 'd': return { rs: RX_DIGIT }; case 'D': return { rs: rxNot(RX_DIGIT) };
        case 'w': return { rs: RX_WORD }; case 'W': return { rs: rxNot(RX_WORD) };
        case 's': return { rs: RX_SPACE }; case 'S': return { rs: rxNot(RX_SPACE) };
        case 'b': return inCls ? { c: 8 } : { as: 'wb' };
        case 'B': return inCls ? { c: 66 } : { as: 'nwb' };
        case 't': return { c: 9 }; case 'n': return { c: 10 }; case 'v': return { c: 11 }; case 'f': return { c: 12 }; case 'r': return { c: 13 };
        case 'c': { const l = src[i]; if (l && (/[A-Za-z]/.test(l) || (inCls && /[0-9_]/.test(l)))) { i++; return { c: l.charCodeAt(0) % 32 }; } i--; return { c: 92 }; }
        case 'x': { const v = hexAt(2); if (v < 0) return { c: 120 }; i += 2; return { c: v }; }
        case 'u': { const v = hexAt(4); if (v < 0) return { c: 117 }; i += 4; return { c: v }; }
        case 'k': if (named && !inCls) stop('back'); return { c: 107 };
        case undefined: stop('syntax');
      }
      if (e >= '0' && e <= '9') {
        i--;
        if (!inCls && e !== '0') { let k = i; while (src[k] >= '0' && src[k] <= '9') k++; if (Number(src.slice(i, k)) <= groups) stop('back'); }
        if (e >= '8') { i++; return { c: e.charCodeAt(0) }; }
        return { c: octal() };
      }
      return { c: e.charCodeAt(0) };
    }
    function cls() {
      i++;
      const neg = src[i] === '^', rs = [];
      if (neg) i++;
      const item = () => (src[i] === '\\' ? (i++, escape(true)) : { c: src.charCodeAt(i++) });
      const put = (x) => { if (x.rs) rs.push(...x.rs); else rs.push([x.c, x.c]); };
      while (i < src.length && src[i] !== ']') {
        const a = item();
        if (src[i] === '-' && i + 1 < src.length && src[i + 1] !== ']') {
          i++;
          const b = item();
          if (a.rs || b.rs) { put(a); rs.push([45, 45]); put(b); }      // a class at either end: no range, and - is itself
          else { if (a.c > b.c) stop('syntax'); rs.push([a.c, b.c]); }
        } else put(a);
      }
      if (src[i] !== ']') stop('syntax');
      i++;
      const r = ic ? rxFold(rxNorm(rs)) : rxNorm(rs);
      return { t: 'set', rs: neg ? rxNot(r) : r };
    }
    function atom() {
      const c = src[i];
      if (c === '^') { i++; return { t: 'as', k: multi ? 'bolm' : 'bol' }; }
      if (c === '$') { i++; return { t: 'as', k: multi ? 'eolm' : 'eol' }; }
      if (c === '.') { i++; return { t: 'set', rs: dotAll ? [[0, 0xffff]] : rxNot(RX_LT) }; }
      if (c === '[') return cls();
      if (c === '\\') { i++; const e = escape(false); return e.as ? { t: 'as', k: e.as } : one(e.rs || [[e.c, e.c]]); }
      if (c !== '(') { i++; return one([[c.charCodeAt(0), c.charCodeAt(0)]]); }
      i++;
      const keep = [ic, multi, dotAll];
      if (src[i] === '?') {
        const n = src[i + 1];
        if (n === '=' || n === '!' || (n === '<' && (src[i + 2] === '=' || src[i + 2] === '!'))) stop('look');
        if (n === '<') i = src.indexOf('>', i) + 1;
        else if (n === ':') i += 2;
        else {
          RX_FLAGS.lastIndex = i;
          const f = RX_FLAGS.exec(src);
          if (!f) stop('syntax');
          for (const x of f[1]) { if (x === 'i') ic = true; else if (x === 'm') multi = true; else dotAll = true; }
          for (const x of f[2] || '') { if (x === 'i') ic = false; else if (x === 'm') multi = false; else dotAll = false; }
          i = RX_FLAGS.lastIndex;
        }
      }
      const inner = disj();
      if (src[i] !== ')') stop('syntax');
      i++;
      [ic, multi, dotAll] = keep;
      return inner;
    }
    const count = (d) => { const n = Number(d); return n >= 2147483647 ? Infinity : n; };
    function quant(a) {
      let min, max;
      const c = src[i];
      if (c === '*') { min = 0; max = Infinity; i++; }
      else if (c === '+') { min = 1; max = Infinity; i++; }
      else if (c === '?') { min = 0; max = 1; i++; }
      else if (c === '{') {
        RX_QB.lastIndex = i;
        const m = RX_QB.exec(src);
        if (!m) return a;
        min = count(m[1]); max = m[2] === undefined ? min : m[3] === '' ? Infinity : count(m[3]);
        i = RX_QB.lastIndex; counted = true;
      } else return a;
      let greedy = true;
      if (src[i] === '?') { greedy = false; i++; }
      if (a.t === 'as' || min > max) stop('syntax');
      return { t: 'rep', min, max, greedy, item: a };
    }
    function alt() { const items = []; while (i < src.length && src[i] !== '|' && src[i] !== ')') items.push(quant(atom())); return { t: 'cat', items }; }
    function disj() { const items = [alt()]; while (src[i] === '|') { i++; items.push(alt()); } return items.length === 1 ? items[0] : { t: 'alt', items }; }
    const tree = disj();
    if (i < src.length) stop('syntax');
    return { tree, counted };
  }
  // A repeated part that can only ever match nothing (no way through it reads a code unit: only ^, $, \b, \B and
  // empty groups, or a repeat of none) matches where it is as JavaScript reads it, however many times it is repeated:
  // once when at least once is asked for, as it then holds or not there the same each time, and as nothing at all when
  // none may be asked for. JavaScript takes no copy past the smaller number that matches nothing. So such a repeat is
  // read as its part once, or as nothing, and is never written out. Each node is given none (it can only match
  // nothing) and empty (it can match nothing, by some way through it).
  function rxTrim(n) {
    if (n.t === 'set') { n.none = n.empty = false; return n; }
    if (n.t === 'as') { n.none = n.empty = true; return n; }
    if (n.t === 'rep') {
      const x = rxTrim(n.item);
      if (n.max === 0 || (x.none && n.min === 0)) return { t: 'cat', items: [], none: true, empty: true };
      if (x.none) return x;
      n.item = x; n.none = false; n.empty = n.min === 0 || x.empty;
      return n;
    }
    n.items = n.items.map(rxTrim);
    n.none = n.items.every((x) => x.none);
    n.empty = n.t === 'cat' ? n.items.every((x) => x.empty) : n.items.some((x) => x.empty);
    return n;
  }
  // How many steps n comes to, counted until past RX_MOST: one for each code unit set and each assertion, a counted
  // repeat's part as many times as it is written out, one more for each copy that may be left out, two more for
  // * and the like, and two more for each |. After rxTrim every repeated part reads at least one code unit, so no
  // count of copies, however large, is ever multiplied by nothing.
  function rxSize(n) {
    if (n.t === 'set' || n.t === 'as') return 1;
    if (n.t === 'rep') { const b = Math.max(1, rxSize(n.item)); return n.min * b + (n.max === Infinity ? b + 2 : (n.max - n.min) * (b + 1)); }
    let s = n.t === 'alt' ? 2 * (n.items.length - 1) : 0;
    for (const x of n.items) { s += rxSize(x); if (!(s <= RX_MOST)) break; }
    return s;
  }
  // The steps: CHAR (read one code unit of set a1), SPLIT (go on at a1, and at a2 after it), JMP (go on at a1),
  // ASSERT (go on if assertion a1 holds here), IN and OUT (the start and the end of a copy of a repeated part that may
  // be left out and can match nothing, a1 being how many such copies it is inside, itself included) and MATCH. An
  // assertion looks at the kind of code unit on each side of where it is: 0 none (the start or the end), 1 a line
  // end, 2 a word character, 3 any other.
  // What a search says of a /regex/ it leaves out, for each why of rxCompile(), with what rxCompile gave. The pattern
  // is said back as sent, cut after RX_SAID characters (an ellipsis ends it then), so that what follows it is read too.
  const RX_SAID = 200, rxSaid = (src) => { const cps = Array.from(src); return cps.length > RX_SAID ? `${cps.slice(0, RX_SAID).join('')}\u2026` : src; };
  const RX_LEFT_OUT = {
    look: (src) => `/${rxSaid(src)}/ has a look-ahead or a look-behind, which this search does not read, so it was left out of the search. Write it without (?=, (?!, (?<= or (?<!, or search for its words in quotation marks.`,
    back: (src) => `/${rxSaid(src)}/ has a back-reference, which this search does not read, so it was left out of the search. Write it without \\1 or \\k<name>, or search for its words in quotation marks.`,
    big: (src, rx) => `/${rxSaid(src)}/ is longer than this search reads: it comes to more than ${RX_MOST} steps as this search counts them, so it was left out of the search. A counted repeat such as x{2,30} counts as 30 copies of x, and each | and each copy that may be left out counts more. ${rx && rx.counted ? 'Write it shorter, or with smaller counts.' : 'Write it shorter.'}`,
    deep: (src) => `/${rxSaid(src)}/ has groups inside groups deeper than this search reads, so it was left out of the search. Write it with fewer groups.`,
    syntax: (src) => `/${rxSaid(src)}/ is written in a way this search does not read, so it was left out of the search. To search for those characters as plain text, put them in quotation marks.`,
  };
  const RX_CHAR = 0, RX_SPLIT = 1, RX_JMP = 2, RX_ASSERT = 3, RX_MATCH = 4, RX_IN = 5, RX_OUT = 6, RX_AS = { bol: 0, bolm: 1, eol: 2, eolm: 3, wb: 4, nwb: 5 };
  const RX_FRESH_NONE = 1 << 30;                         // find(): no copy begun where the thread is now
  const rxHolds = (k, p, n) => (k === 0 ? p === 0 : k === 1 ? p <= 1 : k === 2 ? n === 0 : k === 3 ? n <= 1 : k === 4 ? (p === 2) !== (n === 2) : (p === 2) === (n === 2));
  function rxCompile(src, flags) {
    let tree, counted = false;
    try {
      ({ tree, counted } = rxParse(src, flags.includes('i'), flags.includes('m')));
      tree = rxTrim(tree);
      if (!(rxSize(tree) <= RX_MOST)) return { why: 'big', counted };
    } catch (e) {
      if (e && e.rxWhy) return { why: e.rxWhy };
      if (e instanceof RangeError) return { why: 'deep' };         // groups inside groups deeper than this reader goes
      throw e;
    }
    const op = [], a1 = [], a2 = [], dep = [], sets = [], setOf = new Map();
    const put = (o, x = 0, y = 0) => { op.push(o); a1.push(x); a2.push(y); dep.push(depth); return op.length - 1; };
    const aim = (s, greedy, out) => { if (greedy) { a1[s] = s + 1; a2[s] = out; } else { a1[s] = out; a2[s] = s + 1; } };
    // A copy that may be left out, of a part that can match nothing: JavaScript does not take it when it matches
    // nothing (find() follows that rule, between IN and OUT; test() needs no such rule, as the copy changes nothing).
    // dep: how many such copies each step is inside (an IN and its OUT are inside their own).
    let depth = 0;
    const copy = (n) => {
      if (!n.item.empty) { emit(n.item); return; }
      put(RX_IN, ++depth); emit(n.item); put(RX_OUT, depth); depth--;
    };
    const emit = (n) => {
      if (n.t === 'set') { const key = n.rs.join(' '); let k = setOf.get(key); if (k === undefined) { k = sets.length; sets.push(n.rs); setOf.set(key, k); } put(RX_CHAR, k); }
      else if (n.t === 'as') put(RX_ASSERT, RX_AS[n.k]);
      else if (n.t === 'cat') for (const x of n.items) emit(x);
      else if (n.t === 'alt') {
        const jumps = [];
        n.items.forEach((x, k) => {
          if (k === n.items.length - 1) { emit(x); return; }
          const s = put(RX_SPLIT, op.length + 1);
          emit(x); jumps.push(put(RX_JMP)); a2[s] = op.length;
        });
        for (const j of jumps) a1[j] = op.length;
      } else {
        for (let k = 0; k < n.min; k++) emit(n.item);
        if (n.max === Infinity) { const s = put(RX_SPLIT); copy(n); put(RX_JMP, s); aim(s, n.greedy, op.length); return; }
        const splits = [];
        for (let k = n.min; k < n.max; k++) { splits.push(put(RX_SPLIT)); copy(n); }
        for (const s of splits) aim(s, n.greedy, op.length);
      }
    };
    try { emit(tree); } catch (e) { if (e instanceof RangeError) return { why: 'deep' }; throw e; }
    put(RX_MATCH);
    // Code units in classes: two are in one class when every set holds both or neither, and when each is a line end,
    // a word character or neither (what an assertion looks at), so a class says all the reader needs of a code unit
    const all = sets.concat([RX_LT, RX_WORD]), cuts = new Set([0, 65536]);
    for (const rs of all) for (const [a, b] of rs) { cuts.add(a); cuts.add(b + 1); }
    const pts = [...cuts].sort((x, y) => x - y), cmap = new Uint16Array(65536), sig = new Map(), keys = [], at = new Int32Array(all.length);
    for (let k = 0; k + 1 < pts.length; k++) {
      const c = pts[k];
      let key = '';
      for (let s = 0; s < all.length; s++) { const rs = all[s]; while (at[s] < rs.length && rs[at[s]][1] < c) at[s]++; key += at[s] < rs.length && rs[at[s]][0] <= c ? '1' : '0'; }
      let id = sig.get(key);
      if (id === undefined) { id = keys.length; sig.set(key, id); keys.push(key); }
      cmap.fill(id, c, pts[k + 1]);
    }
    const K = keys.length, has = new Uint8Array(sets.length * K), kinds = new Uint8Array(K);
    keys.forEach((key, c) => {
      for (let s = 0; s < sets.length; s++) has[s * K + c] = key.charCodeAt(s) === 49 ? 1 : 0;
      kinds[c] = key[sets.length] === '1' ? 1 : key[sets.length + 1] === '1' ? 2 : 3;
    });
    return new RxReader(Int32Array.from(op), Int32Array.from(a1), Int32Array.from(a2), Int32Array.from(dep), has, K, cmap, kinds);
  }
  class RxReader {
    constructor(op, a1, a2, dep, has, K, cmap, kinds) {
      Object.assign(this, { op, a1, a2, dep, has, K, cmap, kinds });
      const L = op.length;
      this.seen = new Int32Array(L); this.gen = 0; this.stack = new Int32Array(3 * L + 2);
      this.seenAt = new Int32Array(L); this.base = null; this.met = null; this.sp = []; this.sf = []; this.work = 0;      // for find() and begin()
      this.opens = new Map(); this.begins = new Map();  // the steps from the start, by what is on each side (opening(), begin())
      this.most = Math.max(64, Math.min(1 << 16, Math.floor((1 << 21) / K)));      // states kept at once
      this.clear();
    }
    bump() { if (++this.gen > 2e9) { this.seen.fill(0); this.seenAt.fill(0); if (this.met) this.met.fill(0); this.gen = 1; } return this.gen; }
    clear() {                                           // states as they are met: each is the steps it is at, after a code unit of a kind
      this.ids = new Map(); this.at = []; this.after = []; this.ends = []; this.held = 0;
      this.room = Math.min(this.most, 256);             // room for states in trans, made larger as more are met, up to most
      this.trans = new Int32Array(this.room * this.K).fill(-1);
      this.start = this.state(Int32Array.of(0), 0);
    }
    state(pcs, after) {
      const key = `${after} ${pcs.join(' ')}`;
      let id = this.ids.get(key);
      if (id !== undefined) return id;
      if (this.at.length >= this.most || this.held > 1 << 22) { this.clear(); return this.state(pcs, after); }
      if (this.at.length >= this.room) {
        this.room = Math.min(this.most, this.room * 2);
        const more = new Int32Array(this.room * this.K).fill(-1);
        more.set(this.trans);
        this.trans = more;
      }
      id = this.at.length;
      this.at.push(pcs); this.after.push(after); this.ends.push(-1); this.ids.set(key, id); this.held += pcs.length;
      return id;
    }
    // The steps reached from `from` without reading, between a code unit of kind prev and one of kind next: take(pc)
    // for each that reads one, and true as soon as the pattern's end is reached
    close(from, prev, next, take) {
      const { op, a1, a2, seen, stack } = this, gen = this.bump();
      let n = 0;
      for (let k = from.length - 1; k >= 0; k--) stack[n++] = from[k];
      while (n) {
        const pc = stack[--n];
        if (seen[pc] === gen) continue;
        seen[pc] = gen;
        const o = op[pc];
        if (o === RX_CHAR) take(pc);
        else if (o === RX_SPLIT) { stack[n++] = a2[pc]; stack[n++] = a1[pc]; }
        else if (o === RX_JMP || o === RX_IN || o === RX_OUT) stack[n++] = o === RX_JMP ? a1[pc] : pc + 1;
        else if (o === RX_ASSERT) { if (rxHolds(a1[pc], prev, next)) stack[n++] = pc + 1; }
        else return true;
      }
      return false;
    }
    // close() from the start alone, before a code unit of class c after one of kind prev, worked out once for each
    // kind and class: true when the pattern's end is reached, or else the steps that read c, in an Int32Array
    opening(prev, c) {
      const key = prev * this.K + c;
      let o = this.opens.get(key);
      if (o === undefined) {
        const pcs = [], { K, has, a1 } = this;
        o = this.close([0], prev, this.kinds[c], (pc) => { if (has[a1[pc] * K + c]) pcs.push(pc); }) ? true : Int32Array.from(pcs);
        this.opens.set(key, o);
      }
      return o;
    }
    step(d, c) {                                        // the state after a code unit of class c in state d; -2: matched before it
      const K = this.K, has = this.has, a1 = this.a1, next = [];
      if (this.close(this.at[d], this.after[d], this.kinds[c], (pc) => { if (has[a1[pc] * K + c]) next.push(pc + 1); })) return (this.trans[d * K + c] = -2);
      next.push(0);                                     // a match can start at every code unit
      next.sort((x, y) => x - y);
      const before = this.ids, id = this.state(Int32Array.from(next), this.kinds[c]);
      if (before === this.ids) this.trans[d * K + c] = id;     // unless the states were cleared to make room
      return id;
    }
    end(d) { if (this.ends[d] < 0) this.ends[d] = this.close(this.at[d], this.after[d], 0, () => {}) ? 1 : 0; return this.ends[d] === 1; }
    test(s, a, b) {
      const cmap = this.cmap, K = this.K;
      let d = this.start, trans = this.trans, met = 0;
      for (let i = a; i < b; i++) {
        const c = cmap[s.charCodeAt(i)];
        let t = trans[d * K + c];
        if (t < 0) {
          if (t === -2) return true;
          // A line that keeps meeting states not met before is read on without keeping them: each is used once
          if (++met > 64 && met * 4 > i - a) return this.walk(s, i, b, this.at[d], this.after[d]);
          t = this.step(d, c);
          if (t === -2) return true;
          trans = this.trans;
        }
        d = t;
      }
      return this.end(d);
    }
    // test() from a, at the steps pcs after a code unit of kind prev: close() and step() in one, keeping no state.
    // The steps from the start, where a match can begin at each code unit, are taken from opening(), so each code
    // unit costs the threads that are live, not the whole pattern again.
    walk(s, a, b, pcs, prev) {
      const { op, a1, a2, cmap, K, has, kinds, seen, stack } = this, L = op.length;
      let now = new Int32Array(L + 1), next = new Int32Array(L + 1), cn = 0;
      for (let j = 0; j < pcs.length; j++) now[cn++] = pcs[j];
      for (let i = a; i < b; i++) {
        const c = cmap[s.charCodeAt(i)], k = kinds[c], open = this.opening(prev, c);      // before bump(): it can call close()
        if (open === true) return true;
        const gen = this.bump();
        let m = 0, nn = 0;
        for (let j = cn - 1; j >= 0; j--) stack[m++] = now[j];
        while (m) {
          const pc = stack[--m];
          if (seen[pc] === gen) continue;
          seen[pc] = gen;
          const o = op[pc];
          if (o === RX_CHAR) { if (has[a1[pc] * K + c]) next[nn++] = pc + 1; }
          else if (o === RX_SPLIT) { stack[m++] = a2[pc]; stack[m++] = a1[pc]; }
          else if (o === RX_JMP) stack[m++] = a1[pc];
          else if (o === RX_ASSERT) { if (rxHolds(a1[pc], prev, k)) stack[m++] = pc + 1; }
          else if (o === RX_IN || o === RX_OUT) stack[m++] = pc + 1;
          else return true;
        }
        for (let j = 0; j < open.length; j++) { const pc = open[j]; if (seen[pc] !== gen) { seen[pc] = gen; next[nn++] = pc + 1; } }
        [now, next] = [next, now]; cn = nn; prev = k;
      }
      const last = Array.from(now.subarray(0, cn));
      last.push(0);
      return this.close(last, prev, 0, () => {});
    }
    // find(): the steps reached from pc0 without reading, between code units of kinds prev and next, in the order
    // JavaScript tries them: those that read a code unit, and the end, put in pcs from len on, unless reached already
    // in this round (gen, in seen). As in JavaScript, a copy that may be left out is not taken when it reaches its OUT
    // having read nothing. So a place is a step and fd, how many copies deep the outermost copy begun here is (none:
    // RX_FRESH_NONE; never more than dep of the step), and each place is looked at once a round (in met, from base).
    // No way back to a place leaves an OUT once an IN has been passed, so the places are tried in JavaScript's order.
    // Gives the new len; this.work counts each place looked at.
    reach(pcs, len, pc0, prev, next, gen, seen) {
      const { op, a1, a2, sp, sf, base, met } = this;
      let m = 1, work = 0;
      sp[0] = pc0; sf[0] = RX_FRESH_NONE;
      while (m) {
        work++;
        const pc = sp[--m], fd = sf[m], o = op[pc];
        if (o === RX_CHAR || o === RX_MATCH) { if (seen[pc] !== gen) { seen[pc] = gen; pcs[len++] = pc; } continue; }
        const at = base[pc] + (fd === RX_FRESH_NONE ? 0 : fd);
        if (met[at] === gen) continue;
        met[at] = gen;
        if (o === RX_SPLIT) { sp[m] = a2[pc]; sf[m++] = fd; sp[m] = a1[pc]; sf[m++] = fd; }
        else if (o === RX_JMP) { sp[m] = a1[pc]; sf[m++] = fd; }
        else if (o === RX_ASSERT) { if (rxHolds(a1[pc], prev, next)) { sp[m] = pc + 1; sf[m++] = fd; } }
        else if (o === RX_IN) { sp[m] = pc + 1; sf[m++] = Math.min(fd, a1[pc]); }
        else if (fd > a1[pc]) { sp[m] = pc + 1; sf[m++] = RX_FRESH_NONE; }        // RX_OUT, of a copy that read something
      }
      this.work += work;
      return len;
    }
    places() {                                          // made when find() is first called: test() needs none of it
      if (this.base) return;
      const { dep } = this, base = new Int32Array(dep.length);
      let n = 0;
      for (let pc = 0; pc < dep.length; pc++) { base[pc] = n; n += dep[pc] + 1; }
      this.base = base; this.met = new Int32Array(n);
    }
    // reach() from the start alone, before a code unit of class c (-1: at the end) after one of kind prev, worked out
    // once for each kind and class: the end of the pattern and the steps that read c, as reach() orders them (a step
    // that does not read c ends there, and it is left out)
    begin(prev, c) {
      const key = prev * (this.K + 1) + c + 1;
      let o = this.begins.get(key);
      if (o === undefined) {
        const { op, a1, K, has } = this, out = new Int32Array(op.length), n = this.reach(out, 0, 0, prev, c < 0 ? 0 : this.kinds[c], this.bump(), this.seenAt);
        o = out.slice(0, n).filter((pc) => op[pc] === RX_MATCH || (c >= 0 && has[a1[pc] * K + c] === 1));
        this.begins.set(key, o);
      }
      return o;
    }
    // Every thread at once, in the order JavaScript would try them, each with where it started: the first to reach
    // the end of the pattern wins over every thread after it, and the threads before it go on for a later end. The
    // steps from the start are put after the threads already there (begin()), less those they reached already.
    find(s, from, most = Infinity) {
      this.places();
      const { op, a1, has, K, cmap, kinds, seen } = this, L = op.length, n = s.length;
      const classAt = (p) => (p < 0 || p >= n ? -1 : cmap[s.charCodeAt(p)]);
      let cpc = new Int32Array(L), cst = new Int32Array(L), npc = new Int32Array(L), nst = new Int32Array(L), cn = 0, matched = null;
      let before = classAt(from - 1), here = classAt(from);
      this.work = 0;
      let gen = this.bump();
      for (let i = from; i <= n; i++) {
        const after = classAt(i + 1), prev = here < 0 ? 0 : kinds[here], next = after < 0 ? 0 : kinds[after];
        this.work++;
        if (matched === null) {
          const open = this.begin(before < 0 ? 0 : kinds[before], here);      // its round is not this one: seen is kept
          this.work += open.length;
          for (let k = 0; k < open.length; k++) { const pc = open[k]; if (seen[pc] !== gen) { seen[pc] = gen; cpc[cn] = pc; cst[cn] = i; cn++; } }
        }
        const g = this.bump();
        let nn = 0;
        for (let k = 0; k < cn; k++) {
          if (++this.work > most) { this.steps = this.work; return null; }
          const pc = cpc[k];
          if (op[pc] === RX_MATCH) { matched = [cst[k], i]; break; }
          if (here >= 0 && has[a1[pc] * K + here]) { const was = nn; nn = this.reach(npc, nn, pc + 1, prev, next, g, seen); nst.fill(cst[k], was, nn); }
        }
        before = here; here = after;
        if (this.work > most) { this.steps = this.work; return null; }
        [cpc, npc] = [npc, cpc]; [cst, nst] = [nst, cst]; cn = nn; gen = g;
        if (matched !== null && cn === 0) break;
      }
      this.steps = this.work;
      return matched;
    }
  }

  // ---------- case/incident_context.md ----------
  // Which collector wrote it. Before 1.5.0 the collector put its own sentences there ("- Case:", "## Reported
  // behavior", "## Best next capture") when a question was answered yes, which pressing Return also did; from 1.5.0
  // the file holds only what whoever ran it gave ("- Collector started:" opens it). Told apart by what the file holds,
  // not by the bundle, and line by line as the page's Markdown reader reads it, so that nothing inside a typed line
  // or a path can pass for a line of its own. The page, the text commands and request mode all ask this one function.
  // 'old' (an older collector's wording is in it), 'given' (this collector's file) or 'other'.
  // A file is this collector's when it opens as this collector writes it (CONTEXT_OPENS: its title, a blank line, then
  // "- Collector started:") and has no line of the older wording: from 1.5.0 the note and the path are each on a line
  // of their own after four spaces, so this collector never writes one. A file that has both was not written as either
  // collector writes it, and the older wording in it is said of as in any other file that has it (contextRead).
  const CONTEXT_OPENS = (lines) => lines[0] === '# Incident context' && lines[1] === '' && /^- Collector started: /.test(lines[2] ?? '');
  const OLD_LINE = (l) => /^- Case: /.test(l) || /^## (Reported behavior|Best next capture)\s*$/.test(l);
  function contextKind(text) {
    const lines = text.split(/\r?\n/);
    if (lines.some(OLD_LINE)) return 'old';
    return CONTEXT_OPENS(lines) ? 'given' : 'other';
  }
  // What is said once above the file, by which collector wrote it: the page, the text commands and request mode all
  // say these sentences, from this one function. Before 1.5.0 the collector wrote sentences of its own into the file,
  // which read as if someone had typed them: under two headings, for the case pivot-filter only. Its "Case" line held
  // pivot-filter when its PivotTable question was answered yes, or whatever --case was given, which can be words
  // somebody chose. So each part is said only when the file has it, found line by line as contextKind finds it, and
  // the text under a heading is said to be the older collector's own only when it is word for word what that
  // collector wrote there (OLD_SECTIONS, from its source): the file is the bundle's text, and anyone can have written
  // other lines under the same heading. From 1.5.0 the file holds the --note line, which the collector checks against
  // nothing, and the --workbook path, which it uses to read the workbook's facts. Each sentence is one of the fixed
  // ones below, with only the fixed heading names put in: nothing of the file's own text is ever in one.
  // { kind, said }: kind is 'given', 'old' (the Case line, or the text under one of the headings, is the older
  // collector's) or 'other'; said is the sentences, in order.
  const OLD_CASE_LINE = 'Collectors before 1.5.0 wrote the "Case" line in this file: pivot-filter when their question "Is this the crash when filtering a PivotTable?" was answered yes, which pressing Return also did, or what was given with --case.';
  const OLD_SECTIONS = {
    'Reported behavior': ['Excel crashes when a user filters within a PivotTable.'],
    'Best next capture': ['If Excel freezes before it closes, run: sudo ./excel_diagnostics.sh hang --case pivot-filter',
      'To capture the crash as it happens, run: sudo ./excel_diagnostics.sh repro --case pivot-filter, reproduce it, wait 30 seconds, then press Ctrl-C',
      'After an immediate crash, run: sudo ./excel_diagnostics.sh collect --case pivot-filter --since YYYY-MM-DD --until YYYY-MM-DD', 'The workbook is not copied by this collector.'],
  };
  const GIVEN_SAID = 'The note in this file, where it has one, is from what whoever ran the collector typed or gave it, and the collector checked it against nothing it collected. Its workbook path, where it has one, is from the path that was given.';
  const BOTH_SAID = 'This file opens as collectors from 1.5.0 on write it, with "- Collector started:" as its third line, and it also has lines that only collectors before 1.5.0 wrote, which collectors from 1.5.0 on never write.';
  const headingsSaid = (names) => names.map((n) => `"${n}"`).join(' and ');      // at most the two headings
  function contextRead(text) {
    const kind = contextKind(text);
    if (kind === 'given') return { kind, said: [GIVEN_SAID] };
    if (kind !== 'old') return { kind, said: [] };
    // Each heading's text runs to the next heading, as the page's Markdown reader finds one (one to six # and a space:
    // a line such as "#", "#1" or "####### x" is text under the heading, and is compared with the rest); a heading that
    // is in the file twice is the collector's only if the text under each is
    const lines = text.split(/\r?\n/), caseLine = lines.some((l) => /^- Case: /.test(l)), word = new Map(), both = CONTEXT_OPENS(lines);
    lines.forEach((l, k) => {
      const h = /^## (Reported behavior|Best next capture)\s*$/.exec(l);
      if (!h) return;
      let end = k + 1;
      while (end < lines.length && !/^#{1,6} /.test(lines[end])) end++;
      const under = lines.slice(k + 1, end).filter((x) => x.trim()), want = OLD_SECTIONS[h[1]];
      word.set(h[1], (word.get(h[1]) ?? true) && under.length === want.length && under.every((x, j) => x === want[j]));
    });
    const same = [...word].filter(([, w]) => w).map(([n]) => n), other = [...word].filter(([, w]) => !w).map(([n]) => n);
    const said = [both ? BOTH_SAID : '', caseLine ? OLD_CASE_LINE : '',
      same.length ? `The text under ${headingsSaid(same)} in this file is word for word what collectors before 1.5.0 wrote there for the case pivot-filter.` : '',
      other.length ? `This file has the heading${other.length > 1 ? 's' : ''} ${headingsSaid(other)}, which collectors before 1.5.0 wrote for the case pivot-filter, and the text under ${other.length > 1 ? 'them' : 'it'} here is not what they wrote there.` : ''];
    // both: the page titles such a file as neither collector's
    return { kind: caseLine || same.length ? 'old' : 'other', said: said.filter(Boolean), ...(both ? { both } : {}) };
  }

  // ---------- the shape of a message ----------
  // What a message has in common with others that differ from it only in what changes from one run to the next (a
  // process ID, an address, a time, a request's UUID), so that entries can be counted by it. The rule is fixed:
  //  - only the first SHAPE_READ characters of the message are read, and the shape of a longer one ends in an ellipsis;
  //  - each run of white space (line breaks and tabs among it) is one space, and none is kept at either end;
  //  - a word is a run of ASCII letters, digits and underscores. A UUID (hex digits in groups of 8, 4, 4, 4 and 12 joined
  //    by hyphens) is one word. A word that is a UUID, 0x and hex digits, or hex digits only with a digit among them is
  //    a number, and in any other word each run of digits is a number;
  //  - each number is written #, and numbers joined by a single . : - / or , are one #: a time, a date, a version or an
  //    address is one #. Everything else is kept as it is.
  // Each character is looked at a fixed number of times (a UUID is looked for at the start of a word, 36 characters at
  // most), and nothing is read past SHAPE_READ, so no message, however it was written, makes this slow.
  const SHAPE_READ = 120, JOINS = new Set(['.', ':', '-', '/', ',']);
  const wordAt = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  const hexAt = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  const digitAt = (c) => c >= 48 && c <= 57;
  const spaceAt = (c) => c <= 32 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  function uuidAt(s, i) {
    if (i + 36 > s.length || (i + 36 < s.length && wordAt(s.charCodeAt(i + 36)))) return false;
    for (let k = 0; k < 36; k++) {
      const c = s.charCodeAt(i + k);
      if (k === 8 || k === 13 || k === 18 || k === 23 ? c !== 45 : !hexAt(c)) return false;
    }
    return true;
  }
  function wordShape(s, a, b) {
    let hex = true, digit = false;
    for (let k = a; k < b; k++) { const c = s.charCodeAt(k); if (digitAt(c)) digit = true; else if (!hexAt(c)) hex = false; }
    if (hex && digit) return '#';
    if (b - a > 2 && s.charCodeAt(a) === 48 && (s.charCodeAt(a + 1) | 32) === 120) {
      let all = true;
      for (let k = a + 2; k < b && all; k++) all = hexAt(s.charCodeAt(k));
      if (all) return '#';
    }
    if (!digit) return s.slice(a, b);
    let w = '';
    for (let k = a; k < b;) {
      if (!digitAt(s.charCodeAt(k))) { w += s[k++]; continue; }
      while (k < b && digitAt(s.charCodeAt(k))) k++;
      w += '#';
    }
    return w;
  }
  function messageShape(msg) {
    const s = String(msg);
    let n = Math.min(s.length, SHAPE_READ);
    if (n < s.length && s.charCodeAt(n - 1) >= 0xD800 && s.charCodeAt(n - 1) <= 0xDBFF) n--;      // not through the middle of a character
    const t = s.slice(0, n), parts = [];
    const put = (p) => {                                // a number joined to the number before it by one separator is that number
      const k = parts.length;
      if (p === '#' && k >= 2 && parts[k - 2] === '#' && JOINS.has(parts[k - 1])) parts.pop();
      else parts.push(p);
    };
    for (let i = 0; i < n;) {
      const c = t.charCodeAt(i);
      if (spaceAt(c)) { while (i < n && spaceAt(t.charCodeAt(i))) i++; if (parts.length) parts.push(' '); continue; }
      if (!wordAt(c)) { put(t[i++]); continue; }
      if (uuidAt(t, i)) { put('#'); i += 36; continue; }
      let j = i;
      while (j < n && wordAt(t.charCodeAt(j))) j++;
      put(wordShape(t, i, j));
      i = j;
    }
    if (parts[parts.length - 1] === ' ') parts.pop();
    return parts.join('') + (n < s.length ? '…' : '');
  }

  // ---------- made-up sample bundle, so the page can be tried without real data ----------
  function sampleBundle(scale = 1) {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, pick = (a) => a[(rnd() * a.length) | 0];
    const base = Date.UTC(2026, 2, 10, 13, 0, 0), om = -240, span = 3 * 3600e3, crash = base + 95 * 60e3, relaunch = crash + 70e3;
    const local = (t, digits) => stamp(t + om * 60000, digits);
    const files = [], add = (path, text) => files.push({ path: 'Excel_Diagnostics_sample/' + path, blob: new Blob([text]) });
    const books = ['Q1 Forecast.xlsx', 'Regional Sales Pivot.xlsx', 'Headcount Plan.xlsx'];

    // unified log
    const U = ['local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage'];
    const quiet = [
      ['Default', 'runningboardd', 164, 'RunningBoard', 'com.apple.runningboard', 'process', 'mentions-excel', () => `[app<application.com.microsoft.Excel.${1000 + (rnd() * 9000 | 0)}>] Ignoring jetsam update because this process is not memory-managed`],
      ['Info', 'UserEventAgent', 101, 'UserEventAgent', 'com.apple.cfprefsd', 'daemon', 'mentions-excel', () => `Captured event for com.microsoft.Excel: appIsActive=${rnd() > 0.5}`],
      ['Default', 'Microsoft Excel', 0, 'AppKit', 'com.apple.AppKit', 'Window', 'excel', () => `order window front conditionally: ${(rnd() * 4000) | 0} related: 0`],
      ['Info', 'Microsoft Excel', 0, 'CFNetwork', 'com.apple.CFNetwork', 'Default', 'excel', () => `Task <${(rnd() * 1e9 | 0).toString(16).toUpperCase()}>.<${1 + (rnd() * 40 | 0)}> finished successfully`],
      ['Debug', 'Microsoft Excel', 0, 'CoreFoundation', 'com.apple.defaults', 'User Defaults', 'excel', () => `found no value for key ${pick(['NSWindowTabbingShoudShowTabBarKey', 'AppleLanguages', 'kMSOAutoRecoverInterval'])} in CFPrefsSource`],
      ['Default', 'filecoordinationd', 388, 'Foundation', 'com.apple.FileCoordination', 'claims', 'mentions-excel', () => `Claim ${(rnd() * 1e8 | 0).toString(16)} granted in server for Microsoft Excel: ${pick(books)}`],
      ['Default', 'kernel', 0, 'kernel', '', '', 'memory', () => `memorystatus: set assertion priority(${3 + (rnd() * 7 | 0)}) for Microsoft Excel`],
      ['Info', 'Microsoft Update Assistant', 2210, 'Microsoft Update Assistant', '', '', 'microsoft', () => `Checking for updates for application ${pick(['XCEL2019', 'MSWD2019', 'PPT32019'])}`],
    ];
    const allocError = ['Error', 'Microsoft Excel', 0, 'libsystem_malloc.dylib', 'com.apple.libmalloc', 'default', 'excel', () => `PivotCache: could not grow record buffer to ${2 + (rnd() * 6 | 0)} GB (out of memory), retrying with a smaller block`];
    const fontError = ['Error', 'Microsoft Excel', 0, 'CoreText', 'com.apple.CoreText', 'default', 'excel', () => `CTFontManagerRegisterFontsForURL failed for font ${pick(['Aptos.ttf', 'Calibri.ttf'])}: already registered`];
    const n = Math.round(24000 * scale);
    let pid = 4121;
    for (let i = 0; i < n; i++) {
      const storm = rnd() < 0.14;                          // the minutes before the crash are much busier
      const t = storm ? crash - 240e3 * rnd() * rnd() : base + (i / n) * span + rnd() * 50;
      if (t > crash && t < relaunch) continue;
      pid = t >= relaunch ? 4307 : 4121;
      const q = storm && rnd() < 0.25 ? allocError : rnd() < 0.006 ? fontError : pick(quiet);
      U.push(`${local(t, 6)}-0400\t${stamp(t, 6)}\t${q[0]}\t${q[1]}\t${q[2] || pid}\t${q[3]}\t${q[4]}\t${q[5]}\t${q[6]}\t${q[7]()}`);
    }
    const burst = [
      [-41e3, 'Default', 'Microsoft Excel', 4121, 'excel', 'PivotTable filter requested on field "Region" (items: 48211)'],
      [-38e3, 'Default', 'kernel', 0, 'memory', 'memorystatus: Microsoft Excel [4121] exceeded mem limit: ActiveSoft 6144 MB (non-fatal)'],
      [-31e3, 'Default', 'kernel', 0, 'memory', 'vm_compressor: compressor pool usage 91%, swapping out'],
      [-22e3, 'Error', 'WindowServer', 388, 'mentions-excel', 'disable_update_timeout: UI updates were forcibly re-enabled for application "Microsoft Excel" after 1.00 seconds'],
      [-20e3, 'Default', 'spindump', 771, 'hang-report,mentions-excel', 'Microsoft Excel [4121] is unresponsive, sampling for 10 seconds'],
      [-6e3, 'Fault', 'Microsoft Excel', 4121, 'excel', 'Unhandled exception in PivotCache refresh\\n  0  Microsoft Excel  0x0000000104a3c1f0 PivotFilterApply + 532\\n  1  Microsoft Excel  0x0000000104a3b9d4 PivotTableUpdate + 96'],
      [0, 'Default', 'launchd', 1, 'mentions-excel', 'exited due to SIGSEGV | sent by exc handler[4121], ran for 5714012ms: application.com.microsoft.Excel.4121'],
      [1500, 'Default', 'ReportCrash', 5120, 'mentions-excel', 'Saved crash report for Microsoft Excel[4121] version 16.114 to Microsoft Excel-2026-03-10-103500.ips'],
      [2500, 'Default', 'Microsoft Error Reporting', 5131, 'microsoft', 'Crash log found for Microsoft Excel; preparing report dialog'],      // a little permissions and storage activity, so those tags have something to show
      [-83 * 60e3, 'Default', 'tccd', 412, 'mentions-excel,permissions', 'AUTHREQ_SUBJECT: msgID=412.38, subject=com.microsoft.Excel,'],
      [-83 * 60e3 + 40, 'Error', 'tccd', 412, 'mentions-excel,permissions', 'Prompting policy for hardened runtime; service: kTCCServiceCalendar requires entitlement com.apple.security.personal-information.calendars but it is missing for accessing={TCCDProcess: identifier=com.microsoft.Excel, pid=4121}'],
      [-52 * 60e3, 'Error', 'kernel', 0, 'mentions-excel,permissions', 'Sandbox: Microsoft Excel(4121) deny(1) file-read-data /Volumes/Finance/Regional Sales Pivot.xlsx'],
      [-52 * 60e3 + 900, 'Default', 'Microsoft Excel', 4121, 'excel,permissions', 'os_unix.c:47395: (1) open(/Volumes/Finance/.quarantine-events) - Operation not permitted'],
      [-19 * 60e3, 'Error', 'Microsoft Excel', 4121, 'excel,storage', 'AutoRecover could not save "Regional Sales Pivot.xlsx": Error Domain=NSPOSIXErrorDomain Code=28 "No space left on device"'],
    ];
    for (const [dt, lv, pr, p, tags, msg] of burst) U.push(`${local(crash + dt, 6)}-0400\t${stamp(crash + dt, 6)}\t${lv}\t${pr}\t${p}\t${pr}\t\t\t${tags}\t${msg}`);
    const header = U.shift();
    U.sort((a, b) => (a.slice(32, 58) < b.slice(32, 58) ? -1 : 1));
    U.unshift(header);
    add('unified_logs/2026-03-10.tsv', U.join('\n') + '\n');
    add('unified_logs/collection_status.txt', `Date | Status\n2026-03-10 | ok (${U.length - 1} entries)\n`);

    // Excel's own log (UTC, CRLF)
    const X = ['Timestamp\tProcess\tTID\tArea\tCategory\tEventID\tLevel\tMessage\tCorrelation'];
    const usd = (t) => { const s = stamp(t); return `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)} ${s.slice(11)}`; };
    const cats = ['Telemetry Event', 'Next user licensing', 'XLS PivotTable', 'MSO AutoRecover', 'Identity', 'Graphics'];
    const xn = Math.round(9000 * scale);
    for (let i = 0; i < xn; i++) {
      const t = base + (i / xn) * span;
      if (t > crash && t < relaunch) continue;
      const c = pick(cats), r = rnd();
      const lv = r < 0.004 ? 'Unexpected' : r < 0.03 ? 'Monitorable' : 'Medium';
      const msg = c === 'XLS PivotTable' ? `PivotCache::Refresh ${JSON.stringify({ Workbook: pick(books), Records: (rnd() * 50000) | 0, DurationMs: (rnd() * 900) | 0 })}`
        : c === 'MSO AutoRecover' ? `AutoRecover save completed ${JSON.stringify({ File: pick(books), Bytes: (rnd() * 4e7) | 0 })}`
          : `${c.replace(/ /g, '')}::Log ${JSON.stringify({ Activity: pick(['Idle', 'Recalc', 'Paint', 'Sync']), Result: lv === 'Unexpected' ? 'Failed' : 'Ok', Value: (rnd() * 1000) | 0 })}`;
      X.push(`${usd(t)}\tEXCEL (0x${(t < crash ? 4121 : 4307).toString(16).toUpperCase()})\t0x${(1 + (rnd() * 40 | 0)).toString(16)}\tMicrosoft Excel\t${c}\t${(rnd() * 1e6 | 0).toString(36)}\t${lv}\t${msg}\t`);
    }
    X.push(`${usd(crash - 6100)}\tEXCEL (0x1019)\t0x1\tMicrosoft Excel\tXLS PivotTable\tb7q2x\tUnexpected\tPivotFilter::Apply failed {"Field":"Region","Items":48211,"HRESULT":"0x8007000E","Reason":"E_OUTOFMEMORY"}\t`);
    add('office/excel_container_logs/Diagnostics/EXCEL/Primary1773147600000000000_SAMPLE.log', X.join('\r\n') + '\r\n');

    const A = [];
    for (let i = 0; i < 40; i++) {
      const t = base + 120e3 + i * 255e3;
      A.push(`${local(t, 0)} [Microsoft Update Assistant] <${i % 13 === 5 ? 'Warning' : 'Info'}> ${i % 13 === 5 ? 'CriticalSecurityUpdates.Manifest: {"Error":"Unable to retrieve security manifest. Error: -1100","Operation":"Download"}' : 'NOT.COLLECTED: {"Payload":"Checking for updates"}'}`);
    }
    add('office/autoupdate.log', A.join('\n') + '\n');
    add('system/sleep_wake.txt', `${local(base + 20e3, 0)} -0400 Wake                \tWake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open\t\n${local(base + span - 600e3, 0)} -0400 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using AC (Charge:100%) 540 secs  \n`);
    const xlPath = '/Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel';
    add('reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips',
      `{"app_name":"Microsoft Excel","timestamp":"${local(crash, 0)}.00 -0400","app_version":"16.114","build_version":"16.114.26030814","bug_type":"309","os_version":"macOS 15.7.8 (24G824)","name":"Microsoft Excel"}\n` +
      JSON.stringify({ procName: 'Microsoft Excel', pid: 4121, procPath: xlPath, cpuType: 'ARM-64', translated: false, modelCode: 'MacBookPro18,1', parentProc: 'launchd', parentPid: 1,
        bundleInfo: { CFBundleShortVersionString: '16.114', CFBundleVersion: '16.114.26030814', CFBundleIdentifier: 'com.microsoft.Excel' },
        exception: { codes: '0x0000000000000001, 0x0000000000000018', type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV', subtype: 'KERN_INVALID_ADDRESS at 0x0000000000000018' },
        termination: { flags: 0, code: 11, namespace: 'SIGNAL', indicator: 'Segmentation fault: 11', byProc: 'exc handler', byPid: 4121 }, faultingThread: 0,
        threads: [{ id: 90011, queue: 'com.apple.main-thread', triggered: true, frames: [{ imageOffset: 77840, symbol: 'PivotFilterApply', symbolLocation: 532, imageIndex: 0 }, { imageOffset: 75732, symbol: 'PivotTableUpdate', symbolLocation: 96, imageIndex: 0 },
          { imageOffset: 9120, imageIndex: 0 }, { imageOffset: 230224, symbol: '-[NSApplication run]', symbolLocation: 480, imageIndex: 1 }, { imageOffset: 24916, symbol: 'start', symbolLocation: 2840, imageIndex: 2 }] },
        { id: 90012, frames: [{ imageOffset: 3984, symbol: 'mach_msg2_trap', symbolLocation: 8, imageIndex: 3 }] }],
        usedImages: [{ name: 'Microsoft Excel', path: xlPath, arch: 'arm64', CFBundleShortVersionString: '16.114', CFBundleIdentifier: 'com.microsoft.Excel' }, { name: 'AppKit', path: '/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit', arch: 'arm64e' },
          { name: 'dyld', path: '/usr/lib/dyld', arch: 'arm64e' }, { name: 'libsystem_kernel.dylib', path: '/usr/lib/system/libsystem_kernel.dylib', arch: 'arm64e' }] }, null, 2) + '\n');
    add('reports/crash_summary.txt', `# Diagnostic report summary\n\n## reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-103230.ips\nReport type: bug type 298\nDate/Time: ${local(crash - 150e3, 0)}.00 -0400\nOS Version: macOS 15.7.8 (24G824)\nLargest process: Microsoft Excel\n\n` +
      `## reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips\nReport type: bug type 309\nProcess: Microsoft Excel\nVersion: 16.114 (16.114.26030814)\nDate/Time: ${local(crash, 0)}.00 -0400\nOS Version: macOS 15.7.8 (24G824)\n` +
      'Exception Type: EXC_BAD_ACCESS (SIGSEGV)\nException Subtype: KERN_INVALID_ADDRESS at 0x0000000000000018\nTermination: Segmentation fault: 11\nCrashed Thread: 0\n');

    const procs = [['Microsoft Excel', 4307, 688, 141], ['WindowServer', 388, 512, 96], ['Browser Helper (Renderer)', 2110, 474, 310], ['Chat Helper (Renderer)', 1532, 431, 288], ['Mail', 911, 302, 120],
      ['Browser', 2101, 260, 88], ['Finder', 640, 148, 61], ['OneDrive', 1145, 96, 58], ['Dock', 633, 71, 30], ['Spotlight', 702, 64, 22], ['Notes', 1290, 58, 19], ['Terminal', 3320, 44, 8]];
    const snapAt = base + span + 220e3;
    add('system/system_info.txt', '=== Collected ===\nTue Mar 10 12:03:33 EDT 2026\nTue Mar 10 16:03:33 UTC 2026\nMode: collect  Days: 1  Ran as: root  Console user: sample\n\n=== macOS ===\nProductName:\t\tmacOS\nProductVersion:\t\t15.7.8\nBuildVersion:\t\t24G824\n\n' +
      '=== Hardware ===\nHardware:\n\n    Hardware Overview:\n\n      Model Name: MacBook Pro\n      Model Identifier: MacBookPro18,1\n      Chip: Apple M1 Pro\n      Total Number of Cores: 10 (8 performance and 2 efficiency)\n      Memory: 16 GB\n' +
      '=== Uptime / load ===\n12:03  up 6 days,  2:41, 2 users, load averages: 2.31 2.87 3.40\n\n=== Disk ===\nFilesystem        Size    Used   Avail Capacity iused ifree %iused  Mounted on\n' +
      '/dev/disk3s1s1   460Gi    10Gi    41Gi    21%    453k  427M    0%   /\n/dev/disk3s5     460Gi   402Gi    41Gi    91%    2.1M  427M    0%   /System/Volumes/Data\n');
    add('office/versions.txt', 'Microsoft Excel: 16.114 (16.114.26030814)\nMicrosoft Word: 16.114 (16.114.26030814)\nOneDrive: 26.035 (26035.0221)\n\n=== Excel processes ===\n4307 /Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel\n');
    add('bundle_info.tsv', 'collector_version\t1.5.0\nmode\tcollect\ncollected_local\t2026-03-10 12:03:40 EDT\ncollected_utc\t2026-03-10 16:03:40\nmacos_version\t15.7.8\nmacos_build\t24G824\nmodel_name\tMacBook Pro\nmodel_identifier\tMacBookPro18,1\n' +
      'chip\tApple M1 Pro\nmemory\t16 GB\nexcel_version\t16.114\nexcel_build\t16.114.26030814\nlog_format\ttsv\n');
    add('system/memory.txt', `=== ${new Date(snapAt + om * 60000).toUTCString().slice(0, 25)} EDT 2026 / ${stamp(snapAt, 0)} UTC ===\nMemory pressure level (1=normal 2=warning 4=critical): 1\nSwap: total = 2048.00M  used = 1200.00M  free = 848.00M  (encrypted)\n` +
      '--- top processes by memory (MEM = physical footprint, CMPRS = compressed)\nProcesses: 512 total, 3 running, 509 sleeping, 2890 threads \nPhysMem: 11G used (2100M wired, 1500M compressor), 4200M unused.\n\nPID    COMMAND          MEM  CMPRS %CPU #TH \n' +
      procs.map(([n, p, m, c]) => `${String(p).padEnd(6)} ${n.slice(0, 16).padEnd(16)} ${(m + 'M').padEnd(4)} ${(c + 'M').padEnd(5)} ${(rnd() * 9).toFixed(1).padEnd(4)} ${12 + (rnd() * 40 | 0)}  `).join('\n') +
      '\n--- vm_stat\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                              268800.\nPages active:                            310021.\n--- memory_pressure\nThe system has 17179869184 (1048576 pages with a page size of 16384).\n\n');
    const fcats = [['MALLOC_SMALL', 212, 41], ['MALLOC_NANO', 148, 3], ['MALLOC_MEDIUM', 96, 12], ['IOSurface', 88, 164], ['MALLOC_TINY', 51, 80], ['MALLOC_LARGE', 34, 5], ['CoreAnimation', 18, 733], ['CG raster data', 14, 402],
      ['__DATA', 11, 1040], ['untagged (VM_ALLOCATE)', 7, 120], ['CoreUI image data', 4, 61], ['stack', 2, 46], ['page table', 2, 1], ['ColorSync', 1, 38]];
    add('office/excel_footprint.txt', '======================================================================\nMicrosoft Excel [4307]: 64-bit    Footprint: 688 MB (16384 bytes per page)\n======================================================================\n\n' +
      '  Dirty      Clean  Reclaimable    Regions    Category\n    ---        ---          ---        ---    ---\n' + fcats.map(([c, mb, rg]) => `${String(mb).padStart(4)} MB        0 B          0 B ${String(rg).padStart(10)}    ${c}`).join('\n') +
      '\n    ---        ---          ---        ---    ---\n 688 MB        0 B          0 B       2746    TOTAL\n');
    const jetAt = crash - 150e3, pg = (mb) => Math.round(mb * 64);   // 16 KB pages
    add(`reports/Library_Logs_DiagnosticReports/JetsamEvent-${local(jetAt, 0).slice(0, 10)}-${local(jetAt, 0).slice(11).replace(/:/g, '')}.ips`,
      `{"bug_type":"298","timestamp":"${local(jetAt, 0)}.00 -0400","os_version":"macOS 15.7.8 (24G824)","roots_installed":0,"incident_id":"SAMPLE"}\n` + JSON.stringify({ build: 'macOS 15.7.8 (24G824)', product: 'MacBookPro18,1', date: `${local(jetAt, 0)}.00 -0400`, bug_type: '298',
        memoryStatus: { compressorSize: pg(4650), pageSize: 16384, memoryPages: { active: pg(5200), inactive: pg(2900), wired: pg(2300), free: pg(96), purgeable: pg(12), speculative: pg(40) } }, largestProcess: 'Microsoft Excel',
        processes: [{ name: 'Microsoft Excel', pid: 4121, rpages: pg(5980), lifetimeMax: pg(6102), states: ['frontmost'] }, { name: 'Browser Helper (Renderer)', pid: 2110, rpages: pg(612), lifetimeMax: pg(905), states: ['suspended'], reason: 'vm-pageshortage' },
          { name: 'Chat Helper (Renderer)', pid: 1532, rpages: pg(540), lifetimeMax: pg(760), states: ['suspended'], reason: 'vm-pageshortage' }, { name: 'WindowServer', pid: 388, rpages: pg(498), lifetimeMax: pg(540), states: ['daemon'] },
          { name: 'Mail', pid: 911, rpages: pg(288), lifetimeMax: pg(410), states: ['idle'] }, { name: 'Finder', pid: 640, rpages: pg(140), lifetimeMax: pg(190), states: ['idle'] }, { name: 'Notes', pid: 1290, rpages: pg(52), lifetimeMax: pg(80), states: ['idle'], reason: 'per-process-limit' },
          { name: 'Spotlight', pid: 702, rpages: pg(60), lifetimeMax: pg(75), states: ['daemon'] }, { name: 'Dock', pid: 633, rpages: pg(66), lifetimeMax: pg(90), states: ['daemon'] }] }, null, 1) + '\n');

    const M = ['local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,excel_compressed_mb,excel_threads,pressure_level,free_mb,compressor_mb,swap_used_mb'];
    for (let t = base; t < base + span; t += 30e3) {
      const up = t < crash, k = up ? (t - base) / (crash - base) : (t - relaunch) / span;
      if (t > crash && t < relaunch) { M.push(`${local(t, 0)},${stamp(t, 0)},,,,,,2,${900 + (rnd() * 200 | 0)},3100,1800`); continue; }
      const foot = Math.round(up ? 700 + 5600 * k * k : 650 + 900 * k), cmp = Math.round(foot * (up ? 0.25 + 0.3 * k : 0.2));
      M.push(`${local(t, 0)},${stamp(t, 0)},${up ? 4121 : 4307},${(rnd() * (up && k > 0.9 ? 99 : 30)).toFixed(1)},${foot},${cmp},${40 + (rnd() * 12 | 0)},${up && k > 0.85 ? 4 : up && k > 0.6 ? 2 : 1},${Math.round(up ? 5200 - 4700 * k : 4200)},${Math.round(up ? 600 + 4200 * k : 1500)},${Math.round(up ? 3900 * k * k : 1200)}`);
    }
    add('excel_memory_timeline.csv', M.join('\n') + '\n');
    add('manifest.tsv', 'component\tstatus\tdetails\nunified_log_tags\tcomplete\texcel, excel-helper, microsoft, hang-report, mentions-excel, memory, restart, permissions, storage, logs-dropped\nsystem\tcomplete\tsystem, memory, sleep/wake, network state\noffice\tcomplete\tversions, Excel logs, AutoRecover, add-ins, preferences\nreports\tcomplete\tdiagnostic reports, by the rule in source_catalog.tsv, and the CrashReporter files named Microsoft* or Intervals*\nunified_logs\tcomplete\t1 day(s), 2026-03-10 through 2026-03-10\n');
    add('collection.log', '[12:01:02] Excel diagnostics: collect (2026-03-10 through 2026-03-10) for user sample\n[12:01:02] System information\n[12:01:09] Unified logs (Excel, hangs/terminations, memory pressure), 2026-03-10 through 2026-03-10\n[12:03:40] Done.\n');
    add('summary.md', `# Excel diagnostics summary\n\nThis is made-up sample data that ships with the viewer. In it, Excel's memory climbs for an hour and a half, a PivotTable filter is asked for, Excel crashes at ${local(crash, 0)} local time, and it is started again.\n\n- Collected: 2026-03-10 12:03:40 EDT\n- Collector version: 1.5.0\n- Console user: sample\n- Mode: collect\n- Incident window: 2026-03-10 through 2026-03-10 (1 day(s))\n\n## Collection status\n\n| Component | Status | Details |\n| --- | --- | --- |\n| system | complete | system, memory, sleep/wake, network state |\n| office | complete | versions, Excel logs, AutoRecover, add-ins, preferences |\n| reports | complete | crash, hang, spin and jetsam reports |\n| unified_logs | complete | 1 day(s) |\n\n## Things to try\n\n1. Search for \`pivot\`, then press \`e\` to step through the errors.\n2. Drag across the spike in the histogram to zoom in on the crash.\n3. Open the Memory tab and click just before the drop.\n`);
    return files;
  }

  return { Dataset, sampleBundle, SEV, stamp, isoAt, offStr, timeBad, daysIn, TIME_FIRST, TIME_LAST, readZip, Entry, contextKind, contextRead, queryTerms, rxCompile, RX_MOST, messageShape, SHAPE_READ, levelSev };
})();

// ---------- worker entry point ----------
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let ds = null, lastPost = 0;
  const progress = (p) => { const now = Date.now(); if (p.done === undefined || now - lastPost > 80) { lastPost = now; postMessage({ progress: p }); } };
  const api = {
    load: ({ inputs, sample }) => { ds = new Core.Dataset(); return ds.load(sample ? Core.sampleBundle(1) : inputs, progress); },
    query: (q) => ds.query(q, progress),
    rows: ({ start, count }) => ds.rows(start, count),
    row: ({ pos }) => ds.row(pos),
    seek: ({ t }) => ds.seek(t),
    findSev: ({ from, dir, min }) => ds.findSev(from, dir, min),
    exportTsv: ({ positions }) => ds.exportTsv(progress, positions),
    fileBlob: ({ i }) => ds.entries[i].blob(),
    fileChunk: ({ i, offset, len }) => ds.fileChunk(i, offset, len),
    tagTimes: ({ tag, bins }) => ds.tagTimes(tag, bins),
    facts: () => ds.facts(),
    marks: () => ds.marks(),
    report: ({ path }) => ds.report(path),
    contextRead: ({ text }) => Core.contextRead(text),
  };
  self.onmessage = async (ev) => {
    const { id, op, args } = ev.data;
    try { postMessage({ id, result: await api[op](args || {}) }); }
    catch (err) { postMessage({ id, error: (err && err.message) || String(err) }); }
  };
}

/* Excel diagnostics command-line tool: the viewer's indexing and search engine (above), driven from a terminal.
 *
 * Made for use without a browser, by a person or by an agent. Every command says what it searched, what it found
 * and what could be run next. It reports what the logs hold and leaves the conclusions to the reader.
 * Nothing is sent anywhere: the only files it reads are the bundle's, and it writes only where it says it does.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { Duplex } from 'node:stream';

const VERSION = '1.2';
const SEV = Core.SEV;
const VIEWER_URL = 'https://cadengithubb.github.io/Excel_Diagnostics/';

try { new DecompressionStream('deflate-raw'); } catch (e) {       // older Node: inflate zip members with zlib instead
  globalThis.DecompressionStream = class { constructor() { return Duplex.toWeb(zlib.createInflateRaw()); } };
}

// ---------- what reaches the terminal ----------
// What is printed holds text from the bundle, written by whoever made it. A control character in it is shown,
// never sent: sent, it would be the terminal's to act on (move the cursor, retitle the window, write to the
// clipboard, hide or reorder what follows). Tabs and line ends stay. Everything this tool writes to a terminal
// goes through shown(): the lines gathered for the end of a command, and what is written at once to standard
// error while a bundle is opened (toErr), where the name of a zip is the name its sender gave it.
const odd = (n) => n < 9 || (n > 10 && n < 32) || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029 || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
// Characters that take no room where they stand: every character Unicode calls default-ignorable (the soft hyphen,
// the combining grapheme joiner, the Arabic letter mark, the Hangul fillers, the Khmer inherent vowels, the Mongolian
// variation selectors and vowel separator, the zero-width space, non-joiner and joiner, the direction marks, the word
// joiner, the invisible operators and the other format characters beside them, the variation selectors, the byte
// order mark, the shorthand and musical format controls, the tag characters, and the code points kept for more of
// these), and the interlinear annotation marks. The tag characters, and the variation selectors one to a byte, can
// spell out a whole sentence. A person reading sees nothing where one is; a program reading the text gets it whole.
const unseen = (n) => n === 0xad || n === 0x34f || n === 0x61c || n === 0x115f || n === 0x1160 || n === 0x17b4 || n === 0x17b5 || (n >= 0x180b && n <= 0x180f)
  || (n >= 0x200b && n <= 0x200f) || (n >= 0x2060 && n <= 0x206f) || n === 0x3164 || (n >= 0xfe00 && n <= 0xfe0f) || n === 0xfeff || n === 0xffa0
  || (n >= 0xfff0 && n <= 0xfffb) || (n >= 0x1bca0 && n <= 0x1bca3) || (n >= 0x1d173 && n <= 0x1d17a) || (n >= 0xe0000 && n <= 0xe0fff);
// Both: what is written by its number where a name or an id is said to a model, in a suggested call or in quotation marks.
const hidden = (n) => odd(n) || unseen(n);
const shownBy = (test) => (s) => {
  let out = '';
  for (const c of String(s)) {
    const n = c.codePointAt(0);
    out += !test(n) ? c : n < 32 ? `^${String.fromCharCode(n + 64)}` : n === 127 ? '^?' : `<U+${n.toString(16).toUpperCase().padStart(4, '0')}>`;
  }
  return out;
};
const shown = shownBy(odd);
const toErr = (s) => process.stderr.write(shown(s));
// A name taken from the bundle (its own name, a file, a folder, a process, a level, a tag) is one line wherever this
// tool says it in a line of its own: a line break in it is written as \n and a tab as \t. Left as they are, they
// would start lines of the name's own, laid out like this tool's ("Next:" and a command under it). A character that
// takes no room is written by its number, so that what is printed is all the name holds. Two of them stay where
// they are part of an emoji, and only there: the variation selector right after a pictograph, which says how to draw
// it, and the zero-width joiner between two pictographs (the first perhaps with that selector or a skin tone after
// it), which joins them into one picture. Anywhere else each is written by its number like the rest.
const BREAKS = new RegExp(`\\r\\n?|[\\n\\v\\f${String.fromCodePoint(0x85, 0x2028, 0x2029)}]`, 'g');
const PICTURE = /\p{Extended_Pictographic}/u;
const pictured = (c) => c !== undefined && PICTURE.test(c);
const toned = (c) => c !== undefined && (c.codePointAt(0) === 0xfe0f || (c.codePointAt(0) >= 0x1f3fb && c.codePointAt(0) <= 0x1f3ff));
// Each character of s as roomless() writes it, one item for each: request mode cuts a line it prints at a character.
function roomlessEach(s) {
  const cs = [...String(s)];
  return cs.map((c, i) => {
    const n = c.codePointAt(0);
    if (!unseen(n)) return c;
    const emoji = n === 0x200d ? pictured(cs[i + 1]) && (pictured(cs[i - 1]) || (toned(cs[i - 1]) && pictured(cs[i - 2])))
      : (n === 0xfe0e || n === 0xfe0f) && pictured(cs[i - 1]);
    return emoji ? c : `<U+${n.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}
const roomless = (s) => roomlessEach(s).join('');
const named = (s) => roomless(String(s).replace(BREAKS, '\\n').replace(/\t/g, '\\t'));
// A command this tool suggests has to hold a name exactly, or it would not find the thing named. So a name goes
// into one only when it is printed exactly as it is: one line, with nothing in it that has to be shown another way.
// A suggestion that would need any other name is left out. A path given as an argument must also not read as an option.
const plainHere = (s) => typeof s === 'string' && s.length > 0 && s.length <= 300 && named(s) === s && shown(s) === s;
const plainArg = (s) => plainHere(s) && !s.startsWith('-');
// A name from the bundle as a column value no wider than `most` as written, ending in ~ when it was cut: written as
// namedEach() writes it (a line break as \n, a character that would act or takes no room by its number), and cut at
// a whole item, so never through the middle of a character or of a character written by its number (<U+202E>, ^[).
// tail is the column's own text after the name (a process ID in brackets), cut as if it were part of the name.
function cutAt(s, most, tail = '') {
  const items = [...namedEach(s), ...tail];
  return items.join('').length <= most ? items.join('') : `${cutEach(items, most - 1)}~`;
}

// ---------- small helpers ----------
const fmtN = (n) => Number(n).toLocaleString('en-US');
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const z2 = (n, w = 2) => String(n).padStart(w, '0');
const plural = (n, one, many = one + 's') => `${fmtN(n)} ${n === 1 ? one : many}`;
const lines = [];
const say = (s = '') => lines.push(s);
// A line printed as it stands in the bundle. It is remembered as the bundle's, so that nothing later takes it for one
// of this tool's own lines (a file can hold a line that reads "Next:").
const theirs = new Set();
const sayTheirs = (s = '') => { theirs.add(lines.length); lines.push(s); };
// The command was not understood: exit status 2. The message is written for a person at a shell. `why` holds the
// same refusal as data, so request mode can word it for a model, which is shown argument names and not options.
class Usage extends Error {
  constructor(message, why) { super(message); this.why = why || null; }
}

const RUNTIME = typeof Deno !== 'undefined' ? 'deno run -A' : 'node';
// A word that starts with "=" is quoted too: zsh, the shell a Mac starts with, reads =ls as the path of the ls command.
const shq = (s) => (/^[A-Za-z0-9_\/.:@%+,-][A-Za-z0-9_\/.:=@%+,-]*$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const SCRIPT = (() => {
  const p = process.argv[1] || 'excel_diagnostics_cli.mjs', rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith('..') && rel.length < p.length ? rel : p;
})();
let bundleArg = 'BUNDLE';
const run = (rest) => `${RUNTIME} ${shq(SCRIPT)} ${bundleArg === 'BUNDLE' ? bundleArg : shq(bundleArg)} ${rest}`.trim();
function closest(word, names) {                           // the name a mistyped word is nearest to, if it is near any
  word = String(word).toLowerCase();
  const pre = names.filter((n) => n.startsWith(word));
  if (word.length >= 2 && pre.length === 1) return pre[0];
  let best = null, bestD = 3;
  for (const name of names) {
    const row = Array.from({ length: name.length + 1 }, (_, i) => i);
    for (let i = 1; i <= word.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= name.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (word[i - 1] === name[j - 1] ? 0 : 1)); prev = keep; }
    }
    if (row[name.length] < bestD) { bestD = row[name.length]; best = name; }
  }
  return best;
}

// ---------- files on disk, read on demand like a browser File ----------
let lastFd = null;
function fdOf(p) {
  if (lastFd && lastFd.p === p) return lastFd.fd;
  if (lastFd) { const was = lastFd.fd; lastFd = null; fs.closeSync(was); }      // forgotten first: if the next file cannot be opened, this one must not be closed twice
  lastFd = { p, fd: fs.openSync(p, 'r') };
  return lastFd.fd;
}
class DiskBlob {
  constructor(p, start = 0, end = fs.statSync(p).size) { this.path = p; this.start = start; this.size = end - start; }
  slice(a = 0, b = this.size) {
    a = Math.max(0, Math.min(this.size, a)); b = Math.max(a, Math.min(this.size, b));
    return new DiskBlob(this.path, this.start + a, this.start + b);
  }
  async arrayBuffer() {
    const buf = new Uint8Array(this.size), fd = fdOf(this.path);
    for (let n = 0; n < buf.length;) { const r = fs.readSync(fd, buf, n, buf.length - n, this.start + n); if (!r) break; n += r; }
    return buf.buffer;
  }
  async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
  stream() {
    let pos = 0;
    return new ReadableStream({ pull: async (c) => {
      if (pos >= this.size) return c.close();
      const n = Math.min(1 << 20, this.size - pos);
      c.enqueue(new Uint8Array(await this.slice(pos, pos + n).arrayBuffer()));
      pos += n;
    } });
  }
}
// The files of a bundle folder. A link inside it is never followed: a bundle comes from someone else, and a link in
// it could point at any file on this machine, which would then be listed, searched and printed as if it were a log.
// Only plain files and folders are taken. linksLeftOut says how many links were passed over in the last walk.
let linksLeftOut = 0;
const readRoots = [];                                     // every folder the open bundle's files are read from; "export" writes into none of them
function walk(root, top, loose) {
  const inputs = [];
  linksLeftOut = 0;
  readRoots.push(root);
  const go = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.lstatSync(full); } catch (err) { continue; }
      if (st.isSymbolicLink()) { linksLeftOut++; continue; }
      if (st.isDirectory()) go(full, `${rel}${e.name}/`);
      else if (st.isFile() && e.name !== '.unpacked') inputs.push({ path: `${top}${rel}${e.name}`, blob: new DiskBlob(full, 0, st.size), loose });
    }
  };
  go(root, '');
  return inputs;
}
// A zip is unpacked once into the temporary folder and read from there on later runs: every command is a new
// process, and inflating a large bundle each time would make each one slow. The engine's own zip reader does it,
// because it also reads the over-4 GB archives that macOS ditto writes without zip64.
let cacheRoot = null;                                     // request mode unpacks where its caller says instead
const cacheDir = () => cacheRoot || path.join(os.tmpdir(), 'excel_diagnostics_cli');
// The folder a zip is unpacked into is named after the zip's size and date, so a zip that is replaced gets a new one.
const unpackedName = (zipPath, st) => `${path.basename(zipPath).replace(/\.zip$/i, '')}-${st.size}-${Math.floor(st.mtimeMs)}`;
// A few kilobytes of zip can unpack to any size. A bundle's text packs perhaps twenty to one, so past two hundred
// to one (and never under a gigabyte, never over the ceiling) this is not a bundle and unpacking stops. The budget
// is one for everything a run unpacks: a zip found inside the zip is unpacked out of what the first one left.
// made: the folders this run unpacked and moved into place. chain: those and the ones it found already unpacked by an
// earlier run, every folder the chain of zips is read from, so that a refusal further down can take them all away again.
function unpackBudget(zipPath, size) {
  const gb = Number(process.env.EXCEL_DIAG_UNPACK_LIMIT_GB);
  return { name: path.basename(zipPath), most: gb > 0 ? gb * 2 ** 30 : Math.min(64 * 2 ** 30, Math.max(2 ** 30, size * 200)), written: 0, files: 0, made: [], chain: [] };
}
async function unpack(zipPath, budget) {
  const st = fs.statSync(zipPath);
  const dir = path.join(cacheDir(), unpackedName(zipPath, st)), marker = path.join(dir, '.unpacked');
  if (fs.existsSync(marker)) { if (budget) budget.chain.push(dir); return dir; }
  budget = budget || unpackBudget(zipPath, st.size);
  toErr(`Unpacking ${named(path.basename(zipPath))} (${fmtBytes(st.size)}) into ${named(dir)} ...\n`);
  // Unpacked beside its final place and moved there whole, so that another process opening the same zip at the
  // same moment (a program may make two requests at once) never reads a half-written folder.
  const part = `${dir}.part-${process.pid}`;
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(part, { recursive: true, mode: 0o700 });
  const file = new DiskBlob(zipPath, 0, st.size);
  try {
    const inside = path.resolve(part) + path.sep;
    const tooMuch = () => new Usage(`${named(budget.name)} unpacks to more than ${fmtBytes(budget.most)} or more than 200,000 files and folders, which is far more than a bundle of its size holds, so it was not unpacked.\nIf it really is a bundle, set EXCEL_DIAG_UNPACK_LIMIT_GB to a larger number of gigabytes and run this again.`, { why: 'too-large', limit: fmtBytes(budget.most) });
    let members;
    try { members = await Core.readZip(file, 200001 - budget.files); } catch (err) { if (err && err.tooMany) throw tooMuch(); throw err; }
    for (const e of members) {
      if (++budget.files > 200000) throw tooMuch();

      const parts = e.path.split('/').filter(Boolean);
      if (!parts.length || parts.includes('..') || CLUTTER.test(e.path)) continue;
      // A name must stay a name inside the folder being unpacked into. Where a backslash separates folders
      // (Windows), a name that holds one, or a drive letter, could step outside; a NUL ends a name early anywhere.
      if (e.path.includes('\0') || (path.sep === '\\' && parts.some((p) => p.includes('\\') || /^[A-Za-z]:/.test(p)))) continue;
      const dest = path.join(part, ...parts);
      if (!path.resolve(dest).startsWith(inside)) continue;

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const fd = fs.openSync(dest, 'w');
      try {
        for await (const c of new Core.Entry(e.path, e.size, null, { file, e }).chunks(false)) {
          if ((budget.written += c.length) > budget.most) throw tooMuch();      // counted as it is written: the sizes a zip declares can lie
          for (let n = 0; n < c.length;) n += fs.writeSync(fd, c, n, c.length - n);
        }

      } finally { fs.closeSync(fd); }
    }
    fs.writeFileSync(path.join(part, '.unpacked'), `${path.resolve(zipPath)}\n`);
    try { fs.renameSync(part, dir); } catch (err) {
      if (fs.existsSync(marker)) throw err;                // the other process got there first, with the same files: handled below
      fs.rmSync(dir, { recursive: true, force: true });    // what is in the way was left half-done by an earlier run
      fs.renameSync(part, dir);
    }
    budget.made.push(dir);
  } catch (err) {
    if (!fs.existsSync(marker)) throw err;
  } finally { fs.rmSync(part, { recursive: true, force: true }); }
  budget.chain.push(dir);
  toErr('Unpacked.\n');                                    // that later commands reuse it is said once the whole chain is in
  return dir;
}
// The zip that is the whole of what was found: the one zip there, with nothing beside it but its checksum (and what
// macOS strews about). This is what the engine would take for the bundle and inflate itself, in memory.
const CLUTTER = /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$|\.localized$|Icon\r$)/;    // what macOS and the Finder leave; the engine sets aside the same
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
function loneZip(inputs) {
  const given = inputs.filter((f) => !CLUTTER.test(f.path)), zips = given.filter((f) => /\.zip$/i.test(f.path));
  if (zips.length !== 1) return null;
  const beside = `${baseOf(zips[0].path)}.sha256`.toLowerCase();
  return given.every((f) => f === zips[0] || baseOf(f.path).toLowerCase() === beside) ? zips[0] : null;
}

// ---------- the open bundle ----------
let ds = null, info = null, utc = false;
// loose: a zip found among the files of the folder or zip being opened is one of the bundle's files. Request mode
// asks for that, because the bundle it opens was chosen by name. Without it a zip that is all there is, alone or
// with its checksum, is taken to be the bundle, which is right when a person points this tool at the folder a
// zip and its checksum were delivered in.
async function open(arg, loose) {
  let inputs;
  readRoots.length = 0;
  if (arg === 'sample') inputs = Core.sampleBundle(1);
  else {
    let st, budget = null, depth = 0;
    try { st = fs.statSync(arg); } catch (err) {
      throw new Usage(`There is no file or folder at ${arg}.\nGive the path to an Excel_Diagnostics_....zip, to the unzipped folder, or to a log file. The word "sample" in its place opens built-in made-up data.`, { why: 'no-bundle' });
    }
    const unpacked = async (zipPath) => {
      depth++;
      budget = budget || unpackBudget(zipPath, fs.statSync(zipPath).size);
      return walk(await unpack(zipPath, budget), '', loose);
    };
    if (st.isDirectory()) {
      inputs = walk(arg, `${path.basename(path.resolve(arg))}/`, loose);
      if (linksLeftOut && !loose) toErr(`${linksLeftOut} link${linksLeftOut === 1 ? '' : 's'} in this folder ${linksLeftOut === 1 ? 'was' : 'were'} not followed: a bundle's files are only the ones inside it.\n`);
    }
    else if (/\.zip$/i.test(arg)) inputs = await unpacked(arg);

    else inputs = [{ path: path.basename(arg), blob: new DiskBlob(arg, 0, st.size) }];
    if (!loose) {
      // A zip that is all there is (a zip inside the zip, or a folder holding the zip and its checksum, which is
      // how the collector delivers one) is the bundle. It is unpacked here like the first, out of the same
      // budget, and never handed to the engine, which would inflate it in memory with nothing counting the bytes.
      // Four zips deep is the most; whatever zip is left after that is one of the bundle's files, listed and not opened.
      // A zip in the chain that is over the limit is refused in the name of the first, as not unpacked: so every
      // folder of the chain is taken away again, the ones this run unpacked and the ones an earlier run left (a
      // folder found unpacked is not counted against the limit), and the next run starts from nothing.
      try {
        for (let zip; depth < 4 && (zip = loneZip(inputs));) inputs = await unpacked(zip.blob.path);
      } catch (err) {
        if (budget && err instanceof Usage && err.why && err.why.why === 'too-large') for (const dir of budget.chain) fs.rmSync(dir, { recursive: true, force: true });
        throw err;
      }
      if (budget && budget.made.length && !cacheRoot) toErr(`Later commands on this ${st.isDirectory() ? 'folder' : 'zip'} reuse what was unpacked; "${RUNTIME} ${shq(SCRIPT)} clean" deletes it.\n`);
      const given = inputs.filter((f) => !CLUTTER.test(f.path));
      if (given.length > 1 && given.every((f) => /\.zip$/i.test(f.path))) throw new Error('Open one bundle at a time (several .zip files were given).');
      for (const f of inputs) if (/\.zip$/i.test(f.path)) f.loose = true;
    }
    if (!inputs.length) throw new Usage(`${arg} is an empty folder.`, { why: 'empty-bundle' });
  }
  ds = new Core.Dataset();
  const tty = process.stderr.isTTY;
  let last = '';
  info = await ds.load(inputs, (p) => {
    if (!tty) return;
    const s = `${p.phase}${p.total ? ` ${Math.round((p.done / p.total) * 100)}%` : ''}`;
    if (s !== last) { last = s; process.stderr.write(`\r${shown(s.padEnd(40))}`); }
  });
  if (tty && last) process.stderr.write(`\r${''.padEnd(40)}\r`);
}

// ---------- time ----------
function offsetAt(t) {                                    // minutes east of UTC that times are shown in
  if (utc || !info.zone.length) return 0;
  const z = info.zone;
  let lo = 0, hi = z.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (z[m][0] <= t) lo = m + 1; else hi = m; }
  return z[Math.max(0, lo - 1)][1];
}
const offName = (om) => (om === 0 ? 'UTC' : `UTC${om < 0 ? '-' : '+'}${z2((Math.abs(om) / 60) | 0)}:${z2(Math.abs(om) % 60)}`);
function fmtTime(t, ms = true) {
  if (t !== t) return '';
  const d = new Date(Math.floor(t) + offsetAt(t) * 60000);
  return `${d.getUTCFullYear()}-${z2(d.getUTCMonth() + 1)}-${z2(d.getUTCDate())} ${z2(d.getUTCHours())}:${z2(d.getUTCMinutes())}:${z2(d.getUTCSeconds())}${ms ? '.' + z2(d.getUTCMilliseconds(), 3) : ''}`;
}
const zoneOffsets = () => [...new Set(info.zone.map((z) => z[1]))].map(offName).join(' and ');
function zoneSaid() {
  if (utc) return 'UTC';
  if (!info.zone.length) return "UTC, because these logs do not record the Mac's time zone";
  return `the logged Mac's time zone, ${zoneOffsets()} (add --utc for UTC)`;
}
// A time as it is sent: YYYY-MM-DD, with a time of day after it or not, and Z, UTC or an offset after that or not;
// or a time of day alone, on a bundle whose entries are all on one day. Each part has to be one that can be, by the
// rules in Core.timeBad (src/core.js), which the page's From and To boxes also read times by: a month from 01 to 12,
// a day that month has, an hour from 00 to 23, a minute and a second from 00 to 59, and an offset from -12:00 to
// +14:00 with its minutes from 00 to 59. A part that is not is refused, with each such part said and an example made
// from what was sent with those parts brought into range (outOfRange): left to Date, 2026-13-45 would be read as
// 2027-02-14 and 10:99 as 11:39. So is a moment before TIME_FIRST or after TIME_LAST: any time between them is
// written with a year of four digits on any clock, so a time this tool prints from it reads back here.
// Request mode and the text commands both read times here.
const TIME_SENT = /^(\d{4})-(\d\d)-(\d\d)(?:([ T])(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?)?(\s*)(Z|UTC|[+-]\d\d:?\d\d)?$/i;
const TIME_OF_DAY = /^(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?$/;
const { TIME_FIRST, TIME_LAST } = Core;
// The parts of a time as TIME_SENT or TIME_OF_DAY took them (y, mo and d absent for a time of day) that cannot be, each
// said as a clause, and the parts with each of them brought into range (an offset that cannot be is left out)
function outOfRange(p) {
  const { bad, zoneBad } = Core.timeBad(p), dated = p.y !== undefined, inMonth = Math.min(12, Math.max(1, +p.mo || 1));
  const two = (v, most) => (v === undefined ? undefined : z2(Math.min(most, +v)));
  const fixed = { ...p, h: two(p.h, 23), mi: two(p.mi, 59), s: two(p.s, 59), ...(zoneBad ? { z: undefined, gap: '' } : {}) };
  if (dated) Object.assign(fixed, { mo: z2(inMonth), d: z2(Math.min(Core.daysIn(+p.y, inMonth), Math.max(1, +p.d))) });
  return { bad, fixed, zoneBad };
}
// Parts written as a time again, in the shape they were sent in. The white space sent before an offset is written as
// one space: it can be any (a line separator among it), and this is said back in a sentence.
const timeWritten = (p) => {
  const clock = p.h === undefined ? '' : `${p.h}:${p.mi}${p.s === undefined ? '' : `:${p.s}${p.frac === undefined ? '' : `.${p.frac}`}`}`;
  return p.y === undefined ? clock : `${p.y}-${p.mo}-${p.d}${clock ? `${p.sep}${clock}` : ''}${p.z === undefined ? '' : `${p.gap ? ' ' : ''}${p.z}`}`;
};
// The moment parts in range stand for (a time of day alone, on the day `day`, YYYY-MM-DD), as UTC ms
function momentOf(p, day) {
  const [y, mo, d] = p.y !== undefined ? [+p.y, +p.mo, +p.d] : day.slice(0, 10).split('-').map(Number);
  const at = new Date(0);
  at.setUTCFullYear(y, mo - 1, d);                        // setUTCFullYear, not Date.UTC: that reads the years 0 to 99 as 1900 to 1999
  at.setUTCHours(+p.h || 0, +p.mi || 0, +p.s || 0, +String(p.frac || '0').padEnd(3, '0').slice(0, 3));
  const naive = at.getTime();
  if (p.z) return naive - (/^(z|utc)$/i.test(p.z) ? 0 : Core.offStr(p.z)) * 60000;
  return naive - offsetAt(naive - offsetAt(naive) * 60000) * 60000;
}
// The window of half either side of the moment t, as [t0, t1), kept within the times this tool reads (TIME_FIRST to
// TIME_LAST), so that its ends, printed, read back here; cut says whether an end was moved to stay within them. A
// moment that is itself outside them (an entry's own time) has its window left as it is.
function windowAround(t, half) {
  const lo = t - half, hi = t + half + 1, inside = t >= TIME_FIRST && t <= TIME_LAST;
  const t0 = inside ? Math.max(lo, TIME_FIRST) : lo, t1 = inside ? Math.min(hi, TIME_LAST) : hi;
  return { t0, t1, cut: t0 > lo || t1 < hi };
}
// (at: how each end is written; request mode writes it with its offset where the bundle's clock has more than one)
const windowCutSaid = (t0, t1, at = (t) => fmtTime(t, false)) => `reaches past the times this tool reads, 1000-01-02 00:00:00 to 9999-12-30 23:59:59 UTC, so it was cut to ${at(t0)} to ${at(t1)}`;
const SPAN_ENDS = { early: ['it is before 1000-01-02 00:00:00 UTC, the earliest time this tool reads', '1000-01-02 00:00:00Z'], late: ['it is after 9999-12-30 23:59:59 UTC, the latest time this tool reads', '9999-12-30 23:59:59Z'] };
const spanEnd = (t) => (t < TIME_FIRST ? SPAN_ENDS.early : t > TIME_LAST ? SPAN_ENDS.late : null);
function parseTime(str, option) {
  const s = String(str).trim(), m = TIME_SENT.exec(s), tm = m ? null : TIME_OF_DAY.exec(s);
  const first = fmtTime(info.t0, false), last = fmtTime(info.t1, false), oneDay = first.slice(0, 10) === last.slice(0, 10);
  const parts = m ? { y: m[1], mo: m[2], d: m[3], sep: m[4], h: m[5], mi: m[6], s: m[7], frac: m[8], gap: m[9], z: m[10] } : tm ? { h: tm[1], mi: tm[2], s: tm[3], frac: tm[4] } : null;
  if (!parts) {
    const like = info.total ? first : '2026-03-10 09:15:00', zone = zoneSaid().replace(/ \(add.*/, '');
    throw new Usage(`${option} "${s}" is not a time this tool can read. Write it like "${like}" (YYYY-MM-DD HH:MM:SS; seconds are optional, and so is the time of day). It is read in ${zone}, unless it ends in Z or an offset such as -05:00.`, { why: 'time', option, value: s, like, zone });
  }
  // a time of day alone, on a bundle of more than one day, is given the bundle's last day, as the refusal below does
  const dayless = !!tm && !oneDay && !!info.total, range = outOfRange(parts);
  let t = range.bad.length || (tm && !oneDay) ? NaN : momentOf(parts, first);
  const end = range.bad.length ? spanEnd(momentOf(range.fixed, dayless ? last : first)) : spanEnd(t);
  if (range.bad.length || end) {
    // the example is what was sent with its parts in range, unless that moment is outside the span this tool reads:
    // then it is the end of that span nearest it
    const like = end ? end[1] : `${dayless ? `${last.slice(0, 10)} ` : ''}${timeWritten(range.fixed)}`, bad = [...range.bad, ...(end ? [end[0]] : [])];
    const zone = range.zoneBad && !end ? zoneSaid().replace(/ \(add.*/, '') : '', lead = range.bad.length ? `has ${range.bad.length > 1 ? 'parts' : 'a part'} out of range` : 'is outside the times this tool reads';
    throw new Usage(`${option} "${named(s)}" ${lead}: ${bad.join('; ')}. Write it like "${like}".`, { why: 'time-range', option, value: s, like, bad, lead, zone, dayless: dayless && !end });
  }
  if (tm && !oneDay) throw new Usage(`${option} ${s} has no date, and this bundle covers more than one day (${first} to ${last}). Write it like "${last}".`, { why: 'time-no-date', option, value: s, from: info.t0, to: info.t1 });
  return t;
}
// A length of time is at most SPAN_DAYS days: a time that far either side of any logged moment is still a date,
// where one past the range of dates would be written as no time at all
const SPAN_DAYS = 36500;
function parseSpan(str, option) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|d)?$/i.exec(String(str).trim());
  if (!m) throw new Usage(`${option} "${str}" is not a length of time. Write a number and a unit: 500ms, 30s, 5m, 2h or 1d.`, { why: 'span', option, value: String(str) });
  const ms = +m[1] * { ms: 1, s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000 }[(m[2] || 's').toLowerCase()];
  if (!(ms <= SPAN_DAYS * 86400000)) throw new Usage(`${option} "${str}" is longer than ${fmtN(SPAN_DAYS)} days, the longest this tool takes. Write a shorter one: 500ms, 30s, 5m, 2h or 1d.`, { why: 'span-long', option, value: String(str) });
  return ms;
}
const fmtSpan = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 120e3 ? `${+(ms / 1000).toFixed(1)} s` : ms < 7200e3 ? `${+(ms / 60e3).toFixed(1)} min` : ms < 172800e3 ? `${+(ms / 3600e3).toFixed(1)} h` : `${+(ms / 86400e3).toFixed(1)} days`);
function wholeNumber(v, option, min, max) {
  if (!/^\d+$/.test(String(v)) || +v < min || +v > max) throw new Usage(`${option} needs a whole number from ${fmtN(min)} to ${fmtN(max)}, not "${v}".`);
  return +v;
}

// ---------- options ----------
const QUERY = ['from', 'to', 'around', 'window', 'min-severity', 'case', 'utc'];
const OPTIONS = {
  summary: ['utc'], search: [...QUERY, 'limit', 'offset', 'last', 'wide'], count: [...QUERY, 'by', 'limit'], histogram: [...QUERY, 'bins'],
  show: ['utc'], context: ['before', 'after', 'window', 'wide', 'utc'], reports: ['utc'], files: ['limit', 'all'], cat: ['lines', 'grep', 'all'],
  memory: ['utc'], export: [...QUERY, 'out'], clean: [], help: [],
};
const FLAGS = new Set(['case', 'utc', 'last', 'wide', 'all']);
const EXAMPLE = { from: '--from "2026-03-10 09:00"', to: '--to "2026-03-10 09:30"', around: '--around "2026-03-10 09:15:20" or --around 1234', window: '--window 2m',
  'min-severity': '--min-severity error', limit: '--limit 100', offset: '--offset 40', by: '--by process', bins: '--bins 30', before: '--before 20', after: '--after 20',
  lines: '--lines 200-400', grep: '--grep jetsam', out: '--out matches.tsv' };
function parseArgs(command, args) {
  const o = {}, pos = [];
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!raw && a === '--') { raw = true; continue; }
    if (raw || !a.startsWith('--')) { pos.push(a); continue; }       // one dash is a search exclusion (-kernel), not an option
    const eq = a.indexOf('='), name = a.slice(2, eq < 0 ? undefined : eq);
    if (!OPTIONS[command].includes(name)) {
      const guess = closest(name, OPTIONS[command]);
      throw new Usage(`"${command}" has no option --${name}.${guess ? ` Did you mean --${guess}?` : ''} Its options are: ${OPTIONS[command].map((x) => `--${x}`).join(', ') || 'none'}.`);
    }
    if (FLAGS.has(name)) { o[name] = true; continue; }
    let v = eq >= 0 ? a.slice(eq + 1) : args[++i];
    if (v === undefined || v === '') throw new Usage(`--${name} needs a value after it, for example ${EXAMPLE[name]}.`);
    // a date and a time typed without quotation marks arrive as two arguments
    if (['from', 'to', 'around'].includes(name) && /^\d{4}-\d\d-\d\d$/.test(v) && /^\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(args[i + 1] || '')) v += ` ${args[++i]}`;
    o[name] = v;
  }
  return { o, pos };
}
// Several words handed over as one argument were quoted in the shell, so they are a phrase - unless the argument is
// plainly a whole search (it has its own quotation marks, a field such as process:excel, a /regex/ or an -exclusion).
const termsOf = (pos) => pos.map((a) => (/\s/.test(a.trim()) && !/"|^-?\/|(^|\s)-?[a-z]+:\S|\s-\S/i.test(a) ? `"${a.trim()}"` : a.trim())).filter(Boolean).join(' ');

// pos is the words as a shell handed them over, or (from request mode) the whole search as one string.
async function buildQuery(o, pos) {
  const q = { text: typeof pos === 'string' ? pos : termsOf(pos), cs: !!o.case, facets: {}, t0: null, t1: null, bins: 1 }, said = { text: q.text, window: '', sev: '' };
  if (o.around !== undefined && (o.from !== undefined || o.to !== undefined)) throw new Usage('Use either --around (with --window) or --from and --to, not both.', { why: 'around-with-span' });
  if (o.window !== undefined && o.around === undefined) throw new Usage(`--window only goes with --around, for example ${EXAMPLE.around} --window 2m. For a fixed span use --from and --to.`, { why: 'window-alone' });
  if (o.from !== undefined) q.t0 = parseTime(o.from, '--from');
  if (o.to !== undefined) q.t1 = parseTime(o.to, '--to');
  if (q.t0 != null && q.t1 != null && q.t1 <= q.t0) throw new Usage(`--from (${fmtTime(q.t0)}) has to be earlier than --to (${fmtTime(q.t1)}).`, { why: 'from-after-to', from: q.t0, to: q.t1 });
  if (o.around !== undefined) {
    const half = parseSpan(o.window === undefined ? '60s' : o.window, '--window'), c = await anchorTime(o.around, '--around'), w = windowAround(c, half);
    q.t0 = w.t0; q.t1 = w.t1; said.cut = w.cut;
    said.window = `${fmtSpan(half)} either side of ${fmtTime(c)}${w.cut ? `; it ${windowCutSaid(w.t0, w.t1)}` : ''}`;
  } else if (q.t0 != null || q.t1 != null) {
    said.window = `${q.t0 != null ? `from ${fmtTime(q.t0)}` : 'from the start'} ${q.t1 != null ? `to ${fmtTime(q.t1)}` : 'to the end'}`;
  }
  if (o['min-severity'] !== undefined) {
    const n = SEV.findIndex((s) => s.toLowerCase() === String(o['min-severity']).toLowerCase());
    if (n < 0) throw new Usage(`--min-severity "${o['min-severity']}" is not a severity. Use one of: ${SEV.map((s) => s.toLowerCase()).join(', ')} (lowest to highest).`, { why: 'severity', value: String(o['min-severity']) });
    const ids = info.lvlSev.reduce((a, sv, v) => (sv >= n ? a.concat(v) : a), []);
    q.facets.lvl = { inc: ids.length ? ids : [0xFFFF], exc: [] };  // no such level in the bundle: an id nothing has, so nothing matches
    q.levelOk = new Set(ids);
    said.sev = n === SEV.length - 1 ? 'Fault only' : `${SEV[n]} and above`;
  }
  return { q, said };
}
async function anchorTime(v, option) {                    // an entry ID or a time -> UTC ms
  if (/^\d+$/.test(String(v).trim())) {
    const id = +v;
    if (id >= info.total) throw new Usage(`${option} ${v}: there is no entry ${v}. IDs in this bundle run from 0 to ${fmtN(info.total - 1)}; "search" prints them in the first column.`, { why: 'no-entry', option, value: String(v) });
    return (await ds.readRows([id], 64))[0].row[1];
  }
  return parseTime(v, option);
}
const heading = (said) => [said.text ? `Search: ${said.text}` : 'Search: every entry', said.window && `Time window: ${said.window}`, said.sev && `Severity: ${said.sev}`].filter(Boolean).join('\n');
const optionsSaid = (o, drop = []) => Object.entries(o).filter(([k]) => !drop.includes(k)).map(([k, v]) => (v === true ? `--${k}` : `--${k} ${shq(String(v))}`)).join(' ');
const again = (command, o, pos, drop, extra) => run([command, ...pos.map(shq), optionsSaid(o, drop), extra].filter(Boolean).join(' '));

// ---------- printing entries ----------
const flat = (s) => String(s).replace(BREAKS, '\\n').replace(/\t/g, ' ');
// One entry is one line. The level, the source and the process are names from the bundle: each is said on one line
// and cut to a width (LEVEL 24, SOURCE 34, PROCESS[PID] 34, ending in ~ when cut), because every line of the table
// is padded to the widest of them and one long name would make every line that long.
const LEVEL_WIDE = 24, SOURCE_WIDE = 34, PROCESS_WIDE = 34;
function printRows(rows, { wide, mark } = {}) {
  if (!rows.length) return;
  const N = info.names, idW = Math.max(2, String(rows.reduce((a, r) => Math.max(a, r[0]), 0)).length + (mark === undefined ? 0 : 1));
  const cells = rows.map((r) => {
    let msg = flat(r[9]);
    if (!wide && msg.length > 220) msg = `${msg.slice(0, 220)}... [+${fmtN(msg.length - 220)} characters; --wide or "show ${r[0]}" has the rest]`;
    else if (r[10]) msg += ` ... [cut at 2,048 bytes; "show ${r[0]}" has the rest]`;
    return [(r[0] === mark ? '>' : '') + r[0], fmtTime(r[1]), cutAt(N.lvl[r[3]] || SEV[info.lvlSev[r[3]]], LEVEL_WIDE), cutAt(info.sources[r[2]].short, SOURCE_WIDE),
      cutAt(N.proc[r[4]] || '-', PROCESS_WIDE, r[5] ? `[${r[5]}]` : ''), msg];
  });
  const w = [idW, 23, ...[2, 3, 4].map((k) => cells.reduce((a, c) => Math.max(a, c[k].length), k === 2 ? 5 : 6))];
  say(['ID'.padStart(w[0]), 'TIME'.padEnd(w[1]), 'LEVEL'.padEnd(w[2]), 'SOURCE'.padEnd(w[3]), 'PROCESS[PID]'.padEnd(w[4]), 'MESSAGE'].join('  '));
  for (const c of cells) say([c[0].padStart(w[0]), c[1].padEnd(w[1]), c[2].padEnd(w[2]), c[3].padEnd(w[3]), c[4].padEnd(w[4]), c[5]].join('  '));
}
const notesFor = (r, nothing) => (r.notes || []).filter((n) => !n.soft || nothing);     // a soft note is only worth saying when nothing matched
const countable = (n) => n.field && n.field !== 'level' && n.field !== 'source';        // the note names a field whose values "count" can list
function sayNotes(r, nothing) {
  // such a note can list names from the bundle (its tags, its levels, the names close to the one typed): one line, whatever they hold
  for (const n of notesFor(r, nothing)) say(`Note: ${named(n.text)}${countable(n) ? ` To list every ${n.field}: ${run(`count --by ${n.field}`)}` : ''}`);
}
// Nothing matched: count again with each condition taken away in turn, so the reader can see which one is responsible.
// Each answer says which condition went (window, sev, cs or term, with the search text that was left) and the count.
async function countWithout(q, r, said) {
  const toks = (r.tokens || []).slice(0, 8), tries = [];
  if (q.t0 != null || q.t1 != null) tries.push([{ window: said.window }, { ...q, t0: null, t1: null }]);
  if (said.sev) tries.push([{ sev: said.sev }, { ...q, facets: {} }]);
  if (q.cs && q.text) tries.push([{ cs: true }, { ...q, cs: false }]);
  if (toks.length > 1 || (toks.length === 1 && tries.length)) toks.forEach((tk, i) => tries.push([{ term: tk }, { ...q, text: toks.filter((_, j) => j !== i).join(' ') }]));
  const out = [];
  for (const [what, qq] of tries) out.push({ ...what, text: qq.text, count: (await ds.query({ ...qq, dry: true, bins: 1 }, () => {})).count });
  return out;
}
const onlyTerm = (r) => ((r.tokens || []).length && !(r.notes || []).some((n) => !n.soft) ? r.tokens[0] : null);   // a lone term that matched nothing and that no note explains
async function sayWhyNothing(q, r, said, o) {
  const tries = await countWithout(q, r, said);
  if (!tries.length) {
    if (onlyTerm(r)) say(`No entry in this bundle matches ${onlyTerm(r)}. A word is looked for anywhere in an entry, ignoring capitals unless --case is given.`);
    return;
  }
  say('How many entries match when one condition is taken away and the rest are kept:');
  for (const t of tries) say(`  without ${t.window !== undefined ? `the time window (${t.window})` : t.sev ? `--min-severity ${o['min-severity']}` : t.cs ? '--case (so that capitals are ignored)' : `the search term ${t.term}`}: ${fmtN(t.count)}`);
  if (!tries.some((t) => t.count > 0)) say('Taking away any single condition still leaves nothing, so more than one of them is ruling entries out. Start again from fewer conditions.');
}

// ---------- what the commands work out, apart from how they say it (request mode says the same things as data) ----------
const collectorMode = (name) => (/^Excel_Diagnostics_(collect|hang|repro|watch)_/.exec(name) || [])[1];
function saySources(indent, num) {                        // one line per log source on the timeline; returns how many it left out
  const src = info.sources.filter((s) => s.rows), short = (s) => cutAt(s.short, SOURCE_WIDE), w = src.reduce((a, s) => Math.max(a, short(s).length), 6);
  say(`${indent}${'ENTRIES'.padStart(9)}  ${'SOURCE'.padEnd(w)}  ${'FIRST'.padEnd(19)}  ${'LAST'.padEnd(19)}  FILE`);
  for (const s of src.slice(0, 40)) say(`${indent}${num(s.rows).padStart(9)}  ${short(s).padEnd(w)}  ${fmtTime(s.t0, false)}  ${fmtTime(s.t1, false)}  ${named(s.path)}`);
  return Math.max(0, src.length - 40);
}
function reportKinds() {                                  // kind -> how many reports of it
  const kinds = new Map();
  for (const x of info.reports) kinds.set(x.kind, (kinds.get(x.kind) || 0) + 1);
  return kinds;
}
// A report about Excel itself: one whose process is Microsoft Excel and whose kind is a crash, hang or spin. The
// collector's own capture of Excel in hang mode (excel_spindump.txt or excel_sample.txt, captureAt in the engine) is
// not one: the collector took it, and the Mac wrote nothing when something happened.
const excelReport = (x) => x.proc === 'Microsoft Excel' && ['Crash', 'Hang', 'Spin'].includes(x.kind) && !ds.captureAt(x.path);
// What is said once above case/incident_context.md, by which collector wrote it: the engine's sentences
// (Core.contextRead, which the page asks too, so the two never say it differently). caseRead gives them and the kind
// the summary names: an older collector's file is one whose Case line, or the text under one of whose headings, is
// that collector's.
const CASE_FILE = 'case/incident_context.md';
function caseRead(text) {
  const { kind, said } = Core.contextRead(text);
  return { kind, said: said.join(' ') };
}
const caseSaid = (text) => caseRead(text).said;
// One line per report. With ids, each line starts with the id of the report's own entry on the timeline (request
// mode, where that id is what show and context take), as a listing of entries does. A character in a name that would
// act or turn the line round is written by its number here as well as at the terminal (shown), so that request mode,
// whose lines reach a model without passing a terminal, says it the same way.
// The PROCESS column is cut at 30 characters as written, at a whole character, and a name cut ends in ~ (cutAt), as
// in every other listing: a character written by its number (<U+202E>, ^[) is kept whole or left out whole, never cut
// through (namedEach gives each as one item).
const namedEach = (s) => roomlessEach(String(s).replace(BREAKS, '\n')).map((c) => (c === '\n' ? '\\n' : c === '\t' ? '\\t' : shown(c)));
function cutEach(items, most) {
  let out = '';
  for (const c of items) { if (out.length + c.length > most) break; out += c; }
  return out;
}
function sayReports(list, ids) {
  const kind = (x) => shown(named(x.kind)), proc = (x) => namedEach(x.proc || '-'), id = (x) => (x.pos === undefined ? '-' : String(x.pos));
  const kw = list.reduce((a, x) => Math.max(a, kind(x).length), 4), pw = Math.min(30, list.reduce((a, x) => Math.max(a, proc(x).join('').length), 7));
  const iw = ids ? list.reduce((a, x) => Math.max(a, id(x).length), 2) : 0, lead = (s) => (ids ? `${s.padStart(iw)}  ` : '');
  say(`${lead('ID')}${'TIME'.padEnd(19)}  ${'KIND'.padEnd(kw)}  ${'PROCESS'.padEnd(pw)}  FILE`);
  for (const x of list) say(`${lead(id(x))}${fmtTime(x.t, false)}  ${kind(x).padEnd(kw)}  ${cutAt(x.proc || '-', pw).padEnd(pw)}  ${shown(named(x.path))}`);
}

// What entries can be counted by, as the engine names each, and the search field that picks one of its values out.
const BY = { severity: 'sev', level: 'lvl', source: 'group', tag: 'tag', process: 'proc', subsystem: 'sub', category: 'cat', file: 'file' };
const BY_FIELD = { severity: 'level', level: 'level', source: 'source', tag: 'tag', process: 'process', subsystem: 'subsystem', category: 'category', file: 'source' };
// A name as a search term. One with a space, a quotation mark or a backslash goes in quotation marks with those two
// escaped: without that, a name could close the quotation and add terms of its own (a slow pattern, for one). One
// that starts with a slash goes in them too, so that it is not read as a regular expression. Every command that
// suggests a search for a name from the bundle builds the term here.
const termFor = (by, name) => `${BY_FIELD[by]}:${/[\s"\\]|^\//.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : name}`;
// What such a term finds, by the engine's own rule: every name that contains the value, capitals ignored (a level:
// every level whose name or severity starts with it; a source: every log whose path or source name contains it).
// A search for one name also finds every other name that holds it, so a sentence about the search says so.
const MATCHES = { tag: 'with a tag that contains', process: 'whose process name contains', subsystem: 'whose subsystem contains', category: 'whose category contains',
  level: 'whose level or severity starts with', source: 'from every log whose path or source name contains' };
function largest(r, q, field, n) {                        // the n values of a field with the most matches: [[value id, entries]], and how many values there are
  const f = r.facets[BY[field]];
  // The engine gives the page every file of a bundle of 80 or fewer in the files' own order, and no more than 60 of
  // them: past 60, the ones it gives are the first, not the ones with the most matches. Those are counted here, from
  // the matches themselves (ds.view, which the query that gave r left).
  if (BY[field] === 'file' && f.all > f.values.length) {
    const per = new Map(), F = ds.g.F, v = ds.view;
    for (let k = 0; k < v.length; k++) per.set(F[v[k]], (per.get(F[v[k]]) || 0) + 1);
    return { vals: [...per].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, n), all: per.size };
  }
  const vals = f.values.filter(([v, c]) => c > 0 && (BY[field] !== 'lvl' || !q.levelOk || q.levelOk.has(v)));
  return { vals: vals.slice().sort((a, b) => b[1] - a[1]).slice(0, n), all: vals.length < f.values.length ? vals.length : f.all };
}

// The stretch of the timeline around an entry or a moment: entries a up to (not including) b, and the one to mark.
// With a window that is everything inside it, however many; the caller decides how much of it to show.
// A moment that is a report's own time is about that report, so its entry is the one marked (report), not the first
// of whatever else was logged in that second: it is the last of them, as the reports are the last source merged.
// Reports print their times to the second, so a time sent without a fraction is a report's when the report is in
// that second. Of two reports at one time, one about Excel itself is taken first.
async function stretch(anchor, isId, before, after, window) {
  let id, t, report = null;
  if (isId) { id = +anchor; t = await anchorTime(anchor, 'context'); }
  else {
    t = parseTime(anchor, 'context');
    await ds.query({ bins: 1 }, () => {});
    report = info.reports.filter((x) => x.pos !== undefined && (x.t === t || (t % 1000 === 0 && x.t > t && x.t < t + 1000)))
      .sort((x, y) => excelReport(y) - excelReport(x) || x.pos - y.pos)[0] || null;
    id = report ? report.pos : ds.seek(t);
  }
  if (window === undefined) return { id, t, report, a: Math.max(0, id - before), b: Math.min(info.total, id + after + 1) };
  const half = parseSpan(window, '--window'), w = windowAround(t, half), r = await ds.query({ t0: w.t0, t1: w.t1, bins: 1 }, () => {});
  const a = r.count ? ds.view[0] : 0, b = a + r.count;      // with no filter the matches are one unbroken run of the timeline
  return { id: r.count ? Math.min(Math.max(id, a), b - 1) : id, t, report, half, a, b, t0: w.t0, t1: w.t1, cut: w.cut };
}

const onTimeline = (x) => (x.src >= 0 && x.rows ? x.rows : 0);      // how many timeline entries a bundle file gives
// The files a typed path can mean: the path as "files" prints it, else the one file of that name, else every path
// containing it. One is the file; none or several are for the caller to explain.
function findFiles(typed) {
  const want = typed.replace(/^\.?\//, ''), exact = info.files.find((x) => x.path === want);
  if (exact) return [exact];
  const named = info.files.filter((x) => x.path.slice(x.path.lastIndexOf('/') + 1) === want);
  return named.length === 1 ? named : info.files.filter((x) => x.path.toLowerCase().includes(want.toLowerCase()));
}
const READ_CAP = 32 << 20;                                // no more of a file than this is read
const ODL = /\.(odl|odlgz|odlsent|aodl)$/i;
const ODL_SAID = "This is a OneDrive sync log in Microsoft's obfuscated binary format. It cannot be printed as text or searched.";
async function fileLines(f) {                             // a bundle file as lines of text; binary when it has a zero byte near the start
  const got = await ds.fileChunk(f.i, 0, READ_CAP), bytes = new Uint8Array(got.bytes), out = { size: got.size, empty: !bytes.length, cut: got.size > READ_CAP };
  if (out.empty) return out;
  if (bytes.subarray(0, 4096).includes(0)) return { ...out, binary: true };
  const all = new TextDecoder().decode(bytes).split(/\r?\n/);
  if (all[all.length - 1] === '') all.pop();
  return { ...out, all };
}

// The bundle's memory files by what they are, and the columns of the memory timeline that figures are given for.
const MEMORY_FILES = [
  ['timeline', 'Samples over time, one row per sample (watch and repro modes)', /(^|\/)excel_memory_timeline\.csv$/],
  ['snapshot', 'Snapshots of system memory and the processes using the most', /(^|\/)(memory|system_memory|memory_snapshots)\.txt$/],
  ['excelMemory', "Excel's memory at collection time, and its breakdown by kind", /(^|\/)(excel_memory|excel_footprint)\.txt$/],
  ['jetsamReport', 'JetsamEvent reports, which macOS writes when it ends processes to free memory', /(^|\/)JetsamEvent[^/]*\.ips$/i],
];
// In a collector's bundle the memory files are the ones at the places the collector writes them, and a JetsamEvent
// report is one only where the collector copies the system's report folder. A file of the same name in a folder
// that was copied from the Mac is not one of them: such a folder can hold anything. (The page has the same rule.)
const OWN_MEMORY = /^(?:system\/memory\.txt|(?:repro\/[^/]+\/)?(?:system_memory|excel_memory|excel_footprint)\.txt|office\/(?:excel_memory|excel_footprint)\.txt|memory_snapshots\.txt|excel_memory_timeline\.csv|reports\/Library_Logs_DiagnosticReports(?:_Retired)?\/JetsamEvent[^/]*\.ips)$/;
const memoryFiles = () => MEMORY_FILES.map(([kind, title, rx]) => ({ kind, title, files: info.files.filter((f) => f.size && rx.test(f.path) && (!ds.collector || OWN_MEMORY.test(f.path))) })).filter((g) => g.files.length);
const MEMORY_COLUMNS = [['excel_footprint_mb', ' MB'], ['excel_cpu_pct', '%'], ['excel_threads', ''], ['free_mb', ' MB'], ['swap_used_mb', ' MB']];
const PRESSURE = { 1: 'normal', 2: 'warning', 4: 'critical' };
// A cell written as a decimal number is that number; any other (0x10, 1e999, Infinity, 12abc, words) is not one
const DECIMAL = /^-?\d{1,15}(\.\d{1,15})?$/;
const decimal = (v) => { const t = String(v ?? '').trim(); return DECIMAL.test(t) ? +t : NaN; };
// For each of those columns: the sample (a row of the file) with its lowest value, the one with its highest, and
// the last value, of the cells that are decimal numbers. Also the pressure levels and the Excel process IDs seen (null
// when the file has no such column). No more than TIMELINE_BYTES of the file is read: a longer one ends inside a row
// where it was cut, and that part of a row is not a sample, so it is left out, and `cut` says the file was longer.
const TIMELINE_BYTES = 16 << 20;
async function memoryTimeline(csv) {
  const got = await ds.fileChunk(csv.i, 0, TIMELINE_BYTES), cut = got.size > TIMELINE_BYTES, text = new TextDecoder().decode(got.bytes);
  const rows = (cut ? text.slice(0, text.lastIndexOf('\n') + 1) : text).split(/\r?\n/).filter(Boolean), head = (rows[0] || '').split(',');
  const col = (name) => head.indexOf(name), data = rows.slice(1).map((l) => l.split(',')), stats = [];
  for (const [name, unit] of MEMORY_COLUMNS) {
    const k = col(name), vals = data.map((d) => [decimal(d[k]), d]).filter((v) => v[0] === v[0]);
    if (k < 0 || !vals.length) continue;
    stats.push({ name, unit, lo: vals.reduce((a, v) => (v[0] < a[0] ? v : a)), hi: vals.reduce((a, v) => (v[0] > a[0] ? v : a)), last: vals[vals.length - 1][0] });
  }
  const lv = col('pressure_level'), pid = col('excel_pid');
  return { data, col, stats, cut, levels: lv < 0 ? [] : [...new Set(data.map((d) => d[lv]).filter(Boolean))], pids: pid < 0 ? null : [...new Set(data.map((d) => d[pid]).filter(Boolean))] };
}

// ---------- where "export" writes ----------
// The one file this tool writes for a person is the one "export" is given. A bundle comes from someone else, and so
// does everything in its folder: a name there can be a link to any file on this machine (unzipping restores links),
// and writing to it would replace that file with rows of the bundle's choosing. So nothing is written inside a
// folder the bundle is being read from, by the path as it was typed or by where its folder really is (a link to a
// folder, or /tmp for /private/tmp, makes the two differ); the file is opened without following a link, wherever
// it is; and the path said afterwards is the one that was written.
// Which folder a path is in is decided by what each folder is, not by how its path is spelt: on macOS one folder
// answers to more than one spelling (capitals are not told apart, nor the ways an accented letter can be written),
// so two spellings are compared by device and inode. Each folder on the path as typed is compared, and each folder
// above where the file's folder really is, with each folder the bundle is read from.
const realOf = (p) => { try { return fs.realpathSync(p); } catch (err) { return path.resolve(p); } };
const upFrom = (p) => { const out = [p]; for (let d = p; path.dirname(d) !== d;) out.push(d = path.dirname(d)); return out; };
function inBundle(p) {                                    // the folder the bundle is read from that the path p is in, if any
  const roots = [];
  for (const root of readRoots) { try { roots.push([root, fs.statSync(root)]); } catch (err) { /* not there: nothing is written into it */ } }
  let real = null;
  try { real = fs.realpathSync(path.dirname(p)); } catch (err) { /* no such folder: nothing is written there */ }
  for (const d of [...upFrom(p), ...(real ? upFrom(real) : [])]) {
    let st;
    try { st = fs.statSync(d); } catch (err) { continue; }
    const hit = roots.find(([, r]) => r.dev === st.dev && r.ino === st.ino);
    if (hit) return hit[0];
  }
  return undefined;
}
function writeOut(out, bytes) {
  const typed = path.resolve(out), root = inBundle(typed);
  if (root !== undefined) throw new Usage(`"export" does not write into the bundle folder, and --out ${out} is inside it (${named(path.resolve(root))}). Give --out a path outside that folder.`);
  const link = () => new Usage(`--out ${out} is a link, and "export" does not write through a link. Give --out another file name.`);
  let st = null, fd;
  try { st = fs.lstatSync(typed); } catch (err) { /* not there yet */ }
  if (st && st.isSymbolicLink()) throw link();
  try { fd = fs.openSync(typed, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o666); } catch (err) {
    if (err && (err.code === 'ELOOP' || err.code === 'EMLINK')) throw link();      // it became a link since it was looked at
    throw err;
  }
  try { for (let n = 0; n < bytes.length;) n += fs.writeSync(fd, bytes, n, bytes.length - n); } finally { fs.closeSync(fd); }
  return realOf(typed);
}
// The file name a suggested "export" gives. From a working folder inside the bundle folder that is a path to the
// folder above the bundle, because a bare name would be refused.
function outName() {
  const root = inBundle(path.resolve('matches.tsv'));
  return root === undefined ? 'matches.tsv' : path.relative(realOf('.'), path.join(path.dirname(realOf(root)), 'matches.tsv'));
}

// ---------- commands ----------
const COMMANDS = {
  async summary(o) {
    const r = await ds.query({ bins: 1 }, () => {}), mode = collectorMode(info.name);
    const has = (p) => info.files.some((f) => f.path === p && f.size);
    say(`Bundle: ${named(info.name)}${mode ? ` (the collector ran in ${mode} mode)` : ''}`);
    say(`Files: ${fmtN(info.files.length)}, ${fmtBytes(info.files.reduce((a, f) => a + f.size, 0))} in all`);
    if (!info.total) {
      say('Entries on the timeline: none. No file here is a log with timestamps this tool recognises.');
      say(); say('Next:'); say(`  List the files:   ${run('files')}`); say(`  Print one:        ${run('cat PATH')}`);
      return;
    }
    say(`Entries on the timeline: ${fmtN(info.total)}, from ${fmtTime(info.t0, false)} to ${fmtTime(info.t1, false)} (${fmtSpan(info.t1 - info.t0)})`);
    say(`Times are shown in ${zoneSaid()}.`);
    if (info.focus) say(`The macOS and Excel logs cover ${fmtTime(info.focus[0], false)} to ${fmtTime(info.focus[1], false)}; entries outside that come from other sources, such as install history, sleep and wake records and reports.`);
    const top = (name, n) => r.facets[name].values.filter(([, c]) => c > 0).slice(0, n).map(([v, c]) => `${named(info.names[name][v] || '(none)')} ${fmtN(c)}`).join(', ');
    say(); say(`By severity: ${top('sev', 6) || 'none'}`);
    if (r.facets.tag.values.some(([, c]) => c > 0)) say(`By tag: ${top('tag', 16)}`);
    say(`Busiest processes: ${top('proc', 8)}${r.facets.proc.all > 8 ? `, and ${fmtN(r.facets.proc.all - 8)} more` : ''}`);
    say(); say('Log sources on the timeline:');
    const more = saySources('  ', fmtN);
    if (more) say(`  ... and ${fmtN(more)} more; "${run('count --by file')}" lists the largest.`);
    say(); say(`Crash, hang and other diagnostic reports: ${info.reports.length ? [...reportKinds()].map(([k, n]) => `${fmtN(n)} ${k}`).join(', ') : 'none in this bundle'}`);
    for (const n of info.notes) { say(); say(`Note: ${n}`); }
    const errors = r.facets.sev.values.reduce((a, [v, c]) => a + (v >= 4 ? c : 0), 0);
    say(); say('Next:');
    if (errors) say(`  The ${fmtN(errors)} errors and faults:        ${run('search --min-severity error')}`);
    if (info.reports.length) say(`  The reports, with their times:      ${run('reports')}`);
    say(`  When entries were logged:           ${run('histogram')}`);
    // tag:excel finds every tag that holds "excel" (excel-helper and mentions-excel too), so that is what is said
    say(`  Entries ${MATCHES.tag} excel:   ${run('search tag:excel')}`);
    say(`  Search for words:                   ${run('search WORDS')}`);
    if (has('summary.md')) say(`  The collector's own summary:        ${run('cat summary.md')}`);
    say(`  Every command, with worked examples:   ${run('help')}`);
  },

  async search(o, pos) {
    const { q, said } = await buildQuery(o, pos);
    const limit = o.limit === undefined ? 40 : wholeNumber(o.limit, '--limit', 1, 5000);
    const r = await ds.query(q, () => {});
    say(heading(said));
    if (!r.count) {
      say(`0 of ${fmtN(r.total)} entries match.`);
      sayNotes(r, true);
      await sayWhyNothing(q, r, said, o);
      say(); say('Next:'); say(`  See what the bundle holds:   ${run('summary')}`); say(`  How searching works:         ${run('help search')}`);
      return;
    }
    let start = o.offset === undefined ? 0 : wholeNumber(o.offset, '--offset', 0, 1e9);
    if (o.last) start = Math.max(0, r.count - limit);
    if (start >= r.count) throw new Usage(`--offset ${fmtN(start)} is past the end: only ${plural(r.count, 'entry', 'entries')} match, so the largest useful offset is ${fmtN(Math.max(0, r.count - 1))}.`);
    const rows = await ds.rows(start, limit);
    say(`${fmtN(r.count)} of ${fmtN(r.total)} entries match. Showing ${fmtN(start + 1)} to ${fmtN(start + rows.length)}, oldest first. Times are in ${zoneSaid()}.`);
    sayNotes(r, false);
    say(); printRows(rows, { wide: o.wide });
    const id = rows[0][0], more = r.count - (start + rows.length);
    say(); say('Next:');
    if (more > 0) say(`  The next ${fmtN(Math.min(limit, more))} of the ${fmtN(more)} not shown:   ${again('search', o, pos, ['offset', 'last'], `--offset ${start + rows.length}`)}`);
    if (!o.last && r.count > limit) say(`  The newest matches instead:      ${again('search', o, pos, ['offset'], '--last')}`);
    say(`  One entry in full:               ${run(`show ${id}`)}`);
    say(`  What was logged around it:       ${run(`context ${id}`)}`);
    if (r.count > limit) {
      say(`  Which processes these are from:  ${again('count', o, pos, ['limit', 'offset', 'last', 'wide'], '--by process')}`);
      say(`  When they were logged:           ${again('histogram', o, pos, ['limit', 'offset', 'last', 'wide'])}`);
      say(`  All ${fmtN(r.count)} to a file:   ${again('export', o, pos, ['limit', 'offset', 'last', 'wide'], `--out ${shq(outName())}`)}`);
    }
  },

  async count(o, pos) {
    if (o.by !== undefined && !BY[o.by]) {
      const guess = closest(String(o.by), Object.keys(BY));
      throw new Usage(`--by "${o.by}" is not something entries can be counted by.${guess ? ` Did you mean --by ${guess}?` : ''} Use one of: ${Object.keys(BY).join(', ')}.`);
    }
    const { q, said } = await buildQuery(o, pos);
    const limit = o.limit === undefined ? 30 : wholeNumber(o.limit, '--limit', 1, 60);
    const r = await ds.query(q, () => {});
    say(heading(said));
    say(`${fmtN(r.count)} of ${fmtN(r.total)} entries match.`);
    sayNotes(r, !r.count);
    if (!r.count) { await sayWhyNothing(q, r, said, o); return; }
    const table = (field, n) => {
      const { vals, all } = largest(r, q, field, n);
      say(); say(`By ${field}${field === 'severity' ? ' (what this tool counts each level as)' : field === 'level' ? " (the logs' own level names)" : field === 'tag' ? ' (an entry can carry several)' : ''}:`);
      for (const [v, c] of vals) say(`  ${fmtN(c).padStart(11)}  ${((c / r.count) * 100).toFixed(1).padStart(5)}%  ${named(info.names[BY[field]][v] || '(none)')}`);
      if (all > vals.length) say(`  ... and ${fmtN(all - vals.length)} more ${field} values with fewer entries${n < 60 ? ` (--limit up to 60 lists more)` : '; narrow the search to see them'}.`);
      return vals;
    };
    let first = null;
    if (o.by) first = table(o.by, limit)[0];
    else for (const f of ['severity', 'source', 'tag', 'process']) { const v = table(f, 8); if (f === 'process') first = v[0]; }
    say(); say('Next:');
    if (!o.by) say(`  A longer list for one field:   ${again('count', o, pos, ['limit'], '--by process')}   (or severity, level, source, tag, subsystem, category, file)`);
    const name = first ? info.names[BY[o.by || 'process']][first[0]] : '';
    const by = o.by || 'process';
    if (name && plainHere(name)) say(`  Those ${MATCHES[BY_FIELD[by]]} the first ${by} listed:   ${again('search', o, [...pos, termFor(by, name)], ['by', 'limit'])}`);
  },

  async histogram(o, pos) {
    const { q, said } = await buildQuery(o, pos);
    const nb = o.bins === undefined ? 24 : wholeNumber(o.bins, '--bins', 2, 200);
    let r = await ds.query(q, () => {});
    say(heading(said));
    say(`${fmtN(r.count)} of ${fmtN(r.total)} entries match.`);
    sayNotes(r, !r.count);
    if (!r.count) { await sayWhyNothing(q, r, said, o); return; }
    // spread the bars over the span the matches cover (or the window asked for), not the whole bundle
    const t0 = q.t0 != null ? q.t0 : (await ds.rows(0, 1))[0][1], t1 = q.t1 != null ? q.t1 : (await ds.rows(r.count - 1, 1))[0][1] + 1;
    r = await ds.query({ ...q, t0, t1: Math.max(t1, t0 + nb), bins: nb }, () => {});
    const h = r.hist, step = (h.t1 - h.t0) / h.nb, total = (b) => h.bins[b * 3] + h.bins[b * 3 + 1] + h.bins[b * 3 + 2];
    let max = 0, busiest = 0;
    for (let b = 0; b < h.nb; b++) if (total(b) > max) { max = total(b); busiest = b; }
    say(`${h.nb} intervals of ${fmtSpan(step)} each, from ${fmtTime(h.t0, false)} to ${fmtTime(h.t1, false)}. Times are in ${zoneSaid()}.`);
    say('ERRORS counts errors and faults.');
    say(); say(`${'INTERVAL STARTS'.padEnd(19)}  ${'ENTRIES'.padStart(9)}  ${'ERRORS'.padStart(8)}  ${'WARNINGS'.padStart(8)}`);
    let empty = 0;
    const flush = () => { if (empty) say(`  (${plural(empty, 'interval')} with no entries)`); empty = 0; };
    for (let b = 0; b < h.nb; b++) {
      if (!total(b)) { empty++; continue; }
      flush();
      say(`${fmtTime(h.t0 + b * step, false)}  ${fmtN(total(b)).padStart(9)}  ${fmtN(h.bins[b * 3 + 2]).padStart(8)}  ${fmtN(h.bins[b * 3 + 1]).padStart(8)}  ${'#'.repeat(Math.max(1, Math.round((total(b) / max) * 40)))}`);
    }
    flush();
    const a = fmtTime(h.t0 + busiest * step, false), z = fmtTime(h.t0 + (busiest + 1) * step, false);
    say(); say('Next:');
    say(`  The entries in the fullest interval:   ${again('search', o, pos, ['bins', 'from', 'to', 'around', 'window'], `--from ${shq(a)} --to ${shq(z)}`)}`);
    say(`  Finer intervals over that stretch:     ${again('histogram', o, pos, ['bins', 'from', 'to', 'around', 'window'], `--from ${shq(a)} --to ${shq(z)}`)}`);
  },

  async show(o, pos) {
    if (pos.length !== 1 || !/^\d+$/.test(pos[0])) throw new Usage(`"show" takes one entry ID, the number in the first column of "search" output. For example: ${run('show 0')}`);
    const id = +pos[0];
    if (id >= info.total) throw new Usage(`There is no entry ${pos[0]}. IDs in this bundle run from 0 to ${fmtN(Math.max(0, info.total - 1))}.`);
    const d = await ds.row(id), r = d.row, N = info.names, sev = info.lvlSev[r[3]], src = info.sources[r[2]], lvl = N.lvl[r[3]];
    say(`Entry ${id} (IDs run from 0 to ${fmtN(info.total - 1)}, oldest first)`);
    say(`Time:       ${fmtTime(r[1])} ${offName(offsetAt(r[1]))}${offsetAt(r[1]) ? `  =  ${Core.stamp(r[1])} UTC` : ''}`);
    say(`Severity:   ${SEV[sev]}${lvl && lvl.toLowerCase() !== SEV[sev].toLowerCase() ? `  (the log's own level name is "${named(lvl)}")` : ''}`);
    say(`Source:     ${named(src.group)}  -  ${named(src.path)}`);
    if (N.proc[r[4]]) say(`Process:    ${named(N.proc[r[4]])}${r[5] ? `  (PID ${r[5]})` : ''}`);
    if (N.sub[r[6]]) say(`Subsystem:  ${named(N.sub[r[6]])}`);
    if (N.cat[r[7]]) say(`Category:   ${named(N.cat[r[7]])}`);
    const tags = N.tag.filter((_, b) => (r[8] >> b) & 1);
    if (tags.length) say(`Tags:       ${tags.map(named).join(', ')}`);
    for (const [k, v] of Object.entries(d.extra || {})) if (v) say(`${(k[0].toUpperCase() + k.slice(1) + ':').padEnd(11)} ${roomless(flat(v))}`);      // a path, a sender: names, like the fields above
    say(); say('Message:'); sayTheirs(r[9]);
    const brace = r[9].indexOf('{');
    if (brace >= 0 && r[9].length < 400000) { try { const j = JSON.parse(r[9].slice(brace)); if (j && typeof j === 'object') { say(); say('The JSON in that message, laid out:'); say(JSON.stringify(j, null, 2)); } } catch (e) { /* not JSON */ } }
    if (r[10]) { say(); say('This entry is longer than 2 MB; the rest is not shown.'); }
    say(); say('Next:');
    say(`  What was logged around it:        ${run(`context ${id}`)}`);
    if (plainHere(N.proc[r[4]])) say(`  Processes whose name contains this one's, a minute either side:   ${run(`search ${shq(termFor('process', N.proc[r[4]]))} --around ${id} --window 1m`)}`);
    if (d.extra && plainArg(d.extra.file)) say(`  The report file itself:           ${run(`cat ${shq(d.extra.file)}`)}`);
  },

  async context(o, pos) {
    if (!pos.length) throw new Usage(`"context" needs an entry ID or a time to centre on. For example: ${run('context 1234')}  or  ${run('context "2026-03-10 09:15:20"')}`);
    if (pos.length === 2 && /^\d{4}-\d\d-\d\d$/.test(pos[0]) && /^\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(pos[1])) pos = [`${pos[0]} ${pos[1]}`];
    if (pos.length > 1) throw new Usage(`"context" takes one entry ID or one time (put a time in quotation marks). To filter what is shown around a moment, use: ${run(`search WORDS --around ${shq(pos[0])} --window 1m`)}`);
    const before = o.before === undefined ? 10 : wholeNumber(o.before, '--before', 0, 2000), after = o.after === undefined ? 10 : wholeNumber(o.after, '--after', 0, 2000);
    const exact = /^\d+$/.test(pos[0]);
    let { id, t, half, a, b, report, t0, t1, cut } = await stretch(pos[0], exact, before, after, o.window);
    if (o.window !== undefined) {
      // A window cut to the times this tool reads is said as the window it was cut to
      const within = cut ? 'within that window' : `within ${fmtSpan(half)} either side`;
      if (cut) say(`The window of ${fmtSpan(half)} either side of ${fmtTime(t)} ${windowCutSaid(t0, t1)}.`);
      if (a === b) { say(`The bundle holds no entry ${cut ? within : `${within} of ${fmtTime(t)}`}. A longer --window, or no --window at all, shows the nearest entries.`); return; }
      if (b - a > 2000) {
        say(`${fmtN(b - a)} entries fall ${within}; the 2,000 nearest are shown. A shorter --window, or "search" with --around, narrows it.`);
        a = Math.max(a, id - 1000); b = Math.min(b, a + 2000);
      }
    }
    const rows = (await ds.readRows(Array.from({ length: b - a }, (_, i) => a + i), 2048)).map((x) => x.row);
    say(exact ? `Entries ${fmtN(a)} to ${fmtN(b - 1)}: everything logged around entry ${id}, from every source, with no filter. Entry ${id} is marked with >.`
      : `Entries ${fmtN(a)} to ${fmtN(b - 1)}: everything logged around ${fmtTime(t)}, from every source, with no filter. ${report ? `The entry of the report recorded at ${fmtTime(report.t)}` : 'The first entry at or after that time'} is marked with >.`);
    say(`Times are in ${zoneSaid()}.`);
    say(); printRows(rows, { wide: o.wide, mark: id });
    say(); say('Next:');
    if (o.window === undefined) say(`  More either side:              ${run(`context ${shq(pos[0])} --before ${Math.min(2000, before * 4 || 40)} --after ${Math.min(2000, after * 4 || 40)}`)}`);
    say(`  By time instead of by count:   ${run(`context ${shq(pos[0])} --window 30s`)}`);
    say(`  Only some of what is around:   ${run(`search WORDS --around ${shq(pos[0])} --window 1m`)}   (WORDS can be process:NAME, level:error and so on)`);
    say(`  One entry in full:             ${run(`show ${id}`)}`);
  },

  async reports() {
    const list = info.reports.slice().sort((a, b) => a.t - b.t);
    if (!list.length) {
      say('This bundle holds no crash, hang, spin, jetsam or other diagnostic report files.');
      say(); say('Next:'); say(`  Errors and faults in the logs instead:   ${run('search --min-severity error')}`);
      return;
    }
    say(`${plural(list.length, 'report')} in this bundle, oldest first. Times are in ${zoneSaid()}.`);
    say('Each is a report as its file records it, and KIND is taken from the file. A force-quit file can record more than one, and excel_sample.txt and excel_spindump.txt are read as the capture of Excel that the collector takes in hang mode.');
    say(); sayReports(list);
    const x = list[list.length - 1];
    say(); say('Next (shown for the newest report):');
    if (plainArg(x.path)) say(`  Read the report:                     ${run(`cat ${shq(x.path)}`)}`);
    say(`  What the logs say around that time:  ${run(`context ${shq(fmtTime(x.t, false))} --window 1m`)}`);
    say(`  Errors in the five minutes before:   ${run(`search --min-severity error --from ${shq(fmtTime(x.t - 300000, false))} --to ${shq(fmtTime(x.t + 1000, false))}`)}`);
  },

  async files(o, pos) {
    const f = pos.join(' ').toLowerCase(), hits = info.files.filter((x) => !f || x.path.toLowerCase().includes(f));
    const limit = o.all ? Infinity : o.limit === undefined ? 100 : wholeNumber(o.limit, '--limit', 1, 1e6);
    if (!hits.length) { say(`No file in this bundle has "${pos.join(' ')}" in its path. ${run('files')} lists all ${fmtN(info.files.length)}.`); return; }
    say(`${plural(hits.length, 'file')}${f ? ` with "${pos.join(' ')}" in the path` : ' in this bundle'}, ${fmtBytes(hits.reduce((a, x) => a + x.size, 0))} in all.`);
    say('ON TIMELINE is how many entries the file gives the merged timeline; - means it is not a log this tool reads line by line.');
    say(); say(`${'SIZE'.padStart(10)}  ${'ON TIMELINE'.padStart(11)}  PATH`);
    for (const x of hits.slice(0, limit)) say(`${fmtBytes(x.size).padStart(10)}  ${(onTimeline(x) ? fmtN(x.rows) : '-').padStart(11)}  ${named(x.path)}`);
    if (hits.length > limit) say(`... and ${fmtN(hits.length - limit)} more. Add --all, or part of a path: ${run('files reports')}`);
    // the first file, and the first log, whose path can be given in a command as it is (see plainHere)
    const first = hits.find((x) => plainArg(x.path)), log = hits.find((x) => onTimeline(x) && plainHere(x.path));
    if (first || log) { say(); say('Next:'); }
    if (first) say(`  Print a file:                  ${run(`cat ${shq(first.path)}`)}`);
    if (log) say(`  Entries ${MATCHES.source} this path:   ${run(`search ${shq(termFor('file', log.path))}`)}`);
  },

  async cat(o, pos) {
    if (pos.length !== 1) throw new Usage(`"cat" takes the path of one file in the bundle, as "files" prints it. For example: ${run('cat summary.md')}`);
    const hits = findFiles(pos[0]), f = hits[0];
    if (!hits.length) throw new Usage(`There is no file "${pos[0]}" in this bundle. ${run('files')} lists them; part of a path is enough when only one file has it.`);
    if (hits.length > 1) throw new Usage(`"${pos[0]}" is part of ${fmtN(hits.length)} paths. Give more of the one you want:\n${hits.slice(0, 20).map((x) => `  ${named(x.path)}`).join('\n')}${hits.length > 20 ? '\n  ...' : ''}`);
    const got = await fileLines(f), all = got.all, cut = got.cut;
    // The path to give this file by in a suggested command: its own when that can be given as it is, else what was typed.
    const arg = [f.path, pos[0]].find(plainArg);
    say(`File: ${named(f.path)} (${fmtBytes(got.size)})${onTimeline(f) ? `. Its ${fmtN(f.rows)} entries are also on the timeline${plainHere(f.path) ? `, among the entries ${MATCHES.source} this path: ${run(`search ${shq(termFor('file', f.path))}`)}` : ''}` : ''}`);
    if (got.empty) { say('The file is empty.'); return; }
    if (got.binary) {
      say(ODL.test(f.path) ? ODL_SAID : 'This is a binary file, so it is not printed. Its place on disk, when the bundle is a folder, is the same path under the bundle folder.');
      return;
    }
    const aboutCase = f.path === CASE_FILE ? caseSaid(all.join('\n')) : '';
    if (aboutCase) say(aboutCase);
    let from = 1, to = o.all ? all.length : Math.min(all.length, 200);
    if (o.lines !== undefined) {
      const m = /^(\d+)(?:-(\d+)?)?$/.exec(o.lines);
      if (!m || +m[1] < 1) throw new Usage(`--lines "${o.lines}" is not a range of lines. Write the first and last line numbers, for example --lines 200-400, or one number for a single line.`);
      from = +m[1]; to = m[2] ? +m[2] : /-$/.test(o.lines) ? all.length : from;
      if (from > all.length) throw new Usage(`--lines ${o.lines}: the file has only ${plural(all.length, 'line')}.`);
      to = Math.min(all.length, Math.max(from, to));
    }
    if (o.grep !== undefined) {
      const g = o.grep.toLowerCase(), hit = [];
      for (let i = from - 1; i < (o.lines !== undefined ? to : all.length); i++) if (all[i].toLowerCase().includes(g)) hit.push(i);
      const lim = o.all ? hit.length : Math.min(hit.length, 200);
      say(`${plural(hit.length, 'line')} of ${fmtN(all.length)} contain "${o.grep}" (capitals ignored)${hit.length > lim ? `; the first ${lim} are shown, --all shows every one` : ''}. Each is shown with its line number.`);
      say();
      for (const i of hit.slice(0, lim)) say(`${String(i + 1).padStart(String(all.length).length)}: ${all[i]}`);
      if (hit.length && arg) { say(); say('Next:'); say(`  The lines around a match:   ${run(`cat ${shq(arg)} --lines ${Math.max(1, hit[0] + 1 - 10)}-${hit[0] + 11}`)}`); }
      return;
    }
    say(`Lines ${fmtN(from)} to ${fmtN(to)} of ${fmtN(all.length)}${cut ? ` (only the first ${fmtBytes(READ_CAP)} of the file was read)` : ''}:`);
    say();
    for (let i = from - 1; i < to; i++) sayTheirs(all[i]);
    if (arg && (to < all.length || from > 1)) {
      say(); say('Next:');
      if (to < all.length) say(`  The next lines:              ${run(`cat ${shq(arg)} --lines ${to + 1}-${Math.min(all.length, to + 200)}`)}`);
      say(`  Only lines containing text:  ${run(`cat ${shq(arg)} --grep TEXT`)}`);
      if (!o.all && o.lines === undefined) say(`  The whole file:              ${run(`cat ${shq(arg)} --all`)}`);
    }
  },

  async memory() {
    const groups = memoryFiles().map((g) => [g.title, g.files]);
    // Counted are the entries that carry the memory tag itself (as the page counts them). The search offered below
    // finds every tag that holds "memory", so it can list more, and the words beside it say that.
    const r = await ds.query({ text: 'tag:memory', bins: 1 }, () => {}), tagged = info.total ? ds.tagTimes('memory', 1).total : 0;
    say('What this bundle recorded about memory. The figures are as the collector and macOS wrote them; nothing here is interpreted.');
    if (!groups.length && !r.count) { say(); say('It holds no memory files and no log entries tagged memory.'); return; }
    for (const [title, files] of groups) { say(); say(`${title}:`); for (const f of files.slice(0, 12)) say(`  ${fmtBytes(f.size).padStart(10)}  ${named(f.path)}`); if (files.length > 12) say(`  ... and ${fmtN(files.length - 12)} more`); }
    const csv = (memoryFiles().find((g) => g.kind === 'timeline') || { files: [] }).files[0];
    if (csv) {
      const { data, stats, levels, pids, cut } = await memoryTimeline(csv);
      // every cell is the file's text: one line each, with what takes no room written by its number (named)
      say(); say(`${named(csv.path)}: ${plural(data.length, 'sample')}${cut ? ` in its first ${fmtBytes(TIMELINE_BYTES)}, all that was read` : ''}${data.length ? `, from ${named(data[0][0])} to ${named(data[data.length - 1][0])} (the Mac's local time, as written in the file)` : ''}`);
      for (const s of stats) say(`  ${s.name}: lowest ${fmtN(s.lo[0])}${s.unit} at ${named(s.lo[1][0])}, highest ${fmtN(s.hi[0])}${s.unit} at ${named(s.hi[1][0])}, last ${fmtN(s.last)}${s.unit}`);
      if (levels.length) say(`  pressure_level values seen: ${levels.map((v) => `${named(v)} (${Object.hasOwn(PRESSURE, v) ? PRESSURE[v] : 'unknown'})`).join(', ')}`);
      if (pids) say(`  Excel process IDs seen: ${pids.length ? pids.map(named).join(', ') : 'none (Excel was not running at any sample)'}`);
    }
    say(); say(`Log entries tagged memory (kernel memory-pressure and jetsam messages): ${fmtN(tagged)}`);
    say(); say('Next:');
    const firstFile = groups.length ? groups[0][1][0] : null;
    if (firstFile && plainArg(firstFile.path)) say(`  Print one of those files:        ${run(`cat ${shq(firstFile.path)}`)}`);
    if (r.count) { say(`  Entries ${MATCHES.tag} memory:   ${run('search tag:memory')}`); say(`  When they were logged:           ${run('histogram tag:memory')}`); }
    if (info.reports.some((x) => x.kind === 'Jetsam')) say(`  Every report, with its time:     ${run('reports')}`);
  },

  async export(o, pos) {
    if (o.out === undefined) throw new Usage(`"export" needs --out and a file name to write, for example: ${again('export', o, pos, [], `--out ${shq(outName())}`)}`);
    const { q, said } = await buildQuery(o, pos), r = await ds.query(q, () => {});
    say(heading(said));
    sayNotes(r, !r.count);
    if (!r.count) { say(`0 of ${fmtN(r.total)} entries match, so no file was written.`); await sayWhyNothing(q, r, said, o); return; }
    const blob = await ds.exportTsv(() => {}), wrote = writeOut(o.out, new Uint8Array(await blob.arrayBuffer()));
    say(`Wrote ${plural(r.count, 'entry', 'entries')} to ${wrote} (${fmtBytes(blob.size)}).`);
    say('It is tab-separated text with a header line and one entry per line, oldest first. The columns are:');
    say('  utc_time, severity, level, source, process, pid, subsystem, category, tags, message');
    say('utc_time is always UTC. Inside a message, a tab is written as \\t and a line break as \\n.');
  },
};

// ---------- help ----------
function help(topic) {
  const B = bundleArg === 'BUNDLE' ? 'BUNDLE' : shq(bundleArg), me = `${RUNTIME} ${shq(SCRIPT)}`;
  const TOPICS = {
    '': `Excel diagnostics, command-line tool ${VERSION}

Searches a bundle made by excel_diagnostics.sh (the collector for Excel slowdowns, hangs and crashes on macOS)
without a browser. It merges every log in the bundle into one timeline, oldest first, and gives each entry an ID.
It reports what the logs hold; it does not judge what caused anything. Nothing is uploaded.

Usage
  ${me} BUNDLE [COMMAND] [WORDS] [--options]

  BUNDLE is the path to an Excel_Diagnostics_....zip, to the unzipped folder, or to a single log file.
  The word sample in its place opens built-in made-up data, for trying commands out.

Commands
  summary             What the bundle holds and where to start. This runs when no command is given.
  search [WORDS]      List the entries that match, oldest first, 40 at a time.
  count [WORDS]       How many matching entries there are per severity, source, tag and process.
  histogram [WORDS]   When the matching entries were logged, as counts per interval.
  show ID             One entry in full.
  context ID|TIME     What every source logged just before and after an entry or a moment.
  reports             The crash, hang and jetsam report files in the bundle, with their times.
  files [TEXT]        The files in the bundle.
  cat PATH            Print one file from the bundle.
  memory              The memory files and figures the bundle recorded.
  export [WORDS] --out FILE   Save every matching entry to a tab-separated file.
  clean               Delete the folders this tool unpacked zips into.
  help [TOPIC]        This text. Topics: search, time, examples, or any command name.

A good first three commands
  ${me} ${B}
  ${me} ${B} search --min-severity error
  ${me} ${B} help examples

Every command ends with a "Next:" list of commands that follow on from what it printed, ready to copy.
Exit status: 0 when the command ran (also when nothing matched), 2 when it was not understood, 1 on any other failure.
For programs: "${me} request" reads one JSON request from standard input and prints one JSON document in answer.
Needs Node 20 or later, or Deno 2 (deno run -A; --allow-read is enough when BUNDLE is a folder). The web viewer for the same bundles is ${VIEWER_URL}`,

    search: `Searching: the WORDS given to search, count, histogram and export

  pivot filter            Entries containing both words, anywhere in the entry. Capitals are ignored.
  "exceeded mem limit"    An exact phrase.
  /jetsam|memorystatus/   A regular expression.
  -runningboardd          Leave out entries containing this. Works on phrases, regular expressions and fields too.
  process:excel           The process name contains "excel".
  level:error             The level, or the severity this tool counts it as, starts with "error". Also: fault,
                          warning, default, info, debug, and Excel's own level names (medium, monitorable, unexpected).
  tag:memory              The entry carries a tag that contains "memory". Tags: excel, excel-helper, mentions-excel,
                          microsoft, hang-report, memory, restart, permissions, storage, logs-dropped.
  source:unified          The log it came from: part of a file path or of a source name ("summary" lists them).
  pid:4121  subsystem:com.apple.TCC  category:xpc      The process ID is 4121; the subsystem or category contains the text.
                          So process:kernel also finds kernelmanagerd, and tag:excel also finds mentions-excel.

  Every condition must hold (they are joined with AND). To get "either", use a regular expression: /crash|hang/

Typing it in a shell
  Put the whole search in single quotation marks so the shell passes it on untouched:
      ${me} ${B} search 'process:excel "exceeded mem limit" -tag:storage'
  Several words in one quoted argument, with no field, exclusion or regular expression among them, are taken
  as a phrase:   search "exceeded mem limit"   is the same as   search '"exceeded mem limit"'
  The first line of the output repeats the search as it was understood.

Options that narrow it further
  --min-severity error    That severity and above (debug, info, notice, warning, error, fault).
  --from TIME --to TIME   A time window; see "help time".
  --around ID|TIME --window 2m    A window centred on an entry or a moment (default 60 seconds either side).
  --case                  Capitals must match.

Options for the listing (search only)
  --limit N               How many entries to print (default 40).
  --offset N              Skip the first N matches; the "Next:" list gives the command for the next page.
  --last                  Print the newest matches instead of the oldest.
  --wide                  Do not shorten long messages.

When nothing matches, the output says how many entries would match with each condition taken away in turn.`,

    time: `Times

  Times are shown in the time zone of the Mac the bundle was collected on (the "logged Mac"), which is read from
  its macOS log. The first lines of each command's output name the zone and its UTC offset. Add --utc to any
  command to show, and read, times in UTC instead. If the logs record no zone, UTC is used and the output says so.

  Write a time the way the output prints it, in quotation marks because of the space:
      --from "2026-03-10 09:15:00"        seconds and fractions are optional: "2026-03-10 09:15"
      --from 2026-03-10                   a date alone means midnight at the start of that day
      --from 2026-03-10T13:15:00Z         ending in Z or an offset such as -04:00 fixes the zone, whatever --utc says
      --from 09:15                        a time alone is accepted only when the whole bundle falls on one day

  Lengths of time, for --window: 500ms, 30s, 5m, 2h, 1d.

  Excel's own logs and OneDrive's are written in UTC, the macOS log in local time; the tool lines them all up, so
  the same moment has the same time in every source.`,

    examples: `Worked examples. Each is a way to look, not a conclusion: read what comes back and decide for yourself.

See what led up to a crash or hang report
  1. ${me} ${B} reports
       Note the TIME and FILE of the report you care about.
  2. ${me} ${B} cat FILE
       Read the report itself.
  3. ${me} ${B} context "TIME" --window 1m
       Everything every source logged in the minute before and after.
  4. ${me} ${B} search --min-severity error --from "FIVE MINUTES EARLIER" --to "TIME"
       Only the errors and faults leading up to it.

Go to a time someone reported ("it froze around quarter past nine")
  ${me} ${B} histogram --from "2026-03-10 09:00" --to "2026-03-10 09:30"
  ${me} ${B} context "2026-03-10 09:15" --window 2m

Follow one process, or one run of it
  ${me} ${B} count --by process
  ${me} ${B} search 'process:"Microsoft Excel"' --min-severity warning
  ${me} ${B} search pid:4121

Find when something first and last appears
  ${me} ${B} search '"exceeded mem limit"' --limit 1
  ${me} ${B} search '"exceeded mem limit"' --limit 1 --last
  ${me} ${B} histogram '"exceeded mem limit"'

Look at one kind of entry
  ${me} ${B} search tag:permissions          sandbox and privacy refusals, "not permitted", "denied"
  ${me} ${B} search tag:storage              full disk, quota and I/O errors
  ${me} ${B} search tag:memory               kernel memory-pressure and jetsam messages
  ${me} ${B} memory                          the memory files and figures in the bundle

Read everything that matches, not 40 at a time
  ${me} ${B} export 'process:excel level:error' --out excel_errors.tsv

Read a file that is not a log
  ${me} ${B} files
  ${me} ${B} cat summary.md
  ${me} ${B} cat system/system_info.txt --grep memory`,

    summary: `summary [--utc]\n  The bundle's name, how many entries and files it has, the period covered, counts by severity, tag and process,\n  each log source with its first and last entry, the reports, and commands to start with.`,
    count: `count [WORDS] [--by FIELD] [--limit N] [search options]\n  How many of the matching entries there are per value. With no --by: the top 8 for severity, source, tag and process.\n  --by FIELD   one of severity, level, source, tag, process, subsystem, category, file; lists up to --limit (default 30, most 60).\n  "severity" is the tool's six-step scale; "level" is the name the log itself used (Default, Fault, Medium, Monitorable...).\n  WORDS and the other options are as for search: see "help search".`,
    histogram: `histogram [WORDS] [--bins N] [search options]\n  Counts of matching entries per interval of time, with errors (errors and faults) and warnings counted separately.\n  The intervals cover the span from the first match to the last, or the window given with --from/--to or --around.\n  --bins N   how many intervals (default 24, from 2 to 200).`,
    show: `show ID [--utc]\n  Every field of one entry and its whole message. ID is the number in the first column of search and context output.\n  IDs number the merged timeline from 0, oldest first, and stay the same for the same bundle.`,
    context: `context ID|TIME [--before N] [--after N] [--window SPAN] [--wide] [--utc]\n  Everything every source logged around one entry or one moment, with no filter, so nothing nearby is hidden.\n  --before N --after N   how many entries either side (default 10 each).\n  --window SPAN          instead, everything within SPAN either side (30s, 2m...), up to 2,000 entries.\n  To filter what is shown around a moment, use search with --around.`,
    reports: `reports [--utc]\n  The crash, hang, spin, jetsam, panic and other diagnostic report files in the bundle: time, kind, process and file.\n  Each report is also an entry on the timeline, so it appears in search and context output at its time.`,
    files: `files [TEXT] [--limit N] [--all]\n  The files in the bundle with their sizes, and how many timeline entries each log file gives.\n  TEXT keeps only paths containing it. 100 are listed unless --limit or --all is given.`,
    cat: `cat PATH [--lines A-B] [--grep TEXT] [--all]\n  Print a file from the bundle. PATH is as "files" prints it; part of a path is enough when only one file has it.\n  With no option the first 200 lines are printed.\n  --lines A-B   those lines only (A- means from A to the end).\n  --grep TEXT   only lines containing TEXT, capitals ignored, each with its line number.\n  --all         the whole file (the first 32 MB of a larger one).`,
    memory: `memory [--utc]\n  The memory-related files in the bundle, figures from the memory timeline when there is one (lowest, highest, last),\n  and how many log entries carry the memory tag. Figures only: nothing is interpreted.`,
    export: `export [WORDS] --out FILE [search options]\n  Write every matching entry to FILE as tab-separated text: utc_time, severity, level, source, process, pid,\n  subsystem, category, tags, message. An existing FILE is replaced.\n  FILE has to be outside the bundle folder: export does not write into the folder it reads, and it does not write\n  through a link. The path of the file that was written is printed.`,
    clean: `clean\n  Delete the folders this tool unpacked zips into, which are under the system's temporary folder.\n  A zip is unpacked there the first time it is opened, so later commands start faster. Opening a folder unpacks nothing.`,
  };
  TOPICS.help = TOPICS[''];
  if (TOPICS[topic || ''] === undefined) {
    const guess = closest(topic, Object.keys(TOPICS).filter(Boolean));
    throw new Usage(`There is no help topic "${topic}".${guess ? ` Did you mean "${guess}"?` : ''} Topics: search, time, examples, ${Object.keys(COMMANDS).join(', ')}.`);
  }
  say(TOPICS[topic || '']);
  if (topic && topic !== 'help' && OPTIONS[topic] && OPTIONS[topic].some((x) => QUERY.includes(x)) && topic !== 'search') { say(); say(`Search options it also takes: ${QUERY.map((x) => `--${x}`).join(', ')}. See: ${me} help search`); }
}
function clean() {
  const CACHE = cacheDir();
  let n = 0, bytes = 0;
  const size = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) size(p); else bytes += fs.statSync(p).size; } };
  if (fs.existsSync(CACHE)) for (const e of fs.readdirSync(CACHE, { withFileTypes: true })) if (e.isDirectory()) { size(path.join(CACHE, e.name)); fs.rmSync(path.join(CACHE, e.name), { recursive: true, force: true }); n++; }
  say(n ? `Deleted ${plural(n, 'unpacked bundle')} (${fmtBytes(bytes)}) from ${CACHE}. The zips themselves were not touched.` : `Nothing to delete: ${CACHE} holds no unpacked bundles.`);
}

// ---------- request mode ----------
/* One JSON request on standard input, one JSON document on standard output. It is how a program drives this tool
 * for a language model: the program runs it once for each call the model makes and hands the model what comes back.
 *
 * Every sentence written here is read by that model, often a small one, and it acts on what it reads. So a bundle
 * is named by its id and a file by its path inside the bundle, never by a path on this machine; a refusal names the
 * argument at fault and says what to send instead; a count says what it is a count of; a limit is announced when
 * it cut something and not otherwise; and nothing says why anything happened. Text from the bundle (a file's lines,
 * a message, a name in a listing) never starts a line of the text where a line of this tool's or the plugin's would:
 * a file's line comes after its number, a message's after two spaces, an entry's after its id. The work is done by
 * the helpers the text commands use, and where one of those refuses in words meant for a shell, the refusal is
 * worded again here.
 */
const OPS = ['summary', 'search', 'count', 'histogram', 'show', 'context', 'reports', 'files', 'read_file', 'memory'];
const TAKES_UTC = new Set(['summary', 'search', 'count', 'histogram', 'show', 'context', 'reports', 'memory']);
// One answer is read whole by a small model with a small context window, every turn after it is given. So it is
// held to at most 22,000 characters, about 5,500 tokens at four characters a token, and most answers are a small part
// of that: TEXT_MOST characters of text, RECEIPT_MOST of the receipt, NOTES_MOST of notes and NEXT_MOST of what could
// be called next. The receipt has room for the summary of a collection that recorded steps and days as less than
// whole, among ten bundles, without being cut. The plugin's own ceiling on a result is worked out from these four, so
// a change here is a change there (RESULT_MOST in openclaw/plugin/index.js; a case in the tests checks the two agree).
const TEXT_MOST = 10000;                                  // characters of text in one answer
const RECEIPT_MOST = 7000;                                // characters of the receipt, as JSON, in one answer
const NOTES_MOST = 3000, NOTES_COUNT_MOST = 12;           // characters of all the notes of one answer, and how many there are
const NEXT_MOST = 2000;                                   // characters of Next
const WINDOW_MOST = 30;                                   // entries a context window lists: about 6,000 to 7,000 characters at the usual maxChars
const LIST_LIMIT = 40, LIST_CHARS = 500;                  // the most entries, values, files or lines one call lists, and characters of each message line in a listing
const CONTEXT_SIDE = 20;                                  // the most entries a context call lists either side of its anchor
const SHOW_CHARS = 8000;                                  // the most characters of the one message show gives: with what it adds, less than TEXT_MOST
const ENTRY_BYTES = 64 << 10;                             // of each entry read for a listing; a longer one is read again by itself
const MORE = '\u2026';                                  // an ellipsis: it ends anything that was cut short

// An answer of ok:false that the caller can put right by sending something else.
class Refusal extends Error {
  constructor(error, field, hint, more) { super(error); Object.assign(this, { field, hint }, more); }
}

// The request being answered: its arguments as sent, the bundle they were read as, the notes gathered so far, and
// whether its time window reaches where the bundle has no macOS log (uncovered).
let P = {};
const R = { op: '', id: '', named: false, ids: [], notes: [], bundlesDir: null, cacheDir: null, option: {}, uncovered: false, sample: false };
// A note is one line of the facts the model reads. A value from the bundle is quoted in it already (fromBundle), but
// the engine's notes about the search text say what was sent as it was sent, and a phrase or a regular expression in
// a query can hold a line break: left as it is, it would start a line of the facts with whatever followed it. So in
// every note a line break is written as \n, and a character that would act, turn the line round or take no room by
// its number, as in a name; what is quoted already holds none of them and stays as it is.
const note = (s) => { s = shownAll(String(s).replace(BREAKS, '\\n')); if (!R.notes.includes(s)) R.notes.push(s); };
const said = () => lines.splice(0);                       // what the shared printers "said", taken back as lines of text

// ---------- reading arguments ----------
// A model leaves an argument out in more than one way: by omitting it, with null, or with an empty string.
const absent = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
const kindOf = (v) => (Array.isArray(v) ? 'A list' : typeof v === 'object' ? 'An object' : typeof v === 'string' ? 'A string' : typeof v === 'boolean' ? 'true or false' : 'A number');
// An argument or a name said back, never at length, with every character in it that would act, break the line, turn
// the text round or take no room written by its number (hidden(), in the text commands).
const shownAll = shownBy(hidden);
const quoted = (s, most = 60) => shownAll(JSON.stringify(s.length > most ? `${s.slice(0, most)}${MORE}` : s));
// Whoever made a bundle chose every name in it: its tags, its process and level names, the paths of its files, and
// (as the name of the zip or folder) its id. A sentence written here is one the model acts on, so a name from the
// bundle is never part of its wording. Where one has to be said, fromBundle() says it as data: on one line, cut
// short, in quotation marks, and not as the first words of the sentence. Where a result suggests a call, a name or
// a path goes into it only when it is short and plain (plainName, plainPath); a suggestion that would need any
// other is left out. No key of a result is a name from the bundle: where names are counted, each name is a value in
// a list ({tag, entries}), as it is in a count, and only this tool's own words are keys.
const fromBundle = (s) => quoted(String(s), 200);
// A path sent is read without spaces at its ends (text()), so a name with a space at either end is never plain: a call
// offered with it would reach another file, or none.
const plainName = (s) => typeof s === 'string' && /^[\w.()\[\]-](?:[\w .()\[\]-]{0,58}[\w.()\[\]-])?$/.test(s);
const plainPath = (s) => typeof s === 'string' && s.length <= 200 && s.split('/').every(plainName);      // each folder and the file name, a plain name
// Nothing from a bundle is passed on at any length. A name, a path or a list in a result can be as long as whoever
// wrote the bundle likes; each is cut here, whatever part of the result it sits in. The receipt as a whole has one
// budget as well, the size one answer's text may be: when it is over, its lists and then its strings are cut
// further, step by step, until it fits, and a note says what the cut was.
const STRING_MOST = 1200, LIST_MOST = 200, NOTE_MOST = 1200;
const clipped = (s, most) => (s.length > most ? `${s.slice(0, most)}${MORE}` : s);
function bounded(v, lists, strings, was) {
  if (typeof v === 'string') return clipped(v, strings);
  if (Array.isArray(v)) { if (v.length > lists) was.cut = true; return v.slice(0, lists).map((x) => bounded(x, lists, strings, was)); }
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[clipped(k, strings)] = bounded(v[k], lists, strings, was); return o; }
  return v;
}
const BUDGET_STEPS = [[LIST_MOST, STRING_MOST], [100, STRING_MOST], [50, STRING_MOST], [25, 600], [12, 300], [6, 150], [3, 80], [1, 40], [0, 20]];
function withinBudget(receipt) {
  let out, was, step = 0;
  for (;; step++) {
    was = { cut: false };
    out = bounded(receipt, BUDGET_STEPS[step][0], BUDGET_STEPS[step][1], was);
    // measured as it will be written (asJson), each character that is written as its escape counted at that length
    if (asJson(out).length <= RECEIPT_MOST || step === BUDGET_STEPS.length - 1) break;
  }
  const [lists, strings] = BUDGET_STEPS[step];
  if (step) note(`This result was larger than one answer holds, so it was cut to fit: no list in it has more than ${count(lists, 'item')}, and no name, path or other text in it more than ${strings} characters.`);
  else if (was.cut) note(`A list in this result was cut to its first ${LIST_MOST} items.`);
  if (step || was.cut) out.truncated = true;
  return out;
}
// How many of `list` (the values of a count, most entries first) the receipt `base` holds as its values within
// RECEIPT_MOST, measured as withinBudget measures it: a call is offered, or said to list so many, only for as many as
// it lists whole, and moreValues counts every value that is not listed.
function valuesFitting(base, list) {
  const size = (k) => asJson(bounded({ ...base, values: list.slice(0, k), truncated: true }, LIST_MOST, STRING_MOST, {})).length;
  let k = list.length;
  while (k > 1 && size(k) > RECEIPT_MOST) k--;
  return k;
}

// The example in a refusal is the value that was sent, as a string, whenever that is what was meant; an invented
// example is one more thing a model can copy in place of a real value. `example` is a value from the bundle, or a
// function that makes one from what was sent. A list of one string is that string, when it can be said whole.
function text(name, example, keepSpaces) {
  const v = P[name];
  if (absent(v)) return undefined;
  if (typeof v !== 'string') {
    const one = Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' && v[0].trim() && v[0].length <= SENT_BACK_MOST && quoted(v[0], SENT_BACK_MOST) === JSON.stringify(v[0]) ? v[0] : '';
    const like = one || (typeof example === 'function' ? example(v) : example) || (typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
    throw new Refusal(`${name} must be a string`, name, `Send ${name} as a string in quotation marks${like ? `, for example ${JSON.stringify(like)}` : ''}. ${kindOf(v)} was sent.`);
  }
  return keepSpaces ? v : v.trim();
}
// A path as it is looked for: without spaces at its ends, unless the bundle has a file at the path exactly as it was
// sent, spaces and all. A path said back as sent is P.path itself.
function pathSent() {
  const typed = text('path');
  return typed !== undefined && P.path !== typed && info.files.some((x) => x.path === P.path) ? P.path : typed;
}
// A time that is really in this bundle, to show how one is written: with its offset where the bundle's clock has more
// than one, as every time a hint states is (timeSaid)
const timeLike = () => (info && info.total ? timeSaid(info.t0) : '');
// A length of time sent as a bare number is that many seconds in the example, as a string with its unit ("60s"); a
// number that cannot be one, or that is longer than the tool takes (parseSpan), is not turned into one
const spanTaken = (s) => { try { parseSpan(s, 'window'); return true; } catch (err) { return false; } };
const spanLike = (v) => (typeof v === 'number' && /^\d+(\.\d+)?$/.test(String(v)) && spanTaken(`${v}s`) ? `${v}s` : '30s');
// A length of time sent in words ("2 minutes", "1 hour", "30 secs") as this tool writes it ("2m"), when the words are
// a number and one of the units spelt out, and the tool takes that length (parseSpan); else undefined
const UNITS = [[/^(ms|msecs?|milliseconds?)$/, 'ms'], [/^(s|secs?|seconds?)$/, 's'], [/^(m|mins?|minutes?)$/, 'm'], [/^(h|hrs?|hours?)$/, 'h'], [/^(d|days?)$/, 'd']];
function spanSaid(sent) {
  const m = /^\s*(\d{1,9}(?:\.\d{1,3})?)\s*([a-z]{1,12})\s*$/i.exec(String(sent)), unit = m && UNITS.find(([rx]) => rx.test(m[2].toLowerCase()));
  return unit && spanTaken(`${m[1]}${unit[1]}`) ? `${m[1]}${unit[1]}` : undefined;
}
function flag(name) {
  const v = P[name];
  if (absent(v)) return false;
  if (v !== true && v !== false) throw new Refusal(`${name} must be true or false`, name, `Send ${name} as true or false without quotation marks, or leave it out. ${kindOf(v)} was sent.`);
  return v;
}
// A number over the most is lowered, and a note says so, because the call still means something. One that is not
// a whole number, or is under the least, means nothing that can be guessed, so it is refused.
function whole(name, least, most, usual) {
  const v = P[name];
  if (absent(v)) return usual;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    // a whole number sent as a string is offered back as the number it is
    const like = typeof v === 'string' && /^\s*\d{1,15}\s*$/.test(v) && +v >= least && (most === undefined || +v <= most) ? `, for example ${+v}` : '';
    throw new Refusal(`${name} must be a whole number`, name, `Send ${name} as a whole number without quotation marks, ${least} or more${like}. ${typeof v === 'number' ? 'A number that is not whole' : kindOf(v)} was sent.`);
  }
  if (v < least) throw new Refusal(`${name} is too small`, name, `${name} must be ${least} or more; ${v} was sent. Send a larger whole number${usual === undefined ? '' : `, or leave ${name} out`}.`);
  if (most !== undefined && v > most) { note(`${name} ${v} is more than this tool returns in one call; ${most} was used.`); return most; }
  return v + 0;                                           // a minus zero becomes zero
}

// ---------- argument names ----------
// A model sends an argument under a name it knows from elsewhere: q for query, severity for minSeverity, file for
// path. A call that runs without it reads as if it had been narrowed by it, so each such name, for the operations
// that have the argument it stands for, is refused before anything runs: the error names the name that was sent, and
// field the argument to send in its place (so that field, as in every refusal, is an argument the tool has), which the
// hint gives the value that was sent where it means the same there. The tool descriptions name the commonest of them.
// Any other name is not looked at here (the plugin says it was ignored), and a name an operation has is never one of
// its wrong names. The caller passes the names its tool does not declare as `undeclared`, apart from the arguments. Of
// those values, only the ones that are wrong names are looked at, and each only as sentBack() says it.
const FILTERING = ['search', 'count', 'histogram'], WITH_PATH = ['reports', 'read_file'];
const RENAMED = [
  ['query', ['q', 'text', 'pattern', 'filter', 'search', 'keyword', 'keywords'], FILTERING],
  ['minSeverity', ['severity', 'level', 'minLevel', 'min_severity'], FILTERING],
  ['from', ['start', 'since', 'begin'], [...FILTERING, 'memory']],
  ['to', ['end', 'until'], [...FILTERING, 'memory']],
  ['matchCase', ['caseSensitive', 'case'], FILTERING],
  ['aroundId', ['id', 'entry'], FILTERING],
  ['limit', ['count', 'max', 'maxResults'], ['search', 'count', 'files', 'read_file']],
  ['limit', ['lines'], ['read_file']],
  ['offset', ['page', 'skip'], ['search', 'files']],
  ['newest', ['last', 'latest'], ['search']],
  ['by', ['groupBy', 'group', 'field'], ['count']],
  ['bins', ['buckets', 'interval', 'intervals'], ['histogram']],
  ['id', ['entry', 'index', 'entryId', 'aroundId'], ['show', 'context']],
  ['time', ['aroundTime', 'at'], ['context', 'memory']],
  ['path', ['file', 'filename', 'filePath', 'name'], WITH_PATH],
  ['filter', ['query', 'pattern', 'path'], ['files']],
  ['grep', ['pattern', 'query', 'search'], ['read_file']],
  ['fromLine', ['offset', 'line', 'start'], ['read_file']],
  ['bundle', ['bundleId', 'bundle_id'], OPS],
  ['bundle', ['name'], OPS.filter((op) => !WITH_PATH.includes(op))],
];
// The value that was sent is given to the argument in the hint only where the call would then mean what was sent: the
// value is of the kind the argument takes (RENAMED_KIND), short and with nothing in it said by its number (so that it is
// the value that was sent, whole), and the wrong name means the same as the argument. Three do not (ELSEWHERE): a page
// is not a count of matches to skip, an interval is a length and not how many there are, and an offset counts lines
// skipped where fromLine is the number of the first line read. For those the hint says what the argument is instead.
const RENAMED_KIND = { matchCase: 'flag', newest: 'flag', aroundId: 'whole', limit: 'whole', offset: 'whole', bins: 'whole', id: 'whole', fromLine: 'whole' };      // any other: a string
const WRONG_KIND = { string: 'as a string in quotation marks', whole: 'as a whole number without quotation marks', flag: 'as true or false without quotation marks' };
const ELSEWHERE = { 'page offset': 'offset is how many to skip, copied from nextOffset, not a page number', 'interval bins': 'bins is how many intervals to count in, not how long each is',
  'intervals bins': 'bins is how many intervals to count in, not how long each is', 'offset fromLine': 'fromLine is the number of the first line to read, from 1' };
const SENT_BACK_MOST = 200;
// Nor is a value given that the argument would refuse: a whole number under its least, a time it does not read on
// this bundle (timeBack), a severity, a way to count or a bundle it does not have, an entry id the bundle does not
// have, a line past the end of the file read, or a path that names no file of the kind the call reads (or more than
// one). The hint then says what the argument takes (TAKES_SAID), so that the next call is not refused in turn. The
// last three are known only once the bundle is open (OPENED): a call with one is refused then.
const RENAMED_LEAST = { aroundId: 0, limit: 1, offset: 0, bins: 1, id: 0, fromLine: 1 };
const OPENED = new Set(['aroundId', 'id', 'fromLine', 'path']);
// the shapes parseTime reads: a date, with a time of day and an offset or not, or a time of day alone
const DATED = /^(?:\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?)?\s*(?:Z|UTC|[+-]\d\d:?\d\d)?|\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?)$/i;
const TIMED = new Set(['from', 'to', 'time']);
const COUNTED_BY = () => [...Object.keys(BY), 'message'];
const TAKES_SAID = {
  from: 'as a time written the way results print times (YYYY-MM-DD HH:MM:SS)', to: 'as a time written the way results print times (YYYY-MM-DD HH:MM:SS)',
  time: 'as a time written the way results print times (YYYY-MM-DD HH:MM:SS)', minSeverity: `as one of: ${SEV.map((x) => x.toLowerCase()).join(', ')}`,
  by: () => `as one of: ${COUNTED_BY().join(', ')}`, bundle: () => `as a bundle id copied from availableBundles in ${tool('summary')} results`,
  // these four with what the open bundle and the file read have (OPENED); where a wrong name for bundle was sent too,
  // nothing is open when they are said ({ op } alone), and they say what one takes in any bundle
  aroundId: () => (info && info.total ? `as a whole number without quotation marks: an entry id, from 0 to ${info.total - 1} in this bundle` : WRONG_KIND.whole),
  id: () => (info && info.total ? `as a whole number without quotation marks: an entry id, from 0 to ${info.total - 1} in this bundle` : WRONG_KIND.whole),
  fromLine: (open) => (open.lines ? `as a whole number without quotation marks: a line number, from 1 to ${open.lines} in the file read` : WRONG_KIND.whole),
  path: (open) => (open.op === 'reports' ? `as a path copied from the FILE column of ${tool('reports')}` : `as a path copied from the PATH column of ${tool('files')}`),
};
// The value as the argument would take it, as written in a call; else undefined. open is what the open bundle says
// ({ op, lines }, lines being how many the file read has), or false before it is open.
function sentBack(right, v, open) {
  const kind = RENAMED_KIND[right] || 'string';
  if (kind === 'flag') return typeof v === 'boolean' ? String(v) : undefined;
  if (kind === 'whole') {
    const n = Number.isInteger(v) ? v + 0 : typeof v === 'string' && /^\s*\d{1,15}\s*$/.test(v) ? +v : undefined;
    if (n === undefined || n < (RENAMED_LEAST[right] ?? 0)) return undefined;
    if (right === 'aroundId' || right === 'id') return open && n <= info.total - 1 ? String(n) : undefined;
    if (right === 'fromLine') return open && open.lines !== undefined && n <= open.lines ? String(n) : undefined;
    return String(n);
  }
  if (typeof v !== 'string' || v.length > SENT_BACK_MOST || quoted(v, SENT_BACK_MOST) !== JSON.stringify(v)) return undefined;
  const t = v.trim();
  if (TIMED.has(right)) return undefined;                 // a time is given back only as timeBack reads it, on the bundle open
  if (right === 'minSeverity' && !SEV.some((x) => x.toLowerCase() === t.toLowerCase())) return undefined;
  if (right === 'by' && !COUNTED_BY().includes(t.toLowerCase())) return undefined;
  if (right === 'bundle' && !bundleNamed(t)) return undefined;
  if (right === 'path' && !(open && pathNamesOne(open.op, v))) return undefined;
  return quoted(v, SENT_BACK_MOST);
}
// Whether path, sent this, names one file of the kind the call reads, as read_file (findFiles) and reports
// (findReports) find one: the path as it was sent when the bundle has a file there, else without spaces at its ends
function pathNamesOne(op, v) {
  const typed = info.files.some((x) => x.path === v) ? v : v.trim();
  return typed !== '' && (op === 'reports' ? findReports(typed).length === 1 : findFiles(typed).length === 1);
}
// How many lines the file a read_file call reads has, as read_file counts them, for a line number sent under a wrong
// name: the file named by path, or by the first wrong name for path, when that is one file of text. Else undefined.
async function linesRead(op, given) {
  const named = Object.keys(given).find((k) => ['file', 'filename', 'filePath', 'name'].includes(k) && typeof given[k] === 'string' && !absent(given[k]));
  const v = typeof P.path === 'string' && !absent(P.path) ? P.path : named ? given[named] : undefined;
  if (op !== 'read_file' || v === undefined || !pathNamesOne(op, v)) return undefined;
  const typed = info.files.some((x) => x.path === v) ? v : v.trim();
  try { const got = await fileLines(findFiles(typed)[0]); return got.binary || !got.all ? undefined : got.all.length; } catch (err) { return undefined; }
}
// A time sent under a wrong name, as the argument would read it on this bundle (open): run through the same reader
// and the same checks as the argument itself, it is given back as it was sent ({value, t}) when they take it. A time
// of day alone, on a bundle of more than one day, is refused there for having no date: it is given back with the
// bundle's last day before it, as that refusal's example writes it ({value, t, day}), and the hint says so. Else, or
// on a bundle with no entries to take a day from, undefined.
function timeBack(op, right, v) {
  if (typeof v !== 'string' || v.length > SENT_BACK_MOST || quoted(v, SENT_BACK_MOST) !== JSON.stringify(v)) return undefined;
  const sent = v.trim(), option = right === 'time' ? (op === 'context' ? 'context' : 'time') : `--${right}`;
  if (!DATED.test(sent) || (!info.total && /^\d\d:\d\d/.test(sent))) return undefined;
  const read = (s) => { try { const t = parseTime(s, option); return t === t ? t : undefined; } catch (err) { return undefined; } };
  const t = read(sent);
  if (t !== undefined) return { value: quoted(v, SENT_BACK_MOST), t };
  const day = /^\d\d:\d\d/.test(sent) ? daysSaid().last : '', whole = `${day} ${sent}`, at = day ? read(whole) : undefined;
  return at === undefined ? undefined : { value: quoted(whole), t: at, day };
}
// Whether bundle, sent this, would name one bundle (pickBundle, without its refusals or its note)
function bundleNamed(want) {
  if (R.sample && want === 'sample') return true;
  if (!want || /[\/\\]|\.\./.test(want) || want.startsWith('.')) return false;
  let list;
  try { list = R.bundlesDir ? bundlesIn(R.bundlesDir) : []; } catch (err) { return false; }
  const low = want.toLowerCase(), alike = list.filter((b) => b.id.toLowerCase() === low).length;
  return list.some((b) => b.id === want) || alike === 1 || (!alike && list.filter((b) => b.id.toLowerCase().includes(low)).length === 1);
}
// What a level name sent as minSeverity is counted as: the severity of the bundle's level of that name, when the
// bundle is open and has one (the LEVEL column of every listing shows them); else, with known, of a level name this
// tool knows (Core.levelSev). Said as the sentence levelSaid gives, or as nothing.
function levelSaid(v, known) {
  const low = String(v).trim().toLowerCase(), names = info && info.names && info.names.lvl ? info.names.lvl : [];
  const k = names.findIndex((n) => typeof n === 'string' && n.toLowerCase() === low), sev = k >= 0 ? info.lvlSev[k] : known ? Core.levelSev(low) : -1;
  if (!(sev >= 0 && sev < SEV.length)) return '';
  const name = SEV[sev].toLowerCase();
  return ` ${k >= 0 ? `${quoted(v)} is a level in this bundle, and this tool counts entries at that level` : `This tool counts entries at a level named ${quoted(v)}`} as ${name}: minSeverity "${name}" keeps them and every severity above.`;
}
// The name a word sent for one of a fixed list of names stands for: the one it is another name for (NAMED_AS), else
// the nearest, when it is near: the start of that name and no other, or fewer edits from it than half the word's
// length. "msg" is not near "tag", though two edits apart.
const NAMED_AS = { msg: 'message', msgs: 'message', messages: 'message', proc: 'process', processes: 'process', sev: 'severity', severities: 'severity', lvl: 'level', levels: 'level',
  src: 'source', sources: 'source', tags: 'tag', files: 'file', path: 'file', paths: 'file', sub: 'subsystem', subsystems: 'subsystem', cat: 'category', categories: 'category' };
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = keep; }
  }
  return row[b.length];
}
function nearName(word, names) {
  const w = String(word).trim().toLowerCase().slice(0, 40);
  if (Object.hasOwn(NAMED_AS, w) && names.includes(NAMED_AS[w])) return NAMED_AS[w];
  const guess = closest(w, names);
  return guess && ((w.length >= 2 && guess.startsWith(w)) || editDistance(w, guess) * 2 < w.length) ? guess : undefined;
}
// A time is given back only as the bundle reads it (timeBack), and an entry id, a line number or a path only as the
// open bundle has them (OPENED), so a call with one under a wrong name is refused once the bundle is open: renamed()
// then gives the function that refuses it, which is called then (open: { op, lines }), and refuses any other at once.
// Unless a wrong name stands for bundle: the call it offers would go to another bundle, so no time, id, line or path
// is given back, and the hint says what one takes.
function renamed(op, given, open) {
  const renames = new Map();
  for (const [right, wrongs, ops] of RENAMED) if (ops.includes(op)) for (const w of wrongs) if (!renames.has(w)) renames.set(w, right);
  const wrong = Object.keys(given).filter((k) => renames.has(k) && !absent(given[k]));
  if (!wrong.length) return undefined;
  // Each argument is given the value of the first wrong name for it. Another wrong name for the same argument, or one
  // for an argument that was sent as well, is to be left out.
  const sent = new Set(Object.keys(P).filter((k) => !renames.has(k) && !absent(P[k]))), moved = [], again = [], twice = [];
  for (const w of wrong) {
    const right = renames.get(w);
    if (sent.has(right)) twice.push([w, right]); else if (moved.some(([, r]) => r === right)) again.push([w, right]); else moved.push([w, right]);
  }
  const elsewhere = moved.some(([, r]) => r === 'bundle');
  if (!open && !elsewhere && moved.some(([w, r]) => (TIMED.has(r) && typeof given[w] === 'string') || OPENED.has(r))) return async () => renamed(op, given, { op, lines: await linesRead(op, given) });
  const back = new Map();
  for (const [w, r] of moved) {
    if (ELSEWHERE[`${w} ${r}`]) continue;
    const b = TIMED.has(r) ? (open ? timeBack(op, r, given[w]) : undefined) : sentBack(r, given[w], open) === undefined ? undefined : { value: sentBack(r, given[w], open) };
    if (b) back.set(w, b);
  }
  // from and to as the call offered would read them: one given back, or the one sent under its own name. Where to is
  // not later than from, that call is refused for it, so neither is given back, and the hint says which way round.
  const paired = new Set();
  if (open) {
    const at = (r) => { const m = moved.find(([, x]) => x === r); if (m) return back.has(m[0]) ? back.get(m[0]).t : undefined; if (typeof P[r] !== 'string') return undefined; try { return parseTime(P[r].trim(), `--${r}`); } catch (err) { return undefined; } };
    const a = at('from'), b = at('to');
    if (a === a && b === b && a !== undefined && b !== undefined && b <= a) for (const [w, r] of moved) if (r === 'from' || r === 'to') { back.delete(w); paired.add(w); }
  }
  const withValue = moved.filter(([w]) => back.has(w)), rest = moved.filter((m) => !withValue.includes(m));
  const asSent = withValue.filter(([w]) => !back.get(w).day), onDay = withValue.filter(([w]) => back.get(w).day);
  const values = (list) => `{${list.map(([w, r]) => `${r}: ${back.get(w).value}`).join(', ')}}`;
  const hint = [
    asSent.length ? `Send ${and(asSent.map(([w, r]) => `${r} in place of ${w}`))}, with the ${asSent.length > 1 ? 'values that were' : 'value that was'} sent: ${values(asSent)}.` : '',
    onDay.length ? `Send ${and(onDay.map(([w, r]) => `${r} in place of ${w}`))}, with this bundle's last day written before the ${onDay.length > 1 ? 'times of day that were' : 'time of day that was'} sent: ${values(onDay)}. ` +
      `This bundle covers more than one day (${daysSaid().span}), so a time needs a date: any day from ${daysSaid().first} to ${daysSaid().last}.` : '',
    // a string too long to say again, or with a character in it that would be said by its number, is not said again
    ...rest.map(([w, r]) => (ELSEWHERE[`${w} ${r}`] ? `Send ${r} in place of ${w}: ${ELSEWHERE[`${w} ${r}`]}.`
      : paired.has(w) ? `Send ${r} in place of ${w}, as a time ${r === 'from' ? 'earlier than to' : 'later than from'}, written the way results print times (YYYY-MM-DD HH:MM:SS).`
      : open && OPENED.has(r) && (typeof given[w] === 'string' || RENAMED_KIND[r]) ? `Send ${r} in place of ${w}, ${TAKES_SAID[r](open)}.`
      : TAKES_SAID[r] && typeof given[w] === 'string' ? `Send ${r} in place of ${w}, ${typeof TAKES_SAID[r] === 'function' ? TAKES_SAID[r]({ op }) : TAKES_SAID[r]}.${r === 'minSeverity' ? levelSaid(given[w], true) : ''}`
        : !RENAMED_KIND[r] && typeof given[w] === 'string' ? `Send ${r} in place of ${w}, with the value that was sent.` : `Send ${r} in place of ${w}, ${WRONG_KIND[RENAMED_KIND[r] || 'string']}.`)),
    twice.length ? `Leave out ${and(twice.map(([w, r]) => `${w}, which stands for ${r}`))}: ${twice.length > 1 ? 'those are' : 'that is'} sent already.` : '',
    again.length ? `Leave out ${and(again.map(([w, r]) => `${w}, which stands for ${r} as well`))}.` : '',
    'This call did not run.',
  ].filter(Boolean).join(' ');
  throw new Refusal(`${wrong[0]} is not a field of ${tool(op)}`, renames.get(wrong[0]), hint);
}

// ---------- saying things ----------
const tool = (op) => `excel_diag_${op}`;
// A value in a suggested call, as JSON. A value can come from the bundle (the bundle id does, whole, when the call
// named a bundle), and JSON leaves some characters as they are that break a line, turn text round or take no room
// (see hidden() in the text commands). Each of those is written as its escape instead (a character past U+FFFF as
// the two escapes of its UTF-16 pair): the value still decodes to exactly what it was, so the call still reaches
// what it names, and it is said on one line, the right way round, with nothing in it unseen. The plugin writes the
// facts of a result the same way, and the receipt is measured written so (withinBudget).
const escapes = (c) => c.split('').map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const asJson = (v) => { let out = ''; for (const c of JSON.stringify(v)) out += hidden(c.codePointAt(0)) ? escapes(c) : c; return out; };
const braces = (o) => `{${Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${asJson(v)}`).join(', ')}}`;
// A call the model could make next, written the way it would send it. It stays on the bundle and the clock of this
// call: without that, a follow-up to a call that named an older bundle would quietly go to the newest one.
const call = (op, a = {}) => `${tool(op)} ${braces({ ...a, ...(utc && TAKES_UTC.has(op) ? { utc: true } : {}), ...(R.named ? { bundle: R.id } : {}) })}`;
// A time in a call this tool offers, as results print it. Where the Mac's clock changed its offset during the bundle,
// one printed time can be two moments, and a time sent with no offset is read on the clock of the first: so then it is
// written with the offset it was printed on (-05:00), which the time reader takes as it stands.
const offsetSaid = (om) => `${om < 0 ? '-' : '+'}${z2((Math.abs(om) / 60) | 0)}:${z2(Math.abs(om) % 60)}`;
const offsetsChange = () => !utc && info.zone.length > 1 && new Set(info.zone.map((z) => z[1])).size > 1;
// A time in a sentence is written the same way: on such a bundle, "from 09:00:00 to 09:30:00" can be a span of
// minutes or of an hour and more, and a time after another can be printed before it. So each time a fact, a hint or a
// Next: sentence states is written with its offset whenever the bundle's clock has more than one (ms: with its
// milliseconds, as listings print them). A value in the receipt is written as results print times, beside timeZone.
const timeSaid = (t, ms = false) => `${fmtTime(t, ms)}${offsetsChange() ? offsetSaid(offsetAt(t)) : ''}`;
const timeArg = (t) => timeSaid(t);
// A time that was sent, said back in a fact: with its milliseconds when it has them, so that it is the moment asked
const timeAsked = (t) => timeSaid(t, t % 1000 !== 0);
// Where a time of day alone needs a day: the bundle's first and last days, and its first and last entries as a span
const daysSaid = () => ({ first: fmtTime(info.t0, false).slice(0, 10), last: fmtTime(info.t1, false).slice(0, 10), span: `${timeSaid(info.t0)} to ${timeSaid(info.t1)}` });
// At most three calls, each with what it gives, then leave to stop: a result that ends on an instruction is obeyed.
// Only whole calls: one that would take Next past NEXT_MOST is left out, and those after it are offered when they fit,
// as a call cut short is one a model copies as it stands (a query sent can be as long as the caller likes, and it is
// sent again in the calls offered).
const REPLY_NOW = 'If this answers the question, reply now.';
function nextSaid(steps) {
  const said = [];
  for (const [c, gives] of steps.slice(0, 3)) {
    const one = `${c} ${gives}.`;
    if ([...said, one, REPLY_NOW].join(' ').length <= NEXT_MOST) said.push(one);
  }
  return steps.length ? [...said, REPLY_NOW].join(' ') : undefined;
}
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]);
const camel = (s) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
function clip(s, most) {                                  // s, or its first `most` characters and how many were left out
  if (s.length <= most) return s;
  const n = most > 1 && s.charCodeAt(most - 1) >= 0xD800 && s.charCodeAt(most - 1) <= 0xDBFF ? most - 1 : most;      // not through the middle of a character
  return `${s.slice(0, n)}${MORE}[${s.length - n} more characters]`;
}
function lengthSaid(ms) {                                 // a whole number of seconds, exactly: "15 min", "1 h 30 min"
  const s = Math.round(ms / 1000);
  return [[Math.floor(s / 3600), 'h'], [Math.floor((s % 3600) / 60), 'min'], [s % 60, 's']].filter(([n]) => n).map(([n, unit]) => `${n} ${unit}`).join(' ') || '0 s';
}
function zone() {                                         // what the receipt calls the clock its times are on
  if (!utc && !info.zone.length) note("These logs do not record the Mac's time zone, so times are shown and read as UTC.");
  return utc || !info.zone.length ? 'UTC' : zoneOffsets();
}
// The engine words its notes for the web page. Where one names something to click there, the argument to send says
// it here; and where one offers a reason for what the logs show, the reason is left out, as everywhere in this mode.
const bundleNotes = () => info.notes.map((n) => `Note: ${n.replace(', from daylight saving or a time zone change', '').replace('switch "Times in" to UTC for a steady clock', 'send utc: true for a steady clock').replace('they are listed under Files but cannot be searched here', `${tool('files')} lists them, but they cannot be read or searched`)}`);

// Text from the bundle in the text block: every character in it that would act, break a line, turn the text round or
// take no room is written by its number, as it is in a name (shown() and roomless(), in the text commands), and a tab
// and the parts of an emoji stay as they are. Left as it is, a carriage return or a line separator would start a line
// that this tool did not start, and the tag characters can spell out a sentence the model reads and a person does not
// see. visibleEach gives each character so written, one item for each, for text that is cut at a character.
const visibleEach = (s) => roomlessEach(s).map(shown);
const visible = (s) => visibleEach(s).join('');

// Text is kept within what one answer may hold by leaving out whole lines: from the end, or from the start when
// the end is what matters. Returns how many of the item lines stay.
function fit(head, items, fromStart) {
  let size = head.reduce((a, l) => a + l.length + 1, 0), kept = 0;
  const at = (k) => items[fromStart ? items.length - 1 - k : k];
  while (kept < items.length && size + at(kept).length <= TEXT_MOST) size += at(kept++).length + 1;
  return kept;
}

// The first line of a listing always stays, cut short if it has to be (and the heading with it, should that be
// what is long). A listing with no line in it would give a nextOffset equal to the offset that was sent, and a
// caller that follows it would ask for the same page again.
const HEAD_MOST = TEXT_MOST / 4;
function fitFirst(head, items) {
  const kept = fit(head, items);
  if (kept || !items.length) return kept;
  for (let i = 0; i < head.length; i++) head[i] = clipped(head[i], HEAD_MOST);
  items[0] = clipped(items[0], Math.max(0, TEXT_MOST - head.reduce((a, l) => a + l.length + 1, 0) - 1));
  note('The first line listed is longer than one result holds, so it was cut short.');
  return 1;
}

// One files call lists one page: the first `limit` (FILES_PAGE unless sent) of the files whose path contains its
// filter, and of those only as many lines as one result holds. A sentence that offers such a call to list some files
// says "a page at a time" when they would not all be on its first page.
const FILES_PAGE = 25, FILES_HEAD = `${'SIZE'.padStart(10)}  ${'TIMELINE_ENTRIES'.padStart(16)}  PATH`;
const fileRow = (x) => `${fmtBytes(x.size).padStart(10)}  ${(onTimeline(x) ? String(x.rows) : '-').padStart(16)}  ${visible(named(x.path))}`;
const filesFor = (filter) => info.files.filter((x) => !filter || x.path.toLowerCase().includes(filter.toLowerCase()));
const onOnePage = (hits) => hits.length <= FILES_PAGE && fit([FILES_HEAD], hits.map(fileRow)) >= hits.length;
const PAGED = 'a page at a time: send nextOffset as offset for the next page';
const FOLDER_WORDS = ['reports', 'office', 'unified_logs', 'system'];      // the folders a collector's bundle keeps most of its files in

// A refusal that gives candidates gives as many of the first `most` as fit, with the rest of the refusal, in what
// the facts of one result may hold, measured as they are handed over (asJson, as withinBudget measures a receipt).
// hintFor(n) is the hint for n candidates, which says how many are given.
function withCandidates(error, field, all, most, hintFor) {
  let n = Math.min(most, all.length);
  while (n > 1 && asJson({ error, field, hint: hintFor(n), candidates: all.slice(0, n) }).length > RECEIPT_MOST) n--;
  return new Refusal(error, field, hintFor(n), { candidates: all.slice(0, n) });
}

// ---------- refusals ----------
const noEntry = (field, id) => new Refusal('no such entry', field, `No entry has id ${id}. Entry ids in this bundle run from 0 to ${info.total - 1}. Copy an id from the ID column of ${tool('search')} or ${tool('context')}; do not guess one.`);
function needTimeline() {
  if (!info.total) throw new Refusal('this bundle has no timeline entries', undefined, `No file in bundle ${fromBundle(R.id)} is a log with timestamps this tool recognises, so there are no entries to show. ${call('files')} lists its files and ${tool('read_file')} reads one.`);
}
// The shell's refusals, worded again for a model. The option a refusal names becomes the argument that was sent.
function reworded(err) {
  const w = err.why, field = R.option[w.option] || String(w.option || '').replace(/^--/, '');
  // The example is the bundle's first time; a bundle with no entries has none, and no time is made up for it
  if (w.why === 'time') return new Refusal(`${field} is not a time`, field, `${quoted(w.value)} cannot be read as a time. ${info && info.total ? `Write ${field} the way results print times, for example "${timeLike()}" (YYYY-MM-DD HH:MM:SS; the` : `Write ${field} as YYYY-MM-DD HH:MM:SS (the`} seconds and the time of day are optional). It is read in ${w.zone}, unless it ends in Z or an offset such as -05:00.`);
  // The time of day that was sent, on a day the bundle covers: its last, which is where a crash is most often looked
  // for. The time is only digits, colons and a decimal point (parseTime took it for a time of day), so it is said as
  // it was sent.
  if (w.why === 'time-no-date') {
    const { first, last, span } = daysSaid();
    return new Refusal(`${field} has no date`, field, `This bundle covers more than one day (${span}), so ${field} needs a date. Write the day before the time that was sent, for example "${last} ${w.value}", with any day from ${first} to ${last}.`);
  }
  // A part that cannot be (a month 13, a minute 99): the example is what was sent with each such part brought into
  // range (outOfRange), which is read as it stands. What was sent is only digits and the few signs a time is written
  // with (parseTime took it for one), so it is said as it was sent.
  if (w.why === 'time-range') {
    const { first, last, span } = w.dayless ? daysSaid() : {};
    return new Refusal(`${field} ${w.lead}`, field, `${quoted(w.value)} was sent: ${w.bad.join('; ')}. Send ${field} ${w.lead.startsWith('has') ? 'with each part in range' : 'within the times this tool reads'}, for example "${w.like}".` +
      `${w.zone ? ` Without an offset it is read in ${w.zone}.` : ''}${w.dayless ? ` This bundle covers more than one day (${span}), so a time needs a date: any day from ${first} to ${last}.` : ''}`);
  }
  if (w.why === 'span') {
    const like = spanSaid(w.value);
    return new Refusal(`${field} is not a length of time`, field, `Send ${field} as a number and a unit in one string${like ? `, for example "${like}"` : ': "500ms", "30s", "2m", "1h" or "1d"'}. ${quoted(w.value)} was sent.`);
  }
  if (w.why === 'span-long') return new Refusal(`${field} is too long`, field, `Send ${field} as a length of time of at most ${SPAN_DAYS} days, as a number and a unit in one string, for example "1d". ${quoted(w.value)} was sent.`);
  if (w.why === 'around-with-span') {
    const around = R.option['--around'], span = absent(P.from) ? 'to' : 'from';
    return new Refusal(`${around} and ${span} cannot be used together`, around, `Send ${around} with window for everything around one moment, or from and to for a fixed span, not both.`);
  }
  if (w.why === 'window-alone') return new Refusal('window needs aroundId or aroundTime', 'window', `window is the length of time either side of aroundId or aroundTime, so send one of those with it. For a fixed span, leave window out and send from and to, written the way results print times.`);
  if (w.why === 'from-after-to') return new Refusal('from is not earlier than to', 'from', `from was read as ${timeSaid(w.from)} and to as ${timeSaid(w.to)}. Send a from that is earlier than to.`);
  if (w.why === 'severity') {
    // A level name (the LEVEL column of every listing) is said as the severity its entries are counted as; any other
    // word gets the nearest severity only when it is near one
    const names = SEV.map((s) => s.toLowerCase()), level = levelSaid(w.value, false), guess = level ? '' : nearName(w.value, names);
    return new Refusal('minSeverity is not a severity', 'minSeverity', `Send minSeverity as one of: ${names.join(', ')} (lowest to highest). ${quoted(w.value)} was sent.${level || (guess ? ` The nearest to it is ${guess}.` : levelSaid(w.value, true))}`);
  }
  if (w.why === 'no-entry') return noEntry(field, w.value);
  return err;
}
// An error nobody planned for is still answered, with the folders of this machine taken out of what it says.
function scrub(s) {
  const dir = (find) => { try { return find(); } catch (err) { return ''; } };      // this runs while an error is being reported, so it must not raise another
  for (const [d, label] of [[R.cacheDir, 'cache folder'], [R.bundlesDir, 'bundles folder'], [dir(cacheDir), 'cache folder'], [dir(os.tmpdir), 'temporary folder'], [dir(os.homedir), 'home folder']]) if (d && d.length > 1) s = s.split(d).join(`[${label}]`);
  return s.replace(/(^|[\s'"(=])\/(?:[^\s'"/]+\/)+[^\s'"]*/g, '$1[path]');
}

// ---------- bundles ----------
// A collector names a bundle Excel_Diagnostics_<mode>_<YYYYMMDD>_<HHMMSS>, with the date and time it started
// collecting on the logged Mac's clock (STAMP in the collector, taken after its questions and before it collects
// anything). Copying a file can add to the end of its name (" 2", " copy"), so anything may follow that is not
// another digit. A date that is not a real one is not taken for one. What an id records is the bundle's text, said
// as values: the mode as the id names it, and the time as the id writes it, with no zone.
const ID_TIME = /^Excel_Diagnostics_(collect|hang|repro|watch)_(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)(?!\d)/;
function idRecords(id) {
  const m = ID_TIME.exec(id);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(2).map(Number), t = Date.UTC(y, mo - 1, d, h, mi, s), back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return { mode: m[1], t, started: `${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}:${m[7]}` };
}
// Which bundle is the newest. A bundle copied in later is not one collected later, so the time in the id comes
// first: bundles whose id has one, by that time, latest first (two Macs' clocks are compared as written); then the
// others, by when their zip or folder last changed here, latest first. NEWEST_SAID says that rule where "newest" is said.
const NEWEST_SAID = 'by the date and time in the id, then by when it was copied here';
// A bundle is a folder in the bundles folder, or a zip there; its id is the name without ".zip". Newest first.
function bundlesIn(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Refusal('the bundles folder cannot be read', undefined, `The Excel diagnostics bundles folder on the OpenClaw host could not be read (${err.code || 'unknown error'}). Tell the human, and do not call these tools again until the human says it is fixed.`);
  }
  const found = new Map();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let st;
    // A link in the bundles folder is not a bundle: it could lead anywhere on this machine (unzipping a hostile zip
    // with another tool can leave one there)
    try { st = fs.lstatSync(path.join(dir, name)); } catch (err) { continue; }
    if (st.isSymbolicLink()) continue;

    const zip = st.isFile() && /\.zip$/i.test(name), id = zip ? name.replace(/\.zip$/i, '') : name, had = found.get(id);
    if ((!zip && !st.isDirectory()) || !id) continue;
    if (!had || (had.zip && !zip)) found.set(id, { id, file: path.join(dir, name), zip, mtime: st.mtimeMs, rec: idRecords(id) });      // a folder is used before a zip of the same id: there is nothing to unpack
  }
  return [...found.values()].sort((a, b) => (!!b.rec - !!a.rec) || (a.rec && b.rec ? b.rec.t - a.rec.t : 0) || b.mtime - a.mtime || (a.id < b.id ? 1 : -1));
}
// A bundle as availableBundles gives it: its id, to copy into bundle, and what the id records
const bundleSaid = (b) => ({ id: b.id, ...(b.rec ? { mode: b.rec.mode, startedLocal: b.rec.started } : {}) });
const idsSaid = (ids) => `${ids.slice(0, 10).map(fromBundle).join(', ')}${ids.length > 10 ? `, and ${ids.length - 10} more` : ''}`;
function pickBundle(list, want) {
  if (!list.length) {
    throw new Refusal('no bundles are available', undefined, 'Ask the human to copy an Excel_Diagnostics_....zip file, or the unzipped folder, into the Excel diagnostics bundles folder on the OpenClaw host. Do not call these tools again until the human says that is done.');
  }
  if (want === undefined) return list[0];
  const low = want.toLowerCase(), same = list.filter((b) => b.id === want), alike = same.length ? same : list.filter((b) => b.id.toLowerCase() === low);
  if (alike.length === 1) return alike[0];
  const hits = alike.length ? alike : list.filter((b) => b.id.toLowerCase().includes(low));
  if (hits.length === 1) { note(`bundle ${quoted(want)} was read as ${fromBundle(hits[0].id)}.`); return hits[0]; }
  if (hits.length) throw new Refusal('bundle matches more than one bundle', 'bundle', `${quoted(want)} is part of ${hits.length} bundle ids. Send one of the candidates, whole, as bundle.`, { candidates: hits.slice(0, 10).map((b) => b.id) });
  throw new Refusal('no such bundle', 'bundle', `No bundle id is or contains ${quoted(want)}. The bundles here, newest first (${NEWEST_SAID}): ${idsSaid(list.map((b) => b.id))}. Send one of these ids as bundle, or leave bundle out for the newest; do not guess an id.`);
}
async function openBundle(b, others) {
  const instead = others.length ? `Other bundles here: ${idsSaid(others)}. Send one of them as bundle.` : 'Ask the human to copy the bundle into the Excel diagnostics bundles folder again.';
  try { await open(b.file, true); } catch (err) {
    const why = err instanceof Usage && err.why ? err.why.why : '';
    const id = fromBundle(b.id);
    if (why === 'empty-bundle' || /^No files found/.test(String(err && err.message))) throw new Refusal('the bundle is empty', 'bundle', `Bundle ${id} holds no files. ${instead}`);
    if (why === 'no-bundle') throw new Refusal('the bundle is no longer there', 'bundle', `Bundle ${id} was removed while it was being opened. ${instead}`);
    // The zip unpacks to more than is unpacked here. Copying it in again would change nothing, and each call would
    // unpack up to the limit again before failing. A folder is read in place, with nothing to unpack.
    if (why === 'too-large') {
      throw new Refusal('the bundle is too large to unpack', 'bundle', `Bundle ${id} is a zip file that unpacks to more than ${err.why.limit} or more than 200,000 files and folders, so it was not unpacked. Tell the human that, and that the zip can be unzipped into the Excel diagnostics bundles folder, where a folder is read in place. ${others.length ? `Other bundles here: ${idsSaid(others)}. Send one of them as bundle.` : 'Do not call these tools again until the human says that is done.'}`);
    }
    toErr(`${err && err.stack ? err.stack : err}\n`);
    // What went wrong is passed on as it was reported. Why it went wrong is not guessed at: the human can look.
    const said = err && typeof err.code === 'string' ? `Bundle ${id} could not be read on the OpenClaw host (${err.code}). Tell the human that, with the code.`
      // A fixed sentence: the reader's own message can quote a name from inside the zip, written by whoever made
      // the zip, and this sentence is one the model acts on. The message itself went to standard error above.
      : `Bundle ${id} could not be read${b.zip ? ' as a zip file' : ''}. Tell the human that.`;
    throw new Refusal('the bundle could not be opened', 'bundle', `${said} ${instead}`);
  }
}

// ---------- the cache folder ----------
// A zip is unpacked once, into a folder named after the zip's size and date. Once the zip is replaced or removed
// that folder is of no use, and a run that was stopped while unpacking leaves a part-made folder behind; nothing
// else would ever delete either, and each can be as large as a bundle. They are cleared at the start of a request:
// only in the folder this request was told to unpack into, only folders this program made (one holds its marker,
// the other has its part-made name), and never through a link. Clearing that fails is not a reason to fail the call.
const PART_KEPT_MS = 60 * 60000;                          // a part-made folder newer than this may still be being written
function sweepCache(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return; }
  for (const name of names) {
    try {
      const full = path.join(dir, name), st = fs.lstatSync(full);
      if (!st.isDirectory()) continue;
      const part = /\.part-(\d+)$/.exec(name);
      if (part) {                                       // left by a run that is over (it was stopped while unpacking), or old
        let running = true;
        try { process.kill(+part[1], 0); } catch (err) { running = err.code === 'EPERM'; }
        if (!running || Date.now() - st.mtimeMs > PART_KEPT_MS) fs.rmSync(full, { recursive: true, force: true });
        continue;
      }

      const zip = fs.readFileSync(path.join(full, '.unpacked'), 'utf8').trim();      // no marker: not made here, so it stays
      let zst = null;
      try { zst = fs.statSync(zip); } catch (err) { if (err.code !== 'ENOENT') continue; }
      if (!zst || name !== unpackedName(zip, zst)) fs.rmSync(full, { recursive: true, force: true });
    } catch (err) { /* left as it is */ }
  }
}

// ---------- what the bundle records about its collection ----------
// What the collector wrote about this collection, read once in a request: the engine's labelled facts (facts()), the
// rows of manifest.tsv and of source_catalog.tsv, and the lines of unified_logs/collection_status.txt, one for each
// day of the macOS log search (and one for its access check), each line read whole, whatever it holds. Every value in
// them is the bundle's text: in a result it is a value in a list, cut short, and in a sentence it is quoted. The
// collector's mode is the one the bundle records (bundle_info.tsv, or summary.md from older collectors), and the one
// the bundle's id names only when it records none. Of each of the three files no more than RECORD_BYTES is read. A
// file longer than that ends inside a line where it was cut, and that part of a line is not a row: a row cut inside
// its status would be said to be one of a step that is not complete. So it is left out, and the file is named in
// cut, for the summary to say so.
// Of each, `read` says what read_file would make of it (shape): whether it is text to read_file (no zero byte in its
// first 4 KB, as fileLines() decides), how many lines it has when it was read whole, and what the first read_file
// call of it lists (firstRead).
const RECORD_BYTES = 1 << 20, MANIFEST = 'manifest.tsv', STATUS_FILE = 'unified_logs/collection_status.txt', CATALOG = 'source_catalog.tsv', DATE = /^\d{4}-\d\d-\d\d$/;
let recorded = null;
async function collection() {
  if (recorded) return recorded;
  const cut = [], shape = {};
  const read = async (p) => {
    const f = info.files.find((x) => x.path === p);
    if (!f || !f.size) return '';
    const got = await ds.fileChunk(f.i, 0, RECORD_BYTES), bytes = new Uint8Array(got.bytes), text = new TextDecoder().decode(bytes);
    const all = text.split(/\r?\n/);
    if (all[all.length - 1] === '') all.pop();
    const whole = got.size <= RECORD_BYTES;
    shape[p] = { text: !bytes.subarray(0, 4096).includes(0), whole, lines: all.length, ...firstRead(whole ? all : all.slice(0, text.endsWith('\n') ? all.length : all.length - 1), whole) };
    if (got.size <= RECORD_BYTES) return text;
    cut.push(p);
    return text.slice(0, text.lastIndexOf('\n') + 1);
  };
  const lines = (s) => s.split(/\r?\n/).filter((l) => l.trim());
  const facts = await ds.facts(), fact = (label) => facts.find((x) => x.label === label);
  const steps = lines(await read(MANIFEST)).map((l) => l.split('\t')).filter((c) => c.length >= 2 && !(c[0] === 'component' && c[1] === 'status'))
    .map(([step, status, ...rest]) => ({ step, status: status.trim(), detail: rest.join(' ').trim() }));
  const days = lines(await read(STATUS_FILE)).map((l) => /^(.+?) \| (.*)$/s.exec(l)).filter((m) => m && !(m[1] === 'Date' && m[2] === 'Status')).map((m) => ({ day: m[1], outcome: m[2] }));
  // source_catalog.tsv: a row for each place the collector looked for a source, with the source's name and what it
  // found there in its first two columns (found, missing, on, off, or its own longer words)
  const catalog = lines(await read(CATALOG)).map((l) => l.split('\t')).filter((c) => c.length >= 2 && !(c[0] === 'source' && c[1] === 'availability')).map(([source, availability]) => ({ source, availability: availability.trim() }));
  const mode = fact('Collector mode');
  return (recorded = { facts, steps, days, catalog, cut, shape, mode: mode && mode.path ? mode.value : collectorMode(R.id), modeFile: mode && mode.path ? mode.path : '', excel: fact('Excel'), running: fact('Excel running when the collector started') });
}
// A line of a file as read_file gives it: after its number, cut at READ_LINE_MOST characters, each character written
// as visible() writes it; and the lead line read_file puts above lines first to last when sent no grep.
const READ_LINE_MOST = 400;
const fileLineSaid = (line, i) => `${i + 1}: ${visible(clip(line, READ_LINE_MOST))}`;
const linesLead = (first, last) => (first === last ? `Line ${first} of the file, after its line number:` : `Lines ${first} to ${last} of the file, each after its line number:`);
// What the first read_file call of a file lists, from its lines known here (`whole`: every line of it; else only the
// whole lines of its start): the first LIST_LIMIT lines as read_file gives them, as many as fit in one result (fit),
// so that a sentence about that call says what it lists, however long its lines are once written. `kept` is exact when
// the lines that call is sent are all known and its lead line is known to the character; `cut` says some line it lists
// (or, when not exact, some line known) is longer than READ_LINE_MOST.
function firstRead(known, whole) {
  const first = known.slice(0, LIST_LIMIT), rows = first.map(fileLineSaid);
  const exactly = whole || first.length === LIST_LIMIT, kept = first.length ? fit([linesLead(1, exactly ? first.length : LIST_LIMIT)], rows) : 0;
  // when not every line it is sent is known, the lead line names a last line from first.length to LIST_LIMIT: of the
  // same width as LIST_LIMIT's from 10 on, so a count cut short within them is exact as well
  const exact = exactly || (kept < first.length && first.length >= 10);
  return { kept, exact, cut: (exact ? first.slice(0, kept) : first).some((l) => l.length > READ_LINE_MOST) };
}
// What one read_file call of a record file gives: `whole` when that is every line of it whole, else the lines it lists.
// Undefined when read_file would refuse it, as a file with a zero byte near its start, or there is no such file.
function readsSaid(c, p, whole) {
  const s = c.shape[p];
  if (!s || !s.text) return undefined;
  if (s.whole && s.kept === s.lines && !s.cut) return whole;
  const each = s.cut ? `, each to its first ${READ_LINE_MOST} characters` : '';
  if (!s.exact) return `reads at most its first ${LIST_LIMIT} lines${each}`;
  return `reads ${s.whole && s.kept === s.lines ? `its ${count(s.lines, 'line')}` : s.whole ? `the first ${s.kept} of its ${s.lines} lines` : `its first ${count(s.kept, 'line')}`}${each}`;
}
// Said where a record file is not text to read_file, in place of the call that would be refused
const notTextSaid = (p) => `${tool('read_file')} does not read ${p}: it has a zero byte in its first 4 KB, so it is not text.`;
const LISTED = 10;                                        // steps, and days of the macOS log search, a summary lists
const SUMMARY_REPORTS = 5, REPORT_LINE_MOST = 300;        // report files a summary lists, and the characters of each line it lists
const REPORTS_LISTED = LIST_LIMIT;                        // reports the reports call lists, the newest
// Whether reports with this report's path lays it out: its file is one the engine reads as a report (not a force-quit
// record, which is listed from lines of a file that is not one), its path can be offered as it is, and the engine
// reads it here (a bundle copied by hand can hold a report this account may not read).
const layable = async (x) => plainPath(x.path) && ds.isReport(x.path) && findReports(x.path).length === 1 && (await ds.report(x.path).then(() => true, () => false));
// Whether read_file reads this file as text: it has a byte, and no zero byte in its first 4 KB (fileLines)
async function textToRead(p) {
  const f = info.files.find((x) => x.path === p);
  if (!f || !f.size) return false;
  try { return !new Uint8Array((await ds.fileChunk(f.i, 0, 4096)).bytes).includes(0); } catch (err) { return false; }
}
// The list the reports call gives: the newest REPORTS_LISTED report files, oldest first, one line each, of which the
// newest `kept` fit in one result. The summary says from it how many that call lists.
function reportLines() {
  const all = info.reports.slice().sort((a, b) => a.t - b.t);
  sayReports(all.slice(-REPORTS_LISTED), true);
  const out = said();
  return { all, out, kept: fit(out.slice(0, 1), out.slice(1), true) };
}
// The summary's word for which collector wrote case/incident_context.md (Core.contextKind)
const CASE_KIND = { old: "partly an older collector's own wording", given: 'given when the collector was run', other: 'other' };
// The call that shows what was collected: the collector's own record of each day of its macOS log search when the
// bundle has one that read_file reads, else the summary, which gives what the bundle records about its collection.
async function collectedCall() {
  const reads = readsSaid(await collection(), STATUS_FILE, 'reads what it records for each day of the macOS log search');
  return reads ? [call('read_file', { path: STATUS_FILE }), reads] : [call('summary'), 'shows what this bundle holds and what it records about its collection'];
}

// The spans the macOS log in this bundle covers (marks() in the engine: what is shown to be covered, and nothing
// more), and whether the bundle looked for that log at all. A bundle that never did, such as loose log files, is not
// said to be without it.
let covered = null;
const macosCover = () => (covered ??= ds.marks().then((m) => ({ searched: !!m.searched, spans: m.cover.unified })));
// The parts of the span t0 up to t1 that the macOS log in this bundle does not cover. A span covers from its first
// entry to its last, both included, so the moment of its last entry is covered, and a span of one entry covers that
// moment. Spans less than a second apart are one in the engine, so a part shorter than a second is not one, unless the
// span asked about itself is (a moment); and a part after a span starts at the next whole second, so that the time it
// is said to start at is one the span does not cover.
async function notCovered(t0, t1) {
  const c = await macosCover(), out = [], least = Math.min(1000, t1 - t0);
  if (!c.searched) return out;
  let at = t0;
  for (const [a, b] of c.spans) {
    if (b < at) continue;
    if (a >= t1) break;
    if (a - at >= least) out.push([at, a]);
    at = Math.max(at, Math.ceil((b + 1) / 1000) * 1000);
  }
  if (t1 - at >= least) out.push([at, t1]);
  return out;
}
// A fact for a time window that is wholly or partly outside the macOS log in this bundle (moment: the one time a
// context call was centred on): the part it does not cover, then what the collector recorded for each day of its
// search that the part falls in, as it wrote it, and for each line that names no day (its access check). The days are
// the Mac's own, as the collector named them. Each day's span is worked out once and the parts it meets are found by
// halving (they are in order, apart): a status file can hold a great many lines, and a bundle a great many parts.
async function coverNotes(t0, t1, moment) {
  const gaps = await notCovered(t0, t1);
  if (!gaps.length) return [];
  const c = await collection(), spanOf = new Map();
  const day = (d) => { let r = spanOf.get(d); if (!r) { const start = Core.isoAt(`${d} 00:00:00`, 0); spanOf.set(d, (r = [ds.localToUtc(start), ds.localToUtc(start + 86400000)])); } return r; };
  const meets = ([s, e]) => {
    let lo = 0, hi = gaps.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (gaps[mid][1] > s) hi = mid; else lo = mid + 1; }      // the first part that ends after s
    return lo < gaps.length && gaps[lo][0] < e;
  };
  // a part that starts where the window starts starts at the time that was sent, said with its milliseconds when it has
  // them, as the moment asked is
  const end = (x) => (x === t0 ? timeAsked(x) : timeSaid(x));
  const spans = gaps.slice(0, 3).map(([a, b]) => `from ${end(a)} to ${end(b)}`).join(', ') + (gaps.length > 3 ? `, and ${count(gaps.length - 3, 'more span')}` : '');
  const said = moment ? `The macOS log in this bundle does not cover ${timeAsked(t0)}, the time asked.`
    : gaps.length === 1 && gaps[0][0] === t0 && gaps[0][1] === t1 ? 'The macOS log in this bundle covers none of this time window.'
      : `The macOS log in this bundle does not cover part of this time window: ${spans}.`;
  const days = c.days.filter((d) => !DATE.test(d.day) || meets(day(d.day)));
  if (!days.length) return [said];
  const each = days.slice(0, 3).map((d) => (DATE.test(d.day) ? `for ${d.day}: ${fromBundle(d.outcome)}` : `in its line ${fromBundle(d.day)}: ${fromBundle(d.outcome)}`));
  return [`${said} ${STATUS_FILE} records ${each.join('; ')}${days.length > 3 ? `; and it has ${count(days.length - 3, 'more such line')}, each for a day of that part or for no day` : ''}.`];
}
// What the bundle records that bears on a call finding none of something: the collector's mode, the rows of
// manifest.tsv that are not complete for the steps that collect it, and what bundle_info.tsv records of Excel. Each
// is said as what the bundle records, never as the reason. Excel's state is said for reports only of a hang capture,
// which is of Excel running then; the reports of a collect run are the Mac's own, from before.
// The steps are named as the collector names them: office is the step that writes office/excel_memory.txt.
const STEPS_OF = { reports: ['reports', 'hang_capture'], memory: ['system', 'office', 'hang_capture', 'watch', 'repro'], excel: ['unified_logs', 'unified_last30m', 'office', 'hang_capture'] };
async function recordedAbout(what) {
  const c = await collection(), out = [], hang = c.mode === 'hang';
  if (what === 'reports' && hang) out.push(`${c.modeFile ? `${c.modeFile} records` : "The bundle's id names"} hang as the collector's mode, and in hang mode the collector copies none of the Mac's report files.`);
  const rows = c.steps.filter((x) => x.status !== 'complete' && STEPS_OF[what].some((name) => x.step === name || (name === 'repro' && x.step.startsWith('repro'))));
  for (const x of rows.slice(0, 3)) out.push(`manifest.tsv records the step ${fromBundle(x.step)} as ${fromBundle(x.status)}${x.detail ? `, with: ${fromBundle(x.detail)}` : ''}.`);
  if (rows.length > 3) out.push(`manifest.tsv records ${count(rows.length - 3, 'more such step')} as not complete.`);
  if (what !== 'reports' || hang) {
    if (c.excel && c.excel.path === 'bundle_info.tsv' && /^not found\b/.test(c.excel.value)) out.push(`bundle_info.tsv records Excel as ${fromBundle(c.excel.value)}.`);
    if (c.running && c.running.value === 'no') out.push('bundle_info.tsv records "no" for excel_running: whether a process of the console user\'s ran Excel when the collector started.');
  }
  return out;
}
// A search for an Excel process: a process field whose value holds "excel" (not one left out with a minus sign)
const EXCEL_PROCESS = /(?:^|\s)process:(?:"[^"]*excel|[^\s"]*excel)/i;

// ---------- what search, count and histogram share ----------
// Their filter arguments, checked, and turned into the options the text commands take. `same` is the arguments as
// they would be sent again, for the calls a result suggests.
// A search looks for each term of its query in every entry it reads, so a query of many terms takes long on a large
// bundle: no more than QUERY_TERMS_MOST are taken, counted as the engine reads them (Core.queryTerms: a phrase in
// quotation marks is one term, however many words it holds), and no query longer than QUERY_CHARS_MOST characters.
// A query offered in a result is offered only when it is one these take (queryFits).
const QUERY_TERMS_MOST = 100, QUERY_CHARS_MOST = 10000;
const TERM_SAID = 'A term is a word, a phrase in quotation marks, a /regex/ or a field such as process:excel, with a minus before it or not.';
const queryFits = (q) => [...String(q || '')].length <= QUERY_CHARS_MOST && Core.queryTerms(q || '') <= QUERY_TERMS_MOST;
function filters() {
  const sent = text('query') || '', chars = [...sent].length;
  if (chars > QUERY_CHARS_MOST) throw new Refusal('query is too long', 'query', `Send query with at most ${fmtN(QUERY_CHARS_MOST)} characters; ${fmtN(chars)} were sent.`);
  const terms = Core.queryTerms(sent);
  if (terms > QUERY_TERMS_MOST) throw new Refusal('query has too many terms', 'query', `Send query with at most ${QUERY_TERMS_MOST} terms; ${terms} were sent. ${TERM_SAID}`);
  const f = { query: text('query') || '', from: text('from', timeLike()), to: text('to', timeLike()), aroundId: whole('aroundId', 0),
    aroundTime: text('aroundTime', timeLike()), window: text('window', spanLike), minSeverity: text('minSeverity', 'error'), matchCase: flag('matchCase') };
  if (f.aroundId !== undefined && f.aroundTime !== undefined) throw new Refusal('aroundId and aroundTime cannot be used together', 'aroundTime', 'Send aroundId to centre the window on an entry, or aroundTime to centre it on a time, not both.');
  R.option['--around'] = f.aroundId !== undefined ? 'aroundId' : 'aroundTime';
  if (info.total) {
    if (f.aroundId !== undefined && f.aroundId > info.total - 1) throw noEntry('aroundId', f.aroundId);
    if (f.aroundTime !== undefined) parseTime(f.aroundTime, '--around');      // refused here, or a time made only of digits would be taken for an entry id below
  }
  f.o = { from: f.from, to: f.to, around: f.aroundId !== undefined ? String(f.aroundId) : f.aroundTime, window: f.window, 'min-severity': f.minSeverity, case: f.matchCase };
  f.same = { query: f.query || undefined, from: f.from, to: f.to, aroundId: f.aroundId, aroundTime: f.aroundTime, window: f.window, minSeverity: f.minSeverity, matchCase: f.matchCase || undefined };
  return f;
}
// Runs the search and starts the receipt with how the call was read, so the model can see it: the search text as
// the engine took it, the window, the severity floor, then how many of how many matched.
async function matched(f) {
  if (!info.total) return { r: { count: 0 }, receipt: { query: f.query, matched: 0, total: 0 } };      // nothing to search, and nothing to check a time or an id against
  const { q, said: read } = await buildQuery(f.o, f.query);
  // a span the caller chose for a call that was sent none (the histogram's main period), in place of the whole period
  if (f.span) { [q.t0, q.t1] = f.span; read.window = `from ${fmtTime(q.t0)} to ${fmtTime(q.t1)}`; }
  const r = await ds.query(q, () => {});
  // A note about a field value that names nothing lists, for the page, the names the bundle does have. Here the
  // note is the engine's sentence without that list (plain), and the call that lists the names takes its place.
  for (const n of notesFor(r, !r.count)) {
    const names = n.plain !== undefined ? n.names : countable(n) ? n.field : null;
    note(`${n.plain !== undefined ? n.plain : n.text}${names ? ` ${call('count', { by: names })} lists every ${names}.` : ''}${names === 'source' ? ` source: also matches the path of a log file; ${call('count', { by: 'file' })} lists those.` : ''}`);
  }
  // A time window with no macOS log in part of it holds no entries from that log there, whatever was logged on the Mac.
  // A side left open runs to the bundle's own first or last time.
  if (read.cut) note(`The time window ${windowCutSaid(q.t0, q.t1, (t) => timeSaid(t))}.`);
  if (q.t0 != null || q.t1 != null) {
    const gaps = await coverNotes(q.t0 != null ? q.t0 : info.t0, q.t1 != null ? q.t1 : info.end + 1);
    gaps.forEach(note);
    R.uncovered = gaps.length > 0;
  }
  const receipt = { query: q.text };
  if (q.t0 != null) receipt.from = fmtTime(q.t0, false);
  if (q.t1 != null) receipt.to = fmtTime(q.t1, false);
  if (f.minSeverity) receipt.minSeverity = f.minSeverity.toLowerCase();
  if (f.matchCase) receipt.matchCase = true;
  receipt.matched = r.count; receipt.total = r.total;
  return { q, r, read, receipt };
}
// Nothing matched. That is an answer, not a failure: say how many entries match with each condition taken away in
// turn, which shows the one that ruled them out, and offer the call without it.
async function nothing(op, f, q, r, read, receipt) {
  const without = (t) => (t.window !== undefined ? 'the time window' : t.sev ? 'minSeverity' : t.cs ? 'matchCase' : `the query term ${t.term}`);
  const tries = info.total ? await countWithout(q, r, read) : [], hit = tries.find((t) => t.count > 0), steps = [];
  if (!info.total) note('This bundle has no timeline entries: no file in it is a log with timestamps this tool recognises.');
  else if (tries.length) {
    receipt.withoutEach = tries.map((t) => ({ without: without(t), matched: t.count }));
    if (!hit) note('Taking away any one condition still leaves no entries, so more than one condition is ruling entries out. A call with fewer conditions shows which.');
  } else if (onlyTerm(r)) note(`No entry in this bundle contains ${onlyTerm(r)}. A word is looked for anywhere in an entry, and capitals are ignored unless matchCase is true.`);
  if (EXCEL_PROCESS.test(f.query)) (await recordedAbout('excel')).forEach(note);
  if (info.total) receipt.timeZone = zone();
  if (hit) {
    const a = { ...f.same };
    // without its window, a call that was sent none is sent the whole period: sent nothing, it would take the same span again
    if (hit.window !== undefined) { for (const k of ['from', 'to', 'aroundId', 'aroundTime', 'window']) delete a[k]; Object.assign(a, f.whole); }
    else if (hit.sev) delete a.minSeverity;
    else if (hit.cs) delete a.matchCase;
    else a.query = hit.text || undefined;
    // When the window is what ruled entries out and the bundle has no macOS log for part of it, the entries found
    // without it are from other times. What was collected for that window comes first.
    if (hit.window !== undefined && R.uncovered) steps.push(await collectedCall());
    steps.push([call(op, a), `is this call without ${without(hit)}, which ${hit.count === 1 ? '1 entry matches' : `${hit.count} entries match`}`]);
  }
  if (!steps.some(([c]) => c.startsWith(`${tool('summary')} `))) steps.push(info.total ? [call('summary'), 'shows what this bundle holds'] : [call('files'), 'lists the files in this bundle']);
  return { receipt, next: nextSaid(steps) };
}
// Entries for a listing: each message on one line, cut to maxChars. An entry longer than a listing reads is read
// again whole, so that the count of characters left out is the true one.
async function listed(positions, maxChars) {
  const rows = [];
  for (const got of await ds.readRows(positions, ENTRY_BYTES)) {
    const r = (got.row[10] ? (await ds.row(got.row[0])).row : got.row).slice();
    r[9] = clip(flat(r[9]), maxChars); r[10] = 0;
    rows.push(r);
  }
  return rows;
}

// ---------- the shape of a message ----------
// by: "message" groups entries by the shape of their message (Core.messageShape, where the rule is written). Every
// entry grouped is read for it, so the work is bounded: one call groups no more than GROUP_MOST entries, GROUP_BYTES
// of them as read (each read to its first SHAPE_ENTRY_BYTES at most) or GROUP_SHAPES different shapes. Entries are
// grouped oldest first, so when a bound is met the ones grouped are the first ones matched, each of them counted, and
// the result says how many that was (cutSaid). A shape is the bundle's text: a value in a list, never a key and never
// a word of a sentence.
const GROUP_MOST = 200000, GROUP_BYTES = 96 << 20, GROUP_SHAPES = 50000, SHAPE_ENTRY_BYTES = 16 << 10;
async function shapesOf(view) {
  const by = new Map(), end = Math.min(view.length, GROUP_MOST), G = ds.g, S = ds.sources;
  let grouped = 0, bytes = 0, stop = '';
  for (let k = 0; k < end && !stop; k += 1024) {
    for (const got of await ds.readRows(Array.from(view.subarray(k, Math.min(end, k + 1024))), SHAPE_ENTRY_BYTES)) {
      if (bytes >= GROUP_BYTES) { stop = `${GROUP_BYTES >> 20} MB of entries`; break; }
      const r = got.row, shape = Core.messageShape(r[9]);
      let g = by.get(shape);
      if (!g) {
        if (by.size >= GROUP_SHAPES) { stop = `${GROUP_SHAPES} different shapes`; break; }
        by.set(shape, (g = { value: shape, entries: 0, firstId: r[0], first: r[1], last: r[1] }));
      }
      // counted in bytes as read from the file, which is what the bound says: an entry of characters that take more
      // than one byte each is longer in bytes than as text
      g.entries++; g.last = r[1]; grouped++; bytes += Math.min(S[G.F[r[0]]].len[G.R[r[0]]], SHAPE_ENTRY_BYTES);
    }
  }
  if (!stop && grouped < view.length) stop = `${GROUP_MOST} entries`;
  const list = [...by.values()].sort((a, b) => b.entries - a.entries || a.firstId - b.firstId)
    .map((g) => ({ value: g.value, entries: g.entries, firstId: g.firstId, firstTime: fmtTime(g.first, false), lastTime: fmtTime(g.last, false) }));
  return { list, grouped, stop, after: grouped < view.length ? view[grouped] : -1 };
}
// What a bound that cut the grouping says, of `what` (the entries matched, or the errors and faults), and which part
// of the result counts only the entries grouped (`where`, with its verb).
const cutSaid = (g, total, what, where) => `Of the ${total} ${what}, the oldest ${g.grouped} were grouped: one call groups no more than ${g.stop}. ${where} those ${g.grouped} only.`;
// What a call that groups `n` entries by message is said to do where a result offers it. It groups all of them when no
// bound can be met first: no more entries than the byte bound lets through when each is read at its longest. Past
// that a bound is met, or not, only as the entries are read, so the call is said to group as many as it can.
const GROUPED_WHOLE = Math.min(GROUP_MOST, GROUP_SHAPES, Math.floor(GROUP_BYTES / SHAPE_ENTRY_BYTES));
const groupsSaid = (n, what) => (n <= GROUPED_WHOLE ? `groups all ${n} ${what} by the shape of their message`
  : `groups the ${n} ${what} by the shape of their message, oldest first, as many as one call can`);

// The intervals a span is counted in, as the histogram counts them: each a whole number of seconds long from a whole
// second, at most `bins` of them from lo up to hi, so that the times printed are the real boundaries and a search from
// one to the next returns the entries counted between them. The last runs to t1 when the span has a set end.
function intervalsOf(lo, hi, t1, bins) {
  const h0 = Math.floor(lo / 1000) * 1000, step = Math.max(1, Math.ceil((hi - h0) / bins / 1000)) * 1000, nb = Math.max(1, Math.ceil((hi - h0) / step));
  const end = t1 != null ? t1 : h0 + nb * step;
  const start = (b) => h0 + b * step, stop = (b) => Math.min(h0 + (b + 1) * step, end);
  return { h0, step, nb, end, at: (t) => Math.min(nb - 1, Math.max(0, Math.floor((t - h0) / step))), start, stop,
    from: (b) => fmtTime(start(b), false), to: (b) => fmtTime(stop(b), false) };
}
const errorLevels = () => info.lvlSev.reduce((a, sv, v) => (sv >= 4 ? a.concat(v) : a), []);

// ---------- one report, laid out ----------
// reports with a path lays one report out as the engine reads it (readReport, which the page's Reports tab shows):
// its labelled facts as "Label: value" lines, the stack the report itself singles out with the image of each frame,
// and how many threads and images it lists, which are among the facts. The labels are the engine's words; every value
// is the report's own text, on one line and cut short, after a label of this tool's, so none starts a line. The text
// stays near REPORT_TEXT characters: the facts take up to FACTS_TEXT of it, then up to FRAMES_MOST lines of the stack.
// How many threads, images and processes the report lists are kept however many other facts are left out. Every value
// is said the way a name is said on a line of this tool's (named), and a character in it that would act, turn the
// line round or take no room is written by its number (shown): these lines are this tool's, not the file's own.
const REPORT_TEXT = 3800, FACTS_TEXT = 2000, FRAMES_MOST = 40, VALUE_MOST = 100, FRAME_MOST = 120;
const COUNTED = new Set(['Threads in the report', 'Images listed', 'Threads in the part read', 'Images listed in the part read', 'Processes listed']);
const oneLine = (s, most) => clipped(shown(named(String(s))).trim(), most);
// The report files a typed path can mean, by the rule read_file finds a file by (findFiles), among the reports alone;
// one path once, though a file can give more than one report (a force-quit record can hold several).
function findReports(typed) {
  const want = typed.replace(/^\.?\//, ''), seen = new Set(), all = info.reports.filter((x) => !seen.has(x.path) && seen.add(x.path));
  const exact = all.filter((x) => x.path === want);
  if (exact.length) return exact;
  const byName = all.filter((x) => baseOf(x.path) === want);
  return byName.length === 1 ? byName : all.filter((x) => x.path.toLowerCase().includes(want.toLowerCase()));
}
async function laidOut(typed) {
  const seen = new Set(), newest = info.reports.slice().sort((a, b) => b.t - a.t).map((x) => x.path).filter((p) => !seen.has(p) && seen.add(p));
  if (!newest.length) throw new Refusal('this bundle has no report files', 'path', `Bundle ${fromBundle(R.id)} holds no crash, hang or other report file, so there is none to lay out. ${call('files')} lists its files and ${tool('read_file')} reads one.`);
  const hits = findReports(typed);
  if (!hits.length) {
    const file = findFiles(typed), other = file.length === 1 ? file[0] : null;
    throw withCandidates(other ? 'path is not a report file' : 'no such report file', 'path', newest, 10, (n) => `${other ? `The file ${fromBundle(other.path)} is not one of the report files ${tool('reports')} lists; ${tool('read_file')} reads its lines.`
      : `No report file in this bundle has ${quoted(typed)} as its path, as its name or as part of its path.`} Send one of the candidates, whole, as path: ${n < newest.length ? `the ${n} newest of the ${newest.length} report files` : n === 1 ? 'the one report file' : `the ${n} report files, newest first`}. Do not guess one.`);
  }
  if (hits.length > 1) {
    // The candidates newest first, as the reports call lists them; that call is said to list them all only when every
    // one of them is among the ones it lists (the newest REPORTS_LISTED, as many as fit)
    const paths = new Set(hits.map((x) => x.path)), ordered = newest.filter((p) => paths.has(p)), { all, kept } = reportLines();
    const listed = new Set(all.slice(-REPORTS_LISTED).slice(all.slice(-REPORTS_LISTED).length - kept).map((x) => x.path)), every = ordered.every((p) => listed.has(p));
    throw withCandidates('path matches more than one report file', 'path', ordered, 20, (n) => `${quoted(typed)} is part of ${hits.length} report paths. Send one of the candidates, whole, as path.${n < hits.length ? ` The ${n} newest are given; ${every ? `${call('reports')} lists them all` : 'send more of the path to match fewer of them'}.` : ''}`);
  }
  // A file can give more than one report (a force-quit record holds one for each time it records): the one laid out
  // here is the newest of them, as the reports call lists it, and the result says how many there are.
  const mine = info.reports.filter((r) => r.path === hits[0].path).sort((a, b) => a.t - b.t || (a.pos ?? 0) - (b.pos ?? 0)), x = mine[mine.length - 1];
  // the path a suggested read_file gives this file by: one that finds this file and no other
  const again = [x.path, typed].find((p) => plainPath(p) && findFiles(p).length === 1 && findFiles(p)[0].path === x.path);
  if (x.path !== P.path) note(`path ${quoted(P.path)} was read as ${fromBundle(x.path)}.`);
  if (mine.length > 1) note(`This file gives ${mine.length} reports on the timeline, from ${timeSaid(mine[0].t)} to ${timeSaid(x.t)}: time and id are those of the newest.`);
  // read_file reads a file only when it has a line of text: not when it is empty, and not when it has a zero byte
  // near its start (fileLines), so it is offered for neither
  const file = info.files.find((f) => f.path === x.path), empty = !file || !file.size;
  let binary = false;
  // A bundle copied by hand can hold a file this account may not read: refused as read_file refuses it, by its path.
  const unread = (err) => new Refusal('the file cannot be read', 'path', `The file ${fromBundle(x.path)} could not be opened on the OpenClaw host (${err.code}). Tell the human, or choose another report from ${tool('reports')}.`);
  try { binary = !empty && new Uint8Array((await ds.fileChunk(file.i, 0, 4096)).bytes).includes(0); } catch (err) { if (err && typeof err.code === 'string') throw unread(err); throw err; }
  let d;
  try { d = await ds.report(x.path); } catch (err) {
    if (err && typeof err.code === 'string') throw unread(err);
    // Whatever else stops the engine reading it, the file is still there to read line by line
    toErr(`${err && err.stack ? err.stack : err}\n`);
    const reader = again ? call('read_file', { path: again }) : tool('read_file');
    throw new Refusal('the report could not be laid out', 'path', `This tool could not lay out the report file ${fromBundle(x.path)}. ${empty || binary ? `The file is not text, so ${tool('read_file')} cannot read it either.` : `${reader} reads the file's own lines, each after its line number.`}`);
  }
  const receipt = { path: x.path, kind: clipped(x.kind, 40), process: clipped(x.proc || '', 80), time: fmtTime(x.t, false), id: x.pos, bytes: d.size };
  const out = [], size = () => out.reduce((n, l) => n + l.length + 1, 0), facts = d.facts, stack = d.stack;
  let cut = false;
  // The facts in the report's order, as many as FACTS_TEXT holds after the counts, which always stay
  const lines = facts.map(([label, value]) => `${label}: ${oneLine(value, VALUE_MOST)}`), keep = facts.map(([label]) => COUNTED.has(label));
  let room = FACTS_TEXT - lines.reduce((n, l, k) => n + (keep[k] ? l.length + 1 : 0), 0);
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) continue;
    if (lines[k].length + 1 > room) break;              // this fact and the others after it are left out; a count after them stays
    keep[k] = true; room -= lines[k].length + 1;
  }
  out.push(...lines.filter((_, k) => keep[k]));
  if (out.length < facts.length) { cut = true; receipt.factsLeftOut = facts.length - out.length; out.push(`(${count(facts.length - out.length, 'more fact')} left out)`); }
  if (stack) {
    // A JSON report gives its frames as fields: the frame's number, its image, its symbol and offset, its source.
    // A text report gives the stack as lines, each with its image in it, and they are its own lines (empty ones left out).
    const rows = stack.frames ? stack.frames.map((fr, k) => `${String(k).padStart(3)}  ${oneLine(fr.image, 40)}  ${oneLine([fr.symbol, fr.offset].filter(Boolean).join(' '), 70)}${fr.source ? `  ${oneLine(fr.source, 40)}` : ''}`)
      : stack.lines.filter((l) => l.trim()).map((l) => `  ${oneLine(l.replace(/[\t ]+/g, ' '), FRAME_MOST)}`);
    const total = rows.length + stack.more, unit = stack.frames ? 'frame' : 'line';
    out.push(`Stack: ${oneLine(stack.title, 120)}`);
    let n = 0;
    while (n < Math.min(rows.length, FRAMES_MOST) && size() + rows[n].length + 1 <= REPORT_TEXT - 60) out.push(rows[n++]);
    if (n < total) { cut = true; out.push(`(${count(total - n, `more ${unit}`)} of this stack ${total - n === 1 ? 'is' : 'are'} in the file)`); }
    Object.assign(receipt, { stackLines: total, stackLinesShown: n });
  }
  const what = [facts.length && 'facts this tool reads in it', stack && 'the stack the report itself singles out'].filter(Boolean);
  const readable = !empty && !binary, reader = again ? call('read_file', { path: again }) : tool('read_file');
  const reads = readable ? `${reader} reads the file's own lines, each after its line number.` : `The file is not text, so ${tool('read_file')} cannot read it${what.length ? '' : ' either'}.`;
  note(what.length ? `These lines are this tool's layout of the report, not the file's own lines: ${what.join(', and ')}. ${reads}`
    : empty ? 'This file is empty, so there is nothing in it to lay out.' : `This tool finds nothing in this file that it lays out. ${reads}`);
  if (d.headerOnly) note(`This report is ${fmtBytes(d.size)}, more than this tool reads of one report, so only its first line is laid out.`);
  else if (d.read < d.size) note(`Only the first ${fmtBytes(d.read)} of this report was read, so what is laid out here is of that part.`);
  receipt.truncated = cut || d.headerOnly || d.read < d.size;
  receipt.timeZone = zone();
  const steps = [];
  if (info.total && x.pos !== undefined) steps.push([call('context', { id: x.pos }), "lists what every source logged just before and after this report's own entry"]);
  if (again && readable) steps.push([call('read_file', { path: again }), "reads the file's own lines"]);
  return { receipt, text: out.join('\n') || undefined, next: nextSaid(steps) };
}

// ---------- one message, printed ----------
// show prints the message with each of its lines after two spaces (INDENT), so that no line of it starts where a line
// of this tool's does: a message is whatever was logged, and it can hold lines that read "Next:", "- Fact:" or a JSON
// result. Every kind of line break ends a line, and each character is written as visible() says. The message is cut
// at maxChars, never through a character, and also where what is printed would be more than one answer's text
// (SHOWN_MOST): many short lines, or characters written by their numbers, print longer than the message is. A cut
// ends in how many characters were left out; `full` says the second cut was made. The receipt says how the lines are
// printed (MESSAGE_PRINTED), so that the two spaces are not taken for the message's own.
const INDENT = '  ', SHOWN_MOST = TEXT_MOST - 60, LINE_ENDS = new RegExp(BREAKS.source, 'g');
const MESSAGE_PRINTED = 'each line of the message after two spaces that are not part of it';
function messagePrinted(msg, maxChars) {
  if (!msg) return { text: '', shown: 0, full: false };
  let end = Math.min(msg.length, maxChars);
  if (end < msg.length && msg.charCodeAt(end - 1) >= 0xD800 && msg.charCodeAt(end - 1) <= 0xDBFF) end--;      // not through the middle of a character
  const lines = [];
  let size = 0, at = 0, full = false;
  for (;;) {
    // A line left out is where the cut is said. The empty line after a break the message ends with always has room:
    // SHOWN_MOST is below what one answer's text may be by more than it takes.
    if (size + INDENT.length > SHOWN_MOST && at < end) { full = true; lines.push(INDENT); break; }
    LINE_ENDS.lastIndex = at;
    const m = LINE_ENDS.exec(msg), stop = m && m.index < end ? m.index : end, chars = [...msg.slice(at, stop)], each = visibleEach(chars.join(''));
    let line = INDENT, k = 0;
    while (k < chars.length && size + line.length + each[k].length <= SHOWN_MOST) { line += each[k]; at += chars[k].length; k++; }
    lines.push(line);
    size += line.length + 1;
    if (k < chars.length) { full = true; break; }
    if (stop === end) break;
    at = stop + m[0].length;                            // past the line break
  }
  return { text: lines.join('\n') + (at < msg.length ? `${MORE}[${msg.length - at} more characters]` : ''), shown: Math.min(at, msg.length), full };
}

// A word that the name of every memory file of a kind holds, to filter the list of files by.
const MEMORY_FILTER = { timeline: 'excel_memory_timeline', snapshot: 'memory', excelMemory: 'excel_', jetsamReport: 'JetsamEvent' };

// ---------- the memory timeline at a moment ----------
// A sample of the memory timeline as the memory call lists it: its time on the receipt's clock (at), then the value of
// each column the collector writes whose meaning this tool knows, under that column's name (camel(), as the figures
// of the timeline are named). The names are this tool's, not the file's: a column it does not know is not given, and
// an empty cell gives no field. A value that is not a number is the file's text, cut short.
const SAMPLE_COLUMNS = ['excel_pid', 'excel_cpu_pct', 'excel_footprint_mb', 'excel_compressed_mb', 'excel_threads', 'pressure_level', 'free_mb', 'compressor_mb', 'swap_used_mb'];
const SAMPLES_EITHER_SIDE = 3, SAMPLES_MOST = 12, PRESSURE_SPANS = 6;
// A cell written as a decimal number is that number; any other (0x10, 1e999, Infinity, words) is the file's text, cut
// short, so that what is given is what the file holds and not a reading of it
const cellSaid = (v) => (DECIMAL.test(v) ? +v : clipped(v, 40));      // the figures of the timeline (memoryTimeline) take the same numbers
function sampleSaid(m, at, d) {
  const o = { time: at(d) };
  for (const c of SAMPLE_COLUMNS) {
    const j = m.col(c), v = j < 0 ? '' : String(d[j] ?? '').trim();
    if (v) o[camel(c)] = cellSaid(v);
  }
  return o;
}
// For each pressure level the timeline records: its number, the name macOS gives it, how many samples have it, and
// when it was seen: each run of samples in a row at that level, from the first sample of the run to the last (so a
// run of one sample is from and to one time). At most PRESSURE_SPANS runs of each level are listed. When there are
// more, they are the first ones; or, when a time or a span was asked (start, its time or its start), the first that
// end at or after it, and the last ones when none does. seenNotListed counts the others. A sample with no level ends a run.
function pressureSeen(m, at, T, start) {
  const lv = m.col('pressure_level'), runs = new Map();
  let cur = null;
  m.data.forEach((d, j) => {
    const v = d[lv];
    if (!v) { cur = null; return; }
    if (cur && cur.v === v) { cur.b = j; cur.n++; return; }
    cur = { v, a: j, b: j, n: 1 };
    if (!runs.has(v)) runs.set(v, []);
    runs.get(v).push(cur);
  });
  return m.levels.map((v) => {
    const all = runs.get(v) || [], after = start === undefined || all.length <= PRESSURE_SPANS ? 0 : all.findIndex((r) => T[r.b] >= start), from = after < 0 ? all.length - PRESSURE_SPANS : after;
    const shown = all.slice(from, from + PRESSURE_SPANS), o = { level: cellSaid(String(v).trim()), name: Object.hasOwn(PRESSURE, v) ? PRESSURE[v] : 'unknown', samples: all.reduce((a, r) => a + r.n, 0) };
    o.seen = shown.map((r) => ({ from: at(m.data[r.a]), to: at(m.data[r.b]) }));
    if (shown.length < all.length) o.seenNotListed = all.length - shown.length;
    return o;
  });
}

// ---------- the operations ----------
const OP = {
  // The first look at a bundle, so that one call answers the usual first questions: what it holds and over what
  // time, its report files (the newest, the newest crash, hang or spin report of Microsoft Excel first), the interval
  // with the most errors and faults, the shapes of message most of those have, the process IDs Excel logged under,
  // and what the bundle records about its collection (the sources it did not find among it). Counts, times and
  // recorded values only. The list of log sources is one call away (count by file).
  async summary() {
    const c = await collection(), receipt = { bundle: R.id }, steps = [];
    if (c.mode) receipt.collectorMode = clipped(c.mode, 40);
    Object.assign(receipt, { files: info.files.length, bytes: info.files.reduce((a, f) => a + f.size, 0), entries: info.total });
    const out = [], notesIn = [];
    let busiest = null, busiestAt = null, errors = 0;
    if (!info.total) {
      note('No file in this bundle is a log with timestamps this tool recognises, so it has no timeline entries.');
      steps.push([call('files'), `lists the ${count(info.files.length, 'file')} in this bundle${onOnePage(info.files) ? '' : `, ${PAGED}`}`]);
    } else {
      const r = await ds.query({ bins: 1 }, () => {});
      const counted = (name) => r.facets[name].values.filter(([, c]) => c > 0).map(([v, c]) => [info.names[name][v] || '(none)', c]);
      receipt.period = { from: fmtTime(info.t0, false), to: fmtTime(info.t1, false) };
      if (info.focus) receipt.mainPeriod = { from: fmtTime(info.focus[0], false), to: fmtTime(info.focus[1], false) };
      receipt.timeZone = zone();
      receipt.bySeverity = Object.fromEntries(counted('sev'));      // the tool's own six names
      receipt.byTag = counted('tag').map(([tag, entries]) => ({ tag, entries }));      // the tags are the bundle's names: values, not keys
      receipt.topProcesses = counted('proc').slice(0, 8).map(([name, entries]) => ({ process: name, entries }));
      receipt.processes = r.facets.proc.all;
      // count by file lists 20 values unless sent a limit, no more than LIST_LIMIT in one call, and no more than its
      // receipt holds (valuesFitting): a path can be long. The call offered asks for as many as that call lists.
      const sources = receipt.logSources = info.sources.filter((s) => s.rows).length, top = largest(r, {}, 'file', LIST_LIMIT);
      const listedByFile = valuesFitting({ query: '', matched: info.total, total: info.total, by: 'file', moreValues: sources }, top.vals.map(([v, n]) => ({ value: info.names.file[v] || '(none)', entries: n })));
      const byFile = call('count', { by: 'file', ...(listedByFile !== Math.min(sources, 20) ? { limit: listedByFile } : {}) });
      note(listedByFile >= sources ? `${count(sources, 'log source is', 'log sources are')} on the timeline: ${byFile} lists ${sources === 1 ? 'it, with the entries it gave' : 'them, with the entries each gave'}.`
        : `${sources} log sources are on the timeline: ${byFile} lists the ${listedByFile} that gave the most entries, with the entries each gave.`);
      if (info.focus) notesIn.push(`Note: The macOS and Excel logs cover ${timeSaid(info.focus[0])} to ${timeSaid(info.focus[1])} (mainPeriod). Entries outside that come from other sources, such as install history, sleep and wake records and reports.`);
      errors = r.facets.sev.values.reduce((a, [v, c]) => a + (v >= 4 ? c : 0), 0);
      if (errors) {
        const lvl = { inc: errorLevels(), exc: [] };
        // The interval of the main period (of the whole period when there is none) with the most errors and faults,
        // counted in the intervals the histogram offered below counts in, so that its ERRORS column shows the same.
        const lo = info.focus ? Math.floor(info.focus[0] / 1000) * 1000 : info.t0, hi = info.focus ? Math.floor(info.focus[1] / 1000) * 1000 : info.t1 + 1;
        const iv = intervalsOf(lo, hi, info.focus ? hi : null, 24), per = new Uint32Array(iv.nb), T = ds.g.T;
        const inside = await ds.query({ ...(info.focus ? { t0: lo, t1: hi } : {}), bins: 1, facets: { lvl } }, () => {});
        if (inside.count) {
          for (let k = 0; k < ds.view.length; k++) per[iv.at(T[ds.view[k]])]++;
          let b = 0;
          for (let k = 1; k < iv.nb; k++) if (per[k] > per[b]) b = k;
          busiest = { from: iv.from(b), to: iv.to(b), errorsAndFaults: per[b], intervalLength: lengthSaid(iv.step), within: info.focus ? 'mainPeriod' : 'period' };
          receipt.intervalWithMostErrors = busiest;
          busiestAt = [timeArg(iv.start(b)), timeArg(iv.stop(b))];
        }
        // The shapes of message the errors and faults have most (count by message, with minSeverity error)
        await ds.query({ bins: 1, facets: { lvl } }, () => {});
        const g = await shapesOf(ds.view), all = call('count', { minSeverity: 'error', by: 'message' });
        receipt.errorsByMessage = g.list.slice(0, 3);
        if (g.stop) note(cutSaid(g, errors, 'errors and faults', 'errorsByMessage counts'));
        else if (g.list.length > 3) note(`errorsByMessage gives the 3 shapes of message that most errors and faults have, of the ${g.list.length} they have: ${all} lists more.`);
      }
    }
    receipt.reports = { total: info.reports.length, byKind: Object.fromEntries(reportKinds()) };
    // The report files, newest first, except that the newest about Excel itself comes first when it is not the newest
    const byTime = info.reports.slice().sort((a, b) => b.t - a.t || (b.pos ?? 0) - (a.pos ?? 0)), excel = byTime.find(excelReport);
    if (byTime.length) {
      const first = excel && excel !== byTime[0], rows = (excel ? [excel, ...byTime.filter((x) => x !== excel)] : byTime).slice(0, SUMMARY_REPORTS), n = byTime.length;
      // Counted are the reports, each an entry of the timeline: a force-quit record can hold more than one in one file
      const rest = rows.length < n ? `the ${rows.length - 1} newest of the other ${n - 1} reports` : n === 2 ? 'the other report' : `the other ${n - 1} reports`;
      out.push(first ? `The newest crash, hang or spin report of Microsoft Excel, then ${rest}${rows.length > 2 ? ', newest first' : ''}:`
        : n === 1 ? 'The one report:' : rows.length < n ? `The ${rows.length} newest of the ${n} reports, newest first:` : `The ${n} reports, newest first:`);
      // A path is as long as whoever made the bundle chose, and the summary is meant to stay short: a line longer than
      // REPORT_LINE_MOST is cut, and its report is still listed whole by reports.
      sayReports(rows, true);
      out.push(...said().map((l) => clipped(l, REPORT_LINE_MOST)));
    }
    out.push(...notesIn);
    // What the bundle records about this Mac and this collection, in the engine's words (fact) with the bundle's own
    // values, then each step of the collection and each day of its macOS log search that the collector recorded as
    // less than whole, as it wrote them. Each list is capped and each value cut short, and a cap that cut is said.
    receipt.collection = c.facts.slice(0, 24).map((x) => ({ fact: x.label, value: clipped(x.value, 120), ...(x.path ? { file: x.path } : {}) }));
    // The days are those whose outcome does not start with "ok", the collector's word for a day searched to its end and
    // written: an outcome can also say that how the search ended is not known, so the key claims no more than that.
    const open = c.steps.filter((x) => x.status !== 'complete'), partial = c.days.filter((d) => !/^ok\b/.test(d.outcome));
    const part = (p) => (c.cut.includes(p) ? ` in the first ${fmtBytes(RECORD_BYTES)} of it, all that was read` : '');
    if (open.length) {
      receipt.stepsNotComplete = open.slice(0, LISTED).map((x) => ({ step: clipped(x.step, 60), status: clipped(x.status, 40), detail: clipped(x.detail, 160) }));
      note(`${MANIFEST} records ${count(open.length, 'step')} of this collection as not complete, of the ${c.steps.length} it lists${part(MANIFEST)}. stepsNotComplete gives ${open.length > LISTED ? `the first ${LISTED}, each` : open.length === 1 ? 'it' : 'each'} with its status and details.`);
    } else if (c.cut.includes(MANIFEST) && c.steps.length) note(`Only the first ${fmtBytes(RECORD_BYTES)} of ${MANIFEST} was read, and it records every step it lists there as complete.`);
    if (partial.length) {
      receipt.macosLogDaysNotOk = partial.slice(0, LISTED).map((d) => ({ day: clipped(d.day, 40), outcome: clipped(d.outcome, 160) }));
      if (partial.length > LISTED || c.cut.includes(STATUS_FILE)) note(`${STATUS_FILE} records ${count(partial.length, 'line')} whose outcome does not start with "ok"${part(STATUS_FILE)}, and macosLogDaysNotOk gives ${partial.length > LISTED ? `the first ${LISTED}` : partial.length === 1 ? 'it' : 'each'}.`);
    } else if (c.cut.includes(STATUS_FILE) && c.days.length) note(`Only the first ${fmtBytes(RECORD_BYTES)} of ${STATUS_FILE} was read, and every outcome it records there starts with "ok".`);
    if (open.length > LISTED || partial.length > LISTED) receipt.truncated = true;
    // The sources source_catalog.tsv records the collector did not find, or found turned off, in its own words for
    // that (missing, off), so that a log the bundle lacks is not read as one that had nothing in it
    const lacking = c.catalog.filter((x) => x.availability === 'missing' || x.availability === 'off');
    if (lacking.length) {
      receipt.sourcesMissingOrOff = lacking.slice(0, LISTED).map((x) => ({ source: clipped(x.source, 80), availability: x.availability }));
      if (lacking.length > LISTED || c.cut.includes(CATALOG)) {
        receipt.truncated = true;
        note(`${CATALOG} records ${count(lacking.length, 'source')} as missing or off${part(CATALOG)}, and sourcesMissingOrOff gives ${lacking.length > LISTED ? `the first ${LISTED}` : lacking.length === 1 ? 'it' : 'each'}.`);
      }
    }
    // Each process ID of Microsoft Excel the macOS and Excel logs have entries from (the excel marks of marks() in the
    // engine), with the times of its first and last entry there, oldest first, so that whether Excel logged again after
    // a crash is in the summary. The engine follows only so many process IDs (excelPidsCut says it met more); of those
    // it follows, the LISTED whose first entry is newest are given.
    const marks = info.total ? await ds.marks() : { marks: [] }, runs = marks.marks.filter((x) => x.kind === 'excel');
    if (runs.length) {
      receipt.excelProcessIds = runs.slice(-LISTED).map((x) => ({ pid: x.pid, firstEntry: fmtTime(x.t, false), lastEntry: fmtTime(x.t1, false) }));
      if (runs.length > LISTED || marks.excelPidsCut) {
        receipt.truncated = true;
        note(marks.excelPidsCut ? `The macOS and Excel logs have entries from Microsoft Excel under more than ${runs.length} process IDs. This tool follows the first ${runs.length} of them, and excelProcessIds gives the ${Math.min(LISTED, runs.length)} of those whose first entry is newest.`
          : `The macOS and Excel logs have entries from Microsoft Excel under ${runs.length} process IDs, and excelProcessIds gives the ${LISTED} whose first entry is newest.`);
      }
    }
    const caseFile = info.files.find((x) => x.path === CASE_FILE && x.size), caseGot = caseFile ? await fileLines(caseFile) : null;
    if (caseFile) {
      receipt.caseNote = { path: CASE_FILE, kind: CASE_KIND[caseGot.all ? caseRead(caseGot.all.join('\n')).kind : 'other'] };
      if (caseGot.binary) note(notTextSaid(CASE_FILE));
    }
    // newest first (NEWEST_SAID), each with what its id records
    receipt.availableBundles = R.bundles.slice(0, 10).map(bundleSaid);
    receipt.bundles = R.bundles.length;
    // The newest report about Excel itself first, laid out; then the case note, which is what whoever ran the
    // collector gave it (or an older collector's own wording); then the steps not complete, then the errors.
    const laid = excel && await layable(excel);
    if (laid) steps.push([call('reports', { path: excel.path }), 'lays out the newest crash, hang or spin report of Microsoft Excel']);
    if (caseFile && caseGot.all) steps.push([call('read_file', { path: CASE_FILE }), receipt.caseNote.kind === CASE_KIND.given ? 'reads what was given when the collector was run' : 'reads the case file']);
    if (open.length) {
      const reads = readsSaid(c, MANIFEST, 'reads the row it has for each step');
      if (reads) steps.push([call('read_file', { path: MANIFEST }), reads]);
      else if (c.shape[MANIFEST]) note(notTextSaid(MANIFEST));
    }
    if (busiest) steps.push([call('search', { minSeverity: 'error', from: busiestAt[0], to: busiestAt[1] }), `lists the ${count(busiest.errorsAndFaults, 'error or fault', 'errors and faults')} in intervalWithMostErrors`]);
    else if (errors) steps.push([call('search', { minSeverity: 'error' }), `lists the ${count(errors, 'error or fault', 'errors and faults')}`]);
    if (info.reports.length && (!laid || info.reports.length > SUMMARY_REPORTS)) {
      const n = info.reports.length, { kept } = reportLines();
      steps.push([call('reports'), `lists ${kept < n ? `the ${kept === 1 ? 'newest' : `${kept} newest`} of the ${n} reports` : `the ${count(n, 'report')}`} with ${kept === 1 ? 'its time' : 'their times'}`]);
    }
    // Install history and old reports can stretch the whole period over years; intervals over that say nothing. Sent no
    // span, the histogram counts the main period itself. The span is not written into the call: a time printed after
    // the Mac's clock changed its offset is not always read back as the same moment, and the main period would be cut short.
    if (info.total) steps.push([call('histogram'), info.focus ? 'shows when entries were logged in the main period' : 'shows when entries were logged']);
    const notesOut = bundleNotes(), kept = fit(out, notesOut);
    return { receipt, text: [...out, ...notesOut.slice(0, kept)].join('\n'), next: nextSaid(steps) };
  },

  async search() {
    const f = filters(), limit = whole('limit', 1, LIST_LIMIT, 20), offset = whole('offset', 0), newest = flag('newest'), maxChars = whole('maxChars', 1, LIST_CHARS, 200);
    if (newest && offset !== undefined) throw new Refusal('newest and offset cannot be used together', 'offset', 'Send newest: true for the last matches, or offset to skip that many matches from the first, not both.');
    const { q, r, read, receipt } = await matched(f);
    if (!r.count) return nothing('search', f, q, r, read, receipt);
    const start = newest ? Math.max(0, r.count - limit) : offset || 0;
    if (start >= r.count) throw new Refusal('offset is past the last match', 'offset', `${r.count === 1 ? 'Only 1 entry matches' : `Only ${r.count} entries match`}, so offset can be from 0 to ${r.count - 1}. Leave offset out to start from the first match.`);
    const rows = await listed(Array.from(ds.view.subarray(start, start + limit)), maxChars);
    printRows(rows, { wide: true });
    // each line starts with the entry's id; a character in its names or its message is written as visible() says
    const out = said().map(visible), head = out.slice(0, 1), listing = out.slice(1), kept = fitFirst(head, listing), last = start + kept;
    if (kept < rows.length) note(`These entries are long: ${kept} of the ${rows.length} asked for fit in one result. nextOffset continues after them.`);
    receipt.shown = { first: start + 1, last };
    receipt.truncated = last < r.count || (newest && start > 0);
    if (last < r.count) receipt.nextOffset = last;
    receipt.timeZone = zone();
    const id = rows[0][0], page = { ...f.same, ...(absent(P.limit) ? {} : { limit }), ...(absent(P.maxChars) ? {} : { maxChars }) };
    const steps = [[call('context', { id }), `shows what every source logged around entry ${id}, the first listed`]];
    const onward = last < r.count ? [call('search', { ...page, offset: last }), `lists the matches after these ${kept}`] : newest && start > 0 ? [call('search', { ...page, offset: Math.max(0, start - limit) }), 'lists the matches before these'] : null;
    // Paging through hundreds of matches gets a small model nowhere: grouping them by the shape of their message is
    // the way in. The page after stays on offer, as the one way on from the newest matches, which have no nextOffset.
    if (onward && r.count > 5 * limit) { steps.unshift([call('count', { ...f.same, by: 'message' }), groupsSaid(r.count, 'matches')]); steps.push(onward); }
    else { steps.push([call('show', { id }), 'gives that entry in full']); if (onward) steps.push(onward); }
    return { receipt, text: [...head, ...listing.slice(0, kept)].join('\n'), next: nextSaid(steps) };
  },

  async count() {
    const f = filters(), by = text('by', 'process'), limit = whole('limit', 1, LIST_LIMIT, 20), field = by === undefined ? undefined : by.toLowerCase(), fields = COUNTED_BY();
    if (field !== undefined && !fields.includes(field)) {
      const guess = nearName(field, fields);
      throw new Refusal('by is not something entries can be counted by', 'by', `Send by as one of: ${fields.join(', ')}.${guess ? ` The nearest to what was sent is ${guess}.` : ''}`);
    }
    if (field === undefined && !absent(P.limit)) note('limit is used only when by is given, so it changed nothing here.');
    const { q, r, read, receipt } = await matched(f);
    // the call offered without the condition that ruled entries out is this call without it: by and limit stay
    if (!r.count) return nothing('count', { ...f, same: { ...f.same, by: field, ...(field && !absent(P.limit) ? { limit } : {}) } }, q, r, read, receipt);
    if (field === 'message') {
      // Each shape with its entries, the first entry that has it and when the first and the last were logged
      const g = await shapesOf(ds.view), top = g.list[0], steps = [], all = g.list.length;
      const fits = valuesFitting({ ...receipt, by: 'message', moreValues: all, entriesGrouped: g.grouped, timeZone: zone() }, g.list.slice(0, LIST_LIMIT)), shown = Math.min(limit, fits);
      Object.assign(receipt, { by: 'message', values: g.list.slice(0, shown), moreValues: all - shown });
      if (shown < Math.min(limit, all)) note(`values gives the ${shown} shapes with the most entries: one result holds no more of them, and moreValues counts the rest.`);
      if (g.stop) { receipt.entriesGrouped = g.grouped; note(cutSaid(g, r.count, 'entries matched', 'values and moreValues count')); }
      if (receipt.moreValues > 0 || g.stop) receipt.truncated = true;
      steps.push([call('show', { id: top.firstId }), 'gives in full the first entry of the first shape listed'], [call('context', { id: top.firstId }), 'shows what every source logged around it']);
      if (g.stop) {
        // The rest of what matched: from the time of the first entry left out, to where this call's window ends. A time
        // is sent to the second, so that call starts at the second the entry left out is in; when that is the second
        // the first match is in, it would group what this call grouped and stop where this one stopped, so it is not offered.
        const T = ds.g.T, resume = Math.floor(T[g.after] / 1000) * 1000;
        if (resume > T[ds.view[0]]) {
          const rest = { ...f.same, from: timeArg(resume), ...(q.t1 != null ? { to: timeArg(q.t1) } : {}), by: 'message', ...(absent(P.limit) ? {} : { limit }) };
          for (const k of ['aroundId', 'aroundTime', 'window']) delete rest[k];
          steps.push([call('count', rest), `groups the matched entries logged from ${timeSaid(resume)} on`]);
        }
      } else if (receipt.moreValues > 0 && fits > shown) {
        const n = Math.min(all, fits);
        steps.push([call('count', { ...f.same, by: 'message', limit: n }), n === all ? `lists all ${all} shapes` : `lists the ${n} shapes with the most entries`]);
      }
      receipt.timeZone = zone();
      return { receipt, next: nextSaid(steps) };
    }
    const values = (name, n) => { const { vals, all } = largest(r, q, name, n); return { list: vals.map(([v, c]) => ({ value: info.names[BY[name]][v] || '(none)', entries: c })), more: all - vals.length }; };
    const steps = [];
    let top, all = 0, fits = 0, shown = 0;
    if (field) {
      // the values with the most entries, as many as the receipt holds whole (valuesFitting), and no more than limit
      const v = values(field, LIST_LIMIT);
      all = v.list.length + v.more;
      fits = valuesFitting({ ...receipt, by: field, moreValues: all, ...(receipt.from || receipt.to ? { timeZone: zone() } : {}) }, v.list);
      shown = Math.min(limit, fits);
      Object.assign(receipt, { by: field, values: v.list.slice(0, shown), moreValues: all - shown });
      if (shown < Math.min(limit, all)) note(`values gives the ${shown} ${field} values with the most entries: one result holds no more of them, and moreValues counts the rest.`);
      if (receipt.moreValues > 0) receipt.truncated = true;
      top = v.list[0];
    } else {
      Object.assign(receipt, { bySeverity: values('severity', 8).list, bySource: values('source', 8).list, byTag: values('tag', 8).list, byProcess: values('process', 8).list });
      top = receipt.byProcess[0];
    }
    if (top && top.value !== '(none)') {
      const { query, ...rest } = f.same;
      // A name from the bundle goes into a suggested call only when it is short and plain. Any other is text its
      // writer chose. Even a plain one is said once, in the call, and not again in the words beside it: a short
      // sentence of letters, spaces and dots is a plain name too.
      // The search finds every name that holds this one (MATCHES, in the text commands), and the words say that.
      // It adds a term to the query sent, so it is offered only when the query it sends has no more words than a
      // query may have: else it would be refused.
      const by = field || 'process', narrowed = plainName(top.value) ? [query, termFor(by, top.value)].filter(Boolean).join(' ') : '';
      if (narrowed && queryFits(narrowed)) steps.push([call('search', { query: narrowed, ...rest }), `lists the entries counted here ${MATCHES[BY_FIELD[by]]} the largest ${by} value`]);
    }
    // offered as the size to ask for: every value when one call lists them all, else as many as one call lists
    if (field && receipt.moreValues > 0 && fits > shown) {
      const n = Math.min(all, fits);
      steps.push([call('count', { ...f.same, by: field, limit: n }), n === all ? `lists all ${all} ${field} values` : `lists the ${n} ${field} values with the most entries`]);
    }
    if (!field) steps.push([call('count', { ...f.same, by: 'process' }), 'lists more processes; by can also be severity, level, source, tag, subsystem, category or file']);
    if (receipt.from || receipt.to) receipt.timeZone = zone();
    return { receipt, next: nextSaid(steps) };
  },

  async histogram() {
    const f = filters(), bins = whole('bins', 1, 60, 24);
    // Sent no span, it counts the main period when the bundle has one (info.focus, mainPeriod in the summary): install
    // history and old reports can stretch the whole period over years, and intervals over that say nothing. The span is
    // the one the summary gives and offers: from its first whole second to its last. The whole period is one call away,
    // sent from the first entry's time and no end: a time printed after the Mac's clock changed its offset is not
    // always read back as the same moment, and the bundle's first entry is before any such change.
    // Whatever span was sent, the call offered without one (nothing() offers it when the span ruled every entry out) is
    // the whole period too: sent no span, it would count the main period again.
    if (info.focus) f.whole = { from: timeArg(info.t0) };
    if (info.focus && [P.from, P.to, P.aroundId, P.aroundTime].every(absent)) {
      const [lo, hi] = info.focus.map((t) => Math.floor(t / 1000) * 1000), main = { from: timeSaid(lo), to: timeSaid(hi) };
      f.span = [lo, hi];
      note(`No from, to, aroundId or aroundTime was sent, so this counts the main period only, where the bundle's macOS and Excel logs are (mainPeriod in ${tool('summary')}): from ${main.from} to ${main.to}. ${call('histogram', { ...f.same, ...f.whole })} counts the whole period.`);
    }
    const { q, r, read, receipt } = await matched(f);
    if (!r.count) return nothing('histogram', f, q, r, read, receipt);
    // The engine's own histogram is not used. It places an entry by multiplying by a rounded scale, so one logged
    // exactly on a boundary can fall either side, and its boundaries fall between seconds. Here each interval is a
    // whole number of seconds from a whole second, so the times printed are the real boundaries, and a search from
    // one to the next returns the entries counted between them. (Only a window that itself starts or ends between
    // seconds keeps a boundary there, at that end.)
    const T = ds.g.T, view = ds.view, lo = q.t0 != null ? q.t0 : T[view[0]], hi = q.t1 != null ? q.t1 : T[view[view.length - 1]] + 1;
    const iv = intervalsOf(lo, hi, q.t1, bins), { h0, step, nb, end, from, to } = iv, counts = new Uint32Array(nb * 3);
    for (let k = 0; k < view.length; k++) {
      const i = view[k], sv = ds.lvlSev[ds.g.L[i]];
      counts[iv.at(T[i]) * 3 + (sv >= 4 ? 2 : sv === 3 ? 1 : 0)]++;
    }
    if (!absent(P.bins) && nb < bins) note(`${count(nb, 'interval covers', 'intervals cover')} this span, fewer than the bins asked for: each interval is a whole number of seconds long.`);
    const total = (b) => counts[b * 3] + counts[b * 3 + 1] + counts[b * 3 + 2];
    const out = ['ERRORS counts errors and faults.', `${'START'.padEnd(19)}  ${'ENTRIES'.padStart(9)}  ${'ERRORS'.padStart(8)}  ${'WARNINGS'.padStart(8)}`];
    // An interval with no entries may be one the bundle has no macOS log for at all (no part of it is covered), and
    // each run of them says how many of its intervals are, when the bundle looked for that log.
    const cover = await macosCover(), bare = (b) => cover.searched && !cover.spans.some(([x, y]) => x < Math.min(h0 + (b + 1) * step, end) && y >= h0 + b * step);
    let fullest = 0, empty = 0, unlogged = 0, emptyAll = 0, unloggedAll = 0;
    const gap = () => {
      if (empty) out.push(`(${count(empty, 'interval')} with no entries${unlogged ? `; the bundle has no macOS log for ${unlogged === empty ? (empty === 1 ? 'it' : 'any of them') : `${unlogged} of them`}` : ''})`);
      empty = unlogged = 0;
    };
    for (let b = 0; b < nb; b++) {
      if (total(b) > total(fullest)) fullest = b;
      if (!total(b)) { empty++; emptyAll++; if (bare(b)) { unlogged++; unloggedAll++; } continue; }
      gap();
      out.push(`${from(b)}  ${String(total(b)).padStart(9)}  ${String(counts[b * 3 + 2]).padStart(8)}  ${String(counts[b * 3 + 1]).padStart(8)}`);
    }
    gap();
    Object.assign(receipt, { intervals: nb, intervalLength: lengthSaid(step), from: from(0), to: fmtTime(end, false), fullest: { from: from(fullest), to: to(fullest), entries: total(fullest) } });
    if (emptyAll && cover.searched) Object.assign(receipt, { emptyIntervals: emptyAll, emptyIntervalsWithNoMacosLog: unloggedAll });
    receipt.timeZone = zone();
    const same = { ...f.same, from: timeArg(iv.start(fullest)), to: timeArg(iv.stop(fullest)) };
    for (const k of ['aroundId', 'aroundTime', 'window']) delete same[k];
    return { receipt, text: out.join('\n'), next: nextSaid([[call('search', same), 'lists the entries in the fullest interval']]) };
  },

  async show() {
    const id = whole('id', 0), maxChars = whole('maxChars', 1, SHOW_CHARS, 4000);
    needTimeline();
    if (id === undefined) throw new Refusal('id is missing', 'id', `Send id as a whole number copied from the ID column of ${tool('search')} or ${tool('context')} results. Entry ids in this bundle run from 0 to ${info.total - 1}; do not guess one.`);
    if (id > info.total - 1) throw noEntry('id', id);
    const d = await ds.row(id), r = d.row, N = info.names, sev = info.lvlSev[r[3]], src = info.sources[r[2]], lvl = N.lvl[r[3]], msg = String(r[9]);
    const receipt = { id, lastId: info.total - 1, time: fmtTime(r[1], false), utcTime: Core.stamp(r[1], 0), timeZone: zone(), severity: SEV[sev] };
    if (lvl && lvl.toLowerCase() !== SEV[sev].toLowerCase()) receipt.level = lvl;
    receipt.source = src.short;
    if (!src.virtual) receipt.file = src.path;
    if (N.proc[r[4]]) receipt.process = N.proc[r[4]];
    if (r[5]) receipt.pid = r[5];
    if (N.sub[r[6]]) receipt.subsystem = N.sub[r[6]];
    if (N.cat[r[7]]) receipt.category = N.cat[r[7]];
    const tags = N.tag.filter((_, b) => (r[8] >> b) & 1), extra = {};
    if (tags.length) receipt.tags = tags;
    // "Local time" is left out: it is the entry's time again on another clock, and the receipt has one clock.
    for (const [k, v] of Object.entries(d.extra || {})) if (v && k !== 'file' && k !== 'Local time') extra[camel(k)] = clip(flat(v), 200);
    if (Object.keys(extra).length) receipt.extra = extra;
    if (src.kind === 'report' && d.extra && d.extra.file) receipt.reportFile = d.extra.file;
    const printed = messagePrinted(msg, maxChars);
    receipt.messageChars = msg.length;
    if (printed.text) receipt.printed = MESSAGE_PRINTED;
    receipt.truncated = printed.shown < msg.length || !!r[10];
    const steps = [];
    if (r[10]) note('This entry is longer than 2 MB. Only its first 2 MB was read, and messageChars counts that part.');
    // Cut where what is printed fills one answer, a larger maxChars would show no more, so none is offered
    if (printed.full) note(`This message as printed here, each line after two spaces and each character that would act, break a line or take no room written by its number, is longer than one result holds, so only its first ${printed.shown} characters are shown. A larger maxChars shows no more of it.`);
    else if (msg.length > maxChars) {
      // The size offered is this message's own length where one call can return it: a model shown the largest
      // size a call takes sends that size from then on, for every entry.
      if (maxChars < SHOW_CHARS) steps.push(msg.length <= SHOW_CHARS ? [call('show', { id, maxChars: msg.length }), 'gives the whole message'] : [call('show', { id, maxChars: SHOW_CHARS }), 'gives more of the message']);
      else note(`This message has ${msg.length} characters. The first ${maxChars} are shown, and one call returns no more than that.`);
    }
    steps.push([call('context', { id }), 'shows what every source logged around it']);
    if (plainPath(receipt.reportFile)) steps.push([call('read_file', { path: receipt.reportFile }), 'reads the report file itself']);
    return { receipt, text: printed.text, next: nextSaid(steps) };
  },

  async context() {
    const id = whole('id', 0), time = text('time', timeLike()), before = whole('before', 0, CONTEXT_SIDE, 8), after = whole('after', 0, CONTEXT_SIDE, 8), window = text('window', spanLike), maxChars = whole('maxChars', 1, LIST_CHARS, 200);
    needTimeline();
    if (id !== undefined && time !== undefined) throw new Refusal('id and time cannot be used together', 'time', 'Send id to centre on an entry, or time to centre on a moment, not both.');
    if (id === undefined && time === undefined) throw new Refusal('id or time is missing', 'id', `Send one of the two: id, a whole number copied from the ID column of ${tool('search')} results, or time, written the way results print times. Do not guess an id.`);
    if (id !== undefined && id > info.total - 1) throw noEntry('id', id);
    R.option.context = id !== undefined ? 'id' : 'time';
    if (window !== undefined && !(absent(P.before) && absent(P.after))) note('before and after are not used when window is given.');
    const s = await stretch(id !== undefined ? String(id) : time, id !== undefined, before, after, window), anchor = s.id, receipt = {};
    let { a, b } = s, cut = false;
    // A window, or the moment asked for, that the macOS log in this bundle does not cover is said to be so: an entry
    // nearest to it from another source, or from far off, is not what was logged there.
    const uncovered = window !== undefined ? await coverNotes(s.t0, s.t1) : id === undefined ? await coverNotes(s.t, s.t + 1, true) : [];
    if (window !== undefined && s.cut) note(`The time window ${windowCutSaid(s.t0, s.t1, (t) => timeSaid(t))}.`);
    if (window !== undefined) {
      receipt.entriesInWindow = b - a;
      if (a === b) {
        note(s.cut ? `The bundle holds no entry in that window, from ${timeSaid(s.t0)} to ${timeSaid(s.t1)}.` : `The bundle holds no entry within ${fmtSpan(s.half)} either side of ${timeSaid(s.t)}.`);
        uncovered.forEach(note);
        Object.assign(receipt, { entries: 0, truncated: false, timeZone: zone() });
        return { receipt, next: nextSaid([...(uncovered.length ? [await collectedCall()] : []), [call('context', id !== undefined ? { id } : { time }), 'shows the entries nearest to it, however far off they are']]) };
      }
      // A window lists at most the entries nearest the anchor that fill about a third of one result (WINDOW_MOST):
      // a window around a crash can hold thousands logged in its last second, and a long list of them is no help.
      if (b - a > WINDOW_MOST) { a = Math.max(a, anchor - WINDOW_MOST / 2); b = Math.min(b, a + WINDOW_MOST); a = Math.max(s.a, b - WINDOW_MOST); cut = true; }
    }
    const rows = await listed(Array.from({ length: b - a }, (_, i) => a + i), maxChars), at = rows.find((x) => x[0] === anchor);
    printRows(rows, { wide: true, mark: anchor });
    const out = said().map(visible), asked = rows.length, windowCut = cut;
    // The entry the call is about has to stay, so when not everything fits, lines go from whichever end is further from it.
    let lo = 1, hi = out.length, size = out.reduce((n, l) => n + l.length + 1, -1);
    while (size > TEXT_MOST && hi - lo > 1) { if (anchor - a - (lo - 1) >= (hi - 2) - (anchor - a)) size -= out[lo++].length + 1; else size -= out[--hi].length + 1; }
    const long = hi - lo < asked;
    if (long) cut = true;
    // The times the listed entries span, as listed: a window cut down to its nearest entries can span a second of it
    const shownFrom = fmtTime(rows[lo - 1][1]), shownTo = fmtTime(rows[hi - 2][1]);
    if (windowCut) note(`${s.b - s.a} entries were logged ${s.cut ? 'in that window' : `within ${fmtSpan(s.half)} either side`}, and the ${hi - lo} nearest to the anchor are listed, logged from ${timeSaid(rows[lo - 1][1], true)} to ${timeSaid(rows[hi - 2][1], true)}. A shorter window holds fewer entries, and lists them all once they fit.`);
    if (long) note(`These entries are long: ${hi - lo} of the ${asked} around the anchor fit in one result. A smaller maxChars fits more of them.`);
    if (size > TEXT_MOST) { out[0] = clipped(out[0], HEAD_MOST); out[lo] = clipped(out[lo], Math.max(0, TEXT_MOST - out[0].length - 2)); cut = true; note('The line of the anchor entry is longer than one result holds, so it was cut short.'); }
    b = a + hi - 1; a += lo - 1;
    if (id === undefined) {
      // Without a window the anchor can be far from the time asked, and how far is said
      // (to the second first, so that what is left over after the days is never said as a whole day)
      const off = at[1] - s.t, secs = Math.round(Math.abs(off) / 1000), d = Math.floor(secs / 86400), rest = secs % 86400;
      const how = d >= 2 ? `${d} days${rest ? ` ${lengthSaid(rest * 1000)}` : ''}` : lengthSaid(secs * 1000);
      const far = window === undefined && Math.abs(off) > 60000 ? `, ${how} ${off > 0 ? 'after' : 'before'} the time asked` : '';
      note(s.report ? `The anchor is entry ${anchor}, the entry of the report recorded at ${timeSaid(s.report.t, s.report.t % 1000 !== 0)}.`
        : at[1] >= s.t ? `The anchor is entry ${anchor}, the first entry at or after ${timeAsked(s.t)}${far}.`
          : `No entry ${window !== undefined ? 'in the window ' : ''}is at or after ${timeAsked(s.t)}, so the anchor is the entry nearest before it, ${anchor}${far}.`);
    }
    uncovered.forEach(note);
    Object.assign(receipt, { anchorId: anchor, anchorTime: fmtTime(at[1], false), shown: { firstId: a, lastId: b - 1, from: shownFrom, to: shownTo }, entries: b - a, truncated: cut, timeZone: zone() });
    const steps = [[call('show', { id: anchor }), 'gives the anchor entry in full']], proc = info.names.proc[at[4]];
    // A window cut down is grouped first, every entry in it by the shape of its message, then narrowed by severity:
    // the same window, warnings and worse only
    if (windowCut) {
      const around = id !== undefined ? { aroundId: id } : { aroundTime: time };
      steps.unshift([call('count', { ...around, window, by: 'message' }), groupsSaid(s.b - s.a, 'entries in this window')],
        [call('search', { ...around, window, minSeverity: 'warning' }), 'lists only the warnings, errors and faults in this window']);
    }
    // More either side only where the bundle has entries before or after the ones listed, and they were not left out to fit
    if (window === undefined && !long && ((s.a > 0 && before < CONTEXT_SIDE) || (s.b < info.total && after < CONTEXT_SIDE))) steps.push([call('context', { id: anchor, before: Math.min(CONTEXT_SIDE, Math.max(16, before * 2)), after: Math.min(CONTEXT_SIDE, Math.max(16, after * 2)) }), 'shows more either side']);
    steps.push(proc && plainName(proc) ? [call('search', { query: termFor('process', proc), aroundId: anchor, window: '1m' }), "lists what every process whose name contains the anchor entry's process name logged within a minute either side"]
      : [call('search', { aroundId: anchor, window: '1m', minSeverity: 'warning' }), 'lists only warnings and worse within a minute either side']);
    return { receipt, text: [out[0], ...out.slice(lo, hi)].join('\n'), next: nextSaid(steps) };
  },

  async reports() {
    if (text('path') !== undefined) return laidOut(pathSent());
    // byKind: the kinds are this tool's own words for the reports (Crash, Hang, Jetsam and so on), not names from the bundle
    const receipt = { reports: info.reports.length, byKind: Object.fromEntries(reportKinds()) };
    if (!info.reports.length) {
      note('This bundle holds no crash, hang, spin, jetsam or other diagnostic report files.');
      (await recordedAbout('reports')).forEach(note);
      Object.assign(receipt, { shown: 0, truncated: false });
      return { receipt, next: nextSaid(info.total ? [[call('search', { minSeverity: 'error' }), 'lists errors and faults in the logs instead']] : []) };
    }
    const { all, out, kept } = reportLines();
    // Next follows up the newest report about Excel itself, when there is one, and else the newest report: a report
    // of another app, or the collector's own capture of Excel, is listed here but is not where an Excel crash is read.
    const excel = all.filter(excelReport), x = excel.length ? excel[excel.length - 1] : all[all.length - 1];
    if (x !== all[all.length - 1]) note(`Next follows up the newest crash, hang or spin report of Microsoft Excel, the one at ${timeSaid(x.t)}, and not the newest report.`);
    // That search lists a page of 20 unless sent a limit, so past 20 the sentence says it lists a page at a time.
    const everyReport = 'source:"crash and hang reports"', paged = kept < all.length && (await ds.query({ text: everyReport, bins: 1, dry: true }, () => {})).count > 20;
    if (kept < all.length) note(`This bundle holds ${all.length} reports and the ${kept} newest are listed. Each report is also a timeline entry: ${call('search', { query: everyReport })} lists them all, oldest first${paged ? `, ${PAGED}` : ''}.`);
    Object.assign(receipt, { shown: kept, truncated: kept < all.length, timeZone: zone() });
    const which = x === all[all.length - 1] ? 'the newest report' : "that report of Excel's";
    // reports with a path lays out a file the engine reads as a report and can read here. A force-quit record is
    // listed from the lines of a file that is not one, and that file is read as it is.
    const steps = [];
    if (await layable(x)) steps.push([call('reports', { path: x.path }), `lays out ${which}: the facts this tool reads in it, and the stack it singles out when it has one`]);
    else if (!ds.isReport(x.path) && plainPath(x.path) && findFiles(x.path).length === 1 && await textToRead(x.path)) steps.push([call('read_file', { path: x.path }), `reads the file of ${which}, each line after its number`]);
    // The report's own entry, with no window: the context lists the entries just before and after it, where a window
    // of a minute would list a second of a crash's busiest part.
    if (info.total && x.pos !== undefined) steps.push([call('context', { id: x.pos }), `lists what every source logged just before and after ${which}`]);
    return { receipt, text: [out[0], ...out.slice(out.length - kept)].join('\n'), next: nextSaid(steps) };
  },

  async files() {
    const filter = text('filter'), limit = whole('limit', 1, LIST_LIMIT, FILES_PAGE), offset = whole('offset', 0, undefined, 0);
    const hits = filesFor(filter), receipt = {};
    if (filter) receipt.filter = filter;
    receipt.files = hits.length;
    if (filter) receipt.filesInBundle = info.files.length;
    receipt.bytes = hits.reduce((a, x) => a + x.size, 0);
    if (!hits.length) {
      note(`No file path in this bundle contains ${quoted(filter)}.`);
      receipt.truncated = false;
      return { receipt, next: nextSaid([[call('files'), onOnePage(info.files) ? `lists all ${count(info.files.length, 'file')} in this bundle` : `lists the ${info.files.length} files in this bundle, ${PAGED}`]]) };
    }
    if (offset >= hits.length) throw new Refusal('offset is past the last file', 'offset', `${hits.length === 1 ? 'Only 1 file is' : `Only ${hits.length} files are`} listed${filter ? ' for this filter' : ''}, so offset can be from 0 to ${hits.length - 1}. Leave offset out to start from the first.`);
    const page = hits.slice(offset, offset + limit), head = FILES_HEAD;
    const rows = page.map(fileRow), kept = fitFirst([head], rows), last = offset + kept;
    if (kept < page.length) note(`These paths are long: ${kept} of the ${page.length} asked for fit in one result. nextOffset continues after them.`);
    Object.assign(receipt, { shown: { first: offset + 1, last }, truncated: last < hits.length });
    if (last < hits.length) receipt.nextOffset = last;
    // Paging through every file of a collector's bundle takes many calls. Its folders have names a filter can take,
    // and the fact says how many paths each keeps (by the filter's own rule, so a word can be in other paths too).
    if (!filter && hits.length > limit) {
      const words = FOLDER_WORDS.map((w) => [w, filesFor(w).length]).filter(([, n]) => n && n < hits.length);
      note(`This bundle has ${hits.length} files, more than this call lists. filter keeps only the paths that contain it${words.length ? `: ${and(words.map(([w, n]) => `"${w}" keeps ${n}`))}` : ''}.`);
    }
    const steps = plainPath(page[0].path) ? [[call('read_file', { path: page[0].path }), 'reads the first file listed']] : [];
    if (last < hits.length) steps.push([call('files', { filter, ...(absent(P.limit) ? {} : { limit }), offset: last }), 'lists the files after these']);
    return { receipt, text: [head, ...rows.slice(0, kept)].join('\n'), next: nextSaid(steps) };
  },

  async read_file() {
    const typed = text('path') === undefined ? undefined : pathSent(), fromLine = whole('fromLine', 1, undefined, 1), limit = whole('limit', 1, LIST_LIMIT, LIST_LIMIT), grep = text('grep', '', true);
    if (typed === undefined) throw new Refusal('path is missing', 'path', `Send path: a path copied from the PATH column of ${tool('files')} or the FILE column of ${tool('reports')}. Do not guess one.`);
    const hits = findFiles(typed), f = hits[0];
    if (!hits.length) throw new Refusal('no such file in this bundle', 'path', `No file in this bundle has ${quoted(typed)} as its path, as its name or as part of its path. Copy a path from the PATH column of ${tool('files')}; do not guess one.`);
    if (hits.length > 1) {
      // The files call is offered with the text findFiles looked for (what was sent, without a leading "./" or "/"):
      // its filter finds the same paths, all of them, by the same rule.
      const filter = typed.replace(/^\.?\//, ''), paged = onOnePage(filesFor(filter)) ? '' : `, ${PAGED}`;
      throw withCandidates('path matches more than one file', 'path', hits.map((x) => x.path), 20, (n) => `${quoted(typed)} is part of ${hits.length} paths. Send one of the candidates, whole, as path.${n < hits.length ? ` The first ${n} are given; ${call('files', { filter })} lists them all${paged}.` : ''}`);
    }
    if (f.path !== P.path) note(`path ${quoted(P.path)} was read as ${fromBundle(f.path)}.`);
    // A bundle copied by hand can hold a file this account may not read. That is the file's fault, not the program's.
    const got = await fileLines(f).catch((err) => { throw (err && typeof err.code === 'string' ? new Refusal('the file cannot be read', 'path', `The file ${fromBundle(f.path)} could not be opened on the OpenClaw host (${err.code}). Tell the human, or choose another file from ${tool('files')}.`) : err); });
    // The path a suggested call gives this file by: its own when that is short and plain, else the one that was
    // sent when that is. With neither, the calls that read on are left out; nextFromLine is in the receipt all the same.
    const receipt = { path: f.path, bytes: got.size }, steps = [], again = [f.path, typed].find(plainPath);
    if (got.binary) {
      throw new Refusal('binary file', 'path', `The file ${fromBundle(f.path)} ${ODL.test(f.path) ? ODL_SAID.replace(/^This /, '') : 'is not text, so it cannot be read here.'} Choose another file from ${tool('files')}.`);
    }
    const all = got.all || [], total = all.length;
    receipt.lines = total;
    if (!total) {
      note(got.empty ? 'This file is empty.' : 'This file holds no lines of text.');
      receipt.truncated = false;
      return { receipt };
    }
    if (got.cut) note(`Only the first ${fmtBytes(READ_CAP)} of this file was read. lines counts that part, and nothing after it can be read here.`);
    // Who wrote what in the case file, said once whichever lines are read (caseSaid, which the text command says too)
    const aboutCase = f.path === CASE_FILE ? caseSaid(all.join('\n')) : '';
    if (aboutCase) note(aboutCase);
    // A report file is also laid out by reports, which reads its facts and its stack out of it
    if (ds.isReport(f.path) && info.reports.some((x) => x.path === f.path)) {
      const by = [f.path, typed].find((p) => plainPath(p) && findReports(p).length === 1);
      note(`This file is a report file. ${by ? call('reports', { path: by }) : `${tool('reports')} with its path`} lays it out: the facts this tool reads in it, and the stack it singles out when it has one.`);
    }
    if (fromLine > total) throw new Refusal('fromLine is past the last line', 'fromLine', `The file has ${count(total, 'line')}, so fromLine can be from 1 to ${total}. Leave fromLine out to start from the first line.`);
    const picked = [];
    let matchedLines = 0, onward = 0;
    if (grep === undefined) for (let i = fromLine - 1; i < Math.min(total, fromLine - 1 + limit); i++) picked.push(i);
    else {
      const g = grep.toLowerCase();
      for (let i = 0; i < total; i++) {
        if (!all[i].toLowerCase().includes(g)) continue;
        matchedLines++;
        if (i >= fromLine - 1 && onward++ < limit) picked.push(i);
      }
    }
    // Every line is given after its number. A file can hold lines that read "Next:", "- Fact:" or a JSON result, so no
    // line of it may start where a line of this tool's does. A line longer than 400 characters is cut, and each
    // character in it is written as visible() says, so that a carriage return or a line separator in a line does not
    // start one more. The lines come after a lead line in this tool's words that says what they are (the path is in
    // the receipt, where it is data).
    const lineSaid = (i) => fileLineSaid(all[i], i), rows = picked.map(lineSaid);
    // A line of a table that matched means little without the names of its columns, which a .csv or .tsv file most
    // often has on its first line: so line 1 comes first in every grep of one, whatever it holds, and is not a match
    // unless it contains grep.
    const head = grep !== undefined && /\.(csv|tsv)$/i.test(f.path) && picked.length && picked[0] !== 0 ? [lineSaid(0)] : [];
    const each = (n) => (n === 1 ? 'after its line number:' : 'each after its line number:');
    const lead = (n) => (grep === undefined ? linesLead(picked[0] + 1, picked[n - 1] + 1)
      : `${head.length ? 'Line 1, then ' : ''}${count(n, 'line')} ${fromLine > 1 ? `from line ${fromLine} on ` : ''}that contain${n === 1 ? 's' : ''} grep, ${each(n + head.length)}`);
    // room is kept for the lead as long as it can be, with every line picked
    const kept = picked.length ? fit([lead(picked.length), ...head], rows) : 0;
    if (kept < picked.length) note(`These lines are long: ${kept} of the ${picked.length} asked for fit in one result. nextFromLine continues after them.`);
    if (head.length && kept) note(`Line 1 is listed first, as it is in every grep of a .csv or .tsv file${all[0].toLowerCase().includes(grep.toLowerCase()) ? '' : `; it does not contain ${quoted(grep)}`}.`);
    if (kept) {
      const toLine = picked[kept - 1] + 1;
      receipt.shown = { fromLine: picked[0] + 1, toLine };
      receipt.truncated = grep === undefined ? toLine < total : kept < onward;
      if (receipt.truncated) {
        receipt.nextFromLine = toLine + 1;
        if (again) steps.push([call('read_file', { path: again, fromLine: toLine + 1, ...(absent(P.limit) ? {} : { limit }), grep }), grep === undefined ? 'reads the lines after these' : 'lists the matching lines after these']);
      }
      if (grep !== undefined && again) steps.push([call('read_file', { path: again, fromLine: Math.max(1, picked[0] + 1 - 10), limit: 21 }), `reads the lines around line ${picked[0] + 1}, the first match listed`]);
    } else {
      receipt.truncated = false;
      note(matchedLines ? `No line from line ${fromLine} on contains ${quoted(grep)}; ${count(matchedLines, 'earlier line does', 'earlier lines do')}.` : `No line of this file contains ${quoted(grep)}. Capitals are ignored.`);
    }
    if (onTimeline(f)) { receipt.timelineEntries = f.rows; if (plainPath(f.path)) steps.push([call('search', { query: termFor('file', f.path) }), `lists by time the entries ${MATCHES.source} this file's path`]); }
    if (grep !== undefined) Object.assign(receipt, { grep, matchedLines });
    return { receipt, text: kept ? [lead(kept), ...head, ...rows.slice(0, kept)].join('\n') : undefined, next: nextSaid(steps) };
  },

  async memory() {
    const time = text('time', timeLike()), from = text('from', timeLike()), to = text('to', timeLike());
    if (time !== undefined && (from !== undefined || to !== undefined)) throw new Refusal(`time and ${from !== undefined ? 'from' : 'to'} cannot be used together`, 'time', 'Send time for the samples nearest one moment, or from and to for the samples in a span, not both.');
    // A time with no date takes its day from the bundle's log entries; a bundle with none has no day to give it
    const when = (v, option, name) => {
      if (v === undefined) return undefined;
      if (!info.total && /^\d\d:\d\d/.test(v)) throw new Refusal(`${name} has no date`, name, `This bundle has no timeline entries to take a day from, so ${name} needs a date, written YYYY-MM-DD HH:MM:SS. ${quoted(v)} was sent.`);
      return parseTime(v, option);
    };
    const tAt = when(time, 'time', 'time'), t0 = when(from, '--from', 'from'), t1 = when(to, '--to', 'to');
    if (t0 !== undefined && t1 !== undefined && t1 <= t0) throw new Refusal('from is not earlier than to', 'from', `from was read as ${timeSaid(t0)} and to as ${timeSaid(t1)}. Send a from that is earlier than to.`);
    const groups = memoryFiles(), receipt = {}, steps = [];
    // how the call was read, first
    if (tAt !== undefined) receipt.time = fmtTime(tAt, false);
    if (t0 !== undefined) receipt.from = fmtTime(t0, false);
    if (t1 !== undefined) receipt.to = fmtTime(t1, false);
    receipt.files = [];
    let unlisted = 0;
    for (const g of groups) {
      for (const f of g.files.slice(0, 12)) receipt.files.push({ kind: g.kind, path: f.path, bytes: f.size });
      unlisted += Math.max(0, g.files.length - 12);
    }
    if (unlisted) Object.assign(receipt, { filesNotListed: unlisted, truncated: true });
    // For each kind with files left out: how many, and a filter for the files call that every one of them matches
    // (by that call's own rule: the path contains it, capitals ignored). Of the filters that do, the one that
    // matches the fewest files of the bundle is offered: their folder or their file name, when all of them share it
    // and it is short and plain, or a word every file of that kind has in its name. When it matches other files
    // too, the sentence says so, and when they are more than its first page lists, that it lists a page at a time.
    for (const g of groups.filter((x) => x.files.length > 12)) {
      const left = g.files.slice(12), dirs = new Set(left.map((f) => f.path.replace(/[^/]*$/, ''))), bases = new Set(left.map((f) => baseOf(f.path)));
      const [dir] = dirs, [base] = bases;
      const offered = [dirs.size === 1 && dir && plainPath(dir.replace(/\/$/, '')) ? dir : null, bases.size === 1 && plainName(base) ? base : null, MEMORY_FILTER[g.kind]]
        .filter((filter) => filter && left.every((f) => f.path.toLowerCase().includes(filter.toLowerCase())))
        .map((filter) => ({ filter, hits: filesFor(filter) })).sort((a, b) => a.hits.length - b.hits.length)[0];
      const said = `${count(left.length, `more memory file of kind ${g.kind} is`, `more memory files of kind ${g.kind} are`)} in this bundle than files lists.`;
      note(offered ? `${said} ${call('files', { filter: offered.filter })} lists ${offered.hits.length === left.length ? 'them' : 'them among others'}${onOnePage(offered.hits) ? '' : `, ${PAGED}`}.` : said);
    }
    const csv = (groups.find((g) => g.kind === 'timeline') || { files: [] }).files[0];
    if (csv) {
      const m = await memoryTimeline(csv), k = m.col('utc_time'), tl = { path: csv.path, samples: m.data.length };
      // Only so much of the file is read: every figure and sample given is then of that part, and the sentences say so
      if (m.cut) { note(`Only the first ${fmtBytes(TIMELINE_BYTES)} of the memory timeline was read, so its samples, figures and pressure levels here are of that part.`); receipt.truncated = true; }
      const whose = m.cut ? 'The samples read of the memory timeline' : "The memory timeline's samples";
      // The file gives each sample's time twice. The UTC one is used, so these times are on the receipt's clock like every other.
      // A row whose UTC time cannot be read is given its first cell, the file's text, as a value and cut short
      const at = (d) => { const t = k < 0 ? NaN : Core.isoAt(String(d[k] || ''), 0); return t === t ? fmtTime(t, false) : clipped(String(d[0] || ''), 40); };
      if (m.data.length) { tl.from = at(m.data[0]); tl.to = at(m.data[m.data.length - 1]); }
      for (const s of m.stats) tl[camel(s.name)] = { lowest: { value: s.lo[0], at: at(s.lo[1]) }, highest: { value: s.hi[0], at: at(s.hi[1]) }, last: s.last };
      // The samples whose time can be read, in the order of their times: nearest is by time, whatever order the file is in
      const T = m.data.map((d) => (k < 0 ? NaN : Core.isoAt(String(d[k] || ''), 0))), timed = T.map((_, j) => j).filter((j) => T[j] === T[j]).sort((a, b) => T[a] - T[b] || a - b);
      // In a sentence the timeline is said to run between the times of its first and last such samples, as this tool
      // writes times: never a cell of the file, which is said only as a value
      const runs = () => `${timeSaid(T[timed[0]])} to ${timeSaid(T[timed[timed.length - 1]])}`;
      const start = k < 0 ? undefined : tAt !== undefined ? tAt : t0;      // where the spans listed for each pressure level start
      if (m.levels.length) tl.pressureLevels = pressureSeen(m, at, T, start);
      if (m.pids) tl.excelPids = m.pids.map((v) => cellSaid(String(v).trim()));
      receipt.timeline = tl;
      if (k < 0) note("The memory timeline has no utc_time column, so its times are the Mac's local time as written in the file.");
      else if (m.data.length) receipt.timeZone = zone();
      // The samples asked for: the ones nearest a time (SAMPLES_EITHER_SIDE at or before it and as many after), or those
      // in a span, at most SAMPLES_MOST of them, each with every column this tool knows the meaning of
      if (tAt !== undefined || t0 !== undefined || t1 !== undefined) {
        if (k < 0) note('With no utc_time column, time, from and to pick no samples.');
        else if (!timed.length) note('No sample in the memory timeline has a time this tool can read, so time, from and to pick none.');
        else if (tAt !== undefined) {
          let n = 0;
          while (n < timed.length && T[timed[n]] <= tAt) n++;           // the samples before n are at or before the time
          const near = timed.slice(Math.max(0, n - SAMPLES_EITHER_SIDE), n + SAMPLES_EITHER_SIDE);
          receipt.samplesListed = near.map((j) => sampleSaid(m, at, m.data[j]));
          const end = m.cut ? `${n ? 'at or after the last' : 'before the first'} of them` : n ? 'at or after its last sample' : 'before its first sample';
          if (!n || n === timed.length) note(`${whose} run from ${runs()}, so time is ${end}, and the ${n ? 'last' : 'first'} ${count(near.length, 'sample is', 'samples are')} listed.`);
        } else {
          const inSpan = timed.filter((j) => (t0 === undefined || T[j] >= t0) && (t1 === undefined || T[j] < t1)), step = Math.ceil(inSpan.length / SAMPLES_MOST);
          receipt.samplesInSpan = inSpan.length;
          receipt.samplesListed = inSpan.filter((_, i) => i % step === 0).map((j) => sampleSaid(m, at, m.data[j]));
          if (step > 1) { receipt.truncated = true; note(`${inSpan.length} samples ${m.cut ? 'read ' : ''}of the memory timeline are in this span, and every ${ordinal(step)} one is listed, from the first, so that no more than ${SAMPLES_MOST} are. A shorter span lists more of them.`); }
          if (!inSpan.length) note(`No sample ${m.cut ? 'read ' : ''}of the memory timeline is in this span. ${m.cut ? whose : 'Its samples'} run from ${runs()}.`);
        }
      }
    } else if (tAt !== undefined || t0 !== undefined || t1 !== undefined) note('This bundle has no memory timeline (excel_memory_timeline.csv), so time, from and to pick no samples.');
    // The entries that carry the memory tag itself, as the page counts them. The search offered for them finds every
    // tag that holds "memory", so it can list more, and the words beside it say that.
    receipt.memoryEntries = info.total ? ds.tagTimes('memory', 1).total : 0;
    if (!receipt.files.length && !receipt.memoryEntries) { note('This bundle holds no memory files and no log entries tagged memory.'); (await recordedAbout('memory')).forEach(note); }
    if (receipt.files.length && plainPath(receipt.files[0].path)) steps.push([call('read_file', { path: receipt.files[0].path }), 'reads the first of those files']);
    // the entries tagged memory near the time asked, or in the span, else all of them
    if (receipt.memoryEntries) {
      const at = (t) => (t === undefined ? undefined : timeArg(t));
      steps.push(tAt !== undefined ? [call('search', { query: 'tag:memory', aroundTime: at(tAt), window: '5m' }), `lists the entries ${MATCHES.tag} memory within 5 minutes either side of that time`]
        : t0 !== undefined || t1 !== undefined ? [call('search', { query: 'tag:memory', from: at(t0), to: at(t1) }), `lists the entries ${MATCHES.tag} memory in that span`]
          : [call('search', { query: 'tag:memory' }), `lists the entries ${MATCHES.tag} memory`]);
    }
    return { receipt, next: nextSaid(steps) };
  },
};

// ---------- one request ----------
async function stdinText() {
  const decoder = new TextDecoder();
  let all = '', size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1 << 20) throw new Refusal('the request is larger than 1 MB');
    all += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  return all + decoder.decode();
}
async function answer(raw) {
  let req;
  try { req = JSON.parse(raw); } catch (err) { throw new Refusal('the request is not valid JSON'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Refusal('the request is not a JSON object');
  if (req.format !== undefined && req.format !== 1) throw new Refusal('the request is not format 1, the only format this program answers');
  if (!OPS.includes(req.op)) throw new Refusal(`${typeof req.op === 'string' ? `unknown op ${quoted(req.op)}` : 'the request has no op'}; the ops are ${OPS.join(', ')}`);
  if (req.params !== undefined && req.params !== null && (typeof req.params !== 'object' || Array.isArray(req.params))) throw new Refusal('params is not an object', undefined, 'Send the arguments as one JSON object of names and values, or {} for none.');
  const sample = R.sample = req.allowSample === true;
  if (req.bundlesDir === undefined || req.bundlesDir === null) { if (!sample) throw new Refusal('the request has no bundlesDir'); } else if (typeof req.bundlesDir !== 'string' || !path.isAbsolute(req.bundlesDir)) throw new Refusal('bundlesDir is not an absolute path');
  if (req.cacheDir !== undefined && req.cacheDir !== null) {
    if (typeof req.cacheDir !== 'string' || !path.isAbsolute(req.cacheDir)) throw new Refusal('cacheDir is not an absolute path');
    // Unpacked zips must not turn up as bundles of their own, and nothing is ever written among the bundles.
    if (req.bundlesDir && !path.relative(path.resolve(req.bundlesDir), path.resolve(req.cacheDir)).startsWith('..')) throw new Refusal('cacheDir is inside bundlesDir');
    cacheRoot = R.cacheDir = req.cacheDir;
  }
  R.op = req.op; R.bundlesDir = req.bundlesDir || null;
  P = req.params || {};
  const undeclared = req.undeclared !== null && typeof req.undeclared === 'object' && !Array.isArray(req.undeclared) ? req.undeclared : {};
  const renamedLater = renamed(req.op, { ...undeclared, ...P });
  utc = flag('utc');
  const want = text('bundle');
  // Ids come from the names in one folder. Anything shaped like a path is refused before it is compared with them,
  // so no argument can reach a file outside that folder.
  if (want !== undefined && (/[\/\\]|\.\./.test(want) || want.startsWith('.'))) {
    throw new Refusal('bundle is not a bundle id', 'bundle', `A bundle id is a name with no slash, no backslash and no "..", and it does not start with a dot. Copy an id from availableBundles in ${tool('summary')} results, or leave bundle out for the newest bundle.`);
  }
  const list = R.bundlesDir ? bundlesIn(R.bundlesDir) : [];
  if (R.cacheDir) sweepCache(R.cacheDir);
  R.named = want !== undefined;
  if (sample && (want === 'sample' || (want === undefined && !R.bundlesDir))) {
    R.bundles = [{ id: 'sample', rec: null }, ...list];
    await open('sample');
    if (renamedLater) await renamedLater();
    R.id = 'sample';
  } else {
    const b = pickBundle(list, want);
    R.bundles = list;
    await openBundle(b, list.map((x) => x.id).filter((x) => x !== b.id));
    if (renamedLater) await renamedLater();                // before R.id: the refusal names no bundle, as one before the bundle opened does not
    R.id = b.id;
  }
  R.ids = R.bundles.map((b) => b.id);
  const out = await OP[req.op](), receipt = withinBudget(out.receipt), doc = { ok: true, bundle: R.id, notes: notesKept(), receipt };
  if (out.text) doc.text = out.text;
  if (out.next) doc.next = clipped(out.next, NEXT_MOST);
  return doc;
}
// The notes of one answer, each cut to NOTE_MOST, as many of them in order as NOTES_MOST and NOTES_COUNT_MOST hold;
// when that is not all of them, the last says how many were left out
function notesKept() {
  const all = R.notes.map((n) => clipped(n, NOTE_MOST)), out = [];
  let size = 0;
  for (let k = 0; k < all.length; k++) {
    // room is kept for the note that says how many were left out, unless this one is the last
    const last = k === all.length - 1;
    if (out.length >= NOTES_COUNT_MOST - (last ? 0 : 1) || size + all[k].length > NOTES_MOST - (last ? 0 : 150)) break;
    out.push(all[k]); size += all[k].length;
  }
  if (out.length < all.length) out.push(`${count(all.length - out.length, 'more fact about this call was', 'more facts about this call were')} left out: one result holds no more than ${NOTES_COUNT_MOST} facts, or ${NOTES_MOST} characters of them.`);
  return out;
}
// Whatever happens, one JSON document is printed. A refusal is an ordinary answer and the exit status stays 0; the
// status is 1 only when the program itself failed, and the document then says so in a form the model can pass on.
function failed(thrown) {
  const err = thrown instanceof Usage && thrown.why ? reworded(thrown) : thrown, doc = { ok: false };
  if (R.id) doc.bundle = R.id;
  if (err instanceof Refusal) {
    doc.error = err.message;
    for (const k of ['field', 'hint', 'candidates']) if (err[k] !== undefined) doc[k] = err[k];
    return doc;
  }
  process.exitCode = 1;
  toErr(`${err && err.stack ? err.stack : err}\n`);
  doc.error = 'the Excel diagnostics program failed';
  // one line, whatever the message quotes
  doc.hint = `Tell the human that ${R.op ? tool(R.op) : 'the Excel diagnostics program'} failed with: ${shownAll(named(scrub(String((err && err.message) || err)))).slice(0, 300).replace(/[.!?]*$/, '.')} Do not send the same call again.`;
  return doc;
}
async function answerRequest() {
  let doc;
  try {
    doc = await answer(await stdinText());
  } catch (thrown) {
    try { doc = failed(thrown); } catch (err) { process.exitCode = 1; doc = { ok: false, error: 'the Excel diagnostics program failed' }; }
  }
  lines.length = 0;                                       // anything a shared printer said and nobody took is not for standard output
  process.stdout.write(`${JSON.stringify(doc)}\n`);
}
// ---------- main ----------
async function main(argv) {
  const names = [...Object.keys(COMMANDS), 'clean', 'help'];
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return help('');
  if (argv[0] === '--version') return say(`excel_diagnostics_cli ${VERSION}`);
  if (argv[0] === 'help') return help(argv[1]);
  if (argv[0] === 'clean') return clean();
  bundleArg = argv[0];
  let command = argv[1] === undefined ? 'summary' : argv[1], rest = argv.slice(2);
  if (command.startsWith('--')) {
    if (command === '--help') return help('');
    if (command === '--utc') { rest = argv.slice(1); command = 'summary'; }
    else throw new Usage(`A command comes before the options: ${run(`COMMAND ${command}`)}. Commands: ${names.join(', ')}.`);
  }
  if (command === 'help') return help(rest[0]);
  if (command === 'clean') return clean();
  if (!COMMANDS[command]) {
    const guess = closest(command, names);
    if (names.includes(argv[0])) throw new Usage(`The bundle comes first, then the command: ${RUNTIME} ${shq(SCRIPT)} BUNDLE ${argv[0]} ...  ("${argv[0]}" was read as the bundle and "${command}" as the command.)`);
    throw new Usage(`"${command}" is not a command.${guess ? ` Did you mean "${guess}"?` : ''} Commands: ${names.join(', ')}.\nTo search for words, put "search" before them: ${run(`search ${shq(command)}`)}`);
  }
  if (rest.includes('--help')) return help(command);
  const { o, pos } = parseArgs(command, rest);
  if (names.includes(argv[0]) && !fs.existsSync(argv[0])) throw new Usage(`The bundle comes first, then the command: ${RUNTIME} ${shq(SCRIPT)} BUNDLE ${argv[0]} ...  BUNDLE is the path to the zip or folder, or the word sample.`);
  await open(bundleArg);
  utc = !!o.utc;
  if (!info.total && !['summary', 'files', 'cat', 'reports', 'memory'].includes(command)) {
    say(`"${command}" works on timeline entries, and this bundle has none: no file in it is a log with timestamps this tool recognises.`);
    say(); say('Next:'); say(`  List the files:   ${run('files')}`); say(`  Print one:        ${run('cat PATH')}`);
    return;
  }
  await COMMANDS[command](o, pos);
}

// "request" in the bundle's place is request mode: it answers on standard output with one JSON document and nothing
// else, so none of what follows for the text commands (which print what they said, as text) may run.
if (process.argv[2] === 'request') {
  await answerRequest();
} else {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Usage) {
      say(err.message);
      say(); say(`For the list of commands: ${RUNTIME} ${shq(SCRIPT)} help`);
      process.exitCode = 2;
    } else {
      // what went wrong is one line: a message from the file system quotes a path, and a path can come from the bundle
      say(`Could not finish: ${named(err && err.message ? err.message : err)}`);
      process.exitCode = 1;
    }
  }
  // line the commands of each "Next:" list up under one another
  for (let i = 0; i < lines.length; i++) {
    if (theirs.has(i) || !/^Next( \(.*\))?:$/.test(lines[i])) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && !theirs.has(j); j++) { const m = /^  (.*?):\s{2,}((?:node|deno run -A) .*)$/.exec(lines[j]); if (!m) break; block.push([j, m[1], m[2]]); }
    const w = block.reduce((a, x) => Math.max(a, x[1].length), 0);
    for (const [j, label, command] of block) lines[j] = `  ${(label + ':').padEnd(w + 1)}  ${command}`;
  }
  // What is printed holds text from the bundle: shown() (at the top of the text commands) keeps every control
  // character in it from reaching the terminal.
  const text = shown(lines.join('\n')) + '\n';
  if (process.exitCode) process.stderr.write(text); else process.stdout.write(text);

}
if (lastFd) fs.closeSync(lastFd.fd);
