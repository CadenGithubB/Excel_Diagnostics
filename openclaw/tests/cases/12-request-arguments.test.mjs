// Request mode: arguments that are wrong, and requests that are broken.
//
// A small model guesses argument names and types, sends numbers as strings, and repeats a call that failed unless
// the failure tells it what to send. So a wrong value must come back as a JSON document that is an ordinary answer
// (exit status 0), with ok:false, the argument at fault in "field", a short lower-case "error", and a "hint" that
// says what to send instead, in argument names and never in shell options. A crash, an empty reply or a shell-style
// message here is what turns one bad call into a loop.
import * as os from 'node:os';
import { describe, it, assert, request, sampleBundlesDir, emptyDir, cleanup, SAMPLE_ID } from '../harness.mjs';

let cacheDir = null;
async function send(req, raw) {
  const r = await request(req, raw === undefined ? {} : { input: raw });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object' && !Array.isArray(r.json), `standard output is not a JSON document: ${r.stdout.slice(0, 200)}`);
  assert.equal(r.stdout, `${JSON.stringify(r.json)}\n`, 'standard output holds the document, a line break and nothing else');
  for (const dir of [os.tmpdir(), os.homedir()]) assert.ok(!r.stdout.includes(dir), `a path of this machine is in the output: ${dir}`);
  return r.json;
}
async function ask(op, params, extra = {}) {
  cacheDir ??= await emptyDir('cache');
  return send({ format: 1, op, bundlesDir: await sampleBundlesDir(), cacheDir, params, ...extra });
}
const ARGUMENTS = new Set(['aroundId', 'aroundTime', 'minSeverity', 'matchCase', 'maxChars', 'fromLine']);      // the only words in an error that are not lower case
// A refusal as the model has to be able to use it.
function refused(d, field, label) {
  assert.equal(d.ok, false, `${label}: was not refused: ${JSON.stringify(d).slice(0, 300)}`);
  assert.equal(d.field, field, `${label}: field. ${JSON.stringify(d)}`);
  assert.ok(typeof d.error === 'string' && d.error.length > 3 && d.error.length <= 60, `${label}: error is not short: ${d.error}`);
  assert.ok(d.error.split(' ').every((w) => w === w.toLowerCase() || ARGUMENTS.has(w)) && !/[.!]$/.test(d.error), `${label}: error is not a short lower-case phrase: ${d.error}`);
  assert.ok(typeof d.hint === 'string' && d.hint.length > 20, `${label}: no hint`);
  assert.ok(!/--[a-z]|\bnode\b|deno run|\.mjs/.test(`${d.error} ${d.hint}`), `${label}: reads like the shell: ${d.error} ${d.hint}`);
  assert.equal(d.receipt, undefined);
  assert.equal(d.text, undefined);
}
// [operation, arguments, the field that must be named]
const BAD = [
  ['search', { limit: '5' }, 'limit'], ['search', { limit: 1.5 }, 'limit'], ['search', { limit: 0 }, 'limit'], ['search', { limit: -3 }, 'limit'],
  ['search', { limit: [5] }, 'limit'], ['search', { limit: true }, 'limit'], ['search', { offset: -1 }, 'offset'], ['search', { offset: 1e100 }, 'offset'], ['search', { offset: 32861 }, 'offset'],
  ['search', { maxChars: 0 }, 'maxChars'], ['search', { maxChars: '200' }, 'maxChars'],
  ['search', { query: 4121 }, 'query'], ['search', { query: ['pivot'] }, 'query'], ['search', { query: { text: 'pivot' } }, 'query'], ['search', { query: true }, 'query'],
  ['search', { from: 20260310 }, 'from'], ['search', { from: 'banana' }, 'from'], ['search', { to: 'tomorrow' }, 'to'], ['search', { from: '2026-03-10', to: '2026-03-09' }, 'from'],
  ['search', { aroundId: '139' }, 'aroundId'], ['search', { aroundId: -1 }, 'aroundId'], ['search', { aroundId: 99999 }, 'aroundId'], ['search', { aroundId: 1e21 }, 'aroundId'], ['search', { aroundId: 1.5 }, 'aroundId'],
  ['search', { aroundTime: 5 }, 'aroundTime'], ['search', { aroundTime: '1234' }, 'aroundTime'], ['search', { aroundTime: 'soon' }, 'aroundTime'],
  ['search', { window: '2m' }, 'window'], ['search', { aroundId: 139, window: 30 }, 'window'], ['search', { aroundId: 139, window: 'xyz' }, 'window'], ['search', { aroundId: 139, window: '-5s' }, 'window'],
  ['search', { aroundId: 139, aroundTime: '2026-03-10 09:00' }, 'aroundTime'], ['search', { aroundId: 139, from: '2026-03-10' }, 'aroundId'], ['search', { aroundTime: '2026-03-10 09:00', to: '2026-03-10 10:00' }, 'aroundTime'],
  ['search', { minSeverity: 'loud' }, 'minSeverity'], ['search', { minSeverity: 4 }, 'minSeverity'], ['search', { matchCase: 'yes' }, 'matchCase'], ['search', { matchCase: 1 }, 'matchCase'],
  ['search', { utc: 'true' }, 'utc'], ['search', { newest: 'true' }, 'newest'], ['search', { newest: true, offset: 5 }, 'offset'],
  ['count', { by: 'nope' }, 'by'], ['count', { by: 5 }, 'by'], ['count', { by: 'constructor' }, 'by'], ['count', { by: 'process', limit: 0 }, 'limit'], ['count', { from: 'never' }, 'from'],
  ['histogram', { bins: 0 }, 'bins'], ['histogram', { bins: '12' }, 'bins'], ['histogram', { bins: 2.5 }, 'bins'], ['histogram', { window: '1h' }, 'window'],
  ['show', {}, 'id'], ['show', { id: '139' }, 'id'], ['show', { id: -1 }, 'id'], ['show', { id: 99999 }, 'id'], ['show', { id: 1.5 }, 'id'], ['show', { id: 1e308 }, 'id'], ['show', { id: [139] }, 'id'],
  ['show', { id: 139, maxChars: 0 }, 'maxChars'], ['show', { id: 139, maxChars: 'all' }, 'maxChars'],
  ['context', {}, 'id'], ['context', { id: 5, time: '2026-03-10 09:00' }, 'time'], ['context', { id: 99999 }, 'id'], ['context', { id: '5' }, 'id'], ['context', { time: 'nonsense' }, 'time'], ['context', { time: 1773147600 }, 'time'],
  ['context', { id: 5, before: -1 }, 'before'], ['context', { id: 5, after: '8' }, 'after'], ['context', { id: 5, window: 'abc' }, 'window'], ['context', { id: 5, maxChars: 0 }, 'maxChars'],
  ['reports', { utc: 'no' }, 'utc'], ['memory', { utc: 0 }, 'utc'],
  ['files', { limit: 0 }, 'limit'], ['files', { offset: -1 }, 'offset'], ['files', { offset: 17 }, 'offset'], ['files', { filter: 5 }, 'filter'], ['files', { filter: ['a'] }, 'filter'],
  ['read_file', {}, 'path'], ['read_file', { path: 5 }, 'path'], ['read_file', { path: '../../etc/passwd' }, 'path'], ['read_file', { path: '/etc/passwd' }, 'path'], ['read_file', { path: 'summary.md/../../x' }, 'path'],
  ['read_file', { path: 'reports' }, 'path'], ['read_file', { path: 'summary.md', fromLine: 0 }, 'fromLine'], ['read_file', { path: 'summary.md', fromLine: 25 }, 'fromLine'], ['read_file', { path: 'summary.md', fromLine: '2' }, 'fromLine'],
  ['read_file', { path: 'summary.md', limit: 0 }, 'limit'], ['read_file', { path: 'summary.md', grep: 5 }, 'grep'],
  ['summary', { bundle: 5 }, 'bundle'], ['summary', { bundle: ['x'] }, 'bundle'],
];

