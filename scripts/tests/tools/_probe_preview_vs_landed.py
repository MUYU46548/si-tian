#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Measure the gap between the river PREVIEW shape and the LANDED shape (item: 预览=落库).

For a stroke drawn with the river tool:
  preview = smoothWhileDrawing(draft, 1, 18)   (what the user sees while dragging)
  landed  = fitPolylineToCount + smoothRiverNodes(draft)   (what finishRiverDraft writes)
This probe computes, for each preview vertex, the distance to the landed polyline (and vice
versa), so the "preview == landed" claim becomes a NUMBER instead of an impression.
Usage (lab must be up): python scripts/tests/tools/_probe_preview_vs_landed.py
"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

BUST = int(time.time())

JS = r"""
(async () => {
  const s = (document.querySelector('#app').__vue_app__._instance.setupState).store;
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const PS = await import('/src/utils/polylineSmooth.js');
  const sc1 = sc();
  const KEY = 'previewdiag';
  if (!s.baseMaps[KEY]) s.addBaseMap(KEY, { name: KEY });
  sc1.baseMapKey = KEY;
  if (typeof sc1.onBaseMapChange === 'function') await sc1.onBaseMapChange();
  await new Promise(r => setTimeout(r, 400));
  const cv = sc1.canvas;
  const rect = cv.getBoundingClientRect();
  const tl = sc1.screenToWorld(0, 0);
  const br = sc1.screenToWorld(cv.clientWidth, cv.clientHeight);

  // 一条"像河"的笔迹：起点在左上、途中有两个弯、终点在右下（走屏幕里的中间区域）
  const raw = [];
  const N = 140;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = tl.x + (br.x - tl.x) * (0.22 + 0.56 * t);
    const y = tl.y + (br.y - tl.y) * (0.18 + 0.64 * t + 0.10 * Math.sin(t * Math.PI * 2.2));
    raw.push({ x, y });
  }
  // 预览：与组件里那一行**同一份实现**
  const preview = PS.smoothWhileDrawing(raw, 1, 18);
  // 落库口径：与 finishRiverDraft 同一串调用
  const pxPerWorld = 1;   // 1× 缩放
  const RIVER_TRACE_MIN_STEP_PX = 10, RIVER_NODE_SPACING_PX = 30, RIVER_MIN_NODES = 6, RIVER_MAX_NODES = 72;
  const dec = PS.decimatePolyline(raw.map(p => ({ x: p.x, y: p.y })), RIVER_TRACE_MIN_STEP_PX / pxPerWorld);
  const len = (() => { let a = 0; for (let i = 0; i + 1 < dec.length; i++) a += Math.hypot(dec[i+1].x-dec[i].x, dec[i+1].y-dec[i].y); return a; })();
  const want = Math.max(RIVER_MIN_NODES, Math.min(RIVER_MAX_NODES, Math.round(len / (RIVER_NODE_SPACING_PX / pxPerWorld))));
  const fitted = PS.fitPolylineToCount(dec, want, { minCount: RIVER_MIN_NODES, maxCount: RIVER_MAX_NODES });
  const landed = fitted.length >= 3 ? PS.smoothRiverNodes(fitted, 1) : fitted;

  const distToPolyline = (p, pts) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      const qx = a.x + dx * t, qy = a.y + dy * t;
      best = Math.min(best, Math.hypot(p.x - qx, p.y - qy));
    }
    return best;
  };
  const gapsA = preview.map(p => distToPolyline(p, landed));
  const gapsB = landed.map(p => distToPolyline(p, preview));
  const stat = (a) => {
    const s2 = a.slice().sort((x, y) => x - y);
    return { n: s2.length, p50: +s2[Math.floor(s2.length * 0.5)].toFixed(2), p90: +s2[Math.floor(s2.length * 0.9)].toFixed(2), max: +s2[s2.length - 1].toFixed(2) };
  };
  return JSON.stringify({
    rawPts: raw.length, previewPts: preview.length, decimated: dec.length, targetNodes: want,
    landedPts: landed.length,
    previewToLanded: stat(gapsA), landedToPreview: stat(gapsB),
    strokeLengthWorld: +len.toFixed(1),
    inView: raw.every(p => p.x > tl.x && p.x < br.x && p.y > tl.y && p.y < br.y),
    fails: [],
  });
})()"""


def main():
    cdp = CDP()
    try:
        cdp.navigate('http://localhost:5180/?prev=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='boot')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?prev=%d' % (BUST + 1))   # 硬重载（防 HMR 旧闭包）
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='hard-reload')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?prev=%d' % BUST)
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
        print(cdp.eval(JS))
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
