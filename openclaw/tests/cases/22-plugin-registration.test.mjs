// What the plugin tells the host about itself: the manifest, the ten tools, their schemas and descriptions, and
// the configuration it reads.
//
// The schemas are loose on purpose. A call the host's own schema check refuses never reaches the tool, and the
// model is shown the host's refusal of the whole call in place of one sentence naming the argument at fault. So
// nothing is required, nothing is ranged or enumerated and nothing is forbidden; the program answers a wrong call.
//
// A description is all a model knows of a tool before it reads the skill, and it copies from it: the argument
// shape must be the schema's own names, the wrong names it reaches for must be named, and a time must be said to
// be written the way results print it. The six everyday tools must stay in the tool list (direct-only), because
// a search text does not survive the escaping that the wrapper for deferred tools asks of a small model.
//
// Configuration that is wrong must not take the tools down: a bad value falls back to the default and one log
// line says so.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { describe, it, assert, loadPlugin, emptyDir, cleanup, PLUGIN_DIR } from '../harness.mjs';

const NAMES = ['excel_diag_summary', 'excel_diag_search', 'excel_diag_count', 'excel_diag_histogram', 'excel_diag_show',
  'excel_diag_context', 'excel_diag_reports', 'excel_diag_files', 'excel_diag_read_file', 'excel_diag_memory'];
const DIRECT = ['excel_diag_summary', 'excel_diag_search', 'excel_diag_show', 'excel_diag_context', 'excel_diag_reports', 'excel_diag_read_file'];
const FILTERS = { query: 'string', from: 'string', to: 'string', aroundId: 'integer', aroundTime: 'string', window: 'string', minSeverity: 'string', matchCase: 'boolean', utc: 'boolean', bundle: 'string' };
// The argument names and types of each tool, as the build contract lists them for the operation behind it.
const ARGUMENTS = {
  excel_diag_summary: { utc: 'boolean', bundle: 'string' },
  excel_diag_search: { ...FILTERS, limit: 'integer', offset: 'integer', newest: 'boolean', maxChars: 'integer' },
  excel_diag_count: { ...FILTERS, by: 'string', limit: 'integer' },
  excel_diag_histogram: { ...FILTERS, bins: 'integer' },
  excel_diag_show: { id: 'integer', maxChars: 'integer', utc: 'boolean', bundle: 'string' },
  excel_diag_context: { id: 'integer', time: 'string', before: 'integer', after: 'integer', window: 'string', maxChars: 'integer', utc: 'boolean', bundle: 'string' },
  excel_diag_reports: { utc: 'boolean', bundle: 'string' },
  excel_diag_files: { filter: 'string', limit: 'integer', offset: 'integer', bundle: 'string' },
  excel_diag_read_file: { path: 'string', fromLine: 'integer', limit: 'integer', grep: 'string', bundle: 'string' },
  excel_diag_memory: { utc: 'boolean', bundle: 'string' },
};
const MANIFEST = {
  id: 'excel-diagnostics',
  name: 'Excel Diagnostics',
  description: 'Read-only search of Excel diagnostics log bundles kept in a folder on the host.',
  version: '1.0.0',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      bundlesDir: { type: 'string', description: 'Absolute path of the folder that holds the bundles (zips or unzipped folders). Default: <OpenClaw state folder>/excel-diagnostics/bundles. Takes effect on gateway restart.' },
      timeoutSeconds: { type: 'integer', minimum: 5, maximum: 600, description: 'Longest one tool call may take. Default 120. Takes effect on gateway restart.' },
    },
  },
  activation: { onStartup: true },
  contracts: { tools: NAMES },
};
const readJson = async (name) => JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, name), 'utf8'));

