# Excel diagnostics

Four pieces for chasing Microsoft Excel slowdowns, hangs and crashes on macOS:

- **`excel_diagnostics.sh`** collects the evidence on the affected Mac and zips it. Run `sudo bash excel_diagnostics.sh`; it asks what to do. `bash excel_diagnostics.sh --help` lists the modes and options.
- **`index.html`** is a viewer for those bundles. It is a single static page, served by GitHub Pages, that searches and filters a bundle inside the browser.
- **`excel_diagnostics_cli.mjs`** searches a bundle from a terminal with the same engine as the page, for working without a browser or for handing the job to an agent.
- **`openclaw/`** is a plugin and skill for an OpenClaw agent: ten read-only `excel_diag_*` tools over the same engine, with a short skill that tells the agent when and how to use them.

## Using the viewer

Open the page, then drop an `Excel_Diagnostics_….zip` on it. The unzipped folder or individual log files work too, and "Try it with sample data" loads a made-up bundle.

Prefer a terminal? File → Get the command-line tool (or "Download the tool" on the start page) hands out `excel_diagnostics_cli.mjs`, described below.

No bundle yet? The page hands out the collector as well: "Download the script" on the start page, or File → Get the collector script once a bundle is open. "View it" shows the script and how to run it. The copy is built into the page, so it works offline and matches this repository as of the last build.

**Nothing is uploaded.** The page has no server side. Its Content-Security-Policy sets `connect-src 'none'`, so the browser itself refuses any network request the page might make. You can save `index.html` and open it from disk with no connection.

### Timeline

Every timestamped source is merged into one list, sorted by time:

| Source | Files |
| --- | --- |
| macOS unified log | `unified_logs/*.tsv`, `unified_last30m.tsv`, `repro/unified_live_unfiltered.tsv` (and the `.ndjson` variants written when `jq` is missing) |
| Excel's own diagnostics | `…/excel_container_logs/Diagnostics/EXCEL/*.log` (and other Office apps' logs in the same format) |
| Microsoft AutoUpdate | `office/autoupdate.log` |
| OneDrive | the text `OneDrive-*.log` files |
| Install history, sleep and wake | `system/install_history_microsoft.txt`, `system/sleep_wake.txt` |
| Crash and hang reports | one entry per `.ips`, `.crash`, `.diag`, `.hang`, `.spin` or `.panic` file, and each recorded force-quit |
| Anything else | any `.log` or `.txt` whose lines start with a timestamp |

Sources disagree about clocks: Excel and OneDrive log in UTC, AutoUpdate in local time without saying so, the unified log in local time with an offset. The viewer converts everything to UTC and displays it in the time zone of the Mac the bundle was collected on (the "logged Mac"), which it learns from the offsets in the unified log. A switch in the header changes the display to UTC or to your own zone, and shows the offset each choice means. If the logs record no zone, that first choice is unavailable and times start in your own zone.

They disagree about names too: Excel's own log calls the process `EXCEL`, macOS calls it `Microsoft Excel`. The viewer shows both as `Microsoft Excel`, so one process filter covers both logs; the Source column still says which log an entry came from.

What you can do:

- **Search** with words, `"exact phrases"`, `/regular expressions/`, and `-exclusions`. `process:`, `level:`, `pid:`, `subsystem:`, `category:`, `tag:` and `source:` match one field.
- **Filter** by severity, source, tag, process, subsystem, category and file from the list on the left. The count beside each value is what you would get by choosing it. Under each severity are the levels the logs themselves use (macOS: Default, Info, Debug, Error, Fault; Excel: Medium, Monitorable, Unexpected), so you can pick a whole severity or one level.
- **Tags** say why an entry is worth a look. `excel`, `excel-helper`, `mentions-excel`, `microsoft`, `hang-report`, `memory`, `restart` and `logs-dropped` describe who logged it. `permissions` and `storage` describe what it says: sandbox and privacy (TCC) refusals, "not permitted", "denied" and missing entitlements; a full disk, an exceeded quota, I/O errors and a read-only volume. Those two are applied to every log in the bundle, Excel's own included, and look for refusals and failures, not the bare words.
- **Zoom in time** by dragging across the histogram (right-click it to zoom back out), typing a start and end, or using the ± buttons on a selected entry.
- **Step through errors** with `e` and `Shift+E`, **pin** entries with `p`, and press `c` to drop the filters while staying on the selected entry, so you can see what surrounded it.
- **Export** the entries shown, or just the pinned ones, as a tab-separated file.
- **Save a view** from the File menu: the search, filters, time window and pins go into a small `.view.json` file that holds no log text. Load it later, or hand it to a colleague who has the same bundle, to land on the same entries.

