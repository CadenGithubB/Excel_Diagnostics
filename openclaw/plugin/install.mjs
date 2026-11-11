// Installer for the Excel diagnostics plugin and skill. deploy.sh starts it as the account that owns the OpenClaw
// Gateway. It uses only what Node ships with and never opens a network connection.
//
// Order of work: read and check everything first (--check stops there), copy what is about to be replaced into a
// backup folder, replace file by file, ask OpenClaw to validate its configuration, and put every file back if it
// refuses. Nothing inside the bundles folder is ever written, changed or removed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const PLUGIN_ID = 'excel-diagnostics';
export const SKILL_NAME = 'excel-diagnostics';
// The names OpenClaw is told to let agents call. Kept here as a constant and compared with the manifest being
// installed, so a tool renamed on one side only stops the install instead of leaving a tool no agent may call.
export const TOOL_NAMES = Object.freeze([
  'excel_diag_summary', 'excel_diag_search', 'excel_diag_count', 'excel_diag_histogram', 'excel_diag_show',
  'excel_diag_context', 'excel_diag_reports', 'excel_diag_files', 'excel_diag_read_file', 'excel_diag_memory',
]);

const PLUGIN_FILES = ['index.js', 'openclaw.plugin.json', 'package.json'];
const CLI_FILE = 'excel_diagnostics_cli.mjs';
const exec = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileCount = (n) => `${n} ${n === 1 ? 'file' : 'files'}`;
const root = fileURLToPath(new URL('../', import.meta.url));      // the openclaw folder this file sits in
const help = `Excel Diagnostics installer for OpenClaw

  bash openclaw/plugin/deploy.sh [options]

Installs the Gateway plugin ${PLUGIN_ID}, the command-line tool it runs, and the
${SKILL_NAME} skill. Backs up every file it replaces, adds its own entries to the
OpenClaw configuration, creates the bundles folder when it is missing, and restarts
the existing macOS Gateway service. Nothing is downloaded. Bundles already on this
computer, other configuration keys, OpenClaw itself and its service definition are
left as they are.

  --check              Read-only preflight; no files or services changed
  --skip-restart       Install files without restarting the Gateway
  --skill-dir PATH     Skill folder (otherwise <agent workspace>/skills/${SKILL_NAME})
  --agent ID           Agent whose workspace receives the skill (default: main)
  --state-dir PATH     OpenClaw state folder (or OPENCLAW_STATE_DIR)
  --config PATH        OpenClaw JSON configuration (or OPENCLAW_CONFIG_PATH)
  --help               Show this help

EXCEL_DIAGNOSTICS_NODE and EXCEL_DIAGNOSTICS_OPENCLAW may name existing executables.
EXCEL_DIAGNOSTICS_SKILL_DIR may name the skill folder.
OPENCLAW_GATEWAY_LABEL names an existing macOS LaunchAgent.
`;

