// Request mode on bundles that are not like the sample: two time zones, more than one day, old entries from
// other sources, files that are not text, and a bundle with no log in it at all.
//
// These are the cases where a result has to be read differently, and a small model reads every result the same
// way unless a sentence in it says otherwise. So each one is pinned to the sentence it gets: which clock the times
// are on, why a time alone was refused, why a file cannot be read, and that a bundle with no timeline is to be
// read file by file. The engine words some of these for the web page ("switch Times in to UTC"); what reaches
// the model has to name an argument it can send, not a control it cannot click.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, assert, request, emptyDir, cleanup } from '../harness.mjs';

let cacheDir = null, oddDir = null;
async function ask(op, params = {}) {
  const bundlesDir = await odd();
  cacheDir ??= await emptyDir('cache');
  const r = await request({ format: 1, op, bundlesDir, cacheDir, params });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', `standard output is not a JSON document: ${r.stdout.slice(0, 200)}`);
  assert.equal(r.stdout, `${JSON.stringify(r.json)}\n`);
  for (const dir of [bundlesDir, cacheDir, os.tmpdir(), os.homedir()]) assert.ok(!r.stdout.includes(dir), `a path of this machine is in the output: ${dir}`);
  return r.json;
}
const TWO_ZONES = 'Excel_Diagnostics_repro_20260603_100000', NO_LOGS = 'Just_some_files';
// TWO_ZONES: a macOS log whose Mac went from UTC-04:00 to UTC-05:00 between 1 and 3 June, one much older line from
// another log, and three files that are not text. NO_LOGS: two files, neither a log. It is the older bundle.
function odd() {
  oddDir ??= (async () => {
    const dir = await emptyDir('bundles');
    const put = async (id, rel, data) => { const dest = path.join(dir, id, ...rel.split('/')); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, data); };
    const row = (local, utc, level, message) => `${local}\t${utc}\t${level}\tMicrosoft Excel\t4121\tAppKit\tcom.apple.AppKit\tWindow\texcel\t${message}`;
    await put(TWO_ZONES, 'unified_logs/2026-06-01.tsv', `${['local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage',
      row('2026-06-01 09:00:00.000000-0400', '2026-06-01 13:00:00.000000', 'Default', 'opened the workbook'),
      row('2026-06-01 09:00:05.250000-0400', '2026-06-01 13:00:05.250000', 'Error', 'could not save the workbook'),
      row('2026-06-03 09:00:00.000000-0500', '2026-06-03 14:00:00.000000', 'Default', 'opened the workbook again'),
      row('2026-06-03 09:30:00.000000-0500', '2026-06-03 14:30:00.000000', 'Fault', 'stopped responding')].join('\n')}\n`);
    await put(TWO_ZONES, 'old/setup.log', '2026-01-01T00:00:00Z info installed the update\n');
    await put(TWO_ZONES, 'sync/SyncEngine.odl', new Uint8Array([69, 66, 70, 71, 0, 1, 2, 3, 0, 0]));
    await put(TWO_ZONES, 'blob.bin', new Uint8Array([1, 0, 2, 0, 3, 0]));
    await put(TWO_ZONES, 'empty.txt', '');
    await put(NO_LOGS, 'notes.txt', 'first line\nsecond line\n');
    await put(NO_LOGS, 'data.csv', 'a,b\n1,2\n');
    await fs.utimes(path.join(dir, NO_LOGS), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await fs.utimes(path.join(dir, TWO_ZONES), new Date('2026-06-03T15:00:00Z'), new Date('2026-06-03T15:00:00Z'));
    return dir;
  })();
  return oddDir;
}

describe('request mode: a bundle whose clock changed, and that covers more than its main logs', () => {
  it('summary names both zones, gives the main period, and words the engine notes as things to send', async () => {
    const d = await ask('summary');
    const r = d.receipt;
    assert.equal(d.bundle, TWO_ZONES);
    assert.equal(r.collectorMode, 'repro');
    assert.equal(r.timeZone, 'UTC-04:00 and UTC-05:00');
    assert.equal(r.entries, 5);
    assert.deepEqual(r.period, { from: '2025-12-31 20:00:00', to: '2026-06-03 09:30:00' });
    assert.deepEqual(r.mainPeriod, { from: '2026-06-01 08:59:00', to: '2026-06-03 09:31:00' });
    assert.deepEqual(r.availableBundles, [TWO_ZONES, NO_LOGS]);
    const notes = d.text.split('\n').filter((l) => l.startsWith('Note: '));
    assert.equal(notes.length, 3);
    assert.equal(notes[0], 'Note: The macOS and Excel logs cover 2026-06-01 08:59:00 to 2026-06-03 09:31:00 (mainPeriod). Entries outside that come from other sources, such as install history, sleep and wake records and reports.');
    assert.equal(notes[1], "Note: The Mac's clock changed UTC offset during this period (UTC-04:00, UTC-05:00). Local times can appear to jump backwards or forwards at those moments; send utc: true for a steady clock.", 'the offsets are given; no reason for the change is offered');
    assert.equal(notes[2], "Note: 1 OneDrive .odl/.odlgz/.odlsent/.aodl files are in Microsoft's obfuscated binary format; excel_diag_files lists them, but they cannot be read or searched.");
    assert.ok(!/Times in|under Files|this page|browser/.test(d.text), 'nothing that only makes sense in the web page');
    assert.deepEqual(d.notes, []);
  });

  it('each entry is shown on the clock the Mac was on at that moment', async () => {
    const d = await ask('search', { query: 'workbook' });
    assert.equal(d.receipt.matched, 3);
    assert.equal(d.receipt.timeZone, 'UTC-04:00 and UTC-05:00');
    const lines = d.text.split('\n');
    assert.match(lines[1], /^\s*1  2026-06-01 09:00:00\.000  /);
    assert.match(lines[2], /^\s*2  2026-06-01 09:00:05\.250  Error /);
    assert.match(lines[3], /^\s*3  2026-06-03 09:00:00\.000  /);
    const utc = await ask('show', { id: 3, utc: true });
    assert.equal(utc.receipt.time, '2026-06-03 14:00:00');
    assert.equal(utc.receipt.timeZone, 'UTC');
  });

  it('a time with no date is refused when the bundle covers more than one day', async () => {
    const [search, context] = await Promise.all([ask('search', { from: '09:00' }), ask('context', { time: '09:00:05' })]);
    assert.deepEqual(search, { ok: false, bundle: TWO_ZONES, error: 'from has no date', field: 'from', hint: 'This bundle covers more than one day (2025-12-31 20:00:00 to 2026-06-03 09:30:00), so from needs a date. Write it like "2026-06-03 09:30:00".' });
    assert.equal(context.error, 'time has no date');
    assert.equal(context.field, 'time');
  });

  it('a file that is not text is refused as a binary file, and an empty one is said to be empty', async () => {
    const [bin, odl, empty] = await Promise.all([ask('read_file', { path: 'blob.bin' }), ask('read_file', { path: 'SyncEngine.odl' }), ask('read_file', { path: 'empty.txt' })]);
    assert.deepEqual(bin, { ok: false, bundle: TWO_ZONES, error: 'binary file', field: 'path', hint: 'blob.bin is not text, so it cannot be read here. Choose another file from excel_diag_files.' });
    assert.equal(odl.error, 'binary file');
    assert.equal(odl.hint, "sync/SyncEngine.odl: This is a OneDrive sync log in Microsoft's obfuscated binary format. It cannot be printed as text or searched. Choose another file from excel_diag_files.");
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.receipt, { path: 'empty.txt', bytes: 0, lines: 0, truncated: false });
    assert.deepEqual(empty.notes, ['This file is empty.']);
    assert.equal(empty.text, undefined);
    assert.equal(empty.next, undefined);
  });
});

