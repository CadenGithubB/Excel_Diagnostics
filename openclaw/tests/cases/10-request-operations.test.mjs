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
  it('summary gives the bundle as facts, one line per log source, and where to look first', async () => {
    const d = await ask('summary');
    assert.equal(d.ok, true);
    assert.equal(d.bundle, SAMPLE_ID);
    assert.deepEqual(d.notes, []);
    const r = d.receipt;
    assert.equal(r.bundle, SAMPLE_ID);
    assert.equal(r.collectorMode, undefined, 'the sample id names no collector mode');
    assert.equal(r.files, 15);
    assert.ok(Number.isInteger(r.bytes) && r.bytes > 5e6);
    assert.equal(r.entries, 32861);
    assert.deepEqual(r.period, { from: '2026-03-10 09:00:00', to: '2026-03-10 11:59:59' });
    assert.equal(r.timeZone, 'UTC-04:00');
    assert.deepEqual(r.bySeverity, { Fault: 2, Error: 1058, Warning: 235, Notice: 11381, Info: 17312, Debug: 2873 });
    assert.equal(r.byTag.memory, 2856);
    assert.equal(r.topProcesses.length, 8);
    assert.deepEqual(r.topProcesses[0], { process: 'Microsoft Excel', entries: 18561 });
    assert.equal(r.processes, 14);
    assert.deepEqual(r.reports, { total: 2, byKind: { Jetsam: 1, Crash: 1 } });
    assert.deepEqual(r.availableBundles, [SAMPLE_ID]);
    assert.equal(r.bundles, 1);
    const lines = d.text.split('\n');
    assert.match(lines[0], /^\s*ENTRIES\s+SOURCE\s+FIRST\s+LAST\s+FILE$/);
    assert.equal(lines.length, 6, 'a heading and the five log sources');
    assert.ok(lines.some((l) => /^\s*23874\s+unified\s+2026-03-10 09:00:00\s+2026-03-10 11:59:59\s+unified_logs\/2026-03-10\.tsv$/.test(l)), d.text);
    checkNext(d.next, 'excel_diag_search {minSeverity: "error"}', 'excel_diag_reports {}', 'excel_diag_histogram {}');
    assert.ok(d.next.includes('1060 errors and faults'), 'the count in next says what it counts');
  });

  it('search echoes how the call was read and lists entries one per line', async () => {
    const d = await ask('search', { minSeverity: 'Error', limit: 5 });
    assert.deepEqual(d.receipt, { query: '', minSeverity: 'error', matched: 1060, total: 32861, shown: { first: 1, last: 5 }, truncated: true, nextOffset: 5, timeZone: 'UTC-04:00' });
    const lines = d.text.split('\n');
    assert.match(lines[0], /^\s*ID\s+TIME\s+LEVEL\s+SOURCE\s+PROCESS\[PID\]\s+MESSAGE$/);
    assert.equal(lines.length, 6);
    assert.match(lines[1], /^\s*139  2026-03-10 09:00:50\.400  Unexpected  excel    Microsoft Excel\[4121\]  TelemetryEvent::Log \{"Activity":"Paint","Result":"Failed","Value":434\}$/);
    checkNext(d.next, 'excel_diag_context {id: 139}', 'excel_diag_search {minSeverity: "Error", limit: 5, offset: 5}', 'excel_diag_count {minSeverity: "Error", by: "process"}');
  });

  it('search follows nextOffset to the page after, and newest gives the last page', async () => {
    const [second, last] = await Promise.all([ask('search', { minSeverity: 'error', limit: 5, offset: 5 }), ask('search', { query: 'pivot', newest: true, limit: 2 })]);
    assert.deepEqual(second.receipt.shown, { first: 6, last: 10 });
    assert.equal(second.receipt.nextOffset, 10);
    assert.deepEqual(last.receipt.shown, { first: 3837, last: 3838 });
    assert.equal(last.receipt.matched, 3838);
    assert.equal(last.receipt.truncated, true, 'earlier matches exist');
    assert.equal(last.receipt.nextOffset, undefined, 'nothing comes after the newest');
    checkNext(last.next, 'excel_diag_search {query: "pivot", limit: 2, offset: 3834}');
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
    assert.match(tag.notes[0], /no tag in this bundle contains "nosuchtag".*The tags here are/);
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
      category: 'Telemetry Event', extra: { threadTid: '0x1d', eventId: 'jez7' }, messageChars: 70, truncated: false,
    });
    assert.equal(d.text, 'TelemetryEvent::Log {"Activity":"Paint","Result":"Failed","Value":434}');
    checkNext(d.next, 'excel_diag_context {id: 139}');
  });

  it('show keeps the line breaks of a message, names tags, and points at a report file', async () => {
    const [fault, report] = await Promise.all([ask('show', { id: 18689 }), ask('show', { id: 19089 })]);
    assert.equal(fault.receipt.severity, 'Fault');
    assert.equal(fault.receipt.level, undefined, 'the level is given only when the log calls it something else');
    assert.deepEqual(fault.receipt.tags, ['excel']);
    assert.equal(fault.text.split('\n').length, 3);
    assert.equal(fault.receipt.messageChars, fault.text.length);
    assert.equal(report.receipt.reportFile, CRASH_REPORT);
    assert.equal(report.receipt.file, undefined, 'a report entry comes from no log file');
    assert.equal(report.receipt.level, 'Crash');
    checkNext(report.next, 'excel_diag_context {id: 19089}', `excel_diag_read_file {path: "${CRASH_REPORT}"}`);
  });

  it('context lists what every source logged around an entry and marks it', async () => {
    const d = await ask('context', { id: 139, before: 3, after: 3 });
    assert.deepEqual(d.receipt, { anchorId: 139, anchorTime: '2026-03-10 09:00:50', shown: { firstId: 136, lastId: 142 }, entries: 7, truncated: false, timeZone: 'UTC-04:00' });
    const lines = d.text.split('\n');
    assert.equal(lines.length, 8);
    assert.match(lines[4], /^>139  2026-03-10 09:00:50\.400  Unexpected/);
    assert.equal(lines.filter((l) => l.startsWith('>')).length, 1);
    assert.match(lines[1], /^ 136  /);
    checkNext(d.next, 'excel_diag_show {id: 139}', 'excel_diag_context {id: 139, before: 16, after: 16}', 'excel_diag_search {query: "process:\\"Microsoft Excel\\"", aroundId: 139, window: "1m"}');
  });

  it('context by time anchors on the first entry at or after it and says so', async () => {
    const [at, past, quiet] = await Promise.all([
      ask('context', { time: '2026-03-10 10:35:00', before: 1, after: 1 }),
      ask('context', { time: '2027-01-01' }),
      ask('context', { time: '2027-01-01', window: '5s' }),
    ]);
    assert.equal(at.receipt.anchorId, 19087);
    assert.equal(at.receipt.anchorTime, '2026-03-10 10:35:00');
    assert.equal(at.receipt.entries, 3);
    assert.deepEqual(at.notes, ['The anchor is entry 19087, the first entry at or after 2026-03-10 10:35:00.']);
    assert.equal(past.receipt.anchorId, 32860);
    assert.match(past.notes[0], /^No entry is at or after 2027-01-01 00:00:00, so the anchor is the entry nearest before it, 32860\.$/);
    assert.equal(quiet.ok, true);
    assert.equal(quiet.receipt.entries, 0);
    assert.equal(quiet.receipt.entriesInWindow, 0);
    assert.equal(quiet.text, undefined);
    assert.match(quiet.notes[0], /^Nothing was logged within 5 s either side of 2027-01-01 00:00:00\.$/);
    checkNext(quiet.next, 'excel_diag_context {time: "2027-01-01"}');
  });

  it('reports lists the report files oldest first and follows up the newest', async () => {
    const d = await ask('reports');
    assert.deepEqual(d.receipt, { reports: 2, byKind: { Jetsam: 1, Crash: 1 }, shown: 2, truncated: false, timeZone: 'UTC-04:00' });
    const lines = d.text.split('\n');
    assert.match(lines[0], /^TIME\s+KIND\s+PROCESS\s+FILE$/);
    assert.match(lines[1], new RegExp(`^2026-03-10 10:32:30  Jetsam  JetsamEvent\\s+${JETSAM_REPORT.replace(/[.]/g, '\\.')}$`));
    assert.match(lines[2], /^2026-03-10 10:35:00  Crash   Microsoft Excel  /);
    checkNext(d.next, `excel_diag_read_file {path: "${CRASH_REPORT}"}`, 'excel_diag_context {time: "2026-03-10 10:35:00", window: "1m"}');
  });

  it('files lists paths with sizes and timeline entries, and filter narrows by part of a path', async () => {
    const [all, some, none] = await Promise.all([ask('files'), ask('files', { filter: 'REPORT' }), ask('files', { filter: 'zzzz' })]);
    assert.equal(all.receipt.files, 15);
    assert.equal(all.receipt.filter, undefined);
    assert.deepEqual(all.receipt.shown, { first: 1, last: 15 });
    assert.equal(all.receipt.truncated, false);
    assert.match(all.text.split('\n')[0], /^\s*SIZE\s+TIMELINE_ENTRIES\s+PATH$/);
    assert.match(all.text, /^\s*[\d.]+ [KM]B\s+23874\s+unified_logs\/2026-03-10\.tsv$/m);
    assert.match(all.text, /^\s*[\d.]+ K?B\s+-\s+summary\.md$/m);
    assert.deepEqual({ filter: some.receipt.filter, files: some.receipt.files, filesInBundle: some.receipt.filesInBundle }, { filter: 'REPORT', files: 3, filesInBundle: 15 });
    checkNext(some.next, `excel_diag_read_file {path: "${JETSAM_REPORT}"}`);
    assert.equal(none.ok, true);
    assert.equal(none.receipt.files, 0);
    assert.equal(none.text, undefined);
    assert.deepEqual(none.notes, ['No file path in this bundle contains "zzzz".']);
    checkNext(none.next, 'excel_diag_files {}');
  });

  it('read_file gives lines of a file and how to go on', async () => {
    const d = await ask('read_file', { path: 'summary.md', limit: 5 });
    assert.deepEqual(d.receipt, { path: 'summary.md', bytes: 935, lines: 23, shown: { fromLine: 1, toLine: 5 }, truncated: true, nextFromLine: 6 });
    const lines = d.text.split('\n');
    assert.equal(lines.length, 5);
    assert.equal(lines[0], '# Excel diagnostics summary');
    checkNext(d.next, 'excel_diag_read_file {path: "summary.md", fromLine: 6, limit: 5}');
    const rest = await ask('read_file', { path: 'summary.md', fromLine: 6 });
    assert.deepEqual(rest.receipt.shown, { fromLine: 6, toLine: 23 });
    assert.equal(rest.receipt.truncated, false);
    assert.equal(rest.receipt.nextFromLine, undefined);
  });

  it('read_file accepts a unique name or part of a path and says which file it read', async () => {
    const [byName, byPart, log] = await Promise.all([ask('read_file', { path: 'crash_summary.txt' }), ask('read_file', { path: 'footprint', limit: 2 }), ask('read_file', { path: 'office/autoupdate.log', limit: 1 })]);
    assert.equal(byName.receipt.path, 'reports/crash_summary.txt');
    assert.deepEqual(byName.notes, ['path "crash_summary.txt" was read as reports/crash_summary.txt.']);
    assert.equal(byPart.receipt.path, 'office/excel_footprint.txt');
    assert.equal(log.receipt.timelineEntries, 40);
    assert.deepEqual(log.notes, []);
    checkNext(log.next, 'excel_diag_read_file {path: "office/autoupdate.log", fromLine: 2, limit: 1}', 'excel_diag_search {query: "source:office/autoupdate.log"}');
  });

  it('read_file with grep gives only the matching lines, numbered', async () => {
    const [hit, miss] = await Promise.all([ask('read_file', { path: 'summary.md', grep: 'COMPLETE' }), ask('read_file', { path: 'summary.md', grep: 'zzzz' })]);
    assert.equal(hit.receipt.grep, 'COMPLETE');
    assert.equal(hit.receipt.matchedLines, 4);
    assert.equal(hit.receipt.lines, 23);
    assert.equal(hit.receipt.truncated, false);
    const lines = hit.text.split('\n');
    assert.equal(lines.length, 4);
    for (const l of lines) assert.match(l, /^\d+: \| \w+ \| complete \|/);
    assert.deepEqual(hit.receipt.shown, { fromLine: Number(lines[0].split(':')[0]), toLine: Number(lines[3].split(':')[0]) });
    assert.equal(miss.ok, true);
    assert.equal(miss.receipt.matchedLines, 0);
    assert.equal(miss.text, undefined);
    assert.deepEqual(miss.notes, ['No line of this file contains "zzzz". Capitals are ignored.']);
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
    assert.deepEqual(r.timeline.pressureLevels, [{ level: 1, name: 'normal' }, { level: 2, name: 'warning' }, { level: 4, name: 'critical' }]);
    assert.deepEqual(r.timeline.excelPids, [4121, 4307]);
    assert.equal(r.timeZone, 'UTC-04:00');
    assert.equal(r.memoryEntries, 2856);
    assert.equal(d.text, undefined);
    assert.deepEqual(d.notes, []);
    checkNext(d.next, 'excel_diag_read_file {path: "excel_memory_timeline.csv"}', 'excel_diag_search {query: "tag:memory"}');
    assert.ok(!/because|caused|leak|due to|ran out|too much|not enough/i.test(JSON.stringify(d)), 'figures only');
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
    assert.equal(off.receipt.anchorId, 19087);
  });

  it('the built-in sample opens only when the request allows it', async () => {
    const [allowed, ordinary] = await Promise.all([ask('summary', { bundle: 'sample' }, { allowSample: true }), ask('summary', { bundle: 'sample' })]);
    assert.equal(allowed.bundle, 'sample');
    assert.equal(allowed.receipt.entries, 32861);
    assert.deepEqual(allowed.notes, []);
    checkNext(allowed.next, 'excel_diag_histogram {bundle: "sample"}');
    // Without the test switch, "sample" is a name like any other: here it is part of the one bundle's id.
    assert.equal(ordinary.bundle, SAMPLE_ID);
    assert.deepEqual(ordinary.notes, [`bundle "sample" was read as ${SAMPLE_ID}.`]);
  });

  it('cleanup', async () => { await cleanup(); });
});
