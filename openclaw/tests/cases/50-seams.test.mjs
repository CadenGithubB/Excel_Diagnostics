// The seams between the parts.
//
// The installer, the manifest, the plugin's tools, request mode and the skill were written apart, against one
// agreement. Each of them names the same ten tools, the same arguments and the same result fields, and each has
// cases of its own that pass while its neighbour changes. These cases hold the parts against each other: the
// names in every place, the real files installed into a temp folder and called there, every declared argument
// sent to the program that has to read it, and every call a result offers made as written.
//
// Why it matters to a small model: it acts on names and does not check them. A tool the skill names but the
// configuration does not allow, an argument a schema declares but the program never reads, a field the skill
// tells it to look for that no result carries, a call in a Next: line that the tool then refuses: each of those
// looks to the model like its own mistake, and it answers a mistake by guessing other names.
//
// Nothing here reads or writes the real home folder; "openclaw" and the restart are stand-ins.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { describe, it, assert, loadPlugin, request, sampleBundlesDir, emptyDir, blocks, cleanup, exists, PLUGIN_DIR, CLI_PATH, SKILL_PATH, SAMPLE_ID } from '../harness.mjs';
import { install, PLUGIN_ID, SKILL_NAME, TOOL_NAMES } from '../../plugin/install.mjs';

const PREFIX = 'excel_diag_';
const CLI_FILE = 'excel_diagnostics_cli.mjs';
const INSTALLERS_OWN = ['deploy.sh', 'install.mjs'];      // in the plugin folder, and no part of the plugin
const NO_ANSWER = 'the Excel diagnostics program did not answer';

// Each call starts the program, which indexes the sample bundle again, so they are made several at a time.
async function pooled(items, worker, width = 8) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); }
  }));
  return out;
}

let loaded = null;
const plugin = () => (loaded ??= loadPlugin());
const properties = (t) => t.parameters.properties;
const shape = (v) => (v === null || typeof v !== 'object' ? [] : Object.entries(v).flatMap(([k, x]) => [k, ...shape(x)]));      // every key, at any depth

