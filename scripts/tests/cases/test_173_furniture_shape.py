#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 173：家具自绘形状（2026-11-14）

用户明确要求：家具模块要能自己画形状。渲染侧契约（item.custom）在 0.5.11 就有了，
本用例守的是**入口真的能用** —— 从选中家具、点按钮、在画布上点出轮廓、到落进项目，
全部走真实鼠标事件，不用函数直调冒充。

守的点：
  a) 选中家具 → 浮窗里有「画形状」，且按钮**真的能被点到**（elementFromPoint 命中测试；
     内联按钮被别的层压住时 el.click() 会绕过命中 → 用例绿而人点不动）
  b) 点按钮 → 进入绘制态，提示条出现、点数为 0
  c) 在画布上点 4 个点 → 点数 4（真实 mousedown/mouseup，走 renderer 的坐标换算）
  d) Enter 闭合 → item.custom 落库，4 个点、归一化在 0..1、closed/fill 都在
  e) 一次 undo → custom 消失（绘制必须是一条可撤销命令）
  f) 再进绘制态 → 预填已有形状（接着改，不用重画）
  g) 「恢复默认」→ custom 被删掉，回到内置符号
  h) 画到包围框外 → 家具尺寸自动撑大（形状不被裁掉）
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
    """世界坐标 → 视口坐标（与 renderer.screenToWorld 互逆）"""
    return _j(cdp, """(() => {
      const iv = %s, c = %s;
      const vt = iv.renderer.getViewTransform();
      const r = c.getBoundingClientRect();
      return JSON.stringify({
        x: r.left + r.width / 2 + ((%s) * vt.scale + vt.x),
        y: r.top + r.height / 2 + ((%s) * vt.scale + vt.y),
        scale: vt.scale,
      });
    })()""" % (IV, CANVAS, wx, wy))


def click_world(cdp, wx, wy):
    """在某个世界坐标处派发**真实** mousedown + mouseup（renderer 靠这两个事件判点击）。"""
    p = to_screen(cdp, wx, wy)
    _j(cdp, """(() => {
      const c = %s;
      const opt = { clientX: %s, clientY: %s, bubbles: true, cancelable: true, button: 0 };
      c.dispatchEvent(new MouseEvent('mousedown', opt));
      c.dispatchEvent(new MouseEvent('mouseup', opt));
      return JSON.stringify({});
    })()""" % (CANVAS, p['x'], p['y']))
    return p


