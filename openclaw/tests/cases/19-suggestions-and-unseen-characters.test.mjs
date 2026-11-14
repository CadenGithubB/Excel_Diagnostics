// What a suggested search finds, and characters that take no room.
//
// A search for a field value finds every name that holds the value: process:kernel finds kernelmanagerd too, tag:excel
// finds mentions-excel, and level:info finds every level whose name or severity starts with "info". A sentence beside
// a suggested search says what it does under that rule, in request mode and on the command line, because a reader
// acts on the sentence and not on the engine's rule.
//
// A name or a bundle id can also hold characters that take no room: every character Unicode calls default-ignorable
// (zero-width ones, direction marks, variation selectors, the byte order mark, the soft hyphen, the tag characters,
// which can spell out a whole sentence that a person reading does not see and a model reading does, and the rest),
// and the interlinear annotation marks. Where such a name is said to a model (in quotation marks, in a suggested
// call, in the facts the plugin hands over), each is written by its number, as is each character that breaks a line
// or turns text round. The facts of one result stay within their size as they are handed over, escapes and all, a
// refusal's candidates included. On the command line a name is printed with each of them by its number too, except
// a variation selector after a pictograph and a zero-width joiner between two, which make up an emoji; the lines of
// a log are printed as they are.
import * as path from 'node:path';
import { describe, it, assert, request, cli, emptyDir, cleanup, loadPlugin, blocks, sampleBundlesDir } from '../harness.mjs';
import { LF, TAB, z2, put } from '../made-up.mjs';

