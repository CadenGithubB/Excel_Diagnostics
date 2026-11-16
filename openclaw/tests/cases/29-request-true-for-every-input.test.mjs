// Request mode: each sentence true for every input, and each call offered one the tool takes and that does what it says.
//
// A small model believes what a fact says and copies the calls it is offered. So a fact that the macOS log does not cover
// a moment that holds an entry of it, a call offered that is refused or lays out another file, a count of "report files"
// that counts entries, or a hint that gives back a value the argument then refuses, each sends it the wrong way. Each
// spec here is one such sentence or call, on a made-up bundle built to reach it: the last entry of a day the search did
// not finish, records that are not text, a force-quit record with six dates, report paths with a space at one end, a
// memory timeline longer than is read, a clock that changed its offset, and the like. Nothing here is from a real Mac.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, assert, request, cli, emptyDir, cleanup, sampleBundlesDir, loadPlugin, blocks, SAMPLE_ID } from '../harness.mjs';
import { put, LF, writeIncomplete, writeReports, INCOMPLETE, REPORTS_BUNDLE } from '../made-up.mjs';

let cacheDir = null;
async function send(dir, op, params = {}) {
  cacheDir ??= await emptyDir('cache');
  const t = Date.now(), r = await request({ format: 1, op, bundlesDir: await dir, cacheDir, params });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', r.stdout.slice(0, 300));
  for (const d of [await dir, os.tmpdir(), os.homedir()]) assert.ok(!r.stdout.includes(d), `a path of this machine is in the output: ${d}`);
  return { ...r.json, ms: Date.now() - t };
}
async function ask(dir, op, params = {}) {
  const d = await send(dir, op, params);
  assert.equal(d.ok, true, JSON.stringify(d).slice(0, 400));
  return d;
}
// A bundles folder holding one bundle, made by `write` into its folder
async function bundle(id, write) {
  const dir = await emptyDir('true');
  await write(path.join(dir, id));
  return dir;
}
const z2 = (n) => String(n).padStart(2, '0');
const UNIFIED_HEAD = 'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage';
// a macOS log line on a clock four hours behind UTC
const unified = (day, hms, level, message, process = 'kernel') => {
  const [h, m, s] = hms.split(':').map(Number), at = new Date(Date.UTC(...day.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)), h + 4, m, s));
  return [`${day} ${hms}.000000-0400`, `${at.toISOString().slice(0, 19).replace('T', ' ')}.000000`, level, process, '0', process, '', '', '', message].join('\t');
};
const incomplete = () => bundle(INCOMPLETE, writeIncomplete);
const STATUS = 'unified_logs/collection_status.txt';
const COVER = /does not cover|covers none/;

describe('the macOS log covers the last entry of each span it has', () => {
  it('a moment, or a window that starts there, at the last entry of a day the search did not finish is covered', async () => {
    const dir = await incomplete();
    const [at, from, longer] = await Promise.all([ask(dir, 'context', { time: '2026-04-02 03:00:00' }), ask(dir, 'search', { from: '2026-04-02 03:00:00', to: '2026-04-02 03:00:01' }),
      ask(dir, 'search', { from: '2026-04-02 03:00:00', to: '2026-04-02 03:00:05' })]);
    assert.deepEqual(at.notes, ['The anchor is entry 10, the first entry at or after 2026-04-02 03:00:00.']);
    assert.deepEqual([from.notes, from.receipt.matched], [[], 1], 'the entry at that moment is listed, and no fact says the log does not cover it');
    // a window past it: the part after the entry's second is the part said
    assert.deepEqual(longer.notes, [`The macOS log in this bundle does not cover part of this time window: from 2026-04-02 03:00:01 to 2026-04-02 03:00:05. ${STATUS} records for 2026-04-02: "hit the 30-minute limit, partial (4 entries; rerun with a larger --max-wait for the rest)".`]);
  });

  it('a day of one entry covers that entry, and the summary\'s own search of it says nothing of coverage', async () => {
    const dir = await bundle('One_entry', async (root) => {
      await put(root, STATUS, `Date | Status${LF}2026-06-02 | ok (1 entries)${LF}`);
      await put(root, 'unified_logs/2026-06-02.tsv', `${UNIFIED_HEAD}${LF}${unified('2026-06-02', '09:00:00', 'Error', 'only entry', 'Microsoft Excel')}${LF}`);
    });
    const [at, summary] = await Promise.all([ask(dir, 'context', { time: '2026-06-02 09:00:00' }), ask(dir, 'summary')]);
    assert.ok(!at.notes.some((n) => COVER.test(n)), JSON.stringify(at.notes));
    const offered = /excel_diag_search \{minSeverity: "error", from: "([^"]+)", to: "([^"]+)"\}/.exec(summary.next);
    assert.ok(offered, summary.next);
    const search = await ask(dir, 'search', { minSeverity: 'error', from: offered[1], to: offered[2] });
    assert.deepEqual([search.notes, search.receipt.matched], [[], 1]);
  });

  it('a day searched to its end is covered to its last millisecond, and the next day from its own start', async () => {
    // 2026-04-01 was searched to its end; the window starts at the midnight that ends it
    const d = await ask(incomplete(), 'count', { from: '2026-04-02', to: '2026-04-03' });
    assert.ok(d.notes[0].startsWith('The macOS log in this bundle does not cover part of this time window: from 2026-04-02 00:00:00 to 2026-04-02 00:10:00, '), d.notes[0]);
  });
});

describe('a coverage fact over a status file of many lines', () => {
  it('is quick, however many lines and spans there are', async () => {
    // 3,000 log files of one entry, two days apart, and 60,000 lines of a day that is not among them: each day line
    // used to be worked out again for each part not covered (14 s for this call)
    const dir = await bundle('Many_spans', async (root) => {
      const base = Date.UTC(2025, 0, 1, 12);
      for (let i = 0; i < 3000; i++) {
        const t = new Date(base + i * 2 * 86400000), u = t.toISOString().slice(0, 19).replace('T', ' ');
        await put(root, `unified_logs/${t.toISOString().slice(0, 10)}.tsv`, `${UNIFIED_HEAD}${LF}${u}.000000+0000\t${u}.000000\tDefault\tkernel\t0\tk\t\t\t\tone${LF}`);
      }
      await put(root, STATUS, `Date | Status${LF}${'1999-01-01 | error\n'.repeat(60000)}`);
    });
    const d = await ask(dir, 'search', { from: '2025-01-01 00:00:00', to: '2045-01-01 00:00:00', limit: 1 });
    assert.ok(d.ms < 5000, `${d.ms} ms`);
    assert.ok(d.notes.some((n) => n.endsWith('and 2998 more spans.')), JSON.stringify(d.notes));
  });

  it('reads the whole status file, a line separator in a day line among it, and counts the other lines as lines', async () => {
    const filler = Array.from({ length: 1500 }, (_, i) => `access check ${String(i).padStart(4, '0')} | skipped: ${'x'.repeat(80)}`).join(LF);
    // collected the next day, so that a day searched to its end is covered to its end
    const make = (day) => bundle('Long_status', async (root) => {
      await put(root, 'bundle_info.tsv', `collector_version\t1.5.0${LF}mode\tcollect${LF}collected_local\t2026-06-02 12:00:00 EDT${LF}collected_utc\t2026-06-02 16:00:00${LF}`);
      await put(root, STATUS, `Date | Status${LF}${filler}${LF}${day}${LF}`);
      await put(root, 'unified_logs/2026-06-01.tsv', `${UNIFIED_HEAD}${LF}${unified('2026-06-01', '10:00:00', 'Default', 'one')}${LF}${unified('2026-06-01', '11:00:00', 'Default', 'two')}${LF}`);
    });
    // the day was searched to its end, so the evening is covered: past 64 KB of the file, and with U+2028 in its line
    for (const day of ['2026-06-01 | ok (2 entries)', '2026-06-01 | ok (2 entries) kept whole']) {
      const d = await ask(make(day), 'search', { from: '2026-06-01 12:00:00', to: '2026-06-01 18:00:00' });
      assert.ok(!d.notes.some((n) => COVER.test(n)), JSON.stringify(d.notes).slice(0, 400));
    }
    const d = await ask(make('2026-06-01 | ok (2 entries)'), 'search', { from: '2026-06-02 12:00:00', to: '2026-06-02 18:00:00' });
    assert.ok(d.notes[0].endsWith('; and it has 1497 more such lines, each for a day of that part or for no day.'), d.notes[0].slice(-200));
    assert.ok(!d.notes[0].includes('more days'), 'a line that names no day is not a day');
  });
});

