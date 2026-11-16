// Request mode: times read as a clock can be, hints that give back only what this bundle takes, a query counted as the
// engine reads it, and listing columns cut at a whole character.
//
// A small model copies the value a hint gives back and the example a refusal gives, and believes the times a fact
// states. So a time sent under a wrong name is given back only as this bundle reads it, and a time of day with the
// bundle's last day before it is said to be so; a time with a part that cannot be (month 13, minute 99) is refused, not
// rolled over into another day, with an example made from it that is taken; on a bundle whose clock has two offsets,
// every time a sentence states carries its offset, so that a sample at 10:00:00-04:00 does not read as later than one
// at 09:19:00-05:00; a phrase in quotation marks is one term of a query, however many words it holds; and a name cut
// to fit its column ends at a whole character, never inside <U+200B>. Every bundle here is made up.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, it, assert, request, cli, emptyDir, cleanup, sampleBundlesDir, SAMPLE_ID, REPO } from '../harness.mjs';
import { put, LF, z2 } from '../made-up.mjs';

let cacheDir = null;
async function send(dir, op, params = {}) {
  cacheDir ??= await emptyDir('cache');
  const r = await request({ format: 1, op, bundlesDir: await dir, cacheDir, params });
  assert.equal(r.code, 0, `exit status ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.json && typeof r.json === 'object', r.stdout.slice(0, 300));
  return r.json;
}
async function ask(dir, op, params = {}) {
  const d = await send(dir, op, params);
  assert.equal(d.ok, true, `${op} ${JSON.stringify(params)}: ${JSON.stringify(d).slice(0, 400)}`);
  return d;
}
async function bundle(id, write) {
  const dir = await emptyDir('times');
  await write(path.join(dir, id));
  return dir;
}
const sample = () => sampleBundlesDir();
const HEAD = 'local_time\tutc_time\tlevel\tprocess\tpid\tsender\tsubsystem\tcategory\ttags\tmessage';
const row = (local, off, utc, level, msg, tags = 'excel', proc = 'Microsoft Excel') => [`${local}.000000${off}`, `${utc}.000000`, level, proc, '4121', 'AppKit', '', '', tags, msg].join('\t');
// entries on three days, 2026-06-01 to 2026-06-03, on a clock four hours behind UTC
const MULTI = 'Excel_Diagnostics_collect_20260603_120000';
const multi = () => bundle(MULTI, (root) => put(root, 'unified_logs/2026-06-01.tsv', [HEAD, row('2026-06-01 09:00:00', '-0400', '2026-06-01 13:00:00', 'Default', 'first'),
  row('2026-06-02 10:00:00', '-0400', '2026-06-02 14:00:00', 'Error', 'second'), row('2026-06-03 10:00:00', '-0400', '2026-06-03 14:00:00', 'Error', 'third')].join(LF) + LF));
const SPAN_SAID = 'This bundle covers more than one day (2026-06-01 09:00:00 to 2026-06-03 10:00:00), so a time needs a date: any day from 2026-06-01 to 2026-06-03.';
// the values a hint gives back, as the call it offers sends them
const given = (hint) => { const m = /: \{([^}]*)\}\./.exec(hint); return m ? Object.fromEntries([...m[1].matchAll(/(\w+): "([^"]*)"/g)].map((x) => [x[1], x[2]])) : null; };

describe('a time sent under a wrong name is given back only as this bundle reads it', () => {
  it('a time of day, on a bundle of several days, is given back with its last day before it, said so, and the call is taken', async () => {
    const dir = await multi();
    const cases = [['search', { since: '10:00' }, 'from'], ['memory', { at: '10:00' }, 'time'], ['context', { aroundTime: '10:00:00' }, 'time'], ['histogram', { until: '09:30' }, 'to']];
    for (const [op, params, field] of cases) {
      const d = await send(dir, op, params), [[wrong, value]] = Object.entries(params);
      assert.deepEqual(Object.keys(d), ['ok', 'error', 'field', 'hint'], 'the same refusal as one made before the bundle is opened');
      assert.equal(d.hint, `Send ${field} in place of ${wrong}, with this bundle's last day written before the time of day that was sent: {${field}: "2026-06-03 ${value}"}. ${SPAN_SAID} This call did not run.`);
      // the value as it was sent is one the argument refuses here, and the one given back is taken
      assert.equal((await send(dir, op, { [field]: value })).error, `${field} has no date`);
      await ask(dir, op, given(d.hint));
    }
  });

  it('on a bundle of one day a time of day is given back as it was sent, and taken', async () => {
    const d = await send(sample(), 'search', { since: '10:30' });
    assert.equal(d.hint, 'Send from in place of since, with the value that was sent: {from: "10:30"}. This call did not run.');
    await ask(sample(), 'search', given(d.hint));
  });

  it('two times of day are given back together, and neither when to would not be later than from', async () => {
    const dir = await multi();
    const [both, crossed, againstSent] = await Promise.all([send(dir, 'search', { since: '09:00', until: '10:01' }), send(dir, 'search', { since: '10:00', until: '09:00' }),
      send(dir, 'count', { start: '2026-06-03 10:00', to: '2026-06-02' })]);
    assert.equal(both.hint, `Send from in place of since and to in place of until, with this bundle's last day written before the times of day that were sent: {from: "2026-06-03 09:00", to: "2026-06-03 10:01"}. ${SPAN_SAID} This call did not run.`);
    assert.equal((await ask(dir, 'search', given(both.hint))).receipt.matched, 1);
    assert.equal(crossed.hint, 'Send from in place of since, as a time earlier than to, written the way results print times (YYYY-MM-DD HH:MM:SS). Send to in place of until, as a time later than from, written the way results print times (YYYY-MM-DD HH:MM:SS). This call did not run.');
    assert.equal(againstSent.hint, 'Send from in place of start, as a time earlier than to, written the way results print times (YYYY-MM-DD HH:MM:SS). This call did not run.');
    // which is what the call with the value given back would have been refused for
    assert.equal((await send(dir, 'count', { from: '2026-06-03 10:00', to: '2026-06-02' })).error, 'from is not earlier than to');
  });

  it('a time the argument would refuse on this bundle is not given back, and the hint says what it takes', async () => {
    const empty = await bundle('No_entries', (root) => put(root, 'notes/readme.txt', `nothing with a time${LF}`)), dir = await multi();
    const takes = (field, wrong) => `Send ${field} in place of ${wrong}, as a time written the way results print times (YYYY-MM-DD HH:MM:SS). This call did not run.`;
    const [impossible, noDay, elsewhere] = await Promise.all([send(dir, 'search', { since: '2026-13-45 10:00' }), send(empty, 'memory', { at: '10:00' }), send(dir, 'search', { since: '10:00', bundleId: MULTI })]);
    assert.equal(impossible.hint, takes('from', 'since'));
    assert.equal(noDay.hint, takes('time', 'at'));
    assert.equal((await send(empty, 'memory', { time: '10:00' })).error, 'time has no date', 'which the argument refuses there');
    // a wrong name for bundle sends the call offered to the bundle it names, so no time is given back for this one
    assert.equal(elsewhere.hint, `Send bundle in place of bundleId, with the value that was sent: {bundle: "${MULTI}"}. ${takes('from', 'since')}`);
  });
});