describe('request mode: a wrong argument is refused with its name and what to send instead', () => {
  it(`all ${BAD.length} wrong calls come back as ok:false naming the argument`, async () => {
    for (let i = 0; i < BAD.length; i += 12) {
      await Promise.all(BAD.slice(i, i + 12).map(async ([op, params, field]) => {
        refused(await ask(op, params), field, `${op} ${JSON.stringify(params)}`);
      }));
    }
  });

  it('a number too large for JSON to hold exactly is refused, not rounded into something else', async () => {
    cacheDir ??= await emptyDir('cache');
    const bundlesDir = await sampleBundlesDir();
    const raw = (op, params) => send(null, `{"format":1,"op":"${op}","bundlesDir":${JSON.stringify(bundlesDir)},"cacheDir":${JSON.stringify(cacheDir)},"params":${params}}`);
    const [limit, id, offset] = await Promise.all([raw('search', '{"limit":1e400}'), raw('show', '{"id":1e400}'), raw('search', '{"offset":123456789012345678901234567890}')]);
    refused(limit, 'limit', 'limit 1e400');
    refused(id, 'id', 'id 1e400');
    refused(offset, 'offset', 'a thirty-digit offset');
  });

  it('the hint for a missing or unknown entry id gives the range and where ids come from', async () => {
    const [none, missing, around] = await Promise.all([ask('show', { id: 99999 }), ask('show', {}), ask('search', { aroundId: 40000 })]);
    assert.equal(none.error, 'no such entry');
    assert.equal(none.hint, 'No entry has id 99999. Entry ids in this bundle run from 0 to 32860. Copy an id from the ID column of excel_diag_search or excel_diag_context; do not guess one.');
    assert.equal(none.bundle, SAMPLE_ID, 'a refusal still says which bundle it was about');
    assert.equal(missing.error, 'id is missing');
    assert.match(missing.hint, /ID column of excel_diag_search or excel_diag_context.*run from 0 to 32860; do not guess one\.$/);
    assert.match(around.hint, /^No entry has id 40000\./);
  });

  it('the hint for a time shows how one is written, with a time from this bundle', async () => {
    const [bad, typed] = await Promise.all([ask('search', { from: 'banana' }), ask('context', { time: 1773147600 })]);
    assert.equal(bad.error, 'from is not a time');
    assert.equal(bad.hint, '"banana" cannot be read as a time. Write from the way results print times, for example "2026-03-10 09:00:00" (YYYY-MM-DD HH:MM:SS; the seconds and the time of day are optional). It is read in the logged Mac\'s time zone, UTC-04:00, unless it ends in Z or an offset such as -05:00.');
    assert.equal(typed.error, 'time must be a string');
    assert.equal(typed.hint, 'Send time as a string in quotation marks, for example "2026-03-10 09:00:00". A number was sent.');
  });

  it('window without aroundId or aroundTime says to use from and to', async () => {
    const d = await ask('search', { window: '2m' });
    assert.equal(d.error, 'window needs aroundId or aroundTime');
    assert.match(d.hint, /send from and to/);
  });

  it('two arguments that cannot go together are both named', async () => {
    const [a, b, c, d] = await Promise.all([ask('search', { aroundId: 139, from: '2026-03-10' }), ask('search', { aroundTime: '2026-03-10 09:00', to: '2026-03-10 10:00' }),
      ask('count', { aroundId: 139, aroundTime: '2026-03-10 09:00' }), ask('context', { id: 5, time: '2026-03-10 09:00' })]);
    assert.equal(a.error, 'aroundId and from cannot be used together');
    assert.equal(b.error, 'aroundTime and to cannot be used together');
    assert.equal(c.error, 'aroundId and aroundTime cannot be used together');
    assert.equal(d.error, 'id and time cannot be used together');
  });

  it('a wrong type is named for what it was, and the value is offered back as what was meant', async () => {
    const [query, limit, flag, by, words] = await Promise.all([ask('search', { query: 4121 }), ask('search', { limit: '5' }), ask('search', { utc: 'true' }), ask('count', { by: 'proces' }), ask('search', { limit: 'five' })]);
    assert.equal(query.hint, 'Send query as a string in quotation marks, for example "4121". A number was sent.');
    assert.equal(limit.hint, 'Send limit as a whole number without quotation marks, 1 or more, for example 5. A string was sent.');
    assert.equal(words.hint, 'Send limit as a whole number without quotation marks, 1 or more. A string was sent.', 'no number is made up for words');
    assert.equal(flag.hint, 'Send utc as true or false without quotation marks, or leave it out. A string was sent.');
    assert.equal(by.hint, 'Send by as one of: severity, level, source, tag, process, subsystem, category, file, message. The nearest to what was sent is process.');
  });

  it('a path that is not in the bundle cannot reach a file outside it', async () => {
    const [up, abs, many] = await Promise.all([ask('read_file', { path: '../../etc/passwd' }), ask('read_file', { path: '/etc/hosts' }), ask('read_file', { path: 'reports' })]);
    for (const d of [up, abs]) {
      assert.equal(d.error, 'no such file in this bundle');
      assert.match(d.hint, /Copy a path from the PATH column of excel_diag_files; do not guess one\.$/);
    }
    assert.equal(many.error, 'path matches more than one file');
    assert.equal(many.candidates.length, 3);
    assert.ok(many.candidates.every((p) => p.startsWith('reports/')));
  });

  it('an argument left out as null or as an empty string counts as left out', async () => {
    const [plain, blank] = await Promise.all([ask('search', {}), ask('search', { query: '', from: '', to: null, aroundId: null, aroundTime: ' ', window: '', minSeverity: '', matchCase: null, utc: null, bundle: '', limit: null, offset: null, newest: null, maxChars: null })]);
    assert.equal(blank.ok, true);
    assert.deepEqual(blank.receipt, plain.receipt);
    assert.equal(blank.text, plain.text);
    assert.equal(blank.next, plain.next);
  });

  it('an argument the operation does not have is left to the plugin to report, and changes nothing here', async () => {
    const [plain, extra, apart] = await Promise.all([ask('show', { id: 139 }), ask('show', { id: 139, entries: 5, limit: 'x', __proto__: null, constructor: 1 }),
      ask('show', { id: 139 }, { undeclared: { entries: 5, limit: 'x', toString: 1 } })]);
    assert.deepEqual(extra, plain);
    assert.deepEqual(apart, plain, 'nor when the caller sends it apart from the arguments');
  });
});

