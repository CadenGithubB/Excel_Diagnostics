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
      this.tagNames = []; this.zone = []; this.entries = []; this.sources = []; this.reportList = [];
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
      // inputs: [{path, blob}] - one zip, or the files of an unzipped bundle, or loose log files.
      // loose: true marks a zip that is known to be one of a bundle's own files, to be listed and not opened.
      const zips = inputs.filter((f) => !f.loose && /\.zip$/i.test(f.path));
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
      const add = (t, kind, proc, path, what) => {
        if (t !== t) return;
        lines.push(`${stamp(t)}\t${kind}\t${proc}\t${path}\t${what.replace(/[\t\r\n]+/g, ' ')}`);
        this.reportList.push({ t, kind, proc, path });   // also handed to the page, which marks them on the memory charts
      };
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
        lvlSev: Array.from(this.lvlSev), reports: this.reportList,
      };
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
          out.notes.push({ text: `"${w}" has nothing after the colon, so it was searched for as plain text. Write the value straight after it with no space, for example ${w.toLowerCase()}${w.toLowerCase() === 'pid:' ? '4121' : 'excel'}.` });
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
      const tok = /(-?)(?:(level|lvl|sev|severity|process|proc|pid|subsystem|sub|area|category|cat|tag|source|src|file):)?(?:"((?:[^"\\]|\\.)*)"|\/((?:[^\/\\]|\\.)+)\/(i?)(?=\s|$)|(\S+))/gi;
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
        try {
          out.text.push({ neg, re: new RegExp(toLatin(src), 'g' + flags), one: new RegExp(toLatin(src), flags) });
          if (!neg) out.hl.push({ src, flags: flags.replace('m', '') });
        } catch (err) {
          out.err = `Invalid regular expression /${src}/ - ${err.message}`;
          out.notes.push({ text: `/${src}/ is not a valid regular expression (${String(err.message).replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '')}), so it was left out of the search. To search for those characters as plain text, put them in quotation marks.` });
        }
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
        else if (t.field === 'tag') { if (!p.mask) c.notes.push({ text: `${t.said}: no tag in this bundle contains "${v}", so ${effect}. The tags here are ${list(this.tagNames)}.` }); }
        else if (!p.table.some((x) => x)) {
          const where = { level: `The levels here are ${list([...new Set(SEV.concat(D.lvl.names))])}. level: matches from the start of the name.`,
            process: like(D.proc.names), subsystem: like(D.sub.names), category: like(D.cat.names), source: `The sources here are ${list(this.groups)}; source: also matches file paths.` }[t.field];
          // field: lets the page or the command line add where its own list of these names is
          c.notes.push({ field: t.field, text: `${t.said}: no ${t.field} in this bundle ${t.field === 'level' ? 'starts with' : 'contains'} "${v}", so ${effect}.${where ? ' ' + where.trim() : ''}` });
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

    const procs = [['Microsoft Excel', 4307, 688, 141], ['WindowServer', 388, 512, 96], ['Browser Helper (Renderer)', 2110, 474, 310], ['Chat Helper (Renderer)', 1532, 431, 288], ['Mail', 911, 302, 120],
      ['Browser', 2101, 260, 88], ['Finder', 640, 148, 61], ['OneDrive', 1145, 96, 58], ['Dock', 633, 71, 30], ['Spotlight', 702, 64, 22], ['Notes', 1290, 58, 19], ['Terminal', 3320, 44, 8]];
    const snapAt = base + span + 220e3;
    add('system/system_info.txt', '=== Hardware ===\nHardware:\n\n    Hardware Overview:\n\n      Model Name: MacBook Pro\n      Chip: Apple M1 Pro\n      Total Number of Cores: 10\n      Memory: 16 GB\n');
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
    add('manifest.tsv', 'component\tstatus\tdetails\nunified_log_tags\tcomplete\texcel, excel-helper, microsoft, hang-report, mentions-excel, memory, restart, permissions, storage, logs-dropped\nsystem\tcomplete\tsystem, memory, sleep/wake, network state\noffice\tcomplete\tversions, Excel logs, AutoRecover, add-ins, preferences\nreports\tcomplete\tcrash, hang, spin and jetsam reports\nunified_logs\tcomplete\t1 day(s), 2026-03-10 through 2026-03-10\n');
    add('collection.log', '[12:01:02] Excel diagnostics: collect (2026-03-10 through 2026-03-10) for user sample\n[12:01:02] System information\n[12:01:09] Unified logs (Excel, hangs/terminations, memory pressure), 2026-03-10 through 2026-03-10\n[12:03:40] Done.\n');
    add('summary.md', `# Excel diagnostics summary\n\nThis is made-up sample data that ships with the viewer. It tells one story: Excel's memory climbs for an hour and a half, a PivotTable filter pushes it over the limit, and Excel crashes at ${local(crash, 0)} local time and is relaunched.\n\n- Collected: 2026-03-10 12:03:40 EDT\n- Console user: sample\n- Mode: collect\n- Incident window: 2026-03-10 through 2026-03-10 (1 day(s))\n\n## Collection status\n\n| Component | Status | Details |\n| --- | --- | --- |\n| system | complete | system, memory, sleep/wake, network state |\n| office | complete | versions, Excel logs, AutoRecover, add-ins, preferences |\n| reports | complete | crash, hang, spin and jetsam reports |\n| unified_logs | complete | 1 day(s) |\n\n## Things to try\n\n1. Search for \`pivot\`, then press \`e\` to step through the errors.\n2. Drag across the spike in the histogram to zoom in on the crash.\n3. Open the Memory tab and click just before the drop.\n`);
    return files;
  }

  return { Dataset, sampleBundle, SEV, stamp, isoAt, offStr, readZip, Entry };
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

const VERSION = '1.0';
const SEV = Core.SEV;
const VIEWER_URL = 'https://cadengithubb.github.io/Excel_Diagnostics/';

try { new DecompressionStream('deflate-raw'); } catch (e) {       // older Node: inflate zip members with zlib instead
  globalThis.DecompressionStream = class { constructor() { return Duplex.toWeb(zlib.createInflateRaw()); } };
}

// ---------- small helpers ----------
const fmtN = (n) => Number(n).toLocaleString('en-US');
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const z2 = (n, w = 2) => String(n).padStart(w, '0');
const plural = (n, one, many = one + 's') => `${fmtN(n)} ${n === 1 ? one : many}`;
const lines = [];
const say = (s = '') => lines.push(s);
// The command was not understood: exit status 2. The message is written for a person at a shell. `why` holds the
// same refusal as data, so request mode can word it for a model, which is shown argument names and not options.
class Usage extends Error {
  constructor(message, why) { super(message); this.why = why || null; }
}

