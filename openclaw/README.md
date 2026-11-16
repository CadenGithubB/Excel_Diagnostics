# Excel diagnostics for OpenClaw

This folder lets an OpenClaw agent look through an Excel diagnostics bundle. It holds a Gateway plugin with ten
read-only tools (`excel_diag_*`), the skill that tells the agent when and how to use them, an installer, and tests.

The plugin does no log work itself. For each tool call it starts `excel_diagnostics_cli.mjs`, the command-line
tool at the top of this repository (the same engine as the web viewer), in its request mode. The tools state
what the logs record. They never say what caused anything, and they never show the agent a path on the host.

To install, read [INSTALL.md](INSTALL.md); its first step is `bash openclaw/plugin/deploy.sh --check`, which reads
everything and changes nothing. What the agent reads is [SKILL.md](SKILL.md).

## Layout

```
openclaw/
  SKILL.md                  the skill: when to use the tools, how to call them, how to read a result
  INSTALL.md                what the installer changes, how to run it, how to undo it
  Install.command           double-click launcher for macOS; runs plugin/deploy.sh
  plugin/
    index.js                the plugin: the ten tools, starting the program, laying out results, the repeat guard
    openclaw.plugin.json    manifest: plugin id, configuration schema, the tool names
    package.json            names index.js as the entry; no dependencies
    install.mjs  deploy.sh  the installer and the script that finds Node for it
  tests/
    run.mjs  dsl.mjs        the runner and describe/it; no dependencies
    harness.mjs             loads the real plugin against a stand-in host; writes the sample bundle to a temp folder
    cases/00-*              the harness itself
    cases/1*-request-*      request mode: operations, limits, wrong arguments, which bundle, odd bundles, the cache
    cases/2*-plugin-*       the plugin: results, the program, registration, the repeat guard
    cases/25-* to 27-*, 29-*  request mode again: memory files by place, collection records, count by message,
                            reports laid out, the summary as the first look, each sentence true for odd bundles
    cases/3*-skill-*        SKILL.md against the plugin's schemas and against real results
    cases/4*-installer-*    the installer, on temp folders with a stand-in `openclaw` command
    cases/50-seams          the parts against each other: names, the real files installed and called, offered calls
```

Outside this folder: `src/request.js` is request mode. `python3 build.py` puts it into `excel_diagnostics_cli.mjs`
with `src/core.js`, `src/cli.js` and `src/cli_main.js`. The plugin and the tests run that built file, so rebuild
after changing anything in `src/`.

## How a tool call travels

1. **The model calls a tool**, for example `excel_diag_search {query: "pivot", minSeverity: "error"}`. All ten
   tools stay in its tool list with their schemas (`catalogMode: "direct-only"`), so none is reached through the
   host's `tool_call {id, args}` wrapper. Their descriptions are short: the ten, as registered, come to fewer
   characters than the six direct tools did when the other four were deferred.
2. **The host checks the call against the tool's schema.** The schemas are loose on purpose: nothing is required
   and nothing is ranged or enumerated, so a wrong call gets past the host and reaches the tool's own answer.
