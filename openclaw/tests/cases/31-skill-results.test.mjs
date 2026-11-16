// What SKILL.md says about results, held against results from the real program on the sample bundle.
//
// The page tells a small model what it will be shown and what to do with it: the parts of a result and their
// order, the column an id or a path is copied from, the field that says more exists and the field to send to get
// it, and what each refusal means. The model acts on those sentences and does not check them. A field the page
// names that no result carries, or a call the tool refuses as written, walks it into the stop rule on a healthy
// bundle. So the statements are run: every field and column the page names must turn up in a real result, each row
// of Start here must work as written with values copied from the result before, each signal in the closing bullets
// must be what the tools send, and a field a tool's description shows without "?" must be one it will not go without.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, it, assert, loadPlugin, blocks, cleanup, emptyDir, SKILL_PATH, SAMPLE_ID } from '../harness.mjs';
import { writeIncomplete, INCOMPLETE } from '../made-up.mjs';

const TIME = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

// One plugin for the whole file, and each distinct call made once: the specs share results the way a model does.
// A made-up bundle whose collection was not whole carries what the sample does not: the case note, the steps not
// complete, the days of the macOS log search that did not end with "ok", and the sources not found.
let loaded = null, recorded = null;
const plugin = () => (loaded ??= loadPlugin());
const incomplete = () => (recorded ??= (async () => { const dir = await emptyDir('incomplete'); await writeIncomplete(path.join(dir, INCOMPLETE)); return loadPlugin({ bundlesDir: dir }); })());
const made = new Map();
function call(tool, params = {}) {
  const key = `${tool} ${JSON.stringify(params)}`;
  if (!made.has(key)) made.set(key, plugin().then((p) => p.raw.get(tool)(params)));
  return made.get(key);
}
const details = async (tool, params) => (await call(tool, params)).details;
// A result as the page describes it: the facts, the JSON line, the lines, and the Next paragraph or the last line that
// says the result ends, each or null.
const END = /^End of the excel_diag_[a-z_]+ result\.$/;
function parts(envelope) {
  const b = blocks(envelope), out = { facts: null, json: null, lines: null, next: null, end: null };
  let i = 0;
  if (b[i]?.startsWith('Facts about this call:\n')) out.facts = b[i++];
  out.json = b[i++] ?? null;
  if (i < b.length - 1) out.lines = b[i++];
  if (i < b.length && b[i].startsWith('Next: ')) out.next = b[i++];
  else if (i < b.length && END.test(b[i])) out.end = b[i++];
  assert.equal(i, b.length, 'a result has no part the page does not describe');
  assert.ok(envelope.isError || out.next || out.end, 'a result ends with Next or with the line that says it ends');
  return out;
}
// A list's lines: the one that names the columns, and the rows under it. Columns are two or more spaces apart.
const COLUMNS = /^\s*[A-Z_]+(\[PID\])?(\s{2,}[A-Z_]+(\[PID\])?)+$/;
const cells = (line) => line.trim().split(/\s{2,}/);
async function table(tool, params) {
  const lines = parts(await call(tool, params)).lines.split('\n'), at = lines.findIndex((l) => COLUMNS.test(l));
  assert.ok(at >= 0, `${tool} prints a line that names its columns`);
  return { header: cells(lines[at]), rows: lines.slice(at + 1).map(cells) };
}
const header = async (tool, params) => (await table(tool, params)).header;
const rows = async (tool, params) => (await table(tool, params)).rows;

