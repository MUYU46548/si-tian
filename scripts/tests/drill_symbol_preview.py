#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""看样图：建筑在地图上的**俯视符号**长什么样（2026-11-15）

这是纯预览 —— 产品里**还没接**（AreaMap 一行没动）。脚本在页面里直接 import 模块，
按"地图视角"把几种典型平面并排画出来，截图给人看。

产物：build/building-symbol/preview.png（含真实 harness 建筑 + 四种典型平面）

用法：
  C:/Users/muyu/AppData/Local/Microsoft/WindowsApps/python.exe scripts/tests/drill_symbol_preview.py
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

OUT_DIR = os.path.join(D.ROOT, 'build', 'building-symbol')


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
            'width': 1280, 'height': 1000, 'deviceScaleFactor': 2, 'mobile': False,
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

        # 在页面里造一块画布，把这几种平面并排画出来
        made = cdp.eval("""(async () => {
          const m = await import('/src/interior/buildingSymbol.js');
          const s = document.querySelector('#app').__vue_app__._instance.setupState.store;
          const floors = (s.interiorData[__BID__] || {}).floors || [];

          const W = 1180, H = 940;
          const cv = document.createElement('canvas');
          cv.width = W * 2; cv.height = H * 2;
          cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;width:' + W + 'px;height:' + H
            + 'px;background:#f6f3ea';
          document.body.appendChild(cv);
          const ctx = cv.getContext('2d');
          ctx.scale(2, 2);
          ctx.fillStyle = '#f6f3ea';
          ctx.fillRect(0, 0, W, H);

          const cell = (x, y, w, h, title, sub) => {
            ctx.save();
            ctx.strokeStyle = '#e2dccd';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            ctx.fillStyle = '#5a5245';
            ctx.font = '600 13px "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(title, x + 12, y + 10);
            ctx.fillStyle = '#8a8171';
            ctx.font = '11px "Microsoft YaHei", sans-serif';
            ctx.fillText(sub, x + 12, y + 28);
            ctx.restore();
          };

          // 四种典型平面（w×d，墙厚 12）
          const rect = (w, d, t = 12) => ([
            { start: { x: 0, y: 0 }, end: { x: w, y: 0 }, thickness: t, height: 280 },
            { start: { x: w, y: 0 }, end: { x: w, y: d }, thickness: t, height: 280 },
            { start: { x: w, y: d }, end: { x: 0, y: d }, thickness: t, height: 280 },
            { start: { x: 0, y: d }, end: { x: 0, y: 0 }, thickness: t, height: 280 },
          ]);
          const Lshape = (t = 12) => ([
            { start: { x: 0, y: 0 }, end: { x: 600, y: 0 }, thickness: t, height: 280 },
            { start: { x: 600, y: 0 }, end: { x: 600, y: 300 }, thickness: t, height: 280 },
            { start: { x: 600, y: 300 }, end: { x: 300, y: 300 }, thickness: t, height: 280 },
            { start: { x: 300, y: 300 }, end: { x: 300, y: 600 }, thickness: t, height: 280 },
            { start: { x: 300, y: 600 }, end: { x: 0, y: 600 }, thickness: t, height: 280 },
            { start: { x: 0, y: 600 }, end: { x: 0, y: 0 }, thickness: t, height: 280 },
          ]);
          const cases = [
            { name: '民居 900×650 · 四坡', walls: rect(900, 650), roof: 'hip' },
            { name: '民居 900×650 · 双坡', walls: rect(900, 650), roof: 'gable' },
            { name: '长屋 1200×420 · 四坡', walls: rect(1200, 420), roof: 'hip' },
            { name: '方院 800×800 · 平顶', walls: rect(800, 800), roof: 'flat' },
            { name: 'L 形 · 四坡（凸包填平）', walls: Lshape(), roof: 'hip' },
            { name: 'L 形 · 双坡（凸包填平）', walls: Lshape(), roof: 'gable' },
          ];

          const pad = 40;
          const cellW = (W - pad * 3) / 2;
          const cellH = (H - 56 - pad * 4 - 40) / 3;
          let i = 0;
          for (const c of cases) {
            const col = i % 2, row = Math.floor(i / 2);
            const x = pad + col * (cellW + pad);
            const y = 56 + row * (cellH + pad);
            const fp = m.buildFootprint([{ walls: c.walls, elevation: 0 }]);
            if (!fp) { cell(x, y, cellW, cellH, c.name, '没有墙'); i++; continue; }
            // 缩放到格子里（留 60px 给标题）
            const z = Math.min((cellW - 80) / (fp.bbox.maxX - fp.bbox.minX), (cellH - 120) / (fp.bbox.maxY - fp.bbox.minY));
            ctx.save();
            ctx.translate(x + cellW / 2, y + cellH / 2 + 16);
            ctx.scale(z, z);
            ctx.translate(-(fp.bbox.minX + fp.bbox.maxX) / 2, -(fp.bbox.minY + fp.bbox.maxY) / 2);
            m.drawBuildingSymbol(ctx, fp, { zoom: z, roof: c.roof });
            ctx.restore();
            const size = m.symbolScreenSize(fp, z);
            cell(x, y, cellW, cellH, c.name,
              '占地 ' + (fp.area / 1e4).toFixed(1) + ' m² · ' + Math.round(fp.rect.long) + '×' + Math.round(fp.rect.short) + ' cm · 屏幕上 ' + Math.round(size.w) + 'px 宽');
            i++;
          }

          // 底部说明
          ctx.fillStyle = '#8a8171';
          ctx.font = '12px "Microsoft YaHei", sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText('这是地图视角下的俯视符号：屋顶色块 + 墨线轮廓 + 一点点投影。还没接进 AreaMap，先看形态。', pad, H - 14);

          window.__preview = cv;
          return JSON.stringify({ ok: true, w: cv.width, h: cv.height });
        })()""".replace('__BID__', json.dumps(bid)))
        print('  · 画布：%s' % made)
        time.sleep(0.8)
        p, s = D.shot(cdp, os.path.join(OUT_DIR, 'preview'))
        print('  · %s %s' % (p, s))
        print('\n✅ 符号样图：%s' % os.path.join(OUT_DIR, 'preview.png'))
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
