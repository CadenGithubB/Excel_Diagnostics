// The program behind the tools: how it is started, and what the model is told when it gives no answer.
//
// A tool that throws, or returns anything but { content: [...], details }, reaches a small model as an opaque
// failure with nothing to act on, and it answers that by sending the same call again. So nothing here may reject:
// a program that died, printed something that is not JSON, ran too long or is not installed, and an error inside
// the plugin itself, each come back as one JSON line with one fixed sentence saying what to do instead. Fixed,
// because the host stops a loop only when identical calls return identical results. Nothing the program wrote
// to standard error, no exit status and no path reaches the model.
//
// The program is started without a shell, with three environment variables and the request on standard input,
// and it is killed when it outlives its time: each run holds a whole bundle in memory.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { describe, it, assert, loadPlugin, emptyDir, cleanup, blocks, SAMPLE_ID, PLUGIN_DIR } from '../harness.mjs';

const NO_ANSWER = 'the Excel diagnostics program did not answer';
const HINT = {
  timeout: 'The call took longer than this tool allows and was stopped: send it once more with a shorter time span (from and to) or with a smaller bundle, or tell the human that this bundle is too slow to search here.',
  timeoutWhole: 'The call took longer than this tool allows and was stopped: send it once more with a smaller bundle, or tell the human that this bundle is too slow to search here.',
  missing: 'The program behind the excel_diag tools is not installed on the OpenClaw host: tell the human to run the Excel diagnostics installer again, and do not call these tools until the human says that is done.',
  start: 'The program behind the excel_diag tools could not be started on the OpenClaw host: tell the human, and do not call these tools again until the human says it is fixed.',
  cancelled: 'The call was cancelled before the program answered: send it again only if its result is still needed.',
  silent: 'The program stopped without giving a result: tell the human that this call could not be answered, and do not send the same call again.',
  plugin: 'The tool failed before the program could answer: tell the human that this call could not be answered, and do not send the same call again.',
};

// The one shape a call without an answer has: one JSON line, isError, the fixed error and the hint for its cause.
function checkNoAnswer(env, tool, hint) {
  assert.deepEqual(Object.keys(env), ['content', 'details', 'isError']);
  assert.equal(env.isError, true);
  assert.equal(env.content.length, 1);
  assert.deepEqual(env.content[0], { type: 'text', text: JSON.stringify(env.details) });
  assert.deepEqual(env.details, { ok: false, tool, error: NO_ANSWER, hint });
}

