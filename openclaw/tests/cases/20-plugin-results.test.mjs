// What a tool call hands back, on the real command-line tool and the sample bundle.
//
// The model sees the content blocks and nothing else. A result that is not { content: [...], details } never
// reaches it: the host's wrapper for deferred tools refuses it, the model is shown the wrapper's complaint, and it
// sends the same correct call again. So every path here is checked for that shape first.
//
// The order of the blocks is the dialog with a small model. How its call was read comes first ("Facts about this
// call:"), then one JSON line of facts, then the quoted lines as plain text, and "Next:" last, where it is the
// last thing read before the model's own turn. A failure is one JSON line. A name the tool does not declare is
// said back (ignoredFields), because a guessed argument name that silently changes nothing reads as a filtered
// result. And no block may show a path on the host: the model cannot open one, and it tries.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { describe, it, assert, loadPlugin, sampleBundlesDir, emptyDir, cleanup, blocks, exists, SAMPLE_ID } from '../harness.mjs';

const REPLY = 'If this answers the question, reply now.';
const FACTS = 'Facts about this call:';
const CRASH_REPORT = 'reports/user_Library_Logs_DiagnosticReports/Microsoft Excel-2026-03-10-103500.ips';
const DITTO = '/usr/bin/ditto';                           // what the collector zips a bundle with; macOS only
const NO_DITTO = (await exists(DITTO)) ? undefined : 'needs /usr/bin/ditto, which only macOS has';
const zip = (folder, to) => new Promise((resolve, reject) => execFile(DITTO, ['-c', '-k', '--keepParent', folder, to], (err) => (err ? reject(err) : resolve())));

let loaded = null;
// One plugin over the sample bundle for the whole file, with the state folder it was loaded under.
async function sample() {
  if (!loaded) {
    const p = await loadPlugin();
    loaded = { p, hidden: [p.bundlesDir, process.env.OPENCLAW_STATE_DIR, os.homedir(), os.tmpdir()] };
  }
  return loaded;
}

// What holds of every result, success or failure.
function checkEnvelope(env, tool, hidden) {
  assert.ok(env && typeof env === 'object' && !Array.isArray(env), 'the result is an object');
  assert.ok(Array.isArray(env.content) && env.content.length >= 1, 'content is a list of blocks');
  for (const b of env.content) {
    assert.deepEqual(Object.keys(b), ['type', 'text']);
    assert.equal(b.type, 'text');
    assert.ok(typeof b.text === 'string' && b.text.length > 0, 'no block is empty');
  }
  assert.ok(env.details && typeof env.details === 'object' && !Array.isArray(env.details), 'details is an object');
  assert.equal(env.details.tool, tool);
  assert.equal(typeof env.details.ok, 'boolean');
  for (const dir of hidden) {
    assert.ok(dir && dir.length > 1, 'a folder to look for');
    for (const text of blocks(env)) assert.ok(!text.includes(dir), `a path of this machine is in a content block: ${dir}`);
    assert.ok(!JSON.stringify(env.details).includes(dir), `a path of this machine is in details: ${dir}`);
  }
}

// A success: [facts], the JSON line that is details, [the lines], [Next:], in that order and nothing else.
function checkSuccess(env, { facts, text, next }) {
  assert.deepEqual(Object.keys(env), ['content', 'details'], 'a success has no isError');
  assert.equal(env.details.ok, true);
  const b = blocks(env);
  let i = 0;
  if (facts) {
    const lines = b[i++].split('\n');
    assert.equal(lines[0], FACTS);
    assert.ok(lines.length >= 2 && lines.slice(1).every((l) => l.startsWith('- Fact: ') && l.length > 8), b[0]);
  }
  const json = b[i++];
  assert.ok(json.startsWith(`{"ok":true,"tool":"${env.details.tool}","bundle":"${SAMPLE_ID}"`), `the JSON line starts with ok, tool and bundle: ${json.slice(0, 80)}`);
  assert.ok(!json.includes('\n'), 'the JSON line is one line');
  assert.deepEqual(JSON.parse(json), env.details, 'details is the object of the JSON line');
  if (text) {
    assert.ok(typeof b[i] === 'string' && !b[i].startsWith('{') && !b[i].startsWith('Next: ') && !b[i].startsWith(FACTS), `the lines are plain text: ${String(b[i]).slice(0, 60)}`);
    i++;
  }
  if (next) {
    assert.ok(typeof b[i] === 'string' && b[i].startsWith('Next: excel_diag_'), `Next: names a tool to call: ${String(b[i]).slice(0, 60)}`);
    assert.ok(b[i].endsWith(REPLY), 'Next: ends by allowing a reply');
    assert.equal(i, b.length - 1, 'Next: is the last block');
    i++;
  }
  assert.equal(b.length, i, `${b.length} blocks where ${i} were expected: ${b.map((x) => x.slice(0, 30)).join(' | ')}`);
  assert.equal(b.filter((x) => x.startsWith('Next: ')).length, next ? 1 : 0);
  assert.equal(b.filter((x) => x.startsWith(FACTS)).length, facts ? 1 : 0);
}