The File menu also opens another zip, folder or the sample data, saves a copy of whichever bundle file is open under Files (handy for pulling one crash report out of a zip), and closes the bundle.

### Other tabs

- **Files** lists everything in the bundle and opens text, Markdown and TSV files, with a hex preview for binary ones.
- **Overview** shows the collector's summary, the collection status and what each source covers.
- **Memory** lays out what the bundle recorded about memory, as recorded and without interpretation:
  - the collector's memory snapshots, with the processes using the most memory
  - Excel's footprint by kind, from `footprint`
  - JetsamEvent reports, which macOS writes when it ends processes to free memory
  - when the kernel's memory messages were logged
  - for watch and repro bundles, charts of Excel's footprint, CPU and threads and of system memory from `excel_memory_timeline.csv`, with Excel starts and stops and crash, hang and jetsam reports marked and periods of memory pressure shaded

  Drag across a chart to open that span on the timeline, or click to jump to a moment.

### Large captures

Log text is never loaded into memory. The viewer keeps a compact index of each entry (time, byte range, level, process and so on, about 40 bytes) and reads the text from disk as you scroll or search. Measured in a Chromium browser on an M1 Pro MacBook Pro (16 GB) with a 1.5 GB unified-log file of 5.1 million entries: about 6 seconds to open, filters under half a second, and about 3 seconds for a text search across the whole file.

A zip cannot be searched in place, so its logs are unpacked first: small ones into memory, large ones into the browser's private storage for this page. That copy is deleted when you open another bundle or next open the page. The same 1.5 GB file took 16 seconds to open from a zip. How much fits depends on the storage the browser allows the site; the page tells you if a zip is too big for it. For a bundle over about 1 GB, unzip it and drop the folder instead: the browser then reads the logs where they are, with no copy.

A bundle from a collector older than the `permissions` and `storage` tags opens more slowly, because the viewer has to read every unified-log line for them: about twice as long for a file that size. Current bundles carry the tags in the `.tsv` files and say so in `manifest.tsv`.

macOS `ditto`, which the collector uses, does not write zip64. Past 4 GB it stores sizes and offsets that have wrapped around. The viewer detects and repairs that, and reads real zip64 archives too.

### What it does not read

- OneDrive's `.odl`, `.odlgz`, `.odlsent` and `.aodl` sync logs are in an obfuscated binary format. They are listed under Files only.
- Apple `.logarchive` bundles (from `--archive`) need Console or `log show`.

It needs a current browser: Chrome or Edge 103, Safari 16.4, Firefox 113, or later.

## Using the command-line tool

`excel_diagnostics_cli.mjs` is one file with no dependencies. It needs Node 20 or later, or Deno 2 (`deno run -A` in place of `node`). Get it from this repository, from File → Get the command-line tool in the viewer, or with:

```bash
curl -O https://cadengithubb.github.io/Excel_Diagnostics/excel_diagnostics_cli.mjs
```

Give it a bundle (the zip, the unzipped folder or a single log file) and a command:

```bash
node excel_diagnostics_cli.mjs ~/Desktop/Excel_Diagnostics_collect_20260310_091500.zip
```

With no command it prints what the bundle holds and where to start. The word `sample` in place of a bundle opens made-up data.

