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
const TEXT_MOST = 10000;

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
  it('search: 20 entries unless asked, never more than 40', async () => {
    const [usual, most] = await Promise.all([ask('search', {}), ask('search', { limit: 500 })]);
    assert.deepEqual(usual.receipt.shown, { first: 1, last: 20 });
    assert.equal(usual.receipt.nextOffset, 20);
    assert.deepEqual(usual.notes, []);
    assert.deepEqual(most.receipt.shown, { first: 1, last: 40 });
    assert.equal(most.receipt.truncated, true);
    assert.equal(most.receipt.nextOffset, 40);
    assert.deepEqual(most.notes, [lowered('limit', 500, 40)]);
    assert.equal(most.text.split('\n').length, 41);
    assert.ok(most.next.includes('offset: 40'), most.next);
  });

  it('search and context: 200 characters of a message unless asked, never more than 500', async () => {
    const [usual, most, around] = await Promise.all([askWide('search', { limit: 1 }), askWide('search', { limit: 1, maxChars: 99999 }), askWide('context', { id: 5, before: 0, after: 0, maxChars: 99999 })]);
    assert.ok(usual.text.endsWith(`${'y'.repeat(173)}…[4827 more characters]`), usual.text.slice(-80));
    assert.deepEqual(most.notes.slice(0, 1), [lowered('maxChars', 99999, 500)]);
    assert.ok(most.text.endsWith(`${'y'.repeat(473)}…[4527 more characters]`), most.text.slice(-80));
    assert.ok(around.notes.includes(lowered('maxChars', 99999, 500)));
    assert.ok(around.text.endsWith('…[4527 more characters]'));
  });

  it('an entry longer than a listing reads is still counted to its end', async () => {
    const d = await askWide('search', { query: 'giant' });
    assert.equal(d.receipt.matched, 2);
    assert.ok(d.text.split('\n')[1].endsWith(`${'z'.repeat(188)}…[99812 more characters]`), d.text.split('\n')[1].slice(-60));
  });

  it('context: 8 entries either side unless asked, never more than 20', async () => {
    const [usual, most] = await Promise.all([ask('context', { id: 1000 }), ask('context', { id: 1000, before: 100, after: 41 })]);
    assert.deepEqual(usual.receipt.shown, { firstId: 992, lastId: 1008, from: '2026-03-10 09:06:02.703', to: '2026-03-10 09:06:08.107' });
    assert.equal(usual.receipt.entries, 17);
    assert.deepEqual([most.receipt.shown.firstId, most.receipt.shown.lastId], [980, 1020]);
    assert.equal(most.receipt.entries, 41);
    assert.deepEqual(most.notes, [lowered('before', 100, 20), lowered('after', 41, 20)]);
    assert.ok(!most.next.includes('excel_diag_context'), 'there is no wider look to offer once both sides are at the most');
  });

  it('context with window: everything in it, or the 30 nearest when there are more, with the times they span', async () => {
    const [all, cut, byId] = await Promise.all([ask('context', { id: 139, window: '2s' }), ask('context', { time: '2026-03-10 10:35:00', window: '1m', before: 3 }), ask('context', { id: 19089, window: '1m' })]);
    assert.equal(all.receipt.entries, all.receipt.entriesInWindow);
    assert.equal(all.receipt.truncated, false);
    assert.ok(all.receipt.entries > 3 && all.receipt.entries <= 30);
    assert.equal(cut.receipt.entriesInWindow, 2221);
    assert.equal(cut.receipt.entries, 30);
    assert.equal(cut.receipt.truncated, true);
    assert.equal(cut.receipt.shown.lastId - cut.receipt.shown.firstId, 29);
    assert.ok(cut.receipt.shown.firstId <= cut.receipt.anchorId && cut.receipt.anchorId <= cut.receipt.shown.lastId);
    // the times of the first and last entry listed, as listed: a minute either side, and the list spans half a minute of it
    const lines = cut.text.split('\n');
    assert.deepEqual([cut.receipt.shown.from, cut.receipt.shown.to], [lines[1].slice(8, 31), lines[lines.length - 1].slice(8, 31)]);
    assert.equal(cut.notes[0], 'before and after are not used when window is given.');
    assert.equal(cut.notes[1], `2221 entries were logged within 60 s either side, and the 30 nearest to the anchor are listed, logged from ${cut.receipt.shown.from} to ${cut.receipt.shown.to}. A shorter window holds fewer entries, and lists them all once they fit.`);
    assert.equal(lines.filter((l) => l.trimStart().startsWith('>')).length, 1);
    // about a quarter of what one result holds, where 80 lines came to more than half of it
    assert.ok(cut.text.length > 4000 && cut.text.length < 8000, `${cut.text.length} characters`);
    // the call offered first groups every entry of the same window by the shape of its message, centred where this
    // one was; the one after narrows that window by severity
    assert.ok(cut.next.startsWith('excel_diag_count {aroundTime: "2026-03-10 10:35:00", window: "1m", by: "message"} groups all 2221 entries in this window by the shape of their message. ' +
      'excel_diag_search {aroundTime: "2026-03-10 10:35:00", window: "1m", minSeverity: "warning"} lists only the warnings, errors and faults in this window.'), cut.next);
    assert.ok(byId.next.startsWith('excel_diag_count {aroundId: 19089, window: "1m", by: "message"}'), byId.next);
    assert.ok(byId.next.includes('excel_diag_search {aroundId: 19089, window: "1m", minSeverity: "warning"}'), byId.next);
    assert.ok(!all.next.includes('minSeverity') && !all.next.includes('by: "message"'), 'a window listed whole is not narrowed or grouped');
    // the count offered is of the same entries, all of them
    const [grouped, groupedById] = await Promise.all([ask('count', { aroundTime: '2026-03-10 10:35:00', window: '1m', by: 'message' }), ask('count', { aroundId: 19089, window: '1m', by: 'message' })]);
    assert.equal(grouped.receipt.matched, cut.receipt.entriesInWindow);
    assert.equal(groupedById.receipt.matched, byId.receipt.entriesInWindow);
    assert.equal(grouped.receipt.values.reduce((n, v) => n + v.entries, 0) <= grouped.receipt.matched, true);
  });

  it('show: 4000 characters of the message unless asked, never more than 8000', async () => {
    const [usual, more, giant, long] = await Promise.all([askWide('show', { id: 7 }), askWide('show', { id: 7, maxChars: 99999 }), askWide('show', { id: 390, maxChars: 8000 }), askWide('show', { id: 390 })]);
    assert.equal(usual.receipt.messageChars, 5027);
    assert.equal(usual.receipt.truncated, true);
    assert.ok(usual.text.endsWith('…[1027 more characters]'));
    assert.equal(usual.text.length, '  '.length + 4000 + '…[1027 more characters]'.length, 'a message of one line, after two spaces');
    assert.ok(usual.next.startsWith('excel_diag_show {id: 7, maxChars: 5027} gives the whole message.'), 'the size offered is this message\'s own length, not the most a call takes: ' + usual.next);
    assert.ok(long.next.startsWith('excel_diag_show {id: 390, maxChars: 8000} gives more of the message.'), long.next);
    assert.deepEqual(more.notes.slice(0, 1), [lowered('maxChars', 99999, 8000)]);
    assert.equal(more.receipt.truncated, false);
    assert.equal(more.text.length, '  '.length + 5027);
    assert.equal(giant.receipt.messageChars, 100012);
    assert.equal(giant.receipt.truncated, true);
    assert.ok(giant.text.endsWith('…[92012 more characters]'));
    assert.ok(giant.notes.includes('This message has 100012 characters. The first 8000 are shown, and one call returns no more than that.'), JSON.stringify(giant.notes));
    assert.ok(!giant.next.includes('maxChars'), 'a larger maxChars is not offered when it would change nothing');
  });

  it('count: 20 values unless asked, never more than 40', async () => {
    const [three, most, unused] = await Promise.all([ask('count', { by: 'process', limit: 3 }), ask('count', { by: 'process', limit: 100 }), ask('count', { limit: 5 })]);
    assert.equal(three.receipt.values.length, 3);
    assert.equal(three.receipt.moreValues, 11);
    assert.equal(three.receipt.truncated, true);
    assert.ok(three.next.includes('excel_diag_count {by: "process", limit: 14} lists all 14 process values.'), 'the size offered is how many values there are: ' + three.next);
    assert.deepEqual(most.notes, [lowered('limit', 100, 40)]);
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

  it('files: 25 paths unless asked, never more than 40, and nextOffset reaches the rest', async () => {
    const [usual, most] = await Promise.all([askWide('files', {}), askWide('files', { limit: 500, filter: 'many/' })]);
    assert.equal(usual.receipt.files, 225);
    assert.deepEqual(usual.receipt.shown, { first: 1, last: 25 });
    assert.equal(usual.receipt.truncated, true);
    assert.equal(usual.receipt.nextOffset, 25);
    assert.equal(usual.text.split('\n').length, 26);
    assert.ok(usual.next.includes('excel_diag_files {offset: 25} lists the files after these.'), usual.next);
    // more files than one call lists: a fact says how many paths each of the collector's folder words keeps, of those this bundle has
    assert.deepEqual(usual.notes, ['This bundle has 225 files, more than this call lists. filter keeps only the paths that contain it: "reports" keeps 85.']);
    assert.ok(!most.notes.some((n) => n.startsWith('This bundle has')), 'not when a filter was sent');
    assert.deepEqual(most.notes.slice(0, 1), [lowered('limit', 500, 40)]);
    assert.deepEqual(most.receipt.shown, { first: 1, last: 40 });
    assert.equal(most.receipt.files, 90);
    assert.equal(most.receipt.nextOffset, 40);
    const rest = await askWide('files', { limit: 500, filter: 'many/', offset: 80 });
    assert.deepEqual(rest.receipt.shown, { first: 81, last: 90 });
    assert.equal(rest.receipt.truncated, false);
    assert.equal(rest.receipt.nextOffset, undefined);
    assert.match(rest.text.split('\n')[1], /many\/f081\.txt$/);
  });

  it('read_file: 40 lines, never more, and nextFromLine reaches the rest', async () => {
    const [usual, most, grep] = await Promise.all([askWide('read_file', { path: 'short.txt' }), askWide('read_file', { path: 'short.txt', limit: 500, fromLine: 250 }), askWide('read_file', { path: 'short.txt', grep: 'row 1' })]);
    assert.equal(usual.receipt.lines, 300);
    assert.deepEqual(usual.receipt.shown, { fromLine: 1, toLine: 40 });
    assert.equal(usual.receipt.truncated, true);
    assert.equal(usual.receipt.nextFromLine, 41);
    assert.equal(usual.text.split('\n').length, 41, 'the lead line and 40 lines');
    assert.equal(usual.text.split('\n')[0], 'Lines 1 to 40 of the file, each after its line number:');
    assert.deepEqual(most.notes.slice(0, 1), [lowered('limit', 500, 40)]);
    assert.deepEqual(most.receipt.shown, { fromLine: 250, toLine: 289 });
    assert.equal(most.receipt.truncated, true);
    assert.equal(grep.receipt.matchedLines, 111);
    assert.equal(grep.text.split('\n').length, 41);
    assert.deepEqual(grep.text.split('\n').slice(0, 2), ['40 lines that contain grep, each after its line number:', '1: row 1']);
    assert.equal(grep.receipt.truncated, true);
    const toLine = grep.receipt.shown.toLine;
    assert.equal(grep.receipt.nextFromLine, toLine + 1);
    assert.equal(toLine, 128);
    assert.ok(grep.next.includes('excel_diag_read_file {path: "short.txt", fromLine: 129, grep: "row 1"} lists the matching lines after these.'), grep.next);
    const rest = await askWide('read_file', { path: 'short.txt', grep: 'row 1', fromLine: 169 });
    assert.equal(rest.text.split('\n').length, 32);
    assert.equal(rest.text.split('\n')[0], '31 lines from line 169 on that contain grep, each after its line number:');
    assert.equal(rest.receipt.truncated, false);
  });

  it('read_file: a line over 400 characters is cut and says by how much', async () => {
    const d = await askWide('read_file', { path: 'long.txt', limit: 2 });
    const lines = d.text.split('\n');
    assert.equal(lines.length, 3, 'the lead line and two lines');
    assert.ok(lines[1].endsWith(`${'x'.repeat(393)}…[507 more characters]`), lines[1].slice(-60));
    assert.equal(lines[1].length, '1: '.length + 400 + '…[507 more characters]'.length);
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

  it('reports: the 40 newest, with the way to the others', async () => {
    const d = await askWide('reports');
    assert.equal(d.receipt.reports, 85);
    assert.deepEqual(d.receipt.byKind, { Crash: 71, Jetsam: 14 });
    assert.equal(d.receipt.shown, 40);
    assert.equal(d.receipt.truncated, true);
    const lines = d.text.split('\n');
    assert.equal(lines.length, 41);
    assert.match(lines[1], /^\d+  2026-02-02 13:00:45  Crash /, 'the 45 oldest are the ones left out');
    assert.match(lines[40], /^\d+  2026-02-02 13:01:24  Jetsam /);
    assert.equal(d.notes.length, 2);
    assert.equal(d.notes[0], 'This bundle holds 85 reports and the 40 newest are listed. Each report is also a timeline entry: excel_diag_search {query: "source:\\"crash and hang reports\\""} lists them all, oldest first, a page at a time: send nextOffset as offset for the next page.');
    assert.ok(d.next.includes('JetsamEvent-2026-02-02-130124.ips'), 'next is about the newest report');
    const every = await askWide('search', { query: 'source:"crash and hang reports"', limit: 1 });
    assert.equal(every.receipt.matched, 85, 'the search the note gives does list them all');
    // as it is sent, that search lists one page, which does not hold them all: so the note says it lists a page at a time
    const first = await askWide('search', { query: 'source:"crash and hang reports"' });
    assert.ok(first.receipt.shown.last < 85 && first.receipt.nextOffset === first.receipt.shown.last, JSON.stringify(first.receipt));
  });

  it('summary: the five newest report files, how many log sources there are, and the call that lists them', async () => {
    const d = await askWide('summary');
    assert.equal(d.receipt.entries, 300 + 2 + 90 + 85);
    assert.equal(d.receipt.truncated, undefined, 'the summary lists no log source, so it cuts no list of them');
    assert.equal(d.receipt.timeZone, 'UTC');
    assert.deepEqual(d.receipt.availableBundles, [{ id: WIDE }]);
    assert.equal(d.receipt.logSources, 48);
    // count by file lists 20 values unless sent a limit, and 40 at most, so the call offered sends that and says which they are
    assert.ok(d.notes.includes('48 log sources are on the timeline: excel_diag_count {by: "file", limit: 40} lists the 40 that gave the most entries, with the entries each gave.'), JSON.stringify(d.notes));
    assert.ok(d.notes.includes("These logs do not record the Mac's time zone, so times are shown and read as UTC."), 'UTC for want of a zone is said');
    const lines = d.text.split('\n');
    assert.equal(lines[0], 'The 5 newest of the 85 reports, newest first:', 'the cut is said where the list is');
    assert.equal(lines.length, 7, 'that sentence, the line naming the columns and five reports');
    assert.match(lines[2], /^\d+  2026-02-02 13:01:24  Jetsam /);
    // the reports call lists the 80 newest, and the sentence that offers it says so
    assert.ok(d.next.includes('excel_diag_reports {} lists the 40 newest of the 85 reports with their times'), d.next);
    assert.equal((await askWide('reports')).receipt.shown, 40);
    // the call the fact offers lists the 40 that gave the most
    const files = await askWide('count', { by: 'file', limit: 40 });
    assert.equal(files.receipt.values.length, 40);
    assert.equal(files.receipt.moreValues, 8);
  });

  it('memory: a dozen files of each kind, and the count of the others', async () => {
    const d = await askWide('memory');
    assert.equal(d.receipt.files.length, 12);
    assert.ok(d.receipt.files.every((f) => f.kind === 'jetsamReport'));
    assert.equal(d.receipt.filesNotListed, 2);
    assert.equal(d.receipt.truncated, true);
    assert.equal(d.notes.length, 1);
    // of the filters that every file left out matches, the one that matches fewest: "reports/" holds 71 crash reports too
    assert.equal(d.notes[0], '2 more memory files of kind jetsamReport are in this bundle than files lists. excel_diag_files {filter: "JetsamEvent"} lists them among others.');
    assert.equal(d.receipt.timeline, undefined);
  });
});

describe('request mode: a result is cut at whole lines to 10,000 characters, and says where it stopped', () => {
  it('search: fewer entries than asked for, with nextOffset after the last one shown', async () => {
    const d = await askWide('search', { limit: 40, maxChars: 500 });
    assert.ok(d.text.length <= TEXT_MOST, `text is ${d.text.length} characters`);
    const shown = d.text.split('\n').length - 1;
    assert.ok(shown >= 5 && shown < 40);
    assert.deepEqual(d.receipt.shown, { first: 1, last: shown });
    assert.equal(d.receipt.truncated, true);
    assert.equal(d.receipt.nextOffset, shown);
    assert.ok(d.notes.includes(`These entries are long: ${shown} of the 40 asked for fit in one result. nextOffset continues after them.`), JSON.stringify(d.notes));
    assert.ok(d.next.includes(`excel_diag_search {limit: 40, maxChars: 500, offset: ${shown}} lists the matches after these ${shown}.`), d.next);
    const after = await askWide('search', { limit: 40, maxChars: 500, offset: shown });
    assert.equal(after.receipt.shown.first, shown + 1);
    assert.match(after.text.split('\n')[1], new RegExp(`^\\s*${shown}  2026-02-02 `), 'the next page starts at the entry after the last one shown');
  });

  it('context: the entry it is about is kept, and lines go from the far ends', async () => {
    const [middle, end] = await Promise.all([askWide('context', { id: 150, before: 20, after: 20, maxChars: 500 }), askWide('context', { id: 299, before: 20, after: 0, maxChars: 500 })]);
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
    const shown = d.text.split('\n').length - 1;      // after the lead line
    assert.ok(shown > 15 && shown < 40);
    assert.deepEqual(d.receipt.shown, { fromLine: 1, toLine: shown });
    assert.equal(d.receipt.truncated, true);
    assert.equal(d.receipt.nextFromLine, shown + 1);
    assert.deepEqual(d.notes, [`These lines are long: ${shown} of the 40 asked for fit in one result. nextFromLine continues after them.`]);
    const after = await askWide('read_file', { path: 'long.txt', fromLine: d.receipt.nextFromLine, limit: 1 });
    assert.ok(after.text.split('\n')[1].startsWith(`${shown + 1}: line ${shown + 1} `), after.text.slice(0, 200));
  });

  it('cleanup', async () => { await cleanup(); });
});