describe('read_file is offered for what the collector recorded only as one call reads it', () => {
  it('a record that is not text is not offered, and a fact says why', async () => {
    const dir = await bundle(INCOMPLETE, async (root) => {
      await writeIncomplete(root);
      await put(root, 'manifest.tsv', `component\tstatus\tdetails${LF}system\tincomplete\tx${LF}\0${LF}`);
      await put(root, STATUS, `Date | Status${LF}2026-04-01 | ok (6 entries)${LF}2026-04-02 | error${LF}\0${LF}`);
      await put(root, 'case/incident_context.md', `# Incident context${LF}\0${LF}`);
    });
    const [summary, search] = await Promise.all([ask(dir, 'summary'), ask(dir, 'search', { query: 'pivot', from: '2026-04-03 00:00', to: '2026-04-03 12:00' })]);
    assert.ok(!summary.next.includes('excel_diag_read_file'), summary.next);
    for (const p of ['case/incident_context.md', 'manifest.tsv']) assert.ok(summary.notes.includes(`excel_diag_read_file does not read ${p}: it has a zero byte in its first 4 KB, so it is not text.`), JSON.stringify(summary.notes));
    assert.ok(search.next.startsWith('excel_diag_summary {} shows what this bundle holds and what it records about its collection.'), search.next);
    for (const p of ['manifest.tsv', STATUS, 'case/incident_context.md']) assert.equal((await send(dir, 'read_file', { path: p })).error, 'binary file', 'read_file does refuse each');
  });

  it('a record longer than one call reads is offered as what one call reads of it', async () => {
    const dir = await bundle(INCOMPLETE, async (root) => {
      await writeIncomplete(root);
      await put(root, 'manifest.tsv', `component\tstatus\tdetails${LF}${Array.from({ length: 60 }, (_, i) => `step${z2(i)}\tincomplete\tdetail ${i}`).join(LF)}${LF}`);
      await put(root, STATUS, `Date | Status${LF}${Array.from({ length: 45 }, (_, i) => `2026-02-${z2((i % 28) + 1)} | ok (${i} entries)`).join(LF)}${LF}2026-04-03 | error 1${LF}`);
    });
    const [summary, search] = await Promise.all([ask(dir, 'summary'), ask(dir, 'search', { query: 'pivot', from: '2026-04-03 00:00', to: '2026-04-03 12:00' })]);
    assert.ok(summary.next.includes('excel_diag_read_file {path: "manifest.tsv"} reads the first 40 of its 61 lines.'), summary.next);
    assert.ok(search.next.startsWith(`excel_diag_read_file {path: "${STATUS}"} reads the first 40 of its 47 lines.`), search.next);
    const read = await ask(dir, 'read_file', { path: 'manifest.tsv' });
    assert.deepEqual([read.receipt.lines, read.receipt.shown], [61, { fromLine: 1, toLine: 40 }], 'which is what the call reads');
  });

  it('a record whose lines, as written, do not all fit in one result is offered as the lines that call lists', async () => {
    // 30 rows of 600 characters, and 30 day lines of 40 tag characters each, which read_file writes by their number
    const tags = Array.from({ length: 40 }, (_, k) => String.fromCodePoint(0xe0041 + (k % 26))).join('');
    const dir = await bundle(INCOMPLETE, async (root) => {
      await writeIncomplete(root);
      await put(root, 'manifest.tsv', `component\tstatus\tdetails${LF}${Array.from({ length: 29 }, (_, i) => `step${z2(i)}\tincomplete\t${'d'.repeat(600)}`).join(LF)}${LF}`);
      await put(root, STATUS, `Date | Status${LF}${Array.from({ length: 28 }, (_, i) => `2026-02-${z2(i + 1)} | ok (${i} entries)${tags}`).join(LF)}${LF}2026-04-03 | error 1${LF}`);
    });
    const [summary, search] = await Promise.all([ask(dir, 'summary'), ask(dir, 'search', { query: 'pivot', from: '2026-04-03 00:00', to: '2026-04-03 12:00' })]);
    const [manifest, status] = await Promise.all([ask(dir, 'read_file', { path: 'manifest.tsv' }), ask(dir, 'read_file', { path: STATUS })]);
    assert.ok(manifest.receipt.shown.toLine < 30 && status.receipt.shown.toLine < 30, 'neither file fits in one result');
    assert.ok(summary.next.includes(`excel_diag_read_file {path: "manifest.tsv"} reads the first ${manifest.receipt.shown.toLine} of its 30 lines, each to its first 400 characters.`), summary.next);
    assert.ok(search.next.startsWith(`excel_diag_read_file {path: "${STATUS}"} reads the first ${status.receipt.shown.toLine} of its 30 lines.`), search.next);
  });
});

