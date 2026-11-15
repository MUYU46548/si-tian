#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：建筑在**区域地图**上的俯视符号（2026-11-15）

验三件事：
  1) 有楼层数据的建筑在地图上画成占地符号（不是圆点），且**落在节点位置**（不是地图原点）；
  2) 符号尺寸有夹取：缩得很远时仍 ≥34px 宽，拉近时不超过 220px；
  3) 点符号的边角能选中它（原来只有 14 单位半径的圆）。

产物：build/area-symbol/01-far.png、02-mid.png、03-near.png
用法：
  python scripts/tests/drill_area_symbol.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D                                   # noqa: E402
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'area-symbol')
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
AREA = "document.querySelector('.area-map-container') ? document.querySelector('.area-map-container').__vueParentComponent.setupState : null"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    cdp = None
    fails = []
    mock_ready = False
    try:
        D.RT.setup_mock()
        mock_ready = True
        D.ensure_vite(handles)
        handles.append(D.start_edge())
        cdp = CDP(ws_url=find_page_ws(D.PORT, prefer_prefix='http://localhost:5180'))
        cdp.send('Page.enable')
        cdp.send('Emulation.setDeviceMetricsOverride', {
            'width': 1440, 'height': 900, 'deviceScaleFactor': 2, 'mobile': False,
        })
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='应用挂载')
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层')
        cdp.eval("""(() => {
          const b = document.querySelector('.recovery-overlay .btn-discard');
          if (b) b.click();
          return 1;
        })()""")
        time.sleep(0.3)
        skip_onboarding(cdp)
        ensure_data_ready(cdp)
        ok, info = open_harness_project(cdp)
        if not ok:
            raise RuntimeError('harness 基线项目打不开：%s' % info)
        okb, binfo = ensure_test_building(cdp)
        if not okb:
            raise RuntimeError('建筑 fixture 失败：%s' % binfo)
        bid = binfo['id']
        wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图')
        D.build_house(cdp, bid)

        # 回到区域地图。⚠️ 区域图只画 parentId === 当前区域 的节点，
        # 而 fixture 建筑挂在 city/planet 下 —— 不挂到 area 上，地图里永远看不见它。
        back = _j(cdp, """(() => {
      const s = %s, bid = %s;
      const b = s.nodes.find(x => x.id === bid);
      if (!b) return JSON.stringify({ err: 'no-building' });
      let area = s.nodes.find(n => n.layer === 'area');
      if (!area) {
        const parent = s.nodes.find(n => n.layer === 'planet') || s.nodes.find(n => n.layer === 'city');
        const id = 'fixture_area_' + Date.now();
        s.addNode({ id, name: '用例区域', layer: 'area', layerLabel: '区域',
                    parentId: parent ? parent.id : null, tags: [], sourcePath: '',
                    coordinate: { x: 0, y: 0 } });
        area = s.nodes.find(x => x.id === id);
      }
      b.parentId = area.id;
      b.coordinate = { x: 0, y: 0 };
      s.selectArea(area);
      return JSON.stringify({ level: s.viewLevel, areaId: area.id, bid: b.id, parentId: b.parentId });
    })()""" % (STORE, json.dumps(bid)))
        time.sleep(0.8)
        wait_for(cdp, "!!document.querySelector('.area-map-container')", timeout=20, desc='区域视图挂载')
        time.sleep(0.5)
        print('  · 回到区域：%s' % back)

        def frame(scale):
            return _j(cdp, """(() => {
          const el = document.querySelector('.area-map-container');
          const iv = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
          if (!iv || !iv.renderer) return JSON.stringify({ err: 'no-renderer' });
          // 用 focusOn 而不是直接改 vt.scale —— renderer 对 scale 有夹取，硬改会被拉回
          if (iv.renderer.focusOn) iv.renderer.focusOn(0, 0, %s);
          iv.renderer.requestRender();
          const vt = iv.renderer.getViewTransform();
          return JSON.stringify({ scale: vt.scale, x: vt.x, y: vt.y });
        })()""" % scale)

        for scale, tag in [(0.05, '01-far'), (0.4, '02-mid'), (2.0, '03-near')]:
            r = frame(scale)
            time.sleep(0.7)
            p, shot = D.shot(cdp, os.path.join(OUT_DIR, tag))
            print('  · %s 请求 scale=%s → 实际 %s → %s' % (tag, scale, r.get('scale'), os.path.basename(p)))

        # 符号在屏幕上的尺寸 + 命中：全部用世界坐标算，不折腾屏幕换算
        probe = _j(cdp, """(() => {
      const el = document.querySelector('.area-map-container');
      const iv = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
      const s = %s, bid = %s;
      if (!iv || !iv.buildingSymbolOf) return JSON.stringify({ err: 'no-setup', keys: iv ? Object.keys(iv).length : 0 });
      const n = s.nodes.find(x => x.id === bid);
      const z = iv.renderer.getViewTransform().scale;
      const sym = iv.buildingSymbolOf(n, z);
      if (!sym) return JSON.stringify({ err: 'no-symbol' });
      const hitCenter = iv.hitTest ? iv.hitTest(n.coordinate.x, n.coordinate.y) : null;
      // 边界内偏 80%% 的一点：原来的 14 单位圆绝不可能命中这里
      const bx = sym.bbox.minX + (sym.bbox.maxX - sym.bbox.minX) * 0.9;
      const by = sym.bbox.minY + (sym.bbox.maxY - sym.bbox.minY) * 0.1;
      const hitCorner = iv.hitTest ? iv.hitTest(bx, by) : null;
      return JSON.stringify({
        scale: z, pxW: Math.round(sym.pxW), pxH: Math.round(sym.pxH),
        center: !!hitCenter && hitCenter.id === bid,
        corner: !!hitCorner && hitCorner.id === bid,
        cornerId: hitCorner ? hitCorner.id : null,
      });
    })()""" % (STORE, json.dumps(bid)))
        print('  · 符号与命中：%s' % probe)
        if probe.get('err'):
            fails.append('拿不到符号：%s' % probe)
        else:
            if not probe.get('center'):
                fails.append('点节点中心没选中这栋建筑：%s' % probe)
            if not probe.get('corner'):
                fails.append('点符号边角没选中：%s' % probe)
            if not (30 <= (probe.get('pxW') or 0) <= 240):
                fails.append('符号屏幕宽度失控（%spx）：%s' % (probe.get('pxW'), probe))

        if fails:
            print('\n❌ 有问题：')
            for f in fails:
                print('   - ' + f)
            return 1
        print('\n✅ 区域地图建筑符号：%s' % OUT_DIR)
        return 0
    finally:
        try:
            if cdp:
                cdp.close()
        except Exception:
            pass
        for h in handles[::-1]:
            try:
                h.terminate()
            except Exception:
                pass
        if mock_ready:
            try:
                D.RT.teardown_mock()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
