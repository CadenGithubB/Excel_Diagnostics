# Install Excel Diagnostics for OpenClaw

This installs the `excel-diagnostics` Gateway plugin (ten read-only `excel_diag_*` tools), the command-line
tool the plugin runs, and the `excel-diagnostics` skill into an OpenClaw that is already set up.

Placeholders used on this page:

- `<repository>`: the folder this repository was copied to.
- `<state folder>`: the OpenClaw state folder. It is `--state-dir` if given, else `OPENCLAW_STATE_DIR`, else
  `.openclaw` in the home folder of the account that runs the installer.
- `<agent workspace>`: the workspace of the agent that gets the skill (`main` unless `--agent` names another).
  The installer reads it from the configuration: the agent's own `workspace`, else `agents.defaults.workspace`,
  else `<state folder>/workspace`.

## Before you start

- Run the installer **as the account that runs the OpenClaw Gateway**. Do not use `sudo` and do not switch to
  another account: everything it writes must belong to the Gateway account. The installer stops if the
  configuration file belongs to a different account.
- It needs Node.js (20.6 or later; the one OpenClaw uses is right) and the `openclaw` command. It has no
  dependencies and downloads nothing.
- The OpenClaw configuration must be strict JSON. A JSON5 file with comments is refused, because the comments
  would be lost when the file is written again.
- Copy the whole repository to the OpenClaw computer. The installer needs the `openclaw` folder and, beside
  that folder, `excel_diagnostics_cli.mjs`.

## Run it

Look first. This reads everything, checks it, lists what an install would write, and changes nothing:

```bash
cd <repository>
bash openclaw/plugin/deploy.sh --check
```

Then install, either by double-clicking **`openclaw/Install.command`** in Finder, or in Terminal:

```bash
bash openclaw/plugin/deploy.sh
```

`Install.command` runs the same `deploy.sh`, writes everything that was printed to
`openclaw/install-report.txt`, and keeps the window open. The report names folders on this computer, so do not
commit it. If macOS will not open `Install.command`, use the Terminal command.

Options, all optional:

| Option | Meaning |
| --- | --- |
| `--check` | Preflight only. No file, folder or service is changed. |
| `--skip-restart` | Install, but leave the Gateway running as it is. Restart it yourself. |
| `--agent ID` | Put the skill in this agent's workspace instead of `main`'s. Changes no agent setting. |
| `--skill-dir PATH` | Put `SKILL.md` in this folder instead of `<agent workspace>/skills/excel-diagnostics`. |
| `--state-dir PATH` | Use this OpenClaw state folder. |
| `--config PATH` | Use this configuration file instead of `<state folder>/openclaw.json` (or `OPENCLAW_CONFIG_PATH`). |
| `--help` | Print the options. |

Environment variables: `EXCEL_DIAGNOSTICS_NODE` (the Node executable `deploy.sh` should use),
`EXCEL_DIAGNOSTICS_OPENCLAW` (the `openclaw` executable), `EXCEL_DIAGNOSTICS_SKILL_DIR` (same as `--skill-dir`),
`OPENCLAW_GATEWAY_LABEL` (the LaunchAgent to restart; default `ai.openclaw.gateway`).

## What the installer changes

Files. Each is written beside its destination and renamed into place, so a reader never sees half a file.
A file that already has the right content is not written again.

| Written to | From |
| --- | --- |
| `<state folder>/extensions/excel-diagnostics/index.js` | `openclaw/plugin/index.js` |
| `<state folder>/extensions/excel-diagnostics/openclaw.plugin.json` | `openclaw/plugin/openclaw.plugin.json` |
| `<state folder>/extensions/excel-diagnostics/package.json` | `openclaw/plugin/package.json` |
| `<state folder>/extensions/excel-diagnostics/excel_diagnostics_cli.mjs` | `excel_diagnostics_cli.mjs` at the top of the repository (or beside `install.mjs`, if a copy is there) |
| `<agent workspace>/skills/excel-diagnostics/SKILL.md` | `openclaw/SKILL.md` |

Configuration (`<state folder>/openclaw.json`). Only these entries are added; every other key and value is kept.
The file is rewritten only when one of them is missing, as JSON with two-space indentation.

| Key | Change |
| --- | --- |
| `plugins.entries.excel-diagnostics.enabled` | Set to `true`. Anything else already in that entry (`config`, `hooks`) is kept. |
| `plugins.allow` | `"excel-diagnostics"` is added **only if this list already exists**. With no list, OpenClaw does not restrict which installed plugins load; creating one would restrict it to this plugin. |
| `tools.alsoAllow` | The ten tool names are added, each once, after what the list already holds. |
| `tools.sandbox.tools.alsoAllow` | The same ten names, the same way. |

The ten names: `excel_diag_summary`, `excel_diag_search`, `excel_diag_count`, `excel_diag_histogram`,
`excel_diag_show`, `excel_diag_context`, `excel_diag_reports`, `excel_diag_files`, `excel_diag_read_file`,
`excel_diag_memory`.

Folders. Created only if missing, open to the Gateway account only (mode 700):

- `<state folder>/excel-diagnostics/bundles`: where you put bundles.
- `<state folder>/excel-diagnostics/cache`: where the plugin unpacks zipped bundles. Each zip is unpacked once.
  When a zip is replaced or removed, the tools delete its unpacked copy the next time one of them is called.