describe('a time with a part that cannot be is refused, not rolled over', () => {
  // the sample bundle's entries are all on 2026-03-10, on a clock four hours behind UTC
  const CASES = [
    ['2026-13-45 10:00', 'from has parts out of range', '"2026-13-45 10:00" was sent: the month is 13, and months run from 01 to 12; the day is 45, and no month has more than 31 days. Send from with each part in range, for example "2026-12-31 10:00".'],
    ['2026-02-30', 'from has a part out of range', '"2026-02-30" was sent: the day is 30, and February 2026 has days 01 to 28. Send from with each part in range, for example "2026-02-28".'],
    ['2026-00-00', 'from has parts out of range', '"2026-00-00" was sent: the month is 00, and months run from 01 to 12; the day is 00, and days run from 01. Send from with each part in range, for example "2026-01-01".'],
    ['2026-03-10 24:00:01', 'from has a part out of range', '"2026-03-10 24:00:01" was sent: the hour is 24, and hours run from 00 to 23. Send from with each part in range, for example "2026-03-10 23:00:01".'],
    ['2026-03-10 23:60', 'from has a part out of range', '"2026-03-10 23:60" was sent: the minute is 60, and minutes run from 00 to 59. Send from with each part in range, for example "2026-03-10 23:59".'],
    ['2026-03-10T10:00:60.5', 'from has a part out of range', '"2026-03-10T10:00:60.5" was sent: the second is 60, and seconds run from 00 to 59. Send from with each part in range, for example "2026-03-10T10:00:59.5".'],
    ['10:99', 'from has a part out of range', '"10:99" was sent: the minute is 99, and minutes run from 00 to 59. Send from with each part in range, for example "10:59".'],
    ['2026-03-10 10:00+25:00', 'from has a part out of range', '"2026-03-10 10:00+25:00" was sent: the offset is +25:00, and offsets run from -12:00 to +14:00, with minutes from 00 to 59. Send from with each part in range, for example "2026-03-10 10:00". Without an offset it is read in the logged Mac\'s time zone, UTC-04:00.'],
    ['2026-03-10 10:00 -13:00', 'from has a part out of range', '"2026-03-10 10:00 -13:00" was sent: the offset is -13:00, and offsets run from -12:00 to +14:00, with minutes from 00 to 59. Send from with each part in range, for example "2026-03-10 10:00". Without an offset it is read in the logged Mac\'s time zone, UTC-04:00.'],
    ['2026-03-10 10:00+0575', 'from has a part out of range', '"2026-03-10 10:00+0575" was sent: the offset is +0575, and offsets run from -12:00 to +14:00, with minutes from 00 to 59. Send from with each part in range, for example "2026-03-10 10:00". Without an offset it is read in the logged Mac\'s time zone, UTC-04:00.'],
    ['0050-01-01', 'from is outside the times this tool reads', '"0050-01-01" was sent: it is before 1000-01-02 00:00:00 UTC, the earliest time this tool reads. Send from within the times this tool reads, for example "1000-01-02 00:00:00Z".'],
    ['9999-12-31 10:00', 'from is outside the times this tool reads', '"9999-12-31 10:00" was sent: it is after 9999-12-30 23:59:59 UTC, the latest time this tool reads. Send from within the times this tool reads, for example "9999-12-30 23:59:59Z".'],
  ];

  it(`all ${CASES.length} name what was sent and what cannot be, and the example given is taken`, async () => {
    for (const [value, error, hint] of CASES) {
      const d = await send(sample(), 'search', { from: value });
      assert.deepEqual([d.ok, d.error, d.field, d.hint], [false, error, 'from', hint], value);
      const like = /for example "([^"]+)"/.exec(d.hint)[1];
      assert.equal((await send(sample(), 'search', { from: like, limit: 1 })).ok, true, `the example ${like} is taken`);
    }
  });

  it('what was sent is said with its line breaks written by number, and the example holds none', async () => {
    const d = await send(sample(), 'search', { from: '2026-13-10 10:00\u2028\n -04:00' });
    assert.equal(d.hint, '"2026-13-10 10:00<U+2028>\\n -04:00" was sent: the month is 13, and months run from 01 to 12. Send from with each part in range, for example "2026-12-10 10:00 -04:00".');
    await ask(sample(), 'search', { from: '2026-12-10 10:00 -04:00' });
  });

  it('the times that can be are read as they are: a leap day, the last second of a day, and the widest offsets', async () => {
    const read = async (from) => (await ask(sample(), 'count', { from, by: 'severity' })).receipt.from;
    assert.deepEqual(await Promise.all(['2028-02-29', '2026-03-10 23:59:59', '2026-03-10 10:00+14:00', '2026-03-10 10:00-1200', '1000-01-02 00:00:00Z'].map(read)),
      ['2028-02-29 00:00:00', '2026-03-10 23:59:59', '2026-03-09 16:00:00', '2026-03-10 18:00:00', '1000-01-01 20:00:00']);
  });

  it('on a bundle of several days, the example for a time of day is on its last day, and is taken', async () => {
    const dir = await multi(), d = await send(dir, 'search', { from: '10:99' });
    assert.equal(d.hint, `"10:99" was sent: the minute is 99, and minutes run from 00 to 59. Send from with each part in range, for example "2026-06-03 10:59". ${SPAN_SAID}`);
    await ask(dir, 'search', { from: '2026-06-03 10:59' });
  });

  it('context, memory and aroundTime read times the same way', async () => {
    const [context, memory, around] = await Promise.all([send(sample(), 'context', { time: '2026-03-10 25:00' }), send(sample(), 'memory', { time: '2026-02-30 10:00' }),
      send(sample(), 'search', { aroundTime: '2026-03-10 10:61', window: '1m' })]);
    assert.deepEqual([context.error, memory.error, around.error], ['time has a part out of range', 'time has a part out of range', 'aroundTime has a part out of range']);
    assert.ok(around.hint.endsWith('for example "2026-03-10 10:59".'), around.hint);
  });

  it('the text command line refuses them too, with an example it takes', async () => {
    const at = path.join(await sample(), SAMPLE_ID), r = await cli([at, 'search', '--from', '2026-13-45 10:00']);
    assert.notEqual(r.code, 0);
    assert.ok((r.stdout + r.stderr).includes('--from "2026-13-45 10:00" has parts out of range: the month is 13, and months run from 01 to 12; the day is 45, and no month has more than 31 days. Write it like "2026-12-31 10:00".'), r.stdout + r.stderr);
    assert.equal((await cli([at, 'search', '--from', '2026-12-31 10:00'])).code, 0);
  });
});

