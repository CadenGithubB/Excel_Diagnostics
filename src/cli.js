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