// A failure: one JSON line that is details, and isError.
function checkFailure(env) {
  assert.deepEqual(Object.keys(env), ['content', 'details', 'isError']);
  assert.equal(env.isError, true);
  assert.equal(env.details.ok, false);
  assert.equal(env.content.length, 1, 'a failure is one block');
  const json = blocks(env)[0];
  assert.ok(json.startsWith(`{"ok":false,"tool":"${env.details.tool}"`), json.slice(0, 80));
  assert.deepEqual(JSON.parse(json), env.details, 'details is the object of the JSON line');
  assert.ok(typeof env.details.error === 'string' && env.details.error.length > 0);
}

async function call(tool, params) {
  const { p, hidden } = await sample();
  const env = await p.raw.get(tool)(params);
  checkEnvelope(env, tool, hidden);
  return env;
}
async function ok(tool, params, shape) {
  const env = await call(tool, params);
  checkSuccess(env, shape);
  return env;
}
async function refused(tool, params) {
  const env = await call(tool, params);
  checkFailure(env);
  return env;
}

describe('plugin results: each tool on the sample bundle', () => {
  it('excel_diag_summary: the JSON line, one line per log source, then Next:', async () => {
    const env = await ok('excel_diag_summary', {}, { text: true, next: true });
    const d = env.details;
    assert.deepEqual(Object.keys(d).slice(0, 3), ['ok', 'tool', 'bundle']);
    assert.equal(d.bundle, SAMPLE_ID);
    assert.equal(d.entries, 32861);
    assert.deepEqual(d.period, { from: '2026-03-10 09:00:00', to: '2026-03-10 11:59:59' });
    assert.deepEqual(d.availableBundles, [SAMPLE_ID]);
    const b = blocks(env);
    assert.match(b[1].split('\n')[0], /^\s*ENTRIES\s+SOURCE\s+FIRST\s+LAST\s+FILE$/);
    assert.ok(b[2].includes('excel_diag_search {minSeverity: "error"}') && b[2].includes('excel_diag_reports {}'), b[2]);
  });

  it('excel_diag_search: entries as plain lines, with ids the next call can copy', async () => {
    const env = await ok('excel_diag_search', { query: 'crash' }, { text: true, next: true });
    assert.equal(env.details.query, 'crash');
    assert.equal(env.details.matched, 3);
    assert.equal(env.details.total, 32861);
    assert.equal(env.details.truncated, false);
    const lines = blocks(env)[1].split('\n');
    assert.match(lines[0], /^\s*ID\s+TIME\s+LEVEL\s+SOURCE\s+PROCESS\[PID\]\s+MESSAGE$/);
    assert.equal(lines.length, 4, 'a heading and the three matches');
    assert.match(lines[1], /^19089  2026-03-10 10:35:00\.000  /);
    assert.ok(blocks(env)[2].includes('excel_diag_context {id: 19089}'), 'Next: uses an id from this result');
  });

  it('excel_diag_count: facts only, no lines', async () => {
    const env = await ok('excel_diag_count', { by: 'process', limit: 3 }, { next: true });
    assert.equal(env.details.by, 'process');
    assert.deepEqual(env.details.values[0], { value: 'Microsoft Excel', entries: 18561 });
    assert.equal(env.details.moreValues, 11);
    assert.equal(env.content.length, 2);
  });

  it('excel_diag_histogram: one line per interval', async () => {
    const env = await ok('excel_diag_histogram', { bins: 6 }, { text: true, next: true });
    assert.equal(env.details.intervals, 6);
    assert.deepEqual(env.details.fullest, { from: '2026-03-10 10:30:00', to: '2026-03-10 11:00:00', entries: 8150 });
    assert.match(blocks(env)[1], /^ERRORS counts errors and faults\.\nSTART\s+ENTRIES\s+ERRORS\s+WARNINGS\n/);
  });

  it('excel_diag_show: the fields as JSON and the message as plain text', async () => {
    const env = await ok('excel_diag_show', { id: 15501 }, { text: true, next: true });
    assert.equal(env.details.id, 15501);
    assert.equal(env.details.process, 'Microsoft Excel');
    assert.equal(env.details.truncated, false);
    assert.equal(blocks(env)[1], 'PivotCache: could not grow record buffer to 7 GB (out of memory), retrying with a smaller block');
    assert.ok(!JSON.stringify(env.details).includes('PivotCache'), 'the message is not also put inside the JSON line');
  });

  it('excel_diag_context: the anchor entry is marked', async () => {
    const env = await ok('excel_diag_context', { id: 15501, before: 2, after: 2 }, { text: true, next: true });
    assert.equal(env.details.anchorId, 15501);
    assert.deepEqual(env.details.shown, { firstId: 15499, lastId: 15503 });
    const lines = blocks(env)[1].split('\n');
    assert.equal(lines.length, 6);
    assert.equal(lines.filter((l) => l.startsWith('>')).length, 1);
    assert.ok(lines[3].startsWith('>15501  '), lines[3]);
  });

  it('excel_diag_reports: one line per report file, with the path to read it by', async () => {
    const env = await ok('excel_diag_reports', {}, { text: true, next: true });
    assert.equal(env.details.reports, 2);
    assert.deepEqual(env.details.byKind, { Jetsam: 1, Crash: 1 });
    assert.match(blocks(env)[1].split('\n')[0], /^TIME\s+KIND\s+PROCESS\s+FILE$/);
    assert.ok(blocks(env)[1].includes(CRASH_REPORT));
    assert.ok(blocks(env)[2].includes(`excel_diag_read_file {path: "${CRASH_REPORT}"}`));
  });

  it('excel_diag_files: a cut list says so and gives the offset to go on from', async () => {
    const env = await ok('excel_diag_files', { limit: 5 }, { text: true, next: true });
    assert.equal(env.details.files, 15);
    assert.equal(env.details.truncated, true);
    assert.equal(env.details.nextOffset, 5);
    assert.match(blocks(env)[1].split('\n')[0], /^\s*SIZE\s+TIMELINE_ENTRIES\s+PATH$/);
    assert.equal(blocks(env)[1].split('\n').length, 6);
  });

  it('excel_diag_read_file: the lines as they are in the file', async () => {
    const env = await ok('excel_diag_read_file', { path: 'summary.md', limit: 5 }, { text: true, next: true });
    assert.equal(env.details.path, 'summary.md');
    assert.deepEqual(env.details.shown, { fromLine: 1, toLine: 5 });
    assert.equal(env.details.nextFromLine, 6);
    assert.equal(blocks(env)[1].split('\n')[0], '# Excel diagnostics summary');
  });

  it('excel_diag_memory: figures only, no lines', async () => {
    const env = await ok('excel_diag_memory', {}, { next: true });
    assert.equal(env.details.files[0].kind, 'timeline');
    assert.equal(env.details.timeline.samples, 360);
    assert.equal(env.details.memoryEntries, 2856);
    assert.equal(env.content.length, 2);
  });

  it('every tool answers {} with an envelope, a success or a refusal that names the argument', async () => {
    const { p } = await sample();
    assert.equal(p.raw.size, 10);
    for (const tool of p.raw.keys()) {
      const env = await call(tool, {});
      if (env.details.ok) {
        const b = blocks(env);
        assert.ok(b[b.length - 1].startsWith('Next: '), `${tool}: Next: is last`);
        assert.equal(env.isError, undefined);
      } else {
        checkFailure(env);
        assert.ok(['id', 'path'].includes(env.details.field), `${tool} refused {} for ${env.details.field}`);
        assert.ok(env.details.hint.includes('excel_diag_'), 'the hint names the tool the value comes from');
      }
    }
  });
});