// ---------- calls as results write them ----------
// A result writes a call as  excel_diag_show {id: 15006, maxChars: 4000} : bare argument names, values as JSON.
function valueAt(text, i) {
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    return [JSON.parse(text.slice(i, j + 1)), j + 1];
  }
  const m = /^(?:true|false|-?\d+(?:\.\d+)?)/.exec(text.slice(i));
  assert.ok(m, `a value that is not a string, a number, true or false at: ${text.slice(i, i + 40)}`);
  return [JSON.parse(m[0]), i + m[0].length];
}
function callsIn(text) {
  const found = [], start = /\b(excel_diag_[a-z_]+) \{/g;
  for (let m; (m = start.exec(text));) {
    const args = {};
    let i = start.lastIndex;
    while (text[i] !== '}') {
      const key = /^([A-Za-z]+): /.exec(text.slice(i));
      assert.ok(key, `an argument name is expected at: ${text.slice(i, i + 40)}`);
      const [value, end] = valueAt(text, i + key[0].length);
      args[key[1]] = value;
      i = text.startsWith(', ', end) ? end + 2 : end;
    }
    found.push({ tool: m[1], args, said: text.slice(m.index, i + 1) });
    start.lastIndex = i + 1;
  }
  return found;
}

// ---------- results to hold the parts against ----------
// Every tool, in the ways that change what a result offers: plain, narrowed, cut short, empty, on the UTC clock,
// with the bundle named. Then the refusals. Ids are read from a result first, as a model would get them.
async function corpus() {
  const p = await plugin();
  const firstId = async (params) => Number(blocks(await p.raw.get('excel_diag_search')(params)).find((b) => /^\s*ID\s/.test(b)).split('\n')[1].trim().split(/\s+/)[0]);
  const entry = await firstId({ query: 'could not grow', limit: 1 }), report = await firstId({ query: 'source:"crash and hang reports"', limit: 1 });
  assert.ok(Number.isInteger(entry) && Number.isInteger(report), 'the sample bundle has both entries');
  const good = [
    ['summary', {}], ['summary', { utc: true }], ['summary', { bundle: 'sample' }],
    ['search', { minSeverity: 'error' }], ['search', { query: 'could not grow', limit: 5 }], ['search', { query: 'could not grow', limit: 3, newest: true }],
    ['search', { query: 'proces:excel pivot', from: '2026-03-10 09:00', to: '2026-03-10 09:01' }], ['search', { query: 'zzzzqq' }],
    ['search', { query: 'process:nosuchprocess' }], ['search', { query: 'pivot', matchCase: true, minSeverity: 'fault' }],
    ['search', { aroundId: entry, window: '5s', minSeverity: 'error', utc: true }], ['search', { query: 'pivot', limit: 500, bundle: 'sample' }],
    ['search', { severity: 'error', limit: 2 }],
    ['count', {}], ['count', { by: 'process', minSeverity: 'error' }], ['count', { by: 'tag' }], ['count', { by: 'file' }], ['count', { by: 'subsystem', limit: 2 }],
    ['count', { query: 'zzzzqq', minSeverity: 'error' }],
    ['histogram', { query: 'tag:memory' }], ['histogram', { aroundTime: '2026-03-10 10:35:00', window: '2m', bins: 5 }], ['histogram', { minSeverity: 'fault', utc: true }],
    ['show', { id: entry }], ['show', { id: report }], ['show', { id: entry, maxChars: 10, utc: true }],
    ['context', { id: entry }], ['context', { time: '2026-03-10 10:32:30', window: '2s' }], ['context', { time: '2026-03-10 10:35:00', window: '1s' }],
    ['context', { time: '2026-03-10 10:35:10', window: '1ms' }], ['context', { id: entry, before: 2, after: 2, utc: true, bundle: 'sample' }],
    ['reports', {}], ['reports', { utc: true }],
    ['files', {}], ['files', { filter: 'report' }], ['files', { filter: 'zzz' }], ['files', { limit: 2 }],
    ['read_file', { path: 'summary.md' }], ['read_file', { path: 'summary.md', limit: 2 }], ['read_file', { path: 'unified_logs/2026-03-10.tsv', grep: 'jetsam', limit: 3 }],
    ['read_file', { path: 'memory.txt', bundle: 'sample' }],
    ['memory', {}], ['memory', { utc: true }],
  ];
  const bad = [
    ['show', {}], ['show', { id: 999999 }], ['show', { id: '7' }], ['context', {}], ['context', { id: 1, time: '2026-03-10 10:00' }], ['context', { id: 999999 }],
    ['search', { window: '30s' }], ['search', { from: '2026-03-10 11:00', to: '2026-03-10 10:00' }], ['search', { from: 'yesterday' }], ['search', { limit: 0 }],
    ['search', { query: 'pivot', offset: 99999 }], ['search', { newest: true, offset: 5 }], ['search', { aroundId: 5, aroundTime: '2026-03-10 10:00' }],
    ['search', { aroundId: 5, from: '2026-03-10 10:00' }], ['search', { aroundId: 999999 }], ['search', { minSeverity: 'severe' }], ['search', { window: 'soon', aroundId: 5 }],
    ['count', { by: 'proc' }], ['histogram', { bins: 0 }], ['files', { offset: 999 }],
    ['read_file', {}], ['read_file', { path: 'ips' }], ['read_file', { path: 'nothere.txt' }], ['read_file', { path: 'summary.md', fromLine: 999 }],
    ['summary', { bundle: 'nope' }], ['summary', { bundle: '../etc' }], ['memory', { utc: 'yes' }],
  ];
  const run = ([op, params]) => p.raw.get(PREFIX + op)(params).then((envelope) => ({ tool: PREFIX + op, params, envelope, details: envelope.details }));
  const [ok, refused] = [await pooled(good, run), await pooled(bad, run)];
  for (const r of ok) assert.equal(r.details.ok, true, `${r.tool} ${JSON.stringify(r.params)}: ${JSON.stringify(r.details).slice(0, 300)}`);
  for (const r of refused) assert.equal(r.details.ok, false, `${r.tool} ${JSON.stringify(r.params)} was expected to be refused`);
  const empty = await loadPlugin({ sample: false });
  refused.push(await empty.raw.get('excel_diag_summary')({}).then((envelope) => ({ tool: 'excel_diag_summary', params: {}, envelope, details: envelope.details })));
  return { ok, refused, all: [...ok, ...refused] };
}
let gathered = null;
const results = () => (gathered ??= corpus());

// ---------- the real files, installed into a temp folder ----------
async function copyFolder(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (e.isDirectory()) await copyFolder(path.join(from, e.name), path.join(to, e.name));
    else await fs.copyFile(path.join(from, e.name), path.join(to, e.name));
  }
}
let installing = null;
function installed() {
  installing ??= (async () => {
    // Resolved first: the installer refuses a path that runs through a link, and the system temp folder is one on macOS.
    const root = await fs.realpath(await emptyDir('seams')), state = path.join(root, 'state'), workspace = path.join(root, 'workspace');
    await fs.mkdir(state);
    await fs.writeFile(path.join(state, 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace } } }), { mode: 0o600 });
    const logs = [], calls = [];
    const result = await install(['--state-dir', state, '--skip-restart'], {
      env: {}, version: '2026.9.4', platform: 'darwin', log: (line) => { logs.push(String(line)); },
      run: async (command, args) => { calls.push([command, ...args].join(' ')); return { stdout: '', stderr: '' }; },
    });
    return { state, workspace, result, logs, calls, pluginDir: path.join(state, 'extensions', PLUGIN_ID), skillFile: path.join(workspace, 'skills', SKILL_NAME, 'SKILL.md') };
  })();
  return installing;
}
// The installed copy of the plugin, registered the way the Gateway would with no configuration of its own.
async function registerInstalled(f) {
  const was = { state: process.env.OPENCLAW_STATE_DIR, bundles: process.env.EXCEL_DIAGNOSTICS_BUNDLES };
  process.env.OPENCLAW_STATE_DIR = f.state;
  delete process.env.EXCEL_DIAGNOSTICS_BUNDLES;
  try {
    const mod = await import(`${pathToFileURL(path.join(f.pluginDir, 'index.js')).href}?seams=${Date.now()}`);
    const tools = new Map(), logs = [];
    mod.default.register({ registerTool: (t) => { tools.set(t.name, (params) => t.execute('seams-call', params)); }, on: () => {}, logger: { info: (m) => { logs.push(String(m)); } } });
    return { tools, logs, mod };
  } finally {
    for (const [key, name] of [['state', 'OPENCLAW_STATE_DIR'], ['bundles', 'EXCEL_DIAGNOSTICS_BUNDLES']]) { if (was[key] === undefined) delete process.env[name]; else process.env[name] = was[key]; }
  }
}

