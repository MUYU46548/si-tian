#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe: verify river BRANCHING (item 3) actually works through the product gestures.

Product path being exercised (all real DOM events on the canvas):
  1. draw a trunk river with the river tool (mousedown -> mousemove* -> mouseup);
  2. start a second stroke ON the trunk's body -> the draft must snap to the trunk
     (riverDraftParentId set, first draft point exactly on the trunk line);
  3. drag away and release -> a NEW river appears whose first point lies on the trunk
     (the branch), and the trunk itself is unchanged;
  4. anti-"crossing monster": draw a stroke that comes back across the trunk -> it must
     be REFUSED with a readable status message and NOTHING落库 (river count unchanged).
Usage (lab must be up): python scripts/tests/tools/_probe_river_branch.py
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

OUT = os.path.join(ROOT, 'docs', 'assets', 'river-branch-20261018')
BUST = int(time.time())

# Set up: a synthetic base map with a clean trunk river drawn across the land.
SETUP = r"""
(async () => {
  const s = (document.querySelector('#app').__vue_app__._instance.setupState).store;
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const KEY = 'branchdiag';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  const bm = s.baseMaps[KEY];
  bm.terrain.length = 0;
  if (typeof s.ensureHeightmap === 'function') s.ensureHeightmap(KEY, { cols: 40, rows: 30, spacing: 20 });
  const hm = s.getHeightmapFor(KEY);
  const cp = (hm && hm.grid && hm.grid.points) || [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of cp) {
    const x = Array.isArray(q) ? q[0] : q.x, y = Array.isArray(q) ? q[1] : q.y;
    if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  const sm = sc();
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 600));
  if (sm.setTool) sm.setTool('river');
  await new Promise(r => setTimeout(r, 200));
  const cvr = sm.canvas.getBoundingClientRect();
  // ⚠️ 别依赖高度图格点求范围（`ensureHeightmap` 不保证有 grid.points —— 第一版就是这么
  //    拿到 null 的）。直接取**当前可见世界矩形**的中间 70%：它一定在屏幕内，
  //    而"能不能画到"才是这一段要验的事。
  const tl = sm.screenToWorld(0, 0);
  const br = sm.screenToWorld(cvr.width, cvr.height);
  const padX = (br.x - tl.x) * 0.18, padY = (br.y - tl.y) * 0.18;
  return JSON.stringify({
    KEY, canvasRect: { x: cvr.x, y: cvr.y, w: cvr.width, h: cvr.height },
    bounds: { minX: tl.x + padX, maxX: br.x - padX, minY: tl.y + padY, maxY: br.y - padY },
    cam: { scale: sm.cameraScale, x: sm.cameraX, y: sm.cameraY },
    rivers: (s.baseMaps[KEY].rivers || []).length,
    fails: [],
  });
})()"""

# Drive one stroke: world points -> real pointer events on the canvas, then report.
# ⚠️ 定义成**箭头函数表达式**（不带尾部自调用括号），调用方拼 `(<fn>)(<args>)`。
STROKE = r"""async (worldPts) => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const cv = sm.canvas;
  const rect = cv.getBoundingClientRect();
  const toScreen = (p) => {
    const s2 = sm.worldToScreen(p.x, p.y);
    return { x: rect.left + s2.x, y: rect.top + s2.y };
  };
  const ev = (type, sp, shift) => cv.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: sp.x, clientY: sp.y, button: 0, buttons: 1, shiftKey: !!shift,
  }));
  const before = (sm.baseMap.rivers || []).length;
  ev('mousedown', toScreen(worldPts[0]), window.__strokeShift);
  await new Promise(r => setTimeout(r, 40));
  const parentAfterDown = sm.riverDraftParentId;
  const draftAfterDown = (sm.riverDraft || []).map(p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
  for (let i = 1; i < worldPts.length; i++) {
    ev('mousemove', toScreen(worldPts[i]), window.__strokeShift);
    await new Promise(r => setTimeout(r, 25));
  }
  ev('mouseup', toScreen(worldPts[worldPts.length - 1]), window.__strokeShift);
  await new Promise(r => setTimeout(r, 220));
  const after = (sm.baseMap.rivers || []).length;
  return JSON.stringify({ before, after, parentAfterDown, draftAfterDown,
                          status: sm.statusMsg || sm.provinceHint || null, fails: [] });
}"""

