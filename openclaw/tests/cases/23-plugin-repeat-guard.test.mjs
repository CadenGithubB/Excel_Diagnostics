// The repeat guard, the plugin's only hook.
//
// A small model that has a result and does not know what to do with it sends the same lookup again, and again.
// The third identical call in a row is refused, once, with a sentence that says to use the result it already has.
// Only once, and always in the same words: the host stops a loop by seeing identical calls return identical
// results, so a tool that refuses every repeat, or words each refusal differently, hides the loop from it. The
// fourth and later calls therefore run as usual.
//
// The hook sees every tool call of every plugin. It must refuse none but this plugin's ten tools, and it must
// never throw, whatever the host hands it: a guard that fails would take every tool call down with it.
import { describe, it, assert, loadPlugin, cleanup } from '../harness.mjs';

const NAMES = ['excel_diag_summary', 'excel_diag_search', 'excel_diag_count', 'excel_diag_histogram', 'excel_diag_show',
  'excel_diag_context', 'excel_diag_reports', 'excel_diag_files', 'excel_diag_read_file', 'excel_diag_memory'];
const refusal = (tool) => `This exact ${tool} call was just made twice and its result has not changed. Do not repeat it: use the result you already have and take the next step, or answer.`;
const blocked = (tool) => ({ block: true, blockReason: refusal(tool) });

// A fresh plugin with a clock the spec moves by hand. The program is never started: the hook runs before a call.
async function guard(start = 1_000_000) {
  const clock = { now: start };
  const p = await loadPlugin({ deps: { now: () => clock.now, run: async () => ({ code: 0, stdout: '{"ok":true}' }) } });
  const call = (toolName, params, more = {}, ctx) => p.hook({ toolName, params, ...more }, ctx);
  return { p, clock, call };
}

describe('plugin repeat guard: the third identical call', () => {
  it('two run, the third is refused, and the fourth and later run again', async () => {
    const { call } = await guard();
    const args = { query: 'crash', limit: 5 };
    assert.equal(await call('excel_diag_search', args), undefined);
    assert.equal(await call('excel_diag_search', args), undefined);
    assert.deepEqual(await call('excel_diag_search', args), blocked('excel_diag_search'));
    for (let n = 4; n <= 25; n++) assert.equal(await call('excel_diag_search', args), undefined, `call ${n} runs`);
  });

  it('the refusal is the same sentence for every tool, with only the tool name changed', async () => {
    for (const tool of NAMES) {
      const { call } = await guard();
      await call(tool, {});
      await call(tool, {});
      const third = await call(tool, {});
      assert.deepEqual(Object.keys(third), ['block', 'blockReason']);
      assert.equal(third.block, true);
      assert.equal(third.blockReason, refusal(tool));
    }
  });

  it('the same arguments in another order are the same call, at any depth', async () => {
    const { call } = await guard();
    await call('excel_diag_search', { query: 'crash', limit: 5, extra: { a: 1, b: [1, { x: 1, y: 2 }] } });
    await call('excel_diag_search', { limit: 5, extra: { b: [1, { y: 2, x: 1 }], a: 1 }, query: 'crash' });
    assert.deepEqual(await call('excel_diag_search', { extra: { a: 1, b: [1, { x: 1, y: 2 }] }, limit: 5, query: 'crash' }), blocked('excel_diag_search'));
  });

  it('different arguments, or the same arguments to another tool, are not the same call', async () => {
    const { call } = await guard();
    for (let n = 0; n < 6; n++) assert.equal(await call('excel_diag_search', { query: 'crash', offset: n * 20 }), undefined, 'paging is not a loop');
    for (const params of [{ id: 5 }, { id: 6 }, { id: '5' }, { id: 5, utc: true }, { id: [5] }]) assert.equal(await call('excel_diag_show', params), undefined);
    assert.equal(await call('excel_diag_show', { id: 5 }), undefined);
    assert.equal(await call('excel_diag_context', { id: 5 }), undefined);
    assert.equal(await call('excel_diag_show', { id: 5 }), undefined);
    assert.equal(await call('excel_diag_context', { id: 5 }), undefined, 'two tools taking turns never reach three in a row');
  });

  it('arguments that are not an object count as {}, as they do when the tool runs', async () => {
    const { call } = await guard();
    assert.equal(await call('excel_diag_summary', undefined), undefined);
    assert.equal(await call('excel_diag_summary', null), undefined);
    assert.deepEqual(await call('excel_diag_summary', {}), blocked('excel_diag_summary'));
  });
});