describe('reports: what Next offers, and what a count of reports counts', () => {
  const FQ = 'reports/CrashReporter/Microsoft Excel_0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0.txt', OTHER = 'reports/Library_Logs_DiagnosticReports/OtherApp-2026-06-21-093000.crash';
  const forceQuits = () => bundle('Force_quits', async (root) => {
    await put(root, OTHER, `Process:  OtherApp [1]${LF}Date/Time:  2026-06-21 09:30:00.000 -0400${LF}`);
    await put(root, FQ, `{${LF}${[50, 51, 52, 53, 54, 55].map((m) => `  "ForceQuitDate" => 2026-06-21 09:${m}:00 -0400`).join(LF)}${LF}}${LF}`);
    await put(root, 'app.log', `2026-06-21T13:00:00Z error one${LF}`);
  });

  it('a force-quit record is offered as its file to read, not as a report to lay out', async () => {
    const d = await ask(forceQuits(), 'reports');
    assert.equal(d.next, `excel_diag_read_file {path: "${FQ}"} reads the file of the newest report, each line after its number. excel_diag_context {id: 7} lists what every source logged just before and after the newest report. If this answers the question, reply now.`);
    assert.equal((await ask(forceQuits(), 'read_file', { path: FQ })).receipt.lines, 8, 'which read_file reads');
  });

  it('a file that gives several reports is laid out as its newest, and says how many it gives', async () => {
    const d = await ask(forceQuits(), 'reports', { path: FQ });
    assert.deepEqual([d.receipt.id, d.receipt.time], [7, '2026-06-21 13:55:00'], 'the one the list names as the newest');
    assert.ok(d.notes.includes('This file gives 6 reports on the timeline, from 2026-06-21 13:50:00 to 2026-06-21 13:55:00: time and id are those of the newest.'), JSON.stringify(d.notes));
  });

  // Each record of a force-quit file that holds several says which of them it is: only the latest is called the latest
  it('each force-quit record says which of the file\'s times it is, and none but the latest is called the latest', async () => {
    const d = await ask(forceQuits(), 'search', { query: 'source:"crash and hang reports"', limit: 20 });
    const said = d.text.split(LF).filter((l) => l.includes('Force quit:')).map((l) => l.slice(l.indexOf(' - ') + 3));
    assert.deepEqual(said, [...Array(5).fill('one of the 6 force-quit times this file records'), 'the latest of the 6 force-quit times this file records'], d.text);
    assert.ok(!d.text.includes('last time'), d.text);
  });

  // The text command's own sentence about the list is true of every row: two rows from one force-quit file, and the
  // collector's capture of Excel, which no file of the Mac's is
  it('the text reports command says what each row is, true of a force-quit file of several and of the collector\'s capture', async () => {
    const dir = await incomplete(), r = await cli([path.join(dir, INCOMPLETE), 'reports']);
    assert.equal(r.stdout.split(LF)[1], 'Each is a report as its file records it, and KIND is taken from the file. A force-quit file can record more than one, and excel_sample.txt and excel_spindump.txt are read as the capture of Excel that the collector takes in hang mode.');
    assert.ok(r.stdout.includes('excel_sample.txt'), r.stdout);
    const f = await cli([path.join(await forceQuits(), 'Force_quits'), 'reports']);
    assert.equal(f.stdout.split(LF).filter((l) => /^\d{4}-/.test(l) && l.includes(FQ)).length, 6, f.stdout);
    assert.ok(!/one file that macOS or Excel wrote/.test(f.stdout + r.stdout));
  });

  // A process name longer than its column is cut with ~ at its end, as in every other listing, in the reports and
  // summary listings both: a cut name never reads as a whole one
  it('a process name cut in the reports and summary listings ends in ~', async () => {
    const dir = await bundle('Long_names', async (root) => {
      const head = (name) => `{"app_name":"${name}","timestamp":"2026-05-01 10:00:00.00 -0400","bug_type":"309"}\n{"procName":"${name}","exception":{"type":"EXC_CRASH"}}\n`;
      await put(root, 'reports/Library_Logs_DiagnosticReports/Helper-2026-05-01-100000.ips', head('Microsoft Excel Crash Reporter Helper (Plugin Host)'));
      await put(root, 'reports/Library_Logs_DiagnosticReports/Updater-2026-05-01-110000.ips', head(`Microsoft Excel${' '.repeat(16)}Updater Helper`));
      await put(root, 'app.log', `2026-05-01T14:00:00Z info x${LF}`);
    });
    const [reports, summary] = await Promise.all([ask(dir, 'reports'), ask(dir, 'summary')]);
    for (const text of [reports.text, summary.text]) {
      // the column is 30 characters wide: 29 of the name, then ~
      assert.ok(text.includes('  Microsoft Excel Crash Reporte~  reports/Library_Logs_DiagnosticReports/Helper-2026-05-01-100000.ips'), text);
      assert.ok(text.includes(`  Microsoft Excel${' '.repeat(14)}~  reports/Library_Logs_DiagnosticReports/Updater-2026-05-01-110000.ips`), text);
    }
  });

  // A report with one deeply nested value is read all the same: its kind, its process and its stack
  it('a crash report with a deeply nested value anywhere is listed as the crash it is, and laid out', async () => {
    const DEEP = 'reports/Library_Logs_DiagnosticReports/Deep-2026-05-01-103000.ips', deep = (n) => `${'['.repeat(n)}1${']'.repeat(n)}`;
    const dir = await bundle('Deep_values', async (root) => {
      await put(root, DEEP, `{"app_name":"Deep","timestamp":"2026-05-01 10:30:00.00 -0400","bug_type":"309"}\n{"procName":"Deep","exception":{"type":"EXC_BAD_ACCESS","subtype":${deep(100000)}},"largestProcess":${deep(50000)},"faultingThread":0,"threads":[{"triggered":true,"frames":[{"imageIndex":0,"symbol":"deepFrame"}]}],"usedImages":[{"name":"Deep"}]}\n`);
      await put(root, 'app.log', `2026-05-01T14:00:00Z info x${LF}`);
    });
    const [list, laid] = await Promise.all([ask(dir, 'reports'), send(dir, 'reports', { path: DEEP })]);
    assert.ok(/ Crash {2}Deep {2}/.test(list.text), list.text);
    assert.equal(laid.ok, true, JSON.stringify(laid).slice(0, 300));
    assert.ok(laid.text.includes('deepFrame') && laid.text.includes('EXC_BAD_ACCESS'), laid.text.slice(0, 600));
  });

  it('the summary counts reports, not report files', async () => {
    const d = await ask(forceQuits(), 'summary');
    assert.equal(d.text.split(LF)[0], 'The 5 newest of the 7 reports, newest first:');
    assert.ok(d.next.includes('excel_diag_reports {} lists the 7 reports with their times.'), d.next);
    assert.deepEqual(d.receipt.reports, { total: 7, byKind: { Crash: 1, 'Force quit': 6 } });
  });

  it('a report this account may not read is not offered to be laid out', async () => {
    const dir = await bundle('Locked', async (root) => { await put(root, OTHER, `Process: OtherApp [1]${LF}`); await put(root, 'a.log', `2026-06-21T13:00:00Z error x${LF}`); });
    const file = path.join(dir, 'Locked', ...OTHER.split('/'));
    await fs.chmod(file, 0o000);
    try {
      if (await fs.readFile(file).then(() => true, () => false)) return;      // an account that reads anything (root) has no such file
      const d = await ask(dir, 'reports');
      assert.ok(!d.next.includes('excel_diag_reports {path'), d.next);
      assert.ok(d.next.startsWith('excel_diag_context {id: 1} '), d.next);
    } finally { await fs.chmod(file, 0o644); }
  });

  it('a report whose values nest deeper than can be written is laid out without them, as the call offered says', async () => {
    const WEIRD = 'reports/Library_Logs_DiagnosticReports/Weird-2026-06-01-090000.ips';
    const dir = await bundle('Deep', async (root) => {
      await put(root, WEIRD, `{"app_name":"Weird","timestamp":"2026-06-01 09:00:00.00 -0400","bug_type":"309","name":"Weird"}${LF}{"procName":"Weird","exception":{"type":"EXC_BAD_ACCESS","codes":${'['.repeat(100000)}1${']'.repeat(100000)}},"threads":[]}${LF}`);
      await put(root, 'a.log', `2026-06-01T13:00:00Z error x${LF}`);
    });
    const list = await ask(dir, 'reports');
    assert.ok(list.next.startsWith(`excel_diag_reports {path: "${WEIRD}"} lays out the newest report`), list.next);
    const d = await ask(dir, 'reports', { path: WEIRD });
    assert.ok(d.text.split(LF).includes('Exception type: EXC_BAD_ACCESS'), d.text);
  });

  it('a path that matches many: the newest first, and the list call is said to list them all only when it does', async () => {
    const many = (n) => bundle('Many_crashes', async (root) => {
      for (let i = 0; i < n; i++) await put(root, `reports/Library_Logs_DiagnosticReports/Microsoft Excel_2026-06-01-09${z2(i)}00.crash`, `Process:  Microsoft Excel [4121]${LF}Date/Time:  2026-06-01 09:${z2(i)}:00.000 -0400${LF}`);
    });
    const [sixty, thirty] = await Promise.all([send(many(60), 'reports', { path: 'Excel' }), send(many(30), 'reports', { path: 'Excel' })]);
    assert.equal(sixty.hint, '"Excel" is part of 60 report paths. Send one of the candidates, whole, as path. The 20 newest are given; send more of the path to match fewer of them.');
    assert.equal(sixty.candidates[0], 'reports/Library_Logs_DiagnosticReports/Microsoft Excel_2026-06-01-095900.crash');
    assert.equal(thirty.hint, '"Excel" is part of 30 report paths. Send one of the candidates, whole, as path. The 20 newest are given; excel_diag_reports {} lists them all.');
    assert.equal((await ask(many(30), 'reports')).receipt.shown, 30, 'which it does');
  });

  it('a path with a space at either end is never offered, and one sent is read as sent', async () => {
    const NEW = ' x/Microsoft Excel-2026-06-22-093000.crash', OLD = 'x/Microsoft Excel-2026-06-22-093000.crash';
    const dir = await bundle('Spaces', async (root) => {
      await put(root, NEW, `Process:  Microsoft Excel [4121]${LF}Date/Time:  2026-06-22 09:30:00.000 -0400${LF}Exception Type:  EXC_NEW_ONE${LF}`);
      await put(root, OLD, `Process:  Microsoft Excel [4121]${LF}Date/Time:  2026-06-22 09:00:00.000 -0400${LF}Exception Type:  EXC_OLD_ONE${LF}`);
    });
    const [summary, list, laid, trailing] = await Promise.all([ask(dir, 'summary'), ask(dir, 'reports'), ask(dir, 'reports', { path: NEW }), ask(dir, 'read_file', { path: `${OLD} ` })]);
    for (const d of [summary, list]) assert.ok(!d.next.includes(`"${NEW}"`), d.next);
    assert.ok(laid.text.split(LF).includes('Exception Type: EXC_NEW_ONE'), laid.text);
    assert.ok(!laid.notes.some((n) => n.includes('was read as')), 'it was read as it was sent');
    assert.ok(trailing.notes.includes(`path "${OLD} " was read as "${OLD}".`), JSON.stringify(trailing.notes));
  });

  it('the PROCESS column is cut at a whole character, never through one written by its number, and a cut name ends in ~', async () => {
    const dir = await bundle('Long_process', async (root) => {
      await put(root, 'reports/Library_Logs_DiagnosticReports/Long-2026-03-10-100100.crash', `Process:               ABCDEFGHIJKLMNOPQRSTUVWXYZabc‮defghijkl [812]${LF}Date/Time:  2026-03-10 10:01:00.000 -0400${LF}`);
      await put(root, 'a.log', `2026-03-10T14:00:00Z info x${LF}`);
    });
    const [d, text] = await Promise.all([ask(dir, 'reports'), cli([path.join(dir, 'Long_process'), 'reports'])]);
    for (const line of [d.text.split(LF)[1], text.stdout.split(LF).find((l) => l.includes('Crash'))]) {
      assert.match(line, /Crash {2}ABCDEFGHIJKLMNOPQRSTUVWXYZabc~ {2}reports\//, line);
      assert.ok(!line.includes('‮'), 'and the character itself is not in it');
    }
  });

  it('a text report longer than is read gives its counts as of the part read', async () => {
    const lines = ['Date/Time:        2026-05-01 10:25:00.000 -0400', 'Command:          Microsoft Excel', 'Event:            hang', ''];
    for (let i = 0; i < 4000; i++) lines.push(`  Thread 0x${(0x1000 + i).toString(16)}    DispatchQueue "q"(1)    100 samples (1-100)`, `  100  frame${i} + 8 (Microsoft Excel + 100) [0x104a00000] ${'p'.repeat(200)}`, '');
    lines.push('Binary Images:', '  0x104a00000 - 0x10bffffff com.microsoft.Excel 16.114 /Applications/Microsoft Excel.app/Contents/MacOS/Microsoft Excel', '');
    const HANG = 'reports/Library_Logs_DiagnosticReports/Microsoft Excel_2026-05-01-102500.hang';
    const d = await ask(bundle('Long_hang', (root) => put(root, HANG, lines.join(LF))), 'reports', { path: HANG }), shown = d.text.split(LF);
    assert.ok(shown.some((l) => /^Threads in the part read: \d+$/.test(l)), d.text.slice(0, 600));
    assert.ok(!shown.some((l) => l.startsWith('Threads in the report') || l.startsWith('Images listed')), 'no count is said to be the whole report\'s');
  });
});

describe('a count lists as many values as one result holds, and says so', () => {
  it('the call offered lists as many as it says, and moreValues counts every one it does not list', async () => {
    // 40 messages of 150 letters each, no two of the same shape
    const word = (i) => Array.from({ length: 150 }, (_, k) => String.fromCharCode(97 + ((i * 11 + k * (i % 5 + 1)) % 26))).join('');
    const dir = await bundle('Long_messages', (root) => put(root, 'app.log', `${Array.from({ length: 40 }, (_, i) => `2026-06-01T10:${z2(i)}:00Z error ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))} ${word(i)}`).join(LF)}${LF}`));
    const d = await ask(dir, 'count', { by: 'message' }), offered = /excel_diag_count \{by: "message", limit: (\d+)\} lists the (\d+) shapes with the most entries\./.exec(d.next);
    assert.ok(offered && offered[1] === offered[2] && +offered[1] < 40, d.next);
    const more = await ask(dir, 'count', { by: 'message', limit: +offered[1] });
    assert.deepEqual([more.receipt.values.length, more.receipt.moreValues], [+offered[1], 40 - +offered[1]]);
    assert.ok(!more.notes.some((n) => n.startsWith('This result was larger')), JSON.stringify(more.notes));
    const all = await ask(dir, 'count', { by: 'message', limit: 40 });
    assert.deepEqual([all.receipt.values.length, all.receipt.moreValues], [+offered[1], 40 - +offered[1]], 'asked for more than it holds, it lists as many');
    assert.ok(all.notes.includes(`values gives the ${offered[1]} shapes with the most entries: one result holds no more of them, and moreValues counts the rest.`), JSON.stringify(all.notes));
  });
});