INSPECT = r"""
(() => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const list = (sm.baseMap.rivers || []).map(r => ({
    id: r.id, n: (r.points || []).length, width: r.width,
    first: r.points && r.points[0] ? { x: Math.round(r.points[0].x * 10) / 10, y: Math.round(r.points[0].y * 10) / 10 } : null,
    last: r.points && r.points.length ? { x: Math.round(r.points[r.points.length - 1].x * 10) / 10,
                                        y: Math.round(r.points[r.points.length - 1].y * 10) / 10 } : null,
  }));
  return JSON.stringify({ rivers: list, fails: [] });
})()"""


def main():
    os.makedirs(OUT, exist_ok=True)
    cdp = CDP()
    try:
        cdp.navigate('http://localhost:5180/?lab=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='boot')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?lab=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload')
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=40, desc='data')
        print('project:', open_harness_project(cdp)[0])
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor')
        time.sleep(0.8)

        setup = cdp.eval(SETUP)
        print('setup ->', setup)
        s = json.loads(setup) if isinstance(setup, str) else setup
        b = s.get('bounds') or {}
        if not all(isinstance(b.get(k), (int, float)) for k in ('minX', 'maxX', 'minY', 'maxY')):
            print('!! no bounds'); return
        cx = (b['minX'] + b['maxX']) / 2
        trunk = [{'x': cx, 'y': b['minY'] + (b['maxY'] - b['minY']) * (i / 8)} for i in range(9)]

        # ── 1) trunk ──
        r1 = cdp.eval("(%s)(%s)" % (STROKE.strip().lstrip('('), json.dumps(trunk)))
        print('trunk stroke ->', r1)
        print('after trunk ->', cdp.eval(INSPECT))

        # ── 2) branch: start on the middle of the trunk, go sideways ──
        mid = trunk[4]
        branch = [{'x': mid['x'], 'y': mid['y']}]
        for i in range(1, 7):
            branch.append({'x': mid['x'] + (b['maxX'] - b['minX']) * 0.18 * i / 6,
                           'y': mid['y'] + (b['maxY'] - b['minY']) * 0.16 * i / 6})
        r2 = cdp.eval("(%s)(%s)" % (STROKE, json.dumps(branch)))
        print('branch stroke ->', r2)
        after_branch = cdp.eval(INSPECT)
        print('after branch ->', after_branch)

        # ── 3) crossing monster: go out and come back across the trunk ──
        cross = [{'x': mid['x'] + (b['maxX'] - b['minX']) * 0.10, 'y': mid['y']},
                 {'x': mid['x'] + (b['maxX'] - b['minX']) * 0.22, 'y': mid['y'] + (b['maxY'] - b['minY']) * 0.05},
                 {'x': mid['x'] + (b['maxX'] - b['minX']) * 0.30, 'y': mid['y']},
                 {'x': mid['x'] + (b['maxX'] - b['minX']) * 0.22, 'y': mid['y'] - (b['maxY'] - b['minY']) * 0.05},
                 {'x': mid['x'] + (b['maxX'] - b['minX']) * 0.10, 'y': mid['y']},
                 {'x': mid['x'] - (b['maxX'] - b['minX']) * 0.08, 'y': mid['y']}]
        r3 = cdp.eval("(%s)(%s)" % (STROKE, json.dumps(cross)))
        print('crossing stroke ->', r3)
        print('after crossing ->', cdp.eval(INSPECT))

        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        p = os.path.join(OUT, 'branch-after.png')
        open(p, 'wb').write(base64.b64decode(shot['data']))
        print('shot ->', p)
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
