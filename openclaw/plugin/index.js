/* Excel diagnostics for OpenClaw: ten read-only tools over the diagnostics bundles kept in one folder on the host.
 *
 * The plugin does no log work itself. For each call it starts the command-line tool (excel_diagnostics_cli.mjs,
 * the viewer's own engine) in request mode, gives it the arguments the tool declares exactly as the model sent
 * them, and lays the answer out for the model: how the call was read, one line of facts as JSON, the quoted lines,
 * then what could be called next, or a line that says the result ends. Arguments are checked in that program and
 * not here, so a wrong call always comes back with the program's own sentence about what to send instead: the names
 * a tool does not declare are handed to it apart from the arguments, for it to refuse the ones that stand for an
 * argument of another name.
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
// The ceiling on one result handed to the model, just above the most the program gives in one answer: its own limits
// on the text, the receipt, the notes and Next (TEXT_MOST, RECEIPT_MOST, NOTES_MOST and NEXT_MOST in src/request.js,
// restated here: a case in the tests checks that they agree), and room for what is laid round them here: the bundle
// id, which can be as long as a file name with every character written as its escape, the words and markers of the
// blocks, and the names that were ignored, said back (IGNORED_SAID of them at most, each cut short). So a result the
// program gives whole is never refused here; one over it is something the program did not bound.
export const PROGRAM_MOST = { text: 10000, receipt: 7000, notes: 3000, next: 2000 };
const IGNORED_SAID = 10, IGNORED_NAME_MOST = 40;
// A file name is at most 255 bytes, and no byte of it is written as more than a six-character escape. An ignored name
// is cut to IGNORED_NAME_MOST characters and an ellipsis, each character written as one escape at most, in the JSON
// line (with its quotation marks and a comma) and said once more in its fact (with a comma and a space). A thousand
// characters are for the rest: the keys of the JSON line, the words of the blocks and of the fact about ignored
// names, and the allowed names.
const LAID_ROUND = 255 * 6 + IGNORED_SAID * ((IGNORED_NAME_MOST * 6 + 4) + (IGNORED_NAME_MOST + 3)) + 1000;
export const RESULT_MOST = Object.values(PROGRAM_MOST).reduce((a, n) => a + n, 0) + LAID_ROUND;

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
// model reaches for, because an undeclared name narrows nothing. All ten are in the model's tool list (DIRECT_TOOLS),
// so every word here is read on every turn: a description is one sentence where it can be, and text that several
// arguments share (the bundle, the clock, the filters) is said once, short, and not explained again in each.
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const schema = (properties) => ({ type: 'object', properties, required: [] });

const AS_PRINTED = 'written the way results print times';
// Sizes are described without a figure: a small model takes a number it is shown for the number to send.
const WHOLE = 'a whole number without quotation marks';
const utc = () => bool('true: all times in UTC.');
const bundle = () => str("Id from availableBundles in excel_diag_summary (not 'name').");
// The arguments excel_diag_search, excel_diag_count and excel_diag_histogram share, described for search. count and
// histogram point to it, apart from what a model gets wrong without being told there too. Each tool gets its own copy.
const filters = (full) => ({
  query: str(full ? `All these words; also "a phrase", -word, /regex/, tag:memory, process:excel (not 'q').` : "Words, as in excel_diag_search (not 'q')."),
  from: str(`Start of the span, ${AS_PRINTED} (not 'start' or 'since').`),
  to: str(`End of the span, ${AS_PRINTED} (not 'end' or 'until').`),
  aroundId: int(full ? 'Centre on this entry id; window is the time either side.' : 'As in excel_diag_search.'),
  aroundTime: str(`Centre on this time, ${AS_PRINTED}.`),
  window: str(full ? 'Length either side of aroundId or aroundTime, e.g. "30s".' : 'As in excel_diag_search.'),
  minSeverity: str(full ? "Lowest kept: debug, info, notice, warning, error or fault (not 'severity')." : "As in excel_diag_search (not 'severity')."),
  matchCase: bool(full ? 'true: capitals in query must match.' : 'As in excel_diag_search.'),
  utc: utc(),
  bundle: bundle(),
});
const FILTER_SHAPE = 'query?, from?, to?, aroundId?, aroundTime?, window?, minSeverity?, matchCase?, utc?, bundle?';

export const TOOLS = [
  {
    name: 'excel_diag_summary',
    description: 'Describe a bundle: {utc?, bundle?}. Start with {}: entries, period, timeZone, counts, reports, what the collection recorded, and availableBundles, newest first by id date.',
    parameters: schema({ utc: utc(), bundle: bundle() }),
  },
  {
    name: 'excel_diag_search',
    description: `List entries that meet every condition: {${FILTER_SHAPE}, limit?, offset?, newest?, maxChars?}, e.g. {query: "pivot", minSeverity: "error"} (not 'q' or 'pattern'); ids are in the ID column; truncated:true means more matched.`,
    parameters: schema({
      ...filters(true),
      limit: int(`Entries to list: ${WHOLE} (not 'count').`),
      offset: int(`Matches to skip: ${WHOLE}; copy nextOffset.`),
      newest: bool('true: the last matches; not with offset.'),
      maxChars: int(`Characters per message line: ${WHOLE}.`),
    }),
  },
  {
    name: 'excel_diag_count',
    description: `Count entries that meet every condition: {${FILTER_SHAPE}, by?, limit?}, e.g. {by: "message"} (not 'groupBy'); without by, the top severities, sources, tags and processes.`,
    parameters: schema({
      ...filters(false),
      by: str("message (by its shape), severity, level, source, tag, process, subsystem, category or file (not 'groupBy')."),
      limit: int(`Values to list, with by: ${WHOLE}.`),
    }),
  },
  {
    name: 'excel_diag_histogram',
    description: `Count entries per time interval: {${FILTER_SHAPE}, bins?}, e.g. {minSeverity: "warning"} (not 'buckets'); fullest.from and fullest.to go into excel_diag_search.`,
    parameters: schema({
      ...filters(false),
      bins: int(`Most intervals: ${WHOLE} (not 'buckets').`),
    }),
  },
  {
    name: 'excel_diag_show',
    description: "Read one entry whole: {id, maxChars?, utc?, bundle?}, e.g. {id: 15501} from the ID column of excel_diag_search or excel_diag_context (not 'entry' or 'index'); truncated:true means send a larger maxChars.",
    parameters: schema({
      id: int("Entry id from the ID column; never guess (not 'entry')."),
      maxChars: int(`Characters of the message: ${WHOLE}.`),
      utc: utc(),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_context',
    description: `List what every source logged around an entry or moment: {id?, time?, before?, after?, window?, maxChars?, utc?, bundle?}, e.g. {id: 15501} from the ID column of excel_diag_search (not 'entry' or 'aroundId') or a time ${AS_PRINTED}; truncated:true means more was logged there.`,
    parameters: schema({
      id: int("Entry id to centre on; or send time (not 'entry')."),
      time: str(`Moment to centre on, ${AS_PRINTED} (not 'aroundTime').`),
      before: int(`Entries before the anchor: ${WHOLE}.`),
      after: int(`Entries after the anchor: ${WHOLE}.`),
      window: str('In place of before and after: entries within this long either side, e.g. "30s".'),
      maxChars: int(`Characters per message line: ${WHOLE}.`),
      utc: utc(),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_reports',
    description: 'List crash, hang and other report files: {path?, utc?, bundle?}. Call it with {}; ID goes into id of excel_diag_context, and FILE into path to lay that report out; truncated:true means more reports.',
    parameters: schema({ path: str("From the FILE column: that report laid out (not 'filename')."), utc: utc(), bundle: bundle() }),
  },
  {
    name: 'excel_diag_files',
    description: "List a bundle's files: {filter?, limit?, offset?, bundle?}, e.g. {filter: \"reports\"} (not 'query' or 'pattern'); copy PATH into path of excel_diag_read_file; truncated:true means send nextOffset as offset.",
    parameters: schema({
      filter: str("Keep paths that contain this (not 'pattern')."),
      limit: int(`Files to list: ${WHOLE}.`),
      offset: int(`Files to skip: ${WHOLE}; copy nextOffset.`),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_read_file',
    description: "Read lines of a bundle file: {path, fromLine?, limit?, grep?, bundle?}, e.g. {path: \"summary.md\"} from the PATH column of excel_diag_files or the FILE column of excel_diag_reports (not 'file' or 'filename'); truncated:true means send nextFromLine as fromLine.",
    parameters: schema({
      path: str("Path from the PATH or FILE column (not 'filename')."),
      fromLine: int(`First line: ${WHOLE}; copy nextFromLine (not 'offset').`),
      limit: int(`Lines to return: ${WHOLE}.`),
      grep: str("Keep lines that contain this (not 'pattern')."),
      bundle: bundle(),
    }),
  },
  {
    name: 'excel_diag_memory',
    description: "Memory figures: {time?, from?, to?, utc?, bundle?}. Call it with {}: files, the timeline's lowest, highest and last values, when each pressure level was seen; time lists samples.",
    parameters: schema({
      time: str(`Samples nearest this, ${AS_PRINTED} (not 'aroundTime').`),
      from: str(`Start of the span, ${AS_PRINTED} (not 'start' or 'since').`),
      to: str(`End of the span, ${AS_PRINTED} (not 'end' or 'until').`),
      utc: utc(),
      bundle: bundle(),
    }),
  },
];

// Every tool stays in the model's tool list with its schema (direct-only). A deferred tool is reached through the
// host's tool_call wrapper, where the arguments travel as a nested object and a search text full of quotation marks
// and backslashes has to survive one more layer of escaping: a small model gets that wrong, and it calls a deferred
// tool by its bare name all the same. The descriptions above are short enough that the ten, as registered, take
// less of the model's context than the six direct ones did when four were deferred.
export const DIRECT_TOOLS = new Set(TOOLS.map((t) => t.name));

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
  // Neither says why the call took that long: the program was stopped before it could say, so nothing here knows.
  timeout: 'The call took longer than this tool allows and was stopped, so it gave no result. A shorter time span (from and to) gives it fewer entries to look through: send it once more with one, or tell the human that this call could not be answered in the time this tool allows.',
  // For a tool that takes no time span: naming one would send the model after an argument the tool does not have.
  timeoutWhole: 'The call took longer than this tool allows and was stopped, so it gave no result: tell the human that this call could not be answered in the time this tool allows, and do not send the same call again.',
  missing: 'The program behind the excel_diag tools is not installed on the OpenClaw host: tell the human to run the Excel diagnostics installer again, and do not call these tools until the human says that is done.',
  start: 'The program behind the excel_diag tools could not be started on the OpenClaw host: tell the human, and do not call these tools again until the human says it is fixed.',
  cancelled: 'The call was cancelled before the program answered: send it again only if its result is still needed.',
  silent: 'The program stopped without giving a result: tell the human that this call could not be answered, and do not send the same call again.',
  plugin: 'The tool failed before the program could answer: tell the human that this call could not be answered, and do not send the same call again.',
};
const noAnswer = (cause) => ({ ok: false, error: NO_ANSWER, hint: NO_ANSWER_HINT[cause] });
// The tools whose work a shorter time span makes smaller: they look through the entries in it. The memory call takes
// a span too, but reads its whole file whatever span it is sent.
const SPANNED = new Set(['excel_diag_search', 'excel_diag_count', 'excel_diag_histogram']);

const block = (text) => ({ type: 'text', text });
// The details as the one JSON line the model reads. A value from a bundle (its id, a name, a path) can hold a
// character that JSON leaves as it is and that breaks a line, turns text round or takes no room: a C1 control,
// U+2028 or U+2029, a direction override or isolate, every character Unicode calls default-ignorable (a direction
// mark, a zero-width character, a variation selector, the byte order mark, a soft hyphen, a tag character, a Hangul
// filler and the like), and the interlinear annotation marks. Each is written as its escape (one past U+FFFF as the
// two escapes of its UTF-16 pair), so the line still parses to the same details and is read as one line, the right
// way round, with nothing unseen. The set is the program's own (hidden() in excel_diagnostics_cli.mjs), which
// measures the facts of a result written this way to keep them within their size: the two change together.
const escaped = (n) => (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029 || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069)
  || n === 0xad || n === 0x34f || n === 0x61c || n === 0x115f || n === 0x1160 || n === 0x17b4 || n === 0x17b5 || (n >= 0x180b && n <= 0x180f)
  || (n >= 0x200b && n <= 0x200f) || (n >= 0x2060 && n <= 0x206f) || n === 0x3164 || (n >= 0xfe00 && n <= 0xfe0f) || n === 0xfeff || n === 0xffa0
  || (n >= 0xfff0 && n <= 0xfffb) || (n >= 0x1bca0 && n <= 0x1bca3) || (n >= 0x1d173 && n <= 0x1d17a) || (n >= 0xe0000 && n <= 0xe0fff);
const escapeOf = (c) => c.split('').map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
function jsonLine(v) {
  let out = '';
  for (const c of JSON.stringify(v)) out += escaped(c.codePointAt(0)) ? escapeOf(c) : c;
  return out;
}
// Each fact is one line, whatever it says back. The program writes its notes so, but a name the model sent is said back
// bare, and it can hold a line break as much as a bundle can: left as it is, it would start a line of the facts with
// whatever followed it. So every kind of line break in a fact is written as \n, and a control character or one the
// JSON line escapes as its escape.
const BREAK = /\r\n?|[\n\v\f\u0085\u2028\u2029]/g;
function factLine(s) {
  let out = '';
  for (const c of s.replace(BREAK, '\\n')) { const n = c.codePointAt(0); out += (n < 32 && n !== 9) || escaped(n) ? escapeOf(c) : c; }
  return out;
}
// The names are said back bare, as the model wrote them, in one sentence it can act on: the first IGNORED_SAID of
// them, each cut to IGNORED_NAME_MOST characters, and how many more there were. In that sentence each is one line
// (factLine), cut again once that is done, so that what it adds to a result stays within LAID_ROUND.
// The cut is never through the middle of a character: a character past U+FFFF is two units, and one of them alone is
// no character, which a host that writes the result as UTF-8 cannot write.
const nameSaid = (k) => {
  if (k.length <= IGNORED_NAME_MOST) return k;
  const n = k.charCodeAt(IGNORED_NAME_MOST - 1) >= 0xd800 && k.charCodeAt(IGNORED_NAME_MOST - 1) <= 0xdbff ? IGNORED_NAME_MOST - 1 : IGNORED_NAME_MOST;
  return `${k.slice(0, n)}\u2026`;
};
function ignoredSaid(tool, given, more) {
  const names = given.map((k) => nameSaid(factLine(k)));
  if (names.length === 1) return `${names[0]} is not a field of ${tool} and was ignored, so this result is not narrowed by it. Send the call again with one of the allowed fields if it mattered.`;
  const all = more ? [...names, `${more} more`] : names;
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]} are not fields of ${tool} and were ignored, so this result is not narrowed by them. Send the call again with the allowed fields if they mattered.`;
}

// A failure is one JSON line and nothing else: the error, the argument at fault, and what to send instead.
function failure(tool, doc, more) {
  const details = { ok: false, tool };
  if (typeof doc.bundle === 'string' && doc.bundle) details.bundle = doc.bundle;
  details.error = doc.error;
  for (const key of ['field', 'hint']) if (typeof doc[key] === 'string' && doc[key]) details[key] = doc[key];
  if (Array.isArray(doc.candidates)) details.candidates = doc.candidates.filter((c) => typeof c === 'string');
  Object.assign(details, more);
  return { content: [block(jsonLine(details))], details, isError: true };
}

// What to send for a smaller result, said only with arguments the tool has: naming one it does not have would send
// the model after an argument that narrows nothing. A tool with none of them gets a sentence that names none.
const SMALLER = [['limit', 'a smaller limit'], ['maxChars', 'a smaller maxChars'], ['query', 'a narrower query'], ['filter', 'a filter that keeps fewer files'],
  ['grep', 'a grep that keeps fewer lines'], ['before', 'a smaller before and after'], ['window', 'a shorter window'], ['bins', 'fewer bins']];
function tooLargeSaid(tool, size, known) {
  const ways = SMALLER.filter(([name]) => known.has(name)).map(([, said]) => said).slice(0, 3);
  const led = `The result of ${tool} came to ${size} characters, more than is passed on in one result.`;
  if (!ways.length) return `${led} ${tool} has no argument that makes its result smaller: tell the human that this result is too large to pass on, and do not send the same call again.`;
  return `${led} Ask for less: ${ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]}`}.`;
}

// A success is up to four blocks in a fixed order. Corrections come first, so the model reads how its call was
// taken before it reads the result. "Next:" comes last, so what could be done next is the last thing it reads
// before its own turn. The quoted lines stay plain text between them: inside a JSON string every quotation mark
// and line break in a log message would be escaped, and a model copies what it sees. Those lines are the bundle's
// own text (each line of a file after its number, each line of a message after two spaces), and a file can hold a
// line that reads like a "Next:" of this tool's. So a result that has no Next ends with a fixed line of this
// tool's (endSaid), and the bundle's text is never the last thing the model reads.
const endSaid = (tool) => `End of the ${tool} result.`;
function success(tool, doc, more, ignored, known, unsaid) {
  const details = { ok: true, tool };
  if (typeof doc.bundle === 'string' && doc.bundle) details.bundle = doc.bundle;
  Object.assign(details, isObject(doc.receipt) ? doc.receipt : {}, more, { ok: true, tool });
  const notes = Array.isArray(doc.notes) ? doc.notes.filter((n) => typeof n === 'string' && n) : [];
  if (ignored.length) notes.unshift(ignoredSaid(tool, ignored, unsaid));
  const content = [];
  if (notes.length) content.push(block(`Facts about this call:\n${notes.map((n) => `- Fact: ${factLine(n)}`).join('\n')}`));
  content.push(block(jsonLine(details)));
  if (typeof doc.text === 'string' && doc.text) content.push(block(doc.text));
  content.push(block(typeof doc.next === 'string' && doc.next ? `Next: ${doc.next}` : endSaid(tool)));
  // One ceiling on everything handed to the model, whatever the program printed. The program cuts what a bundle
  // can make long; this is the second lock, for anything it did not.
  const size = content.reduce((n, c) => n + c.text.length, 0);
  if (size > RESULT_MOST) {
    return failure(tool, { bundle: doc.bundle, error: 'the result was too large to pass on', hint: tooLargeSaid(tool, size, known) });
  }
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
      // No tool is deferred, but a host may still hand a call over inside its wrapper, as tool_call {id, args}, and a
      // model may write one; the id can carry a prefix that ends in a colon. It is the same call as the bare one and
      // is counted with it. When the model put the arguments beside id instead of inside args, the whole wrapper
      // stands in for them.
      if (name === 'tool_call' && isObject(args) && typeof args.id === 'string') {
        const target = args.id.slice(args.id.lastIndexOf(':') + 1);
        if (TOOL_NAMES.has(target)) { name = target; args = isObject(args.args) ? args.args : args; }
      }
      if (!TOOL_NAMES.has(name)) { last.delete(session); return undefined; }
      const key = `${name} ${JSON.stringify(isObject(args) ? args : {}, sorted)}`, at = now(), before = last.get(session);
      // A host may announce one wrapped call twice, as the wrapper and then as the tool it names. Counted twice,
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

  // Never rejects and never returns a bare object. The host's tool_call wrapper, which a host may still use, checks
  // that a result has a content array before the model sees anything; a result without one is refused there, the
  // model is shown the wrapper's complaint in place of the result, and it sends the same correct call again.
  async function answer(tool, known, declared, given, signal) {
    try {
      // Only declared arguments are sent on as arguments, each exactly as it came; nothing is renamed or guessed. A name
      // the tool does not declare is sent apart from them (undeclared), for the program to refuse when it stands for an
      // argument of another name (q for query), and is never read as an argument: so every such name narrowed nothing,
      // and is reported so (ignoredFields), whatever tool it was sent to and whether the call ran or was refused.
      const params = {}, undeclared = {}, ignored = [];
      for (const key of Object.keys(isObject(given) ? given : {})) {
        if (known.has(key)) params[key] = given[key];
        else { undeclared[key] = given[key]; ignored.push(key); }
      }
      const said = ignored.slice(0, IGNORED_SAID).map(nameSaid), unsaid = ignored.length - said.length;
      const more = ignored.length ? { ignoredFields: said, allowedFields: [...declared] } : {};
      const request = { format: 1, op: tool.slice(PREFIX.length), bundlesDir, ...(cacheDir ? { cacheDir } : {}), params, ...(ignored.length ? { undeclared } : {}) };
      const outcome = await run(request, { cliPath, timeoutMs, signal });
      const doc = documentOf(outcome);
      if (doc && doc.ok === true) return success(tool, doc, more, said, known, unsaid);
      if (doc && doc.ok === false && typeof doc.error === 'string' && doc.error) return failure(tool, doc, more);
      const cause = outcome?.cause === 'timeout' || outcome?.cause === 'cancelled' ? outcome.cause
        : run === runProgram && !fs.existsSync(cliPath) ? 'missing' : outcome?.cause === 'start' ? 'start' : 'silent';
      log(`${tool} got no answer from the program (${cause}${cause === 'timeout' ? ` after ${timeoutMs / 1000} s` : ''}, exit status ${outcome?.code ?? 'none'}).`);
      return failure(tool, noAnswer(cause === 'timeout' && !SPANNED.has(tool) ? 'timeoutWhole' : cause), more);
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