describe('plugin repeat guard: what starts the count again', () => {
  it('any other tool call in between, of this plugin or any other', async () => {
    for (const between of ['read', 'exec', 'other_plugin_lookup', 'tool_search', 'excel_diag_summary']) {
      const { call } = await guard();
      await call('excel_diag_show', { id: 5 });
      await call('excel_diag_show', { id: 5 });
      assert.equal(await call(between, {}), undefined);
      assert.equal(await call('excel_diag_show', { id: 5 }), undefined, `after ${between} the count starts again`);
      assert.equal(await call('excel_diag_show', { id: 5 }), undefined);
      assert.deepEqual(await call('excel_diag_show', { id: 5 }), blocked('excel_diag_show'));
    }
  });

  it('a call through the wrapper to another plugin\'s tool starts it again too', async () => {
    const { call } = await guard();
    await call('excel_diag_show', { id: 5 });
    await call('excel_diag_show', { id: 5 });
    assert.equal(await call('tool_call', { id: 'openclaw:other-plugin:other_lookup', args: { title: 'x' } }), undefined);
    assert.equal(await call('excel_diag_show', { id: 5 }), undefined);
  });

  it('thirty minutes without the call', async () => {
    const { call, clock } = await guard();
    const minute = 60_000;
    await call('excel_diag_files', {});
    clock.now += 29 * minute;
    await call('excel_diag_files', {});
    clock.now += 30 * minute;
    assert.equal(await call('excel_diag_files', {}), undefined, 'thirty minutes after the last one, it is a first call again');
    clock.now += 30 * minute - 1;
    assert.equal(await call('excel_diag_files', {}), undefined, 'a second call');
    clock.now += 30 * minute - 1;
    assert.deepEqual(await call('excel_diag_files', {}), blocked('excel_diag_files'), 'each within thirty minutes of the one before');
  });
});

describe('plugin repeat guard: other tools', () => {
  it('no other tool is ever refused, however often it repeats', async () => {
    const { call } = await guard();
    const others = ['read', 'exec', 'write', 'other_lookup', 'other_plugin_search', 'tool_search', 'tool_describe', 'excel_diag', 'excel_diag_export', 'EXCEL_DIAG_SEARCH', 'toString', 'constructor', '__proto__', '', undefined, null, 7, {}];
    for (const toolName of others) {
      for (let n = 0; n < 6; n++) assert.equal(await call(toolName, { path: '/same/every/time' }), undefined, `${String(toolName)} call ${n + 1}`);
    }
    for (const id of ['openclaw:other-plugin:other_lookup', 'other_lookup', 'openclaw:other-plugin:excel_diag_export', '', 5, null]) {
      for (let n = 0; n < 6; n++) assert.equal(await call('tool_call', { id, args: { title: 'x' } }), undefined, `tool_call ${String(id)}`);
    }
  });
});

