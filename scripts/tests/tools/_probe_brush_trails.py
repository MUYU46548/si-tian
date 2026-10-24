#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 2 件续（高度笔 / 地形笔接 L2 笔迹层）的验收探针（2026-10-24）。

判据（判据是**像素 + 拖动中截图**，不是读代码）：
  ① 拖动中看得见笔迹：截图留档（人眼确认）+ 拖动中亮像素/差异像素有量
  ② 松手后笔迹消失且**不留鬼影**：松手取校验和 → 手动 render() 再取 → 必须完全相同
  ③ 数据真的变了（高度和 / 地形格数）
  ④ 拖动密度不掉：10s 连拖帧统计（基线 §二A：高度笔 30s p95 19.2 / 1 帧 >50）

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_brush_trails.py
"""
import base64
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for            # noqa: E402
from lib.helpers import open_harness_project  # noqa: E402
import run_tests as RT                       # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
READY = "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')"

ENTER = r"""
(() => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const planetId = Object.keys(s.mapData || {})[0];
  if (!planetId) return JSON.stringify({ __err__: '没有已载入的行星地图' });
  s.focusEntityOnCanvas(planetId);
  return JSON.stringify({ planetId, view: s.viewLevel });
})()
"""

SETUP = r"""
(() => {
  const pm = """ + PM + r""";
  const cvs = document.querySelector('.planet-map-container .canvas-wrapper canvas');
  pm.editMode = true;
  pm.interactionMode = window.MODE;
  pm.planetHeightBrush.brushRadius.value = 60;
  pm.planetHeightBrush.brushStrength.value = 4;
  pm.renderer.requestRender();
  window.__BT = {
    cvs,
    rect: () => cvs.getBoundingClientRect(),
    mk: (t, x, y) => {
      const r = cvs.getBoundingClientRect();
      return new MouseEvent(t, {
        clientX: r.left + x, clientY: r.top + y, button: 0,
        buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
      });
    },
    checksum: null,
  };
  // 校验和（整画布抽样）
  window.__BT.checksum = () => {
    const cx = cvs.getContext('2d');
    const d = cx.getImageData(0, 0, cvs.width, cvs.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4 * 37) sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
    return sum;
  };
  return JSON.stringify({ mode: pm.interactionMode, edit: !!pm.editMode });
})()
"""

# 拖动：按下 → 24 步（分帧）→ 停在半空（不松手）
DRAG_HOLD = r"""
(() => {
  const T = window.__BT;
  const r = T.rect();
  const y = Math.round(r.height * 0.5);
  const x0 = Math.round(r.width * 0.30), x1 = Math.round(r.width * 0.70);
  window.__BT.geom = { y, x0, x1 };
  T.cvs.dispatchEvent(T.mk('mousedown', x0, y));
  return new Promise((resolve) => {
    let x = x0;
    const step = () => {
      x += Math.max(6, Math.round((x1 - x0) / 24));
      T.cvs.dispatchEvent(T.mk('mousemove', Math.min(x, x1), y));
      if (x < x1) requestAnimationFrame(step);
      else resolve(JSON.stringify({ at: Math.min(x, x1) }));
    };
    requestAnimationFrame(step);
  });
})()
"""

RELEASE = "(() => { const T = window.__BT; T.cvs.dispatchEvent(T.mk('mouseup', T.geom.x1, T.geom.y)); return 'ok'; })()"

# 拖动中/松手后：笔迹路径长度 + 数据是否真变 + 校验和
STATE = r"""
(() => {
  const pm = """ + PM + r""";
  const md = pm.currentMapData || {};
  const hm = md.heightmap || {};
  let hSum = 0;
  if (hm.h && hm.h.length) for (let i = 0; i < hm.h.length; i += 7) hSum += hm.h[i];
  let gridPainted = 0;
  let gridSum = 0;
  // ⚠️ 拖动中必须读**组件本地网格**（terrainCanvasBrush.terrainGrid）：store 里那份要等松手
  //    `saveTerrainGrid()` 才回写 —— 读 store 会得到"涂了但没变"的假读数（本轮第一版就栽在这）。
  const g = (pm.terrainCanvasBrush && pm.terrainCanvasBrush.terrainGrid && pm.terrainCanvasBrush.terrainGrid.value)
    || md.terrainGrid;
  if (g && g.length) {
    for (let i = 0; i < g.length; i += 3) {
      gridSum = (gridSum * 31 + (g[i] || 0)) >>> 0;
      if (g[i] !== 255 && g[i] !== 0) gridPainted += 1;
    }
  }
  return JSON.stringify({
    mode: pm.interactionMode,
    pathHeight: (pm.planetHeightBrush.strokePath.value || []).length,
    pathTerrain: (pm.terrainCanvasBrush.strokePath.value || []).length,
    hSum: +hSum.toFixed(1),
    gridPainted,
    gridSum,
    checksum: window.__BT.checksum(),
  });
})()
"""

FORCE_RENDER = "(() => { const pm = " + PM + "; pm.renderer.markFullRedraw(); return 'ok'; })()"

# 10s 连拖（松手统计帧）
PERF = r"""
(() => new Promise((resolve) => {
  const T = window.__BT;
  const r = T.rect();
  const y = Math.round(r.height * 0.42);
  const x0 = Math.round(r.width * 0.28), x1 = Math.round(r.width * 0.72);
  const deltas = [];
  let last = performance.now(), stop = false, x = x0, dir = 1, evs = 0, handler = 0;
  T.cvs.dispatchEvent(T.mk('mousedown', x, y));
  const loop = () => {
    const now = performance.now();
    deltas.push(now - last); last = now;
    evs += 1;
    x += 7 * dir;
    if (x > x1 || x < x0) { dir = -dir; x = Math.min(x1, Math.max(x0, x)); }
    const t0 = performance.now();
    T.cvs.dispatchEvent(T.mk('mousemove', x, y + Math.sin(evs / 9) * 30));
    handler += performance.now() - t0;
    if (!stop) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setTimeout(() => {
    stop = true;
    T.cvs.dispatchEvent(T.mk('mouseup', x, y));
    const d = deltas.slice(1).sort((a, b) => a - b);
    const q = (p) => (d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : -1);
    resolve(JSON.stringify({
      frames: d.length, p50: q(0.5), p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : -1,
      over33: d.filter(v => v > 33).length, over50: d.filter(v => v > 50).length,
      handlerMsPerEvent: +(handler / Math.max(1, evs)).toFixed(2),
    }));
  }, 10000);
}))()
"""


def j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    if isinstance(v, str) and v.startswith(('{', '[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def phase(cdp, mode, png_name, fails):
    cdp.eval("window.MODE = '%s'; 'ok'" % mode)
    print('setup:', j(cdp, SETUP))
    time.sleep(0.6)
    base = j(cdp, STATE)
    print(f'[{mode}] 拖动前:', base)

    print(f'[{mode}] drag:', j(cdp, DRAG_HOLD))
    time.sleep(0.5)
    during = j(cdp, STATE)
    print(f'[{mode}] 拖动中:', during)
    shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
    out = os.path.join(ROOT, png_name)
    with open(out, 'wb') as f:
        f.write(base64.b64decode(shot['data']))
    print(f'[{mode}] 拖动中截图 ->', os.path.relpath(out, ROOT))

    j(cdp, RELEASE)
    time.sleep(0.7)
    after = j(cdp, STATE)
    j(cdp, FORCE_RENDER)
    time.sleep(0.4)
    forced = j(cdp, STATE)
    print(f'[{mode}] 松手后:', after, '| 强制重绘后 checksum:', forced['checksum'])

    perf = j(cdp, PERF)
    print(f'[{mode}] 10s 连拖:', perf)

    path_len = during['pathHeight'] if mode == 'height' else during['pathTerrain']
    if path_len < 3:
        fails.append(f'[{mode}] 拖动中没攒出笔迹路径（{path_len} 点）')
    if mode == 'height':
        if abs(during['hSum'] - base['hSum']) < 1:
            fails.append(f'[{mode}] 高度没变（{base["hSum"]} → {during["hSum"]}）—— 读数无效')
    else:
        if during['gridSum'] == base['gridSum']:
            fails.append(f'[{mode}] 地形格没变（gridSum {base["gridSum"]} == {during["gridSum"]}）—— 读数无效')
    # 松手后：路径清空 + 没有鬼影（强制重绘校验和不变）
    if (after['pathHeight'] if mode == 'height' else after['pathTerrain']) != 0:
        fails.append(f'[{mode}] 松手后笔迹路径没清（{after["pathHeight"]}/{after["pathTerrain"]}）')
    if after['checksum'] != forced['checksum']:
        fails.append(f'[{mode}] 松手后画面不是最新的（强制重绘校验和变了）—— 轨迹留了鬼影')
    if perf.get('over50', 99) > 2:
        fails.append(f'[{mode}] 笔迹层把拖动拖瘦了（10s 里 {perf.get("over50")} 帧 >50ms）')
    if perf.get('p95', 99) > 30:
        fails.append(f'[{mode}] p95 {perf.get("p95")}ms > 30ms')
    return {'mode': mode, 'path_during': path_len, 'perf': perf,
            'data_before': {k: base[k] for k in ('hSum', 'gridPainted')},
            'data_during': {k: during[k] for k in ('hSum', 'gridPainted')},
            'no_ghost': after['checksum'] == forced['checksum']}


def main():
    cdp = CDP()
    try:
        cdp.ws.settimeout(180)
        cdp.navigate('http://localhost:5180/?bt=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?bt=%d' % (int(time.time()) + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        open_harness_project(cdp)
        print('enter:', j(cdp, ENTER))
        wait_for(cdp, READY, timeout=40, desc='行星画布')
        time.sleep(1.2)

        fails = []
        out = {}
        out['height'] = phase(cdp, 'height', '.lab-height-trail.png', fails)
        time.sleep(0.6)
        out['terrain'] = phase(cdp, 'terrain', '.lab-terrain-trail.png', fails)

        print('\n=== 判据 ===')
        print(json.dumps({'phases': out, 'fails': fails}, ensure_ascii=False, indent=1))
        return 0 if not fails else 1
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