describe('on a bundle whose clock has two offsets, each time a sentence states carries its offset', () => {
  // the Mac went from UTC-04:00 to UTC-05:00 between 1 and 3 June; entries tagged memory from 09:08 to 09:12 on the
  // later clock, and memory samples from 14:00 to 14:19 UTC, which straddle the first entry on the later clock
  const twoZones = () => bundle('Excel_Diagnostics_repro_20260603_100000', async (root) => {
    await put(root, 'unified_logs/2026-06-01.tsv', [HEAD, row('2026-06-01 09:00:00', '-0400', '2026-06-01 13:00:00', 'Default', 'before', 'memory', 'kernel'),
      ...[8, 9, 10, 11, 12].map((m) => row(`2026-06-03 09:${z2(m)}:00`, '-0500', `2026-06-03 14:${z2(m)}:00`, 'Default', `memorystatus ${m}`, 'memory', 'kernel'))].join(LF) + LF);
    await put(root, 'excel_memory_timeline.csv', ['local_time,utc_time,excel_pid,free_mb,pressure_level', ...Array.from({ length: 20 }, (_, i) => `2026-06-03 09:${z2(i)}:00,2026-06-03 14:${z2(i)}:00,4121,${4000 - i},1`)].join(LF) + LF);
  });
  const RUNS = 'run from 2026-06-03 10:00:00-04:00 to 2026-06-03 09:19:00-05:00';
  // a time as results print one, with no offset after it
  const bare = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{3})?(?![.\d])(?![+-]\d\d:\d\d)/;

  it('memory says where its samples run with their offsets, so that the time asked is plainly before or after them', async () => {
    const dir = await twoZones();
    const [before, after, none] = await Promise.all([ask(dir, 'memory', { time: '2026-06-03 08:30:00' }), ask(dir, 'memory', { time: '2026-06-03 10:30:00-05:00' }),
      ask(dir, 'memory', { from: '2026-06-01 00:00', to: '2026-06-02' })]);
    assert.deepEqual(before.notes, [`The memory timeline's samples ${RUNS}, so time is before its first sample, and the first 3 samples are listed.`]);
    assert.deepEqual(after.notes, [`The memory timeline's samples ${RUNS}, so time is at or after its last sample, and the last 3 samples are listed.`]);
    assert.deepEqual(none.notes, [`No sample of the memory timeline is in this span. Its samples ${RUNS}.`]);
  });

  it('no fact, hint or Next: sentence states a time without its offset', async () => {
    const dir = await twoZones();
    const said = await Promise.all([send(dir, 'memory', { time: '2026-06-03 08:30:00' }), send(dir, 'context', { time: '2026-06-02 12:00:00', window: '1s' }),
      send(dir, 'search', { from: '2026-06-03 09:10:00-05:00', to: '2026-06-01 10:00' }), send(dir, 'search', { from: '09:00' }), send(dir, 'context', { time: '2026-06-03 09:10:00-05:00', window: '1h', before: 1 }),
      send(dir, 'histogram', {}), send(dir, 'summary'), send(dir, 'search', { since: '09:00' }), send(dir, 'search', { from: '10:99' })]);
    // a call offered sends again the time that was sent as it was sent, and is read as it was; what is checked is what this tool states
    for (const d of said) for (const s of [...(d.notes || []), d.hint || '', (d.next || '').replace(/excel_diag_\w+ \{[^}]*\}/g, '')]) assert.ok(!bare.test(s), s);
    assert.equal(said[1].notes[0], 'The bundle holds no entry within 1 s either side of 2026-06-02 12:00:00-04:00.');
    assert.equal(said[2].hint, 'from was read as 2026-06-03 09:10:00-05:00 and to as 2026-06-01 10:00:00-04:00. Send a from that is earlier than to.');
  });

  // A window cut to the times the tool reads says the ends it was cut to: on this bundle, each with its offset. (The
  // ends of what the tool reads are said in UTC, and say so.)
  it('a window cut to the times the tool reads says the ends it was cut to with their offsets', async () => {
    const dir = await twoZones();
    const said = await Promise.all([ask(dir, 'context', { time: '1000-01-02 00:30Z', window: '1d' }), ask(dir, 'search', { aroundTime: '1000-01-02 00:30Z', window: '1d' })]);
    const reads = '1000-01-02 00:00:00 to 9999-12-30 23:59:59 UTC';
    for (const d of said) {
      assert.ok(d.notes.includes(`The time window reaches past the times this tool reads, ${reads}, so it was cut to 1000-01-01 20:00:00-04:00 to 1000-01-02 20:30:00-04:00.`), JSON.stringify(d.notes));
      for (const s of d.notes) assert.ok(!bare.test(s.replace(reads, '')), s);
    }
  });

  // The example time a refusal gives, of how one is written, is a time of this bundle: said with its offset too
  it('the example time a refusal gives carries its offset, and is taken', async () => {
    const dir = await twoZones();
    const said = await Promise.all([send(dir, 'search', { from: 'yesterday' }), send(dir, 'memory', { time: 5 }), send(dir, 'context', { time: 'noon' })]);
    for (const d of said) {
      assert.equal(d.ok, false);
      assert.ok(d.hint.includes('for example "2026-06-01 09:00:00-04:00"'), d.hint);
      assert.ok(!bare.test(d.hint), d.hint);
    }
    await ask(dir, 'search', { from: '2026-06-01 09:00:00-04:00', limit: 1 });
  });

  it('on a bundle of one offset, times are said as results print them', async () => {
    const d = await ask(sample(), 'memory', { time: '2026-03-10 05:00:00' });
    assert.ok(d.notes.some((n) => /^The memory timeline's samples run from 2026-03-10 \d\d:\d\d:\d\d to 2026-03-10 \d\d:\d\d:\d\d, so time is before its first sample/.test(n)), JSON.stringify(d.notes));
  });
});