describe('plugin results: notes, nothing found, refusals', () => {
  it('a note from the program comes first, as a fact', async () => {
    const env = await ok('excel_diag_search', { query: 'crash', bundle: 'sample' }, { facts: true, text: true, next: true });
    assert.equal(blocks(env)[0], `${FACTS}\n- Fact: bundle "sample" was read as ${SAMPLE_ID}.`);
    assert.equal(env.details.notes, undefined, 'the notes are said once, in their own block');
  });

  it('several notes are one block, one line each, in the order the program gave them', async () => {
    const env = await ok('excel_diag_search', { query: 'crash', bundle: 'sample', limit: 500 }, { facts: true, text: true, next: true });
    assert.deepEqual(blocks(env)[0].split('\n'), [
      FACTS,
      `- Fact: bundle "sample" was read as ${SAMPLE_ID}.`,
      '- Fact: limit 500 is more than this tool returns in one call; 80 was used.',
    ]);
  });

  it('nothing found is a success, not an error', async () => {
    const env = await ok('excel_diag_search', { query: 'zzzznothing', minSeverity: 'error' }, { next: true });
    assert.equal(env.details.matched, 0);
    assert.equal(env.details.total, 32861);
    assert.deepEqual(env.details.withoutEach, [{ without: 'minSeverity', matched: 0 }, { without: 'the query term zzzznothing', matched: 1060 }]);
    assert.equal(env.isError, undefined);
  });

  it('a refusal is one JSON line with the error, the field and the hint, and isError', async () => {
    const missing = await refused('excel_diag_show', {});
    assert.deepEqual(Object.keys(missing.details), ['ok', 'tool', 'bundle', 'error', 'field', 'hint']);
    assert.equal(missing.details.error, 'id is missing');
    assert.equal(missing.details.field, 'id');
    assert.ok(missing.details.hint.includes('ID column of excel_diag_search'));

    const none = await refused('excel_diag_show', { id: 99999 });
    assert.equal(none.details.error, 'no such entry');
    assert.ok(none.details.hint.includes('from 0 to 32860'));

    const bundle = await refused('excel_diag_summary', { bundle: 'no-such-bundle' });
    assert.equal(bundle.details.field, 'bundle');
    assert.equal(bundle.details.bundle, undefined, 'no bundle was opened, so none is named');
    assert.ok(bundle.details.hint.includes(SAMPLE_ID), 'the hint lists the ids there are');
  });

  it('candidates are passed on when a name fits more than one thing', async () => {
    const env = await refused('excel_diag_read_file', { path: '.ips' });
    assert.equal(env.details.field, 'path');
    assert.equal(env.details.candidates.length, 2);
    assert.ok(env.details.candidates.includes(CRASH_REPORT));
  });

  it('arguments are not checked or repaired here: they reach the program as they were sent', async () => {
    const text = await refused('excel_diag_search', { limit: '5' });
    assert.equal(text.details.error, 'limit must be a whole number');
    assert.equal(text.details.field, 'limit');
    const flag = await refused('excel_diag_search', { newest: 'true' });
    assert.equal(flag.details.field, 'newest');
    const lowered = await ok('excel_diag_files', { limit: 500 }, { facts: true, text: true, next: true });
    assert.ok(blocks(lowered)[0].includes('limit 500 is more than this tool returns in one call'));
  });
});