function options(argv, env) {
  const opts = { check: false, skipRestart: false, agent: 'main' };
  const values = { '--skill-dir': 'skillDir', '--agent': 'agent', '--state-dir': 'state', '--config': 'config' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--check') opts.check = true;
    else if (arg === '--skip-restart') opts.skipRestart = true;
    else if (Object.hasOwn(values, arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[values[arg]] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${arg}. Use --help.`);
  }
  if (opts.help) return opts;                                     // help needs no folder, so it looks for none
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(opts.agent)) throw new Error('Invalid agent ID');
  // A variable that is set but empty counts as unset: an empty state folder would install relative to wherever
  // the installer happened to be started.
  opts.state ??= env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
  opts.config ??= env.OPENCLAW_CONFIG_PATH || path.join(opts.state, 'openclaw.json');
  opts.skillDir ??= env.EXCEL_DIAGNOSTICS_SKILL_DIR || undefined;
  opts.label = env.OPENCLAW_GATEWAY_LABEL || 'ai.openclaw.gateway';
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(opts.label)) throw new Error('Invalid Gateway service label');
  for (const key of ['state', 'config', 'skillDir']) {
    if (opts[key] === undefined) continue;
    if (opts[key].startsWith('~/')) opts[key] = path.join(os.homedir(), opts[key].slice(2));
    if (!path.isAbsolute(opts[key])) throw new Error(`${key} must be an absolute path`);
    opts[key] = path.resolve(opts[key]);
  }
  return opts;
}

async function stat(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Sources and destinations must be ordinary files. A link is refused: reading one could install something from
// outside the installer folder, and replacing one would change a file somewhere else.
async function fileBytes(file) {
  const info = await stat(file);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file, not a link: ${file}`);
  return fs.readFile(file);
}
// The nearest folder that exists on the way to `directory` must be a real folder (writable when asked), and
// nothing above it may be a link: a link there could send the install somewhere other than the path shown.
async function directorySafe(directory, writable = false) {
  let current = directory;
  for (;;) {
    const info = await stat(current);
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a folder that is not a link: ${current}`);
      if (writable) await fs.access(current, fs.constants.W_OK | fs.constants.X_OK);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing parent for ${directory}`);
    current = parent;
  }
  for (let parent = path.dirname(current); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error(`Resolve the symlink in this installation path first: ${parent}`);
  }
}
const within = (inner, outer) => inner === outer || inner.startsWith(outer + path.sep);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
// Adds only the names that are missing, after whatever the list already holds, so the owner's own entries keep
// their order and a second run adds nothing. Only a missing key becomes a new list: any other value that is not
// a list of names (null included) means something this installer does not understand, and stops it.
function append(target, key, values) {
  const list = target[key] === undefined ? [] : target[key];
  if (!Array.isArray(list) || list.some((v) => typeof v !== 'string')) throw new Error(`${key} must be a string array`);
  target[key] = [...list, ...values.filter((v) => !list.includes(v))];
}
/** The configuration with this plugin enabled and its tools allowed. The input is not modified. */
export function updateConfiguration(input) {
  const config = structuredClone(object(input, 'OpenClaw config'));
  config.plugins = object(config.plugins ?? {}, 'plugins');
  // With no allow list OpenClaw does not restrict which installed plugins load. Creating one here would.
  if (config.plugins.allow !== undefined) append(config.plugins, 'allow', [PLUGIN_ID]);
  config.plugins.entries = object(config.plugins.entries ?? {}, 'plugins.entries');
  const entry = config.plugins.entries[PLUGIN_ID] = object(config.plugins.entries[PLUGIN_ID] ?? {}, PLUGIN_ID);
  entry.enabled = true;
  config.tools = object(config.tools ?? {}, 'tools');
  append(config.tools, 'alsoAllow', TOOL_NAMES);
  config.tools.sandbox = object(config.tools.sandbox ?? {}, 'tools.sandbox');
  config.tools.sandbox.tools = object(config.tools.sandbox.tools ?? {}, 'tools.sandbox.tools');
  append(config.tools.sandbox.tools, 'alsoAllow', TOOL_NAMES);
  return config;
}
// JSON.parse reads every number as a double. A whole number too large for one (a long id written without quotes)
// would come back altered when the file is written again, so a configuration holding one is not rewritten.
function inexactNumber(text) {
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (token[0] === '"') continue;
    const value = Number(token);
    if (!Number.isFinite(value) || (/^-?\d+$/.test(token) && BigInt(token) !== BigInt(value))) return token;
  }
  return null;
}