const RUNTIME = typeof Deno !== 'undefined' ? 'deno run -A' : 'node';
const shq = (s) => (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
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
function walk(root, top, loose) {
  const inputs = [];
  const go = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch (err) { continue; }      // a dangling link
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
async function unpack(zipPath) {
  const st = fs.statSync(zipPath);
  const dir = path.join(cacheDir(), unpackedName(zipPath, st)), marker = path.join(dir, '.unpacked');
  if (fs.existsSync(marker)) return dir;
  process.stderr.write(`Unpacking ${path.basename(zipPath)} (${fmtBytes(st.size)}) into ${dir} ...\n`);
  // Unpacked beside its final place and moved there whole, so that another process opening the same zip at the
  // same moment (a program may make two requests at once) never reads a half-written folder.
  const part = `${dir}.part-${process.pid}`;
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(part, { recursive: true, mode: 0o700 });
  const file = new DiskBlob(zipPath, 0, st.size);
  try {
    for (const e of await Core.readZip(file)) {
      const parts = e.path.split('/').filter(Boolean);
      if (!parts.length || parts.includes('..') || /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$)/.test(e.path)) continue;
      const dest = path.join(part, ...parts);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const fd = fs.openSync(dest, 'w');
      try {
        for await (const c of new Core.Entry(e.path, e.size, null, { file, e }).chunks(false)) for (let n = 0; n < c.length;) n += fs.writeSync(fd, c, n, c.length - n);
      } finally { fs.closeSync(fd); }
    }
    fs.writeFileSync(path.join(part, '.unpacked'), `${path.resolve(zipPath)}\n`);
    try { fs.renameSync(part, dir); } catch (err) {
      if (fs.existsSync(marker)) throw err;                // the other process got there first, with the same files: handled below
      fs.rmSync(dir, { recursive: true, force: true });    // what is in the way was left half-done by an earlier run
      fs.renameSync(part, dir);
    }
  } catch (err) {
    if (!fs.existsSync(marker)) throw err;
  } finally { fs.rmSync(part, { recursive: true, force: true }); }
  process.stderr.write(cacheRoot ? 'Unpacked.\n' : `Unpacked. Later commands on this zip reuse that folder; "${RUNTIME} ${shq(SCRIPT)} clean" deletes it.\n`);
  return dir;
}

// ---------- the open bundle ----------
let ds = null, info = null, utc = false;
// loose: a zip found among the files of the folder or zip being opened is one of the bundle's files. Request mode
// asks for that, because the bundle it opens was chosen by name. Without it the engine takes such a zip to be the
// bundle, which is right when a person points this tool or the page at a zip and its checksum together.
async function open(arg, loose) {
  let inputs;
  if (arg === 'sample') inputs = Core.sampleBundle(1);
  else {
    let st;
    try { st = fs.statSync(arg); } catch (err) {
      throw new Usage(`There is no file or folder at ${arg}.\nGive the path to an Excel_Diagnostics_....zip, to the unzipped folder, or to a log file. The word "sample" in its place opens built-in made-up data.`, { why: 'no-bundle' });
    }
    if (st.isDirectory()) inputs = walk(arg, `${path.basename(path.resolve(arg))}/`, loose);
    else if (/\.zip$/i.test(arg)) inputs = walk(await unpack(arg), '', loose);
    else inputs = [{ path: path.basename(arg), blob: new DiskBlob(arg, 0, st.size) }];
    if (!inputs.length) throw new Usage(`${arg} is an empty folder.`, { why: 'empty-bundle' });
  }
  ds = new Core.Dataset();
  const tty = process.stderr.isTTY;
  let last = '';
  info = await ds.load(inputs, (p) => {
    if (!tty) return;
    const s = `${p.phase}${p.total ? ` ${Math.round((p.done / p.total) * 100)}%` : ''}`;
    if (s !== last) { last = s; process.stderr.write(`\r${s.padEnd(40)}`); }
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
function parseTime(str, option) {
  const s = String(str).trim();
  let m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?)?\s*(Z|UTC|[+-]\d\d:?\d\d)?$/i.exec(s);
  if (!m) {
    const tm = /^(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,6}))?)?$/.exec(s), day = fmtTime(info.t0, false).slice(0, 10);
    if (tm && day === fmtTime(info.t1, false).slice(0, 10)) m = [s, day.slice(0, 4), day.slice(5, 7), day.slice(8, 10), tm[1], tm[2], tm[3], tm[4]];
    else if (tm) throw new Usage(`${option} ${s} has no date, and this bundle covers more than one day (${fmtTime(info.t0, false)} to ${fmtTime(info.t1, false)}). Write it like "${fmtTime(info.t1, false)}".`, { why: 'time-no-date', option, value: s, from: fmtTime(info.t0, false), to: fmtTime(info.t1, false) });
  }
  if (!m) {
    const like = info.total ? fmtTime(info.t0, false) : '2026-03-10 09:15:00', zone = zoneSaid().replace(/ \(add.*/, '');
    throw new Usage(`${option} "${s}" is not a time this tool can read. Write it like "${like}" (YYYY-MM-DD HH:MM:SS; seconds are optional, and so is the time of day). It is read in ${zone}, unless it ends in Z or an offset such as -05:00.`, { why: 'time', option, value: s, like, zone });
  }
  const naive = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0, +String(m[7] || '0').padEnd(3, '0').slice(0, 3));
  if (m[8]) return naive - (/^(z|utc)$/i.test(m[8]) ? 0 : Core.offStr(m[8])) * 60000;
  return naive - offsetAt(naive - offsetAt(naive) * 60000) * 60000;
}
function parseSpan(str, option) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|d)?$/i.exec(String(str).trim());
  if (!m) throw new Usage(`${option} "${str}" is not a length of time. Write a number and a unit: 500ms, 30s, 5m, 2h or 1d.`, { why: 'span', option, value: String(str) });
  return +m[1] * { ms: 1, s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000 }[(m[2] || 's').toLowerCase()];
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
    const half = parseSpan(o.window === undefined ? '60s' : o.window, '--window'), c = await anchorTime(o.around, '--around');
    q.t0 = c - half; q.t1 = c + half + 1;
    said.window = `${fmtSpan(half)} either side of ${fmtTime(c)}`;
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
const flat = (s) => String(s).replace(/\r?\n/g, '\\n').replace(/\t/g, ' ');
function printRows(rows, { wide, mark } = {}) {
  if (!rows.length) return;
  const N = info.names, idW = Math.max(2, String(rows.reduce((a, r) => Math.max(a, r[0]), 0)).length + (mark === undefined ? 0 : 1));
  const cells = rows.map((r) => {
    let msg = flat(r[9]);
    if (!wide && msg.length > 220) msg = `${msg.slice(0, 220)}... [+${fmtN(msg.length - 220)} characters; --wide or "show ${r[0]}" has the rest]`;
    else if (r[10]) msg += ` ... [cut at 2,048 bytes; "show ${r[0]}" has the rest]`;
    const proc = (N.proc[r[4]] || '-') + (r[5] ? `[${r[5]}]` : '');
    return [(r[0] === mark ? '>' : '') + r[0], fmtTime(r[1]), N.lvl[r[3]] || SEV[info.lvlSev[r[3]]], info.sources[r[2]].short, proc.length > 34 ? proc.slice(0, 33) + '~' : proc, msg];
  });
  const w = [idW, 23, ...[2, 3, 4].map((k) => cells.reduce((a, c) => Math.max(a, c[k].length), k === 2 ? 5 : 6))];
  say(['ID'.padStart(w[0]), 'TIME'.padEnd(w[1]), 'LEVEL'.padEnd(w[2]), 'SOURCE'.padEnd(w[3]), 'PROCESS[PID]'.padEnd(w[4]), 'MESSAGE'].join('  '));
  for (const c of cells) say([c[0].padStart(w[0]), c[1].padEnd(w[1]), c[2].padEnd(w[2]), c[3].padEnd(w[3]), c[4].padEnd(w[4]), c[5]].join('  '));
}
const notesFor = (r, nothing) => (r.notes || []).filter((n) => !n.soft || nothing);     // a soft note is only worth saying when nothing matched
const countable = (n) => n.field && n.field !== 'level' && n.field !== 'source';        // the note names a field whose values "count" can list
function sayNotes(r, nothing) {
  for (const n of notesFor(r, nothing)) say(`Note: ${n.text}${countable(n) ? ` To list every ${n.field}: ${run(`count --by ${n.field}`)}` : ''}`);
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
  const src = info.sources.filter((s) => s.rows), w = src.reduce((a, s) => Math.max(a, s.short.length), 6);
  say(`${indent}${'ENTRIES'.padStart(9)}  ${'SOURCE'.padEnd(w)}  ${'FIRST'.padEnd(19)}  ${'LAST'.padEnd(19)}  FILE`);
  for (const s of src.slice(0, 40)) say(`${indent}${num(s.rows).padStart(9)}  ${s.short.padEnd(w)}  ${fmtTime(s.t0, false)}  ${fmtTime(s.t1, false)}  ${s.path}`);
  return Math.max(0, src.length - 40);
}
function reportKinds() {                                  // kind -> how many reports of it
  const kinds = new Map();
  for (const x of info.reports) kinds.set(x.kind, (kinds.get(x.kind) || 0) + 1);
  return kinds;
}
function sayReports(list) {
  const kw = list.reduce((a, x) => Math.max(a, x.kind.length), 4), pw = Math.min(30, list.reduce((a, x) => Math.max(a, (x.proc || '-').length), 7));
  say(`${'TIME'.padEnd(19)}  ${'KIND'.padEnd(kw)}  ${'PROCESS'.padEnd(pw)}  FILE`);
  for (const x of list) say(`${fmtTime(x.t, false)}  ${x.kind.padEnd(kw)}  ${(x.proc || '-').slice(0, pw).padEnd(pw)}  ${x.path}`);
}

// What entries can be counted by, as the engine names each, and the search field that picks one of its values out.
const BY = { severity: 'sev', level: 'lvl', source: 'group', tag: 'tag', process: 'proc', subsystem: 'sub', category: 'cat', file: 'file' };
const BY_FIELD = { severity: 'level', level: 'level', source: 'source', tag: 'tag', process: 'process', subsystem: 'subsystem', category: 'category', file: 'source' };
const termFor = (by, name) => `${BY_FIELD[by]}:${/\s/.test(name) ? `"${name}"` : name}`;
function largest(r, q, field, n) {                        // the n values of a field with the most matches: [[value id, entries]], and how many values there are
  const f = r.facets[BY[field]];
  const vals = f.values.filter(([v, c]) => c > 0 && (BY[field] !== 'lvl' || !q.levelOk || q.levelOk.has(v)));
  return { vals: vals.slice().sort((a, b) => b[1] - a[1]).slice(0, n), all: vals.length < f.values.length ? vals.length : f.all };
}

