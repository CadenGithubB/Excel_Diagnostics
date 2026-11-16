// The plugin's own ceiling on one result, whatever the program printed.
//
// The program cuts what a bundle can make long, to about 22,000 characters for one answer. This is the second lock: a
// result over RESULT_MOST characters is not handed to the model at all, because one such result can fill much of a
// small model's context. RESULT_MOST is just above the most the program gives, worked out from the program's own
// limits, so that a result the program gave whole is never refused here (50-seams checks the two agree). What the model
// gets in its place has to be something it can act on, so the refusal names only arguments the tool it called
// really has. Told to send "a smaller limit" to a tool with no limit, a small model sends one anyway, the plugin
// reports the argument as ignored, and the same oversized result comes back.
import { describe, it, assert, loadPlugin, cleanup } from '../harness.mjs';
import { RESULT_MOST } from '../../plugin/index.js';

// A stand-in for the program: one result whose text block has `chars` characters.
const answers = (chars) => ({ run: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, bundle: 'Made_up', notes: [], receipt: { entries: 1 }, text: 'x'.repeat(chars) }) }) });
const ASKS_FOR = { limit: /a smaller limit/, maxChars: /a smaller maxChars/, query: /a narrower query/, filter: /a filter that/, grep: /a grep that/, before: /a smaller before and after/, window: /a shorter window/, bins: /fewer bins/ };

describe('plugin: one result is never more than RESULT_MOST characters', () => {
  it('a larger one is refused, and a result under the ceiling is passed on', async () => {
    assert.ok(RESULT_MOST > 20000 && RESULT_MOST < 30000, `RESULT_MOST is ${RESULT_MOST}`);
    const big = await loadPlugin({ deps: answers(RESULT_MOST) }), usual = await loadPlugin({ deps: answers(RESULT_MOST - 200) });
    const env = await big.raw.get('excel_diag_search')({ query: 'pivot' });
    assert.equal(env.isError, true);
    assert.equal(env.content.length, 1);
    assert.ok(env.content[0].text.length < 1000, 'none of the oversized result is passed on');
    assert.equal(env.details.error, 'the result was too large to pass on');
    assert.equal(env.details.bundle, 'Made_up');
    assert.match(env.details.hint, /^The result of excel_diag_search came to \d+ characters, more than is passed on in one result\. Ask for less: a smaller limit, a smaller maxChars or a narrower query\.$/);
    assert.ok(Number(/came to (\d+) /.exec(env.details.hint)[1]) > RESULT_MOST);
    const passed = await usual.raw.get('excel_diag_search')({ query: 'pivot' });
    assert.equal(passed.isError, undefined);
    assert.equal(passed.content[1].text.length, RESULT_MOST - 200);
  });

  it('the refusal names only arguments the tool has, and says so when it has none that would help', async () => {
    const p = await loadPlugin({ deps: answers(RESULT_MOST) });
    for (const [name, definition] of p.definitions) {
      const hint = (await p.raw.get(name)({})).details.hint, has = new Set(Object.keys(definition.parameters.properties));
      for (const [argument, said] of Object.entries(ASKS_FOR)) if (said.test(hint)) assert.ok(has.has(argument), `${name} is told to send ${argument}, which it does not take: ${hint}`);
      if (Object.keys(ASKS_FOR).some((a) => has.has(a))) assert.match(hint, / Ask for less: /, name);
      else assert.ok(hint.endsWith(`${name} has no argument that makes its result smaller: tell the human that this result is too large to pass on, and do not send the same call again.`), hint);
    }
    const hint = async (name) => (await p.raw.get(name)({})).details.hint.replace(/^.*in one result\. /, '');
    assert.equal(await hint('excel_diag_memory'), 'excel_diag_memory has no argument that makes its result smaller: tell the human that this result is too large to pass on, and do not send the same call again.');
    assert.equal(await hint('excel_diag_count'), 'Ask for less: a smaller limit, a narrower query or a shorter window.');
    assert.equal(await hint('excel_diag_show'), 'Ask for less: a smaller maxChars.');
    assert.equal(await hint('excel_diag_context'), 'Ask for less: a smaller maxChars, a smaller before and after or a shorter window.');
    assert.equal(await hint('excel_diag_files'), 'Ask for less: a smaller limit or a filter that keeps fewer files.');
    assert.equal(await hint('excel_diag_read_file'), 'Ask for less: a smaller limit or a grep that keeps fewer lines.');
  });

  it('cleanup', async () => { await cleanup(); });
});