async function skill() {
  const text = await fs.readFile(SKILL_PATH, 'utf8'), body = text.slice(text.indexOf('\n---\n') + 5), section = new Map();
  for (const part of body.split(/^## /m).slice(1)) section.set(part.slice(0, part.indexOf('\n')), part.slice(part.indexOf('\n') + 1));
  return { text, body, section, flat: body.replace(/\s+/g, ' ') };
}
const spans = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
// The rows of Start here: { question, calls }
const startRows = (s) => s.section.get('Start here').split('\n').filter((l) => /^\| (?!Question|---)/.test(l)).map((l) => { const m = l.match(/^\| ([^|]+) \| (.+) \|$/); return { question: m[1], calls: m[2] }; });
// A time printed on a clock `from` minutes ahead of UTC, written again for a clock `to` minutes ahead of UTC.
function onClock(stamp, from, to) {
  const [Y, M, D, h, m, sec] = stamp.split(/[- :]/).map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h, m, sec) + (to - from) * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}
function minutesAhead(zone) {
  const m = zone.match(/^UTC(?:([+-])(\d\d):(\d\d))?$/);
  assert.ok(m, `the sample bundle is on one clock: ${zone}`);
  return m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

describe('skill and results: the parts of a result', () => {
  it('a result with all four parts has them in the order the page gives', async () => {
    const envelope = await call('excel_diag_search', { terms: 'pivot', limit: 2 }), b = blocks(envelope), p = parts(envelope);
    assert.equal(b.length, 4);
    assert.match(p.facts, /^Facts about this call:\n- Fact: \S/);
    assert.deepEqual(JSON.parse(p.json), envelope.details);
    assert.ok(!p.json.includes('\n'), 'one JSON line');
    assert.deepEqual(Object.keys(envelope.details).slice(0, 3), ['ok', 'tool', 'bundle'], 'the page: `ok`, `tool`, `bundle`, then what was understood and counted');
    assert.deepEqual(p.lines.split('\n')[0].trim().split(/\s{2,}/), ['ID', 'TIME', 'LEVEL', 'SOURCE', 'PROCESS[PID]', 'MESSAGE'], 'a list has a line that names its columns');
    assert.match(p.next, /^Next: excel_diag_\w+ \{/);
    assert.equal(b[3], p.next, 'Next is the last thing read');
  });

  it('file lines start with their number and message lines with two spaces, and a result with no Next ends with a last line', async () => {
    const s = await skill(), [file, message] = [parts(await call('excel_diag_read_file', { path: 'summary.md' })), parts(await call('excel_diag_show', { id: 15501 }))];
    assert.ok(s.flat.includes('Each file line starts with its number, and each message line with two spaces:'));
    assert.ok(file.lines.split('\n').slice(1).every((l, i) => l.startsWith(`${i + 1}: `)), file.lines);
    assert.ok(message.lines.split('\n').every((l) => l.startsWith('  ')), message.lines);
    assert.ok(s.flat.includes('or a last line that says the result ends.'));
    assert.equal(file.next, null, 'the whole file was read');
    assert.equal(file.end, 'End of the excel_diag_read_file result.');
  });

  it('matched counts the entries that met the conditions and total the entries in the bundle', async () => {
    const [found, summary] = await Promise.all([details('excel_diag_search', { minSeverity: 'error' }), details('excel_diag_summary', {})]);
    assert.ok(found.matched > 0 && found.matched < found.total);
    assert.equal(found.total, summary.entries);
  });

  it('Next offers calls with real values from the result', async () => {
    const p = parts(await call('excel_diag_search', { minSeverity: 'error' }));
    const first = (await rows('excel_diag_search', { minSeverity: 'error' }))[0][0];
    assert.ok(p.next.includes(`excel_diag_context {id: ${first}}`), p.next);
    assert.ok(p.next.endsWith('If this answers the question, reply now.'), 'replying is always allowed, and the result says so');
  });

  it('a failure is one JSON line with ok false, an error, the field at fault and a hint', async () => {
    const envelope = await call('excel_diag_show', {});
    assert.equal(blocks(envelope).length, 1);
    assert.deepEqual(JSON.parse(blocks(envelope)[0]), envelope.details);
    const d = envelope.details;
    assert.equal(d.ok, false);
    assert.equal(d.field, 'id');
    assert.ok(typeof d.error === 'string' && d.error && typeof d.hint === 'string' && d.hint.length > 20);
  });
});

describe('skill and results: the names the page uses', () => {
  it('every field the page names is an argument of a tool or a field of a real result', async () => {
    const s = await skill(), { module: mod } = await plugin();
    const made = await incomplete();
    const results = await Promise.all([
      details('excel_diag_summary', {}), details('excel_diag_search', { minSeverity: 'error' }), details('excel_diag_search', { query: 'zzzqqq pivot' }),
      details('excel_diag_search', { terms: 'pivot', limit: 2 }), details('excel_diag_read_file', { path: 'summary.md', limit: 2 }), details('excel_diag_histogram', {}),
      details('excel_diag_show', {}), details('excel_diag_read_file', { path: 'ips' }), details('excel_diag_count', { minSeverity: 'error', by: 'message' }),
      made.tools.get('excel_diag_summary')({}),
    ]);
    // the fields of a result at every depth: a value in a list (errorsByMessage[0].firstId) is a field of it too
    const keys = (v) => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    const known = new Set([...mod.TOOLS.flatMap((t) => Object.keys(t.parameters.properties)), ...results.flatMap(keys)]);
    const named = [...new Set(spans(s.body).map((span) => span.match(/^([a-z][A-Za-z]*)(?:: .+)?$/)?.[1]).filter((name) => name && name !== 'true' && name !== 'false'))];
    assert.ok(named.length >= 25, `the page names fields: ${named.join(', ')}`);
    for (const name of named) assert.ok(known.has(name), `SKILL.md names \`${name}\`, which is not an argument of any tool and was in none of these results`);
  });

  it('a field the page shows with a value has that value in a real result', async () => {
    const s = await skill();
    const results = await Promise.all([details('excel_diag_search', { minSeverity: 'error' }), details('excel_diag_search', { query: 'zzzqqq pivot' }), details('excel_diag_show', {}),
      details('excel_diag_search', { bundle: 'no-such-bundle' }), details('excel_diag_count', { minSeverity: 'error', by: 'message' })]);
    // From "Reading results" on, a name with a value is something a result says (or says back), not a step to take.
    const after = s.body.slice(s.body.indexOf('## Reading results'));
    const shown = [...new Set(spans(after).filter((span) => /^[a-z][A-Za-z]*: /.test(span)))];
    assert.deepEqual(shown.sort(), ['field: "bundle"', 'matched: 0', 'ok: false', 'truncated: true']);
    for (const span of shown) {
      const key = span.slice(0, span.indexOf(':')), value = JSON.parse(span.slice(span.indexOf(':') + 2));
      assert.ok(results.some((r) => r[key] === value), `no result here has ${span}`);
    }
  });

  it('the columns the page says to copy from are printed by the tools it names', async () => {
    const s = await skill();
    assert.deepEqual([...new Set(s.flat.match(/\b[A-Z]{2,}(?= column| or [A-Z]+ column)/g))].sort(), ['FILE', 'ID', 'PATH']);
    const [search, context, reports, files] = await Promise.all([header('excel_diag_search', { minSeverity: 'error' }), header('excel_diag_context', { id: 139 }), header('excel_diag_reports', {}), header('excel_diag_files', {})]);
    assert.equal(search[0], 'ID');
    assert.equal(context[0], 'ID');
    assert.ok(reports.includes('ID') && reports.includes('FILE'), reports.join(' '));
    assert.ok(files.includes('PATH'), files.join(' '));
  });

});

describe('skill and results: Start here runs as written', () => {
  it('a first look: the summary, then the errors counted by the shape of their message, each with a firstId', async () => {
    const summary = await details('excel_diag_summary', {});
    assert.equal(summary.ok, true);
    assert.match(summary.period.from, TIME);
    assert.match(summary.period.to, TIME);
    const counted = await details('excel_diag_count', { minSeverity: 'error', by: 'message' });
    assert.equal(counted.ok, true);
    assert.equal(counted.matched, (await details('excel_diag_search', { minSeverity: 'error' })).matched, 'the same filters count the same entries');
    for (const v of counted.values) { assert.ok(Number.isInteger(v.firstId)); assert.match(v.firstTime, TIME); assert.match(v.lastTime, TIME); }
    const around = await call('excel_diag_context', { id: counted.values[0].firstId });
    assert.equal(around.details.anchorId, counted.values[0].firstId);
    assert.ok(parts(around).lines.split('\n').some((l) => l.trim().startsWith(`>${counted.values[0].firstId} `)), 'the entry asked about is marked');
    const shown = await details('excel_diag_show', { id: counted.values[0].firstId });
    assert.equal(shown.id, counted.values[0].firstId);
  });

  it('a crash or a hang: the list, the report laid out by its FILE, what was logged around it by its ID, and whether Excel started again', async () => {
    const listed = await call('excel_diag_reports', {});
    assert.equal(listed.details.ok, true);
    const head = await header('excel_diag_reports', {}), table = await rows('excel_diag_reports', {});
    assert.equal(table.length, listed.details.shown, 'one line per report file');
    // Next names the newest Excel crash or hang report: its FILE and its ID are on one line of the list
    const next = parts(listed).next, file = /excel_diag_reports \{path: "([^"]+)"\}/.exec(next)[1], id = Number(/excel_diag_context \{id: (\d+)\}/.exec(next)[1]);
    const row = table.find((r) => r[head.indexOf('FILE')] === file);
    assert.ok(row && Number(row[head.indexOf('ID')]) === id, `${file} with id ${id} is a line of the list`);
    assert.deepEqual([row[head.indexOf('KIND')], row[head.indexOf('PROCESS')]], ['Crash', 'Microsoft Excel']);
    const read = await call('excel_diag_reports', { path: file });
    assert.equal(read.details.ok, true);
    assert.equal(read.details.id, id);
    const lines = parts(read).lines.split('\n');
    for (const label of ['Exception type: ', 'Stack: ', 'Threads in the report: ', 'Images listed: ']) assert.ok(lines.some((l) => l.startsWith(label)), label);
    const around = await details('excel_diag_context', { id });
    assert.ok(around.entries > 1 && around.shown.firstId < around.anchorId && around.anchorId < around.shown.lastId);
    assert.equal(around.anchorTime, row[head.indexOf('TIME')]);
    assert.equal((await details('excel_diag_show', { id: around.anchorId })).reportFile, file, 'the anchor is the entry of that report');
    // the process IDs of Excel, each with its first and last entry: one before the crash, one after
    const pids = (await details('excel_diag_summary', {})).excelProcessIds;
    assert.equal(pids.length, 2);
    assert.ok(pids[0].lastEntry <= row[head.indexOf('TIME')] && pids[1].firstEntry >= row[head.indexOf('TIME')], JSON.stringify(pids));
  });

  it('a time, or the minute before: the date from period, a time from another zone, and the warnings within a minute', async () => {
    const summary = await details('excel_diag_summary', {});
    const head = await header('excel_diag_reports', {}), table = await rows('excel_diag_reports', {});
    const stamp = table[table.length - 1][head.indexOf('TIME')], day = summary.period.from.slice(0, 10), timeOfDay = stamp.slice(11);
    assert.equal(summary.period.to.slice(0, 10), day, 'the sample covers one day');
    const local = await details('excel_diag_context', { time: `${day} ${timeOfDay}` });
    assert.equal(local.ok, true);
    assert.equal(local.timeZone, summary.timeZone, 'times are read on the clock the results name');
    const ahead = minutesAhead(summary.timeZone);
    const [utc, other] = await Promise.all([
      details('excel_diag_context', { time: `${onClock(stamp, ahead, 0)}Z` }),
      details('excel_diag_context', { time: `${onClock(stamp, ahead, -300)}-05:00` }),
    ]);
    assert.equal(utc.anchorId, local.anchorId, 'a time ending in Z is read as UTC');
    assert.equal(other.anchorId, local.anchorId, 'a time ending in an offset is read on that clock');
    const minute = await details('excel_diag_search', { aroundTime: stamp, window: '1m', minSeverity: 'warning' });
    assert.equal(minute.ok, true);
    assert.ok(minute.matched > 0 && minute.matched < minute.total);
    assert.equal(minute.minSeverity, 'warning');
  });

  it('memory at a time or over a span; disk and permissions by their tags', async () => {
    const at = await details('excel_diag_memory', { time: '2026-03-10 10:34:00' }), span = await details('excel_diag_memory', { from: '2026-03-10 10:30:00', to: '2026-03-10 10:35:00' });
    for (const d of [at, span]) { assert.equal(d.ok, true); assert.ok(d.samplesListed.length > 0); assert.ok(d.timeline.pressureLevels.every((l) => Array.isArray(l.seen))); }
    const [storage, permissions] = await Promise.all([details('excel_diag_search', { query: 'tag:storage' }), details('excel_diag_search', { query: 'tag:permissions' })]);
    assert.ok(storage.matched > 0 && permissions.matched > 0);
  });

  it('what the person reported, and whether the logs are complete: the summary names the fields, and the case file reads', async () => {
    const made = await incomplete(), summary = await made.tools.get('excel_diag_summary')({});
    for (const key of ['caseNote', 'stepsNotComplete', 'macosLogDaysNotOk', 'sourcesMissingOrOff']) assert.ok(summary[key] !== undefined, key);
    const note = await made.tools.get('excel_diag_read_file')({ path: 'case/incident_context.md' });
    assert.equal(note.ok, true);
    assert.equal(note.path, summary.caseNote.path);
  });

  it('other apps, and a file of the bundle', async () => {
    const counted = await details('excel_diag_count', { by: 'process' }), other = counted.values.find((v) => v.value !== 'Microsoft Excel' && /^\w+$/.test(v.value));
    const found = await details('excel_diag_search', { query: `process:${other.value}` });
    assert.ok(found.matched > 0 && found.matched <= other.entries);
    const files = await details('excel_diag_files', { filter: 'reports' });
    assert.ok(files.files > 0 && files.files < files.filesInBundle);
    const grep = await details('excel_diag_read_file', { path: 'summary.md', grep: 'Mode' });
    assert.ok(grep.matchedLines > 0);
    const hist = await details('excel_diag_histogram', {});
    assert.equal(hist.ok, true);
  });

  it('a histogram sent no span: the main period when the bundle has one, as the page says, and the whole period when not', async () => {
    const s = await skill();
    assert.ok(s.flat.includes('`excel_diag_histogram` counts entries per interval; sent no span, it counts the main period when the bundle has one, and says how to count the whole.'), 'the page says when');
    // the sample's main period is its whole period: the summary gives none, and the histogram counts every entry, with no fact
    const [summary, whole] = await Promise.all([details('excel_diag_summary', {}), call('excel_diag_histogram', {})]);
    assert.equal(summary.mainPeriod, undefined);
    assert.deepEqual([whole.details.matched, parts(whole).facts], [whole.details.total, null]);
  });

  it('each row was run above with the tools and the arguments it gives', async () => {
    // If a row is added or changed in the page, this fails until the specs above run it.
    const s = await skill();
    const said = startRows(s).map((r) => [r.question, [...new Set(r.calls.match(/excel_diag_\w+/g))].join(' '),
      spans(r.calls).map((x) => x.match(/^([a-z][A-Za-z]*)(?:: .+)?$/)?.[1]).filter(Boolean).sort().join(' ')]);
    assert.deepEqual(said, [
      ['A first look, or no clear question', 'excel_diag_summary excel_diag_count', 'by minSeverity'],
      ['A crash or a hang', 'excel_diag_reports excel_diag_context', 'id path'],
      ['Whether Excel started again', 'excel_diag_summary', 'excelProcessIds'],
      ['What happened at a time, or in the minute before', 'excel_diag_context excel_diag_search', 'aroundTime minSeverity time window'],
      ['Memory', 'excel_diag_memory', 'from time to'],
      ['Disk or permissions', 'excel_diag_search', 'query query'],
      ['What the person reported', 'excel_diag_read_file excel_diag_summary', 'caseNote path'],
      ['Whether the logs are complete, or what is missing', 'excel_diag_summary', 'macosLogDaysNotOk sourcesMissingOrOff stepsNotComplete'],
      ['Other apps', 'excel_diag_count excel_diag_search', 'by query'],
      ['A file of the bundle', 'excel_diag_files excel_diag_read_file', 'filter filter grep path'],
    ]);
  });
});

describe('skill and results: the signals in the closing bullets', () => {
  it('matched: 0 is an answer, with withoutEach, and the call without the condition that ruled entries out finds them', async () => {
    const envelope = await call('excel_diag_search', { query: 'zzzqqq pivot' }), d = envelope.details;
    assert.equal(d.ok, true);
    assert.ok(!envelope.isError, 'nothing found is not a failure');
    assert.equal(d.matched, 0);
    assert.ok(d.total > 0, 'the bundle is not empty');
    assert.ok(Array.isArray(d.withoutEach) && d.withoutEach.length >= 2);
    for (const each of d.withoutEach) assert.deepEqual(Object.keys(each), ['without', 'matched']);
    const ruledOut = d.withoutEach.filter((each) => each.matched > 0);
    assert.equal(ruledOut.length, 1);
    assert.ok(ruledOut[0].without.includes('zzzqqq'), ruledOut[0].without);
    assert.equal((await details('excel_diag_search', { query: 'pivot' })).matched, ruledOut[0].matched);
    assert.ok(parts(envelope).next.includes('excel_diag_search {query: "pivot"}'), 'and Next offers that call');
  });

  it('truncated: true comes with the way on: nextOffset as offset, nextFromLine as fromLine, or the call in Next', async () => {
    const page = await details('excel_diag_search', { minSeverity: 'error' });
    assert.equal(page.truncated, true);
    assert.equal(page.nextOffset, page.shown.last);
    const onward = await details('excel_diag_search', { minSeverity: 'error', offset: page.nextOffset });
    assert.equal(onward.shown.first, page.nextOffset + 1, 'the next page starts where this one stopped');

    const file = await details('excel_diag_read_file', { path: 'summary.md', limit: 2 });
    assert.equal(file.truncated, true);
    assert.equal(file.nextFromLine, file.shown.toLine + 1);
    const further = await details('excel_diag_read_file', { path: 'summary.md', limit: 2, fromLine: file.nextFromLine });
    assert.equal(further.shown.fromLine, file.nextFromLine);

    // Some cuts have no field to send on. The last matches have earlier ones before them, and Next has the call.
    const last = await call('excel_diag_search', { query: 'pivot', newest: true, limit: 2 });
    assert.equal(last.details.truncated, true);
    assert.equal(last.details.nextOffset, undefined);
    assert.match(parts(last).next, /excel_diag_search \{query: "pivot", limit: 2, offset: \d+\} lists the matches before these\./);
  });

  it('ignoredFields: the name was not a field and narrowed nothing, and allowedFields has the name that does', async () => {
    const { module: mod } = await plugin();
    const [wrong, right] = await Promise.all([call('excel_diag_search', { terms: 'pivot', limit: 2 }), details('excel_diag_search', { query: 'pivot' })]);
    assert.deepEqual(wrong.details.ignoredFields, ['terms']);
    assert.deepEqual(wrong.details.allowedFields, Object.keys(mod.TOOLS.find((t) => t.name === 'excel_diag_search').parameters.properties));
    assert.equal(wrong.details.matched, wrong.details.total, 'every entry matched: the result is not filtered');
    assert.ok(parts(wrong).facts.includes('terms is not a field of excel_diag_search and was ignored'), 'the first fact says so');
    assert.ok(wrong.details.allowedFields.includes('query') && right.matched < right.total, 'a name from allowedFields narrows');
  });

  it('a wrong bundle id is answered with field bundle and the ids there are', async () => {
    const d = await details('excel_diag_search', { bundle: 'no-such-bundle' });
    assert.equal(d.ok, false);
    assert.equal(d.field, 'bundle');
    assert.ok(d.hint.includes(SAMPLE_ID), 'the hint lists an id to send instead');
    assert.equal((await details('excel_diag_summary', {})).availableBundles[0].id, SAMPLE_ID, 'the same id availableBundles gives');
  });

  it('the three refusals the page quotes are worded as it quotes them', async () => {
    const s = await skill();
    const quoted = (words) => assert.ok(s.flat.includes(`\`${words}\``), `SKILL.md quotes "${words}"`);

    const empty = await loadPlugin({ sample: false });
    const none = await empty.tools.get('excel_diag_summary')({});
    assert.equal(none.ok, false);
    quoted(none.error);
    assert.equal(none.error, 'no bundles are available');
    assert.match(none.hint, /Ask the human to copy .* Do not call these tools again until the human says that is done\./, 'stop, and ask the human');

    const guarded = await loadPlugin({ deps: { run: async () => ({ code: 0, stdout: '{"ok":true}' }) } });
    const same = () => guarded.hook({ toolName: 'excel_diag_summary', params: {} }, {});
    assert.equal(await same(), undefined);
    assert.equal(await same(), undefined);
    const third = await same();
    assert.equal(third.block, true);
    quoted('was just made twice');
    assert.ok(third.blockReason.includes('was just made twice') && third.blockReason.includes('use the result you already have'));

    const silent = await loadPlugin({ deps: { run: async () => ({ code: 1, stdout: '' }) } });
    const unanswered = await silent.tools.get('excel_diag_summary')({});
    assert.equal(unanswered.ok, false);
    quoted(unanswered.error);
    assert.equal(unanswered.error, 'the Excel diagnostics program did not answer');
    assert.ok(typeof unanswered.hint === 'string' && unanswered.hint.length > 20, 'the hint the page says to follow once');
  });
});

describe('skill and results: required and optional fields', () => {
  it('a tool called with {} runs when its description marks every field optional, and names the field when one is not', async () => {
    // The page has no table of the tools: the shape each tool's description leads with is what the model sees.
    const { module: mod } = await plugin(), shapes = new Map(mod.TOOLS.map((t) => [t.name, t.description.match(/\{([^{}]*)\}/)[1].split(',').map((f) => f.trim())]));
    assert.equal(shapes.size, 10);
    const answers = await Promise.all([...shapes.keys()].map((tool) => details(tool, {})));
    [...shapes].forEach(([tool, fields], i) => {
      const d = answers[i], required = fields.filter((f) => !f.endsWith('?'));
      if (required.length) {
        assert.equal(required.length, 1, tool);
        assert.equal(d.ok, false, `${tool} shows ${required[0]} without "?", so it must not run without it`);
        assert.equal(d.field, required[0]);
        assert.equal(d.error, `${required[0]} is missing`);
      } else if (d.ok === false) {
        // No single field is required, but one of two is: the tool's description must say to send one.
        const m = d.error.match(/^(\w+) or (\w+) is missing$/);
        assert.ok(m, `${tool} marks every field optional but refuses {}: ${d.error}`);
        assert.ok(fields.includes(`${m[1]}?`) && fields.includes(`${m[2]}?`));
      } else assert.equal(d.ok, true, `${tool} runs with no arguments`);
    });
    assert.deepEqual([...shapes].filter(([, fields]) => fields.some((f) => !f.endsWith('?'))).map(([tool]) => tool), ['excel_diag_show', 'excel_diag_read_file']);
  });

  it('cleanup', async () => { await cleanup(); });
});