describe('a hint gives back a value only where the argument takes it', () => {
  const sample = () => sampleBundlesDir();
  it('a level name sent as minSeverity is said as the severity its entries count as, never the nearest spelling', async () => {
    const [min, level, by] = await Promise.all([send(sample(), 'search', { minSeverity: 'Default' }), send(sample(), 'search', { level: 'Default' }), send(sample(), 'count', { by: 'msg' })]);
    assert.ok(min.hint.endsWith('"Default" was sent. "Default" is a level in this bundle, and this tool counts entries at that level as notice: minSeverity "notice" keeps them and every severity above.'), min.hint);
    assert.equal(level.hint, 'Send minSeverity in place of level, as one of: debug, info, notice, warning, error, fault. This tool counts entries at a level named "Default" as notice: minSeverity "notice" keeps them and every severity above. This call did not run.');
    for (const d of [min, level]) assert.ok(!/fault\.|is fault/.test(d.hint.replace('debug, info, notice, warning, error, fault', '')), d.hint);
    assert.ok(by.hint.endsWith('The nearest to what was sent is message.'), by.hint);
    const [notice, message] = await Promise.all([ask(sample(), 'search', { minSeverity: 'notice' }), ask(sample(), 'count', { by: 'message' })]);
    assert.ok(notice.receipt.matched > 0 && message.receipt.values.length > 0);
  });

  // An entry id, a line number and a path are given back only as the open bundle has them, so that the call the hint
  // offers is not refused in its turn; past the last entry, the last line or any file, the hint says what one takes
  it('an id, a line or a path sent under a wrong name is given back only where the bundle has it, and the call offered is taken', async () => {
    const cases = [['search', { id: 99999 }, 'Send aroundId in place of id, as a whole number without quotation marks: an entry id, from 0 to 32860 in this bundle. This call did not run.'],
      ['search', { entry: '32861' }, 'Send aroundId in place of entry, as a whole number without quotation marks: an entry id, from 0 to 32860 in this bundle. This call did not run.'],
      ['context', { index: '40000' }, 'Send id in place of index, as a whole number without quotation marks: an entry id, from 0 to 32860 in this bundle. This call did not run.'],
      ['show', { entry: 1e21 }, 'Send id in place of entry, as a whole number without quotation marks: an entry id, from 0 to 32860 in this bundle. This call did not run.'],
      ['show', { entry: 32860 }, 'Send id in place of entry, with the value that was sent: {id: 32860}. This call did not run.'],
      ['reports', { filename: 'nope.ips' }, 'Send path in place of filename, as a path copied from the FILE column of excel_diag_reports. This call did not run.'],
      ['read_file', { file: 'nope.txt' }, 'Send path in place of file, as a path copied from the PATH column of excel_diag_files. This call did not run.']];
    for (const [op, params, hint] of cases) assert.equal((await send(sample(), op, params)).hint, hint, `${op} ${JSON.stringify(params)}`);
    assert.equal((await ask(sample(), 'show', { id: 32860 })).receipt.id, 32860, 'the call a hint gives back is taken');
    const dir = await bundle('One_line', (root) => put(root, 'notes/notes.txt', `only line${LF}`));
    const [past, within, both] = await Promise.all([send(dir, 'read_file', { path: 'notes/notes.txt', line: 999 }), send(dir, 'read_file', { path: 'notes/notes.txt', line: 1 }), send(dir, 'read_file', { file: 'notes.txt', line: 1 })]);
    assert.equal(past.hint, 'Send fromLine in place of line, as a whole number without quotation marks: a line number, from 1 to 1 in the file read. This call did not run.');
    assert.equal(within.hint, 'Send fromLine in place of line, with the value that was sent: {fromLine: 1}. This call did not run.');
    assert.equal(both.hint, 'Send path in place of file and fromLine in place of line, with the values that were sent: {path: "notes.txt", fromLine: 1}. This call did not run.');
    assert.equal((await ask(dir, 'read_file', { path: 'notes.txt', fromLine: 1 })).receipt.lines, 1, 'and the call it gives is taken');
  });

  // With a wrong name for bundle as well, the call offered would go to the bundle named, which is not open, so an id, a
  // line or a path is not given back: the hint says what one takes in any bundle, and the program answers, not fails
  it('an id, a line or a path under a wrong name, with a wrong name for bundle too, is refused with what it takes', async () => {
    const bundleBack = `Send bundle in place of %s, with the value that was sent: {bundle: "${SAMPLE_ID}"}.`;
    const cases = [['read_file', { file: 'nope.txt', bundle_id: SAMPLE_ID }, 'bundle_id', 'Send path in place of file, as a path copied from the PATH column of excel_diag_files.'],
      ['reports', { filename: 'nope.ips', bundleId: SAMPLE_ID }, 'bundleId', 'Send path in place of filename, as a path copied from the FILE column of excel_diag_reports.'],
      ['show', { entry: '5', bundleId: SAMPLE_ID }, 'bundleId', 'Send id in place of entry, as a whole number without quotation marks.'],
      ['context', { index: '5', name: SAMPLE_ID }, 'name', 'Send id in place of index, as a whole number without quotation marks.'],
      ['search', { id: '5', name: SAMPLE_ID }, 'name', 'Send aroundId in place of id, as a whole number without quotation marks.'],
      ['read_file', { path: 'manifest.tsv', line: '3', bundle_id: SAMPLE_ID }, 'bundle_id', 'Send fromLine in place of line, as a whole number without quotation marks.']];
    for (const [op, params, wrong, said] of cases) {
      const d = await send(sample(), op, params);
      assert.equal(d.ok, false, `${op} ${JSON.stringify(params)}`);
      assert.equal(d.hint, `${bundleBack.replace('%s', wrong)} ${said} This call did not run.`, `${op} ${JSON.stringify(params)}`);
    }
    assert.equal((await ask(sample(), 'show', { bundle: SAMPLE_ID, id: 5 })).receipt.id, 5, 'the call the hints describe is taken');
  });

  // A length of time is given back as the example only when the tool takes that length (at most 36500 days)
  it('a window example made from what was sent is one the tool takes', async () => {
    const at = { aroundTime: '2026-03-10 09:00' };
    const cases = [[{ ...at, window: 4000000000 }, 'Send window as a string in quotation marks, for example "30s". A number was sent.'],
      [{ ...at, window: 60 }, 'Send window as a string in quotation marks, for example "60s". A number was sent.'],
      [{ ...at, window: '999999999 days' }, 'Send window as a number and a unit in one string: "500ms", "30s", "2m", "1h" or "1d". "999999999 days" was sent.'],
      [{ ...at, window: '36500 days' }, 'Send window as a number and a unit in one string, for example "36500d". "36500 days" was sent.']];
    for (const [params, hint] of cases) assert.equal((await send(sample(), 'search', params)).hint, hint, JSON.stringify(params));
    for (const like of ['30s', '60s', '36500d']) assert.equal((await send(sample(), 'search', { ...at, window: like, limit: 1 })).ok, true, like);
    assert.equal((await send(sample(), 'context', { id: 0, window: 4000000000 })).hint, 'Send window as a string in quotation marks, for example "30s". A number was sent.');
  });

  // A window is kept within the times the tool reads, so that from and to in its receipt read back: a window around a
  // time near either end is cut there, and a fact says so
  it('a window that reaches past the times the tool reads is cut to them, and its ends read back', async () => {
    const [early, late, ctx] = await Promise.all([ask(sample(), 'search', { aroundTime: '1000-01-02 00:00:00Z', window: '36500d', limit: 1 }), ask(sample(), 'count', { aroundTime: '9999-12-30 23:59:59Z', window: '36500d' }),
      ask(sample(), 'context', { time: '1000-01-02 00:00:00Z', window: '36500d' })]);
    assert.deepEqual([early.receipt.from, early.receipt.to], ['1000-01-01 20:00:00', '1099-12-08 20:00:00']);
    assert.deepEqual([late.receipt.from, late.receipt.to], ['9900-01-23 19:59:59', '9999-12-30 19:59:59']);
    assert.ok(early.notes.includes('The time window reaches past the times this tool reads, 1000-01-02 00:00:00 to 9999-12-30 23:59:59 UTC, so it was cut to 1000-01-01 20:00:00 to 1099-12-08 20:00:00.'), JSON.stringify(early.notes));
    assert.ok(ctx.notes.includes('The bundle holds no entry in that window, from 1000-01-01 20:00:00 to 1099-12-08 20:00:00.'), JSON.stringify(ctx.notes));
    for (const d of [early, late]) {
      const back = await send(sample(), 'search', { from: d.receipt.from, to: d.receipt.to, limit: 1 });
      assert.equal(back.ok, true, `${d.receipt.from} to ${d.receipt.to}: ${back.hint}`);
    }
    for (const d of [early, late, ctx]) assert.ok(!/\b\d{3}-\d\d-\d\d |\b\d{5}-\d\d-\d\d /.test(JSON.stringify(d)), 'no time with a year of three or five digits');
  });

  // A time asked with milliseconds is said with them: the moment the log does not cover is the one asked
  it('a time asked with milliseconds is said with them in the anchor and coverage facts', async () => {
    const d = await ask(incomplete(), 'context', { time: '2026-04-02 03:00:00.500' });
    assert.ok(d.notes.some((n) => n.startsWith('The anchor is entry') && n.includes('2026-04-02 03:00:00.500')), JSON.stringify(d.notes));
    assert.ok(d.notes.some((n) => n.startsWith('The macOS log in this bundle does not cover 2026-04-02 03:00:00.500, the time asked.')), JSON.stringify(d.notes));
    assert.ok(!d.notes.some((n) => n.includes('does not cover 2026-04-02 03:00:00,')), 'never the second the log does cover');
    const covered = await ask(incomplete(), 'context', { time: '2026-04-02 03:00:00' });
    assert.ok(!covered.notes.some((n) => COVER.test(n)), JSON.stringify(covered.notes));
  });

  it('a value the argument would refuse is not given back, and the hint says what it takes', async () => {
    const cases = [['search', { count: -5, q: 'crash' }, 'Send query in place of q, with the value that was sent: {query: "crash"}. Send limit in place of count, as a whole number without quotation marks. This call did not run.'],
      ['read_file', { path: 'summary.md', lines: 0 }, 'Send limit in place of lines, as a whole number without quotation marks. This call did not run.'],
      ['read_file', { line: -3 }, 'Send fromLine in place of line, as a whole number without quotation marks. This call did not run.'],
      ['histogram', { buckets: 0 }, 'Send bins in place of buckets, as a whole number without quotation marks. This call did not run.'],
      ['show', { entry: -1 }, 'Send id in place of entry, as a whole number without quotation marks: an entry id, from 0 to 32860 in this bundle. This call did not run.'],
      ['search', { since: 'yesterday' }, 'Send from in place of since, as a time written the way results print times (YYYY-MM-DD HH:MM:SS). This call did not run.'],
      ['files', { name: 'summary.md' }, 'Send bundle in place of name, as a bundle id copied from availableBundles in excel_diag_summary results. This call did not run.'],
      ['count', { name: 'Microsoft Excel', by: 'process' }, 'Send bundle in place of name, as a bundle id copied from availableBundles in excel_diag_summary results. This call did not run.'],
      ['count', { field: 'proc' }, 'Send by in place of field, as one of: severity, level, source, tag, process, subsystem, category, file, message. This call did not run.'],
      ['count', { field: 'process' }, 'Send by in place of field, with the value that was sent: {by: "process"}. This call did not run.']];
    for (const [op, params, hint] of cases) assert.equal((await send(sample(), op, params)).hint, hint, `${op} ${JSON.stringify(params)}`);
    // one that does name a bundle is given back, and the call it gives is taken
    const named = await send(sample(), 'files', { name: 'sample' });
    assert.equal(named.hint, `Send bundle in place of name, with the value that was sent: {bundle: "sample"}. This call did not run.`);
    assert.equal((await ask(sample(), 'files', { bundle: 'sample' })).bundle, SAMPLE_ID);
  });

  it('a window longer than any date can be is refused, and no time is written as NaN', async () => {
    const d = await send(sample(), 'search', { aroundId: 5, window: '99999999999999999999d' });
    assert.deepEqual([d.ok, d.error, d.field], [false, 'window is too long', 'window']);
    assert.ok(!JSON.stringify(d).includes('NaN'));
    const longest = await ask(sample(), 'search', { aroundId: 5, window: '36500d', limit: 1 });
    assert.ok(!JSON.stringify(longest).includes('NaN'));
  });

  // A /regex/ is read by the tool's own reader, which reads each character once. Patterns that took JavaScript's own
  // reader longer than any call may take, on entries made to slow it down, are each answered, through the plugin with
  // a time limit (so that, were one of them to stall, this spec would fail and not hang), with what each matches.
  const slowBundle = () => bundle('Slow_lines', (root) => put(root, 'unified_logs/2026-06-03.tsv', [UNIFIED_HEAD, unified('2026-06-03', '09:00:00', 'Error', `pivot refresh ${'a'.repeat(60)} end`, 'Microsoft Excel'),
    ...Array.from({ length: 20 }, (_, i) => unified('2026-06-03', `09:01:${z2(i)}`, 'Default', `x${' '.repeat(20000)}y`))].join(LF) + LF));
  it('patterns that stall JavaScript\'s own reader are searched, and each is answered within the time a call may take', async () => {
    const p = await loadPlugin({ bundlesDir: await slowBundle(), pluginConfig: { timeoutSeconds: 15 } });
    for (const [query, matched] of [['/(a|aa)+z/', 0], ['/(a+){2,30}z/', 0], ['/(\\w+\\s?){1,30}$/', 21], ['/\\s+$/', 0], ['/[\\s\\S]*zq/', 0], ['/a*a*a*a*a*a*a*a*a*z/', 0], ['/(a|aa)+ end/', 1],
      [`/(a+){1,${'9'.repeat(45)}}z/`, 0]]) {
      const t = Date.now(), env = await p.raw.get('excel_diag_search')({ query, limit: 1 }), d = env.details, said = blocks(env).join(LF);
      assert.equal(d.ok, true, `${query}: ${JSON.stringify(d).slice(0, 300)}`);
      assert.equal(d.matched, matched, query);
      assert.ok(!/left out/.test(said), `${query} is searched: ${said.slice(0, 300)}`);
      assert.ok(Date.now() - t < 10000, `${query}: ${Date.now() - t} ms`);
    }
  });

  it('a wrong name\'s hint gives back such a pattern, and the call it offers is answered', async () => {
    const dir = await slowBundle(), wrong = await send(dir, 'search', { q: '/(a|aa)+z/' });
    assert.equal(wrong.hint, 'Send query in place of q, with the value that was sent: {query: "/(a|aa)+z/"}. This call did not run.');
    const p = await loadPlugin({ bundlesDir: dir, pluginConfig: { timeoutSeconds: 15 } }), env = await p.raw.get('excel_diag_search')({ query: '/(a|aa)+z/' }), d = env.details;
    assert.deepEqual([d.ok, d.matched], [true, 0], JSON.stringify(d).slice(0, 300));
    assert.ok(blocks(env).join(LF).includes('- Fact: No entry in this bundle contains /(a|aa)+z/.'), blocks(env).join(LF).slice(0, 400));
  });

  it('a pattern the reader does not read is left out of the search with a fact that names it, and the rest is searched', async () => {
    const dir = await slowBundle();
    const [look, back, big, fits] = await Promise.all([ask(dir, 'search', { query: '/a(?=b)/ pivot', limit: 1 }), ask(dir, 'search', { query: '/(a)\\1/ pivot', limit: 1 }),
      ask(dir, 'search', { query: '/a{2001}/ pivot', limit: 1 }), ask(dir, 'search', { query: '/a{2000}/', limit: 1 })]);
    assert.ok(look.notes.includes('/a(?=b)/ has a look-ahead or a look-behind, which this search does not read, so it was left out of the search. Write it without (?=, (?!, (?<= or (?<!, or search for its words in quotation marks.'), JSON.stringify(look.notes));
    assert.ok(back.notes.includes('/(a)\\1/ has a back-reference, which this search does not read, so it was left out of the search. Write it without \\1 or \\k<name>, or search for its words in quotation marks.'), JSON.stringify(back.notes));
    assert.ok(big.notes.includes('/a{2001}/ is longer than this search reads: it comes to more than 2000 steps as this search counts them, so it was left out of the search. A counted repeat such as x{2,30} counts as 30 copies of x, and each | and each copy that may be left out counts more. Write it shorter, or with smaller counts.'), JSON.stringify(big.notes));
    assert.deepEqual([look.receipt.matched, back.receipt.matched, big.receipt.matched], [1, 1, 1], 'the other term is searched for');
    assert.ok(!fits.notes.some((n) => /left out/.test(n)), 'a pattern of exactly 2000 steps is searched');
    const words = await send(sample(), 'search', { query: 'pivot '.repeat(101) });
    assert.deepEqual([words.error, words.hint], ['query has too many terms', 'Send query with at most 100 terms; 101 were sent. A term is a word, a phrase in quotation marks, a /regex/ or a field such as process:excel, with a minus before it or not.']);
  });

  it('the text command line answers the same patterns at once', async () => {
    const dir = await slowBundle();
    const r = await cli([path.join(dir, 'Slow_lines'), 'search', '/(a|aa)+ end/'], { timeoutMs: 15000 });
    assert.equal(r.code, 0, r.stderr.slice(0, 300));
    assert.ok(/pivot refresh a+ end/.test(r.stdout), r.stdout.slice(0, 300));
  });

  // A repeated part that can only match nothing, whatever its count, is read at once, as JavaScript reads it, and it
  // does not let a part past the limit after it be read. Each entry is matched as it is shown: read as UTF-8, and
  // without the carriage return at the end of a line of Excel's own log. A long pattern that is left out is said back
  // cut short, so its fact is read to its end. Through the plugin with a time limit, so a stall fails and does not hang.
  it('a /regex/ is answered at once, as JavaScript reads it on each entry as shown, and what is left out says why', async () => {
    const dir = await bundle('Wide_lines', async (root) => {
      await put(root, 'unified_logs/2026-06-03.tsv', [UNIFIED_HEAD, ...['café', 'CAFÉ', 'Ìsland', 'Ünder'].map((m, i) => unified('2026-06-03', `09:00:${z2(i)}`, 'Default', m, 'Microsoft Excel'))].join(LF) + LF);
      await put(root, 'office/excel_container_logs/Diagnostics/EXCEL/Primary1.log', ['Timestamp\tProcess\tTID\tArea\tCategory\tEventID\tLevel\tMessage\tCorrelation',
        '06/03/2026 13:01:00.500\tEXCEL (0x1019)\t0x1\tMicrosoft Excel\tXLS PivotTable\tabc12\tMedium\tPivotCache::Refresh\t'].join('\r\n') + '\r\n');
    });
    const p = await loadPlugin({ bundlesDir: dir, pluginConfig: { timeoutSeconds: 15 } });
    const search = async (query) => { const t = Date.now(), env = await p.raw.get('excel_diag_search')({ query, limit: 1 }), d = env.details; assert.equal(d.ok, true, `${query}: ${JSON.stringify(d).slice(0, 300)}`); return [d.matched, blocks(env).join(LF), Date.now() - t]; };
    for (const query of ['/(?:){2147483647}/', '/(?:x{0}){99999999999}/', '/(?:(?:){2147483647}){2147483646}/']) {
      const [matched, said, ms] = await search(query);
      assert.deepEqual([matched, /left out/.test(said), ms < 10000], [5, false, true], `${query}: ${ms} ms, ${said.slice(0, 300)}`);
    }
    const [hidden, hiddenSaid] = await search('/(?:(?:){2147483647}){0}(?:(?:a{1000}){1000}){2}/ pivot');
    assert.deepEqual([hidden, hiddenSaid.includes('{2}/ is longer than this search reads: it comes to more than 2000 steps as this search counts them, so it was left out of the search.')], [1, true], hiddenSaid.slice(0, 600));
    const found = [];
    for (const query of ['/caf.$/', 'Ü', '/^$/', '/^\\s*$/', '/\\r/']) found.push((await search(query))[0]);
    assert.deepEqual(found, [2, 1, 0, 0, 0], 'é and . read as JavaScript reads them on the entry, and the end of a line of Excel\'s log is not a blank line');
    const words = Array.from({ length: 501 }, (_, k) => `w${k}`).join('|'), [, longSaid] = await search(`/${words}/`);
    assert.ok(longSaid.includes(`- Fact: /${words.slice(0, 200)}\u2026/ is longer than this search reads: it comes to more than 2000 steps as this search counts them, so it was left out of the search. A counted repeat such as x{2,30} counts as 30 copies of x, and each | and each copy that may be left out counts more. Write it shorter.`), longSaid.slice(0, 900));
  });

  it('a count offers the search it narrows to only when that search\'s query has no more terms than a query may', async () => {
    // count adds one term, process:"Microsoft Excel", to the query it was sent
    const offered = (d) => [...(d.next || '').matchAll(/excel_diag_search \{query: ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
    const [fits, over] = await Promise.all([ask(sample(), 'count', { query: 'excel '.repeat(99).trim(), by: 'process' }), ask(sample(), 'count', { query: 'excel '.repeat(100).trim(), by: 'process' })]);
    assert.deepEqual(offered(fits), [`${'excel '.repeat(99)}process:"Microsoft Excel"`], fits.next);
    assert.equal((await send(sample(), 'search', { query: offered(fits)[0], limit: 1 })).ok, true, 'which the tool takes');
    assert.deepEqual(offered(over), [], over.next);
  });
});

describe('the memory timeline: what was read of it, and the numbers it holds', () => {
  it('a timeline longer than is read: the row it was cut in is not a sample, and the facts say they are of the part read', async () => {
    const dir = await bundle('Excel_Diagnostics_watch_20260605_000000', async (root) => {
      const rows = ['local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,excel_compressed_mb,excel_threads,pressure_level,free_mb,compressor_mb,swap_used_mb'], t0 = Date.UTC(2026, 4, 31, 20);
      for (let i = 0; i < 260000; i++) { const u = new Date(t0 + i * 1000), l = new Date(t0 + i * 1000 - 4 * 3600000); rows.push(`${l.toISOString().slice(0, 19).replace('T', ' ')},${u.toISOString().slice(0, 19).replace('T', ' ')},4121,10.5,2000,10,40,1,3509,500,0`); }
      await put(root, 'excel_memory_timeline.csv', rows.join(LF) + LF);
    });
    const d = await ask(dir, 'memory', { time: '2026-06-04 00:00' }), last = d.receipt.samplesListed.at(-1);
    // the rows wholly within the first 16 MB (the file is ASCII, a character to a byte), less the header
    const read = (await fs.readFile(path.join(await dir, 'Excel_Diagnostics_watch_20260605_000000', 'excel_memory_timeline.csv'), 'latin1')).slice(0, 16 << 20);
    assert.equal(d.receipt.timeline.samples, read.slice(0, read.lastIndexOf(LF)).split(LF).length - 1, 'the row the read ends in is not counted as a sample');
    assert.equal(d.notes[0], 'Only the first 16.0 MB of the memory timeline was read, so its samples, figures and pressure levels here are of that part.');
    assert.ok(d.notes.some((n) => /^The samples read of the memory timeline run from 2026-05-31 20:00:00 to \S+ \S+, so time is at or after the last of them, and the last 3 samples are listed\.$/.test(n)), JSON.stringify(d.notes));
    assert.deepEqual([last.freeMb, last.compressorMb, last.swapUsedMb], [3509, 500, 0], 'the last sample listed is a whole row');
    assert.equal(d.receipt.timeline.freeMb.lowest.value, 3509);
    assert.equal(d.receipt.truncated, true);
  });

  it('only decimal numbers are figures: Infinity, 1e999 and 12abc are not', async () => {
    const dir = await bundle('Odd_cells', (root) => put(root, 'excel_memory_timeline.csv', ['local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,pressure_level',
      '2026-06-01 08:00:00,2026-06-01 12:00:00,4121,Infinity,100,1', '2026-06-01 08:01:00,2026-06-01 12:01:00,4121,5,1e999,1', '2026-06-01 08:02:00,2026-06-01 12:02:00,4121,7,12abc,1',
      '2026-06-01 08:03:00,2026-06-01 12:03:00,4121,7,300,1'].join(LF) + LF));
    const t = (await ask(dir, 'memory')).receipt.timeline;
    assert.deepEqual(t.excelFootprintMb, { lowest: { value: 100, at: '2026-06-01 12:00:00' }, highest: { value: 300, at: '2026-06-01 12:03:00' }, last: 300 });
    assert.deepEqual(t.excelCpuPct, { lowest: { value: 5, at: '2026-06-01 12:01:00' }, highest: { value: 7, at: '2026-06-01 12:02:00' }, last: 7 });
  });

  it('the text command says a pressure level it does not know as unknown, and its unseen characters by number', async () => {
    const tagged = [...'Next'].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0))).join('');
    const dir = await bundle('Odd_levels', (root) => put(root, 'excel_memory_timeline.csv', ['local_time,utc_time,excel_pid,excel_footprint_mb,pressure_level',
      '2026-06-01 08:00:00,2026-06-01 12:00:00,4121,100,toString', `2026-06-01 08:01:00,2026-06-01 12:01:00,4121,100,${tagged}`, '2026-06-01 08:02:00,2026-06-01 12:02:00,4121,100,1'].join(LF) + LF));
    const r = await cli([path.join(dir, 'Odd_levels'), 'memory']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('  pressure_level values seen: toString (unknown), <U+E004E><U+E0065><U+E0078><U+E0074> (unknown), 1 (normal)'), r.stdout);
    assert.ok(!/[\u{E0000}-\u{E0FFF}]/u.test(r.stdout) && !r.stdout.includes('function'), 'nothing unseen, and no engine source');
  });
});