| Command | What it prints |
| --- | --- |
| `summary` | What the bundle holds: entries, period, counts by severity, tag and process, each log source, the reports |
| `search WORDS` | The entries that match, oldest first, each with an ID |
| `count`, `histogram` | How many entries match per severity, source, tag or process, and when they were logged |
| `show ID`, `context ID` | One entry in full, and everything every source logged around it |
| `reports`, `memory` | The crash, hang and jetsam report files, and the memory files and figures |
| `files`, `cat PATH` | The files in the bundle, and the text of one |
| `export --out FILE` | Every matching entry as a tab-separated file |
| `help`, `help search`, `help time`, `help examples` | The commands, the search syntax, how times are read, and step-by-step commands for common jobs |

`WORDS` is the viewer's search syntax: words, `"phrases"`, `/regular expressions/`, `-exclusions` and fields such as `process:excel` or `tag:memory`. `--from`, `--to`, `--around` and `--min-severity` narrow it further.

It is written to be usable by an agent with no other instructions:

- Every command repeats the search as it understood it, says how many entries matched, and ends with a "Next:" list of commands that follow on, ready to copy.
- When nothing matches, it counts again with each condition taken away in turn, so it is clear which one is responsible.
- A mistyped command, option, field or time gets an answer that names the mistake and shows the right form.
- It reports what the logs hold and draws no conclusions.

A zip is unpacked once into the system's temporary folder so that later commands start quickly; `clean` deletes those folders. A folder is read where it is. Nothing is uploaded, and the only file it writes is the one named with `export --out`.

For programs there is `excel_diagnostics_cli.mjs request`: one JSON request on standard input, one JSON document on standard output. The OpenClaw plugin in [`openclaw/`](openclaw/README.md) drives the tool that way.

Each command is a new process that indexes the bundle again: about a second for a 240 MB bundle of 430,000 entries on an M1 Pro MacBook Pro. Tested with Node 24 and Deno 2.7.

## Using it from an OpenClaw agent

[`openclaw/`](openclaw/README.md) holds a plugin that gives an OpenClaw agent ten tools (`excel_diag_summary`, `excel_diag_search`, `excel_diag_show`, `excel_diag_context` and six more) and a skill, [`openclaw/SKILL.md`](openclaw/SKILL.md), that the agent reads before using them. The plugin does no log work itself: for each call it starts `excel_diagnostics_cli.mjs request` and lays the answer out for a small local model, with what was understood first, the log lines as plain text, and the calls that could follow last.

Bundles are copied into one folder on the machine that runs OpenClaw, and the agent names them by id; it never sees a path on that machine. The tools report what the logs record and draw no conclusions.

[`openclaw/INSTALL.md`](openclaw/INSTALL.md) covers installing it. `bash openclaw/plugin/deploy.sh --check` is the first step and changes nothing. The tests need no OpenClaw:

```bash
node openclaw/tests/run.mjs
```

They load the real plugin against a stand-in host and run the real command-line tool. They pass on Node 24 and Deno 2.7. Nothing in this folder has been run inside a live OpenClaw Gateway yet.

## Working on the viewer

The page is assembled from `src/` by a small script. There are no dependencies.

```bash
python3 build.py
```

The same command writes `excel_diagnostics_cli.mjs`, which is `src/core.js` followed by `src/cli.js`, `src/request.js` and `src/cli_main.js`. Rebuild after changing `excel_diagnostics.sh` too: the page carries a copy of it, and of the command-line tool, for the download buttons. `python3 build.py --check` fails if `index.html` or `excel_diagnostics_cli.mjs` is out of date.

`src/core.js` does the indexing and searching in a Web Worker and can be run outside a browser. This loads a bundle with Deno and prints what was indexed, plus the results of a few searches:

```bash
deno run --allow-read test/core_test.js path/to/Excel_Diagnostics_….zip
```

With no path it uses the built-in sample data.
