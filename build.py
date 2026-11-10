#!/usr/bin/env python3
"""Assemble src/ into one self-contained index.html (the file GitHub Pages serves).

    python3 build.py           # index.html, with a Content-Security-Policy that blocks all network access
    python3 build.py --dev     # dev.html, same page without the policy, for automated tests that fetch fixtures
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

html = (src / "index.html").read_text()
for marker, value in (("<!--CSP-->", "" if dev else CSP), ("/*CSS*/", (src / "style.css").read_text()),
                      ("/*CORE*/", core), ("/*APP*/", app)):
    if html.count(marker) != 1:
        sys.exit(f"expected exactly one {marker} in src/index.html")
    html = html.replace(marker, value)

out = root / ("dev.html" if dev else "index.html")
out.write_text(html)
print(f"wrote {out.name} ({len(html) / 1024:.0f} KB)")
