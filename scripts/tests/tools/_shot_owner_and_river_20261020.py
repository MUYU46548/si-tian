#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""出图：2026-10-20 两件改动的真机观感（lab 必须先 up）。

  ① 涂归属 = **只改势力归属**（一笔划过几个省 → 整片换色，省界不动）
  ② 河流 = **实心变宽丝带**（不再逐段描边 → 放大后没有「铁轨」）

产物：docs/assets/owner-brush-river-20261020/*.png
用法：python scripts/tests/tools/_lab.py up && python scripts/tests/tools/_shot_owner_and_river_20261020.py
"""
import base64
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

OUT = os.path.join(ROOT, 'docs', 'assets', 'owner-brush-river-20261020')
BUST = int(time.time())
SM = "document.querySelector('.scenario-map-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
KEY = 'riverdemo'


def shot(cdp, name):
    os.makedirs(OUT, exist_ok=True)
    s = cdp.send('Page.captureScreenshot', {'format': 'png'})
    p = os.path.join(OUT, name)
    open(p, 'wb').write(base64.b64decode(s['data']))
    print('shot ->', p)


SEED = r"""
(async () => {
  const s = %(STORE)s, sm = %(SM)s;
  const KEY = %(KEY)s;
  for (const k of Object.keys(s.scenarios || {})) s.removeScenario(k);
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const bm = s.baseMaps[KEY];
  bm.terrain = [
    { id: 'land', name: '大陆', kind: 'land', points: [{x:0,y:0},{x:900,y:0},{x:900,y:700},{x:0,y:700}] },
  ];
  bm.rivers = [];
  const mkProv = (id, name, x0, x1) => ({ id, name, kind: 'land',
    points: [{x:x0,y:0},{x:x1,y:0},{x:x1,y:700},{x:x0,y:700}] });
  s.addBaseProvince(KEY, mkProv('pa', '甲省', 0, 300), { checkOverlap: false });
  s.addBaseProvince(KEY, mkProv('pb', '乙省', 300, 600), { checkOverlap: false });
  s.addBaseProvince(KEY, mkProv('pc', '丙省', 600, 900), { checkOverlap: false });
  // 导入河：横穿三块省界（弯 + 变宽由渲染器负责）
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const x = 40 + i * 20;
    pts.push({ x, y: 380 + Math.sin(i / 5) * 26 });
  }
  bm.rivers.push({ id: 'imp_river_demo', name: '导入河', width: 4, discharge: 420, points: pts });
  // 手画河：带 widthFactors（源头细 → 河口粗 + 中段收窄）
  const hp = [];
  for (let i = 0; i <= 12; i++) hp.push({ x: 80 + i * 60, y: 200 + Math.cos(i / 2.2) * 40 });
  const factors = hp.map((_, i) => 0.7 + 1.1 * (i / (hp.length - 1)));
  const hr = s.addBaseMapRiver(KEY, { points: hp, width: 5, widthFactors: factors });
  const P = (id, name, color) => ({ id, name, color });
  s.createScenario(KEY + '/甲时代', { ownerKey: KEY, name: '甲时代', order: 1,
    era: { roman: 'I', label: '甲', startYear: '2000', endYear: '2010' },
    polities: [P('A1', '甲国', '#c23b3b'), P('A2', '乙国', '#4a90d9')],
    ownership: { pa: 'A1', pb: 'A1', pc: 'A1' } });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  sm.selectScenario(s.scenarios[KEY + '/甲时代']);
  sm.tlDate = { y: 2005, m: null, d: null };
  sm.setTool('select');
  sm.cameraX = 0; sm.cameraY = 0; sm.cameraScale = 1;
  if (typeof sm.render === 'function') sm.render();
  return JSON.stringify({ ok: true, riverId: hr && hr.id, terrain: s.baseMaps[KEY].terrain.length,
    rivers: s.baseMaps[KEY].rivers.length, camScale: sm.cameraScale });
})()
"""


def main():
    cdp = CDP()
    try:
        cdp.navigate('http://localhost:5180/?shot=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='boot')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?shot=%d' % (BUST + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?shot=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload2')
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=40, desc='data')
        open_harness_project(cdp)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor')
        time.sleep(1.0)

        res = cdp.eval(SEED % {'STORE': STORE, 'SM': SM, 'KEY': json.dumps(KEY)})
        print('seed:', str(res)[:300])
        time.sleep(0.8)
        shot(cdp, '01-river-1x.png')

        # 放大 4× 看河道本体（铁轨/竹节在这里最明显）
        cdp.eval("(() => { const sm = %s; sm.cameraScale = 4;"
                 " sm.cameraX = sm.canvas.clientWidth / 2 - 450 * 4;"
                 " sm.cameraY = sm.canvas.clientHeight / 2 - 380 * 4;"
                 " sm.render(); return 'ok'; })()" % SM)
        time.sleep(0.6)
        shot(cdp, '02-river-4x.png')

        # 回到 1×，涂归属：选乙国 → 从甲省拖到乙省（按住时不松手，先拍高亮）
        cdp.eval("""(() => {
          const sm = %s, s = %s;
          sm.cameraX = 0; sm.cameraY = 0; sm.cameraScale = 1;
          const sc = s.scenarios['%s/甲时代'];
          sm.selectPolity((sc.polities || []).find(p => p.id === 'A2') || null);
          sm.provBrushRadius = 40;
          sm.setTool('ownerBrush');
          sm.render();
          return 'ok';
        })()""" % (SM, STORE, KEY))
        time.sleep(0.4)
        # 用真实鼠标拖：从 (150,500) 到 (750,500)
        rect = cdp.eval("(() => { const c = document.querySelector('.scenario-map-container canvas');"
                        " const r = c.getBoundingClientRect();"
                        " const sm = %s;"
                        " const a = sm.worldToScreen(150, 500), b = sm.worldToScreen(750, 500);"
                        " return JSON.stringify({ left: r.left, top: r.top,"
                        " a: { x: r.left + a.x, y: r.top + a.y }, b: { x: r.left + b.x, y: r.top + b.y } }); })()" % SM)
        rect = json.loads(rect)
        a, b = rect['a'], rect['b']
        cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': a['x'], 'y': a['y'],
                                              'button': 'left', 'buttons': 1, 'clickCount': 1})
        for i in range(1, 5):
            cdp.send('Input.dispatchMouseEvent', {
                'type': 'mouseMoved',
                'x': round(a['x'] + (b['x'] - a['x']) * i / 4),
                'y': round(a['y'] + (b['y'] - a['y']) * i / 4),
                'button': 'left', 'buttons': 1,
            })
            time.sleep(0.12)
        time.sleep(0.3)
        shot(cdp, '03-owner-brush-dragging.png')
        cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': b['x'], 'y': b['y'],
                                              'button': 'left', 'buttons': 0, 'clickCount': 1})
        time.sleep(0.6)
        shot(cdp, '04-owner-brush-done.png')
        print('hint:', cdp.eval("String(%s.provinceHint || '')" % SM))
        print('ownership:', cdp.eval("JSON.stringify((%s.scenarios['%s/甲时代'] || {}).ownership)" % (STORE, KEY)))
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