// Programs to start in place of the real one. Each reads the whole request first, as the real one does.
const READ_REQUEST = `import process from 'node:process';
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
`;
const PROGRAMS = {
  echo: `${READ_REQUEST}const errors = fs.fstatSync(2), nowhere = fs.statSync('/dev/null');
process.stdout.write(JSON.stringify({ ok: true, bundle: 'echo', notes: [], receipt: { request, args: process.argv.slice(2), envNames: Object.keys(process.env).sort(), cwd: process.cwd(), errorsDropped: errors.dev === nowhere.dev && errors.ino === nowhere.ino } }) + '\\n');\n`,
  hang: `${READ_REQUEST}fs.writeFileSync(request.bundlesDir + '/pid', String(process.pid));\nsetInterval(() => {}, 1000);\n`,
  flood: `${READ_REQUEST}fs.writeFileSync(request.bundlesDir + '/pid', String(process.pid));\nconst piece = 'x'.repeat(65536);\nfor (let i = 0; i < 48; i++) process.stdout.write(piece);\nsetInterval(() => {}, 1000);\n`,
  dies: `${READ_REQUEST}process.stderr.write('Error: EACCES /Volumes/HostDisk/someone/secret-on-stderr\\n');\nprocess.exitCode = 3;\n`,
  babbles: `${READ_REQUEST}process.stderr.write('secret-on-stderr\\n');\nprocess.stdout.write('Unpacking /Volumes/HostDisk/someone/bundle.zip ...\\n');\n`,
  fails: `${READ_REQUEST}process.stderr.write('secret-on-stderr\\n');\nprocess.stdout.write(JSON.stringify({ ok: false, error: 'the Excel diagnostics program failed', hint: 'Tell the human that excel_diag_search failed with: boom. Do not send the same call again.' }) + '\\n');\nprocess.exitCode = 1;\n`,
};
async function program(name) {
  const file = path.join(await emptyDir('program'), `${name}.mjs`);
  await fs.writeFile(file, PROGRAMS[name]);
  return file;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function pidIn(dir) {
  for (let i = 0; i < 200; i++) {
    try { const pid = Number(await fs.readFile(path.join(dir, 'pid'), 'utf8')); if (pid > 0) return pid; } catch { /* not written yet */ }
    await pause(50);
  }
  throw new Error('the program never started');
}
async function gone(pid) {
  for (let i = 0; i < 60 && alive(pid); i++) await pause(50);
  return !alive(pid);
}
// A stand-in for starting the program at all: it answers with this exit status and this standard output.
const prints = (stdout, code = 0) => ({ run: async () => ({ code, stdout }) });

describe('plugin program: no answer, by way of deps.run', () => {
  it('a dead program is answered by every tool with the same envelope', async () => {
    const p = await loadPlugin({ deps: prints('', 1) });
    assert.equal(p.raw.size, 10);
    for (const tool of p.raw.keys()) checkNoAnswer(await p.raw.get(tool)({}), tool, HINT.silent);
  });

  it('a program killed by a signal has no exit status, and is answered the same way', async () => {
    const p = await loadPlugin({ deps: prints('', null) });
    checkNoAnswer(await p.raw.get('excel_diag_search')({ query: 'x' }), 'excel_diag_search', HINT.silent);
  });

  it('output that is not one JSON object is no answer, whatever the exit status', async () => {
    const outputs = ['Segmentation fault', '[1,2]', '"text"', 'null', '42', '{"ok":true', '{"ok":true}\n{"ok":true}', '  ', '<html>'];
    for (const stdout of outputs) {
      for (const code of [0, 1]) {
        const p = await loadPlugin({ deps: prints(stdout, code) });
        checkNoAnswer(await p.raw.get('excel_diag_show')({ id: 1 }), 'excel_diag_show', HINT.silent);
      }
    }
  });

  it('a JSON object that is neither a success nor a refusal with an error is no answer', async () => {
    for (const doc of [{}, { ok: 'yes' }, { ok: false }, { ok: false, error: '' }, { ok: false, error: 5 }, { error: 'x' }]) {
      const p = await loadPlugin({ deps: prints(JSON.stringify(doc)) });
      checkNoAnswer(await p.raw.get('excel_diag_files')({}), 'excel_diag_files', HINT.silent);
    }
  });

  it('nothing the program printed is shown when it is not a document', async () => {
    const p = await loadPlugin({ deps: prints('ENOENT: no such file, open /Volumes/HostDisk/someone/secret.zip', 1) });
    const env = await p.raw.get('excel_diag_summary')({});
    checkNoAnswer(env, 'excel_diag_summary', HINT.silent);
    assert.ok(!blocks(env)[0].includes('secret') && !blocks(env)[0].includes('ENOENT'));
  });

  it('a document is used whatever the exit status', async () => {
    const hint = 'Tell the human that excel_diag_search failed with: boom. Do not send the same call again.';
    const failed = await loadPlugin({ deps: prints(JSON.stringify({ ok: false, bundle: 'b1', error: 'the Excel diagnostics program failed', hint }), 1) });
    const env = await failed.raw.get('excel_diag_search')({});
    assert.equal(env.isError, true);
    assert.deepEqual(env.details, { ok: false, tool: 'excel_diag_search', bundle: 'b1', error: 'the Excel diagnostics program failed', hint });
    assert.deepEqual(env.content, [{ type: 'text', text: JSON.stringify(env.details) }]);

    const fine = await loadPlugin({ deps: prints(JSON.stringify({ ok: true, bundle: 'b1', notes: [], receipt: { matched: 0, total: 9 } }), 7) });
    const good = await fine.raw.get('excel_diag_search')({});
    assert.deepEqual(Object.keys(good), ['content', 'details']);
    assert.deepEqual(good.details, { ok: true, tool: 'excel_diag_search', bundle: 'b1', matched: 0, total: 9 });
  });

  it('only the parts of a document that the model is meant to read are passed on', async () => {
    const doc = { ok: false, bundle: 'b1', error: 'no such entry', field: 'id', hint: 'Copy an id.', candidates: ['a', 7, 'b'], stack: 'at /Volumes/HostDisk/someone/x.js:1', receipt: { secret: 1 } };
    const p = await loadPlugin({ deps: prints(JSON.stringify(doc)) });
    const env = await p.raw.get('excel_diag_show')({ id: 5 });
    assert.deepEqual(env.details, { ok: false, tool: 'excel_diag_show', bundle: 'b1', error: 'no such entry', field: 'id', hint: 'Copy an id.', candidates: ['a', 'b'] });
  });

  it('a receipt cannot change ok or tool, and parts of the wrong type are left out', async () => {
    const doc = { ok: true, bundle: 'b1', notes: [1, 'a real note', null, ''], receipt: { ok: false, tool: 'other', matched: 2 }, text: 5, next: { call: 'x' } };
    const p = await loadPlugin({ deps: prints(JSON.stringify(doc)) });
    const env = await p.raw.get('excel_diag_count')({});
    assert.deepEqual(env.details, { ok: true, tool: 'excel_diag_count', bundle: 'b1', matched: 2 });
    assert.deepEqual(blocks(env), ['Facts about this call:\n- Fact: a real note', JSON.stringify(env.details)]);
    assert.equal(env.isError, undefined);

    const bare = await loadPlugin({ deps: prints('{"ok":true}') });
    const least = await bare.raw.get('excel_diag_memory')({});
    assert.deepEqual(blocks(least), ['{"ok":true,"tool":"excel_diag_memory"}']);
  });

  it('the block order holds for any document: facts, the JSON line, the lines, Next: last', async () => {
    const doc = { ok: true, bundle: 'b1', notes: ['one', 'two'], receipt: { matched: 1 }, text: 'ID  MESSAGE\n 7  hello', next: 'excel_diag_show {id: 7} gives that entry in full. If this answers the question, reply now.' };
    const p = await loadPlugin({ deps: prints(JSON.stringify(doc)) });
    const env = await p.raw.get('excel_diag_search')({ q: 'hello' });
    assert.deepEqual(blocks(env), [
      'Facts about this call:\n- Fact: q is not a field of excel_diag_search and was ignored, so this result is not narrowed by it. Send the call again with one of the allowed fields if it mattered.\n- Fact: one\n- Fact: two',
      JSON.stringify(env.details),
      'ID  MESSAGE\n 7  hello',
      'Next: excel_diag_show {id: 7} gives that entry in full. If this answers the question, reply now.',
    ]);
    assert.deepEqual(Object.keys(env.details), ['ok', 'tool', 'bundle', 'matched', 'ignoredFields', 'allowedFields']);
  });

  it('a stand-in that rejects, throws or resolves nonsense is still answered with an envelope', async () => {
    const stand = [
      async () => { throw new Error('spawn EACCES /Volumes/HostDisk/someone/node'); },
      () => { throw new Error('thrown before any promise'); },
      () => Promise.reject(new Error('rejected')),
    ];
    for (const run of stand) {
      const p = await loadPlugin({ deps: { run } });
      const env = await p.raw.get('excel_diag_context')({ id: 3 });
      checkNoAnswer(env, 'excel_diag_context', HINT.plugin);
      assert.equal(p.logs.length, 1, 'the error goes to the log, in one line');
      assert.ok(p.logs[0].startsWith('excel-diagnostics: excel_diag_context failed inside the plugin: '), p.logs[0]);
    }
    // Anything can be thrown: a value with no message, and one that cannot even be turned into text.
    const unreadable = { get message() { throw new Error('no message'); } };
    for (const thrown of [undefined, null, 'text', 0, Symbol('thrown'), Object.create(null), unreadable]) {
      const p = await loadPlugin({ deps: { run: () => { throw thrown; } } });
      checkNoAnswer(await p.raw.get('excel_diag_context')({ id: 3 }), 'excel_diag_context', HINT.plugin);
      assert.equal(p.logs.length, 1);
    }
    for (const value of [undefined, null, 7, 'text', {}, { code: 0 }, { code: 0, stdout: 5 }, { code: 0, stdout: null }]) {
      const p = await loadPlugin({ deps: { run: async () => value } });
      checkNoAnswer(await p.raw.get('excel_diag_reports')({}), 'excel_diag_reports', HINT.silent);
    }
  });

  it('a call that ran out of time is told how to narrow it, with arguments the tool has', async () => {
    const p = await loadPlugin({ deps: { run: async () => ({ code: null, stdout: '', cause: 'timeout' }) } });
    const spans = ['excel_diag_search', 'excel_diag_count', 'excel_diag_histogram'];
    for (const tool of p.raw.keys()) {
      const takesSpan = 'from' in p.definitions.get(tool).parameters.properties;
      assert.equal(takesSpan, spans.includes(tool));
      // A tool with no from and to must not be told to send them: the names would come back as ignoredFields.
      checkNoAnswer(await p.raw.get(tool)({}), tool, takesSpan ? HINT.timeout : HINT.timeoutWhole);
    }
    for (const hint of [HINT.timeout, HINT.timeoutWhole]) for (const word of ['smaller bundle', 'tell the human', 'too slow to search here']) assert.ok(hint.includes(word));
    assert.ok(HINT.timeout.includes('from and to') && !HINT.timeoutWhole.includes('from'));
  });

  it('the text is the same every time, so a repeated call returns an identical result', async () => {
    const p = await loadPlugin({ deps: prints('', 1) });
    const first = await p.raw.get('excel_diag_search')({ query: 'x' });
    const second = await p.raw.get('excel_diag_search')({ query: 'x' });
    assert.deepEqual(first, second);
  });

  it('undeclared names are still said back when the program gives no answer', async () => {
    const p = await loadPlugin({ deps: prints('', 1) });
    const env = await p.raw.get('excel_diag_show')({ entry: 5 });
    assert.equal(env.isError, true);
    assert.deepEqual(env.details, { ok: false, tool: 'excel_diag_show', error: NO_ANSWER, hint: HINT.silent, ignoredFields: ['entry'], allowedFields: ['id', 'maxChars', 'utc', 'bundle'] });
  });
});

describe('plugin program: an error inside the plugin itself', () => {
  it('arguments that cannot be written as JSON come back as an envelope, not a throw', async () => {
    const p = await loadPlugin();
    const env = await p.raw.get('excel_diag_search')({ limit: 10n });
    checkNoAnswer(env, 'excel_diag_search', HINT.plugin);
    assert.equal(p.logs.length, 1);
  });

  it('arguments that throw when they are read come back as an envelope, and the error stays in the log', async () => {
    const p = await loadPlugin({ deps: prints('{"ok":true}') });
    const trap = new Proxy({}, { ownKeys() { throw new Error('trap /Volumes/HostDisk/someone/secret'); } });
    const getter = { get query() { throw new Error('getter /Volumes/HostDisk/someone/secret'); } };
    for (const params of [trap, getter]) {
      const env = await p.raw.get('excel_diag_search')(params);
      checkNoAnswer(env, 'excel_diag_search', HINT.plugin);
      assert.ok(!blocks(env)[0].includes('secret'));
    }
    assert.equal(p.logs.length, 2);
    assert.ok(p.logs[0].includes('trap') && p.logs[1].includes('getter'));
  });
});

describe('plugin program: started for real', () => {
  it('gets the request on standard input, "request" as its only argument, and three environment variables', async () => {
    const cliPath = await program('echo');
    process.env.EXCEL_DIAG_TEST_MARKER = 'must-not-reach-the-program';
    try {
      const p = await loadPlugin({ deps: { cliPath } });
      const state = process.env.OPENCLAW_STATE_DIR;
      // Standard input is closed after the request: this program answers only once its input has ended.
      const d = await p.tools.get('excel_diag_search')({ query: 'a "b" \\ $HOME `c`; rm', limit: 3, q: 'dropped' });
      assert.deepEqual(d.request, {
        format: 1,
        op: 'search',
        bundlesDir: p.bundlesDir,
        cacheDir: path.join(state, 'excel-diagnostics', 'cache'),
        params: { query: 'a "b" \\ $HOME `c`; rm', limit: 3 },
      });
      assert.deepEqual(d.args, ['request'], 'nothing the model sent is on the command line');
      for (const name of ['HOME', 'PATH', 'TMPDIR']) assert.ok(d.envNames.includes(name), `${name} is set`);
      const others = d.envNames.filter((n) => !['HOME', 'PATH', 'TMPDIR'].includes(n) && !n.startsWith('__CF'));      // macOS adds __CF_USER_TEXT_ENCODING to every process
      assert.deepEqual(others, [], 'no other variable of the Gateway reaches the program');
      assert.equal(await fs.realpath(d.cwd), await fs.realpath(path.dirname(cliPath)), 'it runs in the folder that holds it');
      assert.equal(d.errorsDropped, true, 'what the program writes to standard error goes nowhere');
      assert.deepEqual(d.ignoredFields, ['q']);
    } finally {
      delete process.env.EXCEL_DIAG_TEST_MARKER;
    }
  });

  it('sends the operation named by the tool, for all ten', async () => {
    const cliPath = await program('echo');
    const p = await loadPlugin({ deps: { cliPath } });
    const ops = [];
    for (const tool of p.tools.keys()) ops.push((await p.tools.get(tool)({})).request.op);
    assert.deepEqual(ops, ['summary', 'search', 'count', 'histogram', 'show', 'context', 'reports', 'files', 'read_file', 'memory']);
  });

  it('the program beside the plugin is the one started, which is where the installer puts it', async () => {
    const dir = await emptyDir('installed');
    for (const name of ['index.js', 'package.json', 'openclaw.plugin.json']) await fs.copyFile(path.join(PLUGIN_DIR, name), path.join(dir, name));
    await fs.writeFile(path.join(dir, 'excel_diagnostics_cli.mjs'), PROGRAMS.echo);
    process.env.OPENCLAW_STATE_DIR = await emptyDir('state');
    const installed = await import(pathToFileURL(path.join(dir, 'index.js')).href);
    const logs = [];
    let execute = null;
    installed.register({ pluginConfig: { bundlesDir: dir }, logger: { info: (m) => logs.push(m) }, registerTool(t) { if (t.name === 'excel_diag_files') execute = t.execute; }, on() {} });
    const env = await execute('test-call', {});
    assert.equal(env.details.bundle, 'echo', 'the stand-in beside index.js answered, not the program in the repository');
    assert.equal(env.details.request.op, 'files');
    assert.equal(await fs.realpath(env.details.cwd), await fs.realpath(dir));
    assert.deepEqual(logs, []);
  });

  it('a program that is not there: the human is told to install it', async () => {
    const cliPath = path.join(await emptyDir('program'), 'excel_diagnostics_cli.mjs');
    const p = await loadPlugin({ deps: { cliPath } });
    assert.equal(p.logs.length, 1, 'one log line when the plugin loads');
    assert.ok(p.logs[0].includes('was not found beside the plugin'), p.logs[0]);
    const env = await p.raw.get('excel_diag_summary')({});
    checkNoAnswer(env, 'excel_diag_summary', HINT.missing);
    assert.ok(!blocks(env)[0].includes(path.dirname(cliPath)));
  });

  it('a runtime that cannot be started: the human is told, and the call does not hang', async () => {
    // What a Gateway meets when the Node it was started with has been replaced under it.
    const p = await loadPlugin();
    const saved = process.execPath;
    process.execPath = path.join(await emptyDir('runtime'), 'not-here');
    let env = null;
    try { env = await p.raw.get('excel_diag_summary')({}); } finally { process.execPath = saved; }
    checkNoAnswer(env, 'excel_diag_summary', HINT.start);
    assert.ok(p.logs.length === 1 && p.logs[0].includes('(start'), p.logs.join(' | '));
  });

  it('a program that exits without a document, and one that prints something else', async () => {
    for (const name of ['dies', 'babbles']) {
      const p = await loadPlugin({ deps: { cliPath: await program(name) } });
      const env = await p.raw.get('excel_diag_search')({ query: 'x' });
      checkNoAnswer(env, 'excel_diag_search', HINT.silent);
      assert.ok(!blocks(env)[0].includes('secret') && !blocks(env)[0].includes('Unpacking'));
      assert.equal(p.logs.length, 1);
      assert.ok(p.logs[0].startsWith('excel-diagnostics: excel_diag_search got no answer from the program (silent'), p.logs[0]);
    }
  });

  it('a document printed before a failing exit is used, and standard error is dropped', async () => {
    const p = await loadPlugin({ deps: { cliPath: await program('fails') } });
    const env = await p.raw.get('excel_diag_search')({ query: 'x' });
    assert.equal(env.isError, true);
    assert.equal(env.details.error, 'the Excel diagnostics program failed');
    assert.equal(env.details.hint, 'Tell the human that excel_diag_search failed with: boom. Do not send the same call again.');
    assert.ok(!blocks(env)[0].includes('secret-on-stderr'));
  });

  it('a program that runs past its time is killed, and the model is told how to narrow the call', async () => {
    const p = await loadPlugin({ deps: { cliPath: await program('hang') }, pluginConfig: { timeoutSeconds: 5 }, sample: false });
    const started = Date.now();
    const env = await p.raw.get('excel_diag_search')({ query: 'x' });
    const took = Date.now() - started;
    assert.ok(took >= 4900 && took < 60000, `the call returned after ${took} ms`);
    checkNoAnswer(env, 'excel_diag_search', HINT.timeout);
    assert.ok(await gone(await pidIn(p.bundlesDir)), 'the program was killed');
    assert.ok(p.logs.some((l) => l.includes('timeout after 5 s')), p.logs.join(' | '));
  });

  it('a call the host cancels kills the program at once', async () => {
    const p = await loadPlugin({ deps: { cliPath: await program('hang') }, pluginConfig: { timeoutSeconds: 60 }, sample: false });
    const stop = new AbortController();
    const started = Date.now();
    const pending = p.definitions.get('excel_diag_summary').execute('test-call', {}, stop.signal);
    const pid = await pidIn(p.bundlesDir);
    stop.abort();
    checkNoAnswer(await pending, 'excel_diag_summary', HINT.cancelled);
    assert.ok(Date.now() - started < 30000, 'it did not wait for the time limit');
    assert.ok(await gone(pid), 'the program was killed');
  });

  it('a call cancelled before it starts runs nothing to the end', async () => {
    const p = await loadPlugin({ deps: { cliPath: await program('echo') } });
    const stop = new AbortController();
    stop.abort();
    checkNoAnswer(await p.definitions.get('excel_diag_summary').execute('test-call', {}, stop.signal), 'excel_diag_summary', HINT.cancelled);
  });

  it('a third argument that is not a cancel signal changes nothing', async () => {
    const p = await loadPlugin();
    for (const third of [undefined, null, {}, () => {}, 'text', 5]) {
      const env = await p.definitions.get('excel_diag_search').execute('test-call', { query: 'crash' }, third);
      assert.equal(env.details.ok, true);
      assert.equal(env.details.bundle, SAMPLE_ID);
      assert.equal(env.details.matched, 3);
    }
  });

  it('more output than one answer can be is cut off, and the program is killed', async () => {
    const p = await loadPlugin({ deps: { cliPath: await program('flood') }, pluginConfig: { timeoutSeconds: 60 }, sample: false });
    const started = Date.now();
    const env = await p.raw.get('excel_diag_search')({});
    checkNoAnswer(env, 'excel_diag_search', HINT.silent);
    assert.ok(Date.now() - started < 30000, 'it did not wait for the time limit');
    assert.ok(await gone(await pidIn(p.bundlesDir)), 'the program was killed');
  });

  it('no path of this machine is in any of these answers', async () => {
    const cases = [
      [{ deps: prints('', 1) }, {}],
      [{ deps: { cliPath: path.join(await emptyDir('program'), 'missing.mjs') } }, {}],
      [{ deps: { cliPath: await program('dies') } }, {}],
      [{}, { limit: 10n }],
    ];
    for (const [options, params] of cases) {
      const p = await loadPlugin(options);
      const env = await p.raw.get('excel_diag_search')(params);
      assert.equal(env.details.error, NO_ANSWER);
      for (const dir of [p.bundlesDir, process.env.OPENCLAW_STATE_DIR, os.homedir(), os.tmpdir()]) assert.ok(!blocks(env).join('\n').includes(dir), dir);
    }
  });

  it('cleanup', async () => { await cleanup(); });
});
