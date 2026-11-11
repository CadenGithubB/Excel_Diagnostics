# Excel diagnostics

Two pieces for chasing Microsoft Excel slowdowns, hangs and crashes on macOS:

- **`excel_diagnostics.sh`** collects the evidence on the affected Mac and zips it. Run `sudo bash excel_diagnostics.sh`; it asks what to do. `bash excel_diagnostics.sh --help` lists the modes and options.
- **`index.html`** is a viewer for those bundles. It is a single static page, served by GitHub Pages, that searches and filters a bundle inside the browser.

## Using the viewer

Open the page, then drop an `Excel_Diagnostics_….zip` on it. The unzipped folder or individual log files work too, and "Try it with sample data" loads a made-up bundle.

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

Sources disagree about clocks: Excel and OneDrive log in UTC, AutoUpdate in local time without saying so, the unified log in local time with an offset. The viewer converts everything to UTC and displays it in the Mac's own time zone, which it learns from the offsets in the unified log. A switch in the header changes the display to UTC or to your own zone.

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
- **Memory** appears when the bundle has `excel_memory_timeline.csv` (watch and repro modes). It charts Excel's footprint and system memory; click a chart to jump to that moment on the timeline.

### Large captures

Log text is never loaded into memory. The viewer keeps a compact index of each entry (time, byte range, level, process and so on, about 40 bytes) and reads the text from disk as you scroll or search. Measured in a Chromium browser on an M1 Pro MacBook Pro (16 GB) with a 1.5 GB unified-log file of 5.1 million entries: about 6 seconds to open, filters under half a second, and about 3 seconds for a text search across the whole file.

A zip cannot be searched in place, so its logs are unpacked first: small ones into memory, large ones into the browser's private storage for this page. That copy is deleted when you open another bundle or next open the page. The same 1.5 GB file took 16 seconds to open from a zip. How much fits depends on the storage the browser allows the site; the page tells you if a zip is too big for it. For a bundle over about 1 GB, unzip it and drop the folder instead: the browser then reads the logs where they are, with no copy.

A bundle from a collector older than the `permissions` and `storage` tags opens more slowly, because the viewer has to read every unified-log line for them: about twice as long for a file that size. Current bundles carry the tags in the `.tsv` files and say so in `manifest.tsv`.

macOS `ditto`, which the collector uses, does not write zip64. Past 4 GB it stores sizes and offsets that have wrapped around. The viewer detects and repairs that, and reads real zip64 archives too.

### What it does not read

- OneDrive's `.odl`, `.odlgz`, `.odlsent` and `.aodl` sync logs are in an obfuscated binary format. They are listed under Files only.
- Apple `.logarchive` bundles (from `--archive`) need Console or `log show`.

It needs a current browser: Chrome or Edge 103, Safari 16.4, Firefox 113, or later.

## Working on the viewer

The page is assembled from `src/` by a small script. There are no dependencies.

```bash
python3 build.py
```

Rebuild after changing `excel_diagnostics.sh` too: the page carries a copy of it for the download button. `python3 build.py --check` fails if `index.html` is out of date.

`src/core.js` does the indexing and searching in a Web Worker and can be run outside a browser. This loads a bundle with Deno and prints what was indexed, plus the results of a few searches:

```bash
deno run --allow-read test/core_test.js path/to/Excel_Diagnostics_….zip
```

With no path it uses the built-in sample data.
