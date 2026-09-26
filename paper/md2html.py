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
nav { text-align: right; font-size: 10pt; color: #5b6470; margin-bottom: 14pt; } nav a { color: #0f766e; }
@media print { nav { display: none; } }
@media screen { body { padding: 24px 16px; } }
'''
abstract = re.sub(r'^<p class="abstract"><b>Abstract\.</b>\s*', '', next(x for x in out if 'class="abstract"' in x))
abstract = re.sub(r'<.*?>', '', abstract)
desc = html.escape(abstract.split('. ')[2] + '. ' + abstract.split('. ')[3] + '.')  # two sentences of the abstract
author = front[0]; date = next(x for x in reversed(front) if x).replace('Draft, ', '')
iso = __import__('datetime').datetime.strptime(date, '%d %B %Y').strftime('%Y/%m/%d')
base = 'https://sidestr.com/spec/paper/'
meta = f'''<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="{desc}">
<meta name="author" content="{html.escape(author)}">
<link rel="canonical" href="{base}">
<meta property="og:site_name" content="sidestr">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="article">
<meta property="og:url" content="{base}">
<meta property="og:image" content="{base}og.png?v=1">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{html.escape(title)}: white paper, draft {html.escape(date)}">
<meta property="article:author" content="{html.escape(author)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{html.escape(title)}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{base}og.png?v=1">
<meta name="citation_title" content="{html.escape(title)}">
<meta name="citation_author" content="{html.escape(author)}">
<meta name="citation_publication_date" content="{iso}">
<meta name="citation_pdf_url" content="{base}sidestr.pdf">
<meta name="citation_abstract_html_url" content="{base}">'''
links = '<nav><a href="sidestr.pdf">PDF</a> · <a href="sidestr.md">Markdown</a> · <a href="../">Spec</a> · <a href="https://sidestr.com/">sidestr.com</a></nav>'
print(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>{meta}<style>{css}</style></head><body>{links}<h1>{html.escape(title)}</h1><div class="front">{front_html}</div>{"".join(out)}</body></html>')