describe('a query is bounded by the terms the engine looks for, and by its length', () => {
  const TERMS = 'A term is a word, a phrase in quotation marks, a /regex/ or a field such as process:excel, with a minus before it or not.';

  it('a phrase in quotation marks is one term, however many words it holds', async () => {
    const phrase = `"${'pivot '.repeat(150).trim()}"`, d = await ask(sample(), 'search', { query: phrase, limit: 1 });
    assert.equal(d.receipt.query, phrase);
  });

  it('terms are counted as the engine reads them: words, phrases, regexes, fields and exclusions alike', async () => {
    const four = ['-kernel', 'process:excel', '/piv.t/', '"pivot table filter"'];
    const hundred = Array.from({ length: 25 }, () => four).flat().join(' ');
    assert.equal((await send(sample(), 'search', { query: hundred, limit: 1 })).ok, true);
    const over = await send(sample(), 'search', { query: `${hundred} excel` });
    assert.deepEqual([over.error, over.field, over.hint], ['query has too many terms', 'query', `Send query with at most 100 terms; 101 were sent. ${TERMS}`]);
  });

  it('a query longer than 10,000 characters is refused, counted in characters', async () => {
    const [long, most, wide] = await Promise.all([send(sample(), 'search', { query: 'x'.repeat(10001) }), send(sample(), 'search', { query: 'x'.repeat(10000), limit: 1 }),
      send(sample(), 'search', { query: '\u{1F600}'.repeat(5001), limit: 1 })]);
    assert.deepEqual([long.error, long.hint], ['query is too long', 'Send query with at most 10,000 characters; 10,001 were sent.']);
    assert.equal(most.ok, true);
    assert.equal(wide.ok, true, 'an emoji is one character, though two in UTF-16');
  });

  it('both READMEs give the limits the tool applies', async () => {
    const [terms, chars] = await Promise.all([send(sample(), 'search', { query: 'a '.repeat(101) }), send(sample(), 'search', { query: 'x'.repeat(10001) })]);
    const [within, past] = await Promise.all([send(sample(), 'search', { query: '/a{2000}/', limit: 1 }), send(sample(), 'search', { query: '/a{2001}/', limit: 1 })]);
    assert.deepEqual([within.notes.some((n) => /more than 2000 steps/.test(n)), past.notes.some((n) => /more than 2000 steps/.test(n))], [false, true]);
    const most = [/at most (\d+) terms/.exec(terms.hint)[1], /at most ([\d,]+) characters/.exec(chars.hint)[1]];
    for (const doc of ['README.md', 'openclaw/README.md']) {
      const text = (await fs.readFile(path.join(REPO, doc), 'utf8')).replace(/\s+/g, ' ');
      assert.ok(text.includes(`at most ${most[0]} terms and ${most[1]} characters`), `${doc} gives ${most.join(' and ')}`);
      // what is left out, and the figure the tool goes by: a pattern of 2,000 steps is searched and one of 2,001 is not
      for (const words of ['look-ahead', 'back-reference', 'more than 2,000 steps']) assert.ok(text.includes(words), `${doc} says a /regex/ with a ${words} is left out`);
    }
  });
});

