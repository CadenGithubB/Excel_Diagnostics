// The installer's configuration edit as a pure function, the names it exports, and the page the owner reads.
//
// What this pins: exactly four configuration entries are added; "plugins.allow" is extended only when it already
// exists; nothing is added twice; the input and every unrelated key are left alone; a value of the wrong type
// stops the edit instead of being overwritten; importing install.mjs does nothing; INSTALL.md names the same
// folders, keys and options the installer uses.
//
// Why it matters to a small model: a tool missing from either allow list is a tool the model is told about by
// the skill and then refused by the host, and it answers a host refusal by trying other names. All ten names
// must be in both lists, spelled as the plugin registers them.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, it, assert, emptyDir, cleanup, RUNTIME, PLUGIN_DIR } from '../harness.mjs';
import * as installer from '../../plugin/install.mjs';

const { install, updateConfiguration, PLUGIN_ID, SKILL_NAME, TOOL_NAMES } = installer;
const INSTALL_MD = path.join(path.dirname(PLUGIN_DIR), 'INSTALL.md');

describe('installer: the configuration edit', () => {
  it('an empty configuration gains the plugin entry and both tool lists, and no plugins.allow', () => {
    assert.deepEqual(updateConfiguration({}), {
      plugins: { entries: { [PLUGIN_ID]: { enabled: true } } },
      tools: { alsoAllow: [...TOOL_NAMES], sandbox: { tools: { alsoAllow: [...TOOL_NAMES] } } },
    });
  });

  it('plugins.allow is extended when it exists, even when empty, and never created', () => {
    assert.deepEqual(updateConfiguration({ plugins: { allow: [] } }).plugins.allow, [PLUGIN_ID]);
    assert.deepEqual(updateConfiguration({ plugins: { allow: ['a', 'b'] } }).plugins.allow, ['a', 'b', PLUGIN_ID]);
    assert.equal('allow' in updateConfiguration({ plugins: { entries: {} } }).plugins, false);
    assert.equal('allow' in updateConfiguration({ plugins: { deny: ['x'] } }).plugins, false);
  });

  it('editing an edited configuration changes nothing more', () => {
    const start = { plugins: { allow: ['other'], entries: { other: { enabled: true } } }, tools: { alsoAllow: ['excel_diag_show', 'x'], sandbox: { tools: { alsoAllow: [] } } } };
    const once = updateConfiguration(start);
    assert.deepEqual(updateConfiguration(once), once);
    assert.equal(JSON.stringify(updateConfiguration(once)), JSON.stringify(once), 'key order is stable too, so the file is not rewritten');
    for (const name of TOOL_NAMES) {
      assert.equal(once.tools.alsoAllow.filter((value) => value === name).length, 1, name);
      assert.equal(once.tools.sandbox.tools.alsoAllow.filter((value) => value === name).length, 1, name);
    }
  });

  it('the input is not modified and unrelated keys come back unchanged', () => {
    const settings = { bundlesDir: '/somewhere/bundles', timeoutSeconds: 300 };
    const start = {
      agents: { defaults: { workspace: '/somewhere/ws' } },
      plugins: { load: { paths: ['/p'] }, entries: { other: { enabled: false }, [PLUGIN_ID]: { enabled: false, config: settings, hooks: { allowConversationAccess: false } } } },
      tools: { deny: ['exec'], toolSearch: { enabled: true, mode: 'directory' }, sandbox: { mode: 'all', tools: { deny: ['process'] } } },
    };
    const copy = structuredClone(start);
    const next = updateConfiguration(start);
    assert.deepEqual(start, copy, 'the configuration passed in must not be touched');
    assert.deepEqual(next.agents, start.agents);
    assert.deepEqual(next.plugins.load, start.plugins.load);
    assert.deepEqual(next.plugins.entries.other, { enabled: false }, 'another plugin stays switched off');
    assert.deepEqual(next.plugins.entries[PLUGIN_ID], { enabled: true, config: settings, hooks: { allowConversationAccess: false } });
    assert.deepEqual(next.tools.deny, ['exec']);
    assert.deepEqual(next.tools.toolSearch, start.tools.toolSearch);
    assert.equal(next.tools.sandbox.mode, 'all');
    assert.deepEqual(next.tools.sandbox.tools.deny, ['process']);
    assert.equal('allow' in next.tools, false, 'a tools.allow list is never created');
  });

  it('a value of the wrong type stops the edit instead of being replaced', () => {
    for (const [config, pattern] of [
      [null, /OpenClaw config must be an object/],
      [[], /OpenClaw config must be an object/],
      [{ plugins: 'on' }, /plugins must be an object/],
      [{ plugins: { entries: [] } }, /plugins\.entries must be an object/],
      [{ plugins: { entries: { [PLUGIN_ID]: true } } }, /excel-diagnostics must be an object/],
      [{ plugins: { allow: 'excel-diagnostics' } }, /allow must be a string array/],
      [{ plugins: { allow: ['a', 1] } }, /allow must be a string array/],
      [{ plugins: { allow: null } }, /allow must be a string array/],
      [{ tools: { alsoAllow: null } }, /alsoAllow must be a string array/],
      [{ tools: [] }, /tools must be an object/],
      [{ tools: { alsoAllow: { a: true } } }, /alsoAllow must be a string array/],
      [{ tools: { sandbox: true } }, /tools\.sandbox must be an object/],
      [{ tools: { sandbox: { tools: { alsoAllow: 'all' } } } }, /alsoAllow must be a string array/],
    ]) assert.throws(() => updateConfiguration(config), pattern, JSON.stringify(config));
  });
});

