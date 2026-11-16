# Excel diagnostics

Tools for looking into Microsoft Excel slowdowns, hangs and crashes on macOS.

- **`excel_diagnostics.sh`** collects logs and reports on the affected Mac into a zipped bundle.
- **[The viewer](https://cadengithubb.github.io/Excel_Diagnostics/)** (`index.html`) reads a bundle in your browser. Nothing is uploaded.
- **`excel_diagnostics_cli.mjs`** searches a bundle from a terminal, with the viewer's engine.
- **`openclaw/`** lets an OpenClaw agent search a bundle.

The tools show what was recorded. They do not say what caused a problem.

## Quick start

1. Get the collector from [The viewer](https://cadengithubb.github.io/Excel_Diagnostics/) (File > "Download the script"), a [release](https://github.com/CadenGithubB/Excel_Diagnostics/releases), or:

   ```bash
   curl -O https://cadengithubb.github.io/Excel_Diagnostics/excel_diagnostics.sh
   ```

2. Run it in Terminal. With no options, it asks what to do.

   ```bash
   sudo bash excel_diagnostics.sh
   ```

3. Find the results on the Desktop: a folder `Excel_Diagnostics_<mode>_<date>_<time>`, its `.zip`, and a `.zip.sha256` checksum. To check the zip, run this in its folder:

   ```bash
   shasum -a 256 -c Excel_Diagnostics_collect_20261114_091500.zip.sha256
   ```

4. Drop the zip on the [viewer](https://cadengithubb.github.io/Excel_Diagnostics/).

## Modes

Name the mode on the command line, for example `sudo bash excel_diagnostics.sh hang`.

| Mode | What it does | Use it |
| --- | --- | --- |
| `collect` (default) | Copies Excel's logs, diagnostic reports, recent days of the unified log, system and memory state, add-ins and preferences. | After a crash or slowdown. |
| `hang` | Takes a spindump, footprint and open-file list of Excel, says when Excel can be force-quit, then copies Excel's logs and the last 30 minutes of the unified log. | While Excel is frozen. |
| `repro` | Starts a live log stream and a memory timeline. Press Ctrl-C 30 seconds after the problem happens; it then gathers what `collect` does. | When you can make the problem happen. |
| `watch` | Writes Excel's memory and CPU, and the system's memory pressure, to a CSV until Ctrl-C or `--hours`. | To follow memory over hours. |

`hang` copies no diagnostic reports, Office logs or system state. `repro`'s live stream is unfiltered: every process's entries, debug level included, up to 10 GB.

## Options

| Option | What it does |
| --- | --- |
| `--days N` | Days of unified log to search (`collect`; default 3). |
| `--since`, `--until` | First and last incident date, as YYYY-MM-DD. |
| `--max-wait M` | Most minutes per log search (default 3; 0 = no limit). |
| `--note TEXT` | What happened, kept as one line in `case/incident_context.md`. |
| `--workbook PATH` | Records the workbook's size and dates. Never copies it. |
| `--redact` | Hides the user's and this Mac's names and IDs, and email addresses. See below. |
| `--archive` | Adds an unfiltered `.logarchive` (`collect`). Can be very large. |
| `--outdir DIR` | Where the results go (default: the console user's Desktop). |
| `--no-sudo` | Does not re-run itself with sudo, so collects only what this account can read. `manifest.tsv` says what was skipped. |
| `--no-prompt` | Asks no questions. |

`bash excel_diagnostics.sh --help` also explains `--interval` and `--hours`.

**Jamf Pro.** Run it as a policy script. Nobody can press Ctrl-C there, so `watch` stops only when parameter 5 gives hours, and `repro` runs until something stops it.

| Parameter | Value |
| --- | --- |
| 4 | Mode |
| 5 | Days (`collect`) or hours (`watch`) |
| 6 | Max wait, in minutes |
| 7 | `redact` to hide names |

## What a bundle holds

Every bundle has:

- `manifest.tsv`: the status table, one row per step, saying what was incomplete and why.
- `collection.log`: what the script did, step by step.
- `summary.md`: the status table, and what the main files hold.
- `bundle_info.tsv`: collector version, mode, start and end times, macOS version, Mac model and Excel version.
- `case/` (when a note or workbook is given): the note, the workbook path and its facts.

By mode:

- `collect` and `repro`: `reports/`, `office/` (Microsoft logs and settings), `system/` and `source_catalog.tsv` (where each source was looked for).
- `collect`: `unified_logs/`, one file per day, and how each day's search ended.
- `repro`: `repro/`, with the first and last snapshots and the live log stream.
- `hang`: `excel_spindump.txt` (or `excel_sample.txt` without root), `excel_footprint.txt`, `excel_open_files.txt`, Excel's logs and `unified_last30m.tsv`.
- `watch` and `repro`: `excel_memory_timeline.csv`.

`reports/` holds every diagnostic report changed since the first incident day, from any app. From the last 30 days it also takes reports named for Excel, Office, Microsoft, jetsam or WindowServer, hang, spin and panic reports, and any report whose text names Microsoft Excel.

**Times.** Excel's own logs are in UTC. The unified-log `.tsv` files have `local_time` and `utc_time` columns. Without `jq` (built into macOS 15 and later) they are `.ndjson` files instead; `log_format` in `bundle_info.tsv` says which.

## Hiding names (`--redact`)

`--redact` rewrites every plain-text file in the bundle:

- **Replaced:** the user's account name, full name and home folder name, this Mac's names, serial number and hardware IDs, and email addresses. File and folder names holding one of these are renamed.
- **Left out:** files that are not plain text, such as OneDrive's own logs. Collect again without `--redact` to get them.
- **Not hidden:** the rest of document and folder names, other people's names, the names of other computers, servers and printers, network addresses, nicknames and initials, and any `.logarchive`.
- **Kept on purpose:** a generic account name such as `admin`, and a Mac named after its model; the last line says so even when the status is 0. A three-to-five-letter account name (such as `max`) is replaced wherever it stands as a word.
- **Report:** `redaction.txt` says whether the result is complete, what was replaced and what was left out. With `--archive`, the result is never complete (status 3): a `.logarchive` cannot be rewritten.

## Running as root

The user controls their home folder, so the collector trusts nothing there.

- It reads the home folder with the user's rights, under time limits (30 minutes in all). After one read times out, nothing more is read with those rights, except the workbook's own facts.
- Outside the home folder, it takes a file only as itself: not through a link, a linked folder or a second name.
- It builds the bundle in a root-only folder under `/private/var/tmp`. At the end it moves the results with the user's rights, unless only root can write to the destination. If a result name is already taken there, nothing is moved.
- It caps what the user can make large. A copied log file over 1 GB is left out (over 250 MB for other Microsoft logs it finds), and so are a log folder's largest files past 4 GB. Each unified-log search is cut at 2 GB. The rows written from what was kept can come to up to three times its size. `repro`'s live stream is cut at 10 GB.
- A process counts as Excel only by its owner (the console user) and its program file, never by its name.

## Exit statuses

| Status | Meaning |
| --- | --- |
| 0 | The zip was made and is where it was asked for. |
| 1 | No zip could be made. |
| 2 | An option, its value or a Jamf parameter was not accepted. Nothing was collected. |
| 3 | The zip was made, but `--redact` failed or is not complete. |
| 4 | Some or all results stayed in the working folder. The last lines say which. |
| 130 | Stopped by Ctrl-C, Ctrl-\, TERM or a hangup (the Terminal window closing) once collecting had begun. What was collected is still packaged. |

When more than one applies, the first in this order wins: 1, 3, 4, 130. A run cut off by a restart leaves what it collected in the working folder it named at the start.

## The viewer

Drop a bundle's zip, its folder, or single log files on the [viewer](https://cadengithubb.github.io/Excel_Diagnostics/). "Try it with sample data" loads a made-up bundle.

- **Nothing is uploaded.** The page's Content-Security-Policy refuses network requests. You can save `index.html` and open it offline.
- **Tabs:** Timeline (every log with timestamps, merged by time, with search and filters), Files and Overview. Reports and Memory appear when the bundle has reports or memory records.
- **Times** are shown in the time zone of the Mac the bundle came from. The "Times in" menu switches to UTC or your own zone.
- **Search** takes words, "a phrase", a `/regex/` and fields such as `process:excel`, and lists the entries that match all of them. A `/regex/` is read by the tool's own reader, one entry at a time. It reads each character once, in no more steps than the pattern has, so the time a search takes grows with how much it reads, whatever the pattern. A `/regex/` with a look-ahead, a look-behind or a back-reference (`\1`) is left out of the search, and a note says so. So is one that comes to more than 2,000 steps as the reader counts them. A character, a class such as `[a-z]` or `\d`, and an anchor such as `^` or `\b` are one step each. A counted repeat such as `x{2,30}` counts as 30 copies of `x`, with one step more for each copy past the first 2. `x?` counts as `x` and one step more, `x*` as `x` and two more, and `x+` as two copies of `x` and two more. Each `|` adds two steps. A repeated part that can only match nothing, such as `(?:)` or `(?:\b)`, counts once at most, whatever its count, since it matches the same each time. Each entry is matched as it is shown: read as UTF-8, without the line end at its end. So `.` and `[é]` each match the one character `é`, capitals are ignored as JavaScript ignores them, and `/^$/` matches only an entry with an empty line.
- **Hatching** on the Timeline chart marks time the bundle has no macOS log for, such as a day whose search was cut short. It is not a quiet stretch.
- **Export** writes one row per entry, with times in UTC. A field that starts with `=`, `+`, `-`, `@` or `"` gets an apostrophe in front, so a spreadsheet does not run it.
- **Large bundles:** over about 1 GB, unzip first and drop the folder.

## The command-line tool

`excel_diagnostics_cli.mjs` is one file with no dependencies. It needs Node 20 or later, or Deno 2 (`deno run -A`). Get it from the viewer ("Download the tool" on the start page, or File > Get the command-line tool), a release, or:

```bash
curl -O https://cadengithubb.github.io/Excel_Diagnostics/excel_diagnostics_cli.mjs
```

Give it a bundle (zip, folder or log file). With no command, it prints a summary:

```bash
node excel_diagnostics_cli.mjs ~/Desktop/Excel_Diagnostics_collect_20261114_091500.zip
```

```bash
node excel_diagnostics_cli.mjs ~/Desktop/Excel_Diagnostics_collect_20261114_091500.zip search --min-severity error
```

```bash
node excel_diagnostics_cli.mjs help examples
```

- `sample` in place of a bundle opens made-up data.
- Most commands end with a "Next:" list of commands to run next, ready to copy.
- `search` reads its words as the viewer does, with the same reader for a `/regex/`, and leaves out the same patterns, with a note. A time with a part that cannot be, such as month 13 or minute 99, is refused with an example.
- `request` mode, which the OpenClaw tools use, takes a query of at most 100 terms and 10,000 characters. A phrase in quotation marks is one term.
- A zip is unpacked once into `excel_diagnostics_cli` in the system's temporary folder and kept for later commands. `node excel_diagnostics_cli.mjs clean` deletes those copies.

## OpenClaw

`openclaw/` holds a plugin with ten read-only `excel_diag_*` tools and a skill, over the command-line tool. The agent reads bundles from one folder on the OpenClaw host; a call that names no bundle reads the newest, by the date and time in its id, then by when it was copied there. It has not yet run in a live OpenClaw Gateway. See [`openclaw/INSTALL.md`](openclaw/INSTALL.md).

## Developing

Edit `src/` and `excel_diagnostics.sh`, never `index.html` or `excel_diagnostics_cli.mjs`. Then rebuild: `python3 build.py` builds both from `src/` and copies the collector into the page. `python3 build.py --check` fails if a built file is out of date.

| Suite | Command |
| --- | --- |
| Engine | `deno run --allow-read test/engine_test.mjs` |
| Viewer | `deno run --allow-read test/viewer_md_test.mjs` |
| Name hiding (Mac) | `bash test/redact_test.sh` |
| Collector (Mac) | `bash test/collect_test.sh` |
| Note and questions (Mac) | `bash test/note_test.sh` |
| OpenClaw plugin | `node openclaw/tests/run.mjs` |

The engine and viewer suites also run with `node`.

## Known limits

- The parts that look at Excel itself (its logs, finding it running, `hang`'s capture) are tested with stand-ins only.
- The tests never run as root.
- Only Excel in `/Applications` is looked for.
- Bundles from collectors before 1.5.0 can hold a "Case" line and sentences about a PivotTable crash that the collector wrote itself. Wherever the viewer, the command-line tool and the agent tools show that file, they say so. They call the text under a heading the collector's only when it is word for word what that collector wrote there, up to the next heading. A file that opens as the 1.5.0 collector writes it and also has those older lines is said to have both.
- A note given with `--note` to a run that uses sudo, or typed before the script re-runs itself with sudo, is on a `sudo` command line. macOS logs that line, and a bundle can include it.
- OneDrive's binary `.odl` logs and `.logarchive` bundles are not read by the viewer or the tool.