describe('request mode: a name that stands for another argument is refused with that argument', () => {
  // [operation, what was sent, the argument to send in its place (field, which as in every refusal is one the tool has), the hint]
  const WRONG = [
    ['search', { q: 'pivot', limit: 2 }, 'query', 'Send query in place of q, with the value that was sent: {query: "pivot"}. This call did not run.'],
    ['search', { q: 'pivot', severity: 'error' }, 'query', 'Send query in place of q and minSeverity in place of severity, with the values that were sent: {query: "pivot", minSeverity: "error"}. This call did not run.'],
    ['count', { groupBy: 'process' }, 'by', 'Send by in place of groupBy, with the value that was sent: {by: "process"}. This call did not run.'],
    ['histogram', { buckets: 12, since: '2026-03-10 10:00' }, 'bins', 'Send bins in place of buckets and from in place of since, with the values that were sent: {bins: 12, from: "2026-03-10 10:00"}. This call did not run.'],
    ['show', { entry: 139 }, 'id', 'Send id in place of entry, with the value that was sent: {id: 139}. This call did not run.'],
    ['context', { aroundTime: '2026-03-10 10:35:00' }, 'time', 'Send time in place of aroundTime, with the value that was sent: {time: "2026-03-10 10:35:00"}. This call did not run.'],
    ['read_file', { filename: 'summary.md', pattern: 'Mode' }, 'path', 'Send path in place of filename and grep in place of pattern, with the values that were sent: {path: "summary.md", grep: "Mode"}. This call did not run.'],
    ['files', { pattern: 'reports', skip: 25 }, 'filter', 'Send filter in place of pattern and offset in place of skip, with the values that were sent: {filter: "reports", offset: 25}. This call did not run.'],
    // a name whose value means something else as the argument: the hint says what the argument is, not the value
    ['files', { pattern: 'reports', page: 2 }, 'filter', 'Send filter in place of pattern, with the value that was sent: {filter: "reports"}. Send offset in place of page: offset is how many to skip, copied from nextOffset, not a page number. This call did not run.'],
    ['histogram', { interval: '5m' }, 'bins', 'Send bins in place of interval: bins is how many intervals to count in, not how long each is. This call did not run.'],
    ['read_file', { path: 'summary.md', offset: 0 }, 'fromLine', 'Send fromLine in place of offset: fromLine is the number of the first line to read, from 1. This call did not run.'],
    ['reports', { file: 'Microsoft Excel-2026-03-10-103500.ips' }, 'path', 'Send path in place of file, with the value that was sent: {path: "Microsoft Excel-2026-03-10-103500.ips"}. This call did not run.'],
    ['summary', { name: 'sample' }, 'bundle', 'Send bundle in place of name, with the value that was sent: {bundle: "sample"}. This call did not run.'],
    ['memory', { at: '10:35' }, 'time', 'Send time in place of at, with the value that was sent: {time: "10:35"}. This call did not run.'],
    // the argument it stands for was sent as well, or another wrong name stands for the same one
    ['search', { q: 'pivot', query: 'crash' }, 'query', 'Leave out q, which stands for query: that is sent already. This call did not run.'],
    ['search', { q: 'pivot', text: 'crash' }, 'query', 'Send query in place of q, with the value that was sent: {query: "pivot"}. Leave out text, which stands for query as well. This call did not run.'],
    ['search', { severity: 'error', level: 'fault', q: 'pivot', query: 'crash' }, 'minSeverity', 'Send minSeverity in place of severity, with the value that was sent: {minSeverity: "error"}. Leave out q, which stands for query: that is sent already. Leave out level, which stands for minSeverity as well. This call did not run.'],
  ];

  it(`all ${WRONG.length} are refused before anything runs, naming the argument to send and giving it the value sent`, async () => {
    // as arguments, and the way the plugin sends them: the names its tool does not declare apart from the arguments
    const { TOOLS } = await import('../../plugin/index.js');
    for (const [op, params, field, hint] of WRONG) {
      const declared = new Set(Object.keys(TOOLS.find((t) => t.name === `excel_diag_${op}`).parameters.properties));
      const split = (keep) => Object.fromEntries(Object.entries(params).filter(([k]) => declared.has(k) === keep));
      for (const [args, extra, how] of [[params, {}, ''], [split(true), { undeclared: split(false) }, ' sent apart']]) {
        const d = await ask(op, args, extra);
        assert.deepEqual(d, { ok: false, error: `${Object.keys(params).find((k) => !declared.has(k))} is not a field of excel_diag_${op}`, field, hint }, `${op} ${JSON.stringify(params)}${how}`);
      }
    }
  });

  it('a name an operation has is never refused as a wrong name, and a wrong name that was left empty is not refused', async () => {
    const [files, search, empty] = await Promise.all([ask('files', { filter: 'reports', limit: 1 }), ask('search', { query: 'pivot', limit: 1 }), ask('search', { q: '', severity: null, limit: 1 })]);
    for (const d of [files, search, empty]) assert.equal(d.ok, true, JSON.stringify(d).slice(0, 300));
    assert.equal(empty.receipt.matched, empty.receipt.total);
  });

  it('a value is given to the argument only as the argument would take it, whole: else the hint says what to send', async () => {
    const [long, longer, unseen, list, flag, digits, lines] = await Promise.all([ask('search', { q: 'x'.repeat(200) }), ask('search', { q: 'x'.repeat(201) }), ask('search', { q: 'a\u202eb' }),
      ask('count', { field: ['process'] }), ask('search', { caseSensitive: 'yes' }), ask('search', { max: '30' }), ask('read_file', { path: 'summary.md', lines: '1-50' })]);
    assert.equal(long.hint, `Send query in place of q, with the value that was sent: {query: "${'x'.repeat(200)}"}. This call did not run.`);
    // longer than is said again, or with a character in it that would be said by its number: not said again, so not changed
    for (const d of [longer, unseen]) assert.equal(d.hint, 'Send query in place of q, with the value that was sent. This call did not run.');
    assert.equal(list.hint, 'Send by in place of field, as a string in quotation marks. This call did not run.');
    assert.equal(flag.hint, 'Send matchCase in place of caseSensitive, as true or false without quotation marks. This call did not run.');
    assert.equal(digits.hint, 'Send limit in place of max, with the value that was sent: {limit: 30}. This call did not run.');
    assert.equal(lines.hint, 'Send limit in place of lines, as a whole number without quotation marks. This call did not run.');
  });
});

