#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""S0 笔刷矩阵出图页（不是回归用例）：把 summary.json + 12 组前后截图拼成一个本地 HTML。

用法：
    python scripts/tests/tools/_make_brush_gallery.py
打开：
    docs/assets/s0-brush-20261019/index.html

为什么做：截图是给人看的；JSON 是给判据用的。两者放一页，暮雨不必逐张点文件名。
"""
import html
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
D = os.path.join(ROOT, 'docs', 'assets', 's0-brush-20261019')
SUMMARY = os.path.join(D, 'summary.json')
DIFF = os.path.join(D, 'diff.json')

TITLES = {
    '01-draw': '自由绘制（B）',
    '02-outline': '描轮廓（Y）',
    '03-brush-paint': '省份笔刷 · 涂归属（Q）',
    '04-lasso': '自由轮廓 / 套索',
    '05-polysplit': '折线切割',
    '06-river': '河流笔（W）',
    '07-river-erase': '河流橡皮（Shift+W）',
    '08-height': '高度笔刷（H）',
    '09-biome': '群系笔刷（N）',
    '10-culture': '文化笔刷（C）',
    '11-religion': '宗教笔刷（R）',
    '12-brush-erase': '省份笔刷 · 抹除',
}


def esc(v):
    return html.escape(str(v if v is not None else '—'))


def main():
    if not os.path.exists(SUMMARY):
        raise SystemExit('缺 %s（先跑 _probe_brush_matrix.py）' % SUMMARY)
    s = json.load(open(SUMMARY, encoding='utf-8'))
    diff = json.load(open(DIFF, encoding='utf-8')) if os.path.exists(DIFF) else {}
    cards = []
    for t in s.get('tools', []):
        tid = t.get('id', '?')
        be, af = t.get('before', {}), t.get('after', {})
        geom = t.get('geom') or []
        g = geom[0] if geom else (t.get('lastProv') or {})
        d = diff.get(tid, {})
        rows = [
            ('地形/河', '%s / %s → %s / %s' % (be.get('terrain'), be.get('rivers'), af.get('terrain'), af.get('rivers'))),
            ('点数', '%s → %s' % (be.get('terrainPts'), af.get('terrainPts'))),
            ('几何', '顶点 %s · 面积 %s · 鼓出 %spx（%s%%）· 尖刺 %s · 自交 %s' % (
                g.get('n'), g.get('area'), g.get('maxBulgePx'), round((g.get('maxBulgeRatio') or 0) * 100, 1),
                g.get('spikes'), g.get('selfInt'))),
            ('像素差', '%s px（%s%%）bbox %s' % (d.get('changedPixels'), round((d.get('ratio') or 0) * 100, 2), d.get('bbox'))),
            ('状态栏', (af.get('status') or '')[-160:]),
            ('撤销', 'undo=%s · 复原=%s' % (t.get('undoCount'), '是' if t.get('restored') else '—')),
        ]
        trs = ''.join('<tr><th>%s</th><td>%s</td></tr>' % (esc(k), esc(v)) for k, v in rows)
        shot = t.get('shot', '')
        before = t.get('shotBefore', '')
        imgs = ''
        if before and os.path.exists(os.path.join(D, os.path.basename(before))):
            imgs += '<figure><img src="%s"><figcaption>画之前</figcaption></figure>' % esc(os.path.basename(before))
        if shot and os.path.exists(os.path.join(D, os.path.basename(shot))):
            imgs += '<figure><img src="%s"><figcaption>抬手之后</figcaption></figure>' % esc(os.path.basename(shot))
        cards.append("""
<section class="card">
  <h2>%s <span class="tid">%s</span></h2>
  <div class="imgs">%s</div>
  <table>%s</table>
</section>""" % (esc(TITLES.get(tid, tid)), esc(tid), imgs, trs))

    out = """<!doctype html><meta charset="utf-8">
<title>司天 S0 笔刷矩阵（2026-10-19）</title>
<style>
 body{font:14px/1.5 system-ui,"Microsoft YaHei";margin:24px;background:#f6f7f9;color:#1c2430}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#5b6676;margin-bottom:18px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(520px,1fr));gap:16px}
 .card{background:#fff;border:1px solid #dde2ea;border-radius:10px;padding:14px;box-shadow:0 1px 2px #0001}
 h2{font-size:15px;margin:0 0 10px} .tid{color:#8a94a6;font-weight:400;font-size:12px}
 .imgs{display:grid;grid-template-columns:1fr 1fr;gap:8px}
 figure{margin:0} img{width:100%;border:1px solid #d5dbe5;border-radius:6px;display:block}
 figcaption{font-size:12px;color:#6b7688;text-align:center;margin-top:3px}
 table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12.5px}
 th{width:72px;text-align:left;color:#5b6676;font-weight:500;vertical-align:top;padding:3px 6px 3px 0}
 td{padding:3px 0;word-break:break-all}
</style>
<h1>司天 S0 笔刷矩阵</h1>
<div class="sub">真实 desite.map（200 省）· 每笔真实/合成鼠标事件 · 截图 __N__ 组 · 本机证据</div>
<div class="grid">__CARDS__</div>
"""
    out = out.replace('__N__', str(len(cards))).replace('__CARDS__', ''.join(cards))
    path = os.path.join(D, 'index.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)
    print('gallery ->', os.path.relpath(path, ROOT))


if __name__ == '__main__':
    main()
