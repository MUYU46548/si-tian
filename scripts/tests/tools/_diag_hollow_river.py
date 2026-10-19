#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Diagnose the "hollow rails" river rendering at high zoom (feedback item 2).

Observation to explain (user): "rivers look fine at small zoom, but when zoomed in they
become hollow rails -- the water fill in the middle is gone, only the two rails are left".

Method (no guessing): import the real `docs/mockups/desite.map` through the product import
chain, turn the AUTO river network on, center one river run at 3x/6x zoom, then
  (a) save a PNG for human inspection, and
  (b) read the actual canvas pixels along a scan line across the river, run-length encoded,
      with the dominant background colour marked -- that shows exactly where the water is.
Usage (lab must be up): python scripts/tests/tools/_diag_hollow_river.py
"""
import base64
import json
import os
import shutil
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

PUBLIC_DIR = os.path.join(ROOT, 'src', 'renderer', 'public')
TMP_MAP = os.path.join(PUBLIC_DIR, '__diag_desite.map')
SRC_MAP = os.path.join(ROOT, 'docs', 'mockups', 'desite.map')
OUT = os.path.join(ROOT, 'docs', 'assets', 'river-hollow-20261018')
BUST = int(time.time())

IMPORT_JS = r"""
(async () => {
  const s = (%s).store;
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const AP = await import('/src/utils/azgaar-parser.js');
  const text = await (await fetch('/__diag_desite.map')).text();
  const parsed = AP.parseMapFile(text);
  const NAME = 'diagdesite';
  const json = AP.buildScenariosJson(parsed, NAME, 'diag');
  const bundle = json.baseMaps[NAME];
  s.importFromScenariosJson(json);
  await new Promise(r => setTimeout(r, 2500));
  const sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 1200));
  return JSON.stringify({
    provinces: (bundle.terrain || []).length,
    rivers: (bundle.rivers || []).length,
    hCells: (bundle.heightmap && bundle.heightmap.h || []).length,
    fails: [],
  });
})()
""" % "(document.querySelector('#app').__vue_app__._instance.setupState)"

# Turn on auto rivers via the component's own product function, then report what it thinks.
AUTO_JS = r"""
(async () => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  // The toolbar button lives inside the "more" flyout, so call the product function
  // the button itself calls -- same code path, no UI guessing.
  const t0 = Date.now();
  let err = null;
  try {
    const r = sm.generateAndShowRivers();
    if (r && typeof r.then === 'function') await r;
  } catch (e) { err = String(e); }
  const ms = Date.now() - t0;
  await new Promise(r => setTimeout(r, 800));
  const sm2 = sc();
  return JSON.stringify({
    ms, err,
    autoRivers: (sm2.autoRivers || []).length,
    autoSegments: (sm2.autoRiverSegments || []).length,
    riverSource: sm2.riverSource,
    showRiverAuto: sm2.showRiverAuto,
    showRiverBase: sm2.showRiverBase,
    maxFlow: sm2.autoRiverMaxFlow,
    status: sm2.statusMsg || sm2.statusText || null,
    fails: [],
  });
})()"""

# For every sampled zoom: keep the SAME view (centered on the picked run) and scan a
# perpendicular cross-section of the river, so the run-length output can be read directly.
SCAN = r"""
(async () => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const cv = sm.canvas;
  const g = cv.getContext('2d');
  const segs = sm.autoRiverSegments || [];
  if (!segs.length) return JSON.stringify({ fails: ['no auto segments'], note: 'no-segments' });

  // 选一段"周围有河"的段：取中点落在其它段密集区的那个
  const key = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
  const dens = new Map();
  for (const s of segs) {
    for (let k = -1; k <= 1; k++) for (let m = -1; m <= 1; m++) {
      const kk = key(s.x0 + k * 14.4, s.y0 + m * 14.4);
      dens.set(kk, (dens.get(kk) || 0) + 1);
    }
  }
  let best = null, bestScore = -1;
  for (const s of segs) {
    const sc2 = dens.get(key(s.x0, s.y0)) || 1;
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const score = sc2 * len + (s.flow || 1) * 3;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  const cxw = (best.x0 + best.x1) / 2, cyw = (best.y0 + best.y1) / 2;
  // 段的法线（横切方向）：跨河扫一条线就能看出"中间有没有水"
  const dx = best.x1 - best.x0, dy = best.y1 - best.y0;
  const L = Math.max(1e-6, Math.hypot(dx, dy));
  const nx = -dy / L, ny = dx / L;
  const out = { pick: { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1, flow: best.flow },
                normal: { nx, ny }, score: bestScore, zooms: [],
                counts: { autoRivers: (sm.autoRivers || []).length, segs: segs.length,
                          riverSource: sm.riverSource } };

  const px = (v) => v / Math.max(sm.cameraScale, 1e-6);
  for (const z of [1, 2, 4, 8]) {
    sm.cameraScale = z;
    sm.cameraX = cv.clientWidth / 2 - cxw * z;
    sm.cameraY = cv.clientHeight / 2 - cyw * z;
    if (typeof sm.render === 'function') sm.render();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 200));
    if (typeof sm.render === 'function') sm.render();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // 沿法线在世界空间取 ±6 个格（一格 = spacing），逐"屏幕像素"采一次
    const spacing = (sm.baseMap && sm.baseMap.heightmap && sm.baseMap.heightmap.grid
                     && sm.baseMap.heightmap.grid.spacing) || 14.4;
    const half = spacing * 3;
    const samples = Math.round(half * 2 * z);
    const centerS = { x: sm.cameraX + cxw * z, y: sm.cameraY + cyw * z };
    const runs = [];
    let prev = null;
    for (let i = 0; i <= samples; i++) {
      const t = -half + (i / Math.max(1, samples)) * half * 2;
      const wx = cxw + nx * t, wy = cyw + ny * t;
      const sx = Math.round(sm.cameraX + wx * z);
      const sy = Math.round(sm.cameraY + wy * z);
      if (sx < 0 || sy < 0 || sx >= cv.width || sy >= cv.height) { prev = null; continue; }
      const d = g.getImageData(sx, sy, 1, 1).data;
      const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      if (prev && prev.hex === hex) prev.n++;
      else { prev = { hex, n: 1, t: Math.round(t * 10) / 10 }; runs.push(prev); }
    }
    // 河色阈值：与 #5d97bb 的距离（欧氏）
    const isRiver = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return Math.hypot(r - 0x5d, gg - 0x97, b - 0xbb) < 70;
    };
    out.zooms.push({
      z, spacing, samples, centerS,
      cellPx: spacing * z,
      riverRuns: runs.filter((r) => isRiver(r.hex)).map((r) => ({ hex: r.hex, n: r.n, t: r.t })),
      runs: runs.slice(0, 60),
      waterPx: runs.filter((r) => isRiver(r.hex)).reduce((a, r) => a + r.n, 0),
      distinctColors: new Set(runs.map((r) => r.hex)).size,
    });
  }
  return JSON.stringify(out);
})()"""


def main():
    os.makedirs(OUT, exist_ok=True)
    shutil.copyfile(SRC_MAP, TMP_MAP)
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

        # enter the scenario editor
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor')
        time.sleep(0.8)

        print('import ->', cdp.eval(IMPORT_JS))
        cdp.eval("window.__diagAuto = null")
        auto = cdp.eval(AUTO_JS)
        print('auto ->', auto)
        try:
            names = cdp.eval("JSON.stringify(Array.from(document.querySelectorAll('button'))"
                             ".map(b => (b.textContent || '').trim()).filter(t => t && t.length < 16)"
                             ".slice(0, 60))")
            print('buttons:', names)
        except Exception as e:
            print('buttons?', e)

        r = cdp.eval(SCAN)
        try:
            data = json.loads(r) if isinstance(r, str) else r
        except Exception:
            data = {'raw': str(r)[:2000]}
        with open(os.path.join(OUT, 'scan.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        pick = data.get('pick') or {}
        print('pick:', json.dumps(pick, ensure_ascii=False))
        print('counts:', json.dumps(data.get('counts') or {}, ensure_ascii=False))
        for z in (data.get('zooms') or []):
            print('== zoom %s  cellPx=%.1f  水色像素=%s  不同色数=%s'
                  % (z.get('z'), z.get('cellPx') or 0, z.get('waterPx'), z.get('distinctColors')))
            print('   riverRuns:', json.dumps(z.get('riverRuns'), ensure_ascii=False))
            print('   runs:', json.dumps(z.get('runs'), ensure_ascii=False)[:600])

        # screenshots for human eyes: same view at each zoom
        for z in (1, 4, 8):
            cdp.eval("""(async () => {
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const cv = sm.canvas;
              const segs = sm.autoRiverSegments || [];
              window.__diagPick = window.__diagPick || (() => {
                const key = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
                const dens = new Map();
                for (const s of segs) for (let k = -1; k <= 1; k++) for (let m = -1; m <= 1; m++) {
                  const kk = key(s.x0 + k * 14.4, s.y0 + m * 14.4);
                  dens.set(kk, (dens.get(kk) || 0) + 1);
                }
                let best = null, bs = -1;
                for (const s of segs) {
                  const sc2 = dens.get(key(s.x0, s.y0)) || 1;
                  const score = sc2 * Math.hypot(s.x1 - s.x0, s.y1 - s.y0) + (s.flow || 1) * 3;
                  if (score > bs) { bs = score; best = s; }
                }
                return best;
              })();
              const b = window.__diagPick;
              const cxw = (b.x0 + b.x1) / 2, cyw = (b.y0 + b.y1) / 2;
              sm.cameraScale = %d;
              sm.cameraX = cv.clientWidth / 2 - cxw * %d;
              sm.cameraY = cv.clientHeight / 2 - cyw * %d;
              if (typeof sm.render === 'function') sm.render();
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
              return 'ok';
            })()""" % (z, z, z))
            time.sleep(0.4)
            shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
            p = os.path.join(OUT, 'zoom-%dx-centered.png' % z)
            open(p, 'wb').write(base64.b64decode(shot['data']))
            print('shot ->', p)
    finally:
        try:
            os.remove(TMP_MAP)
        except OSError:
            pass
        cdp.close()


if __name__ == '__main__':
    main()
