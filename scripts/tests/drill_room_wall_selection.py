#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真机演练：房间单击选中（A29）+ 多选墙批量删（A30）

两件都是**交互**，源码闸门与纯函数单测都碰不到，只能在真机上点：

  1) 点房间里的空白 → 工具条出现“房间名 · 面积”（A29），画布中心像素**真的变了**（高亮生效）；
  2) 点一面墙、Shift 点第二面 → 工具条出现“2 面墙已选”（A30）；
  3) 点“删除选中” → 墙从 5 面变 3 面；**一次 Ctrl+Z 全部回来**（证明是一条 undo，不是 N 条）；
  4) 负向探针：没有选中时工具条不出现（不会一直挂着一条空工具条）。

复用 `drill_exterior_3d` 的起环境与造房子（两层小楼：4 面外墙 + 1 道内隔墙 = 两个房间）。

用法：python scripts/tests/drill_room_wall_selection.py
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

def log(msg):
    print(msg, flush=True)


def text_of(cdp, sel):
    return cdp.eval(
        "(() => { const el = document.querySelector(%s); return el ? el.textContent.trim() : ''; })()"
        % json.dumps(sel)
    ) or ''


def walls_count(cdp):
    expr = """(() => {
      const s = %s;
      const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
      const bid = s.currentBuilding && s.currentBuilding.id;
      const d = bid ? s.interiorData[bid] : null;
      if (!d) return -1;
      const cur = (d.floors || []).find(f => f.id === iv.currentFloorId) || (d.floors || [])[0];
      return cur ? (cur.walls || []).length : -1;
    })()""" % D.STORE
    v = cdp.eval(expr)
    try:
        return int(v)
    except (TypeError, ValueError):
        return -1


def center_pixels(cdp):
    """画布中心 120×120 的像素指纹（高亮是否真的画出来了）。"""
    expr = """(() => {
      const cv = document.querySelector('.interior-container canvas');
      if (!cv) return -1;
      const c = cv.getContext('2d');
      const w = Math.min(120, cv.width), h = Math.min(120, cv.height);
      const d = c.getImageData(Math.floor(cv.width/2 - w/2), Math.floor(cv.height/2 - h/2), w, h).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s = (s + d[i] * 3 + d[i+1] * 5 + d[i+2] * 7) % 1000000007;
      return s;
    })()"""
    v = cdp.eval(expr)
    try:
        return int(v)
    except (TypeError, ValueError):
        return -1