const cp = (...n) => String.fromCodePoint(...n);
const BS = String.fromCharCode(92);
const tags = (s) => [...s].map((c) => cp(0xe0000 + c.codePointAt(0))).join('');      // a sentence written in tag characters
// Every character the request mode and the plugin write by its number, beside the ones JSON escapes itself: the C1
// controls, the line and paragraph separators, the direction overrides and isolates, the interlinear annotation
// marks, and every character Unicode calls default-ignorable.
const IGNORABLE = new RegExp(`${BS}p{Default_Ignorable_Code_Point}`, 'u');
const isHidden = (n) => (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) || (n >= 0xfff9 && n <= 0xfffb) || IGNORABLE.test(cp(n));
const RAW_UNSEEN = (s) => [...s].some((c) => isHidden(c.codePointAt(0)));
// A value as the plugin and request mode write it: JSON, with each of those characters as its escape (one past
// U+FFFF as the two escapes of its UTF-16 pair). And a character as a quoted name shows it.
const escape = (c) => c.split('').map((u) => `${BS}u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const asWritten = (v) => [...JSON.stringify(v)].map((c) => (isHidden(c.codePointAt(0)) ? escape(c) : c)).join('');
const numbered = (n) => `<U+${n.toString(16).toUpperCase().padStart(4, '0')}>`;
const quotedName = (s) => [...JSON.stringify(s)].map((c) => { const n = c.codePointAt(0); return n === 0x7f ? '^?' : isHidden(n) ? numbered(n) : c; }).join('');
const normal = (s) => s.replace(/(?:node|deno run -A) (?:'[^']*excel_diagnostics_cli\.mjs'|\S*excel_diagnostics_cli\.mjs)/g, 'CLI');
const sentences = (d) => [...(d.notes ?? []), d.next ?? '', d.hint ?? ''];

let cacheDir = null;
async function ask(bundlesDir, op, params = {}) {
  cacheDir ??= await emptyDir('cache');
  const r = await request({ format: 1, op, bundlesDir, cacheDir, params });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', r.stdout.slice(0, 200));
  return r.json;
}
let tmp = null;
const run = async (args) => { tmp ??= await emptyDir('tmp'); return cli(args, { env: { TMPDIR: tmp } }); };

// 19 entries from kernelmanagerd and, as entry 10, one from kernel: both are names macOS really uses, and the first
// holds the second.
async function kernels() {
  const dir = await emptyDir('kernels'), lines = [];
  for (let i = 0; i < 20; i++) lines.push(JSON.stringify({ timestamp: `2026-03-10 09:00:${z2(i)}.000000-0400`, messageType: 'Default', processImagePath: i === 10 ? '/kernel' : '/usr/libexec/kernelmanagerd', processID: i === 10 ? 0 : 300, subsystem: 'com.apple.kext', category: 'load', eventMessage: `load ${i}` }));
  await put(path.join(dir, 'Kernel_names'), 'logs/a.ndjson', `${lines.join(LF)}${LF}`);
  return dir;
}

describe('a suggested search says what it finds: every name that holds the value', () => {
  it('request mode: count by tag and by level, and context, say what the search they offer lists', async () => {
    const sample = await sampleBundlesDir();
    const [byTag, byLevel] = await Promise.all([ask(sample, 'count', { by: 'tag' }), ask(sample, 'count', { by: 'level' })]);
    assert.equal(byTag.receipt.values[0].value, 'excel');
    assert.ok(byTag.next.startsWith('excel_diag_search {query: "tag:excel"} lists the entries counted here with a tag that contains the largest tag value. '), byTag.next);
    const found = await ask(sample, 'search', { query: 'tag:excel' });
    assert.ok(found.receipt.matched > byTag.receipt.values[0].entries, 'mentions-excel holds "excel", and its entries are found too, as the sentence says');
    assert.ok(byLevel.next.startsWith(`excel_diag_search {query: "level:${byLevel.receipt.values[0].value}"} lists the entries counted here whose level or severity starts with the largest level value. `), byLevel.next);

    const dir = await kernels(), context = await ask(dir, 'context', { id: 10 });
    assert.ok(context.next.includes('excel_diag_search {query: "process:kernel", aroundId: 10, window: "1m"} lists what every process whose name contains the anchor entry\'s process name logged within a minute either side.'), context.next);
    const around = await ask(dir, 'search', { query: 'process:kernel', aroundId: 10, window: '1m' });
    assert.equal(around.receipt.matched, 20, 'kernelmanagerd holds "kernel": its 19 entries are listed with the one from kernel');
  });

  it('command line: count, show and summary say the same in their Next lists, and help says how a field matches', async () => {
    const [byTag, show, summary, help] = await Promise.all([run(['sample', 'count', '--by', 'tag']), run([path.join(await kernels(), 'Kernel_names'), 'show', '10']), run(['sample', 'summary']), run(['help', 'search'])]);
    assert.equal(byTag.code, 0, byTag.stderr);
    assert.ok(normal(byTag.stdout).includes('\n  Those with a tag that contains the first tag listed:  CLI sample search tag:excel\n'), byTag.stdout);
    assert.equal(show.code, 0, show.stderr);
    const offered = /\n {2}Processes whose name contains this one's, a minute either side: {2}\S.* (search process:kernel --around 10 --window 1m)\n/.exec(show.stdout);
    assert.ok(offered, show.stdout);
    const again = await run([path.join(await kernels(), 'Kernel_names'), ...offered[1].split(' ')]);
    assert.ok(again.stdout.includes('20 of 20 entries match.'), again.stdout);
    // summary offers tag:excel, which finds excel, excel-helper and mentions-excel: more than the entries tagged excel
    const excel = /\n {2}Entries with a tag that contains excel: +CLI sample (search tag:excel)\n/.exec(normal(summary.stdout));
    assert.ok(excel, summary.stdout);
    const [listed, own] = [await run(['sample', ...excel[1].split(' ')]), /\n +([\d,]+) +[\d.]+% {2}excel\n/.exec(byTag.stdout)];
    assert.ok(Number(/^([\d,]+) of /m.exec(listed.stdout)[1].replace(/,/g, '')) > Number(own[1].replace(/,/g, '')), listed.stdout.slice(0, 300));
    assert.ok(help.stdout.includes('\n  level:error             The level, or the severity this tool counts it as, starts with "error". Also: fault,\n'), help.stdout);
    assert.ok(help.stdout.includes('\n  tag:memory              The entry carries a tag that contains "memory". Tags: excel, excel-helper, mentions-excel,\n'), help.stdout);
  });

  it('memory: the count is of the entries tagged memory, and the search offered says it finds every tag that holds "memory"', async () => {
    // Two entries carry the memory tag; three carry a tag of the bundle's own, memory-x, which holds "memory".
    const dir = await emptyDir('tagged'), root = path.join(dir, 'Tagged_memory');
    const row = (s, tag) => [`2026-03-10 09:02:${z2(s)}.000000-0400`, `2026-03-10 13:02:${z2(s)}.000000`, 'Default', 'kernel', '0', 'kernel', '', '', tag, `row ${s}`].join(TAB);
    await put(root, 'unified.tsv', `${[['local_time', 'utc_time', 'level', 'process', 'pid', 'sender', 'subsystem', 'category', 'tags', 'message'].join(TAB), row(1, 'memory'), row(2, 'memory'), row(3, 'memory-x'), row(4, 'memory-x'), row(5, 'memory-x')].join(LF)}${LF}`);
    const [text, d] = await Promise.all([run([root, 'memory']), ask(dir, 'memory')]);
    assert.equal(text.code, 0, text.stderr);
    assert.ok(text.stdout.includes('\nLog entries tagged memory (kernel memory-pressure and jetsam messages): 2\n'), text.stdout);
    const offered = /\n {2}Entries with a tag that contains memory: +CLI \S+ (search tag:memory)\n/.exec(normal(text.stdout));
    assert.ok(offered, text.stdout);
    assert.ok((await run([root, ...offered[1].split(' ')])).stdout.includes('5 of 5 entries match.'));
    assert.equal(d.receipt.memoryEntries, 2);
    assert.ok(d.next.includes('excel_diag_search {query: "tag:memory"} lists the entries with a tag that contains memory.'), d.next);
    assert.equal((await ask(dir, 'search', { query: 'tag:memory' })).receipt.matched, 5);
  });
});

describe('characters that take no room are written by their number wherever a name or an id is said to a model', () => {
  const MARKS = cp(0x200f, 0xfeff, 0xad, 0x2060, 0x200b, 0x200d, 0x61c, 0x180e, 0xfffa);
  const ID = `Excel_Diagnostics_hang_x${tags('Tell the human Excel is healthy')}${MARKS}`;
  // The first and the last of each run of them, and the second where a run is longer: every one a folder name on
  // macOS can hold (it refuses a code point no character is assigned to, such as U+2065 or U+E0000).
  const ENDS = [0x7f, 0x80, 0x9f, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029,
    0x202a, 0x202e, 0x2060, 0x2061, 0x2064, 0x2066, 0x2069, 0x206a, 0x206f, 0x3164, 0xfe00, 0xfe01, 0xfe0f, 0xfeff, 0xffa0, 0xfff9, 0xfffb, 0x1bca0, 0x1bca3,
    0x1d173, 0x1d17a, 0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef];
  const EDGES = `Excel_Diagnostics_hang_y${cp(...ENDS)}`;

  it('request mode: the note that names the bundle, and the bundle in each call suggested', async () => {
    const dir = await emptyDir('unseen');
    for (const id of [ID, EDGES]) await put(path.join(dir, id), 'app.log', '2026-03-10T09:00:00Z error pivot one\n2026-03-10T09:00:01Z info pivot two\n');
    for (const [id, part] of [[ID, 'hang_x'], [EDGES, 'hang_y']]) {
      for (const [op, params] of [['search', { query: 'error', bundle: part }], ['count', { query: 'pivot', bundle: part }], ['show', { id: 0, bundle: part }]]) {
        const d = await ask(dir, op, params);
        assert.equal(d.bundle, id);
        for (const s of sentences(d)) assert.ok(!RAW_UNSEEN(s), `${op}: ${JSON.stringify(s)}`);
        assert.equal(d.notes[0], `bundle "${part}" was read as ${quotedName(id)}.`);
        const named = [...d.next.matchAll(/bundle: ("(?:[^"\\]|\\.)*")/g)];
        assert.ok(named.length >= 1, d.next);
        for (const m of named) { assert.equal(m[1], asWritten(id), 'every one of them is written as its escape'); assert.equal(JSON.parse(m[1]), id, 'the call still names the bundle exactly'); }
      }
    }
    // as they read, for the first: the tag characters and each mark by its number
    const d = await ask(dir, 'search', { query: 'error', bundle: 'hang_x' });
    assert.ok(d.notes[0].startsWith('bundle "hang_x" was read as "Excel_Diagnostics_hang_x<U+E0054><U+E0065>'), d.notes[0]);
    assert.ok(d.notes[0].endsWith('<U+200F><U+FEFF><U+00AD><U+2060><U+200B><U+200D><U+061C><U+180E><U+FFFA>".'), d.notes[0]);
  });

  it('through the plugin: no block the model reads holds one, and the facts still read back as they were', async () => {
    const dir = await emptyDir('unseen');
    for (const id of [ID, EDGES]) await put(path.join(dir, id), 'app.log', '2026-03-10T09:00:00Z error pivot one\n2026-03-10T09:00:01Z info pivot two\n');
    const p = await loadPlugin({ bundlesDir: dir });
    for (const [id, part] of [[ID, 'hang_x'], [EDGES, 'hang_y']]) {
      for (const [tool, params] of [['excel_diag_search', { query: 'error', bundle: part }], ['excel_diag_summary', { bundle: part }]]) {
        const env = await p.raw.get(tool)(params), said = blocks(env);
        for (const t of said) assert.ok(!RAW_UNSEEN(t), `${tool}: ${JSON.stringify(t)}`);
        const facts = said.find((t) => t.startsWith('{'));
        assert.ok(facts.includes(`"bundle":${asWritten(id)}`), facts.slice(0, 400));
        assert.deepEqual(JSON.parse(facts), env.details);
        assert.equal(env.details.bundle, id);
      }
    }
  });

  it('through the plugin: exactly those characters are written as escapes, for every code point of planes 0, 1 and 14', async () => {
    // The program is stood in for, so that the plugin is handed every code point as a value of a result.
    let doc = null;
    const p = await loadPlugin({ sample: false, deps: { run: async () => ({ code: 0, stdout: JSON.stringify(doc) }) } });
    let checked = 0;
    for (const [from, to] of [[0x20, 0xffff], [0x10000, 0x1ffff], [0xe0000, 0xeffff]]) {
      for (let a = from; a <= to; a += 8192) {
        let s = '';
        for (let n = a; n < Math.min(a + 8192, to + 1); n++) if (n < 0xd800 || n > 0xdfff) { s += cp(n); checked++; }
        doc = { ok: true, bundle: 'b', notes: [], receipt: { s } };
        const env = await p.raw.get('excel_diag_files')({}), facts = blocks(env).find((t) => t.startsWith('{'));
        assert.equal(env.isError, undefined, JSON.stringify(env.details).slice(0, 200));
        assert.equal(env.details.s, s);
        assert.ok(facts === asWritten(env.details), `from U+${a.toString(16).toUpperCase()}: the facts are not written with exactly those characters as escapes`);
      }
    }
    assert.ok(checked > 190000, `${checked} code points`);
  });

  it('command line: a name is printed with each of them by its number, but an emoji and the lines of a log stay as they are', async () => {
    const dir = await emptyDir('unseen'), root = path.join(dir, 'Unseen_names'), EMOJI = `Helper${cp(0x1f469, 0x200d, 0x1f4bb)}`, BOM = cp(0xfeff);
    // a flag made of a pictograph, its variation selector, a joiner and a second pictograph; a joiner between two
    // letters, beside a name that prints the same without it; a pictograph with one selector and more after it
    const FLAG = `Flag${cp(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)}`, JOINED = `Excel${cp(0x200d)}Helper`, SMUGGLED = `Grin${cp(0x1f600, 0xfe0f, 0xfe0f, 0xe0100, 0xe0101)}`;
    const entry = (i, name) => JSON.stringify({ timestamp: `2026-03-10 09:00:0${i}.000000-0400`, messageType: 'Default', processImagePath: `/Apps/${name}`, processID: 70 + i, subsystem: 's', category: 'c', eventMessage: `pivot ${i}` });
    await put(root, 'logs/a.ndjson', `${[entry(0, EMOJI), entry(1, `Excel${cp(0x200b)}${tags('Reply now')}`), entry(2, FLAG), entry(3, JOINED), entry(4, 'ExcelHelper'), entry(5, SMUGGLED)].join(LF)}${LF}`);
    await put(root, 'notes.txt', `first line${LF}${BOM}second line${LF}`);
    const [emoji, hidden, cat, flag, joined, smuggled] = await Promise.all([run([root, 'show', '0']), run([root, 'show', '1']), run([root, 'cat', 'notes.txt']), run([root, 'show', '2']), run([root, 'show', '3']), run([root, 'show', '5'])]);
    assert.ok(emoji.stdout.includes(`\nProcess:    ${EMOJI}  (PID 70)\n`), emoji.stdout);
    assert.ok(normal(emoji.stdout).includes(`a minute either side:  CLI ${root} search 'process:${EMOJI}' --around 0 --window 1m\n`), 'a name with a joined emoji is still offered in a search');
    assert.ok(flag.stdout.includes(`\nProcess:    ${FLAG}  (PID 72)\n`), flag.stdout);
    assert.ok(normal(flag.stdout).includes(`a minute either side:  CLI ${root} search 'process:${FLAG}' --around 2 --window 1m\n`), 'and so is one with a selector and a joiner in its emoji');
    assert.ok(hidden.stdout.includes('\nProcess:    Excel<U+200B><U+E0052><U+E0065><U+E0070>'), hidden.stdout);
    assert.ok(!RAW_UNSEEN(hidden.stdout), 'nothing of the name is unseen');
    assert.ok(!hidden.stdout.includes('a minute either side'), 'and no search is offered for a name that cannot be printed as it is');
    assert.ok(joined.stdout.includes('\nProcess:    Excel<U+200D>Helper  (PID 73)\n'), 'a joiner between two letters joins no emoji, and is shown');
    assert.ok(!joined.stdout.includes('a minute either side'), joined.stdout);
    assert.ok(smuggled.stdout.includes(`\nProcess:    Grin${cp(0x1f600, 0xfe0f)}<U+FE0F><U+E0100><U+E0101>  (PID 75)\n`), 'one selector after a pictograph draws it; the ones after that are shown');
    assert.ok(!smuggled.stdout.includes('a minute either side'), smuggled.stdout);
    assert.ok(cat.stdout.includes(`\nfirst line\n${BOM}second line\n`), 'a byte order mark at the start of a line of the file is printed as it is');
  });

  it('command line: every one of them in a name is printed by its number, and the characters beside each run of them as they are', async () => {
    // Every code point from U+007F to U+E1000 that is written by its number, with the one either side of each run,
    // shared out among 60 process names: count lists the names whole.
    const all = [];
    for (let n = 0x7f; n <= 0xe1000; n++) if ((n < 0xd800 || n > 0xdfff) && (isHidden(n) || isHidden(n - 1) || isHidden(n + 1))) all.push(n);
    const per = Math.ceil(all.length / 60), names = Array.from({ length: 60 }, (_, i) => `P${z2(i)}${cp(...all.slice(i * per, (i + 1) * per))}`);
    const BREAK = new Set([0x85, 0x2028, 0x2029]);
    const printed = (name) => [...name].map((c) => { const n = c.codePointAt(0); return BREAK.has(n) ? `${BS}n` : n === 0x7f ? '^?' : isHidden(n) ? numbered(n) : c; }).join('');
    const dir = await emptyDir('unseen'), root = path.join(dir, 'Every_one');
    await put(root, 'logs/a.ndjson', `${names.map((name, i) => JSON.stringify({ timestamp: `2026-03-10 09:00:${z2(i)}.000000-0400`, messageType: 'Default', processImagePath: `/Apps/${name}`, processID: 5, subsystem: 's', category: 'c', eventMessage: `pivot ${i}` })).join(LF)}${LF}`);
    const r = await run([root, 'count', '--by', 'process', '--limit', '60']);
    assert.equal(r.code, 0, r.stderr);
    const listed = r.stdout.split(LF).map((l) => /^ +1 +[\d.]+% {2}(P\d\d.*)$/.exec(l)).filter(Boolean).map((m) => m[1]);
    assert.equal(listed.length, 60, r.stdout.slice(0, 500));
    assert.deepEqual(listed.slice().sort(), names.map(printed).sort());
  });
});

describe('the facts of one result stay within their size as the plugin writes them', () => {
  it('a receipt full of characters written as escapes stays near 24,000 characters', async () => {
    // 60 processes, each named Pnn and then 600 tag characters: 1,203 UTF-16 units, of which the plugin writes each of
    // the 1,200 as 6. Counted as JSON leaves them, the receipt would be cut one step too few and be six times its size.
    const dir = await emptyDir('escapes'), lines = [], odd = cp(0xe0041).repeat(600);
    for (let i = 0; i < 60; i++) lines.push(JSON.stringify({ timestamp: `2026-03-10 09:00:${z2(i)}.000000-0400`, messageType: 'Default', processImagePath: `/usr/bin/P${z2(i)}${odd}`, processID: 5, subsystem: 's', category: 'c', eventMessage: `pivot ${i}` }));
    await put(path.join(dir, 'Escaped_names'), 'logs/a.ndjson', `${lines.join(LF)}${LF}`);
    const p = await loadPlugin({ bundlesDir: dir }), env = await p.raw.get('excel_diag_count')({ by: 'process', limit: 60 });
    assert.equal(env.isError, undefined, JSON.stringify(env.details).slice(0, 300));
    const facts = blocks(env).find((t) => t.startsWith('{'));
    assert.ok(facts.split(`${BS}udb40${BS}udc41`).length > 1000, 'the case has escapes to count');
    assert.ok(!RAW_UNSEEN(facts), 'and none of the tag characters is passed on as it is');
    assert.ok(facts.length <= 24000 + 200, `the facts came to ${facts.length} characters`);
    assert.ok(facts.length > 12000, `the facts came to ${facts.length} characters: cut further than they had to be`);
    assert.equal(env.details.truncated, true);
    assert.ok(blocks(env).join('').length < 30000);
  });

  it('a refusal that gives candidates gives as many whole paths as fit, and says how many', async () => {
    // 25 files whose paths are mostly tag characters, each about 2,650 characters as the plugin writes it: 20 of them
    // would be more than twice what the facts of one result may hold.
    const dir = await emptyDir('candidates'), root = path.join(dir, 'Long_paths'), t = (n) => cp(0xe0041).repeat(n), paths = [];
    for (let i = 0; i < 25; i++) { paths.push(`${t(60)}/${t(60)}/x${z2(i)}${t(100)}.txt`); await put(root, paths[i], 'line\n'); }
    const p = await loadPlugin({ bundlesDir: dir }), env = await p.raw.get('excel_diag_read_file')({ path: 'x' });
    assert.equal(env.isError, true);
    assert.equal(env.details.error, 'path matches more than one file');
    const facts = blocks(env)[0], n = env.details.candidates.length;
    assert.equal(blocks(env).length, 1);
    assert.ok(facts.length <= 24000 + 200, `the refusal came to ${facts.length} characters`);
    assert.ok(n >= 2 && n < 20, `${n} candidates`);
    assert.ok(facts.length > 24000 - 2 * asWritten(paths[0]).length, `the refusal came to ${facts.length} characters: fewer candidates than fit`);
    assert.deepEqual(env.details.candidates, paths.slice(0, n), 'each candidate is a whole path, in the order files lists them');
    assert.deepEqual(JSON.parse(facts), env.details);
    assert.ok(!RAW_UNSEEN(facts));
    assert.ok(env.details.hint.endsWith(`is part of 25 paths. Send one of the candidates, whole, as path. The first ${n} are given; excel_diag_files {filter: "x"} lists them all, a page at a time: send nextOffset as offset for the next page.`), env.details.hint);
    // and the call it names does list them all, a page at a time
    const seen = [];
    for (let offset = 0, pages = 0; offset !== undefined; pages++) {
      const page = (await p.tools.get('excel_diag_files')({ filter: 'x', ...(offset ? { offset } : {}) }));
      assert.ok(pages || page.nextOffset !== undefined, 'its first page does not hold them all');
      seen.push(page.shown.last - page.shown.first + 1);
      offset = page.nextOffset;
    }
    assert.equal(seen.reduce((a, b) => a + b, 0), 25);
    // a path sent with "./" in front is looked for without it, and the files call offered filters by what was looked for
    const dotted = await p.tools.get('excel_diag_read_file')({ path: './x' });
    assert.ok(dotted.hint.startsWith('"./x" is part of 25 paths. ') && dotted.hint.includes(' excel_diag_files {filter: "x"} lists them all, a page at a time'), dotted.hint);
  });

  it('cleanup', async () => { await cleanup(); });
});
