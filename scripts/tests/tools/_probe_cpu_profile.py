#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CPU 采样剖析（**不是回归用例**）：把某一次真实拖笔/拖节点的**自耗时**摊到函数级。

为什么需要它：`_probe_jank_real.js` 只能告诉我们"这一笔每事件 29ms"，
但**说不出这 29ms 花在谁身上**（我前面已经在猜了三种，全是没有证据的猜）。
`Profiler.start/stop` 是 CDP 自带的能力，直接给样本 → 按函数聚合自耗时。

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_cpu_profile.py province-draw
    python scripts/tests/tools/_probe_cpu_profile.py river-trace
    python scripts/tests/tools/_probe_cpu_profile.py node-drag
    python scripts/tests/tools/_probe_cpu_profile.py idle-render
    python scripts/tests/tools/_probe_cpu_profile.py prov-draw-autoriver
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

SETUP = r"""
window.confirm = () => true; window.alert = () => {}; window.prompt = (q, d) => d;
(async () => {
  window.__P = { stage: 'import' };
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const AP = await import('/src/utils/azgaar-parser.js');
  const text = await (await fetch('/__real_desite.map')).text();
  const NAME = '德斯特';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await new Promise((r) => setTimeout(r, 2500));
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  sm.baseMapKey = NAME;
  if (sm.onBaseMapChange) await sm.onBaseMapChange();
  await new Promise((r) => setTimeout(r, 1000));
  if (sm.fitToView) sm.fitToView();
  await new Promise((r) => setTimeout(r, 600));
  window.__P = { stage: 'ready', terrain: (s.baseMaps[NAME].terrain || []).length,
                 rivers: (s.baseMaps[NAME].rivers || []).length };
})();
'ok'
"""

DRIVE = {
    # 省份自由绘制：mousedown → 每帧一圈 mousemove（不松手）
    'province-draw': r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  const cvs = sm.canvas;
  sm.setTool('draw');
  const r = cvs.getBoundingClientRect();
  const cx = r.width * 0.35, cy = r.height * 0.45, Rr = Math.min(r.width, r.height) * 0.12;
  const mk = (t, x, y) => new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  let i = 0, stop = false;
  const loop = () => {
    i++;
    const a = (i / 40) * Math.PI * 2;
    cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr));
    if (!stop) requestAnimationFrame(loop);
  };
  cvs.dispatchEvent(mk('mousedown', cx + Rr, cy));
  requestAnimationFrame(loop);
  setTimeout(() => { stop = true; }, 4000);
  window.__DRIVE = { kind: 'province-draw', pts: () => (sm.freeTrace || []).length };
  return 'driving';
})()
""",
    # 同样，但先画过自动河流（量"自动河在场"给每一帧加了什么）
    'province-draw-autoriver': r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  sm.generateAndShowRivers();
  const cvs = sm.canvas;
  sm.setTool('draw');
  const r = cvs.getBoundingClientRect();
  const cx = r.width * 0.35, cy = r.height * 0.45, Rr = Math.min(r.width, r.height) * 0.12;
  const mk = (t, x, y) => new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  let i = 0, stop = false;
  const loop = () => {
    i++;
    const a = (i / 40) * Math.PI * 2;
    cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr));
    if (!stop) requestAnimationFrame(loop);
  };
  cvs.dispatchEvent(mk('mousedown', cx + Rr, cy));
  requestAnimationFrame(loop);
  setTimeout(() => { stop = true; }, 4000);
  return 'driving';
})()
""",
    # 手画河：mousedown → 每帧拖一段（不松手）
    'river-trace': r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  const cvs = sm.canvas;
  sm.setTool('river');
  const r = cvs.getBoundingClientRect();
  const mk = (t, x, y) => new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  let i = 0, stop = false;
  const loop = () => {
    i++;
    cvs.dispatchEvent(mk('mousemove', 120 + (i * 4) % (r.width - 200), 140 + Math.sin(i / 6) * 60 + 40));
    if (!stop) requestAnimationFrame(loop);
  };
  cvs.dispatchEvent(mk('mousedown', 120, 140));
  requestAnimationFrame(loop);
  setTimeout(() => { stop = true; }, 4000);
  return 'driving';
})()
""",
    # 拖一条自带河的节点
    'node-drag': r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  const cvs = sm.canvas;
  const bm = s.baseMaps[sm.baseMapKey];
  const rv = (bm.rivers || [])[0];
  sm.setTool('river');
  sm.setRiverSelection([rv.id], rv.id);
  sm.render();
  const node = rv.points[Math.floor(rv.points.length / 2)];
  const p = sm.worldToScreen(node.x, node.y);
  const r = cvs.getBoundingClientRect();
  const mk = (t, x, y) => new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  let i = 0, stop = false;
  const loop = () => {
    i++;
    cvs.dispatchEvent(mk('mousemove', p.x + Math.sin(i / 8) * 30, p.y + Math.cos(i / 8) * 30));
    if (!stop) requestAnimationFrame(loop);
  };
  cvs.dispatchEvent(mk('mousedown', p.x, p.y));
  requestAnimationFrame(loop);
  setTimeout(() => { stop = true; }, 4000);
  return JSON.stringify({ started: !!sm.riverDrag, at: [Math.round(p.x), Math.round(p.y)] });
})()
""",
    # 只反复 render（把"一帧的固有成本"摊开）
    'idle-render': r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  let i = 0, stop = false;
  const loop = () => { i++; sm.render(); if (!stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setTimeout(() => { stop = true; }, 3000);
  return 'driving';
})()
""",
    # 🔴 落库那条链：拖一圈 → **松手**（压叠闸门 → 一条 undo → 全量保存）。这是"手一松就顿一下"。
    'province-land': r"""