describe('request mode: the example in a refusal is made from what was sent', () => {
  it('a window sent as a bare number is offered back in seconds, and one in words as this tool writes it', async () => {
    const [number, words, minutes, nonsense] = await Promise.all([ask('search', { aroundId: 139, window: 60 }), ask('search', { aroundId: 139, window: '2 minutes' }),
      ask('context', { id: 139, window: '30 secs' }), ask('search', { aroundId: 139, window: 'soon' })]);
    assert.equal(number.hint, 'Send window as a string in quotation marks, for example "60s". A number was sent.');
    assert.equal(words.hint, 'Send window as a number and a unit in one string, for example "2m". "2 minutes" was sent.');
    assert.equal(minutes.hint, 'Send window as a number and a unit in one string, for example "30s". "30 secs" was sent.');
    assert.equal(nonsense.hint, 'Send window as a number and a unit in one string: "500ms", "30s", "2m", "1h" or "1d". "soon" was sent.');
  });

  it('a string sent in a list of one is offered back as that string', async () => {
    const [by, from, two] = await Promise.all([ask('count', { by: ['tag'] }), ask('search', { from: ['2026-03-10 10:00:00'] }), ask('count', { by: ['tag', 'process'] })]);
    assert.equal(by.hint, 'Send by as a string in quotation marks, for example "tag". A list was sent.');
    assert.equal(from.hint, 'Send from as a string in quotation marks, for example "2026-03-10 10:00:00". A list was sent.');
    assert.equal(two.hint, 'Send by as a string in quotation marks, for example "process". A list was sent.', 'two strings are not one: the usual example');
  });

  it('a severity that is nearly one is named with the one it is nearest', async () => {
    const [near, far] = await Promise.all([ask('search', { minSeverity: 'warn' }), ask('search', { minSeverity: 'loud' })]);
    assert.equal(near.hint, 'Send minSeverity as one of: debug, info, notice, warning, error, fault (lowest to highest). "warn" was sent. The nearest to it is warning.');
    assert.equal(far.hint, 'Send minSeverity as one of: debug, info, notice, warning, error, fault (lowest to highest). "loud" was sent.');
  });

  it('params that is not an object is not shown an invented one', async () => {
    const d = await send({ format: 1, op: 'search', bundlesDir: await sampleBundlesDir(), params: 'pivot' });
    assert.equal(d.hint, 'Send the arguments as one JSON object of names and values, or {} for none.');
  });
});