describe('request mode: a file this account may not read', () => {
  it('is refused by its path in the bundle, as an answer and not as a failure of the program', async () => {
    const file = path.join(await odd(), TWO_ZONES, 'locked.dat');
    await fs.writeFile(file, 'kept from the reader\n');
    await fs.chmod(file, 0o000);
    try {
      const readable = await fs.readFile(file).then(() => true, () => false);
      if (readable) return;      // an account that can read anything (root) has no such file to meet
      const d = await ask('read_file', { path: 'locked.dat' });
      assert.deepEqual(d, { ok: false, bundle: TWO_ZONES, error: 'the file cannot be read', field: 'path', hint: 'locked.dat could not be opened on the OpenClaw host (EACCES). Tell the human, or choose another file from excel_diag_files.' });
      const others = await ask('read_file', { path: 'old/setup.log' });
      assert.equal(others.ok, true, 'the rest of the bundle is still readable');
    } finally { await fs.chmod(file, 0o644); await fs.rm(file); }
  });
});

describe('request mode: a bundle with no log in it', () => {
  const p = { bundle: NO_LOGS };
  const FILES = `excel_diag_files {bundle: "${NO_LOGS}"}`;

  it('searching, counting and the histogram find nothing and say why', async () => {
    for (const d of await Promise.all([ask('search', { ...p, query: 'pivot', aroundId: 5 }), ask('count', { ...p, by: 'process' }), ask('histogram', { ...p, from: '2026-01-01' })])) {
      assert.equal(d.ok, true);
      assert.equal(d.receipt.matched, 0);
      assert.equal(d.receipt.total, 0);
      assert.equal(d.receipt.withoutEach, undefined);
      assert.deepEqual(d.notes, ['This bundle has no timeline entries: no file in it is a log with timestamps this tool recognises.']);
      assert.equal(d.next, `${FILES} lists the files in this bundle. If this answers the question, reply now.`);
    }
  });

  it('show and context are refused, and the refusal names the tools that do work', async () => {
    for (const d of await Promise.all([ask('show', { ...p, id: 0 }), ask('context', { ...p, time: '2026-01-01 00:00:00' }), ask('show', p)])) {
      assert.deepEqual(d, { ok: false, bundle: NO_LOGS, error: 'this bundle has no timeline entries',
        hint: `No file in bundle ${NO_LOGS} is a log with timestamps this tool recognises, so there are no entries to show. ${FILES} lists its files and excel_diag_read_file reads one.` });
    }
  });

  it('reports and memory are empty, files and read_file work', async () => {
    const [reports, memory, files, text] = await Promise.all([ask('reports', p), ask('memory', p), ask('files', p), ask('read_file', { ...p, path: 'notes.txt' })]);
    assert.deepEqual(reports.receipt, { reports: 0, byKind: {}, shown: 0, truncated: false });
    assert.deepEqual(reports.notes, ['This bundle holds no crash, hang, spin, jetsam or other diagnostic report files.']);
    assert.equal(reports.next, undefined, 'with no timeline there is nothing to suggest in their place');
    assert.deepEqual(memory.receipt, { files: [], memoryEntries: 0 });
    assert.deepEqual(memory.notes, ['This bundle holds no memory files and no log entries tagged memory.']);
    assert.equal(files.receipt.files, 2);
    assert.match(files.text, /^\s*8 B\s+-\s+data\.csv$/m);
    assert.equal(text.text, 'first line\nsecond line');
    assert.deepEqual(text.receipt, { path: 'notes.txt', bytes: 23, lines: 2, shown: { fromLine: 1, toLine: 2 }, truncated: false });
  });

  it('cleanup', async () => { await cleanup(); });
});
