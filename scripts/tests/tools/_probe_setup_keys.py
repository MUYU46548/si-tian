#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时：看 ScenarioMap 的 setupState 到底绑了什么（探针建数据报 TypeError，先确认真实原因）。
用法（lab 必须先 up）：python scripts/tests/tools/_probe_setup_keys.py
"""
import io
import json
import os
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for      # noqa: E402
from lib.helpers import open_harness_project   # noqa: E402
import run_tests as RT                 # noqa: E402

BUST = int(time.time())

JS = r"""(() => {
  const el = document.querySelector('.scenario-map-container');
  if (!el) return JSON.stringify({ mounted: false });
  const inst = el.__vueParentComponent;
  const sm = inst && inst.setupState;
  const keys = sm ? Object.keys(sm) : [];
  const has = (k) => !!(sm && k in sm);
  const t = (k) => { try { return sm && sm[k] === null ? 'null' : typeof (sm ? sm[k] : undefined); } catch (e) { return 'ERR'; } };
  return JSON.stringify({
    mounted: true, hasInst: !!inst, keyCount: keys.length,
    want: {
      baseMapKey: t('baseMapKey'), onBaseMapChange: t('onBaseMapChange'), canvas: t('canvas'),
      render: t('render'), setTool: t('setTool'), setRiverSelection: t('setRiverSelection'),
      baseMap: t('baseMap'), cameraScale: t('cameraScale'), worldToScreen: t('worldToScreen'),
      riverDraft: t('riverDraft'), riverDrag: t('riverDrag'), selectedRiverIds: t('selectedRiverIds'),
      tool: t('tool'), provinceHint: t('provinceHint'), statusMsg: t('statusMsg'),
    },
    hasBaseMapKey: has('baseMapKey'),
    firstKeys: keys.slice(0, 40),
  });
})()"""


def main():
    cdp = CDP()
    try:
        cdp.navigate('http://localhost:5180/?keys=%d' % BUST)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='boot')
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?keys=%d' % (BUST + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='reload')
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=40, desc='data')
        open_harness_project(cdp)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('\u5386\u53f2\u5267\u672c'));"
                 " if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='editor')
        time.sleep(1.0)
        print(cdp.eval(JS))
    finally:
        cdp.close()


if __name__ == '__main__':
    main()
