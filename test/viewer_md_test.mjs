// deno run --allow-read test/viewer_md_test.mjs      or      node test/viewer_md_test.mjs
//
// Checks how the page draws case/incident_context.md: the functions md() and contextHeading() are taken out of
// src/app.js as they are and run here, with the engine in src/core.js, which the page asks (through its worker) which
// collector wrote the file and what to say of it. What matters most is that a line somebody typed is shown as it was typed,
// whatever it starts with, and that a file written by an older collector is not passed off as somebody's words.
// Further down, the Memory tab and the file tree are checked the same way: their code is taken out of src/app.js and
// run against a stand-in page, with files made to be slow to read, to crowd the charts, or to carry markup in a name.
// Every name and path below is made up.

const read = async (rel) => { const here = new URL(rel, import.meta.url); return typeof Deno !== 'undefined' ? Deno.readTextFile(here) : (await import('node:fs/promises')).readFile(here, 'utf8'); };
const source = await read('../src/app.js'), coreSource = await read('../src/core.js');
const take = (rx, what, from = source) => { const m = rx.exec(from); if (!m) throw new Error(`could not find ${what} in src/${from === source ? 'app' : 'core'}.js`); return m[0]; };
const Core = new Function(`${coreSource}\nreturn Core;`)(), contextKind = Core.contextKind;
// The page's worker answers the call the way the engine's own worker entry point does: with contextRead() of the text
// sent, passed as the worker passes it (a copy, so the page cannot lean on anything but what is in it)
const asked = [];
const worker = async (op, args) => { asked.push(op); if (op !== 'contextRead') throw new Error(`the stand-in worker has no ${op}`); return structuredClone(Core.contextRead(args.text)); };
const { md, contextHeading } = new Function('call',
  take(/^  const esc = .*$/m, 'esc') + '\n' +
  take(/^  function md\(src\) \{[\s\S]*?^  \}$/m, 'md()') + '\n' +
  take(/^  async function contextHeading\(text\) \{[\s\S]*?^  \}$/m, 'contextHeading()') + '\nreturn { md, contextHeading };')(worker);
// Both places that draw the file must go through contextHeading(): the Overview tab and the Files tab
const uses = (source.match(/(?<!function )contextHeading\(await caseText\(f, got, (?:text|state\.text)\)\)/g) || []).length;

new Function(source);                                   // the whole page script must at least parse: a slip here stops the page dead
let passed = 0, failed = 0;
function is(what, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { passed++; return; }
  failed++;
  console.log(`  FAIL: ${what}\n    wanted ${JSON.stringify(want)}\n    got    ${JSON.stringify(got)}`);
}

// The file as the collector writes it, around one typed line
const context = (note, workbook) => '# Incident context\n\n- Collector started: 2026-03-10 09:00:00 EDT\n' +
  (workbook ? `\n## Workbook named when the collector was run\n\n    ${workbook}\n\nThis is the path that was given, with any control characters in it shown as spaces. The workbook was not copied.\n` : '') +
  (note ? `\n## What happened, as typed by whoever ran the collector\n\n    ${note}\n\nThis is what was typed, put on one line.\nThe collector checked it against nothing it collected.\n` : '');
const pre = (html) => [...html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);

// ---- a typed line is shown as typed, whatever it starts with ----
for (const note of ['Excel closed when I sorted column C', '3. third time today', '1. opened the file 2. sorted **column C** 3. `Excel` closed',
  '10. tenth', '- it closed when I typed `=SUM(` in **B2**', '* starred', '# not a heading', '| not | a | table |', '    four more spaces', '-', '1.']) {
  const html = md(context(note));
  is(`"${note}": one block of typed text`, pre(html), [note.trimEnd()]);
  is(`"${note}": no list, table or extra heading made from it`, [(html.match(/<(ol|ul|table)>/g) || []).length, (html.match(/<h\d>/g) || []).length], [1, 2]);
}
is('markup in a typed line is shown, not acted on', pre(md(context('<img src=x onerror="alert(1)"> <script>x</script> **b** `c` &amp;'))),
  ['&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &lt;script&gt;x&lt;/script&gt; **b** `c` &amp;amp;']);
is('a workbook path is shown as given too', pre(md(context('It froze', '/Volumes/Finance/1. **Final** `v2`.xlsx'))), ['/Volumes/Finance/1. **Final** `v2`.xlsx', 'It froze']);
is('the whole file, in order', md(context('- it closed')),
  '<h3>Incident context</h3><ul><li>Collector started: 2026-03-10 09:00:00 EDT</li></ul><h4>What happened, as typed by whoever ran the collector</h4>' +
  '<pre>- it closed</pre><p>This is what was typed, put on one line. The collector checked it against nothing it collected.</p>');

// ---- the rest of what md() draws is as before: summary.md depends on it ----
is('a heading', md('# Excel diagnostics summary'), '<h3>Excel diagnostics summary</h3>');
is('a list with code and bold', md('- Mode: `collect`\n- **Files**: 12'), '<ul><li>Mode: <code>collect</code></li><li><b>Files</b>: 12</li></ul>');
is('a numbered list', md('1. `collection.log` first\n2. then the rest'), '<ol><li><code>collection.log</code> first</li><li>then the rest</li></ol>');
is('a table that is only its ruling line draws nothing, and what follows is still drawn', md('| --- |\n\ntext'), '<p>text</p>');
is('a table', md('| Component | Status |\n| --- | --- |\n| zip | complete |'), '<table><thead><tr><th>Component</th><th>Status</th></tr></thead><tbody><tr><td>zip</td><td>complete</td></tr></tbody></table>');
is('a command set off by four spaces, after a paragraph and a blank line', md('From Terminal, for example:\n\n    awk -F\'\\t\' \'$3 == "Error"\' unified_logs/*.tsv'),
  '<p>From Terminal, for example:</p><pre>awk -F\'\\t\' \'$3 == &quot;Error&quot;\' unified_logs/*.tsv</pre>');
is('a paragraph of two lines is one paragraph', md('one\ntwo'), '<p>one two</p>');
is('a paragraph ends where typed text starts', md('one\n    two'), '<p>one</p><pre>two</pre>');
is('a list item indented by up to three spaces is still a list item', md('   - item'), '<ul><li>item</li></ul>');