describe('plugin repeat guard: calls through the host\'s wrapper', () => {
  it('are counted as the tool they name', async () => {
    for (const id of ['excel_diag_count', 'openclaw:excel-diagnostics:excel_diag_count']) {
      const { call } = await guard();
      const wrapped = { id, args: { by: 'process' } };
      assert.equal(await call('tool_call', wrapped), undefined);
      assert.equal(await call('tool_call', wrapped), undefined);
      assert.deepEqual(await call('tool_call', wrapped), blocked('excel_diag_count'), 'the refusal names the tool, not the wrapper');
      assert.equal(await call('tool_call', wrapped), undefined, 'the fourth runs');
    }
  });

  it('a wrapped call and a bare one with the same arguments are the same call', async () => {
    const { call } = await guard();
    assert.equal(await call('excel_diag_histogram', { bins: 12 }), undefined);
    assert.equal(await call('tool_call', { id: 'openclaw:excel-diagnostics:excel_diag_histogram', args: { bins: 12 } }), undefined);
    assert.deepEqual(await call('tool_call', { id: 'excel_diag_histogram', args: { bins: 12 } }), blocked('excel_diag_histogram'));
  });

  it('different arguments inside the wrapper are different calls', async () => {
    const { call } = await guard();
    for (const by of ['process', 'severity', 'tag', 'source', 'file']) assert.equal(await call('tool_call', { id: 'excel_diag_count', args: { by } }), undefined);
  });

  // Whether the host announces a deferred call once or twice is not recorded anywhere. If it is twice, the two
  // events are one call of the model's, and its second identical call must not be refused as if it were its third.
  it('one call announced twice, as the wrapper and as the tool with the same call id, is counted once', async () => {
    const { call } = await guard();
    const args = { by: 'process' };
    const twice = async (toolCallId) => [await call('tool_call', { id: 'openclaw:excel-diagnostics:excel_diag_count', args }, { toolCallId }), await call('excel_diag_count', args, { toolCallId })];
    assert.deepEqual(await twice('call-1'), [undefined, undefined]);
    assert.deepEqual(await twice('call-2'), [undefined, undefined], 'the second identical call runs');
    assert.deepEqual((await twice('call-3'))[0], blocked('excel_diag_count'), 'the third is refused, as for a tool called by name');
    assert.deepEqual(await twice('call-4'), [undefined, undefined], 'and the fourth runs');
  });

  it('the call id is also read from the second argument, and a new id is always a new call', async () => {
    const { call } = await guard();
    const args = { filter: 'reports' };
    assert.equal(await call('excel_diag_files', args, {}, { toolCallId: 'a' }), undefined);
    assert.equal(await call('excel_diag_files', args, {}, { toolCallId: 'a' }), undefined, 'the same id again is the same call');
    assert.equal(await call('excel_diag_files', args, {}, { toolCallId: 'b' }), undefined, 'second call');
    assert.deepEqual(await call('excel_diag_files', args, {}, { toolCallId: 'c' }), blocked('excel_diag_files'));
    const other = await guard();
    for (const toolCallId of ['', null, 7, {}]) await other.call('excel_diag_files', args, { toolCallId });
    assert.equal(await other.call('excel_diag_files', args, { toolCallId: '' }), undefined, 'an id that is not a text is no id: four were counted, and the fifth runs');
  });

  it('arguments put beside id, where args should be, do not break the count', async () => {
    const { call } = await guard();
    const flat = { id: 'excel_diag_count', by: 'process' };
    assert.equal(await call('tool_call', flat), undefined);
    assert.equal(await call('tool_call', { id: 'excel_diag_count', by: 'severity' }), undefined, 'another misplaced argument is another call');
    assert.equal(await call('tool_call', flat), undefined);
    assert.equal(await call('tool_call', flat), undefined);
    assert.deepEqual(await call('tool_call', flat), blocked('excel_diag_count'));
    for (const args of ['{"by":"process"}', null, ['by'], 5]) {
      const fresh = await guard();
      assert.equal(await fresh.call('tool_call', { id: 'excel_diag_count', args }), undefined);
    }
  });
});

describe('plugin repeat guard: sessions', () => {
  it('each session has its own count, named by sessionKey, then runId, then "default"', async () => {
    const { p } = await guard();
    const event = { toolName: 'excel_diag_show', params: { id: 5 } };
    // The key is taken from the event first, then from the second argument.
    assert.equal(await p.hook({ ...event, sessionKey: 'a' }), undefined);
    assert.equal(await p.hook({ ...event, sessionKey: 'b' }), undefined);
    assert.equal(await p.hook(event, { sessionKey: 'a' }), undefined);
    assert.equal(await p.hook(event, { sessionKey: 'b' }), undefined);
    assert.equal(await p.hook({ ...event, runId: 'r1' }), undefined, 'a run id is used only when there is no session key');
    assert.equal(await p.hook(event, { runId: 'r1' }), undefined);
    assert.equal(await p.hook(event), undefined, 'no key at all is the session "default"');
    assert.equal(await p.hook(event, {}), undefined);
    assert.deepEqual(await p.hook({ ...event, sessionKey: 'a', runId: 'r9' }), blocked('excel_diag_show'), 'third in session a');
    assert.deepEqual(await p.hook({ ...event, runId: 'r9' }, { sessionKey: 'b', runId: 'r1' }), blocked('excel_diag_show'), 'third in session b');
    assert.deepEqual(await p.hook(event, { runId: 'r1' }), blocked('excel_diag_show'), 'third in run r1');
    assert.deepEqual(await p.hook({ ...event, sessionKey: 'default' }), blocked('excel_diag_show'), 'third in the session "default"');
  });

  it('another tool in one session does not start the count again in another', async () => {
    const { p } = await guard();
    const event = { toolName: 'excel_diag_show', params: { id: 5 } };
    await p.hook({ ...event, sessionKey: 'a' });
    await p.hook({ ...event, sessionKey: 'a' });
    assert.equal(await p.hook({ toolName: 'read', params: {}, sessionKey: 'b' }), undefined);
    assert.deepEqual(await p.hook({ ...event, sessionKey: 'a' }), blocked('excel_diag_show'));
  });

  it('at most 200 sessions are remembered, and the one used longest ago is forgotten first', async () => {
    const event = { toolName: 'excel_diag_show', params: { id: 5 } };
    const kept = await guard();
    await kept.p.hook({ ...event, sessionKey: 'first' });
    await kept.p.hook({ ...event, sessionKey: 'first' });
    for (let n = 0; n < 199; n++) await kept.p.hook({ ...event, sessionKey: `other-${n}` });
    assert.deepEqual(await kept.p.hook({ ...event, sessionKey: 'first' }), blocked('excel_diag_show'), '200 sessions: the first is still remembered');

    const dropped = await guard();
    await dropped.p.hook({ ...event, sessionKey: 'first' });
    await dropped.p.hook({ ...event, sessionKey: 'first' });
    for (let n = 0; n < 200; n++) await dropped.p.hook({ ...event, sessionKey: `other-${n}` });
    assert.equal(await dropped.p.hook({ ...event, sessionKey: 'first' }), undefined, '201 sessions: the first was forgotten, so this is a first call');

    const used = await guard();
    await used.p.hook({ ...event, sessionKey: 'first' });
    for (let n = 0; n < 150; n++) await used.p.hook({ ...event, sessionKey: `other-${n}` });
    await used.p.hook({ ...event, sessionKey: 'first' });
    for (let n = 150; n < 300; n++) await used.p.hook({ ...event, sessionKey: `other-${n}` });
    assert.deepEqual(await used.p.hook({ ...event, sessionKey: 'first' }), blocked('excel_diag_show'), 'a session used since then is kept');
  });
});