describe('plugin results: undeclared argument names', () => {
  it('the call still runs, and the name is said back first with the names that are allowed', async () => {
    const { p } = await sample();
    const env = await ok('excel_diag_search', { q: 'crash', limit: 2 }, { facts: true, text: true, next: true });
    assert.equal(blocks(env)[0], `${FACTS}\n- Fact: q is not a field of excel_diag_search and was ignored, so this result is not narrowed by it. Send the call again with one of the allowed fields if it mattered.`);
    assert.deepEqual(env.details.ignoredFields, ['q']);
    assert.deepEqual(env.details.allowedFields, Object.keys(p.definitions.get('excel_diag_search').parameters.properties));
    assert.deepEqual(Object.keys(env.details).slice(-2), ['ignoredFields', 'allowedFields'], 'they end the JSON line');
  });

  it('no alias is accepted: q is not taken for query', async () => {
    const env = await ok('excel_diag_search', { q: 'crash', limit: 2 }, { facts: true, text: true, next: true });
    assert.equal(env.details.query, '');
    assert.equal(env.details.matched, env.details.total, 'every entry matched, so nothing was narrowed');
    const path_ = await refused('excel_diag_read_file', { file: 'summary.md' });
    assert.equal(path_.details.error, 'path is missing');
    assert.deepEqual(path_.details.ignoredFields, ['file']);
  });

  it('its note stands before the notes of the program', async () => {
    const env = await ok('excel_diag_search', { pattern: 'x', regex: true, bundle: 'sample', limit: 1 }, { facts: true, text: true, next: true });
    const lines = blocks(env)[0].split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[1], '- Fact: pattern and regex are not fields of excel_diag_search and were ignored, so this result is not narrowed by them. Send the call again with the allowed fields if they mattered.');
    assert.equal(lines[2], `- Fact: bundle "sample" was read as ${SAMPLE_ID}.`);
    assert.deepEqual(env.details.ignoredFields, ['pattern', 'regex']);
  });

  it('a refusal carries the two lists too, in its one JSON line', async () => {
    const env = await refused('excel_diag_show', { entry: 15501 });
    assert.equal(env.details.error, 'id is missing');
    assert.deepEqual(env.details.ignoredFields, ['entry']);
    assert.deepEqual(env.details.allowedFields, ['id', 'maxChars', 'utc', 'bundle']);
  });

  it('an undeclared name is not passed to the program, so "ignored" is true of every tool', async () => {
    // The program reads utc for every operation; excel_diag_files does not declare it. Passed on, this value
    // would be refused there as "utc must be true or false", about a field the tool says it does not have.
    const env = await ok('excel_diag_files', { utc: 'yes', limit: 2 }, { facts: true, text: true, next: true });
    assert.deepEqual(env.details.ignoredFields, ['utc']);
    assert.deepEqual(env.details.allowedFields, ['filter', 'limit', 'offset', 'bundle']);
  });

  it('each result has its own list of allowed names, so changing one result changes nothing else', async () => {
    const first = await ok('excel_diag_files', { nope: 1, limit: 2 }, { facts: true, text: true, next: true });
    first.details.allowedFields.length = 0;
    first.details.ignoredFields.push('added');
    const second = await ok('excel_diag_files', { nope: 1, limit: 2 }, { facts: true, text: true, next: true });
    assert.deepEqual(second.details.ignoredFields, ['nope']);
    assert.deepEqual(second.details.allowedFields, ['filter', 'limit', 'offset', 'bundle']);
  });

  it('a call with only declared names carries neither list', async () => {
    const env = await ok('excel_diag_search', { query: 'crash', limit: 2 }, { text: true, next: true });
    assert.equal(env.details.ignoredFields, undefined);
    assert.equal(env.details.allowedFields, undefined);
  });
});

