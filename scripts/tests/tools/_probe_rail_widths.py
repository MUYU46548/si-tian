#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Instrumentation for the "hollow rails" river rendering (feedback item 2).

Hypothesis being tested (and its falsifier):
  H1: the river WATER width is kept at a fixed *screen* width while the BANK is stroked
      with `waterPx + bankPx` in *screen* pixels -> at high zoom the water stays ~1-2 px
      while the terrain grows, so the river looks like two dark rails with no water in
      between. FALSIFIER: if measured water px grows with zoom, H1 is wrong.
  H2: the water colour is being drawn but covered by something drawn afterwards
      (polygons / borders / labels). FALSIFIER: measure water pixels with the layers
      toggled off one at a time.

Method: patch `CanvasRenderingContext2D.prototype.stroke` to record every
`lineWidth` + `strokeStyle` + whether the path is short (an individual river segment),
then zoom 1x..16x over one hand-drawn river and read the pixel cross-section.
Usage (lab must be up): python scripts/tests/tools/_probe_rail_widths.py
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

SETUP = r"""
(async () => {
  const s = (document.querySelector('#app').__vue_app__._instance.setupState).store;
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const AP = await import('/src/utils/azgaar-parser.js');
  const text = await (await fetch('/__diag_desite.map')).text();
  const parsed = AP.parseMapFile(text);
  const NAME = 'raildiag';
  const json = AP.buildScenariosJson(parsed, NAME, 'diag');
  s.importFromScenariosJson(json);
  await new Promise(r => setTimeout(r, 2200));
  const sm = sc();
  sm.baseMapKey = NAME;
  if (typeof sm.onBaseMapChange === 'function') await sm.onBaseMapChange();
  await new Promise(r => setTimeout(r, 900));

  // ── 用**产品写口**画一条手画河（不点 UI：河道工具的鼠标链在 test_109 已覆盖）──
  const bm = s.baseMaps[NAME];
  // ⚠️ 底图省份的 points 是**成对数组** `[[x,y],…]`（不是 {x,y}）——
  //    第一版按 q.x 读，全得到 undefined → minY/maxY = Infinity → 点全 NaN → 写口拒绝。
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const px2 = (q) => Array.isArray(q) ? { x: q[0], y: q[1] } : { x: q.x, y: q.y };
  for (const p of (bm.terrain || [])) {
    if (p.kind === 'sea') continue;
    for (const q0 of (p.points || [])) {
      const q = px2(q0);
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const pts = [];
  for (let i = 0; i <= 12; i++) pts.push({ x: cx, y: minY + (maxY - minY) * (i / 12) });
  const rid = 'river_diagstraight';
  if ((bm.rivers || []).some(r => r.id === rid)) s.removeBaseMapRiver(NAME, rid);
  const add = s.addBaseMapRiver(NAME, { id: rid, name: 'diag', points: pts, width: 3.5 });
  await new Promise(r => setTimeout(r, 500));
  return JSON.stringify({
    baseMap: NAME, cx, cy, minY, maxY, add,
    rivers: (s.baseMaps[NAME].rivers || []).length,
    handRivers: (s.baseMaps[NAME].rivers || []).filter(r => String(r.id).indexOf('river_') === 0).length,
    fails: [],
  });
})()"""

# Patch the 2D context to log stroke widths, then zoom over the middle of the drawn river.
INSTRUMENT = r"""
(async () => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const cv = sm.canvas;
  if (!window.__strokeLog) {
    window.__strokeLog = [];
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.stroke;
    proto.stroke = function (...a) {
      try {
        if (this.canvas === cv) {
          const t = this.getTransform();
          window.__strokeLog.push({ c: String(this.strokeStyle), w: Math.round(this.lineWidth * 1000) / 1000,
                                    cap: this.lineCap, alpha: Math.round(this.globalAlpha * 100) / 100,
                                    ta: Math.round(t.a * 1000) / 1000, td: Math.round(t.d * 1000) / 1000,
                                    camScale: sm.cameraScale,
                                    devPx: Math.round(this.lineWidth * t.a * 100) / 100 });
        }
      } catch (e) {}
      return orig.apply(this, a);
    };
    window.__strokeOrig = orig;
  }
  return 'ok';
})()"""

