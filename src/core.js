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
  const toLatin = (s) => (/[^\x00-\x7f]/.test(s) ? LATIN1.decode(new TextEncoder().encode(s)) : s);
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
  function stamp(t, digits = 3) {                       // UTC ms -> "YYYY-MM-DD HH:MM:SS.fff"
    const d = new Date(Math.floor(t)), z = (n, w = 2) => String(n).padStart(w, '0');
    let s = `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
    if (digits) s += '.' + z(Math.floor((t - Math.floor(t / 1000) * 1000) * 10 ** (digits - 3)), digits);
    return s;
  }

  // ---------- zip (central directory + raw deflate via DecompressionStream) ----------
  // Reads zip64, and also repairs what `ditto -c -k` (the collector's zipper) writes instead of zip64: plain
  // 32-bit sizes and offsets that silently wrap around once a file or the archive passes 4 GB.
  const GB4 = 4294967296;
  async function readZip(file) {
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
      this.alloc(Math.max(1024, Math.min(4 << 20, Math.ceil(entry.size / 200))));
    }
    alloc(cap) {
      const grow = (A, old) => { const a = new A(cap); if (old) a.set(old.subarray(0, this.n)); return a; };
      this.off = grow(Float64Array, this.off); this.len = grow(Uint32Array, this.len); this.t = grow(Float64Array, this.t);
      this.lvl = grow(Uint8Array, this.lvl); this.proc = grow(Uint16Array, this.proc); this.pid = grow(Int32Array, this.pid);
      this.sub = grow(Uint16Array, this.sub); this.cat = grow(Uint16Array, this.cat); this.tags = grow(Uint16Array, this.tags);
      this.cap = cap;
    }
    push(off, len, t, lvl, proc, pid, sub, cat, tags) {
      if (this.n === this.cap) this.alloc(this.cap * 2);
      const i = this.n++;
      this.off[i] = off; this.len[i] = len; this.t[i] = t; this.lvl[i] = lvl; this.proc[i] = proc;
      this.pid[i] = pid; this.sub[i] = sub; this.cat[i] = cat; this.tags[i] = tags;
    }
    extend(end) {                                       // a continuation line belongs to the previous row
      if (this.n) this.len[this.n - 1] = Math.min(end - this.off[this.n - 1], 0xFFFFFFFF);
    }
  }

  // ---------- parsers: line(src, s, p, e, off) indexes one line; fields(text) splits a row for display ----------
  const tab = (s, i, e) => { if (i > e) return e; const j = s.indexOf('\t', i); return j < 0 || j > e ? e : j; };
  const fld = (s, a, b) => (a >= b ? '' : s.substring(a, b));
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
        const image = j.processImagePath || '', name = basename(image), m = j.eventMessage || '';
        let tags = 0;
        if (name === 'Microsoft Excel') tags |= bit('excel');
        else {
          if (image.includes('/Microsoft Excel.app/')) tags |= bit('excel-helper');
          if (/excel/i.test(m)) tags |= bit('mentions-excel');
        }
        if (name === 'Microsoft Error Reporting' || name === 'Microsoft AutoUpdate' || name === 'Microsoft Update Assistant') tags |= bit('microsoft');
        if (name === 'spindump') tags |= bit('hang-report');
        if ((name === 'kernel' && /memorystatus|jetsam|compressor|swap/i.test(m)) || ((name === 'ReportCrash' || name === 'osanalyticshelper') && /jetsam/i.test(m))) tags |= bit('memory');
        if (/previous shutdown cause/i.test(m)) tags |= bit('restart');
        if (j.eventType === 'lossEvent') tags |= bit('logs-dropped');
        src.push(off, e - p, t, lvl.id(j.messageType || j.eventType || ''), proc.id(name), j.processID | 0, sub.id(j.subsystem || ''), cat.id(j.category || ''), tags);
      },
      fields(text) {
        try {
          const j = JSON.parse(text);
          return { msg: j.eventMessage || '', extra: { 'Local time': j.timestamp, Sender: basename(j.senderImagePath || ''), 'Process path': j.processImagePath } };
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
      rx: /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([-+]\d{4}) (\S+)\s*/,
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

  // ---------- dataset ----------
  class Dataset {
    constructor() {
      this.dict = { lvl: new Dict(250), proc: new Dict(65000), sub: new Dict(65000), cat: new Dict(65000) };
      this.tagNames = []; this.zone = []; this.entries = []; this.sources = [];
      this.run = 0; this.textCache = null; this.view = new Uint32Array(0); this.lastBlob = null;
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
      // inputs: [{path, blob}] - one zip, or the files of an unzipped bundle, or loose log files
      const zips = inputs.filter((f) => /\.zip$/i.test(f.path));
      if (zips.length > 1) throw new Error('Open one bundle at a time (several .zip files were given).');
      let name;
      if (zips.length === 1) {
        progress({ phase: 'Reading the zip directory' });
        const file = zips[0].blob;
        name = basename(zips[0].path).replace(/\.zip$/i, '');
        for (const e of await readZip(file)) this.entries.push(new Entry(e.path, e.size, null, { file, e }));
      } else {
        for (const f of inputs) this.entries.push(new Entry(f.path.replace(/^\/+/, ''), f.blob.size, f.blob));
      }
      this.entries = this.entries.filter((en) => !/(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$)/.test(en.path));
      if (!this.entries.length) throw new Error('No files found in what was dropped.');
      const root = this.entries[0].path.split('/')[0] + '/';       // strip the bundle's own top-level folder
      if (this.entries.length > 1 ? this.entries.every((en) => en.path.startsWith(root)) : this.entries[0].path.startsWith(root)) {
        for (const en of this.entries) en.path = en.path.slice(root.length);
        if (!name || /^Excel_Diagnostics/.test(root)) name = root.slice(0, -1);
      }
      this.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      this.name = name || (this.entries.length === 1 ? this.entries[0].path : 'Log files');

      // Which files are logs with timestamps? Decide from each candidate's first bytes.
      const paths = new Set(this.entries.map((en) => en.path));
      const notes = [];
      let skippedBaseline = 0;
      progress({ phase: 'Looking for log files' });
      for (const en of this.entries) {
        if (!en.size || !/\.(tsv|ndjson|log|txt)$|\.log\.[^/]*$/i.test(en.path)) continue;
        if (en.path.startsWith('repro/baseline/') && paths.has('repro/final/' + en.path.slice(15))) { skippedBaseline++; continue; }
        const parser = sniff(this, en.path, LATIN1.decode(await en.head(4096)));
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
      progress({ phase: 'Merging the timeline' });
      this.finalize();
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
          if (e > p) parser.line(src, s, p, e, base + p);
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

    async addReports() {                                // crash, hang and diagnostic reports become timeline events
      const lines = [];
      const add = (t, kind, proc, path, what) => { if (t === t) lines.push(`${stamp(t)}\t${kind}\t${proc}\t${path}\t${what.replace(/[\t\r\n]+/g, ' ')}`); };
      for (const en of this.entries) {
        const ext = (/\.(ips|crash|diag|hang|spin|panic|shutdownstall)$/i.exec(en.path) || [0, ''])[1].toLowerCase();
        const file = basename(en.path);
        if (ext) {
          const head = UTF8.decode(await en.head(8192));
          let t = NaN, proc = '', what = [], kind = { ips: 'Report', crash: 'Crash', diag: 'Diag', hang: 'Hang', spin: 'Spin', panic: 'Panic', shutdownstall: 'Hang' }[ext];
          const stampOf = (str) => { const m = /(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?) ?([-+]\d{4})/.exec(str || ''); return m ? isoAt(m[1], 0) - offStr(m[2]) * 60000 : NaN; };
          if (head[0] === '{') {
            try {
              const j = JSON.parse(head.slice(0, head.indexOf('\n') > 0 ? head.indexOf('\n') : head.length));
              t = stampOf(j.timestamp); proc = j.app_name || j.name || '';
              if (j.bug_type === '309' || j.bug_type === '109') kind = 'Crash';
              else if (j.bug_type === '298') kind = 'Jetsam';
              else if (j.bug_type === '288' || j.bug_type === '388') kind = 'Hang';
              if (j.bug_type) what.push(`bug type ${j.bug_type}`);
              if (j.app_version) what.push(`version ${j.app_version}`);
              if (j.os_version) what.push(j.os_version);
            } catch (err) { /* fall through to the filename */ }
          } else {
            t = stampOf((/^Date\/Time:\s+(.+)$/m.exec(head) || [])[1]);
            proc = ((/^(?:Command|Process):\s+(.+?)(?:\s+\[\d+\])?\s*$/m.exec(head)) || [0, ''])[1];
            for (const key of ['Event', 'Exception Type', 'Termination Reason', 'Action taken', 'Duration']) {
              const m = new RegExp(`^${key}:\\s+(.+)$`, 'm').exec(head);
              if (m) what.push(`${key}: ${m[1].trim()}`);
            }
          }
          if (/^JetsamEvent/i.test(file)) kind = 'Jetsam';
          if (/^(ExcessiveResource|.*\.(cpu|wakeups|diskwrites)_resource)/i.test(file)) kind = 'Diag';
          if (t !== t) {                                // no timestamp inside: use the one in the file name (Mac local time)
            const m = /(\d{4}-\d\d-\d\d)-(\d\d)(\d\d)(\d\d)/.exec(file);
            if (m) t = this.localToUtc(isoAt(`${m[1]} ${m[2]}:${m[3]}:${m[4]}`, 0));
          }
          if (!proc) proc = file.replace(/[-_.]20\d\d-.*$/, '').replace(/\.[a-z]+$/i, '');
          add(t, kind, proc, en.path, what.join('; '));
        } else if (/CrashReporter\/[^/]+\.txt$/i.test(en.path)) {
          const text = UTF8.decode(await en.head(4096));
          for (const m of text.matchAll(/"ForceQuitDate" => (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([-+]\d{4})/g)) {
            add(isoAt(m[1], 0) - offStr(m[2]) * 60000, 'Force quit', file.replace(/_[0-9A-F-]{36}\.txt$/i, ''), en.path, 'last time the user force-quit this app');
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
      const G = this.g = { n: N, T: new Float64Array(N), F: new Uint16Array(N), R: new Uint32Array(N), L: new Uint8Array(N),
        P: new Uint16Array(N), PID: new Int32Array(N), S: new Uint16Array(N), C: new Uint16Array(N), G: new Uint16Array(N) };
      // k-way merge by time. Files are mostly disjoint in time, so copy runs from one file while it stays the earliest.
      const cur = new Uint32Array(S.length);
      const key = (f) => { const s = S[f], c = cur[f]; return c < s.n ? s.t[s.perm ? s.perm[c] : c] : Infinity; };
      let o = 0;
      while (o < N) {
        let m = -1, mk = Infinity, m2 = -1, k2 = Infinity;
        for (let f = 0; f < S.length; f++) {
          const k = key(f);
          if (k < mk) { m2 = m; k2 = mk; m = f; mk = k; } else if (k < k2) { m2 = f; k2 = k; }
        }
        if (m < 0) break;
        const s = S[m], perm = s.perm, n = s.n, t = s.t;
        let c = cur[m];
        for (; c < n; c++) {
          const r = perm ? perm[c] : c, tv = t[r];
          if (tv > k2 || (tv === k2 && m2 < m)) break;
          G.T[o] = tv; G.F[o] = m; G.R[o] = r; G.L[o] = s.lvl[r]; G.P[o] = s.proc[r]; G.PID[o] = s.pid[r];
          G.S[o] = s.sub[r]; G.C[o] = s.cat[r]; G.G[o] = s.tags[r];
          o++;
        }
        cur[m] = c;
      }
      for (const s of S) { s.t = s.lvl = s.proc = s.pid = s.sub = s.cat = s.tags = s.perm = null; }
      this.t0 = N ? G.T[0] : 0;
      this.t1 = N ? G.T[N - 1] : 0;
      const D = this.dict;
      this.lvlSev = Uint8Array.from(D.lvl.names, sevOf);
      const order = ['unified', 'office', 'report', 'autoupdate', 'onedrive', 'install', 'power', 'text'];
      this.groups = [...new Set(S.slice().sort((a, b) => order.indexOf(a.parser.kind) - order.indexOf(b.parser.kind)).map((s) => s.parser.group))];
      this.srcGroup = Uint16Array.from(S, (s) => this.groups.indexOf(s.parser.group));
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
        name: this.name, total: this.g.n, t0: this.t0, t1: this.t1, zone: this.zone, notes,
        focus: focus && focus[1] - focus[0] < 0.8 * (this.t1 - this.t0) ? focus : null,
        files: this.entries.map((en, i) => { const s = srcOf.get(en); return { i, path: en.path, size: en.size, src: s ? s.id : -1, rows: s ? s.n : 0 }; }),
        sources: this.sources.map((s) => ({ id: s.id, path: s.path, kind: s.parser.kind, group: s.parser.group, short: s.parser.short, rows: s.n, t0: s.t0, t1: s.t1, size: s.entry.size, virtual: !!s.entry.virtual })),
        names: { sev: SEV, group: this.groups, tag: this.tagNames, proc: D.proc.names, sub: D.sub.names, cat: D.cat.names, lvl: D.lvl.names, file: this.sources.map((s) => s.path) },
        lvlSev: Array.from(this.lvlSev),
      };
    }

    // ----- search -----
    compile(text, cs) {
      const out = { text: [], fields: [], hl: [], err: null };
      const FIELD = { level: 'level', lvl: 'level', sev: 'level', severity: 'level', process: 'process', proc: 'process', pid: 'pid',
        subsystem: 'subsystem', sub: 'subsystem', area: 'subsystem', category: 'category', cat: 'category', tag: 'tag', source: 'source', src: 'source', file: 'source' };
      const tok = /(-?)(?:(level|lvl|sev|severity|process|proc|pid|subsystem|sub|area|category|cat|tag|source|src|file):)?(?:"((?:[^"\\]|\\.)*)"|\/((?:[^\/\\]|\\.)+)\/(i?)(?=\s|$)|(\S+))/gi;
      let m;
      while ((m = tok.exec(text)) !== null) {
        const neg = m[1] === '-', field = m[2] && FIELD[m[2].toLowerCase()];
        const lit = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[6];
        if (field) { out.fields.push({ neg, field, value: (lit !== undefined ? lit : m[4] || '').toLowerCase() }); continue; }
        if (lit === '' || (lit === undefined && m[4] === undefined)) continue;
        const src = m[4] !== undefined ? m[4] : escapeRx(lit);
        const flags = 'm' + (cs && !m[5] ? '' : 'i');
        try {
          out.text.push({ neg, re: new RegExp(toLatin(src), 'g' + flags), one: new RegExp(toLatin(src), flags) });
          if (!neg) out.hl.push({ src, flags: flags.replace('m', '') });
        } catch (err) { out.err = `Invalid regular expression /${src}/ - ${err.message}`; }
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
        const s = LATIN1.decode(await blob.slice(start, end).arrayBuffer());
        const acc = new Uint8Array(rEnd - r).fill(1), hit = new Uint8Array(rEnd - r);
        for (const term of terms) {
          hit.fill(0);
          const re = term.re;
          re.lastIndex = 0;
          let row = r, m;
          while ((m = re.exec(s)) !== null) {           // jump from match to match; each hit marks its row and skips to the next row
            const pos = start + m.index, j = upperBound(off, pos, row, rEnd) - 1, rowEnd = off[j] + len[j];
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

    async query(q, progress) {
      const run = ++this.run, started = Date.now();
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
        if (!this.textCache || this.textCache.key !== key) this.textCache = { key, files: new Map() };
        const cache = this.textCache.files, jobs = [];
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
          const bm = await this.scanText(S[job.f], job.a, job.b, c.text, run, (n) => { done += n; progress({ phase: 'Searching', label: S[job.f].path, done, total, search: true }); });
          cache.set(job.f, { bm, lo: job.a, hi: job.b });
        }
        if (run !== this.run) throw new Error('superseded');
        bms = S.map((s, f) => (fileOk[f] && cache.has(f) ? cache.get(f).bm : null));
        skipped = fileOk.map((ok, f) => !ok && hi[f] >= 0);     // deselected files were not searched: their counts are unknown
      }

      const nb = Math.max(1, q.bins | 0 || 120), h0 = q.t0 != null ? q.t0 : this.t0, h1 = q.t1 != null ? q.t1 : this.t1 + 1;
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
      const res = { count: n, total: N, hist: { t0: h0, t1: h1, nb, bins: Array.from(hist) }, facets, hl: c.hl, err: c.err, ms: Date.now() - started };
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
        const i = it.i, text = it.text.replace(/[\r\n\0]+$/, ''), f = this.sources[it.s].parser.fields(text);
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
      const run = this.run, v = positions ? Uint32Array.from(positions) : this.view, names = this.info([]).names, clean = (s) => String(s).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n');
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
    add('system/sleep_wake.txt', `${local(base + 20e3, 0)} -0400 Wake                \tWake from Deep Idle [CDNVA] : due to EC.LidOpen/Lid Open\t\n${local(base + span - 600e3, 0)} -0400 Sleep               \tEntering Sleep state due to 'Clamshell Sleep'\t\n`);
    add('reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips',
      `{"app_name":"Microsoft Excel","timestamp":"${local(crash, 0)}.00 -0400","app_version":"16.114","bug_type":"309","os_version":"macOS 15.7.8 (24G824)","name":"Microsoft Excel"}\n{\n  "exception" : {"type":"EXC_BAD_ACCESS","signal":"SIGSEGV","subtype":"KERN_INVALID_ADDRESS at 0x0000000000000018"},\n  "faultingThread" : 0,\n  "threads" : [{"triggered":true,"frames":[{"symbol":"PivotFilterApply","imageIndex":0},{"symbol":"PivotTableUpdate","imageIndex":0}]}]\n}\n`);
    add('reports/crash_summary.txt', `# Crash and hang report summary\n\n## reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips\n"procName":"Microsoft Excel"\n"exception":"EXC_BAD_ACCESS"\n`);

    const M = ['local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,excel_compressed_mb,excel_threads,pressure_level,free_mb,compressor_mb,swap_used_mb'];
    for (let t = base; t < base + span; t += 30e3) {
      const up = t < crash, k = up ? (t - base) / (crash - base) : (t - relaunch) / span;
      if (t > crash && t < relaunch) { M.push(`${local(t, 0)},${stamp(t, 0)},,,,,,2,${900 + (rnd() * 200 | 0)},3100,1800`); continue; }
      const foot = Math.round(up ? 700 + 5600 * k * k : 650 + 900 * k), cmp = Math.round(foot * (up ? 0.25 + 0.3 * k : 0.2));
      M.push(`${local(t, 0)},${stamp(t, 0)},${up ? 4121 : 4307},${(rnd() * (up && k > 0.9 ? 99 : 30)).toFixed(1)},${foot},${cmp},${40 + (rnd() * 12 | 0)},${up && k > 0.85 ? 4 : up && k > 0.6 ? 2 : 1},${Math.round(up ? 5200 - 4700 * k : 4200)},${Math.round(up ? 600 + 4200 * k : 1500)},${Math.round(up ? 3900 * k * k : 1200)}`);
    }
    add('excel_memory_timeline.csv', M.join('\n') + '\n');
    add('manifest.tsv', 'component\tstatus\tdetails\nunified_log_tags\tcomplete\texcel, excel-helper, microsoft, hang-report, mentions-excel, memory, restart, permissions, storage, logs-dropped\nsystem\tcomplete\tsystem, memory, sleep/wake, network state\noffice\tcomplete\tversions, Excel logs, AutoRecover, add-ins, preferences\nreports\tcomplete\tcrash, hang, spin and jetsam reports\nunified_logs\tcomplete\t1 day(s), 2026-03-10 through 2026-03-10\n');
    add('collection.log', '[12:01:02] Excel diagnostics: collect (2026-03-10 through 2026-03-10) for user sample\n[12:01:02] System information\n[12:01:09] Unified logs (Excel, hangs/terminations, memory pressure), 2026-03-10 through 2026-03-10\n[12:03:40] Done.\n');
    add('summary.md', `# Excel diagnostics summary\n\nThis is made-up sample data that ships with the viewer. It tells one story: Excel's memory climbs for an hour and a half, a PivotTable filter pushes it over the limit, and Excel crashes at ${local(crash, 0)} local time and is relaunched.\n\n- Collected: 2026-03-10 12:03:40 EDT\n- Console user: sample\n- Mode: collect\n- Incident window: 2026-03-10 through 2026-03-10 (1 day(s))\n\n## Collection status\n\n| Component | Status | Details |\n| --- | --- | --- |\n| system | complete | system, memory, sleep/wake, network state |\n| office | complete | versions, Excel logs, AutoRecover, add-ins, preferences |\n| reports | complete | crash, hang, spin and jetsam reports |\n| unified_logs | complete | 1 day(s) |\n\n## Things to try\n\n1. Search for \`pivot\`, then press \`e\` to step through the errors.\n2. Drag across the spike in the histogram to zoom in on the crash.\n3. Open the Memory tab and click just before the drop.\n`);
    return files;
  }

  return { Dataset, sampleBundle, SEV, stamp, isoAt, offStr };
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
  };
  self.onmessage = async (ev) => {
    const { id, op, args } = ev.data;
    try { postMessage({ id, result: await api[op](args || {}) }); }
    catch (err) { postMessage({ id, error: (err && err.message) || String(err) }); }
  };
}
