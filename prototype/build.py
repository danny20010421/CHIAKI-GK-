#!/usr/bin/env python3
"""Assemble the single-file site into the repository root index.html (GitHub Pages).

Optional: put your own guarantee-pool cover at assets/guarantee-cover.jpg
(git-ignored) to embed it; otherwise the pool shows the default artwork.
"""
import base64, pathlib
here = pathlib.Path(__file__).parent
parts = ['1_head.html', '2_body.html', '3_core.js', '4_pool.js', '5_pages.js', '6_ops.js', '8_fx.js', '9_admin.js', '10_catalog.js', '11_backoffice.js', '12_sets.js', '13_more.js', '15_vip.js', '14_home.js', '16_bday.js', '17_cards.js', '18_coupon.js', '19_ticket.js', '7_rules.js']
html = ''.join((here / 'src' / p).read_text(encoding='utf-8') for p in parts)
cover = here / 'assets' / 'guarantee-cover.jpg'
guar = 'data:image/jpeg;base64,' + base64.b64encode(cover.read_bytes()).decode() if cover.exists() else ''
html = html.replace('__GUAR__', guar)
# product photos for the test pools (media/<key>.b64, JPEG)
for f in sorted((here / 'media').glob('*.b64')):
    html = html.replace('__DEMO_' + f.stem + '__', 'data:image/jpeg;base64,' + f.read_text().strip())
# draw animation video is served as its own file next to index.html (assets/gacha1.mp4, assets/gacha2.mp4)
for v in ('gacha1', 'gacha2', 'gacha3'):
    html = html.replace('__VIDEO_' + v + '__', 'assets/' + v + '.mp4')
out = here.parent / 'index.html'   # GitHub Pages serves the repository root
out.write_text(html, encoding='utf-8')
print('built', out, len(html), 'bytes')
