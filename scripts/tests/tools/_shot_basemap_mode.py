#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""出图：底图编辑模式的观感（2026-10-18 第十七修）——主行（日常）vs 开模式后的地理行。
用法（lab 必须先 up）：python scripts/tests/tools/_shot_basemap_mode.py
产物：docs/assets/basemap-mode-20261018/*.png
"""
import base64
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

OUT = os.path.join(ROOT, 'docs', 'assets', 'basemap-mode-20261018')
BUST = int(time.time())


def shot(cdp, name):
    os.makedirs(OUT, exist_ok=True)
    s = cdp.send('Page.captureScreenshot', {'format': 'png'})
    p = os.path.join(OUT, name)
    open(p, 'wb').write(base64.b64decode(s['data']))
    print('shot ->', p)


def main():
    cdp = CDP()
    try:
        cdp.navigate('http://localhost:5180/?bmode=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='boot')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?bmode=%d' % (BUST + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?bmode=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload2')
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=40, desc='data')
        open_harness_project(cdp)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor')
        time.sleep(1.0)
        cdp.eval("(() => { const sm = document.querySelector('.scenario-map-container')"
                 ".__vueParentComponent.setupState; if (sm.basemapEditMode) sm.toggleBasemapEditMode();"
                 " sm.setTool('select'); return 'ok'; })()")
        time.sleep(0.5)
        shot(cdp, '01-daily-mode.png')
        cdp.eval("(() => { document.querySelector('[data-testid=basemap-edit-toggle]').click(); return 'ok'; })()")
        time.sleep(0.6)
        shot(cdp, '02-basemap-edit-mode.png')
        cdp.eval("(() => { const sm = document.querySelector('.scenario-map-container')"
                 ".__vueParentComponent.setupState; sm.setTool('river'); return 'ok'; })()")
        time.sleep(0.8)
        shot(cdp, '03-basemap-river-tool.png')
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
