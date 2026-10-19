#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe: how much of the river stays VISIBLE while it is selected?

The complaint (暮雨, with a screenshot neither of us could read): the selection highlight is a
thick milky glow that covers the whole river, so drawing becomes impossible. This probe turns
that into a number:

  1. draw a river with the product write path, point the camera at it at a fixed zoom;
  2. count the pixels of the *river water colour* inside a window around it  -> `before`
  3. select the river through the product selection API (`setRiverSelection`),
     re-render, count the same window                                      -> `after`
  4. report the ratio + the layout of the cross-section, so "occluded" vs "outlined" is visible.

A correct selection mark keeps the water readable: ratio should stay high (~>0.6), and the
cross-section must still show the solid water colour in the MIDDLE.

Usage (lab must be up): python scripts/tests/tools/_probe_river_selection_visibility.py
"""
import json
import os
import sys
import time
import base64

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

BUST = int(time.time())
OUT = os.path.join(ROOT, 'docs', 'assets', 'river-selection-20261018')

MEASURE = r"""
(async (sm, opts) => {
  const cv = sm.canvas;
  const g = cv.getContext('2d');
  const WATER = [0x5d, 0x97, 0xbb];
  const near = (d, i, tol) => Math.hypot(d[i] - WATER[0], d[i + 1] - WATER[1], d[i + 2] - WATER[2]) < tol;
  const river = (sm.baseMap.rivers || []).find(r => String(r.id).indexOf('river_selvis') === 0);
  if (!river) return { fails: ['no river'] };
  const pts = river.points;

  // 把相机钉在这条河的中段上（用组件自己的变换反推）
  const mid = pts[Math.floor(pts.length / 2)];
  sm.cameraScale = opts.zoom;
  sm.cameraX = cv.clientWidth / 2 - mid.x * opts.zoom;
  sm.cameraY = cv.clientHeight / 2 - mid.y * opts.zoom;
  if (sm.render) sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 180));
  if (sm.render) sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const q = sm.worldToScreen(mid.x, mid.y);
  const cx = Math.round(q.x), cy = Math.round(q.y);
  const W = opts.win || 40;
  const x0 = Math.max(0, cx - W), x1 = Math.min(cv.width, cx + W);
  const y0 = Math.max(0, cy - W), y1 = Math.min(cv.height, cy + W);
  const scan = () => {
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let water = 0;
    for (let i = 0; i < d.length; i += 4) if (near(d, i, 60)) water++;
    return { water, total: ((x1 - x0) * (y1 - y0)) };
  };
  // 横切：过中段那条水平线（放在点集里找一段**接近竖直**的，横切才有意义）
  let bestI = -1, bestVert = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = Math.abs(pts[i + 1].x - pts[i].x), dy = Math.abs(pts[i + 1].y - pts[i].y);
    if (dy > dx * 4 && dy > bestVert) { bestVert = dy; bestI = i; }
  }
  const seg = bestI >= 0
    ? { x: (pts[bestI].x + pts[bestI + 1].x) / 2, y: (pts[bestI].y + pts[bestI + 1].y) / 2 }
    : mid;
  const qs = sm.worldToScreen(seg.x, seg.y);
  const row = Math.round(qs.y);
  const rx0 = Math.max(0, Math.round(qs.x) - 26), rx1 = Math.min(cv.width, Math.round(qs.x) + 26);
  const cross = () => {
    const d = g.getImageData(rx0, row, rx1 - rx0, 1).data;
    const out = [];
    for (let i = 0; i < (rx1 - rx0); i++) {
      const hex = '#' + [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
      const isW = near(d, i * 4, 60);
      if (out.length && out[out.length - 1].w === isW) out[out.length - 1].n++;
      else out.push({ w: isW, hex, n: 1 });
    }
    return out;
  };

  // ⚠️ 采样窗口必须在**每次测量时重新算**：选中一条河会让工具栏多出一行 →
  //    画布高度/中心一起变（本仓既有的坑：test_114 也踩过"选中后画布整体下移"）。
  //    第一版把窗口算一次复用，于是 after 量的是**河旁边**的空地 → 得出"保留率 0.009"的假结论。
  const geom = () => {
    const r = cv.getBoundingClientRect();
    const q = sm.worldToScreen(mid.x, mid.y);
    const qs = sm.worldToScreen(seg.x, seg.y);
    return { clientH: cv.clientHeight, rectY: Math.round(r.y), cx: Math.round(q.x), cy: Math.round(q.y),
             row: Math.round(qs.y), x: Math.round(qs.x) };
  };
  const scanAt = (g0) => {
    const x0 = Math.max(0, g0.cx - W), x1 = Math.min(cv.width, g0.cx + W);
    const y0 = Math.max(0, g0.cy - W), y1 = Math.min(cv.height, g0.cy + W);
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let water = 0, sel = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (near(d, i, 60)) water++;
      // 选中色：暖金 / 冷青 / 手柄白 —— 只要画面上出现就说明"有反馈"
      const gold = Math.hypot(d[i] - 255, d[i + 1] - 214, d[i + 2] - 102) < 90;
      const cyan = Math.hypot(d[i] - 34, d[i + 1] - 211, d[i + 2] - 238) < 90;
      if (gold || cyan) sel++;
    }
    return { water, sel, win: { x0, y0, x1, y1 } };
  };
  const crossAt = (g0) => {
    const rx0 = Math.max(0, g0.x - 26), rx1 = Math.min(cv.width, g0.x + 26);
    const d = g.getImageData(rx0, g0.row, rx1 - rx0, 1).data;
    const out = [];
    for (let i = 0; i < (rx1 - rx0); i++) {
      const hex = '#' + [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
      const isW = near(d, i * 4, 60);
      if (out.length && out[out.length - 1].w === isW) out[out.length - 1].n++;
      else out.push({ w: isW, hex, n: 1 });
    }
    return out;
  };

  const gBefore = geom();
  const before = { ...scanAt(gBefore), cross: crossAt(gBefore), geom: gBefore };
  const camBefore = { s: sm.cameraScale, x: Math.round(sm.cameraX), y: Math.round(sm.cameraY) };
  const selBefore = { ids: (sm.selectedRiverIds || []).slice(), primary: sm.selectedRiverId };
  // 走产品选中路径
  if (typeof sm.setRiverSelection !== 'function') return { fails: ['no setRiverSelection'], before };
  sm.setRiverSelection([river.id], river.id);
  if (sm.render) sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 180));
  if (sm.render) sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const gAfter = geom();                     // ← 重新算（画布可能已经变矮）
  const after = { ...scanAt(gAfter), cross: crossAt(gAfter), geom: gAfter };
  const camAfter = { s: sm.cameraScale, x: Math.round(sm.cameraX), y: Math.round(sm.cameraY) };
  const selAfter = { ids: (sm.selectedRiverIds || []).slice(), primary: sm.selectedRiverId };
  return {
    zoom: opts.zoom, riverId: river.id, pts: pts.length,
    camBefore, camAfter, selBefore, selAfter,
    beforeWater: before.water, afterWater: after.water,
    beforeSel: before.sel, afterSel: after.sel,
    beforeGeom: gBefore, afterGeom: gAfter,
    ratio: before.water > 0 ? +(after.water / before.water).toFixed(3) : null,
    beforeCross: before.cross, afterCross: after.cross,
    fails: [],
  };
})
"""

SETUP = r"""
(async () => {
  const s = (document.querySelector('#app').__vue_app__._instance.setupState).store;
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const KEY = 'selvisdiag';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  sm.baseMapKey = KEY;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 400));
  // 一条**接近竖直**的河（横切扫描才有意义），落在初始视野中间
  const cv = sm.canvas;
  const tl = sm.screenToWorld(0, 0);
  const br = sm.screenToWorld(cv.clientWidth, cv.clientHeight);
  const x = tl.x + (br.x - tl.x) * 0.5;
  const y0 = tl.y + (br.y - tl.y) * 0.25, y1 = tl.y + (br.y - tl.y) * 0.75;
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: x + Math.sin(i / 2) * 4, y: y0 + (y1 - y0) * (i / 10) });
  const rid = 'river_selvis1';
  if ((s.baseMaps[KEY].rivers || []).some(r => r.id === rid)) s.removeBaseMapRiver(KEY, rid);
  const add = s.addBaseMapRiver(KEY, { id: rid, name: 'selvis', points: pts, width: 7 });
  await new Promise(r => setTimeout(r, 300));
  sm.setTool && sm.setTool('river');
  if (sm.render) sm.render();
  return JSON.stringify({ add: add && add.ok, key: KEY, rid, points: pts.length, fails: [] });
})()
"""


def main():
    cdp = CDP()
    try:
        cdp.navigate('http://localhost:5180/?selvis=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='boot')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?selvis=%d' % (BUST + 1))   # 硬重载（防 HMR 旧闭包）
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='hard-reload')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?selvis=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload')
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=40, desc='data')
        open_harness_project(cdp)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor')
        time.sleep(0.8)
        print('setup ->', cdp.eval(SETUP))
        for zoom in (1, 4):
            r = cdp.eval("(%s)(document.querySelector('.scenario-map-container')"
                         ".__vueParentComponent.setupState, %s)" % (MEASURE, json.dumps({'zoom': zoom, 'win': 40})))
            if isinstance(r, dict) and '__err__' in r:
                print('zoom', zoom, 'ERR', str(r)[:300]); continue
            d = json.loads(r) if isinstance(r, str) else r
            print('== zoom', d.get('zoom'), '水色像素 before/after =', d.get('beforeWater'), '/', d.get('afterWater'),
                  ' 保留率 =', d.get('ratio'), ' 选中色像素 before/after =', d.get('beforeSel'), '/', d.get('afterSel'))
            print('   cam', d.get('camBefore'), '→', d.get('camAfter'),
                  ' sel', d.get('selBefore'), '→', d.get('selAfter'))
            print('   几何 before', d.get('beforeGeom'), ' after', d.get('afterGeom'))
            print('   横切 before:', json.dumps(d.get('beforeCross'), ensure_ascii=False))
            print('   横切 after :', json.dumps(d.get('afterCross'), ensure_ascii=False))
            try:
                shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
                p = os.path.join(OUT, 'selected-zoom-%dx.png' % zoom)
                os.makedirs(OUT, exist_ok=True)
                open(p, 'wb').write(base64.b64decode(shot['data']))
                print('   shot ->', p)
            except Exception as e:
                print('   shot failed:', e)
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