describe('seams: the ten tools are named alike everywhere', () => {
  it('the installer, the manifest, the plugin, what it registers and the skill table name the same ten, in one order', async () => {
    const p = await plugin();
    const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, 'openclaw.plugin.json'), 'utf8'));
    const table = [...(await fs.readFile(SKILL_PATH, 'utf8')).matchAll(/^\| `(excel_diag_\w+)` \|/gm)].map((m) => m[1]);
    const names = p.module.TOOLS.map((t) => t.name);
    assert.equal(names.length, 10);
    assert.equal(new Set(names).size, 10, 'no name twice');
    assert.deepEqual([...TOOL_NAMES], names, 'TOOL_NAMES in install.mjs, which the configuration is given to allow');
    assert.deepEqual(manifest.contracts.tools, names, 'contracts.tools in the manifest');
    assert.deepEqual([...p.definitions.keys()], names, 'what the plugin registers');
    assert.deepEqual(table, names, 'the rows of the skill table');
    assert.equal(manifest.id, PLUGIN_ID);
    assert.equal(p.entry.id, PLUGIN_ID);
  });

  it('the skill is installed under the name its own first lines give', async () => {
    const text = await fs.readFile(SKILL_PATH, 'utf8');
    assert.equal(/^---\nname: (.+)\n/.exec(text)?.[1], SKILL_NAME);
  });

  it('every tool name any result mentions is one of the ten', async () => {
    const p = await plugin(), names = new Set(p.module.TOOLS.map((t) => t.name));
    let seen = 0;
    for (const r of (await results()).all) {
      for (const name of blocks(r.envelope).join('\n').match(/\bexcel_diag_[a-z_]+/g) ?? []) { seen++; assert.ok(names.has(name), `${r.tool} ${JSON.stringify(r.params)} mentions ${name}`); }
    }
    assert.ok(seen > 100, 'the results looked at do name tools');
  });
});

