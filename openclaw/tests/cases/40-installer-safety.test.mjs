// The installer, run against stand-in files in temp folders with a fake "openclaw" command and a fake restart.
//
// What this pins: a preflight that changes nothing; a refusal before the first write when a file is missing,
// broken or reached through a link; a backup of every replaced file; every file put back when OpenClaw refuses
// the configuration; a second run that replaces nothing and adds no name twice; a configuration whose other
// keys survive; and a bundles folder that is created private, then never touched again.
//
// Why it matters to a small model: the model only ever meets the outcome of an install. It needs all ten tools
// allowed, a skill whose text matches the installed plugin, and a Gateway that still starts. A half-written
// install gives it a skill naming tools it may not call, and it answers that by guessing other names.
//
// Nothing here reads or writes the real home folder, and no real "openclaw" or "launchctl" is ever started.
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it, assert, emptyDir, cleanup, exists, RUNTIME, PLUGIN_DIR, CLI_PATH, SKILL_PATH } from '../harness.mjs';
import { install, PLUGIN_ID, SKILL_NAME, TOOL_NAMES } from '../../plugin/install.mjs';

const OPENCLAW_DIR = path.dirname(PLUGIN_DIR);
const CLI_FILE = 'excel_diagnostics_cli.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const count = (list, value) => list.filter((v) => v === value).length;

// What gets installed in these cases: stand-ins, so that a case can break one file at a time. The installer only
// has to copy, check and register whatever it is handed; the real files are installed in 50-seams.
const STANDIN = {
  'plugin/index.js': `export default { id: '${PLUGIN_ID}', register() {} };\n`,
  'plugin/openclaw.plugin.json': JSON.stringify({ id: PLUGIN_ID, name: 'Stand-in', configSchema: { type: 'object', properties: {} }, contracts: { tools: TOOL_NAMES } }, null, 2) + '\n',
  'plugin/package.json': JSON.stringify({ name: 'stand-in-plugin', version: '0.0.0', type: 'module', private: true, openclaw: { extensions: ['./index.js'] } }) + '\n',
  'SKILL.md': `---\nname: ${SKILL_NAME}\ndescription: Stand-in skill text for the installer cases.\n---\n\nStand-in.\n`,
  [`../${CLI_FILE}`]: "#!/usr/bin/env node\nconsole.log('stand-in command-line tool');\n",
};
const INSTALLED = ['index.js', 'openclaw.plugin.json', 'package.json', CLI_FILE];

/**
 * A stand-in repository, an OpenClaw state folder with a configuration, and fake dependencies.
 * sources: file text by path relative to the stand-in openclaw folder (null leaves a file out).
 * config: keys merged over the starting configuration, or a function of the fixture's root folder returning them.
 * rawConfig: the configuration file's exact text.
 */
async function fixture({ sources = {}, config: patch = {}, rawConfig } = {}) {
  // Resolved first: the installer refuses a path that runs through a link, and the system temp folder is one on macOS.
  const root = await fs.realpath(await emptyDir('installer'));
  const source = path.join(root, 'repo', 'openclaw'), state = path.join(root, 'state'), workspace = path.join(root, 'workspace');
  for (const [name, text] of Object.entries({ ...STANDIN, ...sources })) {
    if (text === null) continue;
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), text);
  }
  await fs.mkdir(state);
  const config = {
    agents: { defaults: { workspace } },
    plugins: { allow: ['other'], entries: { other: { enabled: true, config: { value: 'keep' } } } },
    tools: { alsoAllow: ['other_tool'], deny: ['exec'], sandbox: { tools: { alsoAllow: ['other_tool'] } } },
    ...(typeof patch === 'function' ? patch(root) : patch),
  };
  const configFile = path.join(state, 'openclaw.json');
  await fs.writeFile(configFile, rawConfig ?? JSON.stringify(config), { mode: 0o600 });
  const calls = [], logs = [];
  const deps = {
    env: {}, version: '2026.9.4', sourceRoot: source, platform: 'darwin',
    log: (line) => { logs.push(String(line)); },
    run: async (command, args) => { calls.push([command, ...args].join(' ')); return { stdout: '', stderr: '' }; },
  };
  return {
    root, source, state, workspace, config, configFile, calls, logs, deps,
    options: ['--state-dir', state, '--skip-restart'],
    pluginDir: path.join(state, 'extensions', PLUGIN_ID),
    skillFile: path.join(workspace, 'skills', SKILL_NAME, 'SKILL.md'),
    dataDir: path.join(state, PLUGIN_ID),
    backups: path.join(state, `${PLUGIN_ID}-install-backups`),
  };
}

/** Every file, folder and link under dir with its mode and content hash, so "nothing changed" can be exact. */
async function snapshot(dir, base = dir, out = {}) {
  for (const name of (await fs.readdir(dir)).sort()) {
    const full = path.join(dir, name), info = await fs.lstat(full), rel = path.relative(base, full);
    const mode = (info.mode & 0o777).toString(8);
    if (info.isSymbolicLink()) out[rel] = `link ${await fs.readlink(full)}`;
    else if (info.isDirectory()) { out[rel] = `folder ${mode}`; await snapshot(full, base, out); }
    else out[rel] = `file ${mode} ${sha(await fs.readFile(full))}`;
  }
  return out;
}

/** The install is refused with a matching message, nothing on disk differs afterwards, and no command ran. */
async function refuses(f, pattern, { argv = f.options, deps = f.deps } = {}) {
  const before = await snapshot(f.root);
  await assert.rejects(install(argv, deps), pattern);
  assert.deepEqual(await snapshot(f.root), before, 'a refused install must leave every file and folder as it was');
  assert.deepEqual(f.calls, [], 'a refused install must run no command');
}

