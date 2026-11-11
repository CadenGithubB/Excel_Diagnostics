// What SKILL.md says about results, held against results from the real program on the sample bundle.
//
// The page tells a small model what it will be shown and what to do with it: the parts of a result and their
// order, the column an id or a path is copied from, the field that says more exists and the field to send to get
// it, and what each refusal means. The model acts on those sentences and does not check them. A field the page
// names that no result carries, or a step the tool refuses as written, walks it into the stop rule on a healthy
// bundle. So the statements are run: every field and column the page names must turn up in a real result, each
// procedure must work step by step with values copied from the step before, each signal in the closing bullets
// must be what the tools send, and a field shown without "?" must be the one a tool will not go without.
import { promises as fs } from 'node:fs';
import { describe, it, assert, loadPlugin, blocks, cleanup, SKILL_PATH, SAMPLE_ID } from '../harness.mjs';

const TIME = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const PROCEDURES = ['Look at a bundle for the first time', 'Follow up a crash or hang report', 'Look at a time the human names'];

// One plugin for the whole file, and each distinct call made once: the specs share results the way a model does.
let loaded = null;
const plugin = () => (loaded ??= loadPlugin());
const made = new Map();
function call(tool, params = {}) {
  const key = `${tool} ${JSON.stringify(params)}`;
  if (!made.has(key)) made.set(key, plugin().then((p) => p.raw.get(tool)(params)));
  return made.get(key);
}
const details = async (tool, params) => (await call(tool, params)).details;
// A result as the page describes it: the facts, the JSON line, the lines and the Next paragraph, each or null.
function parts(envelope) {
  const b = blocks(envelope), out = { facts: null, json: null, lines: null, next: null };
  let i = 0;
  if (b[i]?.startsWith('Facts about this call:\n')) out.facts = b[i++];
  out.json = b[i++] ?? null;
  if (i < b.length && !b[i].startsWith('Next: ')) out.lines = b[i++];
  if (i < b.length && b[i].startsWith('Next: ')) out.next = b[i++];
  assert.equal(i, b.length, 'a result has no part the page does not describe');
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
// The table's fields for each tool, as written (with or without "?"), and the clause after them.
function tableRows(s) {
  return new Map([...s.section.get('Tools and limits').matchAll(/^\| `(excel_diag_\w+)` \| `\{([^}]*)\}` — (.+) \|$/gm)].map((m) => [m[1], { fields: m[2].split(',').map((f) => f.trim()), clause: m[3] }]));
}
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
    const envelope = await call('excel_diag_search', { q: 'pivot', limit: 2 }), b = blocks(envelope), p = parts(envelope);
    assert.equal(b.length, 4);
    assert.match(p.facts, /^Facts about this call:\n- Fact: \S/);
    assert.deepEqual(JSON.parse(p.json), envelope.details);
    assert.ok(!p.json.includes('\n'), 'one JSON line');
    assert.deepEqual(Object.keys(envelope.details).slice(0, 3), ['ok', 'tool', 'bundle'], 'the page: `ok`, `tool`, `bundle`, then what was understood and counted');
    assert.deepEqual(p.lines.split('\n')[0].trim().split(/\s{2,}/), ['ID', 'TIME', 'LEVEL', 'SOURCE', 'PROCESS[PID]', 'MESSAGE'], 'a list has a line that names its columns');
    assert.match(p.next, /^Next: excel_diag_\w+ \{/);
    assert.equal(b[3], p.next, 'Next is the last thing read');
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
    const results = await Promise.all([
      details('excel_diag_summary', {}), details('excel_diag_search', { minSeverity: 'error' }), details('excel_diag_search', { query: 'zzzqqq pivot' }),
      details('excel_diag_search', { q: 'pivot', limit: 2 }), details('excel_diag_read_file', { path: 'summary.md', limit: 2 }), details('excel_diag_histogram', {}),
      details('excel_diag_show', {}), details('excel_diag_read_file', { path: 'ips' }),
    ]);
    const known = new Set(['args', ...mod.TOOLS.flatMap((t) => Object.keys(t.parameters.properties)), ...results.flatMap((r) => Object.keys(r))]);
    const named = [...new Set(spans(s.body).map((span) => span.match(/^([a-z][A-Za-z]*)(?:: .+)?$/)?.[1]).filter((name) => name && name !== 'true' && name !== 'false'))];
    assert.ok(named.length >= 25, `the page names fields: ${named.join(', ')}`);
    for (const name of named) assert.ok(known.has(name), `SKILL.md names \`${name}\`, which is not an argument of any tool and was in none of these results`);
  });

  it('a field the page shows with a value has that value in a real result', async () => {
    const s = await skill();
    const results = await Promise.all([details('excel_diag_search', { minSeverity: 'error' }), details('excel_diag_search', { query: 'zzzqqq pivot' }), details('excel_diag_show', {}),
      details('excel_diag_search', { bundle: 'no-such-bundle' }), details('excel_diag_count', { minSeverity: 'error', by: 'process' })]);
    // From "Reading results" on, a name with a value is something a result says (or says back), not a step to take.
    const after = s.body.slice(s.body.indexOf('## Reading results'));
    const shown = [...new Set(spans(after).filter((span) => /^[a-z][A-Za-z]*: /.test(span)))];
    assert.deepEqual(shown.sort(), ['by: "process"', 'field: "bundle"', 'matched: 0', 'ok: false', 'truncated: true']);
    for (const span of shown) {
      const key = span.slice(0, span.indexOf(':')), value = JSON.parse(span.slice(span.indexOf(':') + 2));
      assert.ok(results.some((r) => r[key] === value), `no result here has ${span}`);
    }
  });

  it('the columns the page says to copy from are printed by the tools it names', async () => {
    const s = await skill();
    assert.deepEqual([...new Set(s.flat.match(/\b[A-Z]{2,}(?= column| or [A-Z]+ column)/g))].sort(), ['FILE', 'ID', 'PATH', 'TIME']);
    const [search, context, reports, files] = await Promise.all([header('excel_diag_search', { minSeverity: 'error' }), header('excel_diag_context', { id: 139 }), header('excel_diag_reports', {}), header('excel_diag_files', {})]);
    assert.equal(search[0], 'ID');
    assert.equal(context[0], 'ID');
    assert.ok(reports.includes('TIME') && reports.includes('FILE'), reports.join(' '));
    assert.ok(files.includes('PATH'), files.join(' '));
  });

  it('the wrapper example in the page is a call that works', async () => {
    const s = await skill(), p = await plugin();
    const m = s.flat.match(/`\{id: "(excel_diag_\w+)", args: (\{[^}]+\})\}`/);
    const args = JSON.parse(m[2].replace(/(\w+):/g, '"$1":'));
    const d = await details(m[1], args);
    assert.equal(d.ok, true);
    assert.equal(d.tool, m[1]);
    for (const [key, value] of Object.entries(args)) assert.equal(d[key], value, 'the result says back how the call was read');
    assert.equal(await p.hook({ toolName: 'tool_call', params: { id: m[1], args } }, {}), undefined, 'and the wrapper is not refused');
  });
});

