#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针 3：卡片墙穿帮取证（关掉 __SKIP_SCENARIO_PICKER）+ 世界选择页是否被盖住。
用法（lab 必须先 up）：python scripts/tests/tools/_probe_picker_bleed.py
"""
import base64
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

PROBE = """(() => {
  const picker = document.querySelector('.scenario-picker');
  const ws = document.querySelector('.world-selector');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  // 逐点扫描：卡片墙矩形内、但**卡片墙自身元素**不是命中目标的采样点 = 漏出来的东西
  const leaks = {};
  const pts = [[40,60],[40,760],[110,790],[640,790],[1240,60],[1240,790],[60,400],[200,400]];
  for (const [x,y] of pts) {
    const el = document.elementFromPoint(x,y);
    const path = []; for (let e = el; e && path.length < 4; e = e.parentElement)
      path.push(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className
        ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : ''));
    leaks[x + ',' + y] = path.join(' < ');
  }
  // 卡片墙在 DOM 里的父链（Teleport 是否生效：父应该是 body）
  const chain = []; for (let e = picker; e && chain.length < 4; e = e.parentElement)
    chain.push(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className
      ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : ''));
  return JSON.stringify({
    pickerBox: box(picker), pickerChain: chain,
    worldSelectorBox: box(ws),
    pickerCoversViewport: !!picker && box(picker).w >= innerWidth && box(picker).h >= innerHeight,
    leaks, fails: [],
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

    # 关掉跳过开关 → 走卡片墙这条真实用户路径
    cdp.eval("window.__SKIP_SCENARIO_PICKER = false")
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-picker')", timeout=25, desc='卡片墙挂载')
    time.sleep(1.6)
    print('卡片墙:', cdp.eval(PROBE))
    try:
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        p = os.path.join(ROOT, 'docs', 'assets', 'lab-picker-bleed.png')
        open(p, 'wb').write(base64.b64decode(shot['data']))
        print('shot ->', p)
    except Exception as e:
        print('shot failed:', e)

    # 卡片墙「返回世界」是否真的回到世界选择页
    cdp.eval("(() => { const b = document.querySelector('[data-testid=sp-back]'); if (b) b.click(); return 'ok'; })()")
    time.sleep(1.0)
    print('返回后:', cdp.eval("""JSON.stringify((() => {
      const st = document.querySelector('#app').__vue_app__._instance.setupState;
      return { viewLevel: st.store.viewLevel, scenarioMode: st.scenarioMode,
               picker: !!document.querySelector('.scenario-picker'),
               worldSelector: !!document.querySelector('.world-selector'), fails: [] };
    })())"""))

    cdp.close()


if __name__ == '__main__':
    main()