describe('request mode: a broken request still gets one JSON document', () => {
  it('standard input that is not JSON', async () => {
    for (const raw of ['not json', '', '{"op":', 'NaN', '{"op":"summary",}']) {
      const d = await send(null, raw);
      assert.deepEqual(d, { ok: false, error: 'the request is not valid JSON' }, raw);
    }
  });

  it('JSON that is not an object', async () => {
    for (const raw of ['[1,2]', '"summary"', '5', 'null', 'true']) {
      const d = await send(null, raw);
      assert.deepEqual(d, { ok: false, error: 'the request is not a JSON object' }, raw);
    }
  });

  it('an unknown or missing op, a missing or relative bundlesDir, another format', async () => {
    const bundlesDir = await sampleBundlesDir();
    const [unknown, none, noDir, relative, format, cache, inside] = await Promise.all([
      send({ format: 1, op: 'delete', bundlesDir, params: {} }), send({ format: 1, bundlesDir, params: {} }), send({ format: 1, op: 'summary', params: {} }),
      send({ format: 1, op: 'summary', bundlesDir: 'bundles', params: {} }), send({ format: 2, op: 'summary', bundlesDir, params: {} }),
      send({ format: 1, op: 'summary', bundlesDir, cacheDir: 'cache', params: {} }), send({ format: 1, op: 'summary', bundlesDir, cacheDir: `${bundlesDir}/cache`, params: {} }),
    ]);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'unknown op "delete"; the ops are summary, search, count, histogram, show, context, reports, files, read_file, memory');
    assert.match(none.error, /^the request has no op; the ops are summary, /);
    assert.equal(noDir.error, 'the request has no bundlesDir');
    assert.equal(relative.error, 'bundlesDir is not an absolute path');
    assert.equal(format.error, 'the request is not format 1, the only format this program answers');
    assert.equal(cache.error, 'cacheDir is not an absolute path');
    assert.equal(inside.error, 'cacheDir is inside bundlesDir');
  });

  it('params that is a list, a string or a number', async () => {
    const bundlesDir = await sampleBundlesDir();
    for (const params of [['pivot'], 'pivot', 5, true]) {
      const d = await send({ format: 1, op: 'search', bundlesDir, params });
      assert.equal(d.ok, false, JSON.stringify(params));
      assert.equal(d.error, 'params is not an object');
    }
    const missing = await send({ format: 1, op: 'files', bundlesDir });
    assert.equal(missing.ok, true, 'params left out is the same as no arguments');
    assert.equal(missing.receipt.files, 17);
  });

  it('a request larger than 1 MB is refused before it is read as JSON', async () => {
    const d = await send(null, `{"format":1,"op":"search","params":{"query":"${'x'.repeat(1100000)}"}}`);
    assert.deepEqual(d, { ok: false, error: 'the request is larger than 1 MB' });
  });

  it('a search text built to be awkward is searched for, not obeyed', async () => {
    const [quote, regex, long] = await Promise.all([ask('search', { query: '"unclosed' }), ask('search', { query: '/([a-z]+/' }), ask('search', { query: 'pivot '.repeat(40) })]);
    assert.equal(quote.ok, true);
    assert.match(quote.notes.join(' '), /never closed/);
    assert.equal(regex.ok, true);
    assert.match(regex.notes.join(' '), /not a valid regular expression/);
    assert.equal(long.ok, true);
    assert.equal(long.receipt.matched, 3839);
  });

  it('cleanup', async () => { await cleanup(); });
});