describe('installer: the module', () => {
  it('exports the plugin id, the skill name and the ten tool names', () => {
    assert.equal(PLUGIN_ID, 'excel-diagnostics');
    assert.equal(SKILL_NAME, 'excel-diagnostics');
    assert.deepEqual([...TOOL_NAMES], ['excel_diag_summary', 'excel_diag_search', 'excel_diag_count', 'excel_diag_histogram', 'excel_diag_show',
      'excel_diag_context', 'excel_diag_reports', 'excel_diag_files', 'excel_diag_read_file', 'excel_diag_memory']);
    assert.throws(() => { TOOL_NAMES.push('excel_diag_extra'); }, TypeError, 'the list a test compares against must not be changeable by an importer');
    assert.deepEqual(Object.keys(installer).sort(), ['PLUGIN_ID', 'SKILL_NAME', 'TOOL_NAMES', 'install', 'updateConfiguration']);
  });

  it('does nothing when it is imported', async () => {
    const dir = await fs.realpath(await emptyDir('installer-import'));
    const script = path.join(dir, 'import-only.mjs'), home = path.join(dir, 'home');
    await fs.mkdir(home);
    await fs.writeFile(script, `const m = await import(${JSON.stringify(pathToFileURL(path.join(PLUGIN_DIR, 'install.mjs')).href)});\nconsole.log('imported ' + Object.keys(m).length);\n`);
    // An argument that would be an error if the installer started, and a state folder it would then look in.
    const child = spawn(RUNTIME[0], [...RUNTIME.slice(1), script, '--not-an-option'], { env: { PATH: '/usr/bin:/bin', HOME: home, OPENCLAW_STATE_DIR: path.join(dir, 'state'), DENO_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, 'imported 5\n');
    assert.equal(stderr, '');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['home', 'import-only.mjs'], 'importing must create nothing');
  });

  it('the two launchers are executable, so a double-click on Install.command opens it', async () => {
    for (const file of [path.join(path.dirname(PLUGIN_DIR), 'Install.command'), path.join(PLUGIN_DIR, 'deploy.sh')]) {
      assert.equal((await fs.stat(file)).mode & 0o111, 0o111, `${path.basename(file)} lost its executable bit`);
      assert.ok((await fs.readFile(file, 'utf8')).startsWith('#!/bin/bash\n'), `${path.basename(file)} should start with #!/bin/bash`);
    }
  });

  it('--help prints every option and touches nothing', async () => {
    const logs = [];
    const result = await install(['--help'], { env: {}, log: (line) => logs.push(String(line)), run: async () => { throw new Error('--help must run no command'); } });
    assert.deepEqual(result, { help: true });
    const text = logs.join('\n');
    for (const word of ['--check', '--skip-restart', '--skill-dir', '--agent', '--state-dir', '--config', '--help',
      'EXCEL_DIAGNOSTICS_NODE', 'EXCEL_DIAGNOSTICS_OPENCLAW', 'EXCEL_DIAGNOSTICS_SKILL_DIR', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_GATEWAY_LABEL']) {
      assert.ok(text.includes(word), `--help should explain ${word}`);
    }
  });
});

describe('installer: INSTALL.md', () => {
  it('names the exact folders, configuration keys, tool names and options the installer uses', async () => {
    const text = await fs.readFile(INSTALL_MD, 'utf8');
    for (const needed of [
      `<state folder>/extensions/${PLUGIN_ID}`, `<agent workspace>/skills/${SKILL_NAME}`, 'SKILL.md', 'excel_diagnostics_cli.mjs',
      `<state folder>/${PLUGIN_ID}/bundles`, `<state folder>/${PLUGIN_ID}/cache`, `<state folder>/${PLUGIN_ID}-install-backups`, 'manifest.json',
      `plugins.entries.${PLUGIN_ID}.enabled`, 'plugins.allow', 'tools.alsoAllow', 'tools.sandbox.tools.alsoAllow', `plugins.entries.${PLUGIN_ID}.config.bundlesDir`,
      ...TOOL_NAMES,
      'Install.command', 'openclaw/plugin/deploy.sh --check', 'install-report.txt',
      '--check', '--skip-restart', '--skill-dir', '--agent', '--state-dir', '--config', '--help',
      'EXCEL_DIAGNOSTICS_NODE', 'EXCEL_DIAGNOSTICS_OPENCLAW', 'EXCEL_DIAGNOSTICS_SKILL_DIR', 'OPENCLAW_GATEWAY_LABEL',
      'openclaw plugins list', 'openclaw skills list', 'openclaw config validate', 'launchctl kickstart -k',
      'fresh OpenClaw conversation', 'Undo by hand', 'sudo',
    ]) assert.ok(text.includes(needed), `INSTALL.md should mention ${needed}`);
  });

  it('uses placeholders, never a real home path', async () => {
    const text = await fs.readFile(INSTALL_MD, 'utf8');
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|~\/\.openclaw/, 'write <state folder>, not a path on one computer');
  });

  it('cleanup', async () => { await cleanup(); });
});
