/* Excel diagnostics for OpenClaw: ten read-only tools over the diagnostics bundles kept in one folder on the host.
 *
 * The plugin does no log work itself. For each call it starts the command-line tool (excel_diagnostics_cli.mjs,
 * the viewer's own engine) in request mode, gives it the arguments the tool declares exactly as the model sent
 * them, and lays the answer out for the model: how the call was read, one line of facts as JSON, the quoted lines,
 * then what could be called next. Arguments are checked in that program and not here, so a wrong call always comes
 * back with the program's own sentence about what to send instead.
 *
 * Every string below that reaches the model (descriptions, facts, refusals) is written for a small local model
 * that acts on what it reads word for word: it names real fields, it never shows a path on this machine, and it
 * never says why anything in the logs happened.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'excel-diagnostics';
const PLUGIN_NAME = 'Excel Diagnostics';
const PLUGIN_SAID = 'Read-only search of Excel diagnostics log bundles kept in a folder on the host.';
const PREFIX = 'excel_diag_';
const CLI_NAME = 'excel_diagnostics_cli.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_USUAL = 120;                                // seconds one call may take when the configuration names none
const TIMEOUT_LEAST = 5;
const TIMEOUT_MOST = 600;
const OUTPUT_MOST = 2 * 1024 * 1024;                      // bytes of standard output taken from one run of the program
const REPEAT_REFUSED = 3;                                 // which identical call in a row is refused
const REPEAT_WINDOW_MS = 30 * 60_000;
const SESSIONS_MOST = 200;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- the tools ----------
// The schemas are loose on purpose: no required field, no enum, no range, nothing forbidden. A call the host's own
// schema check refuses never reaches the tool, and the model is then shown the host's refusal of the whole call in
// place of one sentence naming the argument at fault and what to send. So every call is let through, and request
// mode answers the wrong ones.
//
// A description is all the model knows of a tool before it reads the skill. Each leads with the argument shape,
// shows one value, says which result column or field a value is copied from, and names the wrong argument names a
// model reaches for, because an undeclared name narrows nothing.
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties) => ({ type: 'object', properties, required: [] });

const AS_PRINTED = 'written the way results print times';
const BOOLEAN = 'Send true or false without quotation marks.';
// Sizes are described without a figure: a small model takes a number it is shown for the number to send.
const WHOLE = 'a whole number without quotation marks';
const utc = () => bool(`true prints times in UTC and reads the times you send as UTC. Left out, times are in the zone the result names in timeZone. ${BOOLEAN}`);
const bundle = () => str(`Bundle id, copied from availableBundles in excel_diag_summary results. Leave it out for the newest bundle. It is an id, never a file path (not 'name', 'file' or 'bundleId').`);
// The arguments excel_diag_search, excel_diag_count and excel_diag_histogram share. Each tool gets its own copy.
const filters = () => ({
  query: str(`Words to find, all of them, e.g. {query: "pivot cache"}. Also "a phrase", -word, /regex/ and fields such as tag:memory (process: level: pid: subsystem: category: source:). Not 'q' or 'text'.`),
  from: str(`Start of a time span, ${AS_PRINTED}, e.g. "2026-03-10 10:30:00". A date alone means midnight (not 'start' or 'since').`),
  to: str(`End of a time span, ${AS_PRINTED}, e.g. "2026-03-10 11:00:00". A date alone means midnight (not 'end' or 'until').`),
  aroundId: int(`Centre a time span on this entry: a number from the ID column of results, e.g. 15501. window sets the length either side. Not together with aroundTime, from or to.`),
  aroundTime: str(`Centre a time span on this time, ${AS_PRINTED}, e.g. "2026-03-10 10:35:00". window sets the length either side. Not together with aroundId, from or to.`),
  window: str(`Length of time either side of aroundId or aroundTime: a number and a unit in one string, e.g. "30s", "2m" or "1h" (also ms and d). It needs one of those two; for a fixed span send from and to.`),
  minSeverity: str(`Lowest severity to keep: "debug", "info", "notice", "warning", "error" or "fault". For example "error" keeps errors and faults (not 'severity' or 'level').`),
  matchCase: bool(`true makes capitals matter in query; left out, capitals are ignored. ${BOOLEAN}`),
  utc: utc(),
  bundle: bundle(),
});
const FILTER_SHAPE = 'query?, from?, to?, aroundId?, aroundTime?, window?, minSeverity?, matchCase?, utc?, bundle?';

export const TOOLS = [
  {
    name: 'excel_diag_summary',
    description: `Describe a diagnostics bundle: {utc?, bundle?}. Start with {} for the newest bundle; {utc: true} prints times in UTC. Returns entries (log entries on the timeline), period (first and last entry time), timeZone, counts by severity and by tag, the busiest processes, how many report files there are, and availableBundles: the ids to copy into bundle (an id, not a path or 'name'). Then one line per log source.`,
    parameters: schema({ utc: utc(), bundle: bundle() }),
  },
  {
    name: 'excel_diag_search',
    description: `List log entries that meet every condition: {${FILTER_SHAPE}, limit?, offset?, newest?, maxChars?}, e.g. {query: "pivot cache", minSeverity: "error"} (query, not 'q' or 'pattern'). Returns matched of total and one line per entry, oldest first. The ID column gives the id for excel_diag_show and excel_diag_context. truncated:true means more matched than are listed.`,
    parameters: schema({
      ...filters(),
      limit: int(`How many entries to list in this call: ${WHOLE} (not 'count' or 'max'). When more match, the result has truncated:true and nextOffset.`),
      offset: int(`How many matches to skip from the first: ${WHOLE}. Copy nextOffset from the previous result (not 'page' or 'skip'). Not together with newest.`),
      newest: bool(`true lists the last matches instead of the first. Not together with offset. ${BOOLEAN}`),
      maxChars: int(`How many characters of each message to print on its line: ${WHOLE}. A longer message ends with …[N more characters]; read it with excel_diag_show.`),
    }),
  },
  {
    name: 'excel_diag_count',
    description: `Count log entries that meet every condition: {${FILTER_SHAPE}, by?, limit?}. Filters work as in excel_diag_search. by is what to count by, e.g. {by: "process"} (not 'groupBy' or 'field'): returns values with the entries of each, largest first, and moreValues, how many more values exist. Without by: the largest values by severity, source, tag and process.`,
    parameters: schema({
      ...filters(),
      by: str(`What to count by: "severity", "level", "source", "tag", "process", "subsystem", "category" or "file". For example "process" (not 'groupBy' or 'field').`),
      limit: int(`How many values to list when by is given: ${WHOLE}. moreValues in the result is how many further values exist.`),
    }),
  },
  {
    name: 'excel_diag_histogram',
    description: `Count entries per time interval: {${FILTER_SHAPE}, bins?}, e.g. {minSeverity: "warning"}. Filters work as in excel_diag_search; bins is the most intervals to make (not 'buckets'). Returns a line per interval with entries (START, ENTRIES, ERRORS, WARNINGS) and fullest, the interval with the most: copy fullest.from and fullest.to into from and to of excel_diag_search.`,
    parameters: schema({
      ...filters(),
      bins: int(`The most intervals to split the span into: ${WHOLE} (not 'buckets' or 'interval'). Each interval is a whole number of seconds long, so there can be fewer.`),
    }),
  },
  {
    name: 'excel_diag_show',
    description: `Read one log entry in full: {id, maxChars?, utc?, bundle?}. id is the number in the ID column of excel_diag_search or excel_diag_context results, e.g. 15501 (not 'entry' or 'index'). Returns its fields (time, severity, source, process and more) and its message; truncated:true means the message is longer than what is shown, so send a larger maxChars.`,
    parameters: schema({
      id: int(`Entry id: the number in the ID column of excel_diag_search or excel_diag_context results, e.g. 15501 (not 'entry' or 'index'). Copy it; do not guess one.`),
      maxChars: int(`How many characters of the message to return: ${WHOLE}. Send a larger one when the result has truncated:true; messageChars is the message's full length.`),
      utc: utc(),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_context',
    description: `Show what every source logged around one entry or one moment: {id?, time?, before?, after?, window?, maxChars?, utc?, bundle?}. Send id or time, not both. id is a number from the ID column of excel_diag_search, e.g. 15501 (not 'entry' or 'aroundId'); time is ${AS_PRINTED}. No query applies. Returns one line per entry, with > before the anchor entry; truncated:true means more was logged there than is listed.`,
    parameters: schema({
      id: int(`Entry to centre on: a number from the ID column of excel_diag_search results, e.g. 15501 (not 'entry' or 'aroundId'). Send id or time, not both.`),
      time: str(`Moment to centre on, ${AS_PRINTED}, e.g. "2026-03-10 10:35:00" (not 'aroundTime' or 'at'). Send time or id, not both.`),
      before: int(`How many entries before the anchor to list: ${WHOLE}. Not used when window is given.`),
      after: int(`How many entries after the anchor to list: ${WHOLE}. Not used when window is given.`),
      window: str(`List what was logged within this length of time either side, in place of before and after: a number and a unit in one string, e.g. "30s", "1m" or "1h".`),
      maxChars: int(`How many characters of each message to print on its line: ${WHOLE}. A longer message ends with …[N more characters]; read it with excel_diag_show.`),
      utc: utc(),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_reports',
    description: `List the crash, hang and other diagnostic report files of a bundle: {utc?, bundle?}. Call it with {}; {utc: true} prints times in UTC. Returns reports (how many the bundle holds), byKind, and one line per report, oldest first: TIME, KIND, PROCESS, FILE. Copy FILE into path of excel_diag_read_file to read a report, or TIME into time of excel_diag_context. truncated:true means the bundle holds more reports than are listed.`,
    parameters: schema({ utc: utc(), bundle: bundle() }),
  },
  {
    name: 'excel_diag_files',
    description: `List the files in a bundle: {filter?, limit?, offset?, bundle?}. filter keeps the paths that contain it, capitals ignored, e.g. {filter: "reports"} (not 'query', 'path' or 'pattern'). Returns one line per file: SIZE, TIMELINE_ENTRIES (entries that came from it; - when it is not on the timeline) and PATH. Copy PATH into path of excel_diag_read_file. truncated:true means more files than are listed: send nextOffset as offset.`,
    parameters: schema({
      filter: str(`Keep only the file paths that contain this text, capitals ignored, e.g. "reports" (not 'query', 'path' or 'pattern').`),
      limit: int(`How many files to list in this call: ${WHOLE} (not 'count' or 'max').`),
      offset: int(`How many files to skip from the first: ${WHOLE}. Copy nextOffset from the previous result (not 'page' or 'skip').`),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_read_file',
    description: `Read lines of one file in a bundle: {path, fromLine?, limit?, grep?, bundle?}. path is copied from the PATH column of excel_diag_files or the FILE column of excel_diag_reports, e.g. "summary.md" (not 'file' or 'filename'). grep keeps only the lines that contain it. Returns lines (how many the file has) and the lines read; truncated:true means more follow: send nextFromLine as fromLine. A file that is not text gives the error "binary file".`,
    parameters: schema({
      path: str(`Path of a file in the bundle, copied from the PATH column of excel_diag_files or the FILE column of excel_diag_reports, e.g. "summary.md" (not 'file', 'filename' or 'name').`),
      fromLine: int(`Line to start from: ${WHOLE}; the first line is 1. Copy nextFromLine from the previous result (not 'offset' or 'line').`),
      limit: int(`How many lines to return in this call: ${WHOLE} (not 'count' or 'lines').`),
      grep: str(`Keep only the lines that contain this text, capitals ignored, e.g. "exception" (not 'query' or 'pattern'). Each is printed as N: text, where N is its line number.`),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_memory',
    description: `Give the memory records of a bundle as figures: {utc?, bundle?}. Call it with {}; {utc: true} prints times in UTC. Returns files (kind, path, bytes: copy a path into path of excel_diag_read_file), timeline when the bundle has a memory timeline (for Excel's footprint, CPU and threads, free memory and swap: the lowest and highest value with the time of each, and the last value), and memoryEntries, how many log entries are tagged memory.`,
    parameters: schema({ utc: utc(), bundle: bundle() }),
  },
];

// The six everyday tools stay in the model's tool list with their schemas. A deferred tool is reached through the
// host's tool_call wrapper, where the arguments travel as a nested object and a search text full of quotation
// marks and backslashes has to survive one more layer of escaping; a small model gets that wrong. The other four
// are used less often and stay deferred, which keeps the tool list short.
export const DIRECT_TOOLS = new Set(['excel_diag_summary', 'excel_diag_search', 'excel_diag_show', 'excel_diag_context', 'excel_diag_reports', 'excel_diag_read_file']);

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ---------- configuration ----------
// Read once, when the Gateway loads the plugin. The host checks the configuration against the manifest's schema,
// but a value can also arrive from the environment or from a host that does not check, so each one is checked
// again here. A bad value is never used as it stands: the default is, and one log line says so.
function settings(given, env, log) {
  const config = isObject(given) ? given : {};
  const stateDir = typeof env.OPENCLAW_STATE_DIR === 'string' && path.isAbsolute(env.OPENCLAW_STATE_DIR) ? env.OPENCLAW_STATE_DIR : path.join(os.homedir(), '.openclaw');
  const root = path.join(stateDir, PLUGIN_ID), usual = path.join(root, 'bundles');
  const set = (v) => v !== undefined && v !== null;
  const [where, value] = set(config.bundlesDir) ? ['bundlesDir in the plugin configuration', config.bundlesDir]
    : env.EXCEL_DIAGNOSTICS_BUNDLES ? ['EXCEL_DIAGNOSTICS_BUNDLES in the environment', env.EXCEL_DIAGNOSTICS_BUNDLES] : ['', undefined];
  let bundlesDir = usual;
  if (where) {
    if (typeof value === 'string' && path.isAbsolute(value)) bundlesDir = path.resolve(value);
    else log(`${where} is not an absolute path, so the default bundles folder is used: ${usual}`);
  }
  // Request mode refuses a cache folder inside the bundles folder, where unpacked zips would turn up as bundles of
  // their own. A bundles folder set to a parent of the usual cache folder would make every call fail that way, so
  // no cache folder is named then and the program unpacks under the temporary folder, as it does at a terminal.
  let cacheDir = path.join(root, 'cache');
  if (!path.relative(bundlesDir, cacheDir).startsWith('..')) {
    log(`the bundles folder ${bundlesDir} contains the folder zips are usually unpacked in, so they are unpacked under the temporary folder instead.`);
    cacheDir = null;
  }
  let timeoutSeconds = TIMEOUT_USUAL;
  if (set(config.timeoutSeconds)) {
    if (Number.isInteger(config.timeoutSeconds) && config.timeoutSeconds >= TIMEOUT_LEAST && config.timeoutSeconds <= TIMEOUT_MOST) timeoutSeconds = config.timeoutSeconds;
    else log(`timeoutSeconds in the plugin configuration is not a whole number from ${TIMEOUT_LEAST} to ${TIMEOUT_MOST}, so ${TIMEOUT_USUAL} is used.`);
  }
  return { bundlesDir, cacheDir, timeoutMs: timeoutSeconds * 1000 };
}

// The installer puts the command-line tool beside this file. In the repository it lives two folders up.
function findCli() {
  const beside = path.join(HERE, CLI_NAME);
  return fs.existsSync(beside) ? beside : path.resolve(HERE, '..', '..', CLI_NAME);
}

// ---------- running the program ----------
// One run answers one call: the request goes in on standard input, one JSON document comes out on standard output.
// No shell is involved and nothing the model sent is on the command line. The program gets a small fixed
// environment, so no secret in the Gateway's own environment can reach it. Whatever it writes to standard error
// (unpacking progress, a stack trace) is dropped: it is written for a person at a terminal and must not be passed
// to a model as if it were a result.
//
// Always resolves, never rejects: { code, stdout, cause }. `cause` names why there may be no document: 'timeout',
// 'cancelled', 'output' (more output than one answer can be) or 'start' (the process could not be started).
function runProgram(request, { cliPath, timeoutMs, signal }) {
  const input = JSON.stringify(request);
  return new Promise((resolve) => {
    const decoder = new TextDecoder();
    let child = null, timer = null, stdout = '', size = 0, cause = null, done = false;
    const stop = (why) => {
      cause ??= why;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const onAbort = () => stop('cancelled');
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { signal?.removeEventListener?.('abort', onAbort); } catch { /* not a real signal */ }
      resolve({ code, stdout: cause === 'output' ? '' : stdout + decoder.decode(), cause });
    };
    try {
      // Deno runs this file only in the tests, and it needs to be told to run a script and what the script may do.
      const args = globalThis.Deno ? ['run', '-A', cliPath, 'request'] : [cliPath, 'request'];
      child = spawn(process.execPath, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        // The program asks for its working folder when it loads, so it is given one that is sure to exist.
        cwd: path.dirname(cliPath),
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: os.tmpdir() },
        windowsHide: true,
      });
    } catch {
      cause = 'start';
      finish(null);
      return;
    }
    child.on('error', () => { stop('start'); finish(null); });
    child.on('close', (code) => finish(code));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > OUTPUT_MOST) stop('output');
      else stdout += decoder.decode(chunk, { stream: true });
    });
    child.stdin.on('error', () => { /* the program can exit before it has read the request */ });
    // A call that outlives its time is killed, not left behind: each run indexes a whole bundle and holds it in memory.
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) stop('cancelled');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdin.end(input);                               // closed at once: the program answers when its input ends
  });
}

