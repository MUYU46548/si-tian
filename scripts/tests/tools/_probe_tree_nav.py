#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针 2：直接调 `jumpToNode`（树双击的真实落点），看**剧本域内点树**到底发生了什么。
外加卡片墙的穿帮取证（把 __SKIP_SCENARIO_PICKER 关掉重载）。
用法（lab 必须先 up）：python scripts/tests/tools/_probe_tree_nav.py
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

STATE = """(() => {
  const st = document.querySelector('#app').__vue_app__._instance.setupState;
  const box = (s) => { const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const el = document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2));
  const path = []; for (let e = el; e && path.length < 6; e = e.parentElement)
    path.push(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className
      ? '.' + e.className.trim().split(/\\s+/).slice(0,3).join('.') : ''));
  return JSON.stringify({
    viewLevel: st.store.viewLevel,
    scenarioMode: st.scenarioMode,
    pickerVisible: st.scenarioPickerVisible,
    currentPlanet: st.store.currentPlanet ? st.store.currentPlanet.name : null,
    scenarioBox: box('.scenario-map-container'),
    planetBox: box('.planet-map-container'),
    pickerBox: box('.scenario-picker'),
    treeBox: box('.tree-navigation'),
    centerPath: path,
    fails: [],
  });
})()"""


def main():
    cdp = CDP()
    cdp.navigate('http://localhost:5180/?lab=%d' % BUST)
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航')
    RT.apply_viewport(cdp)
    cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
    cdp.navigate('http://localhost:5180/?lab=%d' % BUST)
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载')
    RT.apply_viewport(cdp)
    wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
             timeout=40, desc='数据就绪')
    print('project:', open_harness_project(cdp)[0])
    print('SKIP_PICKER =', cdp.eval("String(window.__SKIP_SCENARIO_PICKER)"))

    # 1) 进剧本域（skip 开关下直达编辑器）
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='编辑器挂载')
    time.sleep(0.8)
    print('s1 进入剧本域:', cdp.eval(STATE))

    # 2) 直接调 useNodeNavigation 的 jumpToNode（树的 dblclick 真正调的就是它）
    r = cdp.eval("""(async () => {
      const st = document.querySelector('#app').__vue_app__._instance.setupState;
      const nav = await import('/src/composables/useNodeNavigation.js');
      const n = nav.useNodeNavigation();
      const planet = st.store.nodes.find(x => x.layer === 'planet');
      if (!planet) return JSON.stringify({ ok: false, reason: 'no planet' });
      n.jumpToNode(planet);
      await new Promise(r => setTimeout(r, 400));
      return JSON.stringify({ ok: true, planet: planet.name, viewLevel: st.store.viewLevel });
    })()""")
    print('s2 jumpToNode ->', r)
    time.sleep(1.0)
    print('s2 状态:', cdp.eval(STATE))
    try:
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        import base64 as _b64
        p = os.path.join(ROOT, 'docs', 'assets', 'lab-tree-nav-inscenario.png')
        open(p, 'wb').write(_b64.b64decode(shot['data']))
        print('shot ->', p)
    except Exception as e:
        print('shot failed:', e)

    # 3) 点「返回」按钮 → 回到世界选择页
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('.scenario-map-container button'))"
             ".find(x => (x.textContent || '').includes('返回')); if (b) b.click(); return 'ok'; })()")
    time.sleep(1.2)
    print('s3 点返回后:', cdp.eval(STATE))

    cdp.close()


if __name__ == '__main__':
    main()
