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
    cases/3*-skill-*        SKILL.md against the plugin's schemas and against real results
    cases/4*-installer-*    the installer, on temp folders with a stand-in `openclaw` command
    cases/50-seams          the parts against each other: names, the real files installed and called, offered calls
```

Outside this folder: `src/request.js` is request mode. `python3 build.py` puts it into `excel_diagnostics_cli.mjs`
with `src/core.js`, `src/cli.js` and `src/cli_main.js`. The plugin and the tests run that built file, so rebuild
after changing anything in `src/`.

## How a tool call travels

1. **The model calls a tool**, for example `excel_diag_search {query: "pivot", minSeverity: "error"}`. Six tools
   stay in its tool list with their schemas (`catalogMode: "direct-only"`): summary, search, show, context,
   reports and read_file. The host defers the other four (count, histogram, files, memory), and those arrive
   through the host's `tool_call {id, args}` wrapper.
2. **The host checks the call against the tool's schema.** The schemas are loose on purpose: nothing is required
   and nothing is ranged or enumerated, so a wrong call gets past the host and reaches the tool's own answer.
3. **The repeat guard looks at it** (`before_tool_call`, the plugin's only hook). A model that has a result and
   does not know what to do with it sends the same call again. The third identical call in a row (same tool,
   same arguments, within 30 minutes, no other tool call in between) is refused once, with a sentence that says
   to use the result it already has. The fourth and later ones run: refusing every repeat would hide the loop
   from the host's own loop detection. Only this plugin's ten tools are ever refused. Two events in a row with
   the same call id are one call: a host that announces a deferred call both as the wrapper and as the tool it
   names does not make the model's second call look like its third.
4. **The plugin builds a request**, `{ format: 1, op, bundlesDir, cacheDir, params }`. Arguments the tool
   declares go in exactly as the model sent them. A name the tool does not declare is left out and reported
   back. Nothing is renamed, repaired or checked here: no other name for an argument is accepted.
5. **The plugin starts the program**: the Gateway's own Node with `excel_diagnostics_cli.mjs request`, no shell,
   the request as JSON on standard input, an environment of `PATH`, `HOME` and `TMPDIR` only, a time limit, and at
   most 2 MiB of output. What the program writes to standard error is dropped.
6. **Request mode answers.** It picks the bundle (the newest in the bundles folder, or the one whose id was
   sent), opens it (a zip is unpacked once into the cache folder; a copy whose zip has since been replaced or
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
| `Facts about this call:` | One `- Fact:` line per note: a corrected argument, an ignored field, a list that was cut. | First, so the model reads how its call was taken before it reads the result. |
| One line of JSON | `ok`, `tool`, `bundle`, then the receipt: the search as it was read, counts, `truncated` and the field that continues (`nextOffset`, `nextFromLine`). | Small facts are safest as named fields. The same object is `details`. |
| The lines | Log entries, file lines or a table, as plain text. | Inside a JSON string every quotation mark and line break would be escaped, and a model copies what it sees. |
| `Next:` | At most three calls, written with real ids, times and paths from this result, then "If this answers the question, reply now." | Last, so it is what the model reads before its own turn; it ends on leave to stop because a result that ends on an instruction is obeyed. |

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
- **A refusal names the argument and says what to send instead.** Wrong types are refused, never repaired, and
  an undeclared name is reported as `ignoredFields` with `allowedFields`.
- **Fixed sentences where a loop is possible.** The host stops a loop when identical calls give identical
  results, so the repeat refusal and the "did not answer" hints never vary.

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
`catalogMode`, `isError` or a refused call, or whether `before_tool_call` fires once or twice for a deferred
tool. Check those on a running Gateway.

## Where the design is recorded

The reasons live beside the code they explain, so they are read when the code is changed:

- `plugin/index.js`: the comment above each part says which model slip it answers: the loose schemas and what a
  description must hold, the six direct tools, how the program is started, the fixed sentences, the order of the
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
