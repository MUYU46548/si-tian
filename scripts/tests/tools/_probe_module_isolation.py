#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe 4: verify the "history scenario is an independent module" fix (round 14).

Criteria (all measured from the DOM):
 1. double-clicking a planet in the nav tree while inside the scenario editor must UNMOUNT
    ScenarioMap (it must no longer overlap PlanetMap);
 2. elementFromPoint(canvas center) must then hit PlanetMap's canvas (the user can click it);
 3. the "back to scenario editor" chip must exist and must NOT cover the canvas bottom controls;
 4. clicking the chip brings the editor back and resets viewLevel to world;
 5. pressing "back" inside the planet map must not re-cover the planet map.
Usage (lab must be up): python scripts/tests/tools/_probe_module_isolation.py
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

STATE = """(() => {
  const st = document.querySelector('#app').__vue_app__._instance.setupState;
  const box = (s) => { const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const mc = box('.main-content');
  const cx = Math.round(mc.x + mc.w / 2), cy = Math.round(mc.y + mc.h / 2);
  const path = (el, n) => { const p = []; for (let e = el; e && p.length < n; e = e.parentElement)
    p.push(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className
      ? '.' + e.className.trim().split(/\\s+/).slice(0,2).join('.') : '')); return p; };
  return JSON.stringify({
    viewLevel: st.store.viewLevel,
    scenarioMode: st.scenarioMode,
    pickerVisible: st.scenarioPickerVisible,
    scenarioEditorVisible: st.scenarioEditorVisible,
    scenarioSteppedOut: st.scenarioSteppedOut,
    currentLevelLabel: st.currentLevelLabel,
    scenarioBox: box('.scenario-map-container'),
    planetBox: box('.planet-map-container'),
    chipBox: box('[data-testid=scenario-return-chip]'),
    chipHit: path(document.elementFromPoint(20, innerHeight - 40), 3),
    centerHit: path(document.elementFromPoint(cx, cy), 4),
    fails: [],
  });
})()"""

DBL = """(() => {
  const items = Array.from(document.querySelectorAll('.tree-navigation .tree-node'));
  const seen = [];
  for (const it of items) {
    const n = it.__vueParentComponent && it.__vueParentComponent.props && it.__vueParentComponent.props.node;
    if (!n) { seen.push('(no-node)'); continue; }
    seen.push(n.layer + ':' + n.name);
    if (n.layer === 'planet') {
      it.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return 'dblclick ' + n.name;
    }
  }
  return 'no-planet ' + JSON.stringify(seen.slice(0, 6));
})()"""


def show(tag, cdp):
    print(tag, cdp.eval(STATE))


def main():
    cdp = CDP()
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

    # 1) enter the scenario editor
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c')); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor mounted')
    time.sleep(0.6)
    show('s1 in editor:', cdp)

    # 2) product path: double-click a planet in the tree
    print('tree dbl ->', cdp.eval(DBL))
    time.sleep(1.2)
    show('s2 after tree dbl:', cdp)
    try:
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        p = os.path.join(ROOT, 'docs', 'assets', 'lab-module-isolated.png')
        open(p, 'wb').write(base64.b64decode(shot['data']))
        print('shot ->', p)
    except Exception as e:
        print('shot failed:', e)

    # 3) click the chip
    cdp.eval("(() => { const b = document.querySelector('[data-testid=scenario-return-btn]');"
             " if (b) b.click(); return 'ok'; })()")
    time.sleep(1.0)
    show('s3 after chip click:', cdp)

    # 4) again: tree dbl -> planet map back button
    print('tree dbl ->', cdp.eval(DBL))
    time.sleep(1.0)
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('.planet-map-container button'))"
             ".find(x => (x.textContent || '').includes('\u8fd4\u56de')); if (b) b.click(); return 'ok'; })()")
    time.sleep(1.0)
    show('s4 after planet back:', cdp)

    cdp.close()


if __name__ == '__main__':
    main()