describe('seams: what the installer installs is what runs', () => {
  it('it copies every file the plugin folder holds, apart from its own two, and the built command-line tool', async () => {
    const f = await installed();
    const inRepo = (await fs.readdir(PLUGIN_DIR)).filter((name) => !name.startsWith('.')).sort();
    for (const own of INSTALLERS_OWN) assert.ok(inRepo.includes(own), `${own} is in the plugin folder`);
    const pluginFiles = inRepo.filter((name) => !INSTALLERS_OWN.includes(name));
    assert.deepEqual((await fs.readdir(f.pluginDir)).sort(), [...pluginFiles, CLI_FILE].sort(), 'a file added beside index.js must be added to the installer too');
    for (const name of pluginFiles) assert.deepEqual(await fs.readFile(path.join(f.pluginDir, name)), await fs.readFile(path.join(PLUGIN_DIR, name)), name);
    assert.deepEqual(await fs.readFile(path.join(f.pluginDir, CLI_FILE)), await fs.readFile(CLI_PATH), 'the command-line tool beside the plugin is the built one');
    assert.deepEqual(await fs.readFile(f.skillFile), await fs.readFile(SKILL_PATH));
    assert.deepEqual(await fs.readdir(path.dirname(f.skillFile)), ['SKILL.md'], 'the skill is one file');
    assert.equal(f.result.changed, 6, 'five files and the configuration');
    assert.deepEqual(f.calls, ['openclaw config validate']);
  });

  it('the entry file the host is pointed at is installed, and it needs no file that is not', async () => {
    const f = await installed();
    const pkg = JSON.parse(await fs.readFile(path.join(f.pluginDir, 'package.json'), 'utf8'));
    for (const entry of pkg.openclaw.extensions) assert.ok(await exists(path.join(f.pluginDir, entry)), `${entry} is named in package.json`);
    const source = await fs.readFile(path.join(f.pluginDir, 'index.js'), 'utf8');
    const imports = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.ok(imports.length >= 4);
    for (const from of imports) assert.match(from, /^node:/, `index.js imports ${from}, which the installer does not copy`);
  });

  it('the configuration it writes allows exactly the tools the plugin registers', async () => {
    const f = await installed(), p = await plugin();
    const config = JSON.parse(await fs.readFile(path.join(f.state, 'openclaw.json'), 'utf8')), names = p.module.TOOLS.map((t) => t.name);
    assert.equal(config.plugins.entries[PLUGIN_ID].enabled, true);
    assert.deepEqual(config.tools.alsoAllow, names);
    assert.deepEqual(config.tools.sandbox.tools.alsoAllow, names);
  });

  it('the installed plugin looks for bundles in the folder the installer made and names, and answers from there', async () => {
    const f = await installed(), bundles = path.join(f.state, PLUGIN_ID, 'bundles');
    assert.equal(f.result.bundlesDir, bundles);
    assert.ok(f.logs.includes(`Put diagnostics bundles in this folder: ${bundles}`));
    const { tools, logs } = await registerInstalled(f);
    assert.equal(tools.size, 10);
    const none = await tools.get('excel_diag_summary')({});
    assert.equal(none.details.error, 'no bundles are available', JSON.stringify(none.details));
    // What the owner does next: a bundle goes into that folder, and the same call finds it.
    await copyFolder(path.join(await sampleBundlesDir(), SAMPLE_ID), path.join(bundles, SAMPLE_ID));
    const found = await tools.get('excel_diag_summary')({});
    assert.equal(found.details.ok, true, JSON.stringify(found.details).slice(0, 300));
    assert.equal(found.details.bundle, SAMPLE_ID);
    assert.equal(found.details.entries, 32861);
    assert.deepEqual(found.details.availableBundles, [SAMPLE_ID]);
    assert.deepEqual(logs, [], 'nothing about the configuration or the program needed saying');
    for (const b of blocks(found)) assert.ok(!b.includes(f.state), 'no folder of the host in what the model reads');
  });

  it('the program the installed plugin starts is the copy installed beside it', async () => {
    const f = await installed(), { tools } = await registerInstalled(f), cli = path.join(f.pluginDir, CLI_FILE);
    await fs.rename(cli, `${cli}.aside`);
    try {
      const gone = await tools.get('excel_diag_reports')({});
      assert.equal(gone.details.error, NO_ANSWER);
      assert.match(gone.details.hint, /is not installed on the OpenClaw host/);
    } finally { await fs.rename(`${cli}.aside`, cli); }
    assert.equal((await tools.get('excel_diag_reports')({})).details.ok, true);
  });
});