const readConfig = async (f) => JSON.parse(await fs.readFile(f.configFile, 'utf8'));
const modeOf = async (file) => (await fs.stat(file)).mode & 0o777;
const failingValidation = (f) => ({ ...f.deps, run: async (command, args) => { f.calls.push([command, ...args].join(' ')); throw new Error('validation refused'); } });

describe('installer: the preflight and every refusal change nothing', () => {
  it('--check says what an install would write and writes nothing, even without --skip-restart', async () => {
    const f = await fixture(), before = await snapshot(f.root);
    const result = await install(['--state-dir', f.state, '--check'], f.deps);
    assert.equal(result.checked, true);
    assert.equal(result.pending, 6, 'four plugin files, the skill and the configuration are pending');
    assert.deepEqual(await snapshot(f.root), before, '--check must leave every file and folder as it was');
    assert.deepEqual(f.calls, [], '--check must not validate, restart or run anything else');
    const text = f.logs.join('\n');
    assert.match(text, /Preflight passed\. No files or services changed\./);
    for (const file of [...INSTALLED.map((name) => path.join(f.pluginDir, name)), f.skillFile, f.configFile]) assert.ok(text.includes(file), `--check should name ${file}:\n${text}`);
    assert.ok(text.includes(path.join(f.dataDir, 'bundles')), `--check should name the bundles folder:\n${text}`);
  });

  it('--check on an installed copy reports that nothing would be replaced', async () => {
    const f = await fixture();
    await install(f.options, f.deps);
    const before = await snapshot(f.root);
    assert.equal((await install([...f.options, '--check'], f.deps)).pending, 0);
    assert.deepEqual(await snapshot(f.root), before);
    assert.match(f.logs.join('\n'), /would replace no file/);
  });

  for (const name of Object.keys(STANDIN)) {
    it(`a missing ${path.basename(name)} stops the install before anything is written`, async () => {
      await refuses(await fixture({ sources: { [name]: null } }), /Installer file missing: .*Nothing was changed/);
    });
  }

  it('a plugin file or command-line tool that fails the syntax check stops the install before anything is written', async () => {
    await refuses(await fixture({ sources: { 'plugin/index.js': 'export default { id: ;\n' } }), /Syntax check failed for .*index\.js\. Nothing was changed/);
    await refuses(await fixture({ sources: { [`../${CLI_FILE}`]: "#!/usr/bin/env node\nconsole.log('unclosed'\n" } }), /Syntax check failed for .*excel_diagnostics_cli\.mjs/);
  });

  it('a manifest for another plugin, with other tools, or that is not JSON stops the install', async () => {
    const manifest = JSON.parse(STANDIN['plugin/openclaw.plugin.json']);
    await refuses(await fixture({ sources: { 'plugin/openclaw.plugin.json': JSON.stringify({ ...manifest, id: 'something-else' }) } }), /Wrong Gateway plugin/);
    await refuses(await fixture({ sources: { 'plugin/openclaw.plugin.json': JSON.stringify({ ...manifest, contracts: { tools: [...TOOL_NAMES.slice(1), 'excel_diag_renamed'] } }) } }), /list different tools/);
    await refuses(await fixture({ sources: { 'plugin/openclaw.plugin.json': JSON.stringify({ ...manifest, contracts: { tools: TOOL_NAMES.slice(1) } }) } }), /list different tools/);
    await refuses(await fixture({ sources: { 'plugin/openclaw.plugin.json': '{ "id": ' } }), /openclaw\.plugin\.json in the installer is not a JSON object/);
    await refuses(await fixture({ sources: { 'plugin/package.json': 'not json' } }), /package\.json in the installer is not a JSON object/);
  });

  it('a configuration that is missing, not JSON, or not shaped as expected stops the install', async () => {
    const missing = await fixture();
    await fs.rm(missing.configFile);
    await refuses(missing, /No OpenClaw config/);
    await refuses(await fixture({ rawConfig: '{ plugins: { } } // json5' }), /must be valid JSON\. Nothing was changed/);
    await refuses(await fixture({ rawConfig: '[]' }), /OpenClaw config must be an object/);
    await refuses(await fixture({ config: { plugins: [] } }), /plugins must be an object/);
    await refuses(await fixture({ config: { tools: { alsoAllow: 'other_tool' } } }), /alsoAllow must be a string array/);
    await refuses(await fixture({ config: { agents: { defaults: { workspace: 'relative/workspace' } } } }), /workspace must be absolute/);
  });

  it('a destination reached through a link stops the install, and what the link points at is untouched', async () => {
    const skills = await fixture();
    await fs.mkdir(path.join(skills.root, 'elsewhere'));
    await fs.mkdir(skills.workspace);
    await fs.symlink(path.join(skills.root, 'elsewhere'), path.join(skills.workspace, 'skills'));
    await refuses(skills, /not a link/);

    const extensions = await fixture();
    await fs.mkdir(path.join(extensions.root, 'elsewhere'));
    await fs.symlink(path.join(extensions.root, 'elsewhere'), path.join(extensions.state, 'extensions'));
    await refuses(extensions, /not a link/);

    const file = await fixture();
    await fs.mkdir(file.pluginDir, { recursive: true });
    await fs.writeFile(path.join(file.root, 'real-index.js'), '// somebody else\'s file\n');
    await fs.symlink(path.join(file.root, 'real-index.js'), path.join(file.pluginDir, 'index.js'));
    await refuses(file, /Expected a regular file, not a link/);

    const state = await fixture();
    await fs.symlink(state.state, path.join(state.root, 'state-link'));
    await refuses(state, /not a link/, { argv: ['--state-dir', path.join(state.root, 'state-link'), '--skip-restart'] });

    // The state folder itself is real here; the link is a folder above it.
    const above = await fixture();
    await fs.symlink(above.root, path.join(above.root, 'link'));
    await refuses(above, /Resolve the symlink in this installation path first/, { argv: ['--state-dir', path.join(above.root, 'link', 'state'), '--skip-restart'] });
  });

  it('a destination the account cannot write stops the preflight and the install before the first write', { skip: process.getuid() === 0 ? 'root can write anywhere' : undefined }, async () => {
    // The skill folder is the last file written. Found only then, the plugin files would already be in place.
    const f = await fixture();
    await fs.mkdir(f.workspace, { mode: 0o500 });
    try {
      await refuses(f, (error) => error.code === 'EACCES', { argv: [...f.options, '--check'] });
      await refuses(f, (error) => error.code === 'EACCES');
    } finally { await fs.chmod(f.workspace, 0o700); }
  });

  it('an installer folder that does not match its checksum list stops the install; a matching one passes', async () => {
    const list = (entries) => JSON.stringify(Object.fromEntries(entries.map(([name, text]) => [name, sha(text)])));
    const good = await fixture({ sources: { 'INSTALLER-CHECKSUMS.json': list([['plugin/index.js', STANDIN['plugin/index.js']], ['SKILL.md', STANDIN['SKILL.md']]]) } });
    assert.equal((await install([...good.options, '--check'], good.deps)).checked, true);
    await refuses(await fixture({ sources: { 'INSTALLER-CHECKSUMS.json': list([['SKILL.md', 'what the skill said when the list was made']]) } }), /integrity check failed: SKILL\.md\. Nothing was changed/);
    await refuses(await fixture({ sources: { 'INSTALLER-CHECKSUMS.json': list([['plugin/gone.js', 'x']]) } }), /integrity check failed: plugin\/gone\.js/);
    await refuses(await fixture({ sources: { 'INSTALLER-CHECKSUMS.json': list([[`../${CLI_FILE}`, STANDIN[`../${CLI_FILE}`]]]) } }), /Invalid installer checksums/);
  });

  it('an openclaw command that cannot be run, or prints no version, stops the install', async () => {
    const absent = await fixture();
    await refuses(absent, /Could not run ".*--version".*Nothing was changed/, { deps: { ...absent.deps, version: undefined, env: { EXCEL_DIAGNOSTICS_OPENCLAW: path.join(absent.root, 'no-such-openclaw') } } });
    const silent = await fixture();
    const script = path.join(silent.root, 'openclaw-without-version.sh');
    await fs.writeFile(script, '#!/bin/sh\necho "hello"\n', { mode: 0o755 });
    await refuses(silent, /Could not determine the installed OpenClaw version/, { deps: { ...silent.deps, version: undefined, env: { EXCEL_DIAGNOSTICS_OPENCLAW: script } } });
  });

  it('an account that does not own the configuration is told to run as the Gateway account', async () => {
    const f = await fixture();
    await refuses(f, /belongs to another account.*without sudo/, { deps: { ...f.deps, uid: process.getuid() + 1 } });
  });

  it('an unknown option, a missing value, a relative path or a bad agent id stops the install', async () => {
    const f = await fixture();
    for (const [argv, pattern] of [
      [[...f.options, '--force'], /Unknown option or missing value: --force/],
      [[...f.options, 'constructor', 'x'], /Unknown option or missing value: constructor/],
      [['--skip-restart', '--state-dir'], /Unknown option or missing value: --state-dir/],
      [['--state-dir', 'relative/state', '--skip-restart'], /state must be an absolute path/],
      [[...f.options, '--skill-dir', 'relative/skill'], /skillDir must be an absolute path/],
      [[...f.options, '--agent', '../main'], /Invalid agent ID/],
    ]) await refuses(f, pattern, { argv });
    await refuses(f, /Invalid Gateway service label/, { deps: { ...f.deps, env: { OPENCLAW_GATEWAY_LABEL: 'gui/501 other' } } });
  });

  it('a configuration holding a number that cannot be written back exactly is not rewritten', async () => {
    const raw = (config) => JSON.stringify(config).replace('"CHANNEL"', '1234567890123456789012');
    const f = await fixture();
    await fs.writeFile(f.configFile, raw({ ...f.config, channel: 'CHANNEL' }));
    await refuses(f, /holds the number 1234567890123456789012.*Nothing was changed.*INSTALL\.md/s);

    // With the keys added by hand the file needs no rewrite, so the same number is no obstacle.
    const g = await fixture(), done = { ...g.config, channel: 'CHANNEL' };
    done.plugins = { allow: ['other', PLUGIN_ID], entries: { ...g.config.plugins.entries, [PLUGIN_ID]: { enabled: true } } };
    done.tools = { ...g.config.tools, alsoAllow: ['other_tool', ...TOOL_NAMES], sandbox: { tools: { alsoAllow: ['other_tool', ...TOOL_NAMES] } } };
    await fs.writeFile(g.configFile, raw(done));
    const result = await install(g.options, g.deps);
    assert.equal(result.changed, 5, 'the plugin files and the skill are installed; the configuration is not rewritten');
    assert.equal(await fs.readFile(g.configFile, 'utf8'), raw(done));
  });

  it('a skill folder among the bundles is refused', async () => {
    const f = await fixture();
    await refuses(f, /where nothing is installed/, { argv: [...f.options, '--skill-dir', path.join(f.dataDir, 'bundles', 'skill')] });
    await refuses(f, /where nothing is installed/, { argv: [...f.options, '--skill-dir', path.join(f.dataDir, 'cache')] });
  });
});

