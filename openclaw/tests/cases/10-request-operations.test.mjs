// Request mode, one operation at a time, on the built-in sample bundle.
//
// The model sees only what request mode prints, so each spec pins the three things it acts on: the receipt (the
// call as it was read, and counts that say what they count), the text (entries and file lines as plain lines) and
// the "next" sentence (real ids and paths from this result, never a shell command). A small model copies from
// these verbatim; a field that moves or a count without its scope sends it somewhere wrong.
import * as os from 'node:os';
import { describe, it, assert, request, sampleBundlesDir, emptyDir, cleanup, SAMPLE_ID } from '../harness.mjs';

let cacheDir = null;
// One request against the sample bundles folder. Every answer is checked for what holds of all of them: exit
// status 0, one JSON document and nothing else on standard output, and no path of this machine in it.
async function ask(op, params = {}, extra = {}) {
  const bundlesDir = await sampleBundlesDir();
  cacheDir ??= await emptyDir('cache');
  const r = await request({ format: 1, op, bundlesDir, cacheDir, params, ...extra });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', `standard output is not a JSON document: ${r.stdout.slice(0, 200)}`);
  assert.equal(r.stdout, `${JSON.stringify(r.json)}\n`, 'standard output holds the document, a line break and nothing else');
  for (const dir of [bundlesDir, cacheDir, os.tmpdir(), os.homedir()]) assert.ok(!r.stdout.includes(dir), `a path of this machine is in the output: ${dir}`);
  return r.json;
}
const REPLY = 'If this answers the question, reply now.';
// What every "next" must be: at most three tool calls in {...} form, the leave to reply last, and no shell.
function checkNext(next, ...calls) {
  assert.equal(typeof next, 'string');
  assert.ok(next.endsWith(REPLY), `next does not end by allowing a reply: ${next}`);
  const named = next.match(/excel_diag_[a-z_]+ \{/g) || [];
  assert.ok(named.length >= 1 && named.length <= 3, `next names ${named.length} calls: ${next}`);
  assert.ok(!/\bnode\b|deno run|--[a-z]/.test(next), `next reads like a shell command: ${next}`);
  for (const c of calls) assert.ok(next.includes(c), `next lacks ${c}: ${next}`);
}
const CRASH_REPORT = 'reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips';
const JETSAM_REPORT = 'reports/Library_Logs_DiagnosticReports/JetsamEvent-2026-03-10-103230.ips';

describe('request mode: each operation on the sample bundle', () => {
  it('summary gives the bundle as facts, its newest reports, where errors are most, the commonest error messages, and where to look first', async () => {
    const d = await ask('summary');
    assert.equal(d.ok, true);
    assert.equal(d.bundle, SAMPLE_ID);
    // the list of log sources is one call away, and errorsByMessage says what it leaves out
    assert.deepEqual(d.notes, ['5 log sources are on the timeline: excel_diag_count {by: "file"} lists them, with the entries each gave.',
      'errorsByMessage gives the 3 shapes of message that most errors and faults have, of the 28 they have: excel_diag_count {minSeverity: "error", by: "message"} lists more.']);
    const r = d.receipt;
    assert.equal(r.bundle, SAMPLE_ID);
    assert.equal(r.collectorMode, 'collect', 'the mode bundle_info.tsv records: the sample id names none');
    assert.equal(r.files, 17);
    assert.ok(Number.isInteger(r.bytes) && r.bytes > 5e6);
    assert.equal(r.entries, 32861);
    assert.deepEqual(r.period, { from: '2026-03-10 09:00:00', to: '2026-03-10 11:59:59' });
    assert.equal(r.timeZone, 'UTC-04:00');
    assert.deepEqual(r.bySeverity, { Fault: 2, Error: 1058, Warning: 235, Notice: 11381, Info: 17312, Debug: 2873 });
    assert.deepEqual(r.byTag.find((x) => x.tag === 'memory'), { tag: 'memory', entries: 2856 });
    assert.equal(r.topProcesses.length, 8);
    assert.deepEqual(r.topProcesses[0], { process: 'Microsoft Excel', entries: 18561 });
    assert.equal(r.processes, 14);
    assert.equal(r.logSources, 5);
    assert.deepEqual(r.intervalWithMostErrors, { from: '2026-03-10 10:30:00', to: '2026-03-10 10:37:30', errorsAndFaults: 908, intervalLength: '7 min 30 s', within: 'period' });
    assert.equal(r.errorsByMessage.length, 3);
    assert.deepEqual(r.errorsByMessage[0], { value: 'PivotCache: could not grow record buffer to # GB (out of memory), retrying with a smaller block', entries: 874, firstId: 15006, firstTime: '2026-03-10 10:31:02', lastTime: '2026-03-10 10:34:59' });
    assert.deepEqual(r.reports, { total: 2, byKind: { Jetsam: 1, Crash: 1 } });
    assert.deepEqual(r.availableBundles, [{ id: SAMPLE_ID }], 'an id with no collector date in it: the id alone');
    assert.equal(r.bundles, 1);
    // each Excel process ID the logs have entries under, with its first and last entry: the sample's Excel crashed and was started again
    assert.deepEqual(r.excelProcessIds, [{ pid: 4121, firstEntry: '2026-03-10 09:00:00', lastEntry: '2026-03-10 10:34:59' }, { pid: 4307, firstEntry: '2026-03-10 10:35:00', lastEntry: '2026-03-10 11:59:58' }]);
    assert.equal(r.sourcesMissingOrOff, undefined, 'it has no source_catalog.tsv');
    // what the bundle records about the Mac and the collection: the engine's labels, the bundle's values, the file each is from
    assert.deepEqual(r.collection.slice(0, 4), [{ fact: 'Collected', value: '2026-03-10 12:03:40 EDT (2026-03-10 16:03:40 UTC)', file: 'bundle_info.tsv' },
      { fact: 'Collector mode', value: 'collect', file: 'bundle_info.tsv' }, { fact: 'Log search window', value: '2026-03-10 through 2026-03-10 (1 day(s))', file: 'summary.md' },
      { fact: 'Collector version', value: '1.5.0', file: 'bundle_info.tsv' }]);
    assert.equal(r.collection.length, 14);
    for (const x of r.collection) assert.deepEqual(Object.keys(x), ['fact', 'value', 'file']);
    assert.equal(r.stepsNotComplete, undefined, 'every row of its manifest is complete');
    assert.equal(r.macosLogDaysNotOk, undefined, 'its one day was searched to the end');
    assert.equal(r.caseNote, undefined, 'it has no case file');
    // the report files, newest first, each with the id of its own entry; and no list of log sources
    const lines = d.text.split('\n');
    assert.equal(lines[0], 'The 2 reports, newest first:');
    assert.match(lines[1], /^\s*ID\s+TIME\s+KIND\s+PROCESS\s+FILE$/);
    assert.equal(lines[2], `19089  2026-03-10 10:35:00  Crash   Microsoft Excel  ${CRASH_REPORT}`);
    assert.equal(lines[3], `15520  2026-03-10 10:32:30  Jetsam  JetsamEvent      ${JETSAM_REPORT}`);
    assert.equal(lines.length, 4);
    assert.ok(!/ENTRIES\s+SOURCE/.test(d.text), 'the log sources are not listed');
    checkNext(d.next, `excel_diag_reports {path: "${CRASH_REPORT}"}`, 'excel_diag_search {minSeverity: "error", from: "2026-03-10 10:30:00", to: "2026-03-10 10:37:30"}', 'excel_diag_histogram {}');
    assert.ok(d.next.startsWith(`excel_diag_reports {path: "${CRASH_REPORT}"} lays out the newest crash, hang or spin report of Microsoft Excel.`), 'the newest crash of Excel first');
    assert.ok(d.next.includes('908 errors and faults'), 'the count in next says what it counts');
  });

  it('what the summary says of errors is what the calls it offers find: count by message, the histogram, the search', async () => {
    const d = await ask('summary'), busiest = d.receipt.intervalWithMostErrors;
    const [byMessage, hist, found] = await Promise.all([ask('count', { minSeverity: 'error', by: 'message', limit: 3 }), ask('histogram', {}),
      ask('search', { minSeverity: 'error', from: busiest.from, to: busiest.to, limit: 1 })]);
    assert.deepEqual(byMessage.receipt.values, d.receipt.errorsByMessage);
    const line = hist.text.split('\n').find((l) => l.startsWith(busiest.from)).trim().split(/\s+/);
    assert.equal(Number(line[3]), busiest.errorsAndFaults, 'the ERRORS column of that interval');
    assert.equal(hist.receipt.intervalLength, busiest.intervalLength);
    assert.equal(found.receipt.matched, busiest.errorsAndFaults);
  });

  it('search echoes how the call was read and lists entries one per line', async () => {
    const d = await ask('search', { minSeverity: 'Error', limit: 5 });
    assert.deepEqual(d.receipt, { query: '', minSeverity: 'error', matched: 1060, total: 32861, shown: { first: 1, last: 5 }, truncated: true, nextOffset: 5, timeZone: 'UTC-04:00' });
    const lines = d.text.split('\n');
    assert.match(lines[0], /^\s*ID\s+TIME\s+LEVEL\s+SOURCE\s+PROCESS\[PID\]\s+MESSAGE$/);
    assert.equal(lines.length, 6);
    assert.match(lines[1], /^\s*139  2026-03-10 09:00:50\.400  Unexpected  excel    Microsoft Excel\[4121\]  TelemetryEvent::Log \{"Activity":"Paint","Result":"Failed","Value":434\}$/);
    checkNext(d.next, 'excel_diag_count {minSeverity: "Error", by: "message"} groups all 1060 matches by the shape of their message', 'excel_diag_context {id: 139}', 'excel_diag_search {minSeverity: "Error", limit: 5, offset: 5}');
    assert.ok(d.next.startsWith('excel_diag_count {minSeverity: "Error", by: "message"}'), 'far more match than are listed: grouping them comes first');
  });

  it('search follows nextOffset to the page after, and newest gives the last page', async () => {
    const [second, last] = await Promise.all([ask('search', { minSeverity: 'error', limit: 5, offset: 5 }), ask('search', { query: 'pivot', newest: true, limit: 2 })]);
    assert.deepEqual(second.receipt.shown, { first: 6, last: 10 });
    assert.equal(second.receipt.nextOffset, 10);
    assert.deepEqual(last.receipt.shown, { first: 3838, last: 3839 });
    assert.equal(last.receipt.matched, 3839);
    assert.equal(last.receipt.truncated, true, 'earlier matches exist');
    assert.equal(last.receipt.nextOffset, undefined, 'nothing comes after the newest');
    checkNext(last.next, 'excel_diag_search {query: "pivot", limit: 2, offset: 3835}');
  });

  it('search reads the viewer syntax, a window and matchCase, and keeps a message on one line', async () => {
    const [windowed, fault] = await Promise.all([
      ask('search', { query: 'process:excel "could not grow"', from: '2026-03-10 10:34', to: '2026-03-10 10:35', limit: 1 }),
      ask('search', { minSeverity: 'fault' }),
    ]);
    assert.equal(windowed.receipt.query, 'process:excel "could not grow"');
    assert.equal(windowed.receipt.from, '2026-03-10 10:34:00');
    assert.equal(windowed.receipt.to, '2026-03-10 10:35:00');
    assert.ok(windowed.receipt.matched > 0 && windowed.receipt.matched < 1060);
    assert.match(windowed.text.split('\n')[1], /2026-03-10 10:34:\d\d\.\d{3}  Error .*PivotCache: could not grow record buffer/);
    assert.equal(fault.receipt.matched, 2);
    assert.equal(fault.receipt.truncated, false);
    assert.equal(fault.receipt.nextOffset, undefined);
    assert.equal(fault.text.split('\n').length, 3, 'a message with line breaks still takes one line');
    assert.ok(fault.text.includes('Unhandled exception in PivotCache refresh\\n  0  Microsoft Excel'), 'line breaks inside a message are shown as \\n');
    checkNext(fault.next, 'excel_diag_context {id: 18689}', 'excel_diag_show {id: 18689}');
  });

  it('a search that matches nothing is an answer: matched 0, and the count without each condition', async () => {
    const d = await ask('search', { query: 'proces:excel pivot', from: '2026-03-10 09:00', to: '2026-03-10 09:01' });
    assert.equal(d.ok, true);
    assert.equal(d.receipt.matched, 0);
    assert.equal(d.receipt.total, 32861);
    assert.deepEqual(d.receipt.withoutEach, [
      { without: 'the time window', matched: 0 },
      { without: 'the query term proces:excel', matched: 13 },
      { without: 'the query term pivot', matched: 0 },
    ]);
    assert.equal(d.text, undefined);
    assert.equal(d.notes.length, 1);
    assert.match(d.notes[0], /"proces:" is not a field.*Did you mean process:excel\?/);
    checkNext(d.next, 'excel_diag_search {query: "pivot", from: "2026-03-10 09:00", to: "2026-03-10 09:01"}');
    assert.ok(d.next.includes('13 entries match'));
  });

  it('matched 0 with every kind of condition names each one by its argument', async () => {
    const d = await ask('search', { query: 'Process:EXCEL "exceeded mem limit"', matchCase: true, minSeverity: 'Fault' });
    assert.deepEqual(d.receipt.withoutEach, [
      { without: 'minSeverity', matched: 0 },
      { without: 'matchCase', matched: 0 },
      { without: 'the query term Process:EXCEL', matched: 0 },
      { without: 'the query term "exceeded mem limit"', matched: 2 },
    ]);
    assert.equal(d.receipt.minSeverity, 'fault');
    assert.equal(d.receipt.matchCase, true);
  });

  it('matched 0 for one word alone, or when no single condition is to blame, says so in a note', async () => {
    const [word, both, tag] = await Promise.all([ask('search', { query: 'zzzznothing' }), ask('count', { query: 'zzzznothing', minSeverity: 'error' }), ask('histogram', { query: 'tag:nosuchtag' })]);
    assert.equal(word.receipt.matched, 0);
    assert.equal(word.receipt.withoutEach, undefined, 'there is no condition to take away from a single word');
    assert.match(word.notes[0], /^No entry in this bundle contains zzzznothing\./);
    assert.deepEqual(both.receipt.withoutEach, [{ without: 'minSeverity', matched: 0 }, { without: 'the query term zzzznothing', matched: 1060 }]);
    checkNext(both.next, 'excel_diag_count {minSeverity: "error"}');
    assert.equal(tag.receipt.matched, 0);
    assert.deepEqual(tag.notes, ['tag:nosuchtag: no tag in this bundle contains "nosuchtag", so it matches no entries. excel_diag_count {by: "tag"} lists every tag.'], 'the names of the tags are not in the sentence; the call that lists them is');
  });

  it('count without by gives the largest values of four fields, and no text', async () => {
    const d = await ask('count');
    assert.equal(d.receipt.matched, 32861);
    assert.equal(d.receipt.total, 32861);
    assert.deepEqual(d.receipt.bySeverity[0], { value: 'Info', entries: 17312 });
    assert.deepEqual(d.receipt.bySource[0], { value: 'macOS unified log', entries: 23874 });
    assert.deepEqual(d.receipt.byTag[0], { value: 'excel', entries: 9617 });
    assert.deepEqual(d.receipt.byProcess[0], { value: 'Microsoft Excel', entries: 18561 });
    assert.equal(d.receipt.byProcess.length, 8);
    assert.equal(d.text, undefined);
    checkNext(d.next, 'excel_diag_search {query: "process:\\"Microsoft Excel\\""}');
  });

  it('count by a field lists its values largest first with what is left over', async () => {
    const [level, proc] = await Promise.all([ask('count', { by: 'Level', minSeverity: 'warning' }), ask('count', { by: 'process', limit: 3, from: '2026-03-10 10:30', to: '2026-03-10 10:40' })]);
    assert.equal(level.receipt.by, 'level');
    assert.equal(level.receipt.matched, 1295);
    assert.deepEqual(level.receipt.values.slice(0, 3), [{ value: 'Error', entries: 1019 }, { value: 'Monitorable', entries: 232 }, { value: 'Unexpected', entries: 38 }]);
    assert.equal(level.receipt.moreValues, 0);
    assert.equal(level.receipt.truncated, undefined);
    checkNext(level.next, 'excel_diag_search {query: "level:Error", minSeverity: "warning"}');
    assert.equal(proc.receipt.values.length, 3);
    assert.equal(proc.receipt.moreValues, 9);
    assert.equal(proc.receipt.truncated, true);
    assert.equal(proc.receipt.from, '2026-03-10 10:30:00');
    assert.equal(proc.receipt.timeZone, 'UTC-04:00');
    checkNext(proc.next, 'excel_diag_count {from: "2026-03-10 10:30", to: "2026-03-10 10:40", by: "process", limit: 12}');
  });

  it('histogram counts per interval, without bars, and its fullest interval can be searched for the same count', async () => {
    const d = await ask('histogram', { query: 'tag:memory', bins: 12 });
    const r = d.receipt;
    assert.equal(r.matched, 2856);
    assert.equal(r.intervals, 12);
    assert.equal(r.intervalLength, '15 min');
    assert.equal(r.from, '2026-03-10 09:00:01');
    assert.equal(r.to, '2026-03-10 12:00:01');
    assert.deepEqual(r.fullest, { from: '2026-03-10 10:30:01', to: '2026-03-10 10:45:01', entries: 520 });
    const lines = d.text.split('\n');
    assert.equal(lines[0], 'ERRORS counts errors and faults.');
    assert.match(lines[1], /^START\s+ENTRIES\s+ERRORS\s+WARNINGS$/);
    assert.equal(lines.length, 14);
    assert.match(lines[2], /^2026-03-10 09:00:01\s+240\s+0\s+0$/);
    assert.ok(!d.text.includes('#'), 'no bars');
    assert.equal(lines.slice(2).reduce((a, l) => a + Number(l.trim().split(/\s+/)[2]), 0), 2856, 'the intervals add up to matched');
    checkNext(d.next, 'excel_diag_search {query: "tag:memory", from: "2026-03-10 10:30:01", to: "2026-03-10 10:45:01"}');
    // The numbers have to agree when the model follows that suggestion, or it will distrust one of the two.
    const follow = await ask('search', { query: 'tag:memory', from: r.fullest.from, to: r.fullest.to, limit: 1 });
    assert.equal(follow.receipt.matched, r.fullest.entries);
  });

  it('histogram folds a run of empty intervals into one line', async () => {
    const d = await ask('histogram', { query: 'source:report', bins: 30 });
    assert.equal(d.receipt.matched, 2);
    assert.match(d.text, /^\(\d+ intervals? with no entries\)$/m);
    assert.equal(d.text.split('\n').filter((l) => /^2026-/.test(l)).length, 2);
  });

  it('show gives one entry as fields and its whole message as text', async () => {
    const d = await ask('show', { id: 139 });
    assert.deepEqual(d.receipt, {
      id: 139, lastId: 32860, time: '2026-03-10 09:00:50', utcTime: '2026-03-10 13:00:50', timeZone: 'UTC-04:00', severity: 'Error', level: 'Unexpected', source: 'excel',
      file: 'office/excel_container_logs/Diagnostics/EXCEL/Primary1773147600000000000_SAMPLE.log', process: 'Microsoft Excel', pid: 4121, subsystem: 'Microsoft Excel',
      category: 'Telemetry Event', extra: { threadTid: '0x1d', eventId: 'jez7' }, messageChars: 70, printed: 'each line of the message after two spaces that are not part of it', truncated: false,
    });
    assert.equal(d.text, '  TelemetryEvent::Log {"Activity":"Paint","Result":"Failed","Value":434}', 'after two spaces, as printed says');
    checkNext(d.next, 'excel_diag_context {id: 139}');
  });

  it('show keeps the line breaks of a message, names tags, and points at a report file', async () => {
    const [fault, report] = await Promise.all([ask('show', { id: 18689 }), ask('show', { id: 19089 })]);
    assert.equal(fault.receipt.severity, 'Fault');
    assert.equal(fault.receipt.level, undefined, 'the level is given only when the log calls it something else');
    assert.deepEqual(fault.receipt.tags, ['excel']);
    assert.equal(fault.text.split('\n').length, 3);
    assert.ok(fault.text.split('\n').every((l) => l.startsWith('  ')), 'each line of the message after two spaces');
    assert.equal(fault.receipt.messageChars, fault.text.split('\n').map((l) => l.slice(2)).join('\n').length, 'which messageChars does not count');
    assert.equal(report.receipt.reportFile, CRASH_REPORT);
    assert.equal(report.receipt.file, undefined, 'a report entry comes from no log file');
    assert.equal(report.receipt.level, 'Crash');
    checkNext(report.next, 'excel_diag_context {id: 19089}', `excel_diag_read_file {path: "${CRASH_REPORT}"}`);
  });

  it('context lists what every source logged around an entry and marks it', async () => {
    const d = await ask('context', { id: 139, before: 3, after: 3 });
    assert.deepEqual(d.receipt, { anchorId: 139, anchorTime: '2026-03-10 09:00:50', shown: { firstId: 136, lastId: 142, from: '2026-03-10 09:00:49.200', to: '2026-03-10 09:00:51.346' }, entries: 7, truncated: false, timeZone: 'UTC-04:00' });
    const lines = d.text.split('\n');
    assert.equal(lines.length, 8);
    assert.match(lines[4], /^>139  2026-03-10 09:00:50\.400  Unexpected/);
    assert.equal(lines.filter((l) => l.startsWith('>')).length, 1);
    assert.match(lines[1], /^ 136  /);
    checkNext(d.next, 'excel_diag_show {id: 139}', 'excel_diag_context {id: 139, before: 16, after: 16}', 'excel_diag_search {query: "process:\\"Microsoft Excel\\"", aroundId: 139, window: "1m"}');
  });

  it('context by time anchors on the first entry at or after it and says so', async () => {
    const [at, past, quiet] = await Promise.all([
      ask('context', { time: '2026-03-10 10:34:59', before: 1, after: 1 }),
      ask('context', { time: '2027-01-01' }),
      ask('context', { time: '2027-01-01', window: '5s' }),
    ]);
    assert.equal(at.receipt.anchorId, 18999);
    assert.equal(at.receipt.anchorTime, '2026-03-10 10:34:59');
    assert.equal(at.receipt.entries, 3);
    assert.deepEqual(at.notes, ['The anchor is entry 18999, the first entry at or after 2026-03-10 10:34:59.']);
    assert.equal(past.receipt.anchorId, 32860);
    // far from the time asked, and how far is said; and that time is one the bundle's macOS log does not reach
    assert.deepEqual(past.notes, ['No entry is at or after 2027-01-01 00:00:00, so the anchor is the entry nearest before it, 32860, 296 days 12 h before the time asked.',
      'The macOS log in this bundle does not cover 2027-01-01 00:00:00, the time asked.']);
    assert.equal(quiet.ok, true);
    assert.equal(quiet.receipt.entries, 0);
    assert.equal(quiet.receipt.entriesInWindow, 0);
    assert.equal(quiet.text, undefined);
    assert.deepEqual(quiet.notes, ['The bundle holds no entry within 5 s either side of 2027-01-01 00:00:00.', 'The macOS log in this bundle covers none of this time window.']);
    checkNext(quiet.next, 'excel_diag_read_file {path: "unified_logs/collection_status.txt"} reads what it records for each day of the macOS log search', 'excel_diag_context {time: "2027-01-01"}');
    assert.ok(quiet.next.startsWith('excel_diag_read_file'), 'what was collected comes before the entries nearest, however far off');
  });

  it('context at a report\'s own time anchors on that report\'s entry, not on what was logged earlier in that second', async () => {
    const [at, near] = await Promise.all([ask('context', { time: '2026-03-10 10:35:00', before: 1, after: 1 }), ask('context', { time: '2026-03-10 10:35:00.001', before: 0, after: 0 })]);
    assert.equal(at.receipt.anchorId, 19089);
    assert.equal(at.receipt.anchorTime, '2026-03-10 10:35:00');
    assert.deepEqual(at.notes, ['The anchor is entry 19089, the entry of the report recorded at 2026-03-10 10:35:00.']);
    const lines = at.text.split('\n');
    assert.match(lines[1], /^ 19088  2026-03-10 10:35:00\.000  Default  unified  launchd\[1\]  /, 'the entry logged before it in the same second');
    assert.match(lines[2], /^>19089  2026-03-10 10:35:00\.000  Crash    report   Microsoft Excel  /, 'the report is the anchor');
    assert.deepEqual(at.receipt.shown, { firstId: 19088, lastId: 19090, from: '2026-03-10 10:35:00.000', to: '2026-03-10 10:35:01.500' });
    assert.notEqual(near.receipt.anchorId, 19089, 'a time with a fraction is a report\'s only when it is the report\'s to the millisecond');
  });

  it('reports lists the report files oldest first, each with the id of its own entry, and follows up the newest', async () => {
    const d = await ask('reports');
    assert.deepEqual(d.receipt, { reports: 2, byKind: { Jetsam: 1, Crash: 1 }, shown: 2, truncated: false, timeZone: 'UTC-04:00' });
    const lines = d.text.split('\n');
    assert.match(lines[0], /^\s*ID\s+TIME\s+KIND\s+PROCESS\s+FILE$/);
    assert.equal(lines[1], `15520  2026-03-10 10:32:30  Jetsam  JetsamEvent      ${JETSAM_REPORT}`);
    assert.equal(lines[2], `19089  2026-03-10 10:35:00  Crash   Microsoft Excel  ${CRASH_REPORT}`);
    checkNext(d.next, `excel_diag_reports {path: "${CRASH_REPORT}"} lays out the newest report`, 'excel_diag_context {id: 19089} lists what every source logged just before and after the newest report.');
    assert.ok(d.next.startsWith('excel_diag_reports {path: '), 'laid out first');
    assert.ok(!d.next.includes('window'), 'the report\'s own entry, with no window');
    // the ID is that report's own entry on the timeline
    const [crash, jetsam] = await Promise.all([ask('show', { id: 19089 }), ask('show', { id: 15520 })]);
    assert.deepEqual([crash.receipt.reportFile, jetsam.receipt.reportFile], [CRASH_REPORT, JETSAM_REPORT]);
  });

  it('files lists paths with sizes and timeline entries, and filter narrows by part of a path', async () => {
    const [all, some, none] = await Promise.all([ask('files'), ask('files', { filter: 'REPORT' }), ask('files', { filter: 'zzzz' })]);
    assert.equal(all.receipt.files, 17);
    assert.equal(all.receipt.filter, undefined);
    assert.deepEqual(all.receipt.shown, { first: 1, last: 17 });
    assert.equal(all.receipt.truncated, false);
    assert.match(all.text.split('\n')[0], /^\s*SIZE\s+TIMELINE_ENTRIES\s+PATH$/);
    assert.match(all.text, /^\s*[\d.]+ [KM]B\s+23874\s+unified_logs\/2026-03-10\.tsv$/m);
    assert.match(all.text, /^\s*[\d.]+ K?B\s+-\s+summary\.md$/m);
    assert.deepEqual({ filter: some.receipt.filter, files: some.receipt.files, filesInBundle: some.receipt.filesInBundle }, { filter: 'REPORT', files: 3, filesInBundle: 17 });
    checkNext(some.next, `excel_diag_read_file {path: "${JETSAM_REPORT}"}`);
    assert.equal(none.ok, true);
    assert.equal(none.receipt.files, 0);
    assert.equal(none.text, undefined);
    assert.deepEqual(none.notes, ['No file path in this bundle contains "zzzz".']);
    checkNext(none.next, 'excel_diag_files {}');
  });

  it('read_file gives lines of a file and how to go on', async () => {
    const d = await ask('read_file', { path: 'summary.md', limit: 5 });
    assert.deepEqual(d.receipt, { path: 'summary.md', bytes: 940, lines: 24, shown: { fromLine: 1, toLine: 5 }, truncated: true, nextFromLine: 6 });
    const lines = d.text.split('\n');
    assert.equal(lines.length, 6, 'a lead line and the five lines');
    assert.deepEqual(lines.slice(0, 2), ['Lines 1 to 5 of the file, each after its line number:', '1: # Excel diagnostics summary']);
    assert.ok(lines.slice(1).every((l, i) => l.startsWith(`${i + 1}: `)), d.text);
    checkNext(d.next, 'excel_diag_read_file {path: "summary.md", fromLine: 6, limit: 5}');
    const rest = await ask('read_file', { path: 'summary.md', fromLine: 6 });
    assert.deepEqual(rest.receipt.shown, { fromLine: 6, toLine: 24 });
    assert.equal(rest.receipt.truncated, false);
    assert.equal(rest.receipt.nextFromLine, undefined);
  });

  it('read_file accepts a unique name or part of a path and says which file it read', async () => {
    const [byName, byPart, log] = await Promise.all([ask('read_file', { path: 'crash_summary.txt' }), ask('read_file', { path: 'footprint', limit: 2 }), ask('read_file', { path: 'office/autoupdate.log', limit: 1 })]);
    assert.equal(byName.receipt.path, 'reports/crash_summary.txt');
    assert.deepEqual(byName.notes, ['path "crash_summary.txt" was read as "reports/crash_summary.txt".']);
    assert.equal(byPart.receipt.path, 'office/excel_footprint.txt');
    assert.equal(log.receipt.timelineEntries, 40);
    assert.deepEqual(log.notes, []);
    checkNext(log.next, 'excel_diag_read_file {path: "office/autoupdate.log", fromLine: 2, limit: 1}', 'excel_diag_search {query: "source:office/autoupdate.log"}');
  });

  it('read_file with grep gives only the matching lines, numbered', async () => {
    const [hit, miss] = await Promise.all([ask('read_file', { path: 'summary.md', grep: 'COMPLETE' }), ask('read_file', { path: 'summary.md', grep: 'zzzz' })]);
    assert.equal(hit.receipt.grep, 'COMPLETE');
    assert.equal(hit.receipt.matchedLines, 4);
    assert.equal(hit.receipt.lines, 24);
    assert.equal(hit.receipt.truncated, false);
    const [lead, ...lines] = hit.text.split('\n');
    assert.equal(lead, '4 lines that contain grep, each after its line number:');
    assert.equal(lines.length, 4);
    for (const l of lines) assert.match(l, /^\d+: \| \w+ \| complete \|/);
    assert.deepEqual(hit.receipt.shown, { fromLine: Number(lines[0].split(':')[0]), toLine: Number(lines[3].split(':')[0]) });
    assert.equal(miss.ok, true);
    assert.equal(miss.receipt.matchedLines, 0);
    assert.equal(miss.text, undefined);
    assert.deepEqual(miss.notes, ['No line of this file contains "zzzz". Capitals are ignored.']);
  });

  it('read_file with grep on a .csv or .tsv file gives its first line first, for the names of its columns', async () => {
    const HEAD = '1: local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,excel_compressed_mb,excel_threads,pressure_level,free_mb,compressor_mb,swap_used_mb';
    const [csv, onward, named, none, tsv] = await Promise.all([ask('read_file', { path: 'excel_memory_timeline.csv', grep: '10:34:' }), ask('read_file', { path: 'excel_memory_timeline.csv', grep: 'free', fromLine: 2 }),
      ask('read_file', { path: 'excel_memory_timeline.csv', grep: 'utc_time' }), ask('read_file', { path: 'excel_memory_timeline.csv', grep: 'zzzz' }), ask('read_file', { path: 'unified_logs/2026-03-10.tsv', grep: 'exceeded mem limit' })]);
    assert.deepEqual(csv.text.split('\n'), ['Line 1, then 2 lines that contain grep, each after its line number:', HEAD, '190: 2026-03-10 10:34:00,2026-03-10 14:34:00,4121,61.2,6183,3381,43,4,549,4756,3818', '191: 2026-03-10 10:34:30,2026-03-10 14:34:30,4121,17.2,6241,3423,50,4,525,4778,3859']);
    assert.deepEqual([csv.receipt.matchedLines, csv.receipt.shown], [2, { fromLine: 190, toLine: 191 }], 'line 1 is not a match and not in shown');
    assert.deepEqual(csv.notes, ['Line 1 is listed first, as it is in every grep of a .csv or .tsv file; it does not contain "10:34:".']);
    // whatever line the matches start from, and when line 1 matched and was passed over
    assert.equal(onward.text, undefined, 'free is only in line 1, which fromLine 2 passes over: no line is listed, so neither is line 1');
    assert.deepEqual(onward.notes, ['No line from line 2 on contains "free"; 1 earlier line does.']);
    const later = await ask('read_file', { path: 'excel_memory_timeline.csv', grep: '10:34:', fromLine: 191 });
    assert.deepEqual(later.text.split('\n'), ['Line 1, then 1 line from line 191 on that contains grep, each after its line number:', HEAD, '191: 2026-03-10 10:34:30,2026-03-10 14:34:30,4121,17.2,6241,3423,50,4,525,4778,3859']);
    assert.deepEqual(named.text.split('\n'), ['1 line that contains grep, after its line number:', HEAD]);
    assert.deepEqual(named.notes, [], 'line 1 matched: it is listed as the match it is');
    assert.equal(none.text, undefined, 'nothing matched, so nothing is listed');
    assert.match(tsv.text.split('\n')[1], /^1: local_time\tutc_time\tlevel\t/);
    assert.match(tsv.text.split('\n')[2], /^\d+: .*exceeded mem limit/);
    const plain = await ask('read_file', { path: 'summary.md', grep: 'Mode' });
    assert.ok(!plain.text.split('\n')[1].startsWith('1: ') && !plain.text.startsWith('Line 1, then'), 'not for other files');
  });

  it('memory reports figures and files, and no sentence about what they mean', async () => {
    const d = await ask('memory');
    const r = d.receipt;
    assert.deepEqual(r.files.map((f) => [f.kind, f.path]), [['timeline', 'excel_memory_timeline.csv'], ['snapshot', 'system/memory.txt'], ['excelMemory', 'office/excel_footprint.txt'], ['jetsamReport', JETSAM_REPORT]]);
    for (const f of r.files) assert.ok(Number.isInteger(f.bytes) && f.bytes > 0);
    assert.equal(r.timeline.path, 'excel_memory_timeline.csv');
    assert.equal(r.timeline.samples, 360);
    assert.equal(r.timeline.from, '2026-03-10 09:00:00');
    assert.equal(r.timeline.to, '2026-03-10 11:59:30');
    assert.deepEqual(r.timeline.excelFootprintMb, { lowest: { value: 644, at: '2026-03-10 10:35:00' }, highest: { value: 6241, at: '2026-03-10 10:34:30' }, last: 1067 });
    for (const k of ['excelCpuPct', 'excelThreads', 'freeMb', 'swapUsedMb']) assert.deepEqual(Object.keys(r.timeline[k]), ['lowest', 'highest', 'last']);
    // each level with how many samples have it and each run of samples at it, from its first sample to its last
    assert.deepEqual(r.timeline.pressureLevels, [
      { level: 1, name: 'normal', samples: 283, seen: [{ from: '2026-03-10 09:00:00', to: '2026-03-10 09:57:00' }, { from: '2026-03-10 10:35:00', to: '2026-03-10 10:35:00' }, { from: '2026-03-10 10:36:30', to: '2026-03-10 11:59:30' }] },
      { level: 2, name: 'warning', samples: 49, seen: [{ from: '2026-03-10 09:57:30', to: '2026-03-10 10:20:30' }, { from: '2026-03-10 10:35:30', to: '2026-03-10 10:36:00' }] },
      { level: 4, name: 'critical', samples: 28, seen: [{ from: '2026-03-10 10:21:00', to: '2026-03-10 10:34:30' }] }]);
    assert.equal(r.timeline.pressureLevels.reduce((n, l) => n + l.samples, 0), r.timeline.samples, 'every sample has a level');
    assert.deepEqual(r.timeline.excelPids, [4121, 4307]);
    assert.equal(r.samplesListed, undefined, 'no time was asked, so no sample is listed');
    assert.equal(r.timeZone, 'UTC-04:00');
    assert.equal(r.memoryEntries, 2856);
    assert.equal(d.text, undefined);
    assert.deepEqual(d.notes, []);
    checkNext(d.next, 'excel_diag_read_file {path: "excel_memory_timeline.csv"}', 'excel_diag_search {query: "tag:memory"}');
    assert.ok(!/because|caused|leak|due to|ran out|too much|not enough/i.test(JSON.stringify(d)), 'figures only');
  });

  it('memory at a moment: the samples nearest it, each with its columns, and the entries tagged memory around it', async () => {
    const d = await ask('memory', { time: '2026-03-10 10:34:10' }), r = d.receipt;
    assert.equal(r.time, '2026-03-10 10:34:10', 'how the call was read comes first');
    assert.deepEqual(Object.keys(r)[0], 'time');
    // three at or before the time and three after, in time order
    assert.deepEqual(r.samplesListed.map((x) => x.time), ['2026-03-10 10:33:00', '2026-03-10 10:33:30', '2026-03-10 10:34:00', '2026-03-10 10:34:30', '2026-03-10 10:35:00', '2026-03-10 10:35:30']);
    assert.deepEqual(r.samplesListed[2], { time: '2026-03-10 10:34:00', excelPid: 4121, excelCpuPct: 61.2, excelFootprintMb: 6183, excelCompressedMb: 3381, excelThreads: 43, pressureLevel: 4, freeMb: 549, compressorMb: 4756, swapUsedMb: 3818 });
    assert.deepEqual(r.samplesListed[5], { time: '2026-03-10 10:35:30', pressureLevel: 2, freeMb: 1060, compressorMb: 3100, swapUsedMb: 1800 }, 'an empty cell gives no field');
    // the same figures read_file gives for that line, under the file's own column names
    const line = await ask('read_file', { path: 'excel_memory_timeline.csv', grep: '2026-03-10 14:34:00' });
    assert.equal(line.text.split('\n')[2], '190: 2026-03-10 10:34:00,2026-03-10 14:34:00,4121,61.2,6183,3381,43,4,549,4756,3818');
    assert.deepEqual(d.notes, []);
    checkNext(d.next, 'excel_diag_search {query: "tag:memory", aroundTime: "2026-03-10 10:34:10", window: "5m"}');
    assert.ok(!/because|caused|leak|due to|ran out|too much|not enough|low\b/i.test(JSON.stringify(d)), 'figures only');
    // before the first sample, the first ones are listed and a note says where the timeline runs
    const early = await ask('memory', { time: '2026-03-10 08:00:00' });
    assert.deepEqual(early.receipt.samplesListed.map((x) => x.time), ['2026-03-10 09:00:00', '2026-03-10 09:00:30', '2026-03-10 09:01:00']);
    assert.deepEqual(early.notes, ["The memory timeline's samples run from 2026-03-10 09:00:00 to 2026-03-10 11:59:30, so time is before its first sample, and the first 3 samples are listed."]);
    const late = await ask('memory', { time: '2026-03-10 11:59:30' });
    assert.deepEqual(late.receipt.samplesListed.map((x) => x.time), ['2026-03-10 11:58:30', '2026-03-10 11:59:00', '2026-03-10 11:59:30']);
    assert.deepEqual(late.notes, ["The memory timeline's samples run from 2026-03-10 09:00:00 to 2026-03-10 11:59:30, so time is at or after its last sample, and the last 3 samples are listed."]);
  });

  it('memory over a span: its samples, every few when there are many, and the pressure levels seen from its start', async () => {
    const [few, many] = await Promise.all([ask('memory', { from: '2026-03-10 10:34:00', to: '2026-03-10 10:35:30' }), ask('memory', { from: '2026-03-10 10:00:00', to: '2026-03-10 10:40:00' })]);
    assert.deepEqual([few.receipt.from, few.receipt.to, few.receipt.samplesInSpan], ['2026-03-10 10:34:00', '2026-03-10 10:35:30', 3]);
    assert.deepEqual(few.receipt.samplesListed.map((x) => x.time), ['2026-03-10 10:34:00', '2026-03-10 10:34:30', '2026-03-10 10:35:00'], 'to is not part of the span');
    assert.deepEqual(few.notes, []);
    assert.equal(few.receipt.truncated, undefined);
    checkNext(few.next, 'excel_diag_search {query: "tag:memory", from: "2026-03-10 10:34:00", to: "2026-03-10 10:35:30"}');
    assert.equal(many.receipt.samplesInSpan, 80);
    assert.equal(many.receipt.samplesListed.length, 12);
    assert.deepEqual(many.receipt.samplesListed.slice(0, 2).map((x) => x.time), ['2026-03-10 10:00:00', '2026-03-10 10:03:30']);
    assert.equal(many.receipt.truncated, true);
    assert.deepEqual(many.notes, ['80 samples of the memory timeline are in this span, and every 7th one is listed, from the first, so that no more than 12 are. A shorter span lists more of them.']);
    const third = await ask('memory', { from: '2026-03-10 10:00:00', to: '2026-03-10 10:15:00' });
    assert.equal(third.notes[0], '30 samples of the memory timeline are in this span, and every 3rd one is listed, from the first, so that no more than 12 are. A shorter span lists more of them.');
    assert.equal(third.receipt.samplesListed.length, 10);
    const none = await ask('memory', { from: '2026-03-10 13:00:00' });
    assert.deepEqual([none.receipt.samplesInSpan, none.receipt.samplesListed], [0, []]);
    assert.deepEqual(none.notes, ['No sample of the memory timeline is in this span. Its samples run from 2026-03-10 09:00:00 to 2026-03-10 11:59:30.']);
  });

  it('utc: true shows and reads every time in UTC, and next keeps it', async () => {
    const [show, search, memory] = await Promise.all([
      ask('show', { id: 139, utc: true }),
      ask('search', { from: '2026-03-10 13:00:50', to: '2026-03-10 13:00:51', utc: true }),
      ask('memory', { utc: true }),
    ]);
    assert.equal(show.receipt.time, '2026-03-10 13:00:50');
    assert.equal(show.receipt.utcTime, '2026-03-10 13:00:50');
    assert.equal(show.receipt.timeZone, 'UTC');
    checkNext(show.next, 'excel_diag_context {id: 139, utc: true}');
    assert.equal(search.receipt.timeZone, 'UTC');
    assert.match(search.text, /^\s*139  2026-03-10 13:00:50\.400  /m);
    assert.equal(memory.receipt.timeline.excelFootprintMb.lowest.at, '2026-03-10 14:35:00');
    assert.ok(!memory.next.includes('excel_memory_timeline.csv", utc'), 'read_file takes no utc, so next does not send it one');
  });

  it('a time ending in Z or an offset is read in that zone whatever the bundle uses', async () => {
    const [z, off] = await Promise.all([ask('search', { from: '2026-03-10T13:00:50Z', to: '2026-03-10 13:00:51Z', limit: 1 }), ask('context', { time: '2026-03-10 15:35:00+01:00', before: 0, after: 0 })]);
    assert.equal(z.receipt.from, '2026-03-10 09:00:50');
    assert.match(z.text, /^\s*139  2026-03-10 09:00:50\.400  /m);
    assert.equal(off.receipt.anchorId, 19089, 'the report at that moment');
  });

  it('the built-in sample opens only when the request allows it', async () => {
    const [allowed, ordinary] = await Promise.all([ask('summary', { bundle: 'sample' }, { allowSample: true }), ask('summary', { bundle: 'sample' })]);
    assert.equal(allowed.bundle, 'sample');
    assert.equal(allowed.receipt.entries, 32861);
    assert.ok(allowed.notes.length && allowed.notes.every((n) => n.includes('bundle: "sample"')), 'the calls its facts offer stay on that bundle');
    checkNext(allowed.next, 'excel_diag_histogram {bundle: "sample"}');
    // Without the test switch, "sample" is a name like any other: here it is part of the one bundle's id.
    assert.equal(ordinary.bundle, SAMPLE_ID);
    assert.equal(ordinary.notes[0], `bundle "sample" was read as "${SAMPLE_ID}".`);
  });

  it('cleanup', async () => { await cleanup(); });
});
