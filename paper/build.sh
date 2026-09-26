#!/bin/sh
# Renders sidestr.md to sidestr.html and sidestr.pdf. Needs python3 and a Chromium.
set -e
cd "$(dirname "$0")"
python3 md2html.py sidestr.md > sidestr.html
CHROME=${CHROME:-$(command -v chromium-browser || command -v chromium || command -v google-chrome || command -v brave-browser)}
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf=sidestr.pdf "file://$PWD/sidestr.html" 2>/dev/null
ls -l sidestr.pdf