describe('calls offered for a span: the whole period, and the clock they are read on', () => {
  // the Mac went from UTC-04:00 to UTC-05:00 between 1 and 3 June; 20 errors after the change, and an old line from
  // another log, so that the bundle has a main period
  const twoZones = () => bundle('Excel_Diagnostics_repro_20260603_100000', async (root) => {
    const row = (local, off, utc, level, msg) => [`${local}.000000${off}`, `${utc}.000000`, level, 'Microsoft Excel', '4121', 'AppKit', '', '', 'excel', msg].join('\t');
    await put(root, 'unified_logs/2026-06-01.tsv', [UNIFIED_HEAD, row('2026-06-01 09:00:00', '-0400', '2026-06-01 13:00:00', 'Default', 'first'), row('2026-06-01 10:00:00', '-0400', '2026-06-01 14:00:00', 'Default', 'second'),
      ...Array.from({ length: 20 }, (_, i) => row(`2026-06-03 09:${z2(i)}:10`, '-0500', `2026-06-03 14:${z2(i)}:10`, 'Error', `err ${i}`))].join(LF) + LF);
    await put(root, 'old/setup.log', `2026-01-01T00:00:00Z info installed the update${LF}`);
  });

  it('the summary\'s search of its busiest interval finds the errors it counts there', async () => {
    const dir = await twoZones(), s = await ask(dir, 'summary'), call = /excel_diag_search \{minSeverity: "error", from: "([^"]+)", to: "([^"]+)"\}/.exec(s.next);
    assert.ok(call && /-0[45]:00$/.test(call[1]) && /-0[45]:00$/.test(call[2]), s.next);
    const d = await ask(dir, 'search', { minSeverity: 'error', from: call[1], to: call[2] });
    assert.equal(d.receipt.matched, s.receipt.intervalWithMostErrors.errorsAndFaults);
    const h = await ask(dir, 'histogram', { minSeverity: 'error' }), fullest = /excel_diag_search \{from: "([^"]+)", to: "([^"]+)"/.exec(h.next);
    assert.equal((await ask(dir, 'search', { minSeverity: 'error', from: fullest[1], to: fullest[2] })).receipt.matched, h.receipt.fullest.entries);
  });

  it('a histogram sent a span that matches nothing offers the whole period without it, which matches what it says', async () => {
    const dir = await twoZones(), d = await ask(dir, 'histogram', { query: 'installed', from: '2026-06-01 00:00:00' });
    const offered = /^excel_diag_histogram \{query: "installed", from: "([^"]+)"\} is this call without the time window, which 1 entry matches\./.exec(d.next);
    assert.ok(offered, d.next);
    assert.equal((await ask(dir, 'histogram', { query: 'installed', from: offered[1] })).receipt.matched, 1);
  });

  it('a context by time says the time asked as it was read', async () => {
    const d = await ask(twoZones(), 'context', { time: '2026-06-03 09:05:10' });
    assert.equal(d.notes[0], 'The anchor is entry 3, the first entry at or after 2026-06-03 09:05:10-04:00, 55 min after the time asked.');
  });

  it('memory at a time after the change offers the memory entries around that time, on its clock', async () => {
    // five entries tagged memory either side of 09:10 on the later clock, and samples over the same minutes
    const dir = await bundle('Excel_Diagnostics_repro_20260603_100000', async (root) => {
      const row = (local, off, utc, msg) => [`${local}.000000${off}`, `${utc}.000000`, 'Default', 'kernel', '0', 'kernel', '', '', 'memory', msg].join('\t');
      await put(root, 'unified_logs/2026-06-01.tsv', [UNIFIED_HEAD, row('2026-06-01 09:00:00', '-0400', '2026-06-01 13:00:00', 'before'),
        ...[8, 9, 10, 11, 12].map((m) => row(`2026-06-03 09:${z2(m)}:00`, '-0500', `2026-06-03 14:${z2(m)}:00`, `memorystatus ${m}`))].join(LF) + LF);
      await put(root, 'excel_memory_timeline.csv', ['local_time,utc_time,excel_pid,free_mb,pressure_level', ...Array.from({ length: 20 }, (_, i) => `2026-06-03 09:${z2(i)}:00,2026-06-03 14:${z2(i)}:00,4121,${4000 - i},1`)].join(LF) + LF);
    });
    const m = await ask(dir, 'memory', { time: '2026-06-03 09:10:00-05:00' });
    const offered = /excel_diag_search \{query: "tag:memory", aroundTime: "([^"]+)", window: "5m"\} lists the entries with a tag that contains memory within 5 minutes either side of that time/.exec(m.next);
    assert.ok(offered && offered[1] === '2026-06-03 09:10:00-05:00', m.next);
    assert.equal((await ask(dir, 'search', { query: 'tag:memory', aroundTime: offered[1], window: '5m' })).receipt.matched, 5);
  });
});

