#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 174：对齐辅助线 + 正交约束（2026-11-15，台账 A26）

以前画墙只有网格吸附：想在别人墙的正对面接一段，只能靠眼睛；画完房间才发现差 3cm 围不上。
本用例守的是"吸得住 + 看得见"，全部走真实鼠标与真实 keydown。

  a) 画墙两点成墙
  b) 端点吸附：第二点落在离已有墙角 5cm 处 → 实际落点精确等于墙角（房间才围得出来）
  c) 轴线吸附：与已有墙的端点共线 → 对齐到那条线
  d) 正交（按住 Shift）：第二点的 y 必须等于起点 y（不管光标歪多少）
  e) 松开 Shift → 不再正交（不能一直卡在正交）
  f) hover 时对齐参考线真的被设上（有吸附就必须有参考线，否则用户不知道为什么跳）
  g) 拖墙角也吸附：拖到另一个墙角附近 → 落到精确坐标
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for                                    # noqa: E402
from lib.helpers import ensure_data_ready, ensure_test_building  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
CANVAS = "document.querySelector('.interior-container .canvas-wrapper canvas')"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def to_screen(cdp, wx, wy):
    return _j(cdp, """(() => {
      const iv = %s, c = %s;
      const vt = iv.renderer.getViewTransform();
      const r = c.getBoundingClientRect();
      return JSON.stringify({
        x: r.left + r.width / 2 + ((%s) * vt.scale + vt.x),
        y: r.top + r.height / 2 + ((%s) * vt.scale + vt.y),
      });
    })()""" % (IV, CANVAS, wx, wy))


def click_world(cdp, wx, wy):
    p = to_screen(cdp, wx, wy)
    _j(cdp, """(() => {
      const c = %s;
      const opt = { clientX: %s, clientY: %s, bubbles: true, cancelable: true, button: 0 };
      c.dispatchEvent(new MouseEvent('mousedown', opt));
      c.dispatchEvent(new MouseEvent('mouseup', opt));
      return JSON.stringify({});
    })()""" % (CANVAS, p['x'], p['y']))


def hover_world(cdp, wx, wy):
    """只移动不点击（触发 onPointerMove → 参考线）"""
    p = to_screen(cdp, wx, wy)
    _j(cdp, """(() => {
      const c = %s;
      c.dispatchEvent(new MouseEvent('mousemove', {
        clientX: %s, clientY: %s, bubbles: true, cancelable: true,
      }));
      return JSON.stringify({});
    })()""" % (CANVAS, p['x'], p['y']))


def key(cdp, k, down=True):
    _j(cdp, """(() => {
      window.dispatchEvent(new KeyboardEvent('%s', { key: %s, bubbles: true }));
      return JSON.stringify({});
    })()""" % ('keydown' if down else 'keyup', json.dumps(k)))


def walls(cdp):
    return _j(cdp, """(() => {
      const iv = %s;
      const f = iv.currentFloor;
      return JSON.stringify((f && f.walls || []).map(w => ({
        id: w.id, sx: w.start.x, sy: w.start.y, ex: w.end.x, ey: w.end.y,
      })));
    })()""" % IV)


def guides(cdp):
    return _j(cdp, """(() => {
      const iv = %s;
      const g = iv.alignGuides;
      return JSON.stringify({ x: g.x, y: g.y, snap: iv.alignSnapPoint });
    })()""" % IV)