async function executableVersion(command, env) {
  let result;
  try { result = await exec(command, ['--version'], { env, timeout: 20000, maxBuffer: 128 * 1024 }); }
  catch { throw new Error(`Could not run "${command} --version". Run the installer as the Gateway account, or set EXCEL_DIAGNOSTICS_OPENCLAW to the openclaw executable. Nothing was changed.`); }
  const version = result.stdout.match(/\b20\d{2}\.\d{1,2}\.\d{1,2}(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0];
  if (!version) throw new Error('Could not determine the installed OpenClaw version. Nothing was changed.');
  return version;
}
// Deno runs this file only in this project's tests; there "check" is a subcommand, not a flag.
const syntaxCheck = (file) => exec(process.execPath, [globalThis.Deno ? 'check' : '--check', file], { env: { ...process.env, NO_COLOR: '1' }, timeout: 60000, maxBuffer: 512 * 1024 });

// Writes beside the destination and renames over it, so a reader sees the old file or the new one, never a part.
async function replaceFile(file, bytes, metadataSource = file) {
  const temp = path.join(path.dirname(file), `.${PLUGIN_ID}-install-${randomBytes(10).toString('hex')}.tmp`);
  try {
    // Starting from a copy made by cp -p keeps the replaced file's mode, and on macOS its ACLs and extended attributes.
    if (await stat(metadataSource)) await exec('/bin/cp', ['-p', metadataSource, temp]);
    else await fs.writeFile(temp, '', { mode: 0o600, flag: 'wx' });
    const handle = await fs.open(temp, 'w');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
// Creates the folder, and any missing parent, for this account only. Returns false and does nothing when
// something is already there: an existing folder, its permissions and its contents belong to the owner.
async function privateFolder(directory) {
  if (await stat(directory)) return false;
  await privateFolder(path.dirname(directory));
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
  return true;
}

/**
 * Run the installer. `dependencies` exists for tests: env, log, sourceRoot (the folder holding plugin/ and
 * SKILL.md), run(command, args), version, platform, uid.
 */
export async function install(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env, log = dependencies.log ?? console.log;
  const opts = options(argv, env);
  if (opts.help) { log(help); return { help: true }; }
  const sourceRoot = dependencies.sourceRoot ?? root;
  const checksums = await fileBytes(path.join(sourceRoot, 'INSTALLER-CHECKSUMS.json'));
  if (checksums) {
    for (const [name, expected] of Object.entries(JSON.parse(checksums))) {
      if (path.isAbsolute(name) || name.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid installer checksums');
      const bytes = await fileBytes(path.join(sourceRoot, name));
      if (!bytes || hash(bytes) !== expected) throw new Error(`Installer integrity check failed: ${name}. Nothing was changed. Copy the complete installer folder to this computer again.`);
    }
  }
  const openclaw = env.EXCEL_DIAGNOSTICS_OPENCLAW || 'openclaw';
  const commandEnv = { ...env, OPENCLAW_STATE_DIR: opts.state, OPENCLAW_CONFIG_PATH: opts.config };
  const run = dependencies.run ?? ((command, args) => exec(command, args, { env: commandEnv, timeout: 30000, maxBuffer: 512 * 1024 }));
  const uid = dependencies.uid ?? process.getuid?.();

  const configBytes = await fileBytes(opts.config);
  if (!configBytes) throw new Error(`No OpenClaw config at ${opts.config}. Run this as the Gateway account, or use --config.`);
  // Run with sudo, every file written would belong to root and the Gateway could no longer replace or read them.
  const owner = (await fs.lstat(opts.config)).uid;
  if (uid !== undefined && owner !== uid) throw new Error(`The OpenClaw configuration belongs to another account (user id ${owner}; this is user id ${uid}). Run the installer as the account that owns the Gateway, without sudo. Nothing was changed.`);
  let original;
  try { original = JSON.parse(configBytes); }
  catch { throw new Error('OpenClaw config must be valid JSON. Nothing was changed; a JSON5 configuration has to be converted by hand first.'); }
  const next = updateConfiguration(original);

  const agent = original.agents?.entries?.[opts.agent] ?? (Array.isArray(original.agents?.list) ? original.agents.list.find((value) => value?.id === opts.agent) : undefined);
  if (!opts.skillDir) {
    let workspace = agent?.workspace ?? original.agents?.defaults?.workspace ?? path.join(opts.state, 'workspace');
    if (typeof workspace !== 'string') throw new Error('Configured workspace must be a path');
    if (workspace.startsWith('~/')) workspace = path.join(os.homedir(), workspace.slice(2));
    if (!path.isAbsolute(workspace)) throw new Error('Configured workspace must be absolute; use --skill-dir');
    opts.skillDir = path.join(workspace, 'skills', SKILL_NAME);
  }
  const pluginDest = path.join(opts.state, 'extensions', PLUGIN_ID);
  // Where the plugin looks for bundles: its own setting when the configuration has a usable one, else the default.
  const dataRoot = path.join(opts.state, PLUGIN_ID);
  const configured = next.plugins.entries[PLUGIN_ID].config?.bundlesDir;
  const ownBundles = typeof configured === 'string' && path.isAbsolute(configured) ? path.resolve(configured) : null;
  const bundlesDir = ownBundles ?? path.join(dataRoot, 'bundles');
  const folders = [...(ownBundles ? [] : [bundlesDir]), path.join(dataRoot, 'cache')];

  const destinations = [pluginDest, opts.skillDir];
  for (const [i, a] of destinations.entries()) {
    for (const b of destinations.slice(i + 1)) if (within(a, b) || within(b, a)) throw new Error('Installation destinations must not overlap');
    if (within(opts.config, a)) throw new Error('Config cannot be inside an installation destination');
    // No destination may land among the bundles or the unpacked copies of them: nothing in there is the installer's.
    for (const data of [dataRoot, bundlesDir]) if (within(a, data)) throw new Error(`${a} is inside ${data}, where nothing is installed. Choose another --skill-dir, or another bundlesDir in the plugin's configuration.`);
    await directorySafe(a, true);
  }
  await directorySafe(path.dirname(opts.config), true);
  await directorySafe(opts.state, true);
  const missing = [];
  for (const folder of folders) {
    let info = null;
    try { info = await fs.stat(folder); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info && !info.isDirectory()) throw new Error(`Expected a folder: ${folder}`);
    if (!info) { await directorySafe(folder, true); missing.push(folder); }
  }
  const version = dependencies.version ?? await executableVersion(openclaw, commandEnv);

  const plan = [];
  const add = async (source, destination) => {
    const bytes = await fileBytes(source);
    if (!bytes) throw new Error(`Installer file missing: ${source}. Nothing was changed. Copy the complete installer folder to this computer again.`);
    await directorySafe(path.dirname(destination), true);
    plan.push({ source, destination, bytes, previous: await fileBytes(destination) });
  };
  for (const name of PLUGIN_FILES) await add(path.join(sourceRoot, 'plugin', name), path.join(pluginDest, name));
  // The command-line tool is built at the top of the repository; a packaged installer carries it beside this file.
  const beside = path.join(sourceRoot, 'plugin', CLI_FILE);
  await add(await stat(beside) ? beside : path.join(sourceRoot, '..', CLI_FILE), path.join(pluginDest, CLI_FILE));
  await add(path.join(sourceRoot, 'SKILL.md'), path.join(opts.skillDir, 'SKILL.md'));

  const json = (name) => {
    try { return object(JSON.parse(plan.find((file) => file.destination === path.join(pluginDest, name)).bytes), name); }
    catch { throw new Error(`${name} in the installer is not a JSON object. Nothing was changed.`); }
  };
  const manifest = json('openclaw.plugin.json');
  json('package.json');
  if (manifest.id !== PLUGIN_ID) throw new Error('Wrong Gateway plugin in installer. Nothing was changed.');
  const declared = Array.isArray(manifest.contracts?.tools) ? manifest.contracts.tools : [];
  if (declared.length !== TOOL_NAMES.length || TOOL_NAMES.some((name) => !declared.includes(name))) {
    throw new Error('The plugin manifest and this installer list different tools (contracts.tools against TOOL_NAMES in install.mjs). Nothing was changed.');
  }
  for (const file of plan.filter((value) => /\.(?:js|mjs|cjs)$/.test(value.source))) {
    try { await syntaxCheck(file.source); }
    catch (error) { throw new Error(`Syntax check failed for ${file.source}. Nothing was changed.\n${String(error.stderr ?? error.message).split('\n').filter((line) => line.trim()).slice(0, 8).join('\n')}`); }
  }
  // The configuration is written again only when a key has to change, so a file that already has every entry
  // (after an earlier run, or edited by hand) keeps its bytes and its formatting.
  if (JSON.stringify(next) !== JSON.stringify(original)) {
    const inexact = inexactNumber(configBytes.toString('utf8'));
    if (inexact) throw new Error(`The OpenClaw configuration holds the number ${inexact}, which would come back altered if this installer rewrote the file. Nothing was changed. Add the configuration keys by hand as INSTALL.md lists them, then run the installer again: it leaves a configuration that already has them as it is.`);
    plan.push({ destination: opts.config, previous: configBytes, bytes: Buffer.from(JSON.stringify(next, null, 2) + '\n') });
  }
  for (const file of plan) await directorySafe(path.dirname(file.destination), true);
  const changed = plan.filter((file) => !file.previous || !file.previous.equals(file.bytes));

  log(`OpenClaw ${version}\nPlugin: ${pluginDest}\nSkill: ${opts.skillDir}\nBundles: ${bundlesDir}`);
  if (opts.check) {
    log(changed.length
      ? `An install would write ${fileCount(changed.length)}:\n${changed.map((file) => `  ${file.destination} (${file.previous ? 'replaced; the current file is backed up first' : 'new'})`).join('\n')}`
      : 'An install would replace no file: each one is already as this installer writes it.');
    if (missing.length) log(`An install would create: ${missing.join(', ')}`);
    log('Preflight passed. No files or services changed.');
    return { checked: true, version, pending: changed.length };
  }

  let backup = null;
  if (changed.length) {
    const backupRoot = path.join(opts.state, `${PLUGIN_ID}-install-backups`);
    await directorySafe(backupRoot, true);
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    backup = await fs.mkdtemp(path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
    await fs.chmod(backup, 0o700);
    for (const [index, file] of changed.entries()) {
      file.backup = path.join(backup, String(index));
      if (!file.previous) continue;
      await exec('/bin/cp', ['-p', file.destination, file.backup]);
      if (hash(await fs.readFile(file.backup)) !== hash(file.previous)) throw new Error('A destination changed while being backed up; nothing installed. Retry after editing finishes.');
    }
    await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(changed.map((file) => ({ destination: file.destination, previous: Boolean(file.previous), backup: path.basename(file.backup), installedSha256: hash(file.bytes) })), null, 2) + '\n', { mode: 0o600 });
  }
  const applied = [];
  try {
    for (const file of changed) {
      const current = await fileBytes(file.destination);
      if (Boolean(current) !== Boolean(file.previous) || (current && !current.equals(file.previous))) throw new Error(`File changed during install: ${file.destination}`);
      await directorySafe(path.dirname(file.destination), true);
      await fs.mkdir(path.dirname(file.destination), { recursive: true, mode: 0o700 });
      await replaceFile(file.destination, file.bytes);
      applied.push(file);
      if (hash(await fs.readFile(file.destination)) !== hash(file.bytes)) throw new Error(`Installed file verification failed: ${file.destination}`);
    }
    // Also run when nothing was replaced: the Gateway is not restarted on a configuration OpenClaw refuses.
    try { await run(openclaw, ['config', 'validate']); }
    catch { throw new Error(`"openclaw config validate" refused the configuration; ${changed.length ? 'restoring the files this run replaced' : 'this run had replaced no file'}. The Gateway was not restarted.`); }
  } catch (error) {
    const conflicts = [];
    for (const file of applied.reverse()) {
      try {
        const current = await fileBytes(file.destination);
        // Someone else wrote the file after this run did: their version stays and is reported.
        if (!current || hash(current) !== hash(file.bytes)) { conflicts.push(file.destination); continue; }
        if (file.previous) await replaceFile(file.destination, await fs.readFile(file.backup), file.backup);
        else await fs.unlink(file.destination);
      } catch { conflicts.push(file.destination); }
    }
    if (backup) log(`Backup: ${backup}`);
    if (conflicts.length) log(`Concurrent changes prevented automatic rollback of: ${conflicts.join(', ')}`);
    else if (applied.length) log(`Rolled back ${fileCount(applied.length)}: each destination is as it was before this run.`);
    throw error;
  }
  log(changed.length
    ? `Installed and verified ${fileCount(changed.length)}. Backup: ${backup}`
    : 'Nothing to replace: every file and the configuration are already as this installer writes them.');

  // After validation, so a refused install leaves no new folder behind. Existing folders are not touched at all.
  const created = [];
  for (const folder of folders) {
    try { if (await privateFolder(folder)) created.push(folder); }
    catch (error) { if (error.code !== 'EEXIST') log(`Could not create ${folder} (${error.code ?? error.message}). Create that folder by hand, open to this account only.`); }
  }

  let restarted = false;
  if (!opts.skipRestart) {
    if ((dependencies.platform ?? process.platform) === 'darwin') {
      try { await run('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${opts.label}`]); restarted = true; }
      catch { log(`Files installed; the existing service ${opts.label} could not be restarted. Restart the Gateway manually.`); }
    } else log('Files installed. Restart your existing Gateway service manually.');
  }
  if (restarted) log('Existing Gateway service restarted; its definition and environment were preserved.');
  else if (opts.skipRestart) log('Gateway restart skipped as requested. The plugin loads the next time the Gateway starts.');

  if (ownBundles) log(`The configuration sets bundlesDir, so the plugin reads bundles from ${bundlesDir}. The installer did not create or change that folder.`);
  else {
    log(`Put diagnostics bundles in this folder: ${bundlesDir}`);
    const info = await fs.stat(bundlesDir).catch(() => null);
    if (info && !created.includes(bundlesDir) && (info.mode & 0o077)) log('That folder was already there and other accounts on this computer can open it. The installer left its permissions as they were; bundles hold user names and file paths.');
  }
  log('A bundle is an Excel_Diagnostics_....zip file, or the folder it unzips to, placed directly in that folder. The installer never changes or removes anything in it.');
  log(`Open a fresh OpenClaw conversation to use the ${SKILL_NAME} skill: OpenClaw loads skills when a conversation starts.`);
  log(`To check the install, run "openclaw plugins list" and "openclaw skills list". Each should list ${PLUGIN_ID}.`);
  return { installed: true, backup, version, restarted, changed: changed.length, bundlesDir, created };
}

// Node gives import.meta.url with links resolved while argv keeps the path as typed, so the two are compared after
// resolving both. Compared as typed, an installer started from a linked folder would do nothing and report success.
async function startedDirectly() {
  if (!process.argv[1]) return false;
  try { return await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (await startedDirectly()) {
  try { await install(); }
  catch (error) {
    console.error(`INSTALL FAILED: ${error.message}`);
    if (error.code === 'EACCES' || error.code === 'EPERM') console.error('The Gateway account needs access to the destination shown above. Correct that folder\'s permission; do not run the installer as another user or with sudo.');
    process.exitCode = 1;
  }
}