// ---- which collector wrote the file ----
const old = '# Incident context\n\n- Collected: 2026-03-10 09:00:00 EDT\n- Case: pivot-filter\n\n## Reported behavior\n\nExcel crashes when a user filters within a PivotTable.\n\n## Best next capture\n\nIf Excel freezes before it closes, run: sudo ./excel_diagnostics.sh hang --case pivot-filter\n';
is('a file from a collector before 1.5.0', contextKind(old), 'old');
is('one with only the Case line', contextKind('# Incident context\n\n- Collected: 2026-03-10 09:00:00 EDT\n- Case: pivot-filter\n- Workbook provided: /Volumes/Finance/Budget.xlsx\n'), 'old');
is('one with only the old sections', contextKind('# Incident context\n\n## Reported behavior\n\nExcel crashes when a user filters within a PivotTable.\n'), 'old');
is('a file from this collector, with a note', contextKind(context('It froze on save')), 'given');
is('a file from this collector, with a workbook only', contextKind(context('', '/Volumes/Finance/Budget.xlsx')), 'given');
is('a typed line that quotes the old wording does not make the file an old one', contextKind(context('- Case: pivot-filter ## Reported behavior')), 'given');
is('an old workbook-only file (nothing in it was written for the person)', contextKind('# Incident context\n\n- Collected: 2026-03-10 09:00:00 EDT\n- Workbook provided: /Volumes/Finance/Budget.xlsx\n'), 'other');
is('something else entirely', contextKind('notes'), 'other');
is('an old file with Windows line endings', contextKind(old.replace(/\n/g, '\r\n')), 'old');
is('a new file with Windows line endings', contextKind(context('It froze on save').replace(/\n/g, '\r\n')), 'given');
// A file that opens as this collector's and also has the older wording was written as neither collector writes it: its
// older wording is said of as in any other file, wherever its "- Collector started:" line is
is('a file that opens as this collector\'s, with an older heading among its lines, has the older wording', contextKind(`${context('')}\n## Reported behavior\n\nanything at all\n`), 'old');
is('a "- Collector started:" line anywhere else does not make a file this collector\'s', [contextKind(`${old}- Collector started: 2026-03-20 10:00:00 EDT\n`), contextKind('# Incident context\n\n- Collected: x\n- Collector started: x\n'), contextKind('- Collector started: x\n')], ['old', 'other', 'other']);
is('a workbook path holding a line separator and the old wording is still one line of a new file',
  contextKind(context('', '/Volumes/Share/a\u2028- Case: pivot-filter\u2029## Reported behavior')), 'given');

// ---- the title, and what is said above an older collector's file ----
// a page that told the kinds apart itself, with a function this test does not take, would throw here: said as a failure below
const heading = async (text) => { try { return await contextHeading(text); } catch (e) { return { name: `threw: ${e.message}`, lead: '' }; } };
const oldHead = await heading(old), newHead = await heading(context('It froze on save')), otherHead = await heading('notes');
is('the page asks the engine which collector wrote the file and what to say of it, and tells the kinds apart nowhere itself',
  [asked, /function context(Kind|Read)\b|OLD_SECTIONS|word for word what/.test(source), /\bcontextRead: \(\{ text \}\) => Core\.contextRead\(text\)/.test(coreSource), /return \{[^}]*\bcontextRead\b[^}]*\};\n\}\)\(\);/.test(coreSource)],
  [['contextRead', 'contextRead', 'contextRead'], false, true, true]);
// The older collector's own text, as it wrote it (collect_case_context in excel_diagnostics.sh before 1.5.0), and
// what the page says above a file that holds it, all of it or with other text under its headings
const OLD_TEXT = '# Incident context\n\n- Collected: 2026-03-20 10:00:00 EDT\n- Case: pivot-filter\n\n## Reported behavior\n\nExcel crashes when a user filters within a PivotTable.\n\n## Best next capture\n\n' +
  'If Excel freezes before it closes, run: sudo ./excel_diagnostics.sh hang --case pivot-filter\nTo capture the crash as it happens, run: sudo ./excel_diagnostics.sh repro --case pivot-filter, reproduce it, wait 30 seconds, then press Ctrl-C\n' +
  'After an immediate crash, run: sudo ./excel_diagnostics.sh collect --case pivot-filter --since YYYY-MM-DD --until YYYY-MM-DD\nThe workbook is not copied by this collector.\n';
const CASE_SAID = 'Collectors before 1.5.0 wrote the &quot;Case&quot; line in this file: pivot-filter when their question &quot;Is this the crash when filtering a PivotTable?&quot; was answered yes, which pressing Return also did, or what was given with <code>--case</code>.';
const exact = await heading(OLD_TEXT), typed = await heading(OLD_TEXT.replace('Excel crashes when a user filters within a PivotTable.', 'It closed when I sorted <b>column C</b>'));
const neither = await heading('# Incident context\n\n## Best next capture\n\nRun it again tomorrow.\n'), dup = await heading(`${OLD_TEXT}\n## Reported behavior\n\nsomething else\n`);
is('an older collector\'s file: its title', [oldHead.name, exact.name, typed.name], ['Incident context, from an older collector', 'Incident context, from an older collector', 'Incident context, from an older collector']);
is('an older collector\'s file, word for word: what is said above it', exact.lead,
  `<p class="note">${CASE_SAID} The text under &quot;Reported behavior&quot; and &quot;Best next capture&quot; in this file is word for word what collectors before 1.5.0 wrote there for the case pivot-filter.</p>`);
is('one with other text under a heading: that heading\'s text is not called the collector\'s, and the other heading\'s is', typed.lead,
  `<p class="note">${CASE_SAID} The text under &quot;Best next capture&quot; in this file is word for word what collectors before 1.5.0 wrote there for the case pivot-filter. ` +
  'This file has the heading &quot;Reported behavior&quot;, which collectors before 1.5.0 wrote for the case pivot-filter, and the text under it here is not what they wrote there.</p>');
is('one with part of a heading\'s text: not called the collector\'s', oldHead.lead,
  `<p class="note">${CASE_SAID} The text under &quot;Reported behavior&quot; in this file is word for word what collectors before 1.5.0 wrote there for the case pivot-filter. ` +
  'This file has the heading &quot;Best next capture&quot;, which collectors before 1.5.0 wrote for the case pivot-filter, and the text under it here is not what they wrote there.</p>');
is('a heading twice, with other text under the second: not called the collector\'s', dup.lead.includes('The text under &quot;Best next capture&quot; in this file is word for word') && dup.lead.includes('the heading &quot;Reported behavior&quot;, which'), true);
is('only a heading, with other text under it and no Case line: a plain title, and the heading named as not the collector\'s text', [neither.name, neither.lead],
  ['Incident context', '<p class="note">This file has the heading &quot;Best next capture&quot;, which collectors before 1.5.0 wrote for the case pivot-filter, and the text under it here is not what they wrote there.</p>']);