CANVAS_INFO = r"""
(() => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const cv = sm.canvas;
  const r = cv.getBoundingClientRect();
  const cs = getComputedStyle(cv);
  return JSON.stringify({
    canvas: { w: cv.width, h: cv.height, clientW: cv.clientWidth, clientH: cv.clientHeight,
              rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
              cssW: cs.width, cssH: cs.height, dpr: devicePixelRatio },
    wrapper: (() => { const w = document.querySelector('.scenario-canvas-wrap');
      const wr = w.getBoundingClientRect();
      return { rect: { x: Math.round(wr.x), y: Math.round(wr.y), w: Math.round(wr.width), h: Math.round(wr.height) },
               scrollW: w.scrollWidth, scrollH: w.scrollHeight }; })(),
    cam: { scale: sm.cameraScale, x: sm.cameraX, y: sm.cameraY },
    fails: [],
  });
})()"""

# 关掉所有别的图层，只留河 —— 直接判"没有水"到底是"没画"还是"被盖"
ISOLATE = r"""
(async () => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const log = {};
  const set = (k, v) => { try { sm[k] = v; log[k] = sm[k]; } catch (e) { log[k] = 'ERR ' + e; } };
  const keys = ['showRivers', 'showRiverBase', 'showRiverAuto', 'showBorders', 'showBurgs', 'showLabels',
                'showPolityLabels', 'showRoutes', 'terrainShade', 'colorMode', 'rasterLayer', 'riverSource'];
  const before = {}; for (const k of keys) before[k] = sm[k];
  set('showRivers', true);
  set('showRiverBase', true);
  set('showRiverAuto', false);
  set('showBorders', false); set('showBurgs', false); set('showLabels', false);
  set('showPolityLabels', false); set('showRoutes', false); set('terrainShade', false);
  sm.cameraScale = 16;
  const river = (sm.baseMap.rivers || []).find(r => String(r.id).indexOf('river_diagstraight') === 0);
  const mid = river.points[Math.floor(river.points.length / 2)];
  const cv = sm.canvas;
  sm.cameraX = cv.clientWidth / 2 - mid.x * sm.cameraScale;
  sm.cameraY = cv.clientHeight / 2 - mid.y * sm.cameraScale;
  window.__strokeLog.length = 0;
  if (typeof sm.render === 'function') sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 250));
  window.__strokeLog.length = 0;
  if (typeof sm.render === 'function') sm.render();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const lw = Array.from(new Set((window.__strokeLog || []).map(e => e.w))).sort((a, b) => a - b);
  const widths = (() => { try { return sm.riverWidthsFor(river, 13); } catch (e) { return 'ERR ' + e; } })();
  for (const k of keys) { try { sm[k] = before[k]; } catch (e) {} }
  if (typeof sm.render === 'function') sm.render();
  return JSON.stringify({
    camScaleReadback: sm.cameraScale, mid, canvasClientW: cv.clientWidth, canvasClientH: cv.clientHeight,
    distinctLineWidths: lw, startEndWidths: Array.isArray(widths) ? [widths[0], widths[widths.length - 1]] : widths,
    strokeCount: (window.__strokeLog || []).length,
    log, fails: [],
  });
})()"""

