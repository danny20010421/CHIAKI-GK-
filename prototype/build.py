#!/usr/bin/env python3
"""Assemble the single-file site into the repository root index.html (GitHub Pages).

Optional: put your own guarantee-pool cover at assets/guarantee-cover.jpg
(git-ignored) to embed it; otherwise the pool shows the default artwork.
"""
import base64, pathlib
here = pathlib.Path(__file__).parent
parts = ['1_head.html', '2_body.html', '3_core.js', '4_pool.js', '5_pages.js', '6_ops.js', '8_fx.js', '9_admin.js', '7_rules.js']
html = ''.join((here / 'src' / p).read_text(encoding='utf-8') for p in parts)
cover = here / 'assets' / 'guarantee-cover.jpg'
guar = 'data:image/jpeg;base64,' + base64.b64encode(cover.read_bytes()).decode() if cover.exists() else ''
html = html.replace('__GUAR__', guar)
out = here.parent / 'index.html'   # GitHub Pages serves the repository root
out.write_text(html, encoding='utf-8')
print('built', out, len(html), 'bytes')