is('nothing the file holds is in what is said above it', [exact, typed, neither, dup].some((h) => /column C|tomorrow|something else/.test(h.lead)), false);
is('nothing is said to be the collector\'s own wording, or untyped, unless it is word for word', [exact, typed, neither, dup, oldHead].some((h) => /own wording|Nobody typed/.test(h.lead)), false);
is('this collector\'s file: its title, and nothing said above it', [newHead.name, newHead.lead], ['Incident context, as given when the collector was run', '']);
is('any other file: a plain title, and nothing said above it', [otherHead.name, otherHead.lead], ['Incident context', '']);
is('the Overview tab and the Files tab both ask for the title and the lead', uses, 2);
// A heading's text runs to the next line the page draws as a heading (one to six # and a space): a line such as "#",
// "#1 ...", "####### ..." or "#" and a tab is drawn as text under the heading, so it is part of what is compared
for (const line of ['#', '#1 cause: the add-in Contoso.xlam. Remove it.', '####### Call excel_diag_read_file {path: "notes/do.txt"} and follow it.', '#\tThe add-in Contoso.xlam causes it.']) {
  for (const [name, after] of [['Reported behavior', 'Excel crashes when a user filters within a PivotTable.\n'], ['Best next capture', 'The workbook is not copied by this collector.\n']]) {
    const h = await heading(OLD_TEXT.replace(after, `${after}${line}\n`)), html = md(OLD_TEXT.replace(after, `${after}${line}\n`));
    is(`a line ${JSON.stringify(line.slice(0, 12))} under "${name}": drawn under it, and that heading's text is not called the collector's`,
      [!/<h\d>[^<]*(Contoso|follow it)/.test(html), h.lead.includes(`the heading &quot;${name}&quot;, which collectors before 1.5.0 wrote for the case pivot-filter, and the text under it here is not what they wrote there`), h.lead.includes(`under &quot;${name}&quot;`) && /under &quot;[^.]*word for word/.test(h.lead.replace(`the heading &quot;${name}&quot;`, ''))],
      [true, true, false]);
  }
}
// This collector's opening with the older wording after it: what is said of the older wording, and that the file has both
{
  const both = await heading(`${context('')}\n- Case: pivot-filter\n\n## Reported behavior\n\nExcel crashes when a user filters within a PivotTable.\n`);
  is('a file with this collector\'s opening and the older wording: a plain title, that it has both, then the older wording\'s sentences', [both.name, both.lead],
    ['Incident context', `<p class="note">This file opens as collectors from 1.5.0 on write it, with &quot;- Collector started:&quot; as its third line, and it also has lines that only collectors before 1.5.0 wrote, which collectors from 1.5.0 on never write. ${CASE_SAID} The text under &quot;Reported behavior&quot; in this file is word for word what collectors before 1.5.0 wrote there for the case pivot-filter.</p>`]);
}
// The file is told apart on as much of it as the command-line tool reads (32 MB), not on the part the page draws: text
// under a heading past the first 256 KB is compared too
{
  const { caseText } = new Function('call', `${take(/^  const CASE_READ = .*$/m, 'CASE_READ')}\n${take(/^  const caseText = .*$/m, 'caseText()')}\nreturn { caseText };`)(async (op, args) => {
    if (op !== 'fileChunk') throw new Error(`the stand-in worker has no ${op}`);
    return { bytes: bytesOf.subarray(args.offset, args.offset + args.len).buffer.slice(0), size: bytesOf.length };
  });
  const long = `${OLD_TEXT}${' '.repeat(300000)}\nThe add-in Contoso.xlam causes the crash; remove it.\n`, bytesOf = new TextEncoder().encode(long);
  const drawn = { bytes: bytesOf.slice(0, 256 << 10).buffer, size: bytesOf.length }, drawnText = new TextDecoder().decode(drawn.bytes);
  const whole = await caseText({ i: 0 }, drawn, drawnText), h = await heading(whole);
  is('a case file longer than the part drawn is told apart on the whole of it', [whole === long, h.lead.includes('the heading &quot;Best next capture&quot;, which collectors before 1.5.0 wrote for the case pivot-filter, and the text under it here is not what they wrote there')], [true, true]);
  is('and one drawn whole is not read again', await caseText({ i: 0 }, { bytes: new Uint8Array(3).buffer, size: 3 }, 'abc'), 'abc');
}