3. **The repeat guard looks at it** (`before_tool_call`, the plugin's only hook). A model that has a result and
   does not know what to do with it sends the same call again. The third identical call in a row (same tool,
   same arguments, within 30 minutes, no other tool call in between) is refused once, with a sentence that says
   to use the result it already has. The fourth and later ones run: refusing every repeat would hide the loop
   from the host's own loop detection. Only this plugin's ten tools are ever refused. A call that still arrives
   inside the host's wrapper is counted with the bare one, and two events in a row with the same call id are one
   call: a host that announces a wrapped call both as the wrapper and as the tool it names does not make the
   model's second call look like its third.
4. **The plugin builds a request**, `{ format: 1, op, bundlesDir, cacheDir, params, undeclared }`. Arguments the
   tool declares go in `params` exactly as the model sent them. A name the tool does not declare goes in
   `undeclared`, which the program never reads as an argument, and is reported back as ignored. Nothing is
   renamed, repaired or checked here: no other name for an argument is accepted.
5. **The plugin starts the program**: the Gateway's own Node with `excel_diagnostics_cli.mjs request`, no shell,
   the request as JSON on standard input, an environment of `PATH`, `HOME` and `TMPDIR` only, a time limit, and at
   most 2 MiB of output. What the program writes to standard error is dropped.
6. **Request mode answers.** A name in `params` or `undeclared` that the tool descriptions give as a wrong name
   for one of the tool's arguments (`q` for `query`, `severity` for `minSeverity`, `file` for `path`) is refused
   first, before the operation runs: `field` is the argument to send, and `hint` gives it the value that was sent
   where the argument takes it. One that holds a time, an entry id, a line number or a path is refused once the
   bundle is open, so that the value is given back only as that bundle has it. Then
   it picks the bundle (the newest in the bundles folder by the date and time in its id, then by when it was
   copied there; or the one whose id was sent), opens it (a zip is unpacked once into the cache folder; a copy whose zip has since been replaced or
   removed is deleted at the start of a request), checks every argument, runs the operation and
   prints one JSON document: `{ ok: true, bundle, notes, receipt, text, next }`, or
   `{ ok: false, bundle, error, field, hint, candidates }`. A refusal the model can correct is an ordinary
   answer with exit status 0.
7. **The plugin lays the answer out** as text blocks and returns `{ content, details }`. If no document came
   back (the program ran out of time, is missing, or died), the model gets `the Excel diagnostics program did
   not answer` and one fixed sentence for that cause.

Each call is a new process that indexes the bundle again: under half a second for the 6 MB sample bundle.

## How a result is laid out, and why

A success is up to four text blocks, always in this order:

| Block | Holds | Why it is there, and in that place |
| --- | --- | --- |
| `Facts about this call:` | One `- Fact:` line per note: a corrected argument, an ignored field, a list that was cut. A note that says back what was sent is still one line: a line break in it is written as `\n`. | First, so the model reads how its call was taken before it reads the result. |
| One line of JSON | `ok`, `tool`, `bundle`, then the receipt: the search as it was read, counts, `truncated` and the field that continues (`nextOffset`, `nextFromLine`). | Small facts are safest as named fields. The same object is `details`. |
| The lines | Log entries, file lines or a table, as plain text. A file's lines come each after its number, under a lead line; a message's each after two spaces, which the receipt's `printed` says. Inside a line, a character that would act, start another line, turn the line round or take no room is written by its number, or as `\n` where a name or a message in a listing holds a line break. | Inside a JSON string every quotation mark and line break would be escaped, and a model copies what it sees. A bundle can hold lines that read like the other three blocks, and none of its lines starts where one of theirs does. |
| `Next:` | At most three calls, written with real ids, times and paths from this result, then "If this answers the question, reply now." A result with none ends with `End of the <tool> result.` instead. | Last, so it is what the model reads before its own turn; it ends on leave to stop because a result that ends on an instruction is obeyed. The line that ends a result with no Next keeps the bundle's text from being the last thing read. |

A failure is one line of JSON with `isError`: `ok: false`, `tool`, `error`, and where they apply `bundle`,
`field` (the argument at fault), `hint` (what to send instead, and where that value comes from) and `candidates`.

The rules behind the wording, each of which answers a way a small model goes wrong:

- **No host paths.** A bundle is named by its id and a file by its path inside the bundle. A model that is shown
  a path it cannot open tries to open it.
- **Every count says what it counts.** `matched` comes with `total`; a filtered file list comes with the number
  of files in the bundle.
- **Nothing found is not a failure.** A search that matches nothing is `ok: true` with `matched: 0` and
  `withoutEach`, the count with each condition taken away in turn.
- **Limits are enforced, and announced only when they bite.** A number that is too large is lowered and a fact
  says so; anything cut sets `truncated` and gives the way on. No description or result offers a limit as a
  number to send, because a model that is shown one sends it.
- **One result is at most about 22,000 characters, about 5,500 tokens, and most are far less.** The program holds
  one answer to 10,000 characters of text, 7,000 of receipt (as JSON), 3,000 of notes (twelve at most) and 2,000 of
  `Next:`, whole calls only; a listing to 40 entries, values, files or lines, and a message line in a listing to 500
  characters (one message shown alone, to 8,000, and to fewer where what it prints would be more than one result's
  text, which a fact then says). The plugin's ceiling, `RESULT_MOST`, is worked out from those four figures and
  what it lays round them, so a result the program gave whole is never refused there. INSTALL.md says what that
  means for the model's context length.
- **A refusal names the argument and says what to send instead.** Wrong types are refused, never repaired, and
  an undeclared name is reported as `ignoredFields` with `allowedFields`. A wrong name the descriptions list for
  an argument of the tool (`q`, `text` or `pattern` for `query`, and so on) is refused before the operation runs, with
  `field` the argument to send and the value that was sent, because a call that ran without it would read as
  narrowed by it. The value is given to that argument only when the call would then mean what was sent; a page,
  an interval and a read_file offset mean something else, and the hint says what the argument is instead. Nor is
  a value given that the argument would refuse (a whole number under its least, a time it does not read on that
  bundle, a `to` not later than `from`, a word that is not a severity or a way to count, a bundle that is not
  there, an entry id past the bundle's last, a line past the end of the file read, a path that names no one file of
  the kind the call reads): the hint says what the argument takes. A time of day alone, on a bundle of more than one day, is given
  back with the bundle's last day before it, and the hint says so. A level
  name sent as `minSeverity` (`Default`, from the LEVEL column) is said as the severity its entries count as, and a
  nearest name is given only for a near spelling. The
  example a refusal gives is made from what was sent or taken from the bundle: a window sent as `60` is offered back
  as `"60s"`, a time with no date with the last day of the bundle before it. A window longer than the tool takes is
  not offered back.
- **Fixed sentences where a loop is possible.** The host stops a loop when identical calls give identical
  results, so the repeat refusal and the "did not answer" hints never vary.
- **Grouped, not paged.** A model shown hundreds of matches pages through them and gets nowhere. A search that
  matches far more than it lists, and a context window cut to its nearest entries, offer `excel_diag_count` with
  `by: "message"` first: the entries grouped by the shape of their message, each shape with `firstId`, the id of
  its first entry, and its first and last time. The shape folds digits, hex numbers and UUIDs into `#` by a fixed
  rule (`messageShape` in `src/core.js`) that reads no more than the first 120 characters of a message and cannot be
  made slow by one. One call groups at most 200,000 entries, 96 MB of them as read or 50,000 shapes, oldest first,
  and a fact says so when that cut it. The call that groups the rest is offered when the rest starts in a later
  second than the first match: a time is sent to the second, so a call from the first match's second would group the
  same entries again.
  Where a result offers count by message, it says the call groups all the entries only when no bound can cut it.
- **One call for the first look.** `excel_diag_summary` gives what one call can answer first: the period, the
  counts, up to five reports (newest first, the newest crash, hang or spin report of Excel at the top), the
  interval with the most errors and faults, the three shapes of message most of them have, each process ID of
  Excel with its first and last entry (the ten newest), the sources `source_catalog.tsv` records as missing or off,
  and `availableBundles`, each id with the mode and start time it records, in about 1,500 to 6,000 characters on
  the sample and the made-up bundles. The list of log sources is not in it: a fact says how many there are and offers
  `excel_diag_count {by: "file"}` with a limit that lists them all, or as many of those with the most entries as
  one result holds. Each report line is cut at 300 characters. Its first `Next:` lays out Excel's newest crash or
  hang report. Reports are counted as reports, not files: a force-quit record can hold several.
- **A count lists what one result holds.** `excel_diag_count` lists as many values as its receipt holds whole,
  `moreValues` counts every value it does not list, and a call it offers for more asks for as many as that call
  lists. A call it offers `read_file` of `manifest.tsv` or `collection_status.txt` says what one call reads of it,
  and none is offered for a file that is not text.
- **Coverage, to the entry.** A fact that the macOS log does not cover a time is said only of what no span of it
  covers: a span covers its first and last entry, and a day searched to its end is covered to the moment before the next.
  On a bundle whose clock has more than one offset, every time the tool writes into a call it offers, a fact or a
  hint carries its offset (`-05:00`), so that it is read back as the moment it was printed for. A time the call was
  sent is offered again as it was sent. A value in the receipt is written as results print times, beside `timeZone`.
- **Times as a clock can be.** A time with a part that cannot be (month 13, February 30, minute 99, second 60, an
  offset past -12:00 or +14:00) is refused, never rolled over into another day. The hint names what was sent and
  each part out of range, and gives an example made from it with those parts in range, which the tool takes. A time
  before 1000-01-02 or after 9999-12-30 (UTC) is refused too, with the nearest one the tool reads as the example.
  A window around a time that reaches past those is cut to them, and a fact says so, so that its ends read back.
  A time asked with milliseconds is said with them in the facts. Request mode and the text command line read times
  the same way.
- **A bounded search.** A query holds at most 100 terms and 10,000 characters. A term is a word, a phrase in
  quotation marks (one term, however many words), a `/regex/` or a field such as `process:excel`, with a minus or
  not. A `/regex/` is read by the tool's own reader, one entry at a time, which reads each character once in no
  more steps than the pattern has. A `/regex/` with a look-ahead, a look-behind or a back-reference, or one that comes
  to more than 2,000 steps as the reader counts them, is left out of the search, and a fact names it and says how the
  steps are counted: a counted repeat such as `x{2,30}` counts as 30 copies of `x`, and each `|` and each copy that
  may be left out counts more. A word or a `/regex/` is matched with each entry as it is shown, read as UTF-8 and
  without the line end at its end. The viewer and the text commands use the same reader. A query a result offers is
  one these limits take.
- **Memory at a moment.** `excel_diag_memory` with `time` lists the memory timeline's samples nearest it (three
  either side), and with `from` and `to` those in the span (every few, twelve at most), each with the columns this
  tool knows under its own names; every result gives, for each pressure level, the runs of samples at it. A
  histogram sent no span counts the main period and says how to count the whole, and a grep of a `.csv` or `.tsv`
  file lists its first line first.
