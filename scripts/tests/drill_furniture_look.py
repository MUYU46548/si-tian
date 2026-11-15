#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""家具符号放大检视（2026-11-14，用户："有的像推翻了压在地上，特别是柜子"）。

把每类家具摆一排、放大到能看清笔画，截图存 `build/furniture-look/`。
用法：
  python scripts/tests/drill_furniture_look.py
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D  # noqa: E402
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'furniture-look')

ITEMS = [
    ('bed', '床', 0, 0, 200, 150, 0),
    ('bed', '床·旋转90', 260, 0, 200, 150, 90),
    ('table', '桌', 520, 0, 140, 80, 0),
    ('chair', '椅', 700, 0, 45, 45, 0),
    ('chest', '柜子 120×60', 0, 220, 120, 60, 0),
    ('chest', '柜子 60×120', 180, 220, 60, 120, 0),
    ('wardrobe', '衣柜 180×60', 300, 220, 180, 60, 0),
    ('sofa', '沙发', 540, 220, 220, 90, 0),
    ('sofa', '沙发·旋转90', 820, 220, 220, 90, 90),
    ('door', '门', 0, 420, 90, 200, 0),
    ('window', '窗', 200, 420, 120, 140, 0),
    ('generic', '通用', 400, 420, 100, 100, 0),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    handles = []
    cdp = None
    mock_ready = False
    try:
        D.RT.setup_mock()
        mock_ready = True
        D.ensure_vite(handles)
        handles.append(D.start_edge())
        cdp = CDP(ws_url=find_page_ws(D.PORT, prefer_prefix='http://localhost:5180'))
        cdp.send('Page.enable')
        cdp.send('Emulation.setDeviceMetricsOverride', {
            'width': 1440, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False,
        })
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='应用挂载')
        cdp.eval("localStorage.setItem('sitian-first-run-complete', 'true')")
        cdp.navigate(APP_URL)
        wait_for(cdp, "!!document.querySelector('.app-layout')", timeout=45, desc='重载')
        wait_for(cdp, "!document.querySelector('.onboarding-overlay')", timeout=30, desc='引导层')
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

        items = [dict(zip(['type', 'name', 'x', 'y', 'w', 'h', 'rot'], i)) for i in ITEMS]
        st = cdp.eval("""(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          const bid = %s;
          let d = s.interiorData[bid];
          if (!d || !(d.floors || []).length) s.addFloor(bid, '检视层');
          d = s.interiorData[bid];
          const f = d.floors[0];
          (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
          (f.furniture || []).slice().forEach(x => s.removeFurniture(bid, f.id, x.id));
          const items = %s;
          for (const it of items) {
            s.addFurniture(bid, f.id, {
              name: it.name, type: it.type, x: it.x, y: it.y,
              width: it.w, height: it.h, rotation: it.rot,
            });
          }
          iv.editMode = true;
          iv.fitToFloor && iv.fitToFloor();
          return JSON.stringify({ fid: f.id, n: (f.furniture || []).length });
        })()""" % (json.dumps(bid), json.dumps(items)))
        print('  · 摆件：%s' % st)
        time.sleep(0.8)
        p, s1 = D.shot(cdp, os.path.join(OUT_DIR, '01-furniture-row'))
        print('  · %s %s' % (p, s1))

        # 放大到 2.6 px/cm 看笔画（柜子那一片）
        cdp.eval("""(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          iv.renderer.focusOn(300, 250, 2.6);
          return 1;
        })()""")
        time.sleep(0.5)
        p2, s2 = D.shot(cdp, os.path.join(OUT_DIR, '02-zoom-chest'))
        print('  · %s %s' % (p2, s2))
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
    return 0


if __name__ == '__main__':
    sys.exit(main())