def main():
    handles = []
    cdp = None
    fails = []
    mock_ready = False
    try:
        log('  · 注入回归 mock 数据…')
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
        cdp.eval("(() => { const b = document.querySelector('.recovery-overlay .btn-discard'); if (b) b.click(); return 1; })()")
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
        # 页面报错要自己挂监听（读一个没人写的变量 = 假绿）
        cdp.eval("window.__rwErrs = [];"
                 "window.addEventListener('error', e => window.__rwErrs.push(String(e.message || e)));"
                 "window.addEventListener('unhandledrejection', e => window.__rwErrs.push('rejection: ' + String(e.reason)));"
                 "1")
        D.build_house(cdp, bid)
        time.sleep(1.0)
        # build_house 最后把 editMode 设成 false（出图用）。工具条与墙的命中都在编辑模式下才生效 ——
        # 第一版忘了这一条，点了半天“没反应”，其实只是工具栏整块没渲染。
        D.eval_json(cdp, """(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          iv.editMode = true;
          return JSON.stringify({ editMode: iv.editMode });
        })()""")
        time.sleep(0.6)

        w0 = walls_count(cdp)
        log('  · 起始墙数：%s' % w0)
        if w0 != 5:
            fails.append('起始墙数应为 5（4 外墙 + 1 内隔墙），实际 %s' % w0)

        # 诊断：房间是否被检测出来、是否在编辑模式（工具条只在编辑模式渲染）
        diag = D.eval_json(cdp, """(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          const f = iv.currentFloor;
          return JSON.stringify({
            rooms: (f && f.rooms || []).length,
            walls: (f && f.walls || []).length,
            editMode: !!iv.editMode,
            mode: iv.interactionMode,
          });
        })()""")
        log('  · 诊断：%s' % json.dumps(diag, ensure_ascii=False))

        # 负向探针：什么都没选时两条工具条都不该在
        if text_of(cdp, '[data-testid=room-selected]'):
            fails.append('没点房间却已经有房间工具条')
        if text_of(cdp, '[data-testid=walls-selected]'):
            fails.append('没选墙却已经有多选墙工具条')

        # ① 点房间里的空白（大厅中心，世界坐标 260,325）
        before = center_pixels(cdp)
        # ⚠️ 这里直接调组件自己的点击处理（世界坐标），不走 CDP 模拟鼠标：
        #    renderer 的「屏幕 → 世界」换算有它自己的 DPR/偏移口径，用它来测选中会把
        #    两件事混在一起（第一版就是这样：点在 CANVAS 上却没选中）。
        #    本 drill 要验的是“选中逻辑 + 高亮 + 批量删 + 一条 undo”，坐标换算交给别的用例。
        D.eval_json(cdp, """(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          iv.handleCanvasClick(null, 260, 325);
          return JSON.stringify({ ok: true });
        })()""")
        time.sleep(0.4)
        room_text = text_of(cdp, '[data-testid=room-selected]')
        after = center_pixels(cdp)
        log('  · 点房间 → 工具条：%r' % room_text)
        log('  · 画布中心指纹：%s → %s' % (before, after))
        if not room_text:
            fails.append('点房间空白后没有出现“房间名 · 面积”工具条（A29 没生效）')
        elif '㎡' not in room_text and 'cm' not in room_text:
            fails.append('房间工具条没有面积：%r' % room_text)
        if before == after:
            fails.append('选中房间后画布中心像素没变 —— 高亮没画出来')

        # ② 点外墙下边（世界 450,650），再 Shift 点内隔墙（世界 520,325）
        #    同样直接调组件的 dragStart（墙的选中在 pointerdown 里做）
        D.eval_json(cdp, """(() => {
          const iv = document.querySelector('.interior-container').__vueParentComponent.setupState;
          iv.handleDragStart(450, 650, 0, false, false, null);
          iv.handleDragStart(520, 325, 0, true, false, null);
          return JSON.stringify({ walls: iv.selectedWallIds ? iv.selectedWallIds.length : -1 });
        })()""")
        time.sleep(0.4)
        wall_text = text_of(cdp, '[data-testid=walls-selected]')
        log('  · 点两面墙 → 工具条：%r' % wall_text)
        if '2 面墙已选' not in wall_text:
            fails.append('Shift 点第二面墙后应为“2 面墙已选”，实际 %r' % wall_text)

        # ③ 删（confirm 会弹窗：先把它换成恒 true，免得演练卡在对话框上）
        cdp.eval("window.confirm = () => true; 1")
        clicked = D.eval_json(cdp, """(() => {
          const b = document.querySelector('[data-testid=walls-delete]');
          if (!b) return JSON.stringify({ err: 'no-button' });
          b.click();
          return JSON.stringify({ ok: true });
        })()""")
        if clicked.get('err'):
            fails.append('“删除选中”按钮不可用：%s' % clicked['err'])
        time.sleep(0.8)
        w1 = walls_count(cdp)
        log('  · 删后墙数：%s' % w1)
        if w1 != 3:
            fails.append('删两面墙后应剩 3 面，实际 %s' % w1)
        if text_of(cdp, '[data-testid=walls-selected]'):
            fails.append('删完后多选墙工具条还挂着（选中没清）')

        # ④ 一次撤销全部回来（证明是一条 undo）
        cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); 1")
        time.sleep(0.8)
        w2 = walls_count(cdp)
        log('  · Ctrl+Z 后墙数：%s' % w2)
        if w2 != 5:
            fails.append('一次 Ctrl+Z 应把两面墙一起恢复（5 面），实际 %s —— 说明删成了 N 条 undo' % w2)

        # ⑤ 页面零报错
        errs = cdp.eval("(window.__rwErrs || []).slice(0, 5)") or []
        if errs:
            fails.append('页面报错：%s' % errs)

        if fails:
            log('\n❌ 房间选中 / 多选墙没通过：')
            for f in fails:
                log('  - %s' % f)
            return 1
        log('\n✅ 房间单击选中 + 多选墙批量删 全通过')
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