def run(cdp):
    ensure_data_ready(cdp)
    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, '建筑 fixture 失败：%s' % str(binfo)[:200]
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图挂载')

    prep = _j(cdp, """(() => {
      const s = %s, iv = %s, bid = %s;
      let d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) s.addFloor(bid, '对齐层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      (f.furniture || []).slice().forEach(x => s.removeFurniture(bid, f.id, x.id));
      // 先放一面"参照墙"：(-200,-150) → (200,-150)
      const ref = s.addWall(bid, f.id, {
        start: { x: -200, y: -150 }, end: { x: 200, y: -150 }, thickness: 12, height: 280,
      });
      iv.editMode = true;
      iv.interactionMode = 'add_wall';
      iv.gridSnapEnabled = true;
      iv.gridSize = 40;
      iv.wallDraftStart = null;
      iv.clearAlignGuides();
      iv.fitToFloor && iv.fitToFloor();
      return JSON.stringify({ fid: f.id, refId: ref && ref.id });
    })()""" % (STORE, IV, json.dumps(bid)))
    fid = prep.get('fid')
    if not fid or not prep.get('refId'):
        return False, '准备参照墙失败：%s' % prep

    results = []
    try:
        wait_for(cdp, "(() => %s.renderer.getViewTransform().scale > 0)()" % IV, timeout=6, desc='相机就绪')

        # a) 两点成墙（远离开任何已有端点，避免被吸附干扰）
        click_world(cdp, -400, -400)
        click_world(cdp, -400, -100)
        a = walls(cdp)
        ok_a = len(a) == 2
        results.append(('a 两点画出一面墙', ok_a, {'walls': len(a)}))

        # b) 端点吸附：起点贴近参照墙左端 (-200,-150)，故意偏 5cm
        _j(cdp, "(() => { %s.wallDraftStart = null; return JSON.stringify({}); })()" % IV)
        click_world(cdp, -400, -400)          # 起点随便找个空地
        click_world(cdp, -196, -146)          # 终点偏 5cm 靠近 (-200,-150)
        b = walls(cdp)[-1]
        ok_b = (abs(b['ex'] - (-200)) < 0.01 and abs(b['ey'] - (-150)) < 0.01)
        results.append(('b 端点吸附：偏 5cm 的落点被吸到墙角 (-200,-150)', ok_b,
                        {'end': [b['ex'], b['ey']]}))

        # c) 轴线吸附：与参照墙共线（x 对齐到 200，y 不吸）
        _j(cdp, "(() => { %s.wallDraftStart = null; return JSON.stringify({}); })()" % IV)
        click_world(cdp, 400, -400)
        click_world(cdp, 197, -300)           # x 偏 3cm 靠近 200 这条线
        c = walls(cdp)[-1]
        ok_c = abs(c['ex'] - 200) < 0.01
        results.append(('c 轴线吸附：x 偏 3cm → 对齐到 200', ok_c, {'end': [c['ex'], c['ey']]}))

        # d) 正交（Shift）：起点 (500,200)，光标歪到 (600,280)，落点 y 必须 = 200
        _j(cdp, "(() => { %s.wallDraftStart = null; return JSON.stringify({}); })()" % IV)
        click_world(cdp, 500, 200)
        key(cdp, 'Shift', True)
        click_world(cdp, 600, 280)
        key(cdp, 'Shift', False)
        d = walls(cdp)[-1]
        ok_d = (abs(d['ey'] - 200) < 0.01 and abs(d['ex'] - 600) < 8)
        results.append(('d 正交：Shift 下歪着点 → y 仍等于起点 y', ok_d, {'end': [d['ex'], d['ey']]}))

        # e) 松开 Shift 后不再正交
        _j(cdp, "(() => { %s.wallDraftStart = null; return JSON.stringify({}); })()" % IV)
        click_world(cdp, -700, 300)
        click_world(cdp, -600, 380)
        e = walls(cdp)[-1]
        # 自由角度 = y 明显离开起点（网格会把它取整到 40 的倍数，所以只要求"差得远"）
        ok_e = abs(e['ey'] - 300) > 20
        results.append(('e 松开 Shift → 恢复自由角度', ok_e, {'end': [e['ex'], e['ey']]}))

        # f) hover 到吸附范围 → 参考线被设上
        _j(cdp, "(() => { %s.wallDraftStart = null; %s.clearAlignGuides(); return JSON.stringify({}); })()" % (IV, IV))
        click_world(cdp, -800, -150)          # 起点在参照墙那条水平线上
        hover_world(cdp, 196, -147)           # hover 到右墙角附近
        g = guides(cdp)
        ok_f = (g.get('x') is not None) and (g.get('y') is not None)
        results.append(('f hover 到墙角附近 → 两条参考线都设上（有吸附必须有线）', ok_f, g))

        # g) 拖墙角吸附：把最后一面墙的一个端点拖到 (200,-150) 附近
        drag = _j(cdp, """(() => {
      const iv = %s, s = %s;
      const f = iv.currentFloor;
      const w = f.walls[f.walls.length - 1];
      iv.wallDraftStart = null;
      iv.clearAlignGuides();
      iv.interactionMode = 'pan';   // add_wall 工具下 handleDragStart 直接 return false
      
      const info = iv.handleDragStart(w.start.x, w.start.y, 0, false, false, false);
      // 直接喂世界坐标给 move/end（拖拽本身已在 test_171 验过真实鼠标，这里只验吸附）
      iv.handleDragMove(196, -146, info);
      iv.handleDragEnd(196, -146, info);
      const after = f.walls.find(x => x.id === w.id);
      iv.clearAlignGuides();
      return JSON.stringify({
        moved: after ? { sx: after.start.x, sy: after.start.y } : null,
        links: (info && info.links || []).length,
      });
    })()""" % (IV, STORE))
        ok_g = bool(drag.get('moved')) and abs(drag['moved']['sx'] - 200) < 0.01 \
            and abs(drag['moved']['sy'] - (-150)) < 0.01
        results.append(('g 拖墙角偏 5cm → 吸附到 (200,-150)', ok_g, drag))
    finally:
        _j(cdp, """(() => {
      const iv = %s;
      iv.wallDraftStart = null;
      iv.clearAlignGuides();
      iv.interactionMode = 'pan';
      iv.editMode = true;
      return JSON.stringify({});
    })()""" % IV)

    for name, ok, detail in results:
        print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '  ← ' + json.dumps(detail, ensure_ascii=False)[:400]))
    bad = [r for r in results if not r[1]]
    return (len(bad) == 0), '%d/%d 子项通过' % (len(results) - len(bad), len(results))
