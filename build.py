#!/usr/bin/env python3
"""Assemble src/ into one self-contained index.html (the file GitHub Pages serves).

    python3 build.py           # index.html, with a Content-Security-Policy that blocks all network access
    python3 build.py --dev     # dev.html, same page without the policy, for automated tests that fetch fixtures
    python3 build.py --check   # write nothing; fail if index.html is out of date

The page carries a copy of excel_diagnostics.sh so people can download it there, so rebuild after changing the script.
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

html = (src / "index.html").read_text()
for marker, value in (("<!--CSP-->", "" if dev else CSP), ("/*CSS*/", (src / "style.css").read_text()),
                      ("/*CORE*/", core), ("/*APP*/", app), ("/*COLLECTOR*/", collector)):
    if html.count(marker) != 1:
        sys.exit(f"expected exactly one {marker} in src/index.html")
    html = html.replace(marker, value)

out = root / ("dev.html" if dev else "index.html")
if "--check" in sys.argv:
    if not out.exists() or out.read_text() != html:
        sys.exit(f"{out.name} is out of date; run python3 build.py")
    print(f"{out.name} is up to date")
    sys.exit(0)
out.write_text(html)
print(f"wrote {out.name} ({len(html) / 1024:.0f} KB)")