describe('seams: the arguments a schema declares and the arguments the program reads', () => {
  // Sent the wrong type, an argument the program reads is refused by name. One it never reads changes nothing.
  const WRONG = { string: [7, 'must be a string'], integer: ['seven', 'must be a whole number'], boolean: ['true', 'must be true or false'] };
  const NEEDED = { show: { id: 0 }, context: { id: 0 }, read_file: { path: 'summary.md' } };

  it('every declared argument is read by request mode, as the type its schema gives', async () => {
    const p = await plugin(), bundlesDir = await sampleBundlesDir(), cases = [];
    for (const t of p.module.TOOLS) for (const [name, s] of Object.entries(properties(t))) cases.push({ op: t.name.slice(PREFIX.length), name, type: s.type });
    assert.ok(cases.length > 60);
    await pooled(cases, async ({ op, name, type }) => {
      assert.ok(WRONG[type], `${op}.${name} has a type request mode knows how to check: ${type}`);
      const r = await request({ format: 1, op, bundlesDir, params: { [name]: WRONG[type][0] } });
      assert.equal(r.code, 0);
      assert.deepEqual([r.json.ok, r.json.field, r.json.error], [false, name, `${name} ${WRONG[type][1]}`], `${op} given ${name}: ${JSON.stringify(WRONG[type][0])}`);
      assert.ok(r.json.hint.includes(name), 'and the hint says what to send');
    });
  });

  it('request mode reads no argument that the tool does not declare', async () => {
    const p = await plugin(), bundlesDir = await sampleBundlesDir(), every = [...new Set(p.module.TOOLS.flatMap((t) => Object.keys(properties(t))))];
    await pooled(p.module.TOOLS, async (t) => {
      const op = t.name.slice(PREFIX.length), params = NEEDED[op] ?? {};
      // utc is the one name read for every operation (it is the clock of the whole request). The two tools that
      // print no times do not declare it, the plugin never passes it to them, and it changes nothing there: below.
      const others = every.filter((name) => !Object.hasOwn(properties(t), name) && name !== 'utc');
      assert.ok(others.length >= 9);
      const [plain, stuffed] = await Promise.all([request({ format: 1, op, bundlesDir, params }), request({ format: 1, op, bundlesDir, params: { ...params, ...Object.fromEntries(others.map((name) => [name, ['not', 'read']])) } })]);
      assert.equal(plain.json.ok, true, `${op}: ${plain.stdout.slice(0, 200)}`);
      assert.deepEqual(stuffed.json, plain.json, `${op} read one of: ${others.join(', ')}`);
    });
  });

  it('utc is declared by every tool that prints a time, and changes nothing for the two that print none', async () => {
    const p = await plugin(), bundlesDir = await sampleBundlesDir();
    const without = p.module.TOOLS.filter((t) => !Object.hasOwn(properties(t), 'utc')).map((t) => t.name);
    assert.deepEqual(without, ['excel_diag_files', 'excel_diag_read_file']);
    for (const [op, params] of [['files', {}], ['read_file', { path: 'summary.md' }]]) {
      const [plain, onUtc] = await Promise.all([request({ format: 1, op, bundlesDir, params }), request({ format: 1, op, bundlesDir, params: { ...params, utc: true } })]);
      assert.deepEqual(onUtc.json, plain.json);
      const through = await p.tools.get(PREFIX + op)({ ...params, utc: true });
      assert.deepEqual(through.ignoredFields, ['utc'], 'and through the plugin it is reported, not passed on');
    }
    for (const r of (await results()).ok) {
      if (Object.hasOwn(properties(p.definitions.get(r.tool)), 'utc') && r.tool !== 'excel_diag_count') assert.ok(typeof r.details.timeZone === 'string' || r.details.entries === 0 || r.details.matched === 0 || r.details.reports === 0, `${r.tool} ${JSON.stringify(r.params)} names the clock its times are on`);
    }
  });

  it('the argument a refusal names in field is one the tool has', async () => {
    const p = await plugin();
    let named = 0;
    for (const r of (await results()).refused) {
      assert.ok(typeof r.details.error === 'string' && r.details.error && typeof r.details.hint === 'string' && r.details.hint, `${r.tool} ${JSON.stringify(r.params)} has an error and a hint`);
      if (r.details.field === undefined) continue;
      named++;
      assert.ok(Object.hasOwn(properties(p.definitions.get(r.tool)), r.details.field), `${r.tool} was told to change ${r.details.field}, which it does not have`);
    }
    assert.ok(named >= 25);
  });

  it('an argument a hint names in the form of a field is one of that tool, of a tool the hint names, or a field of a result', async () => {
    const p = await plugin(), all = await results(), resultFields = new Set(all.ok.flatMap((r) => shape(r.details)));
    for (const r of all.refused) {
      const allowed = new Set([...Object.keys(properties(p.definitions.get(r.tool))), ...resultFields]);
      for (const name of r.details.hint.match(/\bexcel_diag_[a-z_]+/g) ?? []) for (const key of Object.keys(properties(p.definitions.get(name)))) allowed.add(key);
      for (const word of r.details.hint.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g) ?? []) assert.ok(allowed.has(word), `${r.tool} ${JSON.stringify(r.params)}: the hint names ${word}`);
    }
  });
});

