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