describe('plugin results: arguments that are not an object', () => {
  it('are treated as {}', async () => {
    for (const params of [undefined, null, 'summary', 42, true, ['bundle', 'x']]) {
      const env = await ok('excel_diag_summary', params, { text: true, next: true });
      assert.equal(env.details.entries, 32861, `params ${JSON.stringify(params)}`);
      assert.equal(env.details.ignoredFields, undefined);
    }
  });
});

describe('plugin results: the bundles folder', () => {
  it('an empty bundles folder is answered by every tool with what the human must do', async () => {
    const p = await loadPlugin({ sample: false });
    const hidden = [p.bundlesDir, process.env.OPENCLAW_STATE_DIR, os.homedir(), os.tmpdir()];
    for (const tool of p.raw.keys()) {
      const env = await p.raw.get(tool)({});
      checkEnvelope(env, tool, hidden);
      checkFailure(env);
      assert.equal(env.details.error, 'no bundles are available');
      assert.ok(env.details.hint.includes('Ask the human to copy'), env.details.hint);
      assert.equal(env.details.bundle, undefined);
    }
  });

  it('a bundles folder that does not exist is answered the same way, without its path', async () => {
    const gone = path.join(await emptyDir('gone'), 'never-made');
    const p = await loadPlugin({ bundlesDir: gone });
    const env = await p.raw.get('excel_diag_summary')({});
    checkEnvelope(env, 'excel_diag_summary', [gone, process.env.OPENCLAW_STATE_DIR, os.homedir(), os.tmpdir()]);
    checkFailure(env);
    assert.equal(env.details.error, 'no bundles are available');
  });

  it('a zip is unpacked under the state folder, never among the bundles, and its progress is not shown', { skip: NO_DITTO }, async () => {
    const dir = await emptyDir('zips');
    await zip(path.join(await sampleBundlesDir(), SAMPLE_ID), path.join(dir, `${SAMPLE_ID}.zip`));
    const p = await loadPlugin({ bundlesDir: dir });
    const state = process.env.OPENCLAW_STATE_DIR, cache = path.join(state, 'excel-diagnostics', 'cache');
    assert.equal(await exists(cache), false, 'the cache folder need not exist beforehand');
    for (let n = 0; n < 2; n++) {
      const env = await p.raw.get('excel_diag_search')({ query: 'crash' });
      checkEnvelope(env, 'excel_diag_search', [dir, state, os.homedir(), os.tmpdir()]);
      checkSuccess(env, { text: true, next: true });
      assert.equal(env.details.bundle, SAMPLE_ID, 'the id is the file name without .zip');
      assert.equal(env.details.matched, 3);
      assert.ok(!blocks(env).join('\n').includes('npack'), 'what the program says while unpacking stays out of the result');
    }
    assert.deepEqual(await fs.readdir(dir), [`${SAMPLE_ID}.zip`], 'nothing is written among the bundles');
    assert.equal((await fs.readdir(cache)).length, 1, 'the zip is unpacked once, under the state folder');
  });

  it('cleanup', async () => { loaded = null; await cleanup(); });
});
