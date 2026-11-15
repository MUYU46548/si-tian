#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看一眼：家具自绘形状的真机样子（只截图，不下结论）。

产物 `build/furniture-shape/`：
  01-before      内置符号（对照）
  02-drawing     绘制态（提示条 + 橙色轮廓 + 顶点 + 橡皮筋）
  03-custom      保存后的自定义形状（L 形柜 / 梯形床）
  04-reset       恢复默认后（回到内置符号）

用法：
  python scripts/tests/drill_furniture_shape.py
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

OUT_DIR = os.path.join(D.ROOT, 'build', 'furniture-shape')
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"


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

        cdp.eval("""(() => {
          const s = %s, iv = %s, bid = %s;
          const d = s.interiorData[bid]; const f = d.floors[0];
          (f.furniture || []).slice().forEach(x => s.removeFurniture(bid, f.id, x.id));
          const put = (type, name, x, y, w, h, rot) => s.addFurniture(bid, f.id, {
            name, type, x, y, width: w, height: h, rotation: rot || 0,
          });
          // 两件 120×60 的柜子并排，左边给自绘、右边留作对照
          put('chest', '柜子（自绘）', 200, 120, 120, 60);
          put('chest', '柜子（内置）', 380, 120, 120, 60);
          put('bed', '床', 200, 300, 200, 150);
          iv.editMode = true;
          iv.fitToFloor && iv.fitToFloor();
          return 1;
        })()""" % (STORE, IV, json.dumps(bid)))
        time.sleep(1.0)
        p1, s1 = D.shot(cdp, os.path.join(OUT_DIR, '01-before'))
        print('  · %s %s' % (p1, s1))

        # 绘制态：选中左边柜子 → 画一个 L 形（截图看提示条与橙色预览）
        cdp.eval("""(() => {
          const s = %s, iv = %s;
          const f = iv.currentFloor;
          const it = (f.furniture || [])[0];
          iv.selectedFurniture = it;
          iv.editMode = false;
          iv.startShapeEdit();
          // L 形：左下缺一块
          iv.addShapePoint(200, 120);
          iv.addShapePoint(320, 120);
          iv.addShapePoint(320, 150);
          iv.addShapePoint(260, 150);
          iv.addShapePoint(260, 180);
          iv.addShapePoint(200, 180);
          iv.shapeEdit.cursor = { x: 170, y: 150 };
          iv.renderer.requestRender();
          return 1;
        })()""" % (STORE, IV))
        time.sleep(0.7)
        p2, s2 = D.shot(cdp, os.path.join(OUT_DIR, '02-drawing'))
        print('  · %s %s' % (p2, s2))

        # 保存 → 看自定义形状渲染
        cdp.eval("""(() => {
          const iv = %s;
          const ok = iv.finishShapeEdit();
          return JSON.stringify({ ok, custom: (iv.currentFloor.furniture[0] || {}).custom ? 1 : 0 });
        })()""" % IV)
        time.sleep(0.7)
        p3, s3 = D.shot(cdp, os.path.join(OUT_DIR, '03-custom'))
        print('  · %s %s' % (p3, s3))

        # 恢复默认
        cdp.eval("""(() => {
          const iv = %s;
          iv.clearFurnitureShape();
          return 1;
        })()""" % IV)
        time.sleep(0.6)
        p4, s4 = D.shot(cdp, os.path.join(OUT_DIR, '04-reset'))
        print('  · %s %s' % (p4, s4))

        # 平滑：给床画一圈圆润的轮廓，看曲线是不是真的圆了
        cdp.eval("""(() => {
          const s = %s, iv = %s;
          const f = iv.currentFloor;
          const bed = f.furniture.find(x => x.type === 'bed');
          if (!bed) return 1;
          iv.selectedFurniture = bed;
          iv.startShapeEdit();
          const cx = bed.x + bed.width / 2, cy = bed.y + bed.height / 2;
          iv.shapeEdit.points = [];
          // 8 个点围一圈（近似椭圆），开平滑后应该看不到棱角
          for (let i = 0; i < 8; i++) {
            const a = (Math.PI * 2 * i) / 8;
            iv.shapeEdit.points.push({ x: cx + Math.cos(a) * bed.width * 0.5, y: cy + Math.sin(a) * bed.height * 0.5 });
          }
          iv.shapeEdit.smooth = true;
          iv.renderer.requestRender();
          return 1;
        })()""" % (STORE, IV))
        time.sleep(0.5)
        p5, s5 = D.shot(cdp, os.path.join(OUT_DIR, '05-smooth-drawing'))
        print('  · %s %s' % (p5, s5))
        cdp.eval("(() => { %s.finishShapeEdit(); return 1; })()" % IV)
        time.sleep(0.5)
        p6, s6 = D.shot(cdp, os.path.join(OUT_DIR, '06-smooth-saved'))
        print('  · %s %s' % (p6, s6))

        # 对齐参考线 + 画墙预览（A26）：起一段墙，光标停在右墙角附近
        cdp.eval("""(() => {
          const iv = %s;
          iv.editMode = true;
          iv.interactionMode = 'add_wall';
          const f = iv.currentFloor;
          const w = (f.walls || [])[0];
          iv.wallDraftStart = w ? { x: w.end.x, y: w.end.y } : { x: 0, y: 0 };
          iv.pointerWorld = { x: (w ? w.end.x : 0) + 160, y: (w ? w.end.y : 0) + 60 };
          iv.renderer.requestRender();
          return 1;
        })()""" % IV)
        time.sleep(0.5)
        p7, s7 = D.shot(cdp, os.path.join(OUT_DIR, '07-align-guides'))
        print('  · %s %s' % (p7, s7))

        # 快捷键一览（A27）
        cdp.eval("(() => { const iv = %s; iv.wallDraftStart = null; iv.editMode = false; iv.shortcutsHelpOpen = true; return 1; })()" % IV)
        time.sleep(0.6)
        p8, s8 = D.shot(cdp, os.path.join(OUT_DIR, '08-shortcuts'))
        print('  · %s %s' % (p8, s8))
        cdp.eval("(() => { %s.shortcutsHelpOpen = false; return 1; })()" % IV)
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