describe('seams: the calls a result offers', () => {
  it('every call written in a fact or after Next: uses only arguments its tool declares', async () => {
    const p = await plugin();
    let offered = 0;
    for (const r of (await results()).ok) {
      for (const text of blocks(r.envelope).filter((b) => b.startsWith('Next: ') || b.startsWith('Facts about this call:'))) {
        for (const c of callsIn(text)) {
          offered++;
          const declared = properties(p.definitions.get(c.tool));
          for (const [key, value] of Object.entries(c.args)) {
            assert.ok(Object.hasOwn(declared, key), `${r.tool} ${JSON.stringify(r.params)} offers ${c.said}; ${key} is not an argument of ${c.tool}`);
            assert.equal(Number.isInteger(value) ? 'integer' : typeof value, declared[key].type, `${c.said}: ${key} is written as the type the schema gives`);
          }
        }
      }
    }
    assert.ok(offered > 60, `calls were offered: ${offered}`);
  });

  it('every one of those calls, made as written, is answered with ok true and no ignored field', async () => {
    const p = await plugin(), distinct = new Map();
    for (const r of (await results()).ok) for (const text of blocks(r.envelope).filter((b) => b.startsWith('Next: ') || b.startsWith('Facts about this call:'))) for (const c of callsIn(text)) distinct.set(c.said, c);
    assert.ok(distinct.size > 40, `distinct calls: ${distinct.size}`);
    await pooled([...distinct.values()], async (c) => {
      const d = await p.tools.get(c.tool)(c.args);
      assert.equal(d.ok, true, `${c.said} was refused: ${d.error}; ${d.hint}`);
      assert.ok(!('ignoredFields' in d), `${c.said} has a field the tool ignores`);
    });
  });

  it('a call that named its bundle is followed by calls that name it; one that did not is followed by calls that do not', async () => {
    for (const r of (await results()).ok) {
      const next = blocks(r.envelope).find((b) => b.startsWith('Next: '));
      for (const c of next ? callsIn(next) : []) assert.equal(c.args.bundle, 'bundle' in r.params ? SAMPLE_ID : undefined, `${r.tool} ${JSON.stringify(r.params)} then ${c.said}`);
    }
  });

  it('a call on the UTC clock is followed by calls on it, wherever the tool offered has a clock', async () => {
    const p = await plugin();
    let carried = 0;
    for (const r of (await results()).ok) {
      const next = blocks(r.envelope).find((b) => b.startsWith('Next: '));
      for (const c of next ? callsIn(next) : []) {
        const takes = Object.hasOwn(properties(p.definitions.get(c.tool)), 'utc');
        assert.equal(c.args.utc, r.params.utc === true && takes ? true : undefined, `${r.tool} ${JSON.stringify(r.params)} then ${c.said}`);
        if (c.args.utc) carried++;
      }
    }
    assert.ok(carried >= 8);
  });

  it('every Next: ends by saying that replying is allowed, and offers at most three calls', async () => {
    let seen = 0;
    for (const r of (await results()).ok) {
      const b = blocks(r.envelope), next = b.find((x) => x.startsWith('Next: '));
      if (!next) continue;
      seen++;
      assert.equal(b[b.length - 1], next, 'Next: is the last block');
      assert.ok(next.endsWith(' If this answers the question, reply now.'), next);
      const n = callsIn(next).length;
      assert.ok(n >= 1 && n <= 3, `${n} calls offered: ${next}`);
    }
    assert.ok(seen >= 35);
  });
});