MEASURE = r"""
(async () => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const cv = sm.canvas;
  const g = cv.getContext('2d');
  const bm = sm.baseMap;
  const river = (bm.rivers || []).find(r => String(r.id).indexOf('river_diagstraight') === 0);
  if (!river) return JSON.stringify({ fails: ['diag river missing'], note: 'no-river' });
  const pts = river.points;
  const mid = pts[Math.floor(pts.length / 2)];
  const out = { riverWidth: river.width, canvasPx: { w: cv.width, h: cv.height }, zooms: [] };
  const origWidth = river.width;

  const runAt = async (z, widthOverride) => {
    river.width = widthOverride == null ? origWidth : widthOverride;
    sm.cameraScale = z;
    // 用**预留记号**：先记下想要的相机，读完 w2s 就知道写进没写进（见下发结果里的 camWanted/camActual）。
    const wantedScale = sm.cameraScale;
    let midScreen = { x: sm.cameraX + mid.x * z, y: sm.cameraY + mid.y * z };
    if (typeof sm.worldToScreen === 'function') {
      const p = sm.worldToScreen(mid.x, mid.y);
      if (p && Number.isFinite(p.x)) midScreen = p;   // 组件自己的变换，权威
    }
    // 采样点由**组件自己算出来的屏幕坐标**决定（不再自己猜 cameraX/Y 有没有写进去）
    const sx = Math.round(midScreen.x) + 200;   // 画布在页面里 x 偏移 200 → 截图坐标系
    const y = Math.round(midScreen.y) + 247;
    if (typeof sm.render === 'function') sm.render();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 200));
    window.__strokeLog.length = 0;
    if (typeof sm.render === 'function') sm.render();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // 在**页面坐标系**上截屏采样：先全屏截，再用 Python 侧量（这里只回到画布坐标）
    const cvX = Math.round(midScreen.x), cvY = Math.round(midScreen.y);
    const x0 = Math.max(0, cvX - 200), x1 = Math.min(cv.width - 1, cvX + 200);
    if (cvY < 0 || cvY >= cv.height) return { z, widthOverride, note: 'off-screen', cvY, camWanted: wantedScale,
                                              camActual: sm.cameraScale, midScreen };
    const img = g.getImageData(x0, cvY, x1 - x0, 1).data;
    const runs = []; let prev = null;
    for (let i = 0; i < (x1 - x0); i++) {
      const r = img[i * 4], gg = img[i * 4 + 1], b = img[i * 4 + 2];
      const hex = '#' + [r, gg, b].map(v => v.toString(16).padStart(2, '0')).join('');
      if (prev && prev.hex === hex) prev.n++; else { prev = { hex, n: 1, x: x0 + i }; runs.push(prev); }
    }
    const d = (hex, ref) => { const h = (s) => parseInt(s, 16);
      return Math.hypot(h(hex.slice(1,3)) - h(ref.slice(1,3)), h(hex.slice(3,5)) - h(ref.slice(3,5)), h(hex.slice(5,7)) - h(ref.slice(5,7))); };
    const log = window.__strokeLog || [];
    return {
      z, widthOverride, cvY, x0, x1, camWanted: wantedScale, camActual: sm.cameraScale, midScreen,
      pageX: sx, pageY: y,
      waterPx: runs.filter(r => d(r.hex, '#5d97bb') < 45).reduce((a, r) => a + r.n, 0),
      bankPx: runs.filter(r => d(r.hex, '#3f6478') < 45).reduce((a, r) => a + r.n, 0),
      wideStrokes: log.filter(e => e.devPx >= 2).map(e => e.c + ' w' + e.w + ' ta' + e.ta + ' cam' + e.camScale + '=' + e.devPx + 'px')
                      .filter((v, i, a) => a.indexOf(v) === i).slice(0, 10),
      // 手画河的签名：岸色行紧跟着水色行（`drawCurvedRiver` 里先岸后水）
      bankWaterPairs: (() => {
        const out = [];
        for (let i = 0; i + 1 < log.length; i++) {
          if (log[i].c === '#3f6478' && log[i + 1].c === '#5d97bb') {
            out.push({ bankW: log[i].w, waterW: log[i + 1].w, ta: log[i].ta, cam: log[i].camScale });
            if (out.length >= 6) break;
          }
        }
        return out;
      })(),
      maxDevPx: log.reduce((a, e) => Math.max(a, e.devPx), 0),
      maxTa: log.reduce((a, e) => Math.max(a, e.ta), 0),
      runs: runs.slice(0, 24),
    };
  };

  // ① 现状（数据 width=3.5）：water/bank 的真实屏幕像素随缩放怎么变
  for (const z of [1, 2, 4, 8, 16]) out.zooms.push(await runAt(z, null));
  // ② 把 width 放大 10 倍（37.5 世界单位）：如果屏幕宽度跟着涨 10 倍，说明"世界单位 → 屏幕"
  //    的换算是对的、只是数值口径偏小；如果**几乎不变**，说明画的时候压根没按世界单位走。
  out.wide = [];
  for (const z of [1, 4, 16]) out.wide.push(await runAt(z, 35));
  river.width = origWidth;
  // ③ 隔离：把**导入河**全藏起来，只留手画河。这一步直接回答"我量到的那 6~8px 到底是谁"。
  //    （第一版把两者一起量的结果自相矛盾：改 width ×10 屏幕宽度纹丝不动 —— 那说明
  //      量到的是**导入河**那条同色的 1 格细线，不是手画河。）
  out.isolated = [];
  const savedRivers = bm.rivers;
  for (const z of [1, 4, 16]) {
    bm.rivers = savedRivers.filter(r => String(r.id).indexOf('river_diagstraight') === 0);
    out.isolated.push(await runAt(z, null));
  }
  bm.rivers = savedRivers;
  if (typeof sm.render === 'function') sm.render();
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
        # ⚠️ 改完源码**必须硬重载**：Vite 的 HMR 就地换模块时，`<script setup>` 里
        #    已经闭包捕获了旧函数的那些回调（如 drawRiverPaths → riverWidthsFor）
        #    仍指向旧实现 —— 本轮实测"改了三处、量出来的数字一位不动"就是这个原因。
        cdp.navigate('http://localhost:5180/?lab=%d&reload=1' % (BUST + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?lab=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload2')
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=40, desc='data')
        print('project:', open_harness_project(cdp)[0])
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor')
        time.sleep(0.8)

        print('setup ->', cdp.eval(SETUP))
        print('instr ->', cdp.eval(INSTRUMENT))
        print('canvas ->', cdp.eval(CANVAS_INFO))
        print('isolate ->', cdp.eval(ISOLATE))
        print('modsrc ->', cdp.eval(r"""