- **A report laid out, as well as read.** `excel_diag_reports` with a `path` gives one report as the engine reads it
  for the viewer's Reports tab: labelled facts as `Label: value` lines, the first 40 frames of the stack the report
  singles out with each frame's image, and how many threads and images it lists (kept whatever other facts are left
  out; counted in the part read, and labelled so, for a text report longer than is read), in fewer than 4,000
  characters. A file that gives several reports is laid out as the newest of them, and a fact says how many. Every value is the report's text, on one line and cut short, after a label
  of this tool's, with each character that would act, turn the line round or take no room written by its number. A
  fact says it is a layout, and that `excel_diag_read_file` reads the file's own lines; for a file that is empty or
  not text it says so instead, and a file this account may not read is refused, as `excel_diag_read_file` refuses it.

## Configuration

Two settings, under `plugins.entries.excel-diagnostics.config`, read when the Gateway starts. A value that is
wrong falls back to the default, and one log line says so.

- `bundlesDir`: absolute path of the folder that holds the bundles (zips or unzipped folders). Without it the
  plugin reads `EXCEL_DIAGNOSTICS_BUNDLES` from the Gateway's environment, then uses
  `<state folder>/excel-diagnostics/bundles`.
- `timeoutSeconds`: the longest one call may take, 5 to 600, default 120.

