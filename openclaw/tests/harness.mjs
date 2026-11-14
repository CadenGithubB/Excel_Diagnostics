/**
 * Loads the REAL plugin (plugin/index.js, unmodified) against a fake OpenClaw host object, and runs the
 * REAL command-line tool in request mode. Nothing here needs OpenClaw installed.
 *
 * The sample bundle is the engine's own built-in sample data written to a temp folder, so every case sees
 * the same 32,861 entries: a crash at 2026-03-10 10:35:00 local time, one Jetsam and one Crash report, and
 * memory files.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export { describe, it } from './dsl.mjs';
export { default as assert } from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const CLI_PATH = path.join(REPO, 'excel_diagnostics_cli.mjs');
export const PLUGIN_DIR = path.resolve(HERE, '..', 'plugin');
export const PLUGIN_PATH = path.join(PLUGIN_DIR, 'index.js');
export const SKILL_PATH = path.resolve(HERE, '..', 'SKILL.md');
export const SAMPLE_ID = 'Excel_Diagnostics_sample';

// How this process was started is how the command-line tool is started: Node runs a file directly, Deno needs "run -A".
export const RUNTIME = globalThis.Deno ? [globalThis.Deno.execPath(), 'run', '-A'] : [process.execPath];

const temps = [];
let seq = 0;
let sampleDir = null;

/** A new empty temp folder, removed by cleanup(). */
export async function emptyDir(prefix = 'dir') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `excel-diag-test-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** A bundles folder holding one bundle, Excel_Diagnostics_sample, written once per test process. */
export function sampleBundlesDir() {
  sampleDir ??= (async () => {
    const dir = await emptyDir('bundles');
    const Core = new Function(`${await fs.readFile(path.join(REPO, 'src', 'core.js'), 'utf8')}\nreturn Core;`)();
    for (const { path: rel, blob } of Core.sampleBundle(1)) {
      const dest = path.join(dir, ...rel.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, new Uint8Array(await blob.arrayBuffer()));
    }
    return dir;
  })();
  return sampleDir;
}

/**
 * Run the built command-line tool in request mode. `req` is sent as JSON on stdin; pass { input } to send
 * raw text instead. Resolves { code, stdout, stderr, json } where json is the parsed stdout or null.
 * The program gets this process's environment, with `env` laid over it.
 */
export function request(req, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(RUNTIME[0], [...RUNTIME.slice(1), CLI_PATH, 'request'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(env ?? {}) } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* left null: the case decides whether that is a failure */ }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.on('error', () => { /* the program may exit before reading everything */ });
    child.stdin.end(input !== undefined ? input : JSON.stringify(req));
  });
}

/**
 * Run the text command line: resolves { code, stdout, stderr, out, err }, where out and err are the same output as
 * bytes (a case about control characters has to look at bytes). The program gets this process's environment with
 * `env` laid over it, and runs in the folder `cwd` when one is given. A run that is still going after `timeoutMs`
 * is stopped and resolves with code null.
 */
export function cli(args, { env, cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(RUNTIME[0], [...RUNTIME.slice(1), CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(env ?? {}) }, ...(cwd ? { cwd } : {}) });
    const out = [], err = [];
    const timer = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs) : null;
    child.stdout.on('data', (d) => { out.push(d); });
    child.stderr.on('data', (d) => { err.push(d); });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), out: Buffer.concat(out), err: Buffer.concat(err) }); });
  });
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/**
 * A zip file as bytes, written here so that a case can put into one what no zip program would: a name with ".."
 * in it, a name that is only ".", a name with a NUL. `entries` is [{ name, data, deflate }]: name and data are
 * strings or Buffers, and a member is stored as it is unless deflate is true. Every member is a plain file.
 */
export function zipBytes(entries) {
  const locals = [], central = [];
  let at = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8'), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8'), crc = crc32(data);
    const packed = e.deflate ? deflateRawSync(data) : data, method = e.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(method, 10); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(at, 42);
    locals.push(local, name, packed); central.push(dir, name);
    at += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Math.min(entries.length, 0xFFFF), 8); end.writeUInt16LE(Math.min(entries.length, 0xFFFF), 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Load the plugin against a fake host. Returns { tools, raw, definitions, hook, hooks, entry, module,
 * bundlesDir, logs }.
 *   tools.get(name)       async (params) => details        (what specs usually assert on)
 *   raw.get(name)         async (params) => envelope       ({ content, details, isError? })
 *   definitions.get(name) the object the plugin passed to registerTool
 * Options: pluginConfig (merged over { bundlesDir }), deps (second argument of register), sample (default
 * true; false gives an empty bundles folder), bundlesDir (use this folder), noConfig (pass no pluginConfig).
 */
export async function loadPlugin(options = {}) {
  // The plugin's default folders hang off the OpenClaw state folder: keep them out of the real home folder.
  process.env.OPENCLAW_STATE_DIR = await emptyDir('state');
  delete process.env.EXCEL_DIAGNOSTICS_BUNDLES;
  const bundlesDir = options.bundlesDir ?? (options.sample === false ? await emptyDir('bundles') : await sampleBundlesDir());
  const mod = await import(`${pathToFileURL(PLUGIN_PATH).href}?v=${++seq}`);
  const entry = mod.default;
  const tools = new Map(), raw = new Map(), definitions = new Map(), hooks = new Map(), logs = [];
  let hook = null;
  const api = {
    pluginConfig: options.noConfig ? undefined : { bundlesDir, ...(options.pluginConfig ?? {}) },
    config: options.config,
    logger: { info: (message) => { logs.push(String(message)); } },
    registerTool(t) {
      definitions.set(t.name, t);
      raw.set(t.name, (params) => t.execute('test-call', params));
      tools.set(t.name, async (params) => unwrap(await t.execute('test-call', params)));
    },
    on(event, fn) { hooks.set(event, fn); if (event === 'before_tool_call') hook = fn; },
  };
  entry.register(api, options.deps ?? {});
  return { tools, raw, definitions, hook, hooks, entry, module: mod, bundlesDir, logs };
}

/** The plugin's own object inside a Gateway result envelope, or the value itself. */
function unwrap(r) {
  return r && typeof r === 'object' && Array.isArray(r.content) && r.details !== undefined ? r.details : r;
}

/** The text of every content block of an envelope, in order. */
export const blocks = (envelope) => (envelope?.content ?? []).map((b) => (b && b.type === 'text' ? b.text : ''));

/** Remove every temp folder this process created. */
export async function cleanup() {
  sampleDir = null;
  for (const dir of temps.splice(0)) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
