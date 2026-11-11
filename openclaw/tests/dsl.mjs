/**
 * Test DSL and registry. Lives apart from run.mjs so case files can import it
 * without creating an import cycle with the runner that loads them.
 */
export const suites = [];
let current = null;

/** Group of related specs. */
export function describe(name, fn) {
  current = { name, specs: [] };
  suites.push(current);
  fn();
  current = null;
}

/**
 * A spec. Options:
 *   knownBug: "<finding id>": expected to fail today. Does not fail the run
 *     unless --strict. If it PASSES it is reported as newly fixed, so the
 *     marker gets removed rather than quietly hiding a regression later.
 *   skip: "<reason>"
 */
export function it(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  if (!current) throw new Error(`it(${JSON.stringify(name)}) called outside describe()`);
  current.specs.push({ name, fn, ...opts });
}

/** Called by the runner between files. */
export function reset() { suites.length = 0; current = null; }