## Tests

```bash
node openclaw/tests/run.mjs             # everything; under a minute
node openclaw/tests/run.mjs skill       # only case files whose name contains a word
deno run -A openclaw/tests/run.mjs      # the same suite on Deno
python3 build.py --check                # the built command-line tool matches src/
```

Node 20.6 or later, or Deno 2. There is nothing to install. The cases load the real `plugin/index.js` against a
stand-in for the host and run the real program on the viewer's built-in sample bundle (32,861 entries, one crash
report, one Jetsam report, memory files). Each case file opens with what it pins and why that matters to a small
model. One spec in `21-plugin-program` waits five seconds on purpose: the shortest time limit the plugin allows.

These are fixture tests. They do not start a Gateway or a model, so they cannot show how the host treats
`catalogMode`, `isError` or a refused call, or whether `before_tool_call` fires once or twice for a call the
host wraps. Check those on a running Gateway.

## Where the design is recorded

The reasons live beside the code they explain, so they are read when the code is changed:

- `plugin/index.js`: the comment above each part says which model slip it answers: the loose schemas and what a
  description must hold, why every tool is direct, how the program is started, the fixed sentences, the order of the
  blocks, the repeat guard.
- `src/request.js`: its opening comment gives the rules for every sentence the model reads; the comments at each
  refusal and each limit say why it is worded or bounded that way.
- `tests/cases/*.test.mjs`: the opening comment of each file.
- `SKILL.md` holds no reasons on purpose: every byte of it is read by the model before it does any work.

## Left out on purpose

- **Export to a file.** The tools only read. A file written on the host would have to be named by a host path,
  which the model is never shown and could not open. People have `export --out` on the text command line.
- **Session state.** A tool is handed one call and nothing about the conversation it belongs to, so every call
  stands alone: it names its bundle or takes the newest, and each `Next:` carries the bundle and the clock along.
- **Hooks other than the repeat guard.** A hook sees every tool call of every plugin, so each one is a way to
  break tools that are not ours. One guard answers one loop.
- **A release ZIP.** The installer runs from a copy of this repository and copies five files; there is nothing
  to package.
- **Continuous integration.** The suite runs locally with one command and nothing to install. No workflow runs
  it on a push yet, so run it before you push.