describe('installer: what an install writes', () => {
  it('installs the four plugin files and the skill byte for byte, and validates the configuration once', async () => {
    const f = await fixture();
    const result = await install(f.options, f.deps);
    assert.equal(result.installed, true);
    assert.equal(result.changed, 6);
    assert.deepEqual((await fs.readdir(f.pluginDir)).sort(), [...INSTALLED].sort(), 'the plugin folder holds exactly the four installed files');
    for (const name of ['index.js', 'openclaw.plugin.json', 'package.json']) assert.equal(await fs.readFile(path.join(f.pluginDir, name), 'utf8'), STANDIN[`plugin/${name}`], name);
    assert.equal(await fs.readFile(path.join(f.pluginDir, CLI_FILE), 'utf8'), STANDIN[`../${CLI_FILE}`]);
    assert.equal(await fs.readFile(f.skillFile, 'utf8'), STANDIN['SKILL.md']);
    assert.deepEqual(await fs.readdir(path.dirname(f.skillFile)), ['SKILL.md']);
    assert.deepEqual(f.calls, ['openclaw config validate']);
    assert.match(f.logs.join('\n'), /Installed and verified 6 files\. Backup: /);
  });

  it('takes the command-line tool from beside install.mjs when one is there', async () => {
    const beside = "#!/usr/bin/env node\nconsole.log('the copy beside install.mjs');\n";
    const f = await fixture({ sources: { [`plugin/${CLI_FILE}`]: beside } });
    await install(f.options, f.deps);
    assert.equal(await fs.readFile(path.join(f.pluginDir, CLI_FILE), 'utf8'), beside);
  });

  it('adds exactly its own configuration entries and keeps every other key and value, whatever the formatting', async () => {
    const f = await fixture();
    const original = {
      meta: { note: 'ünïcode ✓ "quoted" \\ back', values: [1, 2.5, -0.125, 1e21, null, true, { deep: [] }] },
      agents: { defaults: { workspace: f.workspace }, entries: { main: { model: 'local' } } },
      plugins: { allow: ['other'], load: { paths: ['/somewhere/else'] }, entries: { other: { enabled: false, config: { value: 'keep' }, hooks: { allowConversationAccess: false } } } },
      tools: { alsoAllow: ['other_tool'], deny: ['exec'], toolSearch: { enabled: true }, sandbox: { mode: 'all', tools: { alsoAllow: ['other_tool'], deny: ['process'] } } },
      gateway: { port: 18789 },
    };
    await fs.writeFile(f.configFile, JSON.stringify(original, null, '\t').replace(/\n/g, '\r\n'), { mode: 0o600 });
    await install(f.options, f.deps);

    const expected = structuredClone(original);
    expected.plugins.allow.push(PLUGIN_ID);
    expected.plugins.entries[PLUGIN_ID] = { enabled: true };
    expected.tools.alsoAllow.push(...TOOL_NAMES);
    expected.tools.sandbox.tools.alsoAllow.push(...TOOL_NAMES);
    const text = await fs.readFile(f.configFile, 'utf8'), written = JSON.parse(text);
    assert.deepEqual(written, expected);
    assert.deepEqual(Object.keys(written), Object.keys(original), 'top-level keys keep their order');
    assert.ok(text.endsWith('}\n'));
    assert.equal(await modeOf(f.configFile), 0o600, 'the configuration keeps its private mode');
  });

  it('leaves plugins.allow absent when the configuration had none', async () => {
    const f = await fixture({ config: { plugins: { entries: { other: { enabled: true } } } } });
    await install(f.options, f.deps);
    const written = await readConfig(f);
    assert.equal(written.plugins.allow, undefined, 'creating an allow list would restrict which plugins load');
    assert.equal(written.plugins.entries[PLUGIN_ID].enabled, true);
    assert.deepEqual(written.plugins.entries.other, { enabled: true });
  });

  it('enables an existing plugin entry and keeps its settings', async () => {
    const entry = { enabled: false, config: { timeoutSeconds: 300 }, hooks: { allowConversationAccess: false } };
    const f = await fixture({ config: { plugins: { allow: ['other'], entries: { [PLUGIN_ID]: entry } } } });
    await install(f.options, f.deps);
    assert.deepEqual((await readConfig(f)).plugins.entries[PLUGIN_ID], { ...entry, enabled: true });
  });

  it('finds the skill folder from the agent, the defaults, the state folder, the flag or the variable', async () => {
    const skillLine = async (f, argv = [], env = {}) => {
      await install([...f.options, '--check', ...argv], { ...f.deps, env });
      return f.logs.join('\n').match(/^Skill: (.*)$/m)?.[1];
    };
    const byEntry = await fixture({ config: (root) => ({ agents: { defaults: { workspace: path.join(root, 'defaults-ws') }, entries: { main: { workspace: path.join(root, 'entry-ws') } } } }) });
    assert.equal(await skillLine(byEntry), path.join(byEntry.root, 'entry-ws', 'skills', SKILL_NAME));
    const byList = await fixture({ config: (root) => ({ agents: { defaults: { workspace: path.join(root, 'defaults-ws') }, list: [{ id: 'main' }, { id: 'helper', workspace: path.join(root, 'helper-ws') }] } }) });
    assert.equal(await skillLine(byList, ['--agent', 'helper']), path.join(byList.root, 'helper-ws', 'skills', SKILL_NAME));
    const byDefaults = await fixture({ config: (root) => ({ agents: { defaults: { workspace: path.join(root, 'defaults-ws') }, list: [{ id: 'main' }] } }) });
    assert.equal(await skillLine(byDefaults), path.join(byDefaults.root, 'defaults-ws', 'skills', SKILL_NAME));
    const byState = await fixture({ config: { agents: undefined } });
    assert.equal(await skillLine(byState), path.join(byState.state, 'workspace', 'skills', SKILL_NAME));
    const byFlag = await fixture();
    assert.equal(await skillLine(byFlag, ['--skill-dir', path.join(byFlag.root, 'chosen')]), path.join(byFlag.root, 'chosen'));
    const byVariable = await fixture();
    assert.equal(await skillLine(byVariable, [], { EXCEL_DIAGNOSTICS_SKILL_DIR: path.join(byVariable.root, 'named') }), path.join(byVariable.root, 'named'));
  });
});

