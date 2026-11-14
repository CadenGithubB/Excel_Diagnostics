// The plugin's own ceiling on one result, whatever the program printed.
//
// The program cuts what a bundle can make long. This is the second lock: a result over 200,000 characters is not
// handed to the model at all, because one such result can fill the whole of a small model's context. What the model
// gets in its place has to be something it can act on, so the refusal names only arguments the tool it called
// really has. Told to send "a smaller limit" to a tool with no limit, a small model sends one anyway, the plugin
// reports the argument as ignored, and the same oversized result comes back.
import { describe, it, assert, loadPlugin, cleanup } from '../harness.mjs';

// A stand-in for the program: one result whose text block has `chars` characters.
const answers = (chars) => ({ run: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, bundle: 'Made_up', notes: [], receipt: { entries: 1 }, text: 'x'.repeat(chars) }) }) });
const ASKS_FOR = { limit: /a smaller limit/, maxChars: /a smaller maxChars/, query: /a narrower query/, filter: /a filter that/, grep: /a grep that/, before: /a smaller before and after/, window: /a shorter window/, bins: /fewer bins/ };

describe('plugin: one result is never more than 200,000 characters', () => {
  it('a larger one is refused, and a result under the ceiling is passed on', async () => {
    const big = await loadPlugin({ deps: answers(300000) }), usual = await loadPlugin({ deps: answers(150000) });
    const env = await big.raw.get('excel_diag_search')({ query: 'pivot' });
    assert.equal(env.isError, true);
    assert.equal(env.content.length, 1);
    assert.ok(env.content[0].text.length < 1000, 'none of the oversized result is passed on');
    assert.equal(env.details.error, 'the result was too large to pass on');
    assert.equal(env.details.bundle, 'Made_up');
    assert.match(env.details.hint, /^The result of excel_diag_search came to 30\d{4} characters, more than is passed on in one result\. Ask for less: a smaller limit, a smaller maxChars or a narrower query\.$/);
    const passed = await usual.raw.get('excel_diag_search')({ query: 'pivot' });
    assert.equal(passed.isError, undefined);
    assert.equal(passed.content[1].text.length, 150000);
  });

  it('the refusal names only arguments the tool has, and says so when it has none that would help', async () => {
    const p = await loadPlugin({ deps: answers(300000) });
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