Backups. Before a file is replaced, the installer copies it to a new private folder
`<state folder>/excel-diagnostics-install-backups/<time>-<random>/`. Its `manifest.json` lists each destination,
whether a file was there before (`previous`), and the name of the copy (`backup`). A run that replaces nothing
makes no backup folder. Old backup folders are never removed; delete them when you no longer want them.

Validation and rollback. After writing, the installer runs `openclaw config validate`. If OpenClaw refuses the
configuration, every file this run replaced is put back from the backup, every file it added is removed (a
folder made for it stays, empty), and the Gateway is not restarted. A file that someone else changed in the
meantime is left alone and named.

Restart. On macOS the installer then runs `launchctl kickstart -k gui/<user id>/ai.openclaw.gateway`, which
restarts the existing Gateway service. It does not edit the service. If the restart fails, or the computer is
not a Mac, the installer says so and the files stay installed.

## What the installer does not change

- Anything inside the bundles folder or the cache folder. An existing folder keeps its permissions and contents.
- `plugins.entries.excel-diagnostics.config`, the plugin's own settings (`bundlesDir`, `timeoutSeconds`). Set
  those by hand if you want them; see the next section.
- Any other configuration key, any other plugin or skill, and any other file in the folders it writes to.
- The Gateway's service definition and environment variables, and OpenClaw itself.
- Nothing is removed by the installer except its own new files during a rollback. There is no uninstall
  command; see "Undo by hand".

## Afterwards, by hand

1. **Restart the Gateway yourself** if the installer said it could not, or if you passed `--skip-restart`. The
   plugin loads when the Gateway starts.
2. **Put bundles in the bundles folder.** The installer prints the folder at the end; unless you changed it, it
   is `<state folder>/excel-diagnostics/bundles`. Copy each `Excel_Diagnostics_....zip` file, or the folder it
   unzips to, directly into it. Bundles hold user names and file paths, so keep that folder private.
3. **Open a fresh OpenClaw conversation.** OpenClaw loads skills when a conversation starts; a conversation that
   was already open does not get the new skill.
4. **Check the install** (next section).

A zipped bundle is unpacked the first time a tool reads it, inside the time one call may take (120 seconds
unless set). If the tools report that a bundle is too slow to search, copy the bundle in unzipped, or raise
`plugins.entries.excel-diagnostics.config.timeoutSeconds` (at most 600) and restart the Gateway.

To keep bundles somewhere else, set `plugins.entries.excel-diagnostics.config.bundlesDir` to an absolute path
and restart the Gateway. The plugin also reads the folder from `EXCEL_DIAGNOSTICS_BUNDLES` in the Gateway's own
environment when the configuration does not set one. The installer creates neither setting. When the
configuration sets `bundlesDir`, the installer names that folder at the end and does not create the default one.

## Check the install

```bash
openclaw plugins list
openclaw skills list
```

Each should list `excel-diagnostics`. Then, in a fresh conversation, ask the agent something that needs a
bundle, for example "Summarise the newest Excel diagnostics bundle." With no bundle in the folder yet, the
tools answer that no bundles are available.

Running the installer again is safe: it replaces only files whose content differs, adds no name twice, and
makes a backup only of what it replaces. It restarts the Gateway each time unless you pass `--skip-restart`.

## If the installer stops

It prints `INSTALL FAILED:` and the reason. A message that says "Nothing was changed" comes from the preflight,
before the first write. A failure after the first write says how many files were rolled back and names the backup
folder. Common reasons:

- A file of the installer is missing or fails its syntax check: copy the whole repository again.
- The configuration is not strict JSON, or holds a whole number too large to write back exactly (a long id
  written without quotes). The installer will not rewrite such a file. Add the four configuration entries above
  by hand, then run the installer again: it leaves a configuration that already has them untouched and installs
  the files.
- A folder on the way to a destination is a symbolic link, or the configuration file is one: give the real
  path with `--state-dir`, `--skill-dir` or `--config`.
- `openclaw config validate` refused the configuration. The installer rolls back and does not repeat OpenClaw's
  own message, which can quote values from the configuration. To read it, add the four entries to a copy of the
  configuration and run `OPENCLAW_CONFIG_PATH=<the copy> openclaw config validate`.
- The Gateway account cannot write a destination: correct that folder's permissions. Do not use `sudo`.

## Undo by hand

There is no uninstall command. To remove everything:

1. Delete the folder `<state folder>/extensions/excel-diagnostics`.
2. Delete the folder `<agent workspace>/skills/excel-diagnostics`.
3. In `<state folder>/openclaw.json`:
   - delete `plugins.entries.excel-diagnostics`;
   - remove `"excel-diagnostics"` from `plugins.allow`, if that list exists;
   - remove the ten `excel_diag_*` names from `tools.alsoAllow` and from `tools.sandbox.tools.alsoAllow`. If a
     list did not exist before the install, the configuration copy in the first backup folder shows what was
     there.
4. Run `openclaw config validate`, then restart the Gateway:
   `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`.
5. Optional: delete `<state folder>/excel-diagnostics/cache`, delete
   `<state folder>/excel-diagnostics-install-backups`, and delete `<state folder>/excel-diagnostics/bundles`
   only if you no longer want the bundles in it.

To go back one install instead, open the newest folder under
`<state folder>/excel-diagnostics-install-backups` and read its `manifest.json`. For each entry with
`"previous": true`, copy the file named by `backup` over `destination` (`cp -p` keeps its permissions). For each
entry with `"previous": false`, delete `destination`: that file did not exist before. Then validate and restart
as in step 4.