describe('plugin repeat guard: never throws', () => {
  it('whatever the host hands it, it answers and does not throw', async () => {
    const { p } = await guard();
    const loop = {};
    loop.self = loop;
    const events = [
      undefined, null, 0, 'excel_diag_show', [], {},
      { toolName: 'excel_diag_show', params: loop },
      { toolName: 'excel_diag_show', params: { id: 10n } },
      { toolName: 'excel_diag_show', params: { toJSON() { throw new Error('toJSON'); } } },
      { toolName: 'excel_diag_show', params: new Proxy({}, { ownKeys() { throw new Error('ownKeys'); } }) },
      { toolName: 'tool_call', params: { id: 'excel_diag_show', args: loop } },
      { get toolName() { throw new Error('toolName'); } },
      { toolName: 'excel_diag_show', get params() { throw new Error('params'); } },
      { toolName: 'excel_diag_show', params: {}, get sessionKey() { throw new Error('sessionKey'); } },
      { toolName: 'excel_diag_show', params: {}, sessionKey: { toString() { throw new Error('toString'); } } },
    ];
    // None of these can be read as a call of this plugin's, so none is counted and none is refused.
    for (const event of events) {
      for (let n = 0; n < 4; n++) assert.equal(await p.hook(event, undefined), undefined);
    }
    // Odd values that can be read are counted like any other: the answer is still only "run" or the refusal.
    for (const sessionKey of [Symbol('s'), 0, false, ['a'], { key: 1 }, 10n]) {
      const answers = [];
      for (let n = 0; n < 4; n++) answers.push(await p.hook({ toolName: 'excel_diag_show', params: {}, sessionKey }));
      assert.deepEqual(answers, [undefined, undefined, blocked('excel_diag_show'), undefined], `session ${String(sessionKey)}`);
    }
    for (const ctx of [null, 5, 'ctx', { get sessionKey() { throw new Error('ctx'); } }]) {
      for (let n = 0; n < 4; n++) assert.equal(await p.hook({ toolName: 'excel_diag_files', params: { filter: String(n) } }, ctx), undefined);
    }
  });

  it('a clock that fails does not take the tools down', async () => {
    const p = await loadPlugin({ deps: { now: () => { throw new Error('no clock'); }, run: async () => ({ code: 0, stdout: '{"ok":true}' }) } });
    for (let n = 0; n < 4; n++) assert.equal(await p.hook({ toolName: 'excel_diag_show', params: { id: 5 } }), undefined);
  });

  it('it only ever allows or refuses: it never changes the arguments, and it does not run the tool', async () => {
    let runs = 0;
    const p = await loadPlugin({ deps: { run: async () => { runs++; return { code: 0, stdout: '{"ok":true}' }; } } });
    const params = { query: 'crash' }, before = JSON.stringify(params);
    const answers = [];
    for (let n = 0; n < 5; n++) answers.push(await p.hook({ toolName: 'excel_diag_search', params }));
    assert.deepEqual(answers, [undefined, undefined, blocked('excel_diag_search'), undefined, undefined]);
    assert.equal(JSON.stringify(params), before);
    assert.equal(runs, 0);
  });

  it('cleanup', async () => { await cleanup(); });
});
