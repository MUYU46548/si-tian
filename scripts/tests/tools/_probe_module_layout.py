#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：历史剧本模块的**布局独立性**实测（2026-10-18 暮雨第 1/4 条反馈）。

要回答的问题（全部靠 DOM 实测，不靠读代码猜）：
  A. 卡片墙是否真的盖满视口、左下角有没有露出导航树/工具栏（穿帮）。
  B. 编辑器（ScenarioMap）在 `.main-content` 里是否与**行星地图**同屏共存 —— 也就是
     「历史剧本是一个大号图层盖在顶上」这条反馈能不能被复现。
  C. 若共存：谁的 z-index / DOM 次序在上、画布中心点 elementFromPoint 命中的是谁
     （命中谁 = 用户点得到谁，这是"被盖住"最硬的判据）。
  D. 用树的「双击 → jumpToNode」这条**产品路径**制造共存（不是直接改 viewLevel），
     保证复现的是用户真实走过的路。
用法（lab 必须先 up）：
  python scripts/tests/tools/_probe_module_layout.py
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


def layout_probe(label):
    """把当前可见视图的层叠事实原样取回来（矩形 / z-index / 中心点命中）。"""
    return """(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = (el) => { if (!el) return null; const c = getComputedStyle(el);
    return { pos: c.position, z: c.zIndex, disp: c.display, vis: c.visibility,
             pe: c.pointerEvents, overflow: c.overflow }; };
  const views = ['.scenario-picker','.scenario-map-container','.world-selector','.galaxy-map-container',
                 '.system-view','.system-detail-view','.planet-map-container','.area-map-container','.interior-container'];
  const present = {};
  for (const s of views) { const el = document.querySelector(s);
    if (el) present[s] = { box: box(el), css: cs(el), testid: el.dataset.testid || null }; }
  const mc = document.querySelector('.main-content');
  const mcBox = box(mc);
  // 中心点命中：谁在画布正中央（用户点得到谁）
  const cx = Math.round(mcBox ? mcBox.x + mcBox.w / 2 : innerWidth / 2);
  const cy = Math.round(mcBox ? mcBox.y + mcBox.h / 2 : innerHeight / 2);
  const hit = document.elementFromPoint(cx, cy);
  const hitPath = [];
  for (let e = hit; e && hitPath.length < 5; e = e.parentElement) {
    hitPath.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string'
      ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''));
  }
  // 左下角（导航树 / 状态栏穿帮区）命中
  const bl = document.elementFromPoint(110, innerHeight - 14);
  const blPath = [];
  for (let e = bl; e && blPath.length < 4; e = e.parentElement) {
    blPath.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string'
      ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''));
  }
  const tree = document.querySelector('.tree-navigation');
  const treeBox = box(tree);
  // 导航树的矩形与卡片墙/编辑器矩形的交叠面积
  const inter = (a, b) => { if (!a || !b) return 0;
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return Math.round(w * h); };
  const st = document.querySelector('#app').__vue_app__._instance.setupState;
  return JSON.stringify({
    label: %r,
    viewport: { w: innerWidth, h: innerHeight },
    viewLevel: st.store.viewLevel,
    scenarioMode: st.scenarioMode,
    pickerVisible: st.scenarioPickerVisible,
    present,
    tree: { box: treeBox, css: cs(tree) },
    overlapTreeWithPicker: inter(treeBox, present['.scenario-picker'] ? present['.scenario-picker'].box : null),
    overlapTreeWithScenario: inter(treeBox, present['.scenario-map-container'] ? present['.scenario-map-container'].box : null),
    overlapScenarioWithPlanet: inter(
      present['.scenario-map-container'] ? present['.scenario-map-container'].box : null,
      present['.planet-map-container'] ? present['.planet-map-container'].box : null),
    centerHit: hitPath,
    bottomLeftHit: blPath,
    fails: [],
  });
})()""" % label


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
    ok, info = open_harness_project(cdp)
    print('harness project:', ok, str(info)[:160])

    out = {}
    out['s0_世界选择页'] = json.loads(cdp.eval(layout_probe('s0')))

    # ── s1：点「历史剧本」→ 卡片墙
    cdp.eval("(() => { const b = Array.from(document.querySelectorAll('button'))"
             ".find(x => (x.textContent || '').includes('历史剧本')); if (b) b.click(); return 'ok'; })()")
    time.sleep(1.2)
    out['s1_卡片墙'] = json.loads(cdp.eval(layout_probe('s1')))
    try:
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        import base64 as _b64
        p = os.path.join(ROOT, 'docs', 'assets', 'lab-module-picker.png')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'wb').write(_b64.b64decode(shot['data']))
        print('shot ->', p)
    except Exception as e:
        print('shot picker failed:', e)

    # ── s2：进编辑器（卡片墙有卡就点第一张，否则走空态的「进入编辑器」）
    has_cards = cdp.eval("!!document.querySelector('[data-testid=sp-cards]')")
    print('has_cards =', has_cards)
    if has_cards:
        cdp.eval("(() => { const c = document.querySelector('.sp-card'); if (c) c.click(); return 'ok'; })()")
    else:
        cdp.eval("(() => { const b = document.querySelector('[data-testid=sp-empty-editor]')"
                 " || document.querySelector('[data-testid=sp-new]'); if (b) b.click(); return 'ok'; })()")
    wait_for(cdp, "!!document.querySelector('.scenario-map-container')", timeout=25, desc='剧本编辑器挂载')
    time.sleep(1.0)
    out['s2_编辑器'] = json.loads(cdp.eval(layout_probe('s2')))
    try:
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        import base64 as _b64
        p = os.path.join(ROOT, 'docs', 'assets', 'lab-module-editor.png')
        open(p, 'wb').write(_b64.b64decode(shot['data']))
        print('shot ->', p)
    except Exception as e:
        print('shot editor failed:', e)

    # ── s3：**产品路径**：导航树里双击一个行星 → jumpToNode → viewLevel='planet'
    #     （用户原话：想测行星地图，点导航栏双击几遍都出不来）
    dbl = """(() => {
      const items = Array.from(document.querySelectorAll('.tree-navigation .tree-item'));
      if (!items.length) return JSON.stringify({ ok: false, reason: '树里没有节点' });
      // 找到一个能双击出视图的项：优先 planet 层
      let target = null, info = [];
      for (const it of items) {
        const vm = it.__vueParentComponent;
        const node = vm && vm.props && vm.props.node;
        if (!node) continue;
        info.push(node.layer + ':' + node.name);
        if (!target && node.layer === 'planet') target = it;
      }
      if (!target) return JSON.stringify({ ok: false, reason: '树里没有 planet 节点', layers: info.slice(0, 20) });
      const node = target.__vueParentComponent.props.node;
      target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return JSON.stringify({ ok: true, layer: node.layer, name: node.name, id: node.id });
    })()"""
    r = cdp.eval(dbl)
    print('tree dblclick ->', r)
    time.sleep(1.2)
    out['s3_树双击行星后'] = json.loads(cdp.eval(layout_probe('s3')))
    try:
        shot = cdp.send('Page.captureScreenshot', {'format': 'png'})
        import base64 as _b64
        p = os.path.join(ROOT, 'docs', 'assets', 'lab-module-after-tree-dbl.png')
        open(p, 'wb').write(_b64.b64decode(shot['data']))
        print('shot ->', p)
    except Exception as e:
        print('shot s3 failed:', e)

    print('\n=== RESULT ===')
    print(json.dumps(out, ensure_ascii=False, indent=1))
    cdp.close()


if __name__ == '__main__':
    main()