(async () => {
  const sc = () => document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
  const sm = sc();
  const bm = sm.baseMap;
  const river = (bm.rivers || []).find(r => String(r.id).indexOf('river_diagstraight') === 0);
  const mid = river.points[Math.floor(river.points.length / 2)];
  const cv = sm.canvas;
  const out = [];
  for (const z of [1, 16]) {
    sm.cameraScale = z;
    sm.cameraX = cv.clientWidth / 2 - mid.x * z;
    sm.cameraY = cv.clientHeight / 2 - mid.y * z;
    window.__riverDbg = [];
    if (sm.render) sm.render();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 200));
    window.__riverDbg = [];
    if (sm.render) sm.render();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.push({ z, calls: (window.__riverDbg || []).slice(0, 6) });
  }
  return JSON.stringify({ riverDataWidth: river.width, camNow: sm.cameraScale, out, fails: [] });
})()"""))
        print('skia ->', cdp.eval(r"""
(() => {
  // 独立小画布：模拟"世界坐标 + ctx.scale(cameraScale)"的两种可能画法，量真实像素宽度。
  // 目的：判定 at-16x 的 8px 到底是 (a) 数学要求 8.4px 但被 Skia 夹住，还是 (b) 我们真的画了 0.52px。
  const mk = () => { const c = document.createElement('canvas'); c.width = 400; c.height = 60; return c; };
  const measure = (draw) => {
    const c = mk(); const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 60);
    g.save(); draw(g); g.restore();
    const d = g.getImageData(0, 30, 400, 1).data;
    let n = 0; for (let i = 0; i < 400; i++) if (d[i * 4] < 250 || d[i * 4 + 1] < 250 || d[i * 4 + 2] < 250) n++;
    return n;
  };
  const out = {};
  // (a) 世界单位 8.4 + scale(16)：数学要求 8.4*16 = 134 设备像素
  out.world8_4_scaled16 = measure((g) => {
    g.scale(16, 16); g.strokeStyle = '#5d97bb'; g.lineWidth = 8.4; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(12, 1); g.lineTo(12.001, 2); g.stroke();
  });
  // (b) 已经换算成设备单位 0.52（= 8.4/16）在 scale(16) 下：
  out.device0_52_scaled16 = measure((g) => {
    g.scale(16, 16); g.strokeStyle = '#5d97bb'; g.lineWidth = 0.52; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(12, 1); g.lineTo(12.001, 2); g.stroke();
  });
  // (c) 不缩放、直接 8.4 设备像素（1x 的理论值）
  out.plain8_4 = measure((g) => {
    g.strokeStyle = '#5d97bb'; g.lineWidth = 8.4; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(200, 20); g.lineTo(200, 40); g.stroke();
  });
  // (d) 缩放 16 但线宽极大（200 世界单位 = 3200 设备像素）：看 Skia 有没有夹
  out.world200_scaled16 = measure((g) => {
    g.scale(16, 16); g.strokeStyle = '#5d97bb'; g.lineWidth = 200; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(12, 1); g.lineTo(12.001, 2); g.stroke();
  });
  return JSON.stringify(Object.assign(out, { fails: [] }));
})()"""))
        r = cdp.eval(MEASURE)
        data = json.loads(r) if isinstance(r, str) else r
        with open(os.path.join(OUT, 'rails.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print('riverWidth=%s canvas=%s' % (data.get('riverWidth'), data.get('canvasPx')))
        for z in data.get('zooms') or []:
            if z.get('note'):
                print('== zoom %s  %s (y=%s)' % (z['z'], z['note'], z.get('y')))
                continue
            print('== zoom %-3s 水像素=%-4s 岸像素=%-4s maxDevPx=%-7s maxTa=%-6s 宽描边=%s'
                  % (z['z'], z['waterPx'], z['bankPx'], z.get('maxDevPx'), z.get('maxTa'),
                     json.dumps(z.get('wideStrokes'), ensure_ascii=False)))
        for z in data.get('wide') or []:
            print('== WIDE(width=%s) zoom %-3s 水像素=%-4s 岸像素=%-4s'
                  % (z.get('widthOverride'), z['z'], z.get('waterPx'), z.get('bankPx')))
        for z in data.get('isolated') or []:
            print('== 只留手画河 zoom %-3s 水像素=%-4s 岸像素=%-4s 岸/水配对=%s'
                  % (z['z'], z.get('waterPx'), z.get('bankPx'),
                     json.dumps(z.get('bankWaterPairs'), ensure_ascii=False)))

        for z in (1, 4, 16):
            cdp.eval("""(async () => {
              const sm = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;
              const cv = sm.canvas;
              const river = (sm.baseMap.rivers || []).find(r => String(r.id).indexOf('river_diagstraight') === 0);
              const mid = river.points[Math.floor(river.points.length / 2)];
              if (sm.setTool) sm.setTool('river');
              sm.showMinimap = false;
              sm.cameraScale = %d;
              sm.cameraX = cv.clientWidth / 2 - mid.x * %d;
              sm.cameraY = cv.clientHeight / 2 - mid.y * %d;
              if (typeof sm.render === 'function') sm.render();
              await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
              return 'ok';
            })()""" % (z, z, z))
            time.sleep(0.45)
            shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
            p = os.path.join(OUT, 'handriver-fixed-zoom-%dx.png' % z)
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
