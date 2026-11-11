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
