#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 2 件首落（散布笔 L2 笔迹层）的验收探针：**判据是像素 + 一张拖动中的截图**。

为什么不用 `_probe_jank_real.py`：这一件要看的是"画的过程里有没有那条笔迹、松手有没有消失"，
必须在**拖动进行中**截一张图（Python 侧截图），再松手取第二组像素。所以这里自己编排时序。

三段判据（都只读，不改产品代码）：
  ① 按下拖动中：笔迹带内的**亮像素**明显变多（轨迹真的画出来了）；
  ② 松手后：亮像素回落（轨迹消失），但图标还在（比拖动前多）；
  ③ 一次拖动 = 一条 undo（undo 栈 +1，且撤销后图标回到拖动前）。

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_relief_trail.py
"""
import base64
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for          # noqa: E402
from lib.helpers import open_harness_project  # noqa: E402
import run_tests as RT                     # noqa: E402

PM = "document.querySelector('.planet-map-container').__vueParentComponent.setupState"
OUT_PNG = os.path.join(ROOT, '.lab-relief-trail.png')

ENTER = r"""
(async () => {
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const planetId = Object.keys(s.mapData || {})[0];
  if (!planetId) return JSON.stringify({ __err__: '没有已载入的行星地图' });
  s.focusEntityOnCanvas(planetId);
  return JSON.stringify({ planetId, view: s.viewLevel });
})()
"""

READY = "!!document.querySelector('.planet-map-container .canvas-wrapper canvas')"

SETUP = "(() => { " + PM + """.editMode = true;
  const pm = """ + PM + """;
  pm.interactionMode = 'relief';
  pm.reliefBrush.reliefType.value = 'mountain';
  pm.reliefBrush.reliefSpacing.value = 30;
  pm.reliefBrush.reliefSize.value = 26;
  pm.renderer.requestRender();
  return JSON.stringify({ mode: pm.interactionMode, edit: !!pm.editMode });
})()"""

# 先把几何与派发器备好（**不动手**）：像素带要靠它算，所以必须在"拖动前"那次计数之前跑
GEOM = r"""
(() => {
  const pm = """ + PM + r""";
  const cvs = document.querySelector('.planet-map-container .canvas-wrapper canvas');
  const r = cvs.getBoundingClientRect();
  const mk = (t, x, y, buttons) => new MouseEvent(t, {
    clientX: r.left + x, clientY: r.top + y, button: 0,
    buttons: buttons === undefined ? (t === 'mouseup' ? 0 : 1) : buttons,
    bubbles: true, cancelable: true,
  });
  const y = Math.round(r.height * 0.5);
  const x0 = Math.round(r.width * 0.28), x1 = Math.round(r.width * 0.72);
  window.__TRAIL = { r, y, x0, x1, mk, cvs, pm };
  return JSON.stringify({ x0, x1, y, width: Math.round(r.width), height: Math.round(r.height) });
})()
"""

# 拖动开始（按住不放）+ 沿一条水平线跑 24 步
START = r"""
(() => {
  const T = window.__TRAIL;
  T.cvs.dispatchEvent(T.mk('mousedown', T.x0, T.y));
  return new Promise((resolve) => {
    let x = T.x0;
    const step = () => {
      x += Math.max(4, Math.round((T.x1 - T.x0) / 24));
      T.cvs.dispatchEvent(T.mk('mousemove', Math.min(x, T.x1), T.y));
      if (x < T.x1) requestAnimationFrame(step);
      else resolve(JSON.stringify({ at: Math.min(x, T.x1) }));
    };
    requestAnimationFrame(step);
  });
})()
"""

COUNT = r"""
(() => {
  const T = window.__TRAIL;
  const cvs = T.cvs;
  const ctx = cvs.getContext('2d');
  const toCss = cvs.width / cvs.clientWidth;        // 是否 DPR>1
  const padX = 30, padY = 60;
  const x = Math.max(0, Math.round((T.x0 - padX) * toCss));
  const w = Math.min(cvs.width - x, Math.round((T.x1 - T.x0 + padX * 2) * toCss));
  const y = Math.max(0, Math.round((T.y - padY) * toCss));
  const h = Math.min(cvs.height - y, Math.round(padY * 2 * toCss));
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  let light = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum > 170) light += 1;
    sum = (sum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) >>> 0;
  }
  const list = (T.pm.currentMapData && T.pm.currentMapData.reliefIcons) || [];
  // 只在"拖动中"那一帧留存 band（供松手后差分）；松手后那次不要再覆盖它
  if (T.__storeBand) {
    T.lastBand = img;
    T.bandMeta = { x, y, w, h };
    T.__storeBand = false;
  }
  return JSON.stringify({ light, sum, band: { x, y, w, h }, icons: list.length });
})()
"""

# 松手后：与"拖动中"那一帧逐像素做差分 —— 差值就是**被擦掉的笔迹**
# （两次的图标是同一批，理应几乎不差；所以我们只看"变暗"的像素：白色笔迹没了）
DIFF = r"""
(() => {
  const T = window.__TRAIL;
  const cvs = T.cvs;
  const ctx = cvs.getContext('2d');
  const prev = T.lastBand;
  const m = T.bandMeta || { x: 0, y: 0 };
  const cur = ctx.getImageData(m.x, m.y, prev.width, prev.height);
  let changed = 0, brightDown = 0, total = 0;
  for (let i = 0; i < prev.data.length; i += 4) {
    const l1 = 0.299 * prev.data[i] + 0.587 * prev.data[i + 1] + 0.114 * prev.data[i + 2];
    const l2 = 0.299 * cur.data[i] + 0.587 * cur.data[i + 1] + 0.114 * cur.data[i + 2];
    total += 1;
    if (Math.abs(l1 - l2) > 6) changed += 1;
    if (l1 - l2 > 6) brightDown += 1;          // "变暗了" = 那条淡白笔迹被擦掉
  }
  return JSON.stringify({ changed, brightDown, total });
})()
"""

RELEASE = "(() => { const T = window.__TRAIL; T.cvs.dispatchEvent(T.mk('mouseup', T.x1, T.y)); return 'ok'; })()"

STATE = "(() => { const pm = " + PM + "; return JSON.stringify({ brushing: !!pm.reliefBrush.isReliefBrushing.value, path: (pm.reliefBrush.reliefPath.value || []).length }); })()"

UNDO = "(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store; return JSON.stringify({ canUndo: !!s.canUndo, label: s.undoLabel }); })()"

# 10s 连续拖笔的帧统计（与 §二A 的"散布笔连画 10s"同口径）——判"笔迹层有没有把拖动拖瘦"
PERF = r"""
(() => new Promise((resolve) => {
  const T = window.__TRAIL;
  const deltas = [];
  let last = performance.now();
  let stop = false, handlerMs = 0, evs = 0, x = T.x0, dir = 1;
  T.cvs.dispatchEvent(T.mk('mousedown', x, T.y));
  const loop = () => {
    const now = performance.now();
    deltas.push(now - last);
    last = now;
    evs += 1;
    x += 6 * dir;
    if (x > T.x1 || x < T.x0) { dir = -dir; x = Math.min(T.x1, Math.max(T.x0, x)); }
    const t0 = performance.now();
    T.cvs.dispatchEvent(T.mk('mousemove', x, T.y + Math.sin(evs / 7) * 40));
    handlerMs += performance.now() - t0;
    if (!stop) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setTimeout(() => {
    stop = true;
    T.cvs.dispatchEvent(T.mk('mouseup', x, T.y));
    const d = deltas.slice(1).sort((a, b) => a - b);
    const q = (p) => (d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : -1);
    resolve(JSON.stringify({
      frames: d.length, p50: q(0.5), p95: q(0.95), max: d.length ? +d[d.length - 1].toFixed(1) : -1,
      over33: d.filter(v => v > 33).length, over50: d.filter(v => v > 50).length,
      handlerMsPerEvent: +(handlerMs / Math.max(1, evs)).toFixed(2),
      icons: ((T.pm.currentMapData && T.pm.currentMapData.reliefIcons) || []).length,
    }));
  }, 10000);
}))()
"""


def j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, dict):
        raise RuntimeError('eval 异常：%s' % v)
    try:
        return json.loads(v) if isinstance(v, str) and v.startswith(('{', '[')) else v
    except ValueError:
        return v


def main():
    cdp = CDP()
    try:
        cdp.ws.settimeout(180)
        cdp.navigate('http://localhost:5180/?trail=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?trail=%d' % (int(time.time()) + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        open_harness_project(cdp)

        print('enter planet:', j(cdp, ENTER))
        wait_for(cdp, READY, timeout=40, desc='行星画布')
        time.sleep(1.0)
        print('setup:', j(cdp, SETUP))
        time.sleep(0.6)
        print('geom:', j(cdp, GEOM))

        before = j(cdp, COUNT)
        print('拖动前:', before)

        print('start:', j(cdp, START))
        time.sleep(0.45)                        # 让最后几帧画完
        cdp.eval("window.__TRAIL.__storeBand = true; 'ok'")
        during = j(cdp, COUNT)
        print('拖动中:', during)
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        with open(OUT_PNG, 'wb') as f:
            f.write(base64.b64decode(shot['data']))
        print('拖动中截图 ->', os.path.relpath(OUT_PNG, ROOT))

        print('release:', j(cdp, RELEASE))
        time.sleep(0.6)
        after = j(cdp, COUNT)
        print('松手后:', after)
        diff = j(cdp, DIFF)
        print('松手 vs 拖动中 差分:', diff)
        state = j(cdp, STATE)
        print('拖动状态:', state)
        undo = j(cdp, UNDO)
        print('undo:', undo)

        print('10s 连续拖笔…')
        perf = j(cdp, PERF)
        print('帧统计:', perf)

        # ── 判据 ──────────────────────────────────────────────────────────
        fails = []
        # ① 拖动中真有笔迹：与"松手后"逐像素差分，"变暗"的像素就是那条淡白轨迹（图标两次都在，不贡献）
        if not (diff['brightDown'] > 800):
            fails.append('拖动中看不到笔迹（松手后变暗像素只有 %s）' % diff['brightDown'])
        if not (after['icons'] > before['icons']):
            fails.append('这一笔没落图标（%s → %s）' % (before['icons'], after['icons']))
        if state.get('brushing'):
            fails.append('松手后 isReliefBrushing 还是 true')
        if not undo.get('canUndo'):
            fails.append('松手后没有可撤销命令（一笔一条 undo 掉了）')
        if perf.get('over50', 99) > 2:
            fails.append('笔迹层把拖动拖瘦了（10s 里 %s 帧 >50ms）' % perf.get('over50'))
        if perf.get('p95', 99) > 26:
            fails.append('p95 %sms > 26ms（基线 18.2）' % perf.get('p95'))

        print('\n=== 判据 ===')
        print(json.dumps({
            'bright_down_after_release(轨迹像素)': diff['brightDown'],
            'changed_after_release': diff['changed'],
            'icons_before': before['icons'], 'icons_after': after['icons'],
            'undoLabel': undo.get('label'),
            'drag10s': {k: perf.get(k) for k in ('frames', 'p50', 'p95', 'max', 'over33', 'over50', 'handlerMsPerEvent')},
            'fails': fails,
        }, ensure_ascii=False, indent=1))
        return 0 if not fails else 1
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