// ---------- what a tool returns ----------
// When the program gives no document there is nothing of its own to pass on, so the model gets one fixed sentence
// for each way that can happen. Fixed, because a model that repeats the call must get the same text again: the
// host stops a loop only when it sees identical results. Each says what to do instead, and none shows a path, an
// exit status or anything the program wrote.
const NO_ANSWER = 'the Excel diagnostics program did not answer';
const NO_ANSWER_HINT = {
  timeout: 'The call took longer than this tool allows and was stopped: send it once more with a shorter time span (from and to) or with a smaller bundle, or tell the human that this bundle is too slow to search here.',
  // For a tool that takes no time span: naming one would send the model after an argument the tool does not have.
  timeoutWhole: 'The call took longer than this tool allows and was stopped: send it once more with a smaller bundle, or tell the human that this bundle is too slow to search here.',
  missing: 'The program behind the excel_diag tools is not installed on the OpenClaw host: tell the human to run the Excel diagnostics installer again, and do not call these tools until the human says that is done.',
  start: 'The program behind the excel_diag tools could not be started on the OpenClaw host: tell the human, and do not call these tools again until the human says it is fixed.',
  cancelled: 'The call was cancelled before the program answered: send it again only if its result is still needed.',
  silent: 'The program stopped without giving a result: tell the human that this call could not be answered, and do not send the same call again.',
  plugin: 'The tool failed before the program could answer: tell the human that this call could not be answered, and do not send the same call again.',
};
const noAnswer = (cause) => ({ ok: false, error: NO_ANSWER, hint: NO_ANSWER_HINT[cause] });

