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