describe('installer: backup, rollback and running again', () => {
  it('backs up every file it replaces in a private folder, with a manifest, and leaves neighbouring files alone', async () => {
    const f = await fixture(), oldConfig = await fs.readFile(f.configFile);
    await fs.mkdir(f.pluginDir, { recursive: true });
    await fs.writeFile(path.join(f.pluginDir, 'index.js'), '// the plugin as it was\n', { mode: 0o644 });
    await fs.writeFile(path.join(f.pluginDir, 'left-by-the-owner.txt'), 'not the installer\'s file\n');
    await fs.mkdir(path.dirname(f.skillFile), { recursive: true });
    await fs.writeFile(f.skillFile, 'the skill as it was\n');
    await fs.mkdir(path.join(path.dirname(f.skillFile), 'references'));
    await fs.writeFile(path.join(path.dirname(f.skillFile), 'references', 'kept.md'), 'kept\n');

    const result = await install(f.options, f.deps);
    assert.equal(path.dirname(result.backup), f.backups);
    assert.equal(await modeOf(f.backups), 0o700);
    assert.equal(await modeOf(result.backup), 0o700);
    const manifest = JSON.parse(await fs.readFile(path.join(result.backup, 'manifest.json'), 'utf8'));
    assert.equal(manifest.length, 6);
    const entry = (destination) => manifest.find((item) => item.destination === destination) ?? assert.fail(`no manifest entry for ${destination}`);
    for (const [destination, before] of [[path.join(f.pluginDir, 'index.js'), '// the plugin as it was\n'], [f.skillFile, 'the skill as it was\n'], [f.configFile, oldConfig.toString()]]) {
      assert.equal(entry(destination).previous, true);
      assert.equal(await fs.readFile(path.join(result.backup, entry(destination).backup), 'utf8'), before, `backup of ${destination}`);
      assert.equal(entry(destination).installedSha256, sha(await fs.readFile(destination)));
    }
    assert.equal(await modeOf(path.join(result.backup, entry(f.configFile).backup)), 0o600, 'the copy of the configuration stays private');
    for (const name of ['openclaw.plugin.json', 'package.json', CLI_FILE]) {
      assert.equal(entry(path.join(f.pluginDir, name)).previous, false);
      assert.equal(await exists(path.join(result.backup, entry(path.join(f.pluginDir, name)).backup)), false, 'a new file has nothing to back up');
    }
    assert.equal(await modeOf(path.join(f.pluginDir, 'index.js')), 0o644, 'a replaced file keeps the mode it had');
    assert.equal(await fs.readFile(path.join(f.pluginDir, 'left-by-the-owner.txt'), 'utf8'), 'not the installer\'s file\n');
    assert.equal(await fs.readFile(path.join(path.dirname(f.skillFile), 'references', 'kept.md'), 'utf8'), 'kept\n');
  });

  it('puts every file and the configuration back when OpenClaw refuses the configuration, and does not restart', async () => {
    const f = await fixture();
    await fs.mkdir(f.pluginDir, { recursive: true });
    await fs.writeFile(path.join(f.pluginDir, 'index.js'), '// the plugin as it was\n');
    const filesOnly = async () => Object.fromEntries(Object.entries(await snapshot(f.root)).filter(([name, kind]) => !kind.startsWith('folder') && !name.startsWith(path.relative(f.root, f.backups))));
    const before = await filesOnly();
    await assert.rejects(install(['--state-dir', f.state], failingValidation(f)), /"openclaw config validate" refused the configuration.*The Gateway was not restarted/);
    assert.deepEqual(await filesOnly(), before, 'replaced files are restored and new files removed');
    assert.equal(await exists(f.skillFile), false);
    assert.equal(await exists(f.dataDir), false, 'a refused install creates no bundles folder');
    assert.deepEqual(f.calls, ['openclaw config validate'], 'no restart after a refused configuration');
    const text = f.logs.join('\n');
    assert.match(text, /Backup: /);
    assert.match(text, /Rolled back 6 files/);
    assert.equal((await fs.readdir(f.backups)).length, 1, 'the backup stays for the owner to inspect');
  });

  it('a file that appears after the preflight is not overwritten', async () => {
    const f = await fixture(), intruder = path.join(f.pluginDir, 'index.js'), oldConfig = await fs.readFile(f.configFile, 'utf8');
    // The first line the installer prints comes after its checks and before its first write.
    const log = (line) => {
      if (!f.logs.length) { mkdirSync(f.pluginDir, { recursive: true }); writeFileSync(intruder, '// written by someone else meanwhile\n'); }
      f.logs.push(String(line));
    };
    await assert.rejects(install(f.options, { ...f.deps, log }), /File changed during install: .*index\.js/);
    assert.equal(await fs.readFile(intruder, 'utf8'), '// written by someone else meanwhile\n');
    assert.deepEqual(await fs.readdir(f.pluginDir), ['index.js'], 'nothing else was installed');
    assert.equal(await exists(f.skillFile), false);
    assert.equal(await fs.readFile(f.configFile, 'utf8'), oldConfig);
    assert.deepEqual(f.calls, []);
  });

  it('a configuration edited after the preflight is not overwritten, and nothing is installed', async () => {
    const f = await fixture(), edited = JSON.stringify({ ...f.config, editedMeanwhile: true });
    const log = (line) => { if (!f.logs.length) writeFileSync(f.configFile, edited); f.logs.push(String(line)); };
    await assert.rejects(install(f.options, { ...f.deps, log }), /changed while being backed up; nothing installed/);
    assert.equal(await fs.readFile(f.configFile, 'utf8'), edited);
    assert.equal(await exists(f.pluginDir), false);
    assert.equal(await exists(f.skillFile), false);
    assert.deepEqual(f.calls, []);
  });

  it('a rollback leaves a file someone else changed meanwhile as they wrote it, and names it', async () => {
    const f = await fixture(), installed = path.join(f.pluginDir, 'index.js'), oldConfig = await fs.readFile(f.configFile, 'utf8');
    const run = async () => { writeFileSync(installed, '// edited by someone else during validation\n'); throw new Error('validation refused'); };
    await assert.rejects(install(f.options, { ...f.deps, run }), /refused the configuration/);
    assert.equal(await fs.readFile(installed, 'utf8'), '// edited by someone else during validation\n');
    assert.ok(f.logs.join('\n').includes(`Concurrent changes prevented automatic rollback of: ${installed}`), f.logs.join('\n'));
    assert.deepEqual(await fs.readdir(f.pluginDir), ['index.js'], 'the other new files were removed');
    assert.equal(await exists(f.skillFile), false);
    assert.equal(await fs.readFile(f.configFile, 'utf8'), oldConfig);
  });

  it('a second run replaces nothing, makes no backup folder, and lists each name once', async () => {
    const f = await fixture();
    await install(f.options, f.deps);
    const before = await snapshot(f.root);
    const second = await install(f.options, f.deps);
    assert.equal(second.changed, 0);
    assert.equal(second.backup, null);
    assert.deepEqual(await snapshot(f.root), before, 'a second run must leave every file and folder as the first left it');
    const written = await readConfig(f);
    for (const name of TOOL_NAMES) {
      assert.equal(count(written.tools.alsoAllow, name), 1, `${name} in tools.alsoAllow`);
      assert.equal(count(written.tools.sandbox.tools.alsoAllow, name), 1, `${name} in tools.sandbox.tools.alsoAllow`);
    }
    assert.equal(count(written.plugins.allow, PLUGIN_ID), 1);
    assert.deepEqual(f.calls, ['openclaw config validate', 'openclaw config validate']);
    assert.match(f.logs.join('\n'), /Nothing to replace/);
  });

  it('a name the owner had already listed is not added again, and the owner\'s order is kept', async () => {
    const f = await fixture({ config: { tools: { alsoAllow: ['excel_diag_search', 'other_tool'], sandbox: { tools: { alsoAllow: ['other_tool', 'excel_diag_memory', 'last_tool'] } } } } });
    await install(f.options, f.deps);
    const written = await readConfig(f);
    assert.deepEqual(written.tools.alsoAllow, ['excel_diag_search', 'other_tool', ...TOOL_NAMES.filter((name) => name !== 'excel_diag_search')]);
    assert.deepEqual(written.tools.sandbox.tools.alsoAllow, ['other_tool', 'excel_diag_memory', 'last_tool', ...TOOL_NAMES.filter((name) => name !== 'excel_diag_memory')]);
  });

  it('a later run replaces only the file that differs and backs up the one it replaces', async () => {
    const f = await fixture();
    await install(f.options, f.deps);
    const newer = `export default { id: '${PLUGIN_ID}', register() {}, newer: true };\n`;
    await fs.writeFile(path.join(f.source, 'plugin', 'index.js'), newer);
    const result = await install(f.options, f.deps);
    assert.equal(result.changed, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(result.backup, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.map((item) => [item.destination, item.previous]), [[path.join(f.pluginDir, 'index.js'), true]]);
    assert.equal(await fs.readFile(path.join(result.backup, manifest[0].backup), 'utf8'), STANDIN['plugin/index.js']);
    assert.equal(await fs.readFile(path.join(f.pluginDir, 'index.js'), 'utf8'), newer);
  });

  it('a configuration that already has every entry keeps its bytes, however it is formatted', async () => {
    const f = await fixture();
    await install(f.options, f.deps);
    const reformatted = JSON.stringify(await readConfig(f), null, '\t');
    await fs.writeFile(f.configFile, reformatted);
    assert.equal((await install(f.options, f.deps)).changed, 0);
    assert.equal(await fs.readFile(f.configFile, 'utf8'), reformatted);
  });
});

describe('installer: the bundles folder', () => {
  it('creates the bundles and cache folders for this account only', async () => {
    const f = await fixture();
    const result = await install(f.options, f.deps);
    const bundles = path.join(f.dataDir, 'bundles'), cache = path.join(f.dataDir, 'cache');
    assert.equal(result.bundlesDir, bundles);
    assert.deepEqual(result.created, [bundles, cache]);
    for (const folder of [f.dataDir, bundles, cache]) assert.equal(await modeOf(folder), 0o700, folder);
    assert.deepEqual(await fs.readdir(bundles), []);
  });

  it('leaves an existing bundles folder, its permissions and the bundles in it exactly as they were', async () => {
    const f = await fixture(), bundles = path.join(f.dataDir, 'bundles');
    await fs.mkdir(path.join(bundles, 'Excel_Diagnostics_collect_20260310_103500'), { recursive: true });
    await fs.writeFile(path.join(bundles, 'Excel_Diagnostics_collect_20260310_103500', 'summary.md'), '# a bundle\n');
    await fs.writeFile(path.join(bundles, 'Excel_Diagnostics_collect_20260311_090000.zip'), Buffer.from([0x50, 0x4b, 5, 6, ...new Array(18).fill(0)]));
    await fs.mkdir(path.join(f.dataDir, 'cache', 'unpacked'), { recursive: true });
    await fs.writeFile(path.join(f.dataDir, 'cache', 'unpacked', 'leftover.txt'), 'x');
    await fs.chmod(f.dataDir, 0o750);
    await fs.chmod(bundles, 0o755);
    const state = async () => ({ files: await snapshot(f.dataDir), folderMode: await modeOf(f.dataDir), bundlesChanged: (await fs.stat(bundles)).mtimeMs, zipChanged: (await fs.stat(path.join(bundles, 'Excel_Diagnostics_collect_20260311_090000.zip'))).mtimeMs });
    const before = await state();

    const result = await install(f.options, f.deps);
    assert.deepEqual(result.created, []);
    assert.deepEqual(await state(), before, 'an install must not touch the bundles folder');
    assert.match(f.logs.join('\n'), /already there and other accounts on this computer can open it/);
    await install(f.options, f.deps);
    assert.deepEqual(await state(), before, 'a second run must not touch the bundles folder');
    await fs.writeFile(path.join(f.source, 'SKILL.md'), 'a newer skill\n');
    await assert.rejects(install(f.options, failingValidation(f)), /refused the configuration/);
    assert.deepEqual(await state(), before, 'a rolled-back run must not touch the bundles folder');
  });

  it('names the folder the plugin configuration sets, and creates no default bundles folder beside it', async () => {
    const f = await fixture({ config: (root) => ({ plugins: { entries: { [PLUGIN_ID]: { config: { bundlesDir: path.join(root, 'shared', 'bundles') } } } } }) });
    const chosen = path.join(f.root, 'shared', 'bundles');
    const result = await install(f.options, f.deps);
    assert.equal(result.bundlesDir, chosen);
    assert.deepEqual(result.created, [path.join(f.dataDir, 'cache')]);
    assert.equal(await exists(path.join(f.dataDir, 'bundles')), false);
    assert.ok(f.logs.join('\n').includes(`The configuration sets bundlesDir, so the plugin reads bundles from ${chosen}. The installer did not create or change that folder.`), f.logs.join('\n'));
    assert.equal(await exists(chosen), false);

    // A value the plugin would not use (it must be absolute) does not move the folder.
    const g = await fixture({ config: { plugins: { entries: { [PLUGIN_ID]: { config: { bundlesDir: 'bundles-here' } } } } } });
    assert.equal((await install(g.options, g.deps)).bundlesDir, path.join(g.dataDir, 'bundles'));
  });
});

describe('installer: restart and closing lines', () => {
  it('restarts the existing Gateway service after the configuration validated', async () => {
    const f = await fixture();
    const result = await install(['--state-dir', f.state], f.deps);
    assert.equal(result.restarted, true);
    assert.deepEqual(f.calls, ['openclaw config validate', `/bin/launchctl kickstart -k gui/${process.getuid()}/ai.openclaw.gateway`]);
    assert.match(f.logs.join('\n'), /Existing Gateway service restarted/);
  });

  it('uses the service named by OPENCLAW_GATEWAY_LABEL', async () => {
    const f = await fixture();
    await install(['--state-dir', f.state], { ...f.deps, env: { OPENCLAW_GATEWAY_LABEL: 'ai.openclaw.gateway.second' } });
    assert.equal(f.calls.at(-1), `/bin/launchctl kickstart -k gui/${process.getuid()}/ai.openclaw.gateway.second`);
  });

  it('a restart that fails leaves the install in place and says to restart by hand', async () => {
    const f = await fixture();
    const run = async (command, args) => { f.calls.push([command, ...args].join(' ')); if (command.endsWith('launchctl')) throw new Error('no such service'); return {}; };
    const result = await install(['--state-dir', f.state], { ...f.deps, run });
    assert.equal(result.installed, true);
    assert.equal(result.restarted, false);
    assert.equal(await exists(f.skillFile), true);
    assert.match(f.logs.join('\n'), /could not be restarted\. Restart the Gateway manually\./);
  });

  it('does not try to restart on another platform, or with --skip-restart', async () => {
    const f = await fixture();
    const result = await install(['--state-dir', f.state], { ...f.deps, platform: 'linux' });
    assert.equal(result.restarted, false);
    assert.deepEqual(f.calls, ['openclaw config validate']);
    assert.match(f.logs.join('\n'), /Restart your existing Gateway service manually\./);
    const g = await fixture();
    assert.equal((await install(g.options, g.deps)).restarted, false);
    assert.deepEqual(g.calls, ['openclaw config validate']);
    assert.match(g.logs.join('\n'), /Gateway restart skipped as requested/);
  });

  it('ends by saying where bundles go, to open a fresh conversation, and how to check the install', async () => {
    const f = await fixture();
    await install(f.options, f.deps);
    const text = f.logs.join('\n');
    const at = (needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `the installer should say "${needle}":\n${text}`); return i; };
    const installed = at('Installed and verified');
    const bundles = at(`Put diagnostics bundles in this folder: ${path.join(f.dataDir, 'bundles')}`);
    const fresh = at('Open a fresh OpenClaw conversation');
    const check = at('openclaw plugins list');
    at('openclaw skills list');
    assert.ok(installed < bundles && bundles < fresh && fresh < check, `closing lines out of order:\n${text}`);
    assert.match(f.logs.at(-1), /openclaw plugins list.*openclaw skills list/, 'how to check comes last');
    assert.doesNotMatch(text, /already there and other accounts/, 'a folder the installer made private needs no warning');
  });
});