describe('skill and results: the procedures run as written', () => {
  it('looking at a bundle for the first time: summarise, search, count, look around', async () => {
    const summary = await details('excel_diag_summary', {});
    assert.equal(summary.ok, true);
    assert.match(summary.period.from, TIME);
    assert.match(summary.period.to, TIME);
    assert.ok(Object.keys(summary.bySeverity).length > 0, 'the counts by severity');

    const found = await details('excel_diag_search', { minSeverity: 'error' });
    assert.equal(found.ok, true);
    assert.ok(found.matched > found.shown.last, 'far more match than one call lists');

    const counted = await details('excel_diag_count', { minSeverity: 'error', by: 'process' });
    assert.equal(counted.ok, true);
    assert.equal(counted.matched, found.matched, 'the same filters count the same entries');
    assert.ok(counted.values.length > 0 && counted.values[0].entries <= counted.matched);

    const id = Number((await rows('excel_diag_search', { minSeverity: 'error' }))[0][0]);
    const around = await call('excel_diag_context', { id });
    assert.equal(around.details.ok, true);
    assert.equal(around.details.anchorId, id);
    assert.ok(parts(around).lines.split('\n').some((l) => l.trim().startsWith(`>${id} `)), 'the entry asked about is marked');
  });

  it('following up a crash or hang report: list, read, look around', async () => {
    const listed = await details('excel_diag_reports', {});
    assert.equal(listed.ok, true);
    const head = await header('excel_diag_reports', {}), table = await rows('excel_diag_reports', {});
    assert.equal(table.length, listed.shown, 'one line per report file');
    const newest = table[table.length - 1], file = newest[head.indexOf('FILE')], time = newest[head.indexOf('TIME')];
    assert.match(time, TIME);

    const read = await details('excel_diag_read_file', { path: file });
    assert.equal(read.ok, true);
    assert.equal(read.path, file);
    assert.ok(read.lines > 0);

    const around = await details('excel_diag_context', { time, window: '1m' });
    assert.equal(around.ok, true);
    assert.ok(around.entries > 0);
    assert.ok(around.anchorTime >= time, 'the anchor is the first entry at or after the time');
  });

  it('looking at a time the human names: the date from period, a time from another zone, a longer span', async () => {
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
    assert.equal(utc.anchorTime, local.anchorTime, 'and the result is still printed on the clock it names');

    const from = onClock(stamp, 0, -1), to = onClock(stamp, 0, 1);
    const span = await details('excel_diag_search', { from, to, minSeverity: 'error' });
    assert.equal(span.ok, true);
    assert.equal(span.from, from);
    assert.equal(span.to, to);
    assert.ok(span.matched > 0 && span.matched < span.total);
  });

  it('each step of each procedure was run above with the tool and the arguments the page gives', async () => {
    // If a step is added or changed in the page, this fails until the specs above run it.
    const s = await skill();
    const stepsOf = (heading) => s.section.get(heading).replace(/\n {3}/g, ' ').split('\n').filter((l) => /^\d+\. /.test(l))
      .map((l) => [l.match(/excel_diag_\w+/)[0], spans(l).map((x) => x.match(/^([a-z][A-Za-z]*)(?:: .+)?$/)?.[1]).filter((x) => x && !['period', 'timeZone'].includes(x)).sort().join(' ')]);
    assert.deepEqual(PROCEDURES.map(stepsOf), [
      [['excel_diag_summary', ''], ['excel_diag_search', 'minSeverity query'], ['excel_diag_count', 'by'], ['excel_diag_context', 'id']],
      [['excel_diag_reports', ''], ['excel_diag_read_file', 'path'], ['excel_diag_context', 'time window']],
      [['excel_diag_summary', ''], ['excel_diag_context', 'time'], ['excel_diag_search', 'from minSeverity query to']],
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
    const [wrong, right] = await Promise.all([call('excel_diag_search', { q: 'pivot', limit: 2 }), details('excel_diag_search', { query: 'pivot' })]);
    assert.deepEqual(wrong.details.ignoredFields, ['q']);
    assert.deepEqual(wrong.details.allowedFields, Object.keys(mod.TOOLS.find((t) => t.name === 'excel_diag_search').parameters.properties));
    assert.equal(wrong.details.matched, wrong.details.total, 'every entry matched: the result is not filtered');
    assert.ok(parts(wrong).facts.includes('q is not a field of excel_diag_search and was ignored'), 'the first fact says so');
    assert.ok(wrong.details.allowedFields.includes('query') && right.matched < right.total, 'a name from allowedFields narrows');
  });

  it('a wrong bundle id is answered with field bundle and the ids there are', async () => {
    const d = await details('excel_diag_search', { bundle: 'no-such-bundle' });
    assert.equal(d.ok, false);
    assert.equal(d.field, 'bundle');
    assert.ok(d.hint.includes(SAMPLE_ID), 'the hint lists an id to send instead');
    assert.equal((await details('excel_diag_summary', {})).availableBundles[0], SAMPLE_ID, 'the same id availableBundles gives');
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
  it('a tool called with {} runs when its row marks every field optional, and names the field when one is not', async () => {
    const table = tableRows(await skill());
    assert.equal(table.size, 10);
    const answers = await Promise.all([...table.keys()].map((tool) => details(tool, {})));
    [...table].forEach(([tool, row], i) => {
      const d = answers[i], required = row.fields.filter((f) => !f.endsWith('?'));
      if (required.length) {
        assert.equal(required.length, 1, tool);
        assert.equal(d.ok, false, `${tool} shows ${required[0]} without "?", so it must not run without it`);
        assert.equal(d.field, required[0]);
        assert.equal(d.error, `${required[0]} is missing`);
      } else if (d.ok === false) {
        // No single field is required, but one of two is: the row must say so, in words.
        const m = d.error.match(/^(\w+) or (\w+) is missing$/);
        assert.ok(m, `${tool} marks every field optional but refuses {}: ${d.error}`);
        assert.ok(row.fields.includes(`${m[1]}?`) && row.fields.includes(`${m[2]}?`));
        assert.ok(row.clause.includes(`\`${m[1]}\``) && row.clause.includes(`\`${m[2]}\``) && row.clause.includes('send one of the two'), `${tool}: ${row.clause}`);
      } else assert.equal(d.ok, true, `${tool} runs with no arguments`);
    });
    assert.deepEqual([...table].filter(([, row]) => row.fields.some((f) => !f.endsWith('?'))).map(([tool]) => tool), ['excel_diag_show', 'excel_diag_read_file']);
  });

  it('cleanup', async () => { await cleanup(); });
});
