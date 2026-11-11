#!/usr/bin/env node
/**
 * Zero-dependency test runner for the Excel diagnostics OpenClaw plugin.
 *
 *   node openclaw/tests/run.mjs               # run everything
 *   node openclaw/tests/run.mjs request guard # only case files matching a substring
 *   node openclaw/tests/run.mjs --bugs        # only the known-bug specs
 *   node openclaw/tests/run.mjs --strict      # known bugs FAIL the run (use after fixing)
 *
 * Also runs under Deno: deno run -A openclaw/tests/run.mjs
 *
 * Why a hand-rolled runner: the plugin has no dependencies and no package manager is assumed on the
 * host. node:test is not portable to Deno, so the runner is about a hundred lines instead.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { suites, reset } from './dsl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = (globalThis.Deno?.args ?? process.argv.slice(2));
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')));
const FILTERS = argv.filter((a) => !a.startsWith('--'));
const STRICT = FLAGS.has('--strict');
const ONLY_BUGS = FLAGS.has('--bugs');

const C = process.stdout?.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

const results = { pass: 0, fail: 0, bug: 0, fixed: 0, skip: 0, failures: [], fixedList: [] };

async function runSpec(suite, spec) {
  const label = `${suite.name} > ${spec.name}`;
  if (spec.skip) { results.skip++; console.log(`  ${C.d}- skip${C.x} ${spec.name} ${C.d}(${spec.skip})${C.x}`); return; }
  if (ONLY_BUGS && !spec.knownBug) return;
  let err = null;
  try {
    await spec.fn();
  } catch (e) {
    err = e;
  }
  if (spec.knownBug) {
    if (err) {
      results.bug++;
      console.log(`  ${C.y}o bug ${C.x}${spec.name} ${C.d}[${spec.knownBug}]${C.x}`);
      if (STRICT) { results.fail++; results.failures.push({ label, err }); }
    } else {
      results.fixed++;
      results.fixedList.push(`${label} [${spec.knownBug}]`);
      console.log(`  ${C.g}* FIXED${C.x} ${spec.name} ${C.d}[${spec.knownBug}] remove the knownBug marker${C.x}`);
    }
    return;
  }
  if (err) {
    results.fail++;
    results.failures.push({ label, err });
    console.log(`  ${C.r}x fail${C.x} ${spec.name}`);
  } else {
    results.pass++;
    console.log(`  ${C.g}ok${C.x} ${spec.name}`);
  }
}

const files = (await fs.readdir(path.join(HERE, 'cases')))
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !FILTERS.length || FILTERS.some((s) => f.includes(s)))
  .sort();

if (!files.length) { console.error('no test files matched'); process.exit(1); }

for (const f of files) {
  reset();
  await import(new URL(`./cases/${f}`, import.meta.url).href);
  console.log(`\n${C.b}${f}${C.x}`);
  for (const suite of suites) {
    if (ONLY_BUGS && !suite.specs.some((s) => s.knownBug)) continue;
    console.log(` ${C.d}${suite.name}${C.x}`);
    for (const spec of suite.specs) await runSpec(suite, spec);
  }
}

console.log(`\n${'-'.repeat(60)}`);
console.log(
  `${C.g}${results.pass} passing${C.x}` +
  (results.bug ? `  ${C.y}${results.bug} known bugs${C.x}` : '') +
  (results.fail ? `  ${C.r}${results.fail} failing${C.x}` : '') +
  (results.fixed ? `  ${C.g}${C.b}${results.fixed} newly fixed${C.x}` : '') +
  (results.skip ? `  ${C.d}${results.skip} skipped${C.x}` : '')
);

if (results.fixedList.length) {
  console.log(`\n${C.g}${C.b}Newly passing, these defects appear fixed:${C.x}`);
  for (const l of results.fixedList) console.log(`  * ${l}`);
}
if (results.failures.length) {
  console.log(`\n${C.r}${C.b}Failures:${C.x}`);
  for (const { label, err } of results.failures) {
    console.log(`\n  ${C.r}x${C.x} ${label}`);
    console.log(`    ${String(err?.message ?? err).split('\n').join('\n    ')}`);
  }
}
console.log('');
const code = results.fail > 0 ? 1 : 0;
if (globalThis.Deno) Deno.exit(code); else process.exit(code);