// The stretch of the timeline around an entry or a moment: entries a up to (not including) b, and the one to mark.
// With a window that is everything inside it, however many; the caller decides how much of it to show.
async function stretch(anchor, isId, before, after, window) {
  let id, t;
  if (isId) { id = +anchor; t = await anchorTime(anchor, 'context'); }
  else {
    t = parseTime(anchor, 'context');
    await ds.query({ bins: 1 }, () => {});
    id = ds.seek(t);
  }
  if (window === undefined) return { id, t, a: Math.max(0, id - before), b: Math.min(info.total, id + after + 1) };
  const half = parseSpan(window, '--window'), r = await ds.query({ t0: t - half, t1: t + half + 1, bins: 1 }, () => {});
  const a = r.count ? ds.view[0] : 0, b = a + r.count;      // with no filter the matches are one unbroken run of the timeline
  return { id: r.count ? Math.min(Math.max(id, a), b - 1) : id, t, half, a, b };
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
const memoryFiles = () => MEMORY_FILES.map(([kind, title, rx]) => ({ kind, title, files: info.files.filter((f) => f.size && rx.test(f.path)) })).filter((g) => g.files.length);
const MEMORY_COLUMNS = [['excel_footprint_mb', ' MB'], ['excel_cpu_pct', '%'], ['excel_threads', ''], ['free_mb', ' MB'], ['swap_used_mb', ' MB']];
const PRESSURE = { 1: 'normal', 2: 'warning', 4: 'critical' };
// For each of those columns: the sample (a row of the file) with its lowest value, the one with its highest, and
// the last value. Also the pressure levels and the Excel process IDs seen (null when the file has no such column).
async function memoryTimeline(csv) {
  const rows = new TextDecoder().decode((await ds.fileChunk(csv.i, 0, 16 << 20)).bytes).split(/\r?\n/).filter(Boolean), head = (rows[0] || '').split(',');
  const col = (name) => head.indexOf(name), data = rows.slice(1).map((l) => l.split(',')), stats = [];
  for (const [name, unit] of MEMORY_COLUMNS) {
    const k = col(name), vals = data.map((d) => [parseFloat(d[k]), d]).filter((v) => v[0] === v[0]);
    if (k < 0 || !vals.length) continue;
    stats.push({ name, unit, lo: vals.reduce((a, v) => (v[0] < a[0] ? v : a)), hi: vals.reduce((a, v) => (v[0] > a[0] ? v : a)), last: vals[vals.length - 1][0] });
  }
  const lv = col('pressure_level'), pid = col('excel_pid');
  return { data, col, stats, levels: lv < 0 ? [] : [...new Set(data.map((d) => d[lv]).filter(Boolean))], pids: pid < 0 ? null : [...new Set(data.map((d) => d[pid]).filter(Boolean))] };
}

// ---------- commands ----------
const COMMANDS = {
  async summary(o) {
    const r = await ds.query({ bins: 1 }, () => {}), mode = collectorMode(info.name);
    const has = (p) => info.files.some((f) => f.path === p && f.size);
    say(`Bundle: ${info.name}${mode ? ` (the collector ran in ${mode} mode)` : ''}`);
    say(`Files: ${fmtN(info.files.length)}, ${fmtBytes(info.files.reduce((a, f) => a + f.size, 0))} in all`);
    if (!info.total) {
      say('Entries on the timeline: none. No file here is a log with timestamps this tool recognises.');
      say(); say('Next:'); say(`  List the files:   ${run('files')}`); say(`  Print one:        ${run('cat PATH')}`);
      return;
    }
    say(`Entries on the timeline: ${fmtN(info.total)}, from ${fmtTime(info.t0, false)} to ${fmtTime(info.t1, false)} (${fmtSpan(info.t1 - info.t0)})`);
    say(`Times are shown in ${zoneSaid()}.`);
    if (info.focus) say(`The macOS and Excel logs cover ${fmtTime(info.focus[0], false)} to ${fmtTime(info.focus[1], false)}; entries outside that come from other sources, such as install history, sleep and wake records and reports.`);
    const top = (name, n) => r.facets[name].values.filter(([, c]) => c > 0).slice(0, n).map(([v, c]) => `${info.names[name][v] || '(none)'} ${fmtN(c)}`).join(', ');
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
    say(`  Entries from Excel itself:          ${run('search tag:excel')}`);
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
      say(`  All ${fmtN(r.count)} to a file:   ${again('export', o, pos, ['limit', 'offset', 'last', 'wide'], '--out matches.tsv')}`);
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
      for (const [v, c] of vals) say(`  ${fmtN(c).padStart(11)}  ${((c / r.count) * 100).toFixed(1).padStart(5)}%  ${info.names[BY[field]][v] || '(none)'}`);
      if (all > vals.length) say(`  ... and ${fmtN(all - vals.length)} more ${field} values with fewer entries${n < 60 ? ` (--limit up to 60 lists more)` : '; narrow the search to see them'}.`);
      return vals;
    };
    let first = null;
    if (o.by) first = table(o.by, limit)[0];
    else for (const f of ['severity', 'source', 'tag', 'process']) { const v = table(f, 8); if (f === 'process') first = v[0]; }
    say(); say('Next:');
    if (!o.by) say(`  A longer list for one field:   ${again('count', o, pos, ['limit'], '--by process')}   (or severity, level, source, tag, subsystem, category, file)`);
    const name = first ? info.names[BY[o.by || 'process']][first[0]] : '';
    if (name) say(`  The entries behind one line:   ${again('search', o, [...pos, termFor(o.by || 'process', name)], ['by', 'limit'])}`);
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
    say(`Severity:   ${SEV[sev]}${lvl && lvl.toLowerCase() !== SEV[sev].toLowerCase() ? `  (the log's own level name is "${lvl}")` : ''}`);
    say(`Source:     ${src.group}  -  ${src.path}`);
    if (N.proc[r[4]]) say(`Process:    ${N.proc[r[4]]}${r[5] ? `  (PID ${r[5]})` : ''}`);
    if (N.sub[r[6]]) say(`Subsystem:  ${N.sub[r[6]]}`);
    if (N.cat[r[7]]) say(`Category:   ${N.cat[r[7]]}`);
    const tags = N.tag.filter((_, b) => (r[8] >> b) & 1);
    if (tags.length) say(`Tags:       ${tags.join(', ')}`);
    for (const [k, v] of Object.entries(d.extra || {})) if (v) say(`${(k[0].toUpperCase() + k.slice(1) + ':').padEnd(11)} ${flat(v)}`);
    say(); say('Message:'); say(r[9]);
    const brace = r[9].indexOf('{');
    if (brace >= 0 && r[9].length < 400000) { try { const j = JSON.parse(r[9].slice(brace)); if (j && typeof j === 'object') { say(); say('The JSON in that message, laid out:'); say(JSON.stringify(j, null, 2)); } } catch (e) { /* not JSON */ } }
    if (r[10]) { say(); say('This entry is longer than 2 MB; the rest is not shown.'); }
    say(); say('Next:');
    say(`  What was logged around it:        ${run(`context ${id}`)}`);
    if (N.proc[r[4]]) say(`  Only this process, a minute either side:   ${run(`search ${shq(`process:${/\s/.test(N.proc[r[4]]) ? `"${N.proc[r[4]]}"` : N.proc[r[4]]}`)} --around ${id} --window 1m`)}`);
    if (d.extra && d.extra.file) say(`  The report file itself:           ${run(`cat ${shq(d.extra.file)}`)}`);
  },

  async context(o, pos) {
    if (!pos.length) throw new Usage(`"context" needs an entry ID or a time to centre on. For example: ${run('context 1234')}  or  ${run('context "2026-03-10 09:15:20"')}`);
    if (pos.length === 2 && /^\d{4}-\d\d-\d\d$/.test(pos[0]) && /^\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(pos[1])) pos = [`${pos[0]} ${pos[1]}`];
    if (pos.length > 1) throw new Usage(`"context" takes one entry ID or one time (put a time in quotation marks). To filter what is shown around a moment, use: ${run(`search WORDS --around ${shq(pos[0])} --window 1m`)}`);
    const before = o.before === undefined ? 10 : wholeNumber(o.before, '--before', 0, 2000), after = o.after === undefined ? 10 : wholeNumber(o.after, '--after', 0, 2000);
    const exact = /^\d+$/.test(pos[0]);
    let { id, t, half, a, b } = await stretch(pos[0], exact, before, after, o.window);
    if (o.window !== undefined) {
      if (a === b) { say(`Nothing was logged within ${fmtSpan(half)} either side of ${fmtTime(t)}. A longer --window, or no --window at all, shows the nearest entries.`); return; }
      if (b - a > 2000) {
        say(`${fmtN(b - a)} entries fall within ${fmtSpan(half)} either side; the 2,000 nearest are shown. A shorter --window, or "search" with --around, narrows it.`);
        a = Math.max(a, id - 1000); b = Math.min(b, a + 2000);
      }
    }
    const rows = (await ds.readRows(Array.from({ length: b - a }, (_, i) => a + i), 2048)).map((x) => x.row);
    say(exact ? `Entries ${fmtN(a)} to ${fmtN(b - 1)}: everything logged around entry ${id}, from every source, with no filter. Entry ${id} is marked with >.`
      : `Entries ${fmtN(a)} to ${fmtN(b - 1)}: everything logged around ${fmtTime(t)}, from every source, with no filter. The first entry at or after that time is marked with >.`);
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
    say('Each is one file that macOS or Excel wrote when the thing happened; KIND is taken from the file.');
    say(); sayReports(list);
    const x = list[list.length - 1];
    say(); say('Next (shown for the newest report):');
    say(`  Read the report:                     ${run(`cat ${shq(x.path)}`)}`);
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
    for (const x of hits.slice(0, limit)) say(`${fmtBytes(x.size).padStart(10)}  ${(onTimeline(x) ? fmtN(x.rows) : '-').padStart(11)}  ${x.path}`);
    if (hits.length > limit) say(`... and ${fmtN(hits.length - limit)} more. Add --all, or part of a path: ${run('files reports')}`);
    say(); say('Next:');
    say(`  Print a file:                  ${run(`cat ${shq(hits[0].path)}`)}`);
    const log = hits.find(onTimeline);
    if (log) say(`  One log's entries by time:     ${run(`search ${shq(`source:${log.path}`)}`)}`);
  },

  async cat(o, pos) {
    if (pos.length !== 1) throw new Usage(`"cat" takes the path of one file in the bundle, as "files" prints it. For example: ${run('cat summary.md')}`);
    const hits = findFiles(pos[0]), f = hits[0];
    if (!hits.length) throw new Usage(`There is no file "${pos[0]}" in this bundle. ${run('files')} lists them; part of a path is enough when only one file has it.`);
    if (hits.length > 1) throw new Usage(`"${pos[0]}" is part of ${fmtN(hits.length)} paths. Give more of the one you want:\n${hits.slice(0, 20).map((x) => `  ${x.path}`).join('\n')}${hits.length > 20 ? '\n  ...' : ''}`);
    const got = await fileLines(f), all = got.all, cut = got.cut;
    say(`File: ${f.path} (${fmtBytes(got.size)})${onTimeline(f) ? `. Its ${fmtN(f.rows)} entries are also on the timeline: ${run(`search ${shq(`source:${f.path}`)}`)}` : ''}`);
    if (got.empty) { say('The file is empty.'); return; }
    if (got.binary) {
      say(ODL.test(f.path) ? ODL_SAID : 'This is a binary file, so it is not printed. Its place on disk, when the bundle is a folder, is the same path under the bundle folder.');
      return;
    }
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
      if (hit.length) { say(); say('Next:'); say(`  The lines around a match:   ${run(`cat ${shq(f.path)} --lines ${Math.max(1, hit[0] + 1 - 10)}-${hit[0] + 11}`)}`); }
      return;
    }
    say(`Lines ${fmtN(from)} to ${fmtN(to)} of ${fmtN(all.length)}${cut ? ` (only the first ${fmtBytes(READ_CAP)} of the file was read)` : ''}:`);
    say();
    for (let i = from - 1; i < to; i++) say(all[i]);
    if (to < all.length || from > 1) {
      say(); say('Next:');
      if (to < all.length) say(`  The next lines:              ${run(`cat ${shq(f.path)} --lines ${to + 1}-${Math.min(all.length, to + 200)}`)}`);
      say(`  Only lines containing text:  ${run(`cat ${shq(f.path)} --grep TEXT`)}`);
      if (!o.all && o.lines === undefined) say(`  The whole file:              ${run(`cat ${shq(f.path)} --all`)}`);
    }
  },

  async memory() {
    const groups = memoryFiles().map((g) => [g.title, g.files]);
    const r = await ds.query({ text: 'tag:memory', bins: 1 }, () => {});
    say('What this bundle recorded about memory. The figures are as the collector and macOS wrote them; nothing here is interpreted.');
    if (!groups.length && !r.count) { say(); say('It holds no memory files and no log entries tagged memory.'); return; }
    for (const [title, files] of groups) { say(); say(`${title}:`); for (const f of files.slice(0, 12)) say(`  ${fmtBytes(f.size).padStart(10)}  ${f.path}`); if (files.length > 12) say(`  ... and ${fmtN(files.length - 12)} more`); }
    const csv = (memoryFiles().find((g) => g.kind === 'timeline') || { files: [] }).files[0];
    if (csv) {
      const { data, stats, levels, pids } = await memoryTimeline(csv);
      say(); say(`${csv.path}: ${plural(data.length, 'sample')}${data.length ? `, from ${data[0][0]} to ${data[data.length - 1][0]} (the Mac's local time, as written in the file)` : ''}`);
      for (const s of stats) say(`  ${s.name}: lowest ${fmtN(s.lo[0])}${s.unit} at ${s.lo[1][0]}, highest ${fmtN(s.hi[0])}${s.unit} at ${s.hi[1][0]}, last ${fmtN(s.last)}${s.unit}`);
      if (levels.length) say(`  pressure_level values seen: ${levels.map((v) => `${v} (${PRESSURE[v] || 'unknown'})`).join(', ')}`);
      if (pids) say(`  Excel process IDs seen: ${pids.length ? pids.join(', ') : 'none (Excel was not running at any sample)'}`);
    }
    say(); say(`Log entries tagged memory (kernel memory-pressure and jetsam messages): ${fmtN(r.count)}`);
    say(); say('Next:');
    const firstFile = groups.length ? groups[0][1][0] : null;
    if (firstFile) say(`  Print one of those files:        ${run(`cat ${shq(firstFile.path)}`)}`);
    if (r.count) { say(`  The memory entries:              ${run('search tag:memory')}`); say(`  When they were logged:           ${run('histogram tag:memory')}`); }
    if (info.reports.some((x) => x.kind === 'Jetsam')) say(`  Every report, with its time:     ${run('reports')}`);
  },

  async export(o, pos) {
    if (o.out === undefined) throw new Usage(`"export" needs --out and a file name to write, for example: ${again('export', o, pos, [], '--out matches.tsv')}`);
    const { q, said } = await buildQuery(o, pos), r = await ds.query(q, () => {});
    say(heading(said));
    sayNotes(r, !r.count);
    if (!r.count) { say(`0 of ${fmtN(r.total)} entries match, so no file was written.`); await sayWhyNothing(q, r, said, o); return; }
    const blob = await ds.exportTsv(() => {});
    fs.writeFileSync(o.out, new Uint8Array(await blob.arrayBuffer()));
    say(`Wrote ${plural(r.count, 'entry', 'entries')} to ${path.resolve(o.out)} (${fmtBytes(blob.size)}).`);
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
  level:error             The level starts with "error". Also: fault, warning, default, info, debug, and Excel's
                          own level names (medium, monitorable, unexpected).
  tag:memory              The entry carries this tag. Tags: excel, excel-helper, mentions-excel, microsoft,
                          hang-report, memory, restart, permissions, storage, logs-dropped.
  source:unified          The log it came from: part of a file path or of a source name ("summary" lists them).
  pid:4121  subsystem:com.apple.TCC  category:xpc      The other fields.

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
    export: `export [WORDS] --out FILE [search options]\n  Write every matching entry to FILE as tab-separated text: utc_time, severity, level, source, process, pid,\n  subsystem, category, tags, message. An existing FILE is replaced.`,
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
 * it cut something and not otherwise; and nothing says why anything happened. The work is done by the helpers the
 * text commands use, and where one of those refuses in words meant for a shell, the refusal is worded again here.
 */
const OPS = ['summary', 'search', 'count', 'histogram', 'show', 'context', 'reports', 'files', 'read_file', 'memory'];
const TAKES_UTC = new Set(['summary', 'search', 'count', 'histogram', 'show', 'context', 'reports', 'memory']);
const TEXT_MOST = 24000;                                  // characters of text in one answer
const ENTRY_BYTES = 64 << 10;                             // of each entry read for a listing; a longer one is read again by itself
const MORE = '\u2026';                                  // an ellipsis: it ends anything that was cut short

// An answer of ok:false that the caller can put right by sending something else.
class Refusal extends Error {
  constructor(error, field, hint, more) { super(error); Object.assign(this, { field, hint }, more); }
}

// The request being answered: its arguments as sent, the bundle they were read as, and the notes gathered so far.
let P = {};
const R = { op: '', id: '', named: false, ids: [], notes: [], bundlesDir: null, cacheDir: null, option: {} };
const note = (s) => { if (!R.notes.includes(s)) R.notes.push(s); };
const said = () => lines.splice(0);                       // what the shared printers "said", taken back as lines of text

// ---------- reading arguments ----------
// A model leaves an argument out in more than one way: by omitting it, with null, or with an empty string.
const absent = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
const kindOf = (v) => (Array.isArray(v) ? 'A list' : typeof v === 'object' ? 'An object' : typeof v === 'string' ? 'A string' : typeof v === 'boolean' ? 'true or false' : 'A number');
const quoted = (s) => JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}${MORE}` : s);     // an argument said back, never at length

// The example in a refusal is the value that was sent, as a string, whenever that is what was meant; an invented
// example is one more thing a model can copy in place of a real value.
function text(name, example, keepSpaces) {
  const v = P[name];
  if (absent(v)) return undefined;
  if (typeof v !== 'string') {
    const like = example || (typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
    throw new Refusal(`${name} must be a string`, name, `Send ${name} as a string in quotation marks${like ? `, for example ${JSON.stringify(like)}` : ''}. ${kindOf(v)} was sent.`);
  }
  return keepSpaces ? v : v.trim();
}
const timeLike = () => (info && info.total ? fmtTime(info.t0, false) : '');      // a time that is really in this bundle, to show how one is written
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
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Refusal(`${name} must be a whole number`, name, `Send ${name} as a whole number without quotation marks, ${least} or more. ${typeof v === 'number' ? 'A number that is not whole' : kindOf(v)} was sent.`);
  if (v < least) throw new Refusal(`${name} is too small`, name, `${name} must be ${least} or more; ${v} was sent. Send a larger whole number${usual === undefined ? '' : `, or leave ${name} out`}.`);
  if (most !== undefined && v > most) { note(`${name} ${v} is more than this tool returns in one call; ${most} was used.`); return most; }
  return v + 0;                                           // a minus zero becomes zero
}

// ---------- saying things ----------
const tool = (op) => `excel_diag_${op}`;
const braces = (o) => `{${Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}}`;
// A call the model could make next, written the way it would send it. It stays on the bundle and the clock of this
// call: without that, a follow-up to a call that named an older bundle would quietly go to the newest one.
const call = (op, a = {}) => `${tool(op)} ${braces({ ...a, ...(utc && TAKES_UTC.has(op) ? { utc: true } : {}), ...(R.named ? { bundle: R.id } : {}) })}`;
// At most three calls, each with what it gives, then leave to stop: a result that ends on an instruction is obeyed.
const nextSaid = (steps) => (steps.length ? `${steps.slice(0, 3).map(([c, gives]) => `${c} ${gives}.`).join(' ')} If this answers the question, reply now.` : undefined);
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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

// Text is kept within what one answer may hold by leaving out whole lines: from the end, or from the start when
// the end is what matters. Returns how many of the item lines stay.
function fit(head, items, fromStart) {
  let size = head.reduce((a, l) => a + l.length + 1, 0), kept = 0;
  const at = (k) => items[fromStart ? items.length - 1 - k : k];
  while (kept < items.length && size + at(kept).length <= TEXT_MOST) size += at(kept++).length + 1;
  return kept;
}

// ---------- refusals ----------
const noEntry = (field, id) => new Refusal('no such entry', field, `No entry has id ${id}. Entry ids in this bundle run from 0 to ${info.total - 1}. Copy an id from the ID column of ${tool('search')} or ${tool('context')}; do not guess one.`);
function needTimeline() {
  if (!info.total) throw new Refusal('this bundle has no timeline entries', undefined, `No file in bundle ${R.id} is a log with timestamps this tool recognises, so there are no entries to show. ${call('files')} lists its files and ${tool('read_file')} reads one.`);
}
// The shell's refusals, worded again for a model. The option a refusal names becomes the argument that was sent.
function reworded(err) {
  const w = err.why, field = R.option[w.option] || String(w.option || '').replace(/^--/, '');
  if (w.why === 'time') return new Refusal(`${field} is not a time`, field, `${quoted(w.value)} cannot be read as a time. Write ${field} the way results print times, for example "${w.like}" (YYYY-MM-DD HH:MM:SS; the seconds and the time of day are optional). It is read in ${w.zone}, unless it ends in Z or an offset such as -05:00.`);
  if (w.why === 'time-no-date') return new Refusal(`${field} has no date`, field, `This bundle covers more than one day (${w.from} to ${w.to}), so ${field} needs a date. Write it like "${w.to}".`);
  if (w.why === 'span') return new Refusal(`${field} is not a length of time`, field, `Send ${field} as a number and a unit in one string: "500ms", "30s", "2m", "1h" or "1d". ${quoted(w.value)} was sent.`);
  if (w.why === 'around-with-span') {
    const around = R.option['--around'], span = absent(P.from) ? 'to' : 'from';
    return new Refusal(`${around} and ${span} cannot be used together`, around, `Send ${around} with window for everything around one moment, or from and to for a fixed span, not both.`);
  }
  if (w.why === 'window-alone') return new Refusal('window needs aroundId or aroundTime', 'window', `window is the length of time either side of aroundId or aroundTime, so send one of those with it. For a fixed span, leave window out and send from and to, written the way results print times.`);
  if (w.why === 'from-after-to') return new Refusal('from is not earlier than to', 'from', `from was read as ${fmtTime(w.from, false)} and to as ${fmtTime(w.to, false)}. Send a from that is earlier than to.`);
  if (w.why === 'severity') return new Refusal('minSeverity is not a severity', 'minSeverity', `Send minSeverity as one of: ${SEV.map((s) => s.toLowerCase()).join(', ')} (lowest to highest). ${quoted(w.value)} was sent.`);
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
    try { st = fs.statSync(path.join(dir, name)); } catch (err) { continue; }      // a dangling link
    const zip = st.isFile() && /\.zip$/i.test(name), id = zip ? name.replace(/\.zip$/i, '') : name, had = found.get(id);
    if ((!zip && !st.isDirectory()) || !id) continue;
    if (!had || (had.zip && !zip)) found.set(id, { id, file: path.join(dir, name), zip, mtime: st.mtimeMs });      // a folder is used before a zip of the same id: there is nothing to unpack
  }
  return [...found.values()].sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? 1 : -1));
}
const idsSaid = (ids) => `${ids.slice(0, 10).join(', ')}${ids.length > 10 ? `, and ${ids.length - 10} more` : ''}`;
function pickBundle(list, want) {
  if (!list.length) {
    throw new Refusal('no bundles are available', undefined, 'Ask the human to copy an Excel_Diagnostics_....zip file, or the unzipped folder, into the Excel diagnostics bundles folder on the OpenClaw host. Do not call these tools again until the human says that is done.');
  }
  if (want === undefined) return list[0];
  const low = want.toLowerCase(), same = list.filter((b) => b.id === want), alike = same.length ? same : list.filter((b) => b.id.toLowerCase() === low);
  if (alike.length === 1) return alike[0];
  const hits = alike.length ? alike : list.filter((b) => b.id.toLowerCase().includes(low));
  if (hits.length === 1) { note(`bundle ${quoted(want)} was read as ${hits[0].id}.`); return hits[0]; }
  if (hits.length) throw new Refusal('bundle matches more than one bundle', 'bundle', `${quoted(want)} is part of ${hits.length} bundle ids. Send one of the candidates, whole, as bundle.`, { candidates: hits.slice(0, 10).map((b) => b.id) });
  throw new Refusal('no such bundle', 'bundle', `No bundle id is or contains ${quoted(want)}. The bundles here, newest first: ${idsSaid(list.map((b) => b.id))}. Send one of these ids as bundle, or leave bundle out for the newest; do not guess an id.`);
}
async function openBundle(b, others) {
  const instead = others.length ? `Other bundles here: ${idsSaid(others)}. Send one of them as bundle.` : 'Ask the human to copy the bundle into the Excel diagnostics bundles folder again.';
  try { await open(b.file, true); } catch (err) {
    const why = err instanceof Usage && err.why ? err.why.why : '';
    if (why === 'empty-bundle' || /^No files found/.test(String(err && err.message))) throw new Refusal('the bundle is empty', 'bundle', `Bundle ${b.id} holds no files. ${instead}`);
    if (why === 'no-bundle') throw new Refusal('the bundle is no longer there', 'bundle', `Bundle ${b.id} was removed while it was being opened. ${instead}`);
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    // What went wrong is passed on as it was reported. Why it went wrong is not guessed at: the human can look.
    const said = err && typeof err.code === 'string' ? `Bundle ${b.id} could not be read on the OpenClaw host (${err.code}). Tell the human that, with the code.`
      : `Bundle ${b.id} could not be read${b.zip ? ' as a zip file' : ''}: ${scrub(String((err && err.message) || err)).replace(/[.!?]*$/, '.')} Tell the human that.`;
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
      if (/\.part-\d+$/.test(name)) { if (Date.now() - st.mtimeMs > PART_KEPT_MS) fs.rmSync(full, { recursive: true, force: true }); continue; }
      const zip = fs.readFileSync(path.join(full, '.unpacked'), 'utf8').trim();      // no marker: not made here, so it stays
      let zst = null;
      try { zst = fs.statSync(zip); } catch (err) { if (err.code !== 'ENOENT') continue; }
      if (!zst || name !== unpackedName(zip, zst)) fs.rmSync(full, { recursive: true, force: true });
    } catch (err) { /* left as it is */ }
  }
}

// ---------- what search, count and histogram share ----------
// Their filter arguments, checked, and turned into the options the text commands take. `same` is the arguments as
// they would be sent again, for the calls a result suggests.
function filters() {
  const f = { query: text('query') || '', from: text('from', timeLike()), to: text('to', timeLike()), aroundId: whole('aroundId', 0),
    aroundTime: text('aroundTime', timeLike()), window: text('window', '30s'), minSeverity: text('minSeverity', 'error'), matchCase: flag('matchCase') };
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
  const { q, said: read } = await buildQuery(f.o, f.query), r = await ds.query(q, () => {});
  for (const n of notesFor(r, !r.count)) note(`${n.text}${countable(n) ? ` ${call('count', { by: n.field })} lists every ${n.field}.` : ''}`);
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
  if (info.total) receipt.timeZone = zone();
  if (hit) {
    const a = { ...f.same };
    if (hit.window !== undefined) for (const k of ['from', 'to', 'aroundId', 'aroundTime', 'window']) delete a[k];
    else if (hit.sev) delete a.minSeverity;
    else if (hit.cs) delete a.matchCase;
    else a.query = hit.text || undefined;
    steps.push([call(op, a), `is this call without ${without(hit)}, which ${hit.count === 1 ? '1 entry matches' : `${hit.count} entries match`}`]);
  }
  steps.push(info.total ? [call('summary'), 'shows what this bundle holds'] : [call('files'), 'lists the files in this bundle']);
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

// ---------- the operations ----------
const OP = {
  async summary() {
    const receipt = { bundle: R.id }, mode = collectorMode(R.id), steps = [];
    if (mode) receipt.collectorMode = mode;
    Object.assign(receipt, { files: info.files.length, bytes: info.files.reduce((a, f) => a + f.size, 0), entries: info.total });
    const out = [];
    if (!info.total) {
      note('No file in this bundle is a log with timestamps this tool recognises, so it has no timeline entries.');
      steps.push([call('files'), `lists the ${count(info.files.length, 'file')} in this bundle`]);
    } else {
      const r = await ds.query({ bins: 1 }, () => {});
      const counted = (name) => r.facets[name].values.filter(([, c]) => c > 0).map(([v, c]) => [info.names[name][v] || '(none)', c]);
      receipt.period = { from: fmtTime(info.t0, false), to: fmtTime(info.t1, false) };
      if (info.focus) receipt.mainPeriod = { from: fmtTime(info.focus[0], false), to: fmtTime(info.focus[1], false) };
      receipt.timeZone = zone();
      receipt.bySeverity = Object.fromEntries(counted('sev'));
      receipt.byTag = Object.fromEntries(counted('tag'));
      receipt.topProcesses = counted('proc').slice(0, 8).map(([name, entries]) => ({ process: name, entries }));
      receipt.processes = r.facets.proc.all;
      const more = saySources('', String);
      out.push(...said());
      if (more) { receipt.truncated = true; note(`${out.length - 1 + more} log sources are on the timeline and ${out.length - 1} of them are listed. ${call('count', { by: 'file' })} lists the sources with the most entries.`); }
      if (info.focus) out.push(`Note: The macOS and Excel logs cover ${receipt.mainPeriod.from} to ${receipt.mainPeriod.to} (mainPeriod). Entries outside that come from other sources, such as install history, sleep and wake records and reports.`);
      const errors = r.facets.sev.values.reduce((a, [v, c]) => a + (v >= 4 ? c : 0), 0);
      if (errors) steps.push([call('search', { minSeverity: 'error' }), `lists the ${count(errors, 'error or fault', 'errors and faults')}`]);
    }
    receipt.reports = { total: info.reports.length, byKind: Object.fromEntries(reportKinds()) };
    receipt.availableBundles = R.ids.slice(0, 10);
    receipt.bundles = R.ids.length;
    if (info.reports.length) steps.push([call('reports'), `lists the ${count(info.reports.length, 'report file')} with ${info.reports.length === 1 ? 'its time' : 'their times'}`]);
    // Install history and old reports can stretch the whole period over years; intervals over that say nothing.
    if (info.total) steps.push(info.focus
      ? [call('histogram', { from: receipt.mainPeriod.from, to: receipt.mainPeriod.to }), 'shows when entries were logged in the main period']
      : [call('histogram'), 'shows when entries were logged']);
    const notesOut = bundleNotes(), kept = fit(out, notesOut);
    return { receipt, text: [...out, ...notesOut.slice(0, kept)].join('\n'), next: nextSaid(steps) };
  },

  async search() {
    const f = filters(), limit = whole('limit', 1, 80, 20), offset = whole('offset', 0), newest = flag('newest'), maxChars = whole('maxChars', 1, 2000, 200);
    if (newest && offset !== undefined) throw new Refusal('newest and offset cannot be used together', 'offset', 'Send newest: true for the last matches, or offset to skip that many matches from the first, not both.');
    const { q, r, read, receipt } = await matched(f);
    if (!r.count) return nothing('search', f, q, r, read, receipt);
    const start = newest ? Math.max(0, r.count - limit) : offset || 0;
    if (start >= r.count) throw new Refusal('offset is past the last match', 'offset', `${r.count === 1 ? 'Only 1 entry matches' : `Only ${r.count} entries match`}, so offset can be from 0 to ${r.count - 1}. Leave offset out to start from the first match.`);
    const rows = await listed(Array.from(ds.view.subarray(start, start + limit)), maxChars);
    printRows(rows, { wide: true });
    const out = said(), kept = fit(out.slice(0, 1), out.slice(1)), last = start + kept;
    if (kept < rows.length) note(`These entries are long: ${kept} of the ${rows.length} asked for fit in one result. nextOffset continues after them.`);
    receipt.shown = { first: start + 1, last };
    receipt.truncated = last < r.count || (newest && start > 0);
    if (last < r.count) receipt.nextOffset = last;
    receipt.timeZone = zone();
    const id = rows[0][0], page = { ...f.same, ...(absent(P.limit) ? {} : { limit }), ...(absent(P.maxChars) ? {} : { maxChars }) };
    const steps = [[call('context', { id }), `shows what every source logged around entry ${id}, the first listed`]];
    const onward = last < r.count ? [call('search', { ...page, offset: last }), `lists the matches after these ${kept}`] : newest && start > 0 ? [call('search', { ...page, offset: Math.max(0, start - limit) }), 'lists the matches before these'] : null;
    // Paging through hundreds of matches gets a small model nowhere; counting them by process is the way in.
    if (onward && r.count > 5 * limit) steps.push(onward, [call('count', { ...f.same, by: 'process' }), `counts all ${r.count} matches by process`]);
    else { steps.push([call('show', { id }), 'gives that entry in full']); if (onward) steps.push(onward); }
    return { receipt, text: out.slice(0, 1 + kept).join('\n'), next: nextSaid(steps) };
  },

  async count() {
    const f = filters(), by = text('by', 'process'), limit = whole('limit', 1, 60, 20), field = by === undefined ? undefined : by.toLowerCase();
    if (field !== undefined && !Object.hasOwn(BY, field)) {
      const guess = closest(field, Object.keys(BY));
      throw new Refusal('by is not something entries can be counted by', 'by', `Send by as one of: ${Object.keys(BY).join(', ')}.${guess ? ` The nearest to what was sent is ${guess}.` : ''}`);
    }
    if (field === undefined && !absent(P.limit)) note('limit is used only when by is given, so it changed nothing here.');
    const { q, r, read, receipt } = await matched(f);
    if (!r.count) return nothing('count', f, q, r, read, receipt);
    const values = (name, n) => { const { vals, all } = largest(r, q, name, n); return { list: vals.map(([v, c]) => ({ value: info.names[BY[name]][v] || '(none)', entries: c })), more: all - vals.length }; };
    const steps = [];
    let top;
    if (field) {
      const v = values(field, limit);
      Object.assign(receipt, { by: field, values: v.list, moreValues: v.more });
      if (v.more > 0) receipt.truncated = true;
      top = v.list[0];
    } else {
      Object.assign(receipt, { bySeverity: values('severity', 8).list, bySource: values('source', 8).list, byTag: values('tag', 8).list, byProcess: values('process', 8).list });
      top = receipt.byProcess[0];
    }
    if (top && top.value !== '(none)') {
      const { query, ...rest } = f.same;
      steps.push([call('search', { query: [query, termFor(field || 'process', top.value)].filter(Boolean).join(' '), ...rest }), `lists the entries behind the largest ${field || 'process'} value, ${top.value}`]);
    }
    if (field && receipt.moreValues > 0 && limit < 60) {
      const all = receipt.values.length + receipt.moreValues;      // offered as the size to ask for when one call can list them all
      steps.push(all <= 60 ? [call('count', { ...f.same, by: field, limit: all }), `lists all ${all} ${field} values`] : [call('count', { ...f.same, by: field, limit: 60 }), `lists more ${field} values`]);
    }
    if (!field) steps.push([call('count', { ...f.same, by: 'process' }), 'lists more processes; by can also be severity, level, source, tag, subsystem, category or file']);
    if (receipt.from || receipt.to) receipt.timeZone = zone();
    return { receipt, next: nextSaid(steps) };
  },

  async histogram() {
    const f = filters(), bins = whole('bins', 1, 60, 24);
    const { q, r, read, receipt } = await matched(f);
    if (!r.count) return nothing('histogram', f, q, r, read, receipt);
    // The engine's own histogram is not used. It places an entry by multiplying by a rounded scale, so one logged
    // exactly on a boundary can fall either side, and its boundaries fall between seconds. Here each interval is a
    // whole number of seconds from a whole second, so the times printed are the real boundaries, and a search from
    // one to the next returns the entries counted between them. (Only a window that itself starts or ends between
    // seconds keeps a boundary there, at that end.)
    const T = ds.g.T, view = ds.view, lo = q.t0 != null ? q.t0 : T[view[0]], hi = q.t1 != null ? q.t1 : T[view[view.length - 1]] + 1;
    const h0 = Math.floor(lo / 1000) * 1000, step = Math.max(1, Math.ceil((hi - h0) / bins / 1000)) * 1000, nb = Math.max(1, Math.ceil((hi - h0) / step));
    const end = q.t1 != null ? q.t1 : h0 + nb * step, counts = new Uint32Array(nb * 3);
    for (let k = 0; k < view.length; k++) {
      const i = view[k], sv = ds.lvlSev[ds.g.L[i]];
      counts[Math.min(nb - 1, Math.max(0, Math.floor((T[i] - h0) / step))) * 3 + (sv >= 4 ? 2 : sv === 3 ? 1 : 0)]++;
    }
    if (!absent(P.bins) && nb < bins) note(`${count(nb, 'interval covers', 'intervals cover')} this span, fewer than the bins asked for: each interval is a whole number of seconds long.`);
    const total = (b) => counts[b * 3] + counts[b * 3 + 1] + counts[b * 3 + 2], from = (b) => fmtTime(h0 + b * step, false), to = (b) => fmtTime(Math.min(h0 + (b + 1) * step, end), false);
    const out = ['ERRORS counts errors and faults.', `${'START'.padEnd(19)}  ${'ENTRIES'.padStart(9)}  ${'ERRORS'.padStart(8)}  ${'WARNINGS'.padStart(8)}`];
    let fullest = 0, empty = 0;
    const gap = () => { if (empty) out.push(`(${count(empty, 'interval')} with no entries)`); empty = 0; };
    for (let b = 0; b < nb; b++) {
      if (total(b) > total(fullest)) fullest = b;
      if (!total(b)) { empty++; continue; }
      gap();
      out.push(`${from(b)}  ${String(total(b)).padStart(9)}  ${String(counts[b * 3 + 2]).padStart(8)}  ${String(counts[b * 3 + 1]).padStart(8)}`);
    }
    gap();
    Object.assign(receipt, { intervals: nb, intervalLength: lengthSaid(step), from: from(0), to: fmtTime(end, false), fullest: { from: from(fullest), to: to(fullest), entries: total(fullest) }, timeZone: zone() });
    const same = { ...f.same, from: receipt.fullest.from, to: receipt.fullest.to };
    for (const k of ['aroundId', 'aroundTime', 'window']) delete same[k];
    return { receipt, text: out.join('\n'), next: nextSaid([[call('search', same), 'lists the entries in the fullest interval']]) };
  },

  async show() {
    const id = whole('id', 0), maxChars = whole('maxChars', 1, 20000, 4000);
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
    receipt.messageChars = msg.length;
    receipt.truncated = msg.length > maxChars || !!r[10];
    const steps = [];
    if (r[10]) note('This entry is longer than 2 MB. Only its first 2 MB was read, and messageChars counts that part.');
    if (msg.length > maxChars) {
      // The size offered is this message's own length where one call can return it: a model shown the largest
      // size a call takes sends that size from then on, for every entry.
      if (maxChars < 20000) steps.push(msg.length <= 20000 ? [call('show', { id, maxChars: msg.length }), 'gives the whole message'] : [call('show', { id, maxChars: 20000 }), 'gives more of the message']);
      else note(`This message has ${msg.length} characters. The first ${maxChars} are shown, and one call returns no more than that.`);
    }
    steps.push([call('context', { id }), 'shows what every source logged around it']);
    if (receipt.reportFile) steps.push([call('read_file', { path: receipt.reportFile }), 'reads the report file itself']);
    return { receipt, text: clip(msg, maxChars), next: nextSaid(steps) };
  },

  async context() {
    const id = whole('id', 0), time = text('time', timeLike()), before = whole('before', 0, 40, 8), after = whole('after', 0, 40, 8), window = text('window', '30s'), maxChars = whole('maxChars', 1, 2000, 200);
    needTimeline();
    if (id !== undefined && time !== undefined) throw new Refusal('id and time cannot be used together', 'time', 'Send id to centre on an entry, or time to centre on a moment, not both.');
    if (id === undefined && time === undefined) throw new Refusal('id or time is missing', 'id', `Send one of the two: id, a whole number copied from the ID column of ${tool('search')} results, or time, written the way results print times. Do not guess an id.`);
    if (id !== undefined && id > info.total - 1) throw noEntry('id', id);
    R.option.context = id !== undefined ? 'id' : 'time';
    if (window !== undefined && !(absent(P.before) && absent(P.after))) note('before and after are not used when window is given.');
    const s = await stretch(id !== undefined ? String(id) : time, id !== undefined, before, after, window), anchor = s.id, receipt = {};
    let { a, b } = s, cut = false;
    if (window !== undefined) {
      receipt.entriesInWindow = b - a;
      if (a === b) {
        note(`Nothing was logged within ${fmtSpan(s.half)} either side of ${fmtTime(s.t, false)}.`);
        Object.assign(receipt, { entries: 0, truncated: false, timeZone: zone() });
        return { receipt, next: nextSaid([[call('context', id !== undefined ? { id } : { time }), 'shows the entries nearest to it, however far off they are']]) };
      }
      if (b - a > 80) {
        note(`${b - a} entries were logged within ${fmtSpan(s.half)} either side, and the 80 nearest to the anchor are listed. A shorter window lists them all; ${tool('search')} with aroundId and a query lists only some.`);
        a = Math.max(a, anchor - 40); b = Math.min(b, a + 80); a = Math.max(s.a, b - 80);
        cut = true;
      }
    }
    const rows = await listed(Array.from({ length: b - a }, (_, i) => a + i), maxChars), at = rows.find((x) => x[0] === anchor);
    printRows(rows, { wide: true, mark: anchor });
    const out = said(), asked = rows.length;
    // The entry the call is about has to stay, so when not everything fits, lines go from whichever end is further from it.
    let lo = 1, hi = out.length, size = out.reduce((n, l) => n + l.length + 1, -1);
    while (size > TEXT_MOST && hi - lo > 1) { if (anchor - a - (lo - 1) >= (hi - 2) - (anchor - a)) size -= out[lo++].length + 1; else size -= out[--hi].length + 1; }
    if (hi - lo < asked) { cut = true; note(`These entries are long: ${hi - lo} of the ${asked} around the anchor fit in one result. A smaller maxChars fits more of them.`); }
    b = a + hi - 1; a += lo - 1;
    if (id === undefined) note(at[1] >= s.t ? `The anchor is entry ${anchor}, the first entry at or after ${fmtTime(s.t, false)}.` : `No entry ${window !== undefined ? 'in the window ' : ''}is at or after ${fmtTime(s.t, false)}, so the anchor is the entry nearest before it, ${anchor}.`);
    Object.assign(receipt, { anchorId: anchor, anchorTime: fmtTime(at[1], false), shown: { firstId: a, lastId: b - 1 }, entries: b - a, truncated: cut, timeZone: zone() });
    const steps = [[call('show', { id: anchor }), 'gives the anchor entry in full']], proc = info.names.proc[at[4]];
    if (window === undefined && (before < 40 || after < 40)) steps.push([call('context', { id: anchor, before: Math.min(40, Math.max(16, before * 2)), after: Math.min(40, Math.max(16, after * 2)) }), 'shows more either side']);
    steps.push(proc ? [call('search', { query: termFor('process', proc), aroundId: anchor, window: '1m' }), `lists only what ${proc} logged within a minute either side`]
      : [call('search', { aroundId: anchor, window: '1m', minSeverity: 'warning' }), 'lists only warnings and worse within a minute either side']);
    return { receipt, text: [out[0], ...out.slice(lo, hi)].join('\n'), next: nextSaid(steps) };
  },

  async reports() {
    const all = info.reports.slice().sort((a, b) => a.t - b.t), newest = all.slice(-80), receipt = { reports: all.length, byKind: Object.fromEntries(reportKinds()) };
    if (!all.length) {
      note('This bundle holds no crash, hang, spin, jetsam or other diagnostic report files.');
      Object.assign(receipt, { shown: 0, truncated: false });
      return { receipt, next: nextSaid(info.total ? [[call('search', { minSeverity: 'error' }), 'lists errors and faults in the logs instead']] : []) };
    }
    sayReports(newest);
    const out = said(), kept = fit(out.slice(0, 1), out.slice(1), true), x = newest[newest.length - 1];
    if (kept < all.length) note(`This bundle holds ${all.length} report files and the ${kept} newest are listed. Each report is also a timeline entry: ${call('search', { query: 'source:"crash and hang reports"' })} lists them all, oldest first.`);
    Object.assign(receipt, { shown: kept, truncated: kept < all.length, timeZone: zone() });
    const steps = [[call('read_file', { path: x.path }), 'reads the newest report']];
    if (info.total) steps.push([call('context', { time: fmtTime(x.t, false), window: '1m' }), 'shows what every source logged in the minute before and after it']);
    return { receipt, text: [out[0], ...out.slice(out.length - kept)].join('\n'), next: nextSaid(steps) };
  },

  async files() {
    const filter = text('filter'), limit = whole('limit', 1, 80, 60), offset = whole('offset', 0, undefined, 0);
    const hits = info.files.filter((x) => !filter || x.path.toLowerCase().includes(filter.toLowerCase())), receipt = {};
    if (filter) receipt.filter = filter;
    receipt.files = hits.length;
    if (filter) receipt.filesInBundle = info.files.length;
    receipt.bytes = hits.reduce((a, x) => a + x.size, 0);
    if (!hits.length) {
      note(`No file path in this bundle contains ${quoted(filter)}.`);
      receipt.truncated = false;
      return { receipt, next: nextSaid([[call('files'), `lists all ${count(info.files.length, 'file')} in this bundle`]]) };
    }
    if (offset >= hits.length) throw new Refusal('offset is past the last file', 'offset', `${hits.length === 1 ? 'Only 1 file is' : `Only ${hits.length} files are`} listed${filter ? ' for this filter' : ''}, so offset can be from 0 to ${hits.length - 1}. Leave offset out to start from the first.`);
    const page = hits.slice(offset, offset + limit), head = `${'SIZE'.padStart(10)}  ${'TIMELINE_ENTRIES'.padStart(16)}  PATH`;
    const rows = page.map((x) => `${fmtBytes(x.size).padStart(10)}  ${(onTimeline(x) ? String(x.rows) : '-').padStart(16)}  ${x.path}`), kept = fit([head], rows), last = offset + kept;
    if (kept < page.length) note(`These paths are long: ${kept} of the ${page.length} asked for fit in one result. nextOffset continues after them.`);
    Object.assign(receipt, { shown: { first: offset + 1, last }, truncated: last < hits.length });
    if (last < hits.length) receipt.nextOffset = last;
    const steps = [[call('read_file', { path: page[0].path }), 'reads the first file listed']];
    if (last < hits.length) steps.push([call('files', { filter, ...(absent(P.limit) ? {} : { limit }), offset: last }), 'lists the files after these']);
    return { receipt, text: [head, ...rows.slice(0, kept)].join('\n'), next: nextSaid(steps) };
  },

  async read_file() {
    const typed = text('path'), fromLine = whole('fromLine', 1, undefined, 1), limit = whole('limit', 1, 80, 80), grep = text('grep', '', true);
    if (typed === undefined) throw new Refusal('path is missing', 'path', `Send path: a path copied from the PATH column of ${tool('files')} or the FILE column of ${tool('reports')}. Do not guess one.`);
    const hits = findFiles(typed), f = hits[0];
    if (!hits.length) throw new Refusal('no such file in this bundle', 'path', `No file in this bundle has ${quoted(typed)} as its path, as its name or as part of its path. Copy a path from the PATH column of ${tool('files')}; do not guess one.`);
    if (hits.length > 1) {
      throw new Refusal('path matches more than one file', 'path', `${quoted(typed)} is part of ${hits.length} paths. Send one of the candidates, whole, as path.${hits.length > 20 ? ` The first 20 are given; ${call('files', { filter: typed })} lists them all.` : ''}`, { candidates: hits.slice(0, 20).map((x) => x.path) });
    }
    if (f.path !== typed) note(`path ${quoted(typed)} was read as ${f.path}.`);
    // A bundle copied by hand can hold a file this account may not read. That is the file's fault, not the program's.
    const got = await fileLines(f).catch((err) => { throw (err && typeof err.code === 'string' ? new Refusal('the file cannot be read', 'path', `${f.path} could not be opened on the OpenClaw host (${err.code}). Tell the human, or choose another file from ${tool('files')}.`) : err); });
    const receipt = { path: f.path, bytes: got.size }, steps = [], source = [call('search', { query: termFor('file', f.path) }), "lists this file's entries on the timeline, by time"];
    if (got.binary) {
      throw new Refusal('binary file', 'path', `${ODL.test(f.path) ? `${f.path}: ${ODL_SAID}` : `${f.path} is not text, so it cannot be read here.`} Choose another file from ${tool('files')}.`);
    }
    const all = got.all || [], total = all.length;
    receipt.lines = total;
    if (!total) {
      note(got.empty ? 'This file is empty.' : 'This file holds no lines of text.');
      receipt.truncated = false;
      return { receipt };
    }
    if (got.cut) note(`Only the first ${fmtBytes(READ_CAP)} of this file was read. lines counts that part, and nothing after it can be read here.`);
    if (fromLine > total) throw new Refusal('fromLine is past the last line', 'fromLine', `${f.path} has ${count(total, 'line')}, so fromLine can be from 1 to ${total}. Leave fromLine out to start from the first line.`);
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
    const rows = picked.map((i) => (grep === undefined ? clip(all[i], 400) : `${i + 1}: ${clip(all[i], 400)}`)), kept = fit([], rows);
    if (kept < picked.length) note(`These lines are long: ${kept} of the ${picked.length} asked for fit in one result. nextFromLine continues after them.`);
    if (kept) {
      const toLine = picked[kept - 1] + 1;
      receipt.shown = { fromLine: picked[0] + 1, toLine };
      receipt.truncated = grep === undefined ? toLine < total : kept < onward;
      if (receipt.truncated) {
        receipt.nextFromLine = toLine + 1;
        steps.push([call('read_file', { path: f.path, fromLine: toLine + 1, ...(absent(P.limit) ? {} : { limit }), grep }), grep === undefined ? 'reads the lines after these' : 'lists the matching lines after these']);
      }
      if (grep !== undefined) steps.push([call('read_file', { path: f.path, fromLine: Math.max(1, picked[0] + 1 - 10), limit: 21 }), `reads the lines around line ${picked[0] + 1}, the first match listed`]);
    } else {
      receipt.truncated = false;
      note(matchedLines ? `No line from line ${fromLine} on contains ${quoted(grep)}; ${count(matchedLines, 'earlier line does', 'earlier lines do')}.` : `No line of this file contains ${quoted(grep)}. Capitals are ignored.`);
    }
    if (onTimeline(f)) { receipt.timelineEntries = f.rows; steps.push(source); }
    if (grep !== undefined) Object.assign(receipt, { grep, matchedLines });
    return { receipt, text: rows.slice(0, kept).join('\n'), next: nextSaid(steps) };
  },

  async memory() {
    const groups = memoryFiles(), receipt = { files: [] }, steps = [];
    let unlisted = 0;
    for (const g of groups) {
      for (const f of g.files.slice(0, 12)) receipt.files.push({ kind: g.kind, path: f.path, bytes: f.size });
      unlisted += Math.max(0, g.files.length - 12);
    }
    if (unlisted) {
      Object.assign(receipt, { filesNotListed: unlisted, truncated: true });
      note(`${count(unlisted, 'more memory file is', 'more memory files are')} in this bundle than files lists. ${call('files', { filter: groups.find((g) => g.files.length > 12).files[0].path.replace(/[^/]*$/, '') || 'JetsamEvent' })} lists them.`);
    }
    const csv = (groups.find((g) => g.kind === 'timeline') || { files: [] }).files[0];
    if (csv) {
      const m = await memoryTimeline(csv), k = m.col('utc_time'), tl = { path: csv.path, samples: m.data.length };
      // The file gives each sample's time twice. The UTC one is used, so these times are on the receipt's clock like every other.
      const at = (d) => { const t = k < 0 ? NaN : Core.isoAt(String(d[k] || ''), 0); return t === t ? fmtTime(t, false) : String(d[0] || ''); };
      if (m.data.length) { tl.from = at(m.data[0]); tl.to = at(m.data[m.data.length - 1]); }
      for (const s of m.stats) tl[camel(s.name)] = { lowest: { value: s.lo[0], at: at(s.lo[1]) }, highest: { value: s.hi[0], at: at(s.hi[1]) }, last: s.last };
      if (m.levels.length) tl.pressureLevels = m.levels.map((v) => ({ level: +v === +v ? +v : v, name: PRESSURE[v] || 'unknown' }));
      if (m.pids) tl.excelPids = m.pids.map((v) => (+v === +v ? +v : v));
      receipt.timeline = tl;
      if (k < 0) note("The memory timeline has no utc_time column, so its times are the Mac's local time as written in the file.");
      else if (m.data.length) receipt.timeZone = zone();
    }
    receipt.memoryEntries = info.total ? (await ds.query({ text: 'tag:memory', bins: 1 }, () => {})).count : 0;
    if (!receipt.files.length && !receipt.memoryEntries) note('This bundle holds no memory files and no log entries tagged memory.');
    if (receipt.files.length) steps.push([call('read_file', { path: receipt.files[0].path }), 'reads the first of those files']);
    if (receipt.memoryEntries) steps.push([call('search', { query: 'tag:memory' }), `lists the ${count(receipt.memoryEntries, 'entry', 'entries')} tagged memory`]);
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
  if (req.params !== undefined && req.params !== null && (typeof req.params !== 'object' || Array.isArray(req.params))) throw new Refusal('params is not an object', undefined, 'Send the arguments as one JSON object, for example {"query": "pivot"}.');
  const sample = req.allowSample === true;
  if (req.bundlesDir === undefined || req.bundlesDir === null) { if (!sample) throw new Refusal('the request has no bundlesDir'); } else if (typeof req.bundlesDir !== 'string' || !path.isAbsolute(req.bundlesDir)) throw new Refusal('bundlesDir is not an absolute path');
  if (req.cacheDir !== undefined && req.cacheDir !== null) {
    if (typeof req.cacheDir !== 'string' || !path.isAbsolute(req.cacheDir)) throw new Refusal('cacheDir is not an absolute path');
    // Unpacked zips must not turn up as bundles of their own, and nothing is ever written among the bundles.
    if (req.bundlesDir && !path.relative(path.resolve(req.bundlesDir), path.resolve(req.cacheDir)).startsWith('..')) throw new Refusal('cacheDir is inside bundlesDir');
    cacheRoot = R.cacheDir = req.cacheDir;
  }
  R.op = req.op; R.bundlesDir = req.bundlesDir || null;
  P = req.params || {};
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
    R.ids = ['sample', ...list.map((b) => b.id)];
    await open('sample');
    R.id = 'sample';
  } else {
    const b = pickBundle(list, want);
    R.ids = list.map((x) => x.id);
    await openBundle(b, R.ids.filter((x) => x !== b.id));
    R.id = b.id;
  }
  const out = await OP[req.op](), doc = { ok: true, bundle: R.id, notes: R.notes, receipt: out.receipt };
  if (out.text) doc.text = out.text;
  if (out.next) doc.next = out.next;
  return doc;
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
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  doc.error = 'the Excel diagnostics program failed';
  doc.hint = `Tell the human that ${R.op ? tool(R.op) : 'the Excel diagnostics program'} failed with: ${scrub(String((err && err.message) || err)).slice(0, 300).replace(/[.!?]*$/, '.')} Do not send the same call again.`;
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
      say(`Could not finish: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  }
  // line the commands of each "Next:" list up under one another
  for (let i = 0; i < lines.length; i++) {
    if (!/^Next( \(.*\))?:$/.test(lines[i])) continue;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) { const m = /^  (.*?):\s{2,}((?:node|deno run -A) .*)$/.exec(lines[j]); if (!m) break; block.push([j, m[1], m[2]]); }
    const w = block.reduce((a, x) => Math.max(a, x[1].length), 0);
    for (const [j, label, command] of block) lines[j] = `  ${(label + ':').padEnd(w + 1)}  ${command}`;
  }
  const text = lines.join('\n') + '\n';
  if (process.exitCode) process.stderr.write(text); else process.stdout.write(text);
}
if (lastFd) fs.closeSync(lastFd.fd);