describe('a listing cuts its LEVEL, SOURCE and PROCESS columns at a whole character', () => {
  // a level, a process and a log whose names hold a zero-width space, which is written by its number, <U+200B>, right
  // where each column is cut; and a process whose name fits its column with it written whole
  const LONG = 'Long_names', ZW = '\u200b';
  const names = () => bundle(LONG, async (root) => {
    await put(root, 'unified_logs/2026-03-10.tsv', [HEAD, row('2026-03-10 09:00:00', '-0400', '2026-03-10 13:00:00', `${'E'.repeat(19)}${ZW}x`, 'hello', '', `${'A'.repeat(28)}${ZW}tail`),
      row('2026-03-10 09:00:02', '-0400', '2026-03-10 13:00:02', 'Default', 'fits', '', `${'B'.repeat(19)}${ZW}b`)].join(LF) + LF);
    await put(root, `logs/${'S'.repeat(28)}${ZW}x.log`, `2026-03-10T13:00:01Z error hello there${LF}`);
  });
  const check = (lines) => {
    const [first, log, fits] = ['  hello', ' hello there', '  fits'].map((m) => lines.find((l) => l.endsWith(m)));
    assert.ok(first.includes(`  ${'E'.repeat(19)}~  `) && first.includes(`  ${'A'.repeat(28)}~  `), first);
    assert.ok(log.includes(`  ${'S'.repeat(28)}~  `), log);
    assert.ok(fits.includes(`  ${'B'.repeat(19)}<U+200B>b[4121]  `), fits);
    for (const l of [first, log]) assert.ok(!/<U\+(?!200B>)|<U\+200B>(?!b)/.test(l), `no character written by its number is cut through: ${l}`);
  };

  it('in search and context results, and at the terminal', async () => {
    const dir = await names();
    const [search, context] = await Promise.all([ask(dir, 'search', {}), ask(dir, 'context', { id: 1 })]);
    check(search.text.split(LF));
    check(context.text.split(LF));
    const text = await cli([path.join(dir, LONG), 'search']);
    assert.equal(text.code, 0, text.stderr);
    check(text.stdout.split(LF));
  });

  it('in the list of log sources the text summary gives', async () => {
    const dir = await names(), r = await cli([path.join(dir, LONG)]);
    assert.ok(r.stdout.split(LF).some((l) => l.includes(`  ${'S'.repeat(28)}~  `)), r.stdout);
    assert.ok(!r.stdout.split(LF).some((l) => /S~|<U\+2(?!00B>)/.test(l) && !l.includes(`${'S'.repeat(28)}~`)), r.stdout);
  });

  it('cleanup', async () => { await cleanup(); });
});
