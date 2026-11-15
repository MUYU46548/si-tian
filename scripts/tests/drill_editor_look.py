#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看一眼：建筑内部编辑器现在的真实样子（只截图，不下结论）。

用途：暮雨说"做出来的东西根本不值得看"——先把它**拍下来**，逐项对着截图说哪里不行，
而不是凭印象改。产物 `build/editor-look/`。

用法：
  C:/Users/muyu/AppData/Local/Microsoft/WindowsApps/python.exe scripts/tests/drill_editor_look.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'lib'))
sys.path.insert(0, os.path.dirname(__file__))

import drill_exterior_3d as D  # noqa: E402
from lib.cdp import CDP, APP_URL, find_page_ws, skip_onboarding, wait_for  # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

OUT_DIR = os.path.join(D.ROOT, 'build', 'editor-look')


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
        # 恢复提示层（.recovery-overlay）会**盖住整页**：上一次异常退出留下的未保存备份。
        # 不点掉的话截图里只有这个弹窗（2026-11-14 第一次跑就中）。
        cdp.eval("""(() => {
          const b = document.querySelector('.recovery-overlay .btn-discard');
          if (b) b.click();
          return 1;
        })()""")
        time.sleep(0.3)
        wait_for(cdp, "!document.querySelector('.recovery-overlay')", timeout=10, desc='恢复提示已关')
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
        # 摆几件真尺寸家具（床 200×150 / 桌 140×80 / 椅 45×45 / 沙发 220×90），
        # 否则截图上只有墙，判断不了"家具像不像东西"
        cdp.eval("""(() => {
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          const bid = %s;
          const d = s.interiorData[bid]; const f = d.floors[0];
          (f.furniture || []).slice().forEach(x => s.removeFurniture(bid, f.id, x.id));
          const put = (type, name, x, y, w, h, rot) => s.addFurniture(bid, f.id, {
            name, type, x, y, width: w, height: h, rotation: rot || 0,
          });
          put('bed', '床', 60, 60, 200, 150);
          put('table', '书桌', 320, 80, 140, 80);
          put('chair', '椅子', 380, 190, 45, 45);
          put('sofa', '沙发', 600, 60, 220, 90);
          put('wardrobe', '衣柜', 620, 380, 180, 60);
          put('chest', '柜子', 200, 430, 120, 60);
          iv.fitToFloor && iv.fitToFloor();
          return 1;
        })()""" % __import__('json').dumps(bid))
        time.sleep(1.2)
        p1, s1 = D.shot(cdp, os.path.join(OUT_DIR, '01-editor-browse'))
        print('  · %s %s' % (p1, s1))
        # 编辑态（工具栏 + 参考图面板之外的另一半）
        cdp.eval("""(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          iv.editMode = true; iv.interactionMode = 'pan';
          return 1;
        })()""")
        time.sleep(0.8)
        p2, s2 = D.shot(cdp, os.path.join(OUT_DIR, '02-editor-edit-mode'))
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
