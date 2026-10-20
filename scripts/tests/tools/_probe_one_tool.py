#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单工具探针（S0 兜底用）：每次**从干净页面**起，只画一个工具，避免上一步的面板/选中状态污染。

用法（lab 必须先 up）：
    python scripts/tests/tools/_probe_one_tool.py provinceBrush
    python scripts/tests/tools/_probe_one_tool.py river
    python scripts/tests/tools/_probe_one_tool.py outline
    python scripts/tests/tools/_probe_one_tool.py provinceLasso

输出：docs/assets/s0-brush-20261019/one-<tool>.png + stdout 读数。
"""
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'tests'))

from lib.cdp import CDP, wait_for          # noqa: E402
from lib.helpers import open_harness_project  # noqa: E402
import run_tests as RT                     # noqa: E402

import importlib.util                      # noqa: E402
_spec = importlib.util.spec_from_file_location('bm', os.path.join(ROOT, 'scripts', 'tests', 'tools', '_probe_brush_matrix.py'))
bm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bm)

TOOL = sys.argv[1] if len(sys.argv) > 1 else 'provinceBrush'
OUT = os.path.join(ROOT, 'docs', 'assets', 's0-brush-20261019', 'one-%s.png' % TOOL)


def main():
    cdp = CDP()
    cdp.ws.settimeout(180)
    try:
        bust = int(time.time())
        cdp.navigate('http://localhost:5180/?one=%d' % bust)
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='导航', timeout=60)
        RT.apply_viewport(cdp)
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate('http://localhost:5180/?one=%d' % (bust + 1))
        wait_for(cdp, "!!document.querySelector('.app-layout')", desc='重载', timeout=60)
        RT.apply_viewport(cdp)
        wait_for(cdp, "document.querySelector('#app').__vue_app__._instance.setupState.store.nodes.length > 0",
                 timeout=45, desc='数据就绪')
        cdp.eval("window.confirm = () => true; window.alert = () => {}; window.prompt = () => 'S0';")
        print('project:', open_harness_project(cdp)[0])
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
        wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=30, desc='剧本模式')
        time.sleep(1.2)
        cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
                 ".find(x => (x.textContent || '').includes('丢弃备份')); if (b) b.click(); return 'ok'; })()")
        time.sleep(0.8)
        loaded = cdp.eval(bm.LOAD_JS.replace('__NAME__', json.dumps(bm.KEY)))
        print('load:', str(loaded)[:200])
        cdp.eval("window.confirm = () => true; window.alert = () => {};")
        cdp.eval("(() => { const sc = document.querySelector('.scenario-map-container').__vueParentComponent.setupState;"
                 " sc.setTool(%s); sc.provBrushTool = 'paint'; sc.provBrushRadius = 40; return 'ok'; })()" % json.dumps(TOOL))
        time.sleep(0.5)
        rect = json.loads(cdp.eval("JSON.stringify((() => { const sc = document.querySelector('.scenario-map-container')"
                                   ".__vueParentComponent.setupState; const r = sc.canvas.getBoundingClientRect();"
                                   " return { l: r.left, t: r.top, w: r.width, h: r.height }; })())"))
        pt = json.loads(cdp.eval("JSON.stringify(window.__S0.landPoint())"))
        print('rect:', rect, 'pt:', pt)
        if not pt:
            raise SystemExit('没有可用的陆地点')
        px = min(max(pt['x'], rect['l'] + 30), rect['l'] + rect['w'] - 30)
        py = min(max(pt['y'], rect['t'] + 30), rect['t'] + rect['h'] - 30)
        if TOOL in ('provinceBrush', 'provinceLasso'):
            print('pick:', cdp.eval("window.__S0.pick(%f, %f)" % (px, py)))
            time.sleep(0.2)
        before = json.loads(cdp.eval("JSON.stringify(window.__S0.stats())"))
        bm.shot(cdp, 'one-%s-before' % TOOL)
        if TOOL == 'provinceLasso':
            bm.stroke_loop(cdp, px, py, r=min(38, (rect['h'] - 60) / 2))
        else:
            bm.stroke_line(cdp, max(rect['l'] + 18, px - 45), max(rect['t'] + 18, py - 20),
                           min(rect['l'] + rect['w'] - 18, px + 45), min(rect['t'] + rect['h'] - 18, py + 20), 14)
        time.sleep(0.8)
        after = json.loads(cdp.eval("JSON.stringify(window.__S0.stats())"))
        print('before:', json.dumps(before, ensure_ascii=False)[:220])
        print('after :', json.dumps(after, ensure_ascii=False)[:320])
        print('geom  :', json.dumps(json.loads(cdp.eval("JSON.stringify(window.__S0.changed())")), ensure_ascii=False)[:600])
        print('shot  :', bm.shot(cdp, 'one-%s' % TOOL))
        return 0
    finally:
        cdp.close()


if __name__ == '__main__':
    sys.exit(main())