// ---------- the shell launchers, started for real with stand-ins for Node's target files and for openclaw ----------
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function sh(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
/**
 * Copies the three installer files into the fixture's stand-in openclaw folder, so the copy installs the stand-ins
 * and writes its report in a temp folder. Returns the environment the launchers are started with: a temp HOME, a
 * "Node" that is whichever runtime runs these cases, and a fake openclaw that records how it was called.
 */
async function launchers(f, { validateStatus = 0 } = {}) {
  for (const name of ['Install.command', 'plugin/deploy.sh', 'plugin/install.mjs']) {
    await fs.copyFile(path.join(OPENCLAW_DIR, name), path.join(f.source, name));
    await fs.chmod(path.join(f.source, name), 0o755);
  }
  const home = path.join(f.root, 'home'), runtime = path.join(f.root, 'runtime.sh'), openclaw = path.join(f.root, 'openclaw-stand-in.sh');
  f.openclawCalls = path.join(f.root, 'openclaw-calls.txt');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(runtime, `#!/bin/sh\nexec ${RUNTIME.map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
  await fs.writeFile(openclaw, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "OpenClaw 2026.9.4 (stand-in)"; exit 0; fi\nprintf '%s|%s|%s\\n' "$*" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" >> ${quote(f.openclawCalls)}\nexit ${validateStatus}\n`, { mode: 0o755 });
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1', EXCEL_DIAGNOSTICS_NODE: runtime, EXCEL_DIAGNOSTICS_OPENCLAW: openclaw };
}

describe('installer: deploy.sh and Install.command', () => {
  it('deploy.sh hands its arguments to install.mjs and returns its exit status', async () => {
    const f = await fixture(), env = await launchers(f), before = await snapshot(f.state);
    const help = await sh(path.join(f.source, 'plugin', 'deploy.sh'), ['--help'], env);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Excel Diagnostics installer for OpenClaw/);
    for (const flag of ['--check', '--skip-restart', '--skill-dir', '--agent', '--state-dir', '--config', 'EXCEL_DIAGNOSTICS_NODE', 'EXCEL_DIAGNOSTICS_OPENCLAW', 'OPENCLAW_GATEWAY_LABEL']) assert.ok(help.stdout.includes(flag), `--help should explain ${flag}`);
    const bad = await sh(path.join(f.source, 'plugin', 'deploy.sh'), ['--state-dir', f.state, '--skip-restart', '--force'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /INSTALL FAILED: Unknown option or missing value: --force/);
    assert.deepEqual(await snapshot(f.state), before);
  });

  it('deploy.sh says which variable to set when it cannot find Node', async () => {
    const f = await fixture(), env = await launchers(f);
    const result = await sh(path.join(f.source, 'plugin', 'deploy.sh'), ['--help'], { ...env, EXCEL_DIAGNOSTICS_NODE: path.join(f.root, 'no-node-here') });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Node\.js is required\. Set EXCEL_DIAGNOSTICS_NODE/);
    assert.equal(result.stdout, '');
  });

  it('the installer still runs when its folder is reached through a link', async () => {
    // Started this way, a main-module test that compares the path as typed finds no match and the installer would
    // print nothing and exit 0: an install that looks done and is not.
    const f = await fixture(), env = await launchers(f);
    await fs.symlink(path.join(f.root, 'repo'), path.join(f.root, 'repo-link'));
    const check = await sh(path.join(f.root, 'repo-link', 'openclaw', 'plugin', 'deploy.sh'), ['--state-dir', f.state, '--check'], env);
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /Preflight passed\. No files or services changed\./);
  });

  it('Install.command installs through the whole chain, keeps a report beside itself, and passes the state folder to openclaw', async () => {
    const f = await fixture(), env = await launchers(f);
    const result = await sh(path.join(f.source, 'Install.command'), ['--state-dir', f.state, '--skip-restart'], env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Installed and verified 6 files/);
    assert.equal(await fs.readFile(path.join(f.source, 'install-report.txt'), 'utf8'), result.stdout, 'the report holds what was printed');
    for (const name of INSTALLED) assert.equal(await exists(path.join(f.pluginDir, name)), true, name);
    assert.equal(await fs.readFile(f.skillFile, 'utf8'), STANDIN['SKILL.md']);
    assert.equal((await readConfig(f)).plugins.entries[PLUGIN_ID].enabled, true);
    assert.equal(await modeOf(path.join(f.dataDir, 'bundles')), 0o700);
    assert.equal(await fs.readFile(f.openclawCalls, 'utf8'), `config validate|${f.state}|${f.configFile}\n`, 'openclaw is asked to validate this state folder and nothing else');
  });

  it('Install.command returns the installer\'s failure, with the reason in the report and every file put back', async () => {
    const f = await fixture(), env = await launchers(f, { validateStatus: 1 }), oldConfig = await fs.readFile(f.configFile, 'utf8');
    const result = await sh(path.join(f.source, 'Install.command'), ['--state-dir', f.state, '--skip-restart'], env);
    assert.equal(result.code, 1, 'a failed install must not exit 0 behind the pipe to tee');
    const report = await fs.readFile(path.join(f.source, 'install-report.txt'), 'utf8');
    assert.match(report, /INSTALL FAILED: "openclaw config validate" refused the configuration/);
    assert.match(report, /Rolled back 6 files/);
    assert.equal(await fs.readFile(f.configFile, 'utf8'), oldConfig);
    assert.equal(await exists(path.join(f.pluginDir, 'index.js')), false);
    assert.equal(await exists(f.skillFile), false);
  });
});

// The one case here that reads the real plugin, skill and command-line tool: they must pass the same preflight an
// owner runs first. Nothing is installed; the state folder is a temp one. A file that is missing fails the case.
const realSources = [...['index.js', 'openclaw.plugin.json', 'package.json'].map((name) => path.join(PLUGIN_DIR, name)), SKILL_PATH, CLI_PATH];

describe('installer: the real files', () => {
  it('the plugin, skill and command-line tool in this repository pass the preflight', async () => {
    for (const file of realSources) assert.ok(await exists(file), `${path.relative(path.dirname(OPENCLAW_DIR), file)} is missing`);
    const f = await fixture(), before = await snapshot(f.state);
    const result = await install([...f.options, '--check'], { ...f.deps, sourceRoot: undefined });
    assert.equal(result.checked, true);
    assert.equal(result.pending, 6);
    assert.deepEqual(await snapshot(f.state), before);
    assert.deepEqual(f.calls, []);
  });

  it('cleanup', async () => { await cleanup(); });
});