describe('files and context: a call offered for more lists more', () => {
  it('files {} is said to list a page at a time when the files are more than one page', async () => {
    const reports = await bundle(REPORTS_BUNDLE, writeReports);
    const none = await ask(reports, 'files', { filter: 'zzzz' });
    assert.equal(none.next, 'excel_diag_files {} lists the 75 files in this bundle, a page at a time: send nextOffset as offset for the next page. If this answers the question, reply now.');
    const texts = await bundle('Thirty_texts', async (root) => { for (let i = 0; i < 30; i++) await put(root, `notes/n${z2(i)}.txt`, `note ${i}${LF}`); });
    assert.ok((await ask(texts, 'summary')).next.startsWith('excel_diag_files {} lists the 30 files in this bundle, a page at a time: send nextOffset as offset for the next page.'));
    assert.equal((await ask(texts, 'files')).receipt.truncated, true, 'which it does');
  });

  it('context offers more either side only when the bundle has more either side', async () => {
    const dir = await incomplete();
    const [all, some] = await Promise.all([ask(dir, 'context', { id: 11, before: 16, after: 16 }), ask(dir, 'context', { id: 11 })]);
    assert.deepEqual([all.receipt.shown.firstId, all.receipt.shown.lastId], [0, 14], 'every entry is listed');
    assert.ok(!all.next.includes('shows more either side'), all.next);
    assert.ok(some.next.includes('excel_diag_context {id: 11, before: 16, after: 16} shows more either side.'), some.next);
  });
});

describe('the plugin: an ignored name is cut at a whole character', () => {
  it('a name cut where a character past U+FFFF falls keeps the result well formed', async () => {
    const p = await loadPlugin(), env = await p.raw.get('excel_diag_files')({ [`${'a'.repeat(39)}\u{1F600}`]: 1 });
    const facts = blocks(env)[0];
    assert.ok(facts.includes(`${'a'.repeat(39)}… is not a field of excel_diag_files`), facts.slice(0, 200));
    assert.ok(facts.isWellFormed() && env.details.ignoredFields.every((k) => k.isWellFormed()));
  });

  it('cleanup', async () => { await cleanup(); });
});