const block = (text) => ({ type: 'text', text });
// The names are said back bare, as the model wrote them, in one sentence it can act on.
function ignoredSaid(tool, names) {
  if (names.length === 1) return `${names[0]} is not a field of ${tool} and was ignored, so this result is not narrowed by it. Send the call again with one of the allowed fields if it mattered.`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are not fields of ${tool} and were ignored, so this result is not narrowed by them. Send the call again with the allowed fields if they mattered.`;
}

// A failure is one JSON line and nothing else: the error, the argument at fault, and what to send instead.
function failure(tool, doc, more) {
  const details = { ok: false, tool };
  if (typeof doc.bundle === 'string' && doc.bundle) details.bundle = doc.bundle;
  details.error = doc.error;
  for (const key of ['field', 'hint']) if (typeof doc[key] === 'string' && doc[key]) details[key] = doc[key];
  if (Array.isArray(doc.candidates)) details.candidates = doc.candidates.filter((c) => typeof c === 'string');
  Object.assign(details, more);
  return { content: [block(JSON.stringify(details))], details, isError: true };
}

// A success is up to four blocks in a fixed order. Corrections come first, so the model reads how its call was
// taken before it reads the result. "Next:" comes last, so what could be done next is the last thing it reads
// before its own turn. The quoted lines stay plain text between them: inside a JSON string every quotation mark
// and line break in a log message would be escaped, and a model copies what it sees.
function success(tool, doc, more, ignored) {
  const details = { ok: true, tool };
  if (typeof doc.bundle === 'string' && doc.bundle) details.bundle = doc.bundle;
  Object.assign(details, isObject(doc.receipt) ? doc.receipt : {}, more, { ok: true, tool });
  const notes = Array.isArray(doc.notes) ? doc.notes.filter((n) => typeof n === 'string' && n) : [];
  if (ignored.length) notes.unshift(ignoredSaid(tool, ignored));
  const content = [];
  if (notes.length) content.push(block(`Facts about this call:\n${notes.map((n) => `- Fact: ${n}`).join('\n')}`));
  content.push(block(JSON.stringify(details)));
  if (typeof doc.text === 'string' && doc.text) content.push(block(doc.text));
  if (typeof doc.next === 'string' && doc.next) content.push(block(`Next: ${doc.next}`));
  return { content, details };
}

// The document the program printed, when it printed one. It is used whatever the exit status was.
function documentOf(outcome) {
  if (!outcome || typeof outcome.stdout !== 'string') return null;
  try {
    const doc = JSON.parse(outcome.stdout);
    return isObject(doc) ? doc : null;
  } catch {
    return null;
  }
}

// ---------- the repeat guard ----------
// A small model that has a result and does not know what to do with it sends the same lookup again, and again.
// The third identical call in a row is refused, once, with what to do instead. Only once: the fourth and later
// ones run as usual, because the host has its own loop detection that works by seeing identical calls return
// identical results, and a tool that refuses every repeat hides the loop from it. The refusal is a constant for
// the same reason. Only this plugin's tools are ever refused; a call to any other tool is not looked at beyond
// the fact that it came in between, which starts the count again.
function repeatGuard(now) {
  const last = new Map();                                 // session -> { name, key, count, at, callId }, least recently used first
  const sorted = (_, v) => (isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
  return (event, ctx) => {
    try {
      const session = String(event?.sessionKey ?? ctx?.sessionKey ?? event?.runId ?? ctx?.runId ?? 'default');
      let name = event?.toolName, args = event?.params;
      // A deferred tool arrives inside the host's wrapper, as tool_call {id, args}; the id can carry a prefix that
      // ends in a colon. It is the same call as the bare one and is counted with it. When the model put the
      // arguments beside id instead of inside args, the whole wrapper stands in for them.
      if (name === 'tool_call' && isObject(args) && typeof args.id === 'string') {
        const target = args.id.slice(args.id.lastIndexOf(':') + 1);
        if (TOOL_NAMES.has(target)) { name = target; args = isObject(args.args) ? args.args : args; }
      }
      if (!TOOL_NAMES.has(name)) { last.delete(session); return undefined; }
      const key = `${name} ${JSON.stringify(isObject(args) ? args : {}, sorted)}`, at = now(), before = last.get(session);
      // A host may announce one deferred call twice, as the wrapper and then as the tool it names. Counted twice,
      // the model's second identical call would be refused as its third. Two events in a row that carry the same
      // call id are therefore one call; a call the model sends again arrives with a new id and is counted.
      const callId = [event?.toolCallId, ctx?.toolCallId].find((v) => typeof v === 'string' && v);
      if (callId && before && before.callId === callId && before.name === name) return undefined;
      const count = before && before.key === key && at - before.at < REPEAT_WINDOW_MS ? before.count + 1 : 1;
      last.delete(session);
      last.set(session, { name, key, count, at, callId });
      if (last.size > SESSIONS_MOST) last.delete(last.keys().next().value);
      if (count !== REPEAT_REFUSED) return undefined;
      return { block: true, blockReason: `This exact ${name} call was just made twice and its result has not changed. Do not repeat it: use the result you already have and take the next step, or answer.` };
    } catch {
      return undefined;                                   // a guard that fails must not take the tools down with it
    }
  };
}

// ---------- registration ----------
// `deps` is for the tests only: run(request, { cliPath, timeoutMs, signal }) -> Promise<{ code, stdout }> stands in
// for starting the program, cliPath names another program to start, and now() is the repeat guard's clock.
export function register(api, deps = {}) {
  const d = isObject(deps) ? deps : {};
  const log = (message) => { try { api?.logger?.info?.(`${PLUGIN_ID}: ${message}`); } catch { /* a log line never decides a call */ } };
  const { bundlesDir, cacheDir, timeoutMs } = settings(api?.pluginConfig, process.env, log);
  const cliPath = typeof d.cliPath === 'string' && d.cliPath ? d.cliPath : findCli();
  const run = typeof d.run === 'function' ? d.run : runProgram;
  if (run === runProgram && !fs.existsSync(cliPath)) log(`${CLI_NAME} was not found beside the plugin, so every tool call will say the program is not installed. Run the installer again.`);

  // Never rejects and never returns a bare object. The host's wrapper for deferred tools checks that a result has
  // a content array before the model sees anything; a result without one is refused there, the model is shown the
  // wrapper's complaint in place of the result, and it sends the same correct call again.
  async function answer(tool, known, declared, given, signal) {
    try {
      // Only declared arguments are sent on, each exactly as it came. A name the tool does not declare is reported
      // and not passed, so that "was ignored" is true of every tool; nothing is renamed or guessed.
      const params = {}, ignored = [];
      for (const key of Object.keys(isObject(given) ? given : {})) {
        if (known.has(key)) params[key] = given[key];
        else ignored.push(key);
      }
      const more = ignored.length ? { ignoredFields: ignored, allowedFields: [...declared] } : {};
      const request = { format: 1, op: tool.slice(PREFIX.length), bundlesDir, ...(cacheDir ? { cacheDir } : {}), params };
      const outcome = await run(request, { cliPath, timeoutMs, signal });
      const doc = documentOf(outcome);
      if (doc && doc.ok === true) return success(tool, doc, more, ignored);
      if (doc && doc.ok === false && typeof doc.error === 'string' && doc.error) return failure(tool, doc, more);
      const cause = outcome?.cause === 'timeout' || outcome?.cause === 'cancelled' ? outcome.cause
        : run === runProgram && !fs.existsSync(cliPath) ? 'missing' : outcome?.cause === 'start' ? 'start' : 'silent';
      log(`${tool} got no answer from the program (${cause}${cause === 'timeout' ? ` after ${timeoutMs / 1000} s` : ''}, exit status ${outcome?.code ?? 'none'}).`);
      return failure(tool, noAnswer(cause === 'timeout' && !known.has('from') ? 'timeoutWhole' : cause), more);
    } catch (err) {
      // Anything can be thrown, a value that cannot be turned into text included, and this path must still answer.
      let said = 'an error that cannot be shown';
      try { said = String(err?.message ?? err); } catch { /* keep the stand-in */ }
      log(`${tool} failed inside the plugin: ${said}`);
      return failure(tool, noAnswer('plugin'), {});
    }
  }

  if (typeof api?.registerTool === 'function') {
    for (const t of TOOLS) {
      const declared = Object.keys(t.parameters.properties), known = new Set(declared);
      api.registerTool({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(DIRECT_TOOLS.has(t.name) ? { catalogMode: 'direct-only' } : {}),
        execute: (_callId, params, signal) => answer(t.name, known, declared, params, signal),
      });
    }
  }
  if (typeof api?.on === 'function') {
    const guard = repeatGuard(typeof d.now === 'function' ? d.now : Date.now);
    api.on('before_tool_call', async (event, ctx) => guard(event, ctx));
  }
}

export default { id: PLUGIN_ID, name: PLUGIN_NAME, description: PLUGIN_SAID, register };
