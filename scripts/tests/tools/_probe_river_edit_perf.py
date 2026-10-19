#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：河流编辑的**性能**（暮雨「有时候还会卡顿」，无可复现判据 → 先量出来）。

量四件事，都是"编辑河流时真的会跑"的路径：
  1. 一帧 `render()` 的耗时，随「河数 × 每河节点数」变化；
  2. 悬停（`mousemove`）时的命中判定耗时 —— 河流编辑器在 mousemove 里做 `hitRiverNodeIndex`
     + `hitBaseMapRiver`，河多时这是**每次鼠标移动**都要付的钱；
  3. 拖一个节点（`riverDrag` 路径）时每帧的耗时；
  4. 选中态渲染（`drawSelectedRiverHighlight`）的增量。

判据用**中位/最大值**（毫秒），不用平均值 —— 卡顿是长尾现象。
用法（lab 必须先 up）：python scripts/tests/tools/_probe_river_edit_perf.py
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

SETUP = r"""(async (count, nodesPer) => {
  // 🔴 只读路径（2026-10-18 改）：不建河。写口在只读态会被闸门拦掉，探针会拿到一个
  //    与被测目标无关的 TypeError（第一版白跑两轮）。直接量**组件正在画的那份底图**
  //    （`sm.baseMap` —— 它是 computed，已解包；store.baseMaps[key] 那条路才是坑：
  //     组件里选中/切图后 key 可能指向别处，实测拿到 undefined）。
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  const bm = sm.baseMap || {};
  const rivers = bm.rivers || [];
  if (sm.setTool) sm.setTool('river');
  await new Promise((r) => setTimeout(r, 200));
  return JSON.stringify({
    key: sm.baseMapKey, rivers: rivers.length,
    totalNodes: rivers.reduce((a, r) => a + ((r.points || []).length), 0),
    terrain: (bm.terrain || []).length,
    readOnly: !!(sm.store && sm.store.isReadOnly), count, nodesPer, fails: [],
  });
})
"""

MEASURE = r"""(async (sm) => {
  const cv = sm.canvas;
  const timeit = (fn, n) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn(i);
      arr.push(performance.now() - t0);
    }
    arr.sort((a, b) => a - b);
    return { n, p50: +arr[Math.floor(arr.length / 2)].toFixed(2), max: +arr[arr.length - 1].toFixed(2),
             sum: +arr.reduce((a, b) => a + b, 0).toFixed(1) };
  };
  const rect = cv.getBoundingClientRect();
  const ev = (type, x, y, extra) => cv.dispatchEvent(new MouseEvent(type, Object.assign({
    bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons: 1 }, extra || {})));
  const out = {};

  // ① 静止重绘
  if (typeof sm.render === 'function') {
    sm.render();
    out.render = timeit(() => sm.render(), 20);
  }
  // ② 悬停（真实 mousemove）：河流编辑器在 mousemove 里做命中判定 + 可能的 render
  const cx = Math.round(cv.clientWidth / 2), cy = Math.round(cv.clientHeight / 2);
  out.hover = timeit((i) => { ev('mousemove', cx + (i % 7), cy + (i % 5)); }, 30);
  // ③ 拖节点：先选中一条河，按住它的一个节点拖
  const rid = (sm.baseMap.rivers[0] || {}).id;
  if (rid && typeof sm.setRiverSelection === 'function') {
    sm.setRiverSelection([rid], rid);
    sm.render();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r0 = sm.baseMap.rivers[0];
    const node = r0.points[Math.floor(r0.points.length / 2)];
    const q = sm.worldToScreen(node.x, node.y);
    ev('mousedown', q.x, q.y);
    await new Promise(r => setTimeout(r, 60));
    out.dragStarted = !!sm.riverDrag;
    out.drag = timeit((i) => { ev('mousemove', q.x + 3 + (i % 5), q.y + 2 + (i % 4)); }, 30);
    ev('mouseup', q.x, q.y);
    await new Promise(r => setTimeout(r, 120));
  }
  // ④ 选中态重绘（含高亮）
  if (rid) {
    sm.setRiverSelection([rid], rid);
    out.renderSelected = timeit(() => sm.render(), 20);
    sm.setRiverSelection([], null);
    sm.render();
  }
  return JSON.stringify(out);
})
"""


def main():
    cdp = CDP()
    try:
        cdp.navigate('http://localhost:5180/?perf=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='boot')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?perf=%d' % (BUST + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='hard-reload')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?perf=%d' % BUST)
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
        # 用底图自带的 160 条河量三档缩放（卡顿与"看得见多少"强相关）
        for zoom in (1, 2, 4):
            st = cdp.eval("(%s)(%d, %d)" % (SETUP, 0, 0))
            d0 = json.loads(st) if isinstance(st, str) else st
            if not isinstance(d0, dict) or d0.get('__err__'):
                print('缩放 %s× 准备失败：%s' % (zoom, str(d0)[:200]))
                continue
            cdp.eval("(() => { const el = document.querySelector('.scenario-map-container');"
                     " const sm = el.__vueParentComponent.setupState; sm.cameraScale = %d;"
                     " if (sm.render) sm.render(); return 'ok'; })()" % zoom)
            time.sleep(0.3)
            r = cdp.eval("(%s)(document.querySelector('.scenario-map-container')"
                         ".__vueParentComponent.setupState)" % MEASURE)
            if isinstance(r, dict) and '__err__' in r:
                print('缩放 %s× 测量失败：%s' % (zoom, str(r)[:200]))
                continue
            d = json.loads(r) if isinstance(r, str) else r
            print('== %s×（底图 %s 条河 / %s 节点 / 地形 %s 块，readOnly=%s）'
                  % (zoom, d0.get('rivers'), d0.get('totalNodes'), d0.get('terrain'), d0.get('readOnly')))
            for k in ('render', 'hover', 'drag', 'renderSelected'):
                v = d.get(k)
                if isinstance(v, dict):
                    print('   %-14s p50 %6.2fms  max %7.2fms  (n=%s)' % (k, v['p50'], v['max'], v['n']))
            if 'dragStarted' in d:
                print('   dragStarted=%s' % d['dragStarted'])
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