(async () => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  const cvs = sm.canvas;
  sm.setTool('draw');
  const r = cvs.getBoundingClientRect();
  const cx = r.width * 0.35, cy = r.height * 0.45, Rr = Math.min(r.width, r.height) * 0.12;
  const mk = (t, x, y) => new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  const tick = (ms) => new Promise((res) => setTimeout(res, ms == null ? 60 : ms));
  cvs.dispatchEvent(mk('mousedown', cx + Rr, cy));
  for (let i = 1; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr));
  }
  await tick(200);
  const t0 = performance.now();
  cvs.dispatchEvent(mk('mouseup', cx + Rr, cy));
  const ms = performance.now() - t0;
  window.__LAND = { landMs: +ms.toFixed(1) };
  // 松手之后紧接着还有一层：800ms 防抖的全量项目保存（`pan` 探针里那 590ms 的那一帧）
  await tick(1600);
  window.__LAND.afterSave = 'done';
  return JSON.stringify(window.__LAND);
})()
""",
}


def aggregate(profile):
    """按函数聚合**自耗时**（微秒 → 毫秒）。"""
    nodes = {n['id']: n for n in profile['nodes']}
    total = 0
    per = {}
    samples = profile.get('samples') or []
    deltas = profile.get('timeDeltas') or []
    for i, sid in enumerate(samples):
        dt = deltas[i] if i < len(deltas) else 0
        total += dt
        n = nodes.get(sid)
        if not n:
            continue
        cf = n['callFrame']
        name = cf.get('functionName') or '(anonymous)'
        url = (cf.get('url') or '').split('/')[-1]
        key = '%s  @%s:%s' % (name, url, cf.get('lineNumber', -1) + 1)
        per[key] = per.get(key, 0) + dt
    rows = sorted(per.items(), key=lambda kv: -kv[1])
    return total, rows


def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else 'province-draw'
    if kind not in DRIVE:
        print('未知动作：', kind, '可选：', list(DRIVE))
        return 1
    cdp = CDP()
    try:
        cdp.ws.settimeout(300)
        cdp.navigate('http://localhost:5180/?prof=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?prof=%d' % (int(time.time()) + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        open_harness_project(cdp)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本模式')
        time.sleep(1.0)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find((x) => (x.textContent || '').includes('\u4e22\u5f03\u5907\u4efd'));"
                 " if (b) { b.click(); return true; } return false; })()")
        time.sleep(0.5)
        # ① 装真实底图
        cdp.send('Runtime.evaluate', {'expression': SETUP, 'returnByValue': True, 'awaitPromise': False})
        for _ in range(120):
            v = cdp.eval("JSON.stringify(window.__P || null)")
            if isinstance(v, str) and '"ready"' in v:
                break
            time.sleep(1)
        print('setup:', v)
        time.sleep(0.8)
        # ② 开剖析 → 驱动 → 停
        cdp.send('Profiler.enable', {})
        cdp.send('Profiler.setSamplingInterval', {'interval': 200})
        cdp.send('Profiler.start', {})
        info = cdp.eval(DRIVE[kind])
        print('drive:', info)
        time.sleep(5.0)
        res = cdp.send('Profiler.stop', {})
        profile = res.get('profile') or {}
        total, rows = aggregate(profile)
        print('=== CPU 自耗时（%s，采样 %d μs，总 %d ms）===' % (kind, profile.get('endTime', 0) - profile.get('startTime', 0), total / 1000))
        for k, v in rows[:40]:
            print('  %8.1f ms  %5.1f%%  %s' % (v / 1000.0, 100.0 * v / max(1, total), k))
        out = os.path.join(ROOT, '.lab-profile-%s.json' % kind)
        with open(out, 'w', encoding='utf-8') as f:
            json.dump({'kind': kind, 'total_ms': total / 1000.0,
                       'rows': [{'ms': v / 1000.0, 'key': k} for k, v in rows[:80]]}, f, ensure_ascii=False, indent=1)
        print('-> 落盘', os.path.relpath(out, ROOT))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
