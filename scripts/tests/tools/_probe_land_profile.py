#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""松手 / 落盘 两条链的 CPU 自耗时剖析（**不是回归用例**，会话结束前删）。

为什么另起一份：`_probe_cpu_profile.py` 的窗口把整段拖笔都罩进去了（mousemove 摊薄了结论），
而这里只想回答"松手那一下 + 800ms 后那次落盘，各自把时间花在哪个函数上"。

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_land_profile.py land     # 松手（mouseup 同步段）
    python scripts/tests/tools/_probe_land_profile.py save     # saveProject（含 IPC）
"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests', 'tools'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

SETUP = r"""
window.confirm = () => true; window.alert = () => {}; window.prompt = (q, d) => d;
(async () => {
  window.__P = { stage: 'import' };
  const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
  let text = null;
  for (const url of ['/__real_desite.map', '/docs/mockups/desite.map']) {
    try {
      const r = await fetch(url); if (!r.ok) continue;
      const t = await r.text(); if (t.length < 1000000 || !t.includes('feature')) continue;
      text = t; break;
    } catch (e) {}
  }
  const AP = await import('/src/utils/azgaar-parser.js');
  const NAME = '剖析底图';
  s.importFromScenariosJson(AP.buildScenariosJson(AP.parseMapFile(text), NAME, '当前'));
  await new Promise((r) => setTimeout(r, 2500));
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  sm.baseMapKey = NAME;
  if (sm.onBaseMapChange) await sm.onBaseMapChange();
  await new Promise((r) => setTimeout(r, 1000));
  if (sm.fitToView) sm.fitToView();
  if (!sm.editMode && sm.enterEditMode) sm.enterEditMode();
  await new Promise((r) => setTimeout(r, 600));
  window.__MAP = NAME;
  window.__P = { stage: 'ready', terrain: (s.baseMaps[NAME].terrain || []).length };
})();
'ok'
"""

# 拖一圈（50 个 mousemove）后松手，结果写 window.__R.landMs
PREPARE = r"""
(() => {
  const el = document.querySelector('.scenario-map-container');
  const sm = el.__vueParentComponent.setupState;
  const cvs = sm.canvas;
  const r = cvs.getBoundingClientRect();
  const cx = r.width * 0.38, cy = r.height * 0.5, Rr = Math.min(r.width, r.height) * 0.10;
  const mk = (t, x, y) => new MouseEvent(t, { clientX: r.left + x, clientY: r.top + y, button: 0,
    buttons: t === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true });
  window.__G = { r, cx, cy, Rr, mk, cvs, sm };
  sm.setTool('draw');
  cvs.dispatchEvent(mk('mousedown', cx + Rr, cy));
  for (let i = 1; i <= 50; i++) {
    const a = (i / 50) * Math.PI * 2;
    cvs.dispatchEvent(mk('mousemove', cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr));
  }
  return 'ready';
})()
"""

DRIVE = {
    # 只量松手那一下（拖圈已在 PREPARE 里做完）
    'land': r"""
(() => {
  const g = window.__G;
  const t0 = performance.now();
  g.cvs.dispatchEvent(g.mk('mouseup', g.cx + g.Rr, g.cy));
  const ms = performance.now() - t0;
  window.__R = { landMs: +ms.toFixed(1) };
  return JSON.stringify(window.__R);
})()
""",
    # 量一次落盘（saveProject 的同步段 + IPC 往返）
    'save': r"""
(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const ps = (await import('/src/store/projectStore.js')).useProjectStore(app.config.globalProperties.$pinia);
  const t0 = performance.now();
  const res = await ps.saveProject({ label: '剖析' });
  const ms = performance.now() - t0;
  window.__R = { saveMs: +ms.toFixed(1), ok: !!(res && res.success), bytes: res && res.bytes };
  return JSON.stringify(window.__R);
})()
""",
}


def aggregate(profile, t_min=0.0, t_max=1e18):
    nodes = {n['id']: n for n in profile['nodes']}
    total = 0
    per = {}
    samples = profile.get('samples') or []
    deltas = profile.get('timeDeltas') or []
    ts = 0.0
    for i, sid in enumerate(samples):
        dt = deltas[i] if i < len(deltas) else 0
        ts += dt
        if ts < t_min * 1000 or ts > t_max * 1000:
            continue
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


def run_profiled(cdp, drive_js, label, drive_ms=0.0):
    """开 Profiler → 跑一段 JS → 立刻停。返回自耗时表。"""
    cdp.send('Profiler.enable', {})
    cdp.send('Profiler.setSamplingInterval', {'interval': 100})
    cdp.send('Profiler.start', {})
    out = cdp.eval(drive_js)
    res = cdp.send('Profiler.stop', {})
    profile = res.get('profile') or {}
    total, rows = aggregate(profile)
    print('=== %s（有效自耗时 %.1f ms / 窗口 %.1f ms）===' % (label, total / 1000.0, drive_ms))
    for k, v in rows[:35]:
        print('  %8.1f ms  %5.1f%%  %s' % (v / 1000.0, 100.0 * v / max(1, total), k))
    fp = os.path.join(ROOT, '.lab-profile-%s.json' % label)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump({'kind': label, 'total_ms': total / 1000.0,
                   'rows': [{'ms': v / 1000.0, 'key': k} for k, v in rows[:120]]}, f, ensure_ascii=False, indent=1)
    print('-> 落盘', os.path.relpath(fp, ROOT), '| drive:', out)
    return rows


def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else 'land'
    if kind not in DRIVE:
        print('未知动作：', kind, '可选：', list(DRIVE))
        return 1
    cdp = CDP()
    try:
        cdp.ws.settimeout(300)
        cdp.navigate('http://localhost:5180/?lp=%d' % int(time.time()))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?lp=%d' % (int(time.time()) + 1))
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
        cdp.send('Runtime.evaluate', {'expression': SETUP, 'returnByValue': True, 'awaitPromise': False})
        for _ in range(120):
            v = cdp.eval("JSON.stringify(window.__P || null)")
            if isinstance(v, str) and '"ready"' in v:
                break
            time.sleep(1)
        print('setup:', v)
        time.sleep(0.8)
        if kind == 'land':
            print('prepare:', cdp.eval(PREPARE))
            time.sleep(0.3)
            run_profiled(cdp, DRIVE[kind], 'land')
        else:
            # 先造一点改动，确保 dirty
            cdp.eval("(() => { const s = document.querySelector('#app').__vue_app__._instance.setupState.store;"
                     " s.updateNode(s.nodes[0].id, { population: 1234 }); return 'dirty'; })()")
            time.sleep(0.2)
            run_profiled(cdp, DRIVE[kind], 'save')
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
