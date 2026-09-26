#!/usr/bin/env python3
"""Turns the paper's Markdown (title, front matter, ## sections, paragraphs, tables, numbered lists) into one HTML page."""
import re, sys, html
src = open(sys.argv[1]).read().split('\n')
def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    return re.sub(r'(https?://[^\s,)]+)', r'<a href="\1">\1</a>', t)
out, front, title, i = [], [], None, 0
while i < len(src):
    l = src[i]
    if title is None and l.startswith('# '):
        title = l[2:]; i += 1
        while i < len(src) and not src[i].startswith('**Abstract'):
            if src[i].strip(): front.append(inline(src[i]))
            elif front and front[-1] != '': front.append('')
            i += 1
        continue
    if l.startswith('## '):
        out.append(f'<h2>{inline(l[3:])}</h2>'); i += 1; continue
    if l.startswith('|'):
        rows = []
        while i < len(src) and src[i].startswith('|'):
            rows.append([c.strip() for c in src[i].strip('|').split('|')]); i += 1
        rows = [r for r in rows if not all(re.fullmatch(r'-+', c) for c in r)]
        h = ''.join(f'<th>{inline(c)}</th>' for c in rows[0])
        b = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows[1:])
        out.append(f'<table><tr>{h}</tr>{b}</table>'); continue
    if re.match(r'\d+\. ', l):
        items = []
        while i < len(src) and re.match(r'\d+\. ', src[i]):
            items.append(re.sub(r'^\d+\. ', '', src[i])); i += 1
        out.append('<ol>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ol>'); continue
    if not l.strip():
        i += 1; continue
    para = []
    while i < len(src) and src[i].strip() and not src[i].startswith(('## ', '|')) and not re.match(r'\d+\. ', src[i]):
        para.append(src[i]); i += 1
    text = ' '.join(para)
    cls = ' class="abstract"' if text.startswith('**Abstract') else ''
    out.append(f'<p{cls}>{inline(text)}</p>')
front_html = '<br>'.join(x if x else '' for x in front).replace('<br><br>', '<br><br>')
css = '''
@page { size: A4; margin: 25mm; }
body { font-family: "Times New Roman", Times, serif; font-size: 11.5pt; line-height: 1.38; color: #000; max-width: 160mm; margin: 0 auto; }
h1 { font-size: 20pt; text-align: center; font-weight: bold; margin: 0 0 6pt; }
.front { text-align: center; font-size: 11pt; margin-bottom: 18pt; }
h2 { font-size: 12.5pt; font-weight: bold; margin: 16pt 0 4pt; }
p { margin: 0 0 7pt; text-align: justify; }
p.abstract { margin: 0 12mm 6pt; }
table { border-collapse: collapse; margin: 6pt auto 10pt; font-size: 10.5pt; }
th, td { border: 1px solid #000; padding: 2.5pt 6pt; text-align: left; vertical-align: top; }
ol { margin: 0 0 7pt 18pt; padding: 0; } li { margin-bottom: 3pt; }
code { font-family: "Courier New", monospace; font-size: 10pt; }
a { color: #000; text-decoration: none; }
'''
print(f'<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(title)}</title><style>{css}</style></head><body><h1>{html.escape(title)}</h1><div class="front">{front_html}</div>{"".join(out)}</body></html>')
