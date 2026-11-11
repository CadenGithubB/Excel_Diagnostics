// Request mode: every limit, on the sample bundle and on a bundle built to be too big for one result.
//
// A small model cannot notice that something was left out unless it is told, and it treats a number it is shown
// as a target. So each limit is pinned two ways: a request for more than the most is lowered and a note says so,
// and whatever was cut sets truncated with the exact way to get the rest (nextOffset, nextFromLine, a larger
// maxChars). A cut that is not announced becomes a wrong answer about what the logs hold.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, assert, request, sampleBundlesDir, emptyDir, cleanup } from '../harness.mjs';

let cacheDir = null, wideDir = null;
async function ask(op, params = {}, bundlesDir) {
  bundlesDir ??= await sampleBundlesDir();
  cacheDir ??= await emptyDir('cache');
  const r = await request({ format: 1, op, bundlesDir, cacheDir, params });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', `standard output is not a JSON document: ${r.stdout.slice(0, 200)}`);
  assert.equal(r.stdout, `${JSON.stringify(r.json)}\n`);
  for (const dir of [bundlesDir, cacheDir, os.tmpdir(), os.homedir()]) assert.ok(!r.stdout.includes(dir), `a path of this machine is in the output: ${dir}`);
  return r.json;
}
const z2 = (n) => String(n).padStart(2, '0');
const lowered = (name, sent, used) => `${name} ${sent} is more than this tool returns in one call; ${used} was used.`;
const TEXT_MOST = 24000;