describe('seams: the fields the skill names and the fields results carry', () => {
  it('every field the skill names that is not an argument is carried by a real result', async () => {
    const p = await plugin(), all = await results(), text = await fs.readFile(SKILL_PATH, 'utf8');
    const args = new Set(p.module.TOOLS.flatMap((t) => Object.keys(properties(t)))), carried = new Set(all.all.flatMap((r) => shape(r.details)));
    const named = [...new Set([...text.slice(text.indexOf('\n---\n', 4)).matchAll(/`([a-z][A-Za-z]*)(?::[^`]*)?`/g)].map((m) => m[1]))].filter((name) => !args.has(name) && !['args', 'true', 'false'].includes(name));
    assert.ok(named.length >= 15, `fields named: ${named.join(', ')}`);
    for (const name of named) assert.ok(carried.has(name), `SKILL.md names \`${name}\`; no tool takes it and no result here carries it`);
  });

  it('the way on that the skill gives for a cut result is the way on results give', async () => {
    const all = await results();
    const cut = all.ok.filter((r) => r.details.truncated === true);
    assert.ok(cut.length >= 8);
    for (const r of cut) {
      const next = blocks(r.envelope).find((b) => b.startsWith('Next: ')) ?? '', facts = blocks(r.envelope).find((b) => b.startsWith('Facts about this call:')) ?? '';
      const way = 'nextOffset' in r.details || 'nextFromLine' in r.details || callsIn(next).some((c) => c.tool === r.tool) || callsIn(facts).length > 0 || /\b(shorter window|maxChars)\b/.test(facts);
      assert.ok(way, `${r.tool} ${JSON.stringify(r.params)} is cut and gives no way to the rest`);
    }
  });

  it('cleanup', async () => { await cleanup(); });
});
