#!/bin/sh
# Renders sidestr.md to index.html (the landing page, with OGP and citation tags) and sidestr.pdf (with metadata), and og.svg to og.png.
# Needs python3, node with `npm install` run here once, a Chromium, and pdftoppm (poppler) for the card's page thumbnail.
set -e
cd "$(dirname "$0")"
python3 md2html.py sidestr.md > index.html
CHROME=${CHROME:-$(command -v chromium-browser || command -v chromium || command -v google-chrome || command -v brave-browser)}
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf=sidestr.pdf "file://$PWD/index.html" 2>/dev/null
TITLE=$(sed -n '1s/^# //p' sidestr.md); DATE=$(sed -n 's/^Draft, //p' sidestr.md | head -1)
node meta.mjs sidestr.pdf "$TITLE" "Melvin Carvalho" "$DATE" "sidestr white paper, draft $DATE. Sidechains validated by the user; signers order blocks." sidestr sidechain bitcoin "user activated" peg "signed blocks" nostr
pdftoppm -r 160 -png -f 1 -l 1 sidestr.pdf page1 && mv page1-1.png page1.png
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1200,630 --screenshot=og.png "file://$PWD/og.html" 2>/dev/null
ls -l sidestr.pdf og.png