def state(cdp, bid, fid):
    return _j(cdp, """(() => {
      const s = %s, iv = %s;
      const d = s.interiorData[%s] || {};
      const f = (d.floors || []).find(x => x.id === %s) || {};
      const it = (f.furniture || [])[0] || null;
      return JSON.stringify({
        active: iv.shapeEdit.active,
        points: (iv.shapeEdit.points || []).length,
        bar: !!document.querySelector('[data-testid=shape-edit-bar]'),
        item: it ? {
          id: it.id, w: it.width, h: it.height, x: it.x, y: it.y,
          custom: it.custom ? {
            n: (it.custom.points || []).length,
            closed: it.custom.closed !== false,
            fill: it.custom.fill !== false,
            minX: Math.min(...(it.custom.points || [{x:0}]).map(p => p.x)),
            maxX: Math.max(...(it.custom.points || [{x:0}]).map(p => p.x)),
            minY: Math.min(...(it.custom.points || [{y:0}]).map(p => p.y)),
            maxY: Math.max(...(it.custom.points || [{y:0}]).map(p => p.y)),
          } : null,
        } : null,
      });
    })()""" % (STORE, IV, json.dumps(bid), json.dumps(fid)))


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
      if (!d || !(d.floors || []).length) s.addFloor(bid, '自绘层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      // 清场：只留一件 200×100 的家具在原点，画布干净才不会点歪
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      (f.furniture || []).slice().forEach(x => s.removeFurniture(bid, f.id, x.id));
      const it = s.addFurniture(bid, f.id, {
        name: '自绘测试', type: 'generic', x: -100, y: -50, width: 200, height: 100, rotation: 0,
      });
      iv.editMode = false;             // 家具浮窗只在浏览态出现
      iv.selectedFurniture = null;
      if (iv.cancelShapeEdit) iv.cancelShapeEdit();
      iv.fitToFloor && iv.fitToFloor();
      return JSON.stringify({ fid: f.id, itemId: it && it.id });
    })()""" % (STORE, IV, json.dumps(bid)))
    fid = prep.get('fid')
    if not fid or not prep.get('itemId'):
        return False, '准备家具失败：%s' % prep

    results = []
    try:
        wait_for(cdp, "(() => %s.renderer.getViewTransform().scale > 0)()" % IV, timeout=6, desc='相机就绪')

        # a) 点家具 → 浮窗出现，「画形状」按钮存在且命中
        click_world(cdp, 0, 0)
        hit = _j(cdp, """(() => {
      const b = document.querySelector('[data-testid=shape-draw]');
      if (!b) return JSON.stringify({ found: false });
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return JSON.stringify({
        found: true, w: Math.round(r.width), h: Math.round(r.height),
        hit: !!(el && (el === b || b.contains(el))),
        hitTag: el ? (el.tagName + '.' + (el.className || '')) : '',
        state: (document.querySelector('[data-testid=shape-state]') || {}).textContent || '',
      });
    })()""")
        ok_a = bool(hit.get('found')) and bool(hit.get('hit')) and hit.get('w', 0) > 20
        results.append(('a 「画形状」按钮存在且命中（没被别的层压住）', ok_a, hit))

        # b) 点按钮 → 进入绘制态
        _j(cdp, """(() => { document.querySelector('[data-testid=shape-draw]').click(); return JSON.stringify({}); })()""")
        b = state(cdp, bid, fid)
        ok_b = b.get('active') is True and b.get('points') == 0 and b.get('bar') is True
        results.append(('b 进入绘制态：提示条出现、0 点', ok_b, b))

        # c) 在画布上点 4 个点（真实鼠标事件）
        pts = [(-80, -40), (80, -40), (80, 40), (-80, 40)]
        for (wx, wy) in pts:
            click_world(cdp, wx, wy)
        c = state(cdp, bid, fid)
        ok_c = c.get('points') == 4
        results.append(('c 画布上点 4 个点 → 计数 4', ok_c, c))

        # d) Enter 闭合 → 落库
        _j(cdp, """(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return JSON.stringify({});
    })()""")
        d = state(cdp, bid, fid)
        cust = d.get('item', {}).get('custom') or {}
        ok_d = (d.get('active') is False and cust.get('n') == 4 and cust.get('closed') is True
                and cust.get('fill') is True
                and cust.get('minX', -1) >= 0 and cust.get('maxX', 2) <= 1
                and cust.get('minY', -1) >= 0 and cust.get('maxY', 2) <= 1)
        results.append(('d Enter 闭合 → custom 落库（4 点、归一化 0..1）', ok_d, d))

        # e) 一次 undo → custom 消失
        _j(cdp, "(() => { %s.undo(); return JSON.stringify({}); })()" % STORE)
        e = state(cdp, bid, fid)
        ok_e = (e.get('item', {}).get('custom') is None)
        results.append(('e 一次 undo → 自定义形状消失', ok_e, e))

        # f) redo 回来，再进绘制态 → 预填（这是"接着改"的关键）
        _j(cdp, "(() => { %s.redo(); return JSON.stringify({}); })()" % STORE)
        click_world(cdp, 0, 0)          # 重新选中家具（undo 可能清掉了选中）
        _j(cdp, """(() => {
      const b = document.querySelector('[data-testid=shape-draw]');
      if (b) b.click();
      return JSON.stringify({ clicked: !!b });
    })()""")
        f = state(cdp, bid, fid)
        ok_f = f.get('active') is True and f.get('points') == 4
        results.append(('f 再进绘制 → 预填已有 4 点（接着改，不重画）', ok_f, f))

        # 退出绘制，别影响后面的断言
        _j(cdp, """(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return JSON.stringify({});
    })()""")
        f2 = state(cdp, bid, fid)
        ok_f2 = f2.get('active') is False and f2.get('points') == 0
        results.append(('f2 Esc 取消 → 退出且不写数据', ok_f2, f2))

        # g) 「恢复默认」→ custom 被删
        click_world(cdp, 0, 0)
        _j(cdp, """(() => {
      const b = document.querySelector('[data-testid=shape-reset]');
      if (b) b.click();
      return JSON.stringify({ clicked: !!b });
    })()""")
        g = state(cdp, bid, fid)
        ok_g = (g.get('item', {}).get('custom') is None)
        results.append(('g 「恢复默认」→ 回到内置符号', ok_g, g))

        # h) 画到框外 → 家具自动撑大（不裁形状）
        before_h = state(cdp, bid, fid).get('item', {})
        click_world(cdp, 0, 0)
        _j(cdp, """(() => {
      const b = document.querySelector('[data-testid=shape-draw]');
      if (b) b.click();
      return JSON.stringify({});
    })()""")
        for (wx, wy) in [(-260, -50), (0, -150), (260, 50), (0, 150)]:
            click_world(cdp, wx, wy)
        _j(cdp, """(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return JSON.stringify({});
    })()""")
        h = state(cdp, bid, fid).get('item', {})
        ok_h = (h.get('w', 0) > before_h.get('w', 0) + 1) and (h.get('h', 0) > before_h.get('h', 0) + 1) \
            and bool(h.get('custom'))
        results.append(('h 画到框外 → 包围框撑大（形状不裁）', ok_h,
                        {'before': {'w': before_h.get('w'), 'h': before_h.get('h')},
                         'after': {'w': h.get('w'), 'h': h.get('h')}}))
    finally:
        # 收尾：退出绘制态 + 恢复编辑态，别把状态留给后面的用例
        _j(cdp, """(() => {
      const iv = %s;
      if (iv.cancelShapeEdit) iv.cancelShapeEdit();
      return JSON.stringify({});
    })()""" % IV)

    for name, ok, detail in results:
        print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '  ← ' + json.dumps(detail, ensure_ascii=False)[:400]))
    bad = [r for r in results if not r[1]]
    return (len(bad) == 0), '%d/%d 子项通过' % (len(results) - len(bad), len(results))
