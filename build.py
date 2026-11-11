#!/usr/bin/env python3
"""Assemble src/ into one self-contained index.html (the file GitHub Pages serves).

    python3 build.py           # index.html, with a Content-Security-Policy that blocks all network access
    python3 build.py --dev     # dev.html, same page without the policy, for automated tests that fetch fixtures
    python3 build.py --check   # write nothing; fail if index.html or the command-line tool is out of date

It also assembles excel_diagnostics_cli.mjs, the command-line tool: src/core.js (the engine the page uses) followed
by src/cli.js (the text commands), src/request.js (request mode, for programs) and src/cli_main.js (what runs).
The page carries a copy of that file and of excel_diagnostics.sh so people can download them there, so rebuild
after changing any of them.
"""
import pathlib
import sys

root = pathlib.Path(__file__).parent
src = root / "src"
dev = "--dev" in sys.argv

CSP = ("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' blob:; "
       "worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'\">")

core = (src / "core.js").read_text()
app = (src / "app.js").read_text()
for name, text in (("core.js", core), ("app.js", app)):
    if "</script" in text.lower():
        sys.exit(f"{name} contains '</script', which would end the inline script early")

# The collector goes into a text/plain script element byte for byte, so what the page hands out is the file itself.
collector = (root / "excel_diagnostics.sh").read_text()
if "</script" in collector.lower() or "<!--" in collector or "\r" in collector or not collector.isascii():
    sys.exit("excel_diagnostics.sh has '</script', '<!--', a carriage return or a non-ASCII character; "
             "an inline copy would not come back out identical")

# The command-line tool: one file that Node or Deno runs as it is, with the same engine as the page.
cli_head = ("#!/usr/bin/env node\n"
            "// excel_diagnostics_cli.mjs - search an excel_diagnostics.sh bundle from a terminal, without a browser.\n"
            "// Run:  node excel_diagnostics_cli.mjs help      (or: deno run -A excel_diagnostics_cli.mjs help)\n"
            "// Built by build.py from src/core.js, src/cli.js, src/request.js and src/cli_main.js; edit those, not this file.\n")
# Everything after the engine, in the order it has to run: the text commands and the helpers they share, request
# mode (which uses those helpers), then the few lines that read the arguments and start one or the other.
cli_tail = "".join((src / name).read_text() for name in ("cli.js", "request.js", "cli_main.js"))
# The page already holds the engine, so it carries only the two ends and puts the same file together from them:
# head, then core.js and the line break that follows it in the page, then that tail.
cli = cli_head + core + "\n" + cli_tail
if "</script" in cli.lower() or "<!--" in cli or "\r" in cli:
    sys.exit("the command-line tool has '</script', '<!--' or a carriage return; an inline copy would not come back out identical")
cli_out = root / "excel_diagnostics_cli.mjs"

html = (src / "index.html").read_text()
for marker, value in (("<!--CSP-->", "" if dev else CSP), ("/*CSS*/", (src / "style.css").read_text()),
                      ("/*CORE*/", core), ("/*APP*/", app), ("/*COLLECTOR*/", collector), ("/*CLIHEAD*/", cli_head), ("/*CLI*/", cli_tail)):
    if html.count(marker) != 1:
        sys.exit(f"expected exactly one {marker} in src/index.html")
    html = html.replace(marker, value)

out = root / ("dev.html" if dev else "index.html")
if "--check" in sys.argv:
    for path, want in ((out, html), (cli_out, cli)):
        if not path.exists() or path.read_text() != want:
            sys.exit(f"{path.name} is out of date; run python3 build.py")
        print(f"{path.name} is up to date")
    sys.exit(0)
out.write_text(html)
print(f"wrote {out.name} ({len(html) / 1024:.0f} KB)")
cli_out.write_text(cli)
cli_out.chmod(0o755)
print(f"wrote {cli_out.name} ({len(cli) / 1024:.0f} KB)")