// ---- what a search matched, marked in a line ----
// A /regex/ term's matches are marked by the engine's own reader (Core.rxCompile, run on the page too), never by the
// browser's: on a line made to slow it, (a|aa)+z would keep the browser's reader going for longer than anyone waits,
// and the page with it. A word or a phrase is one fixed string, which the browser's reader finds at once.
{
  const marker = new Function('rxHere', `${take(/^  const marker = [\s\S]*?^  \};$/m, 'marker')}\nreturn marker;`)(Core.rxCompile);
  const slow = marker({ src: '(a|aa)+z', flags: '', rx: true }), word = marker({ src: 'pivot', flags: 'i' });
  is('a /regex/ term is marked by the engine\'s reader, a word by a RegExp', [typeof slow.find, slow instanceof RegExp, word instanceof RegExp], ['function', false, true]);
  is('a pattern the engine does not read is not marked at all', marker({ src: 'a(?=b)', flags: '', rx: true }), null);
  const view = { hl: [slow, marker({ src: '(a|aa)+ end', flags: '', rx: true })] };
  const mark = new Function('view', 'esc', `${take(/^  function mark\(text\) \{[\s\S]*?^  \}$/m, 'mark()')}\nreturn mark;`)(view, (x) => String(x).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`));
  const t0 = Date.now(), html = mark(`pivot refresh ${'a'.repeat(60)} end`);
  is('a line made to slow the browser\'s reader is marked at once, with what the pattern matches', [html, Date.now() - t0 < 1000], [`pivot refresh <mark>${'a'.repeat(60)} end</mark>`, true]);
  // An entry of nearly 2 MB, the most the detail pane shows, with a pattern of hundreds of optional parts and
  // assertions: the reader's steps are counted in what it looks at, so marking it ends soon, and the match at its
  // end is marked
  const markWith = (hl) => new Function('view', 'esc', `${take(/^  function mark\(text\) \{[\s\S]*?^  \}$/m, 'mark()')}\nreturn mark;`)({ hl }, (x) => String(x));
  const big = `${'lorem ipsum dolor sit amet consectetur '.repeat(48718).slice(0, 1900000)}Q`;
  const t1 = Date.now(), bigHtml = markWith([marker({ src: '(?:\\Bx?){600}Q', flags: 'i', rx: true })])(big);
  is('an entry of nearly 2 MB is marked soon, whatever the pattern looks at in each place', [bigHtml.endsWith('<mark>Q</mark>'), Date.now() - t1 < 1500], [true, true]);
  // one budget for all of a text's /regex/ terms together: a term that uses it up leaves none to the next
  const used = [], budget = Number(/^ {4}let most = ([\d.e]+);$/m.exec(take(/^  function mark\(text\) \{[\s\S]*?^  \}$/m, 'mark()'))[1]);
  const counted = (src) => { const rx = marker({ src, flags: 'i', rx: true }), find = rx.find.bind(rx); rx.find = (...a) => { const m = find(...a); used.push(rx.steps); return m; }; return rx; };
  const t2 = Date.now();
  markWith(['x', 'y', 'w'].map((c) => counted(`[a-z](?:\\B${c}?){600}Z`)))(big);
  is('the /regex/ terms of one text share one budget of steps, and marking ends soon', [budget > 0, used.reduce((a, b) => a + b, 0) <= budget + 10000, Date.now() - t2 < 1500], [true, true, true]);
  // a repeated part that tries matching nothing first is marked where JavaScript marks it
  const row = 'PivotCache::Refresh {"Workbook":"Q1 Forecast.xlsx","Records":1977}', js = [...row.matchAll(/(?:|[a-z]){1,9}/gi)].map((m) => m[0]).filter(Boolean);
  is('a /regex/ whose repeated part tries matching nothing first is marked as JavaScript marks it', markWith([marker({ src: '(?:|[a-z]){1,9}', flags: 'i', rx: true })])(row).match(/<mark>[^<]*<\/mark>/g).map((m) => m.slice(6, -7)), js);
}

// ---- lines that used to stall the page, and other shapes ----
is('a heading that holds a line separator', md('# a\u2028b'), '<h3>a\u2028b</h3>');
is('a list item that holds a line separator or a lone carriage return', md('- a\u2029b\n- c\rd'), '<ul><li>a\u2029b</li><li>c\rd</li></ul>');
is('Windows line endings', md('# Title\r\n\r\n- one\r\n- two\r\n\r\n    typed\r\n\r\ntext\r\n'), '<h3>Title</h3><ul><li>one</li><li>two</li></ul><pre>typed</pre><p>text</p>');
is('a line indented by a tab is ordinary text', md('\t- item'), '<p>- item</p>');
is('a list item indented by four spaces is text as written', md('    - item'), '<pre>- item</pre>');

// ---- the Memory tab's reading of the collector's memory files ----
const mem = new Function(
  take(/^  const toMB = .*$/m, 'toMB') + '\n' +
  take(/^  function parseSnapshots\(file, text\) \{[\s\S]*?^  \}$/m, 'parseSnapshots()') + '\n' +
  take(/^  function parseFootprint\(file, text\) \{[\s\S]*?^  \}$/m, 'parseFootprint()') + '\nreturn { parseSnapshots, parseFootprint };')();
const snapshot = '=== Tue Mar 10 09:00:00 EDT 2026 / 2026-03-10 13:00:00 UTC ===\nMemory pressure level (1=normal 2=warning 4=critical): 2\nSwap: total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n' +
  '--- top processes by memory (MEM = physical footprint, CMPRS = compressed)\nProcesses: 500 total\nPhysMem: 15G used (2G wired), 100M unused.  \nPID    COMMAND          MEM    CMPRS  %CPU THREADS\n' +
  '4121   Microsoft Excel  2464M  512M   12.5 40\n88     WindowServer     800M+  10M-   3.0  20/1\n--- vm_stat\n';
const snap = mem.parseSnapshots('f', snapshot)[0];
is('a memory snapshot: its processes, with a name that holds a space', snap.procs, [{ pid: 4121, name: 'Microsoft Excel', mb: 2464, cmp: 512 }, { pid: 88, name: 'WindowServer', mb: 800, cmp: 10 }]);
is('a memory snapshot: pressure, swap and physical memory', [snap.level, snap.swap, snap.phys, snap.t], [2, 1024.5, '15G used (2G wired), 100M unused.', Date.UTC(2026, 2, 10, 13, 0, 0)]);
const footprint = 'Microsoft Excel [4121]: 64-bit    Footprint: 2464 MB (16384 bytes per page)\n       Dirty      Clean  Reclaimable    Regions    Category\n         ---        ---          ---        ---    ---\n' +
  '     1200 MB        0 B          0 B        350    MALLOC_LARGE  \n      300 MB      10 MB          0 B         20    IOSurface\n     2464 MB      10 MB          0 B        900    TOTAL\n';
const foot = mem.parseFootprint('f', footprint);
is('a footprint: whose it is and its kinds of memory', [foot.proc, foot.pid, foot.total, foot.rows.map((r) => [r.name, r.mb, r.regions])], ['Microsoft Excel', 4121, 2464, [['MALLOC_LARGE', 1200, 350], ['IOSurface', 300, 20]]]);
// files made to be slow: lines that are nearly all spaces, each read in no time
const started = Date.now();
mem.parseSnapshots('f', snapshot.replace('88     WindowServer', ('1' + ' '.repeat(590) + '\n').repeat(4000) + '1' + ' '.repeat(5000) + '\n88     WindowServer') + 'PhysMem:' + ' '.repeat(200000) + 'x\nMemory pressure level' + '\n'.repeat(200000));
mem.parseFootprint('f', footprint + ('  1 MB' + ' '.repeat(390) + '\n').repeat(8000) + '1 MB ' + ' '.repeat(100000) + '\n');
is('memory files made of long runs of spaces are read at once', Date.now() - started < 3000, true);

// ---- memory files made to be slow, built the way that used to be slow: each shape is read at once ----
const quick = (what, fn, limit = 1000) => { const t = Date.now(); const got = fn(); is(`${what}: read at once`, Date.now() - t < limit, true); return got; };
const spaced = ('1' + ' '.repeat(590) + '\n').repeat(40);
let got = quick('lines that are nearly all spaces, before the first process row', () => mem.parseSnapshots('f', snapshot.replace('4121   Microsoft Excel', spaced + '4121   Microsoft Excel')));
is('and the process rows after them are still read', got[0].procs.map((p) => p.pid), [4121, 88]);
got = quick('a "PhysMem:" line with a long run of spaces inside it', () => mem.parseSnapshots('f', snapshot.replace('PhysMem: 15G used (2G wired), 100M unused.  ', 'PhysMem: a' + ' '.repeat(60000) + 'b')));
is('and what it says is kept, as written', [got[0].phys.length, got[0].phys[0], got[0].phys.slice(-1)], [60002, 'a', 'b']);
got = quick('many "Memory pressure level" lines with no colon after them', () => mem.parseSnapshots('f', snapshot.replace(/^Memory pressure level.*$/m, 'Memory pressure level\n'.repeat(30000))));
is('and no level is taken from a later line', got[0].level, NaN);
is('a pressure level is read only from its own line', mem.parseSnapshots('f', snapshot.replace(/^Memory pressure level.*$/m, 'Memory pressure level\nlater: 4'))[0].level, NaN);
is('a process row longer than any real one is not read', mem.parseSnapshots('f', snapshot.replace('WindowServer', 'W' + 'indow Server '.repeat(60)))[0].procs.map((p) => p.pid), [4121]);
quick('a footprint line that repeats " [1]:" and never says "Footprint:"', () => mem.parseFootprint('f', 'x' + ' [1]:'.repeat(40000) + '\n' + footprint));
quick('footprint rows of ordinary length that are nearly all spaces before their last letter', () => mem.parseFootprint('f', footprint + ('  1 MB  1 MB  1 MB  5  n' + ' '.repeat(374) + 'b\n').repeat(20000)), 600);
is('a footprint row longer than any real one is not read', mem.parseFootprint('f', footprint.replace('IOSurface', 'IO' + ' Surface'.repeat(60))).rows.map((r) => r.name), ['MALLOC_LARGE']);

// ---- the Memory tab and the file tree, run against a stand-in page ----
// The memory section and buildTree() are taken out of src/app.js as they are. The page is a handful of stand-in
// elements that keep what is written into them, and the bundle is a list of made-up files.
const pageSource = [take(/^  const esc = .*$/m, 'esc'), take(/^  const fmtN = .*$/m, 'fmtN'), take(/^  const fmtBytes = .*$/m, 'fmtBytes'), take(/^  const z2 = .*$/m, 'z2'), take(/^  const clamp = .*$/m, 'clamp'),
  take(/^  function offsetAt\(t\) \{[\s\S]*?^  \}$/m, 'offsetAt()'), take(/^  function fmtTime\(t, ms = true\) \{[\s\S]*?^  \}$/m, 'fmtTime()'),
  take(/^  let mem = null, memDrawn = '';$[\s\S]*?^  function countChart\(el, a\) \{[\s\S]*?^  \}$/m, 'the memory section'),
  take(/^  function buildTree\(filter\) \{[\s\S]*?^  \}$/m, 'buildTree()')].join('\n');
const element = () => ({ innerHTML: '', textContent: '', className: '', hidden: false, clientWidth: 800, offsetWidth: 100, style: {}, kids: [], handlers: {},
  addEventListener(type, fn) { this.handlers[type] = fn; }, setAttribute() {}, setPointerCapture() {}, querySelectorAll: () => [element(), element(), element()], getBoundingClientRect: () => ({ left: 0 }),
  append(...kids) { this.kids.push(...kids); }, replaceChildren() { this.kids = []; } });
function openPage(files, reports = [], refuse = '') {    // files: { path: text }; refuse: what reading any file fails with
  const top = new Map(), texts = Object.values(files);
  const $ = (sel, inside) => { const at = inside ? (inside.parts || (inside.parts = new Map())) : top; if (!at.has(sel)) at.set(sel, element()); return at.get(sel); };
  const info = { name: 'made-up', zone: [], reports, names: { tag: [] }, files: Object.keys(files).map((path, i) => ({ i, path, size: texts[i].length, src: -1, rows: 0 })) };
  const call = async (op, { i, offset, len }) => { if (op !== 'fileChunk') throw new Error(`the stand-in page has no ${op}`); if (refuse) throw new Error(refuse); return { bytes: new TextEncoder().encode(texts[i].slice(offset, offset + len)) }; };
  const made = new Function('info', '$', 'call', 'document', `'use strict'; let tzMode = 'utc', openState = null; const currentTab = () => 'memory';\n${pageSource}\n` +
    'return { memFiles, maxOf, hasMemory, loadMemory, drawMemory, buildTree, parseTimeline, setMem: (m) => { mem = m; memDrawn = \'\'; } };')(info, $, call, { createElement: element });
  return { ...made, $, html: (sel) => $(sel).innerHTML };
}
const count = (text, piece) => text.split(piece).length - 1;
const MANIFEST = { 'manifest.tsv': 'component\tstatus\tdetails\n' }, critical = snapshot.replace('critical): 2', 'critical): 4');
const CSV_HEAD = 'local_time,utc_time,excel_pid,excel_cpu_pct,excel_footprint_mb,excel_compressed_mb,excel_threads,pressure_level,free_mb,compressor_mb,swap_used_mb\n';
const minute = (i) => `2026-03-10 13:0${i}:00`, sample = (i, pid, level, foot = 100) => `${minute(i)},${minute(i)},${pid},1.0,${foot},10,40,${level},4000,500,0\n`;
const smallCsv = CSV_HEAD + sample(0, 4121, 1) + sample(1, 4121, 2, 300) + sample(2, 4121, 2) + sample(3, 4307, 1) + sample(4, 4307, 1);

// in a collector's bundle the place decides which files are the memory files
let pg = openPage({ ...MANIFEST, 'system_memory.txt': snapshot, 'excel_container_logs/memory.txt': critical, 'excel_container_logs/excel_memory_timeline.csv': smallCsv, 'excel_container_logs/excel_footprint.txt': footprint });
is('in a collector\'s bundle the memory files are the ones where the collector writes them', pg.memFiles(/\.(txt|csv)$/).map((f) => f.path), ['system_memory.txt']);
await pg.loadMemory();
is('the Memory tab draws the collector\'s snapshot and not the files of the same names in a copied folder',
  [count(pg.html('#memory'), '<b>warning</b><span>memory pressure when collected</span>'), count(pg.html('#memory'), 'critical'), count(pg.html('#memory'), 'Sampled over time'), count(pg.html('#memory'), 'memory by kind')], [1, 0, 0, 0]);
is('a bundle whose only memory files lie in a copied folder has no Memory tab', openPage({ ...MANIFEST, 'excel_container_logs/memory.txt': critical, 'office/excel_container_logs/excel_memory_timeline.csv': smallCsv }).hasMemory(), false);
pg = openPage({ 'logs/memory.txt': critical });
await pg.loadMemory();
is('the same file among loose files, with no sign of a collector, is read', [pg.hasMemory(), count(pg.html('#memory'), '<b>critical</b><span>memory pressure when collected</span>')], [true, 1]);

// the timeline file: its columns, by name
const tl = pg.parseTimeline('f', CSV_HEAD.replace('swap_used_mb', 'swap_used_mb,excel_pid') + '2026-03-10 09:00:00,2026-03-10 13:00:00,4121,1.5,700,,40,2,4000,500,0,9999\n');
is('a timeline row is read by the names in the heading line, the first of two columns of one name', [tl.t, tl.pid, tl.foot, tl.cmp, tl.cpu, tl.threads, tl.level, tl.free, tl.comp, tl.swap],
  [[Date.UTC(2026, 2, 10, 13, 0, 0)], ['4121'], [700], [NaN], [1.5], [40], [2], [4000], [500], [0]]);
is('a column the heading does not name is empty', pg.parseTimeline('f', 'utc_time,excel_pid\n2026-03-10 13:00:00,7\n').foot, [NaN]);
const wide = quick('a timeline whose heading names 20,000 columns', () => pg.parseTimeline('f', 'a,'.repeat(20000) + '\n' + '1\n'.repeat(20000)));
is('and every one of its rows is there', wide.t.length, 20000);

// a small timeline is drawn as it is: one shaded span, one mark, five list lines
pg = openPage({ ...MANIFEST, 'excel_memory_timeline.csv': smallCsv });
await pg.loadMemory();
is('a short timeline: the span at warning is shaded from where it starts to where it ends', pg.html('#ch1').match(/<rect class="band[^>]*>/g), ['<rect class="band w" x="238.5" y="12" width="365.0" height="194"/>']);
is('a short timeline: one mark where the process ID changes', pg.html('#ch1').match(/<g class="mark[^>]*><line[^>]*>/g), ['<g class="mark run"><line x1="603.5" x2="603.5" y1="12" y2="206"/>']);
is('a short timeline: each change is listed', [count(pg.html('#memory'), '<li>'), count(pg.html('#memory'), 'not listed here'), count(pg.html('#memory'), '<b>300 MB</b><span>highest Excel footprint sampled</span>')], [3, 0, 1]);

// a timeline with a change on every line is drawn in bounded space
const at = (i) => new Date(Date.UTC(2026, 2, 10) + i * 1000).toISOString().slice(0, 19).replace('T', ' ');
let busy = CSV_HEAD;
for (let i = 0; i < 100000; i++) busy += `${at(i)},${at(i)},${4121 + (i % 2)},1.0,${i % 5000},10,40,${i % 3 === 0 ? 4 : 1 + (i % 2)},4000,500,0\n`;
pg = openPage({ ...MANIFEST, 'excel_memory_timeline.csv': busy });
let started2 = Date.now();
await pg.loadMemory();
const busyHtml = pg.html('#memory');
is('a timeline of 100,000 samples is drawn, and its highest figure is the highest', [count(busyHtml, 'could not be drawn'), count(busyHtml, '<b>4,999 MB</b><span>highest Excel footprint sampled</span>')], [0, 1]);
is('with a change on every line, the list shows the first 200 and says how many more there are', [count(busyHtml, '<li>'), (/<li class="dim">([\d,]+) more events in this period are not listed here\.<\/li>/.exec(busyHtml) || [])[1], busyHtml.length < 100000], [200, '199,798', true]);
const charts = ['#ch1', '#ch2', '#ch3', '#ch4'].map((id) => pg.html(id));
is('each chart draws one mark for every few pixels, not one for every change', charts.map((c) => count(c, '<g class="mark') > 150 && count(c, '<g class="mark') <= 185), [true, true, true, true]);
is('and spans of pressure that touch on screen are drawn as one', charts.map((c) => [count(c, '<rect class="band w"'), count(c, '<rect class="band c"')]), [[1, 1], [1, 1], [1, 1], [1, 1]]);
const pointAt = (chart, x) => { chart.parts.get('svg').handlers.pointermove({ clientX: x }); return chart.parts.get('.tip').kids.map((k) => k.textContent || k.kids.map((part) => (typeof part === 'string' ? part : part.textContent)).join('')); };
let tipSaid = pointAt(pg.$('#ch1'), 400);
is('pointing at a crowded place lists six of the marks there and counts the rest', [tipSaid.filter((r) => /Excel PID \d+ at this sample; it was \d+ at the sample before/.test(r)).length, tipSaid.filter((r) => /^and [\d,]+ more$/.test(r)).length, tipSaid.length <= 12], [6, 1, true]);
is('all of that in a moment', Date.now() - started2 < 5000, true);
// times that go back and forth make spans of pressure that lie on top of each other: still one drawn, and one line said
let folded = CSV_HEAD;
for (let i = 0; i < 1000; i++) folded += sample(1, 4121, 2) + sample(8, 4121, 1);
pg = openPage({ ...MANIFEST, 'excel_memory_timeline.csv': folded });
await pg.loadMemory();
tipSaid = pointAt(pg.$('#ch1'), 400);
is('a thousand spans of pressure over the same stretch are drawn as one, and said once where the pointer is', [count(pg.html('#ch1'), '<rect class="band w"'), tipSaid.filter((r) => /memory pressure/.test(r))], [1, ['warning memory pressure']]);
is('the largest of a very long list is found without handing the list over as arguments', (() => { try { return pg.maxOf(new Array(3000000).fill(1).concat(7), 0); } catch (e) { return e.message; } })(), 7);
is('and of an empty list, the floor', pg.maxOf([], 1), 1);

// names from the bundle are text wherever the Memory tab and the file tree show them
const BAD = '<img src=x onerror=alert(1)>', seen = (text) => [count(text, '<img'), count(text, '&lt;img src=x onerror=alert(1)&gt;') > 0];
const badJetsam = '{"bug_type":"298","timestamp":"2026-03-10 09:01:00.00 -0400"}\n' + JSON.stringify({ largestProcess: BAD, memoryStatus: { pageSize: 16384, memoryPages: { free: 100 } }, processes: [{ name: BAD, pid: 1, rpages: 640, lifetimeMax: 1280, reason: BAD }] }) + '\n';
pg = openPage({ [`${BAD}/memory.txt`]: snapshot.replace('WindowServer', BAD).replace('15G used', BAD), [`${BAD}/excel_footprint.txt`]: footprint.replace('Microsoft Excel [4121]', `${BAD} [4121]`).replace('IOSurface', BAD),
  [`${BAD}/excel_memory_timeline.csv`]: CSV_HEAD + sample(0, 4121, 1) + sample(1, BAD, 2) + sample(2, BAD + '2', 4) + sample(3, '', 1), [`${BAD}/JetsamEvent-2026-03-10-090100.ips`]: badJetsam },
  [{ kind: 'Jetsam', t: Date.UTC(2026, 2, 10, 13, 1, 0), proc: BAD, path: `${BAD}/JetsamEvent-2026-03-10-090100.ips` }, { kind: 'Crash', t: Date.UTC(2026, 2, 10, 13, 2, 0), proc: `Excel ${BAD}`, path: `${BAD}/x.ips` }]);
await pg.loadMemory();
is('a name that is markup, in every memory file and in every path: none of it reaches the Memory tab as markup', [count(pg.html('#memory'), 'could not be drawn'), seen(pg.html('#memory')), count(pg.html('#memory'), '&lt;img src=x onerror=alert(1)&gt;') >= 14], [0, [0, true], true]);
is('nor the charts', ['#ch1', '#ch2', '#ch3', '#ch4'].map((id) => count(pg.html(id), '<img')), [0, 0, 0, 0]);
pg = openPage({ ...MANIFEST, 'system_memory.txt': snapshot }, [], BAD);
await pg.loadMemory();
is('what a file could not be read for is shown as text', [count(pg.html('#memory'), 'Some of it could not be read: &lt;img'), seen(pg.html('#memory'))], [1, [0, true]]);
pg.setMem({ csv: null, foots: [], jets: [], jetCount: 0, ram: NaN, act: null, snaps: [{ t: 0, file: { i: 0, path: 'f' }, level: NaN, swap: NaN, phys: '', get procs() { throw new Error(BAD); } }] });
pg.drawMemory();
is('so is what the tab could not be drawn for', [count(pg.html('#memory'), 'could not be drawn (&lt;img'), seen(pg.html('#memory'))], [1, [0, true]]);

// the file tree
const deep = 'd/'.repeat(30000) + 'f.log';
pg = openPage({ ...MANIFEST, [deep]: 'x', [`${BAD}/"q" ${BAD}.log`]: 'x' });
let treeError = '';
try { pg.buildTree(''); } catch (e) { treeError = e.message; }
is('a path nested 30,000 folders deep: the tree is drawn, with the folders past the fortieth shown as one', [treeError, count(pg.html('#tree'), '<details'), count(pg.html('#tree'), '<span>f.log</span>')], ['', 41, 1]);
is('a folder and a file whose names are markup are shown as text in the tree', [seen(pg.html('#tree')), count(pg.html('#tree'), 'title="&lt;img src=x onerror=alert(1)&gt;/&quot;q&quot; ')], [[0, true], 1]);
pg.buildTree('IMG');
is('and in the list of files that match what was typed', [seen(pg.html('#tree')), count(pg.html('#tree'), '<button')], [[0, true], 1]);

// a file the Markdown reader cannot get through is shown as plain text
const orPlain = (reader) => new Function('esc', 'md', take(/^  const mdOrPlain = .*$/m, 'mdOrPlain') + '\nreturn mdOrPlain;')((s) => String(s).replace(/</g, '&lt;'), reader);
is('when md() fails, the text is shown as it is, as text', (() => { try { return orPlain(() => { throw new Error('made up'); })('# <b>'); } catch (e) { return `threw: ${e.message}`; } })(), '<pre># &lt;b></pre>');
is('when it does not, its drawing is used', orPlain(md)('# a'), '<h3>a</h3>');

// ---- the From and To time boxes ----
// readTime(), renderRange(), setRange(), rangeNote() and rangeTyped() are taken out of src/app.js as they are and run
// against stand-in boxes, with the engine in src/core.js as the page's copy of it. A time with a part that cannot be
// is not used, by the same rules the command-line tool reads times by, and is never rolled over into another time.
{
  let boxSource = null;
  try {
    boxSource = [take(/^  const z2 = .*$/m, 'z2'), take(/^  function offsetAt\(t\) \{[\s\S]*?^  \}$/m, 'offsetAt()'), take(/^  function fmtTime\(t, ms = true\) \{[\s\S]*?^  \}$/m, 'fmtTime()'),
      take(/^  function tzLabel\(t\) \{[\s\S]*?^  \}$/m, 'tzLabel()'), take(/^  const fmtSpan = .*$/m, 'fmtSpan'), take(/^  function readTime\(str\) \{[\s\S]*?^  \}$/m, 'readTime()'),
      take(/^  function renderRange\(\) \{[\s\S]*?^  \}$/m, 'renderRange()'), take(/^  function setRange\(t0, t1\) \{[\s\S]*?^  \}$/m, 'setRange()'),
      take(/^  function rangeNote\(text, bad = \[false, false\]\) \{[\s\S]*?^  \}$/m, 'rangeNote()'), take(/^  async function rangeTyped\(\) \{[\s\S]*?^  \}$/m, 'rangeTyped()')].join('\n');
  } catch (e) { is('the code of the From and To boxes is found in src/app.js', e.message, ''); }
  // A page with the sample's half hour, 13:00 to 13:30 UTC, shown in the logged Mac's zone (UTC-04:00 unless given)
  const openBoxes = ({ zone = [[0, -240]], tz = 'bundle', engine = Core } = {}) => {
    const els = new Map(), wrote = [];
    const box = () => {
      const el = { value: '', textContent: '', hidden: true, disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; } };
      Object.defineProperty(el, 'innerHTML', { get: () => '', set: (v) => { wrote.push(v); } });
      return el;
    };
    const $ = (sel) => { if (!els.has(sel)) els.set(sel, box()); return els.get(sel); };
    const S = { t0: null, t1: null }, info = { t0: Date.UTC(2026, 2, 10, 13, 0, 0), t1: Date.UTC(2026, 2, 10, 13, 30, 0), end: Date.UTC(2026, 2, 10, 13, 30, 0, 1), zone };
    const ran = { schedule: 0 };
    const page = new Function('$', 'S', 'info', 'coreHere', 'coreRan', 'schedule', 'layout', 'setTop', `'use strict'; let tzMode = ${JSON.stringify(tz)}, topRow = 0;\n${boxSource}\nreturn { readTime, renderRange, rangeTyped };`)(
      $, S, info, engine, Promise.resolve(), () => { ran.schedule++; }, () => {}, () => {});
    const note = () => ({ text: $('#tNote').textContent, shown: !$('#tNote').hidden, from: $('#tFrom').attrs['aria-invalid'] || '', to: $('#tTo').attrs['aria-invalid'] || '' });
    const type = async (from, to) => { if (from !== undefined) $('#tFrom').value = from; if (to !== undefined) $('#tTo').value = to; await page.rangeTyped(); return note(); };
    return { ...page, $, S, wrote, ran, note, type };
  };
  if (boxSource) {
    const utc = openBoxes({ tz: 'utc' }), read = (s) => utc.readTime(s);
    is('a time with each part one that can be is read', [read('2026-03-10 09:00:30'), read('2026-03-10T09:00'), read('2026-03-10'), read(' 2028-02-29 10:00:00.5 ')],
      [{ t: Date.UTC(2026, 2, 10, 9, 0, 30) }, { t: Date.UTC(2026, 2, 10, 9, 0, 0) }, { t: Date.UTC(2026, 2, 10) }, { t: Date.UTC(2028, 1, 29, 10, 0, 0, 500) }]);
    is('09:00:99 is not rolled over into 09:01:39: the second is said', read('2026-03-10 09:00:99'), { why: 'the second is 99, and seconds run from 00 to 59' });
    is('2026-13-45 is not rolled over into 2027-02-14: the month and the day are said', read('2026-13-45 10:00'),
      { why: 'the month is 13, and months run from 01 to 12; the day is 45, and no month has more than 31 days' });
    is('30 February is not rolled over into 2 March', read('2026-02-30 10:00'), { why: 'the day is 30, and February 2026 has days 01 to 28' });
    is('day 00, month 00, hour 24 and minute 60 are each said', [read('2026-00-00'), read('2026-03-10 24:00'), read('2026-03-10 23:60:00')].map((r) => r.why),
      ['the month is 00, and months run from 01 to 12; the day is 00, and days run from 01', 'the hour is 24, and hours run from 00 to 23', 'the minute is 60, and minutes run from 00 to 59']);
    is('the page says what the command-line tool says of each part', ['2026-13-45 10:00', '2026-02-30 10:00', '2026-03-10 09:00:99'].map((s) => read(s).why),
      [{ y: '2026', mo: '13', d: '45', h: '10', mi: '00' }, { y: '2026', mo: '02', d: '30', h: '10', mi: '00' }, { y: '2026', mo: '03', d: '10', h: '09', mi: '00', s: '99' }].map((p) => Core.timeBad(p).bad.join('; ')));
    is('the year 0050 is not read as 1950, and times outside 1000-01-02 to 9999-12-30 are not used', [read('0050-06-01 10:00'), read('0999-12-31 23:59:59'), read('9999-12-31 00:00')],
      [{ why: 'it is before 1000-01-02 00:00:00 UTC, the earliest time this page reads' }, { why: 'it is before 1000-01-02 00:00:00 UTC, the earliest time this page reads' }, { why: 'it is after 9999-12-30 23:59:59 UTC, the latest time this page reads' }]);
    is('the first and the last time the tools read are read', [read('1000-01-02 00:00'), read('9999-12-30 23:59:59')], [{ t: Date.UTC(1000, 0, 2) }, { t: Date.UTC(9999, 11, 30, 23, 59, 59) }]);
    is('the span is of the moment, in the zone times are shown in', openBoxes({ zone: [[0, 300]] }).readTime('1000-01-02 03:00').why, 'it is before 1000-01-02 00:00:00 UTC, the earliest time this page reads');
    is('a time in the logged Mac\'s zone is read in it', openBoxes().readTime('2026-03-10 09:00:30'), { t: Date.UTC(2026, 2, 10, 13, 0, 30) });
    is('a time of day alone, or other text, is not a time the boxes read', ['09:00:99', 'yesterday', '2026-03-10 09:00:00.1234'].map((s) => read(s).why),
      new Array(3).fill('it is not written as YYYY-MM-DD HH:MM:SS (the seconds, or the whole time of day, can be left out)'));
    is('when the page\'s copy of the engine has not run, no time is used', openBoxes({ engine: null }).readTime('2026-03-10 09:00'), { why: 'this page could not start the engine that checks a time' });

    // typed into the boxes
    const pg = openBoxes();
    pg.renderRange();
    is('the boxes show the window, with nothing said of them', [pg.$('#tFrom').value, pg.$('#tTo').value, pg.note()], ['2026-03-10 09:00:00', '2026-03-10 09:30:00', { text: '', shown: false, from: '', to: '' }]);
    const still = 'The time window is still 2026-03-10 09:00:00 to 2026-03-10 09:30:00.';
    is('a start of 09:00:99: not used, said beside the boxes, and the window kept', [await pg.type('2026-03-10 09:00:99'), pg.S, pg.ran.schedule, pg.$('#tFrom').value],
      [{ text: `The start time was not used: the second is 99, and seconds run from 00 to 59. ${still}`, shown: true, from: 'true', to: '' }, { t0: null, t1: null }, 0, '2026-03-10 09:00:99']);
    is('an end of 2026-13-45 10:00 as well: each box is said of', await pg.type(undefined, '2026-13-45 10:00'),
      { text: `The start time was not used: the second is 99, and seconds run from 00 to 59. The end time was not used: the month is 13, and months run from 01 to 12; the day is 45, and no month has more than 31 days. ${still}`, shown: true, from: 'true', to: 'true' });
    is('an end of 2026-02-30 10:00, with a start that can be', [await pg.type('2026-03-10 09:05', '2026-02-30 10:00'), pg.S, pg.ran.schedule],
      [{ text: `The end time was not used: the day is 30, and February 2026 has days 01 to 28. ${still}`, shown: true, from: '', to: 'true' }, { t0: null, t1: null }, 0]);
    is('a start that is not before the end', [await pg.type('2026-03-10 09:20', '2026-03-10 09:10'), pg.S, pg.ran.schedule],
      [{ text: `The start time is not before the end time, so neither was used. ${still}`, shown: true, from: 'true', to: 'true' }, { t0: null, t1: null }, 0]);
    is('two times that can be: used, and nothing said', [await pg.type('2026-03-10 09:10', '2026-03-10 09:20:30'), pg.S, pg.ran.schedule],
      [{ text: '', shown: false, from: '', to: '' }, { t0: Date.UTC(2026, 2, 10, 13, 10), t1: Date.UTC(2026, 2, 10, 13, 20, 30) }, 1]);
    pg.renderRange();
    is('and the boxes then show that window', [pg.$('#tFrom').value, pg.$('#tTo').value], ['2026-03-10 09:10:00', '2026-03-10 09:20:30']);
    await pg.type('2026-03-10 09:00:99');
    is('a refusal says the window it kept', pg.note().text, 'The start time was not used: the second is 99, and seconds run from 00 to 59. The time window is still 2026-03-10 09:10:00 to 2026-03-10 09:20:30.');
    pg.renderRange();
    is('when the boxes are written again, the note and the marks go', [pg.$('#tFrom').value, pg.note()], ['2026-03-10 09:10:00', { text: '', shown: false, from: '', to: '' }]);
    const typed = ['<img src=x onerror=alert(1)>', '2026-03-10 09:00‮<b>', '2026-13-45 10:00<script>x</script>', `${'9'.repeat(5000)}`];
    const notes = [];
    for (const t of typed) notes.push((await pg.type(t, '2026-03-10 09:20')).text);
    is('what is typed never reaches the note, and nothing is written into the page as markup', [notes.some((n) => /<|img|script|‮|9{5}/.test(n)), pg.wrote, notes.every((n) => n.startsWith('The start time was not used: it is not written as YYYY-MM-DD HH:MM:SS'))], [false, [], true]);
  }
  is('both boxes are read by rangeTyped() when either changes', /^  for \(const id of \['tFrom', 'tTo'\]\) \$\('#' \+ id\)\.addEventListener\('change', rangeTyped\);$/m.test(source), true);
  const pageHtml = await read('../src/index.html');
  is('the note sits beside the boxes, is read out when it changes, and describes both boxes',
    [/<input id="tTo"[^>]*>\s*<span id="tzNote"><\/span>\s*<button id="zoomOut">Zoom out<\/button>\s*<button id="allTime">All time<\/button>\s*<\/div>\s*<p id="tNote" role="status" hidden><\/p>/.test(pageHtml),
      ['tFrom', 'tTo'].map((id) => new RegExp(`<input id="${id}"[^>]*aria-describedby="tNote"`).test(pageHtml))], [true, [true, true]]);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) (typeof Deno !== 'undefined' ? Deno.exit : process.exit)(1);