// A bundle with more of everything than one result holds: 300 entries of 5,027 characters each, one entry of
// 100,012 characters, a 300-line file, a file of 907-character lines, a file of 33 MB, 90 small files, 45 more log
// sources and 85 report files, 14 of them Jetsam reports. Every time in it is written with its zone, so nothing depends on the
// zone of the machine the tests run on. On the timeline app.log's entries come first (ids 0 to 299), then the 90
// from logs/, then giant.log's two (390 and 391), then the reports.
const WIDE = 'Wide_Bundle';
async function wide() {
  wideDir ??= (async () => {
    const dir = await emptyDir('wide'), root = path.join(dir, WIDE);
    const put = async (rel, text) => { const dest = path.join(root, ...rel.split('/')); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, text); };
    await put('app.log', Array.from({ length: 300 }, (_, i) => `2026-02-02T10:${z2(Math.floor(i / 60))}:${z2(i % 60)}Z error something ${i} happened ${'y'.repeat(5000)}\n`).join(''));
    await put('giant.log', `2026-02-02T12:00:00Z fault giant ${'z'.repeat(100000)}\n2026-02-02T12:00:01Z info after the giant\n`);
    await put('short.txt', Array.from({ length: 300 }, (_, i) => `row ${i + 1}\n`).join(''));
    await put('long.txt', Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${'x'.repeat(900)}\n`).join(''));
    await put('big.txt', `${'b'.repeat(1023)}\n`.repeat(33000));
    for (let i = 1; i <= 90; i++) await put(`many/f${String(i).padStart(3, '0')}.txt`, 'x\n');
    for (let i = 1; i <= 45; i++) await put(`logs/s${z2(i)}.log`, `2026-02-02T11:00:${z2(i)}Z info source ${i} first\n2026-02-02T11:01:${z2(i)}Z info source ${i} second\n`);
    for (let i = 0; i < 85; i++) {
      const jetsam = i >= 71, stamp = `2026-02-02 13:${z2(Math.floor(i / 60))}:${z2(i % 60)}`;
      await put(`reports/${jetsam ? 'JetsamEvent' : 'Crash'}-2026-02-02-13${z2(Math.floor(i / 60))}${z2(i % 60)}.ips`, `{"app_name":"App ${i}","timestamp":"${stamp}.00 +0000","bug_type":"${jetsam ? 298 : 309}"}\n{}\n`);
    }
    return dir;
  })();
  return wideDir;
}
const askWide = async (op, params) => ask(op, params, await wide());

describe('request mode: a number over the most is lowered, and a note says so', () => {
  it('search: 20 entries unless asked, never more than 80', async () => {
    const [usual, most] = await Promise.all([ask('search', {}), ask('search', { limit: 500 })]);
    assert.deepEqual(usual.receipt.shown, { first: 1, last: 20 });
    assert.equal(usual.receipt.nextOffset, 20);
    assert.deepEqual(usual.notes, []);
    assert.deepEqual(most.receipt.shown, { first: 1, last: 80 });
    assert.equal(most.receipt.truncated, true);
    assert.equal(most.receipt.nextOffset, 80);
    assert.deepEqual(most.notes, [lowered('limit', 500, 80)]);
    assert.equal(most.text.split('\n').length, 81);
    assert.ok(most.next.includes('offset: 80'), most.next);
  });

  it('search and context: 200 characters of a message unless asked, never more than 2000', async () => {
    const [usual, most, around] = await Promise.all([askWide('search', { limit: 1 }), askWide('search', { limit: 1, maxChars: 99999 }), askWide('context', { id: 5, before: 0, after: 0, maxChars: 99999 })]);
    assert.ok(usual.text.endsWith(`${'y'.repeat(173)}…[4827 more characters]`), usual.text.slice(-80));
    assert.deepEqual(most.notes.slice(0, 1), [lowered('maxChars', 99999, 2000)]);
    assert.ok(most.text.endsWith(`${'y'.repeat(1973)}…[3027 more characters]`), most.text.slice(-80));
    assert.ok(around.notes.includes(lowered('maxChars', 99999, 2000)));
    assert.ok(around.text.endsWith('…[3027 more characters]'));
  });

  it('an entry longer than a listing reads is still counted to its end', async () => {
    const d = await askWide('search', { query: 'giant' });
    assert.equal(d.receipt.matched, 2);
    assert.ok(d.text.split('\n')[1].endsWith(`${'z'.repeat(188)}…[99812 more characters]`), d.text.split('\n')[1].slice(-60));
  });

  it('context: 8 entries either side unless asked, never more than 40', async () => {
    const [usual, most] = await Promise.all([ask('context', { id: 1000 }), ask('context', { id: 1000, before: 100, after: 41 })]);
    assert.deepEqual(usual.receipt.shown, { firstId: 992, lastId: 1008 });
    assert.equal(usual.receipt.entries, 17);
    assert.deepEqual(most.receipt.shown, { firstId: 960, lastId: 1040 });
    assert.equal(most.receipt.entries, 81);
    assert.deepEqual(most.notes, [lowered('before', 100, 40), lowered('after', 41, 40)]);
    assert.ok(!most.next.includes('excel_diag_context'), 'there is no wider look to offer once both sides are at the most');
  });

  it('context with window: everything in it, or the 80 nearest when there are more', async () => {
    const [all, cut] = await Promise.all([ask('context', { id: 139, window: '2s' }), ask('context', { time: '2026-03-10 10:35:00', window: '1m', before: 3 })]);
    assert.equal(all.receipt.entries, all.receipt.entriesInWindow);
    assert.equal(all.receipt.truncated, false);
    assert.ok(all.receipt.entries > 3 && all.receipt.entries <= 80);
    assert.equal(cut.receipt.entriesInWindow, 2221);
    assert.equal(cut.receipt.entries, 80);
    assert.equal(cut.receipt.truncated, true);
    assert.equal(cut.receipt.shown.lastId - cut.receipt.shown.firstId, 79);
    assert.ok(cut.receipt.shown.firstId <= cut.receipt.anchorId && cut.receipt.anchorId <= cut.receipt.shown.lastId);
    assert.equal(cut.notes[0], 'before and after are not used when window is given.');
    assert.match(cut.notes[1], /^2221 entries were logged within 60 s either side, and the 80 nearest to the anchor are listed\./);
    assert.equal(cut.text.split('\n').filter((l) => l.trimStart().startsWith('>')).length, 1);
  });

  it('show: 4000 characters of the message unless asked, never more than 20000', async () => {
    const [usual, more, giant, long] = await Promise.all([askWide('show', { id: 7 }), askWide('show', { id: 7, maxChars: 99999 }), askWide('show', { id: 390, maxChars: 20000 }), askWide('show', { id: 390 })]);
    assert.equal(usual.receipt.messageChars, 5027);
    assert.equal(usual.receipt.truncated, true);
    assert.ok(usual.text.endsWith('…[1027 more characters]'));
    assert.equal(usual.text.length, 4000 + '…[1027 more characters]'.length);
    assert.ok(usual.next.startsWith('excel_diag_show {id: 7, maxChars: 5027} gives the whole message.'), 'the size offered is this message\'s own length, not the most a call takes: ' + usual.next);
    assert.ok(long.next.startsWith('excel_diag_show {id: 390, maxChars: 20000} gives more of the message.'), long.next);
    assert.deepEqual(more.notes.slice(0, 1), [lowered('maxChars', 99999, 20000)]);
    assert.equal(more.receipt.truncated, false);
    assert.equal(more.text.length, 5027);
    assert.equal(giant.receipt.messageChars, 100012);
    assert.equal(giant.receipt.truncated, true);
    assert.ok(giant.text.endsWith('…[80012 more characters]'));
    assert.ok(giant.notes.includes('This message has 100012 characters. The first 20000 are shown, and one call returns no more than that.'), JSON.stringify(giant.notes));
    assert.ok(!giant.next.includes('maxChars'), 'a larger maxChars is not offered when it would change nothing');
  });

  it('count: 20 values unless asked, never more than 60', async () => {
    const [three, most, unused] = await Promise.all([ask('count', { by: 'process', limit: 3 }), ask('count', { by: 'process', limit: 100 }), ask('count', { limit: 5 })]);
    assert.equal(three.receipt.values.length, 3);
    assert.equal(three.receipt.moreValues, 11);
    assert.equal(three.receipt.truncated, true);
    assert.ok(three.next.includes('excel_diag_count {by: "process", limit: 14} lists all 14 process values.'), 'the size offered is how many values there are: ' + three.next);
    assert.deepEqual(most.notes, [lowered('limit', 100, 60)]);
    assert.equal(most.receipt.values.length, 14);
    assert.equal(most.receipt.moreValues, 0);
    assert.equal(most.receipt.truncated, undefined);
    assert.deepEqual(unused.notes, ['limit is used only when by is given, so it changed nothing here.']);
  });

  it('histogram: 24 intervals unless asked, never more than 60', async () => {
    const [usual, most, few] = await Promise.all([ask('histogram', {}), ask('histogram', { bins: 500 }), ask('histogram', { from: '2026-03-10 10:35:00', to: '2026-03-10 10:35:10', bins: 60 })]);
    assert.equal(usual.receipt.intervals, 24);
    assert.equal(usual.receipt.intervalLength, '7 min 30 s');
    assert.deepEqual(usual.notes, []);
    assert.equal(most.receipt.intervals, 60);
    assert.equal(most.receipt.intervalLength, '3 min');
    assert.deepEqual(most.notes, [lowered('bins', 500, 60)]);
    assert.equal(few.receipt.intervals, 10);
    assert.equal(few.receipt.intervalLength, '1 s');
    assert.deepEqual(few.notes, ['10 intervals cover this span, fewer than the bins asked for: each interval is a whole number of seconds long.']);
  });

  it('files: 60 paths unless asked, never more than 80, and nextOffset reaches the rest', async () => {
    const [usual, most] = await Promise.all([askWide('files', {}), askWide('files', { limit: 500, filter: 'many/' })]);
    assert.equal(usual.receipt.files, 225);
    assert.deepEqual(usual.receipt.shown, { first: 1, last: 60 });
    assert.equal(usual.receipt.truncated, true);
    assert.equal(usual.receipt.nextOffset, 60);
    assert.equal(usual.text.split('\n').length, 61);
    assert.ok(usual.next.includes('excel_diag_files {offset: 60} lists the files after these.'), usual.next);
    assert.deepEqual(most.notes.slice(0, 1), [lowered('limit', 500, 80)]);
    assert.deepEqual(most.receipt.shown, { first: 1, last: 80 });
    assert.equal(most.receipt.files, 90);
    assert.equal(most.receipt.nextOffset, 80);
    const rest = await askWide('files', { limit: 500, filter: 'many/', offset: most.receipt.nextOffset });
    assert.deepEqual(rest.receipt.shown, { first: 81, last: 90 });
    assert.equal(rest.receipt.truncated, false);
    assert.equal(rest.receipt.nextOffset, undefined);
    assert.match(rest.text.split('\n')[1], /many\/f081\.txt$/);
  });

  it('read_file: 80 lines, never more, and nextFromLine reaches the rest', async () => {
    const [usual, most, grep] = await Promise.all([askWide('read_file', { path: 'short.txt' }), askWide('read_file', { path: 'short.txt', limit: 500, fromLine: 250 }), askWide('read_file', { path: 'short.txt', grep: 'row 1' })]);
    assert.equal(usual.receipt.lines, 300);
    assert.deepEqual(usual.receipt.shown, { fromLine: 1, toLine: 80 });
    assert.equal(usual.receipt.truncated, true);
    assert.equal(usual.receipt.nextFromLine, 81);
    assert.equal(usual.text.split('\n').length, 80);
    assert.deepEqual(most.notes.slice(0, 1), [lowered('limit', 500, 80)]);
    assert.deepEqual(most.receipt.shown, { fromLine: 250, toLine: 300 });
    assert.equal(most.receipt.truncated, false);
    assert.equal(grep.receipt.matchedLines, 111);
    assert.equal(grep.text.split('\n').length, 80);
    assert.equal(grep.text.split('\n')[0], '1: row 1');
    assert.equal(grep.receipt.truncated, true);
    const toLine = grep.receipt.shown.toLine;
    assert.equal(grep.receipt.nextFromLine, toLine + 1);
    assert.equal(toLine, 168);
    assert.ok(grep.next.includes('excel_diag_read_file {path: "short.txt", fromLine: 169, grep: "row 1"} lists the matching lines after these.'), grep.next);
    const rest = await askWide('read_file', { path: 'short.txt', grep: 'row 1', fromLine: toLine + 1 });
    assert.equal(rest.text.split('\n').length, 31);
    assert.equal(rest.receipt.truncated, false);
  });

  it('read_file: a line over 400 characters is cut and says by how much', async () => {
    const d = await askWide('read_file', { path: 'long.txt', limit: 2 });
    const lines = d.text.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].endsWith(`${'x'.repeat(393)}…[507 more characters]`), lines[0].slice(-60));
    assert.equal(lines[0].length, 400 + '…[507 more characters]'.length);
  });

  it('read_file: only the first 32 MB of a file is read, and a note says so', async () => {
    const d = await askWide('read_file', { path: 'big.txt', fromLine: 32768, limit: 5 });
    assert.equal(d.receipt.bytes, 33000 * 1024);
    assert.equal(d.receipt.lines, 32768, 'the lines of the first 32 MB');
    assert.deepEqual(d.receipt.shown, { fromLine: 32768, toLine: 32768 });
    assert.equal(d.receipt.truncated, false);
    assert.deepEqual(d.notes, ['Only the first 32.0 MB of this file was read. lines counts that part, and nothing after it can be read here.']);
    assert.ok(d.text.endsWith('\u2026[623 more characters]'));
  });

  it('reports: the 80 newest, with the way to the others', async () => {
    const d = await askWide('reports');
    assert.equal(d.receipt.reports, 85);
    assert.deepEqual(d.receipt.byKind, { Crash: 71, Jetsam: 14 });
    assert.equal(d.receipt.shown, 80);
    assert.equal(d.receipt.truncated, true);
    const lines = d.text.split('\n');
    assert.equal(lines.length, 81);
    assert.match(lines[1], /^2026-02-02 13:00:05  Crash /, 'the five oldest are the ones left out');
    assert.match(lines[80], /^2026-02-02 13:01:24  Jetsam /);
    assert.equal(d.notes.length, 2);
    assert.equal(d.notes[0], 'This bundle holds 85 report files and the 80 newest are listed. Each report is also a timeline entry: excel_diag_search {query: "source:\\"crash and hang reports\\""} lists them all, oldest first.');
    assert.ok(d.next.includes('JetsamEvent-2026-02-02-130124.ips'), 'next is about the newest report');
    const every = await askWide('search', { query: 'source:"crash and hang reports"', limit: 1 });
    assert.equal(every.receipt.matched, 85, 'the search the note gives does list them all');
  });

  it('summary: 40 log sources listed, with the way to the others', async () => {
    const d = await askWide('summary');
    assert.equal(d.receipt.entries, 300 + 2 + 90 + 85);
    assert.equal(d.receipt.truncated, true);
    assert.equal(d.receipt.timeZone, 'UTC');
    assert.deepEqual(d.receipt.availableBundles, [WIDE]);
    assert.equal(d.text.split('\n').filter((l) => !l.startsWith('Note: ')).length, 41);
    assert.ok(d.notes.includes('48 log sources are on the timeline and 40 of them are listed. excel_diag_count {by: "file"} lists the sources with the most entries.'), JSON.stringify(d.notes));
    assert.ok(d.notes.includes("These logs do not record the Mac's time zone, so times are shown and read as UTC."), 'UTC for want of a zone is said');
  });

  it('memory: a dozen files of each kind, and the count of the others', async () => {
    const d = await askWide('memory');
    assert.equal(d.receipt.files.length, 12);
    assert.ok(d.receipt.files.every((f) => f.kind === 'jetsamReport'));
    assert.equal(d.receipt.filesNotListed, 2);
    assert.equal(d.receipt.truncated, true);
    assert.equal(d.notes.length, 1);
    assert.equal(d.notes[0], '2 more memory files are in this bundle than files lists. excel_diag_files {filter: "reports/"} lists them.');
    assert.equal(d.receipt.timeline, undefined);
  });
});

describe('request mode: a result is cut at whole lines to 24,000 characters, and says where it stopped', () => {
  it('search: fewer entries than asked for, with nextOffset after the last one shown', async () => {
    const d = await askWide('search', { limit: 80, maxChars: 2000 });
    assert.ok(d.text.length <= TEXT_MOST, `text is ${d.text.length} characters`);
    const shown = d.text.split('\n').length - 1;
    assert.ok(shown >= 5 && shown < 80);
    assert.deepEqual(d.receipt.shown, { first: 1, last: shown });
    assert.equal(d.receipt.truncated, true);
    assert.equal(d.receipt.nextOffset, shown);
    assert.ok(d.notes.includes(`These entries are long: ${shown} of the 80 asked for fit in one result. nextOffset continues after them.`), JSON.stringify(d.notes));
    assert.ok(d.next.includes(`excel_diag_search {limit: 80, maxChars: 2000, offset: ${shown}} lists the matches after these ${shown}.`), d.next);
    const after = await askWide('search', { limit: 80, maxChars: 2000, offset: shown });
    assert.equal(after.receipt.shown.first, shown + 1);
    assert.match(after.text.split('\n')[1], new RegExp(`^\\s*${shown}  2026-02-02 `), 'the next page starts at the entry after the last one shown');
  });

  it('context: the entry it is about is kept, and lines go from the far ends', async () => {
    const [middle, end] = await Promise.all([askWide('context', { id: 150, before: 40, after: 40, maxChars: 2000 }), askWide('context', { id: 299, before: 40, after: 0, maxChars: 2000 })]);
    for (const [d, anchor] of [[middle, 150], [end, 299]]) {
      assert.ok(d.text.length <= TEXT_MOST, `text is ${d.text.length} characters`);
      assert.equal(d.receipt.truncated, true);
      assert.equal(d.receipt.anchorId, anchor);
      assert.equal(d.text.split('\n').length - 1, d.receipt.entries);
      assert.equal(d.receipt.shown.lastId - d.receipt.shown.firstId + 1, d.receipt.entries);
      assert.ok(d.text.split('\n').some((l) => l.startsWith(`>${anchor}  `)), 'the anchor line is there');
      assert.ok(d.notes.some((n) => /^These entries are long: \d+ of the \d+ around the anchor fit in one result\. A smaller maxChars fits more of them\.$/.test(n)), JSON.stringify(d.notes));
    }
    assert.ok(middle.receipt.shown.firstId < 150 && middle.receipt.shown.lastId > 150, 'both sides of the anchor are kept');
    assert.equal(end.receipt.shown.lastId, 299);
  });

  it('read_file: fewer lines than asked for, with nextFromLine after the last one shown', async () => {
    const d = await askWide('read_file', { path: 'long.txt' });
    assert.ok(d.text.length <= TEXT_MOST, `text is ${d.text.length} characters`);
    const shown = d.text.split('\n').length;
    assert.ok(shown > 40 && shown < 80);
    assert.deepEqual(d.receipt.shown, { fromLine: 1, toLine: shown });
    assert.equal(d.receipt.truncated, true);
    assert.equal(d.receipt.nextFromLine, shown + 1);
    assert.deepEqual(d.notes, [`These lines are long: ${shown} of the 80 asked for fit in one result. nextFromLine continues after them.`]);
    const after = await askWide('read_file', { path: 'long.txt', fromLine: d.receipt.nextFromLine, limit: 1 });
    assert.ok(after.text.startsWith(`line ${shown + 1} `));
  });

  it('cleanup', async () => { await cleanup(); });
});