describe('plugin registration: manifest and entry', () => {
  it('the manifest is the agreed one, key for key', async () => {
    const manifest = await readJson('openclaw.plugin.json');
    assert.deepEqual(manifest, MANIFEST);
    assert.deepEqual(Object.keys(manifest), ['id', 'name', 'description', 'version', 'configSchema', 'activation', 'contracts']);
  });

  it('package.json points the host at index.js and asks for nothing to be installed', async () => {
    const pkg = await readJson('package.json');
    assert.equal(pkg.name, 'openclaw-plugin-excel-diagnostics');
    assert.equal(pkg.version, '1.0.0');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.private, true);
    assert.ok(typeof pkg.description === 'string' && pkg.description.length > 0 && !pkg.description.includes('\n'));
    assert.deepEqual(pkg.openclaw, { extensions: ['./index.js'] });
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) assert.equal(pkg[key], undefined, `no ${key}`);
    assert.equal(pkg.version, (await readJson('openclaw.plugin.json')).version, 'one version in both files');
  });

  it('the entry is a plain object with the manifest\'s id, and imports nothing but Node\'s own modules', async () => {
    const p = await loadPlugin();
    assert.deepEqual(Object.keys(p.entry), ['id', 'name', 'description', 'register']);
    assert.equal(p.entry.id, MANIFEST.id);
    assert.equal(p.entry.name, MANIFEST.name);
    assert.equal(p.entry.description, MANIFEST.description);
    assert.equal(p.entry.register, p.module.register);
    const source = await fs.readFile(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
    const imported = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.ok(imported.length >= 3);
    assert.deepEqual(imported.filter((name) => !name.startsWith('node:')), []);
    assert.ok(!/\bimport\(|\brequire\(/.test(source), 'nothing is loaded later either');
  });

  it('the manifest, the registered tools and TOOLS name the same ten tools in the same order', async () => {
    const p = await loadPlugin();
    assert.deepEqual([...p.definitions.keys()], NAMES);
    assert.deepEqual(p.module.TOOLS.map((t) => t.name), NAMES);
    assert.deepEqual((await readJson('openclaw.plugin.json')).contracts.tools, NAMES);
    assert.equal(new Set(NAMES).size, 10);
  });

  it('TOOLS holds what is registered: name, description and parameters', async () => {
    const p = await loadPlugin();
    for (const t of p.module.TOOLS) {
      assert.deepEqual(Object.keys(t), ['name', 'description', 'parameters']);
      const def = p.definitions.get(t.name);
      assert.equal(def.description, t.description);
      assert.deepEqual(def.parameters, t.parameters);
      assert.equal(typeof def.execute, 'function');
      assert.deepEqual(Object.keys(def).filter((k) => !['name', 'description', 'parameters', 'catalogMode', 'execute'].includes(k)), []);
    }
  });

  it('the six everyday tools are direct-only and the other four stay deferred', async () => {
    const p = await loadPlugin();
    assert.ok(p.module.DIRECT_TOOLS instanceof Set);
    assert.deepEqual([...p.module.DIRECT_TOOLS].sort(), [...DIRECT].sort());
    for (const name of NAMES) {
      const def = p.definitions.get(name);
      if (DIRECT.includes(name)) assert.equal(def.catalogMode, 'direct-only', `${name} stays in the tool list`);
      else { assert.equal(def.catalogMode, undefined, `${name} stays deferred`); assert.ok(!('catalogMode' in def)); }
    }
  });

  it('only the repeat guard is hooked', async () => {
    const p = await loadPlugin();
    assert.deepEqual([...p.hooks.keys()], ['before_tool_call']);
    assert.equal(typeof p.hook, 'function');
  });

  it('a host that lacks a member is harmless, and only the four agreed members are read', async () => {
    const { module: mod } = await loadPlugin();
    const run = async () => ({ code: 0, stdout: '{"ok":true}' });
    assert.doesNotThrow(() => mod.register({}, { run }));
    assert.doesNotThrow(() => mod.register({ pluginConfig: { bundlesDir: 'relative' } }, { run }), 'a log line with no logger');
    assert.doesNotThrow(() => mod.register({ pluginConfig: { bundlesDir: 'relative' }, logger: {} }, { run }));
    assert.doesNotThrow(() => mod.register({ pluginConfig: { bundlesDir: 'relative' }, logger: { info() { throw new Error('log is closed'); } } }, { run }));
    assert.doesNotThrow(() => mod.register({ on() {} }, { run }));
    assert.doesNotThrow(() => mod.register({ registerTool() {} }), 'no second argument');
    assert.doesNotThrow(() => mod.register({ registerTool() {} }, null));
    const tools = [];
    mod.register({ registerTool: (t) => tools.push(t.name) }, { run });
    assert.deepEqual(tools, NAMES, 'tools register without the hook');

    const read = new Set();
    const host = { pluginConfig: {}, registerTool() {}, on() {}, logger: { info() {} }, config: { secret: true }, runtime: {}, registerCommand() {} };
    mod.register(new Proxy(host, { get(target, key) { read.add(key); return target[key]; } }), { run });
    assert.deepEqual([...read].filter((k) => !['pluginConfig', 'registerTool', 'on', 'logger'].includes(k)), []);
  });
});

describe('plugin registration: schemas', () => {
  it('each tool declares exactly the arguments of its operation, with their types, in order', async () => {
    const { module: mod } = await loadPlugin();
    for (const t of mod.TOOLS) {
      const declared = Object.fromEntries(Object.entries(t.parameters.properties).map(([k, v]) => [k, v.type]));
      assert.deepEqual(declared, ARGUMENTS[t.name], t.name);
      assert.deepEqual(Object.keys(t.parameters.properties), Object.keys(ARGUMENTS[t.name]), `${t.name}: order`);
    }
  });

  it('the schemas are loose: nothing required, forbidden, ranged or enumerated', async () => {
    const { module: mod } = await loadPlugin();
    const banned = ['additionalProperties', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format',
      'minLength', 'maxLength', 'minItems', 'maxItems', 'oneOf', 'anyOf', 'allOf', 'not', 'default'];
    for (const t of mod.TOOLS) {
      const s = t.parameters;
      assert.deepEqual(Object.keys(s), ['type', 'properties', 'required'], t.name);
      assert.equal(s.type, 'object');
      assert.deepEqual(s.required, []);
      for (const [name, prop] of Object.entries(s.properties)) {
        assert.deepEqual(Object.keys(prop), ['type', 'description'], `${t.name}.${name}`);
        assert.ok(['string', 'integer', 'boolean'].includes(prop.type), `${t.name}.${name} is ${prop.type}`);
      }
      // A banned keyword is looked for as a key anywhere in the schema, so a nested one cannot slip in.
      const keys = [];
      JSON.stringify(s, (key, value) => { keys.push(key); return value; });
      for (const word of banned) assert.ok(!keys.includes(word), `${t.name} uses ${word}`);
    }
  });

  it('tools do not share schema objects, so a host that changes one changes one', async () => {
    const { module: mod } = await loadPlugin();
    const seen = new Set();
    for (const t of mod.TOOLS) {
      for (const o of [t.parameters, t.parameters.properties, ...Object.values(t.parameters.properties)]) {
        assert.ok(!seen.has(o), `${t.name} shares an object with another tool`);
        seen.add(o);
      }
    }
  });
});

describe('plugin registration: descriptions', () => {
  it('each tool description leads with the argument shape, and the shape is the schema\'s own names', async () => {
    const { module: mod } = await loadPlugin();
    for (const t of mod.TOOLS) {
      const m = /^[A-Z][^{}]*: \{([^{}]*)\}/.exec(t.description);
      assert.ok(m, `${t.name} does not open with "What it does: {arguments}": ${t.description.slice(0, 80)}`);
      assert.ok(m.index === 0 && t.description.indexOf('{') < 80, `${t.name}: the shape comes first`);
      const shape = m[1].split(',').map((s) => s.trim());
      assert.deepEqual(shape.map((s) => s.replace(/\?$/, '')), Object.keys(t.parameters.properties), `${t.name}: shape against schema`);
      // The program asks for id and for path; everything else may be left out, and the shape says so with "?".
      const needed = { excel_diag_show: ['id'], excel_diag_read_file: ['path'] }[t.name] ?? [];
      assert.deepEqual(shape.filter((s) => !s.endsWith('?')), needed, `${t.name}: which arguments have no "?"`);
    }
  });

  it('descriptions stay short enough for the host to show whole', async () => {
    const { module: mod } = await loadPlugin();
    for (const t of mod.TOOLS) {
      assert.ok(t.description.length < 450, `${t.name}: ${t.description.length} characters`);
      assert.ok(!t.description.includes('\n'));
      for (const [name, prop] of Object.entries(t.parameters.properties)) {
        assert.ok(prop.description.length >= 20 && prop.description.length < 200, `${t.name}.${name}: ${prop.description.length} characters`);
        assert.ok(!prop.description.includes('\n'));
      }
    }
  });

  it('each tool description shows one value to send', async () => {
    const { module: mod } = await loadPlugin();
    for (const t of mod.TOOLS) assert.ok(/e\.g\. |with \{\}/.test(t.description), `${t.name} shows no example`);
  });

  it('the wrong names a model reaches for are named where the right one is described', async () => {
    const { module: mod } = await loadPlugin();
    const tool = (name) => mod.TOOLS.find((t) => t.name === name);
    const said = { excel_diag_search: ["'q'", "'pattern'"], excel_diag_count: ["'groupBy'"], excel_diag_histogram: ["'buckets'"], excel_diag_show: ["'entry'", "'index'"],
      excel_diag_context: ["'entry'", "'aroundId'"], excel_diag_files: ["'query'", "'pattern'"], excel_diag_read_file: ["'file'", "'filename'"] };
    for (const [name, wrong] of Object.entries(said)) {
      for (const w of wrong) assert.ok(tool(name).description.includes(w), `${name} does not say ${w} is not accepted`);
      assert.ok(/\bnot '/.test(tool(name).description));
    }
    const params = { query: "'q'", id: "'entry'", path: "'filename'", minSeverity: "'severity'", bundle: "'name'", by: "'groupBy'", bins: "'buckets'", time: "'aroundTime'", grep: "'pattern'", filter: "'pattern'", fromLine: "'offset'" };
    for (const t of mod.TOOLS) {
      for (const [name, prop] of Object.entries(t.parameters.properties)) {
        if (params[name]) assert.ok(prop.description.includes(params[name]), `${t.name}.${name} does not say ${params[name]} is not accepted`);
      }
    }
  });

  it('a value to copy is said to come from a named column or field of a named tool', async () => {
    const { module: mod } = await loadPlugin();
    const tool = (name) => mod.TOOLS.find((t) => t.name === name);
    assert.ok(tool('excel_diag_show').description.includes('ID column of excel_diag_search or excel_diag_context'));
    assert.ok(tool('excel_diag_context').description.includes('ID column of excel_diag_search'));
    assert.ok(tool('excel_diag_search').description.includes('ID column'));
    assert.ok(tool('excel_diag_read_file').description.includes('PATH column of excel_diag_files or the FILE column of excel_diag_reports'));
    assert.ok(tool('excel_diag_files').description.includes('path of excel_diag_read_file'));
    assert.ok(tool('excel_diag_reports').description.includes('path of excel_diag_read_file'));
    assert.ok(tool('excel_diag_summary').description.includes('availableBundles'));
    for (const t of mod.TOOLS) assert.ok(t.parameters.properties.bundle.description.includes('availableBundles in excel_diag_summary'), `${t.name}.bundle`);
    for (const name of ['excel_diag_search', 'excel_diag_files']) assert.ok(tool(name).parameters.properties.offset.description.includes('nextOffset'));
    assert.ok(tool('excel_diag_read_file').parameters.properties.fromLine.description.includes('nextFromLine'));
  });

  it('every time is described as written the way results print times', async () => {
    const { module: mod } = await loadPlugin();
    let times = 0;
    for (const t of mod.TOOLS) {
      for (const name of ['from', 'to', 'aroundTime', 'time']) {
        const prop = t.parameters.properties[name];
        if (!prop) continue;
        times++;
        assert.ok(prop.description.includes('written the way results print times'), `${t.name}.${name}`);
      }
    }
    assert.equal(times, 10);
    assert.ok(mod.TOOLS.find((t) => t.name === 'excel_diag_context').description.includes('written the way results print times'));
  });

  it('truncated is explained wherever a result can be cut', async () => {
    const { module: mod } = await loadPlugin();
    for (const name of ['excel_diag_search', 'excel_diag_show', 'excel_diag_context', 'excel_diag_reports', 'excel_diag_files', 'excel_diag_read_file']) {
      assert.ok(mod.TOOLS.find((t) => t.name === name).description.includes('truncated:true means'), name);
    }
  });

  it('a size is described without a figure, which a small model would take for the number to send', async () => {
    const { module: mod } = await loadPlugin();
    let sizes = 0;
    for (const t of mod.TOOLS) {
      for (const name of ['limit', 'maxChars', 'before', 'after', 'bins', 'offset']) {
        const prop = t.parameters.properties[name];
        if (!prop) continue;
        sizes++;
        assert.ok(!/\d/.test(prop.description), `${t.name}.${name}: ${prop.description}`);
        assert.ok(prop.description.includes('a whole number without quotation marks'), `${t.name}.${name}`);
      }
      assert.ok(!/\b(limit|maxChars|bins|before|after|offset): \d/.test(t.description), `${t.name}: a size is shown with a figure`);
    }
    assert.equal(sizes, 12);
  });

  it('no description shows a path on the host, states a limit, or says what caused anything', async () => {
    const { module: mod } = await loadPlugin();
    for (const t of mod.TOOLS) {
      for (const text of [t.description, ...Object.values(t.parameters.properties).map((p) => p.description)]) {
        assert.ok(!/(^|[\s"'(])\/(Users|home|var|tmp|private|opt|usr|Applications)\b/.test(text) && !text.includes('~/') && !text.includes('.openclaw'), `a host path: ${text}`);
        assert.ok(!/\b(at most|up to|no more than|maximum|by default|defaults? to)\b/i.test(text), `a limit stated: ${text}`);
        assert.ok(!/\b(caused|because|the cause|root cause|why)\b/i.test(text), `a cause stated: ${text}`);
      }
    }
  });
});

describe('plugin registration: configuration', () => {
  // The request each call would send, seen by a stand-in for the program. Registers again on the loaded module so
  // the environment can be set for that one registration, and is put back afterwards.
  async function settingsFor(pluginConfig, env = {}) {
    const { module: mod } = await loadPlugin();
    const seen = [], logs = [];
    let execute = null;
    const saved = {};
    for (const key of ['OPENCLAW_STATE_DIR', 'EXCEL_DIAGNOSTICS_BUNDLES']) {
      saved[key] = process.env[key];
      if (key in env) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    }
    try {
      mod.register({
        pluginConfig,
        logger: { info: (m) => logs.push(String(m)) },
        registerTool(t) { if (t.name === 'excel_diag_summary') execute = t.execute; },
        on() {},
      }, { run: async (request, options) => { seen.push({ request, options }); return { code: 0, stdout: '{"ok":true}' }; } });
      const state = process.env.OPENCLAW_STATE_DIR;
      await execute('test-call', {});
      assert.equal(seen.length, 1);
      return { request: seen[0].request, options: seen[0].options, logs, state };
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }
  const usual = (state) => ({ bundlesDir: path.join(state, 'excel-diagnostics', 'bundles'), cacheDir: path.join(state, 'excel-diagnostics', 'cache') });

  it('bundlesDir from the plugin configuration is used, and unpacked zips go under the state folder', async () => {
    const dir = await emptyDir('bundles');
    const s = await settingsFor({ bundlesDir: dir }, { EXCEL_DIAGNOSTICS_BUNDLES: '/somewhere/else' });
    assert.deepEqual(s.request, { format: 1, op: 'summary', bundlesDir: dir, cacheDir: usual(s.state).cacheDir, params: {} });
    assert.deepEqual(s.logs, []);
  });

  it('with no configuration, the environment names the folder', async () => {
    const dir = await emptyDir('bundles');
    for (const config of [undefined, null, {}, { bundlesDir: null }]) {
      const s = await settingsFor(config, { EXCEL_DIAGNOSTICS_BUNDLES: dir });
      assert.equal(s.request.bundlesDir, dir);
      assert.equal(s.request.cacheDir, usual(s.state).cacheDir);
      assert.deepEqual(s.logs, []);
    }
  });

  it('with neither, the folder is under the OpenClaw state folder', async () => {
    const s = await settingsFor(undefined, { EXCEL_DIAGNOSTICS_BUNDLES: undefined });
    assert.equal(s.request.bundlesDir, usual(s.state).bundlesDir);
    assert.equal(s.request.cacheDir, usual(s.state).cacheDir);
    assert.deepEqual(s.logs, []);
    const empty = await settingsFor({}, { EXCEL_DIAGNOSTICS_BUNDLES: '' });
    assert.equal(empty.request.bundlesDir, usual(empty.state).bundlesDir, 'an empty variable is an unset one');
    assert.deepEqual(empty.logs, []);
  });

  it('with no state folder named, it is .openclaw in the home folder', async () => {
    const home = path.join(os.homedir(), '.openclaw');
    for (const state of [undefined, '', 'relative/state']) {
      const s = await settingsFor({}, { OPENCLAW_STATE_DIR: state, EXCEL_DIAGNOSTICS_BUNDLES: undefined });
      assert.deepEqual({ bundlesDir: s.request.bundlesDir, cacheDir: s.request.cacheDir }, usual(home), `OPENCLAW_STATE_DIR ${JSON.stringify(state)}`);
    }
  });

  it('a bundlesDir that is not an absolute path is rejected in favour of the default, with one log line', async () => {
    for (const bad of ['bundles', './bundles', '~/bundles', '', 42, true, ['/a'], { path: '/a' }]) {
      const s = await settingsFor({ bundlesDir: bad }, { EXCEL_DIAGNOSTICS_BUNDLES: '/somewhere/else' });
      assert.equal(s.request.bundlesDir, usual(s.state).bundlesDir, `bundlesDir ${JSON.stringify(bad)}`);
      assert.equal(s.logs.length, 1, `one log line for ${JSON.stringify(bad)}`);
      assert.ok(s.logs[0].startsWith('excel-diagnostics: bundlesDir in the plugin configuration is not an absolute path'), s.logs[0]);
      assert.ok(!s.logs[0].includes('\n'));
    }
  });

  it('a relative folder in the environment is rejected the same way', async () => {
    const s = await settingsFor({}, { EXCEL_DIAGNOSTICS_BUNDLES: 'bundles/here' });
    assert.equal(s.request.bundlesDir, usual(s.state).bundlesDir);
    assert.equal(s.logs.length, 1);
    assert.ok(s.logs[0].startsWith('excel-diagnostics: EXCEL_DIAGNOSTICS_BUNDLES in the environment is not an absolute path'), s.logs[0]);
  });

  it('timeoutSeconds is used from 5 to 600, and anything else becomes 120 with one log line', async () => {
    assert.equal((await settingsFor({})).options.timeoutMs, 120000);
    for (const good of [5, 30, 600]) {
      const s = await settingsFor({ timeoutSeconds: good });
      assert.equal(s.options.timeoutMs, good * 1000);
      assert.deepEqual(s.logs, []);
    }
    for (const bad of [4, 601, 0, -30, 12.5, '30', true, NaN, Infinity, [30], {}]) {
      const s = await settingsFor({ timeoutSeconds: bad });
      assert.equal(s.options.timeoutMs, 120000, `timeoutSeconds ${String(bad)}`);
      assert.equal(s.logs.length, 1, `one log line for ${String(bad)}`);
      assert.ok(s.logs[0].startsWith('excel-diagnostics: timeoutSeconds in the plugin configuration is not a whole number from 5 to 600'), s.logs[0]);
    }
  });

  it('a pluginConfig that is not an object is no configuration', async () => {
    for (const config of ['text', 7, ['a'], true]) {
      const s = await settingsFor(config, { EXCEL_DIAGNOSTICS_BUNDLES: undefined });
      assert.equal(s.request.bundlesDir, usual(s.state).bundlesDir);
      assert.equal(s.options.timeoutMs, 120000);
    }
  });

  it('a bundles folder that holds the cache folder gets no cache folder inside it', async () => {
    // The program refuses a cache folder inside the bundles folder, which would fail every call.
    const { state } = await settingsFor({});
    for (const dir of [state, path.join(state, 'excel-diagnostics'), path.join(state, 'excel-diagnostics', 'cache')]) {
      const s = await settingsFor({ bundlesDir: dir }, { OPENCLAW_STATE_DIR: state });
      assert.equal(s.request.bundlesDir, dir);
      assert.ok(!('cacheDir' in s.request), `no cacheDir is sent for ${path.relative(state, dir) || 'the state folder'}`);
      assert.equal(s.logs.length, 1);
    }
  });

  it('the settings are read once, when the plugin is registered', async () => {
    const dir = await emptyDir('bundles');
    const config = { bundlesDir: dir, timeoutSeconds: 30 };
    const seen = [];
    const p = await loadPlugin({ pluginConfig: config, deps: { run: async (request, options) => { seen.push({ request, options }); return { code: 0, stdout: '{"ok":true}' }; } } });
    config.bundlesDir = '/changed/later';
    config.timeoutSeconds = 600;
    process.env.EXCEL_DIAGNOSTICS_BUNDLES = '/changed/later';
    try { await p.tools.get('excel_diag_files')({}); } finally { delete process.env.EXCEL_DIAGNOSTICS_BUNDLES; }
    assert.equal(seen[0].request.bundlesDir, dir);
    assert.equal(seen[0].options.timeoutMs, 30000);
  });

  it('cleanup', async () => { await cleanup(); });
});
