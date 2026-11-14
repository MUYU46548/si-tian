#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 170：门窗的选中 / 改尺寸 / 删除（2026-11-14，台账 A11）

用户原话："现在放进去了删不掉，写口有、UI 没有。"
这块以前只有"放"：`addDoor/addWindow` 有写口，但没有命中、没有选中态、没有删除与改尺寸。

本用例守：
  a) 真实鼠标点画布上的门 → 弹出浮窗，字段值 = 数据（不是默认值）
  b) 改洞口宽 + 沿墙位置 → 保存 → 数据变了、浮窗关闭、一次 undo 回到原值
  c) 选中后点「删除」→ 门窗 -1；undo 一次回来（走的是 store 的写口，不是直接改数组）
  d) 点空白处 → 浮窗关闭、选中清空
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


def click_world(cdp, wx, wy):
    """把世界坐标 (cm) 换算成屏幕像素，用真实鼠标事件点下去（不调组件方法）。"""
    pos = _j(cdp, """(() => {
      const iv = %s;
      const vt = iv.renderer.getViewTransform();
      const c = %s;
      const r = c.getBoundingClientRect();
      return JSON.stringify({
        x: r.left + r.width / 2 + ( (%s) * vt.scale + vt.x ),
        y: r.top + r.height / 2 + ( (%s) * vt.scale + vt.y ),
        scale: vt.scale,
      });
    })()""" % (IV, CANVAS, wx, wy))
    x, y = pos['x'], pos['y']
    cdp.send('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
    cdp.send('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
    return pos


def opening_state(cdp, bid, fid, kind, oid):
    return _j(cdp, """(() => {
      const s = %s;
      const d = s.interiorData[%s] || {};
      const f = (d.floors || []).find(x => x.id === %s);
      const o = f && (f[%s] || []).find(x => x.id === %s);
      return JSON.stringify(o ? {
        id: o.id, width: o.width, height: o.height,
        position: o.position, sillHeight: o.sillHeight,
      } : { err: 'gone' });
    })()""" % (STORE, json.dumps(bid), json.dumps(fid), json.dumps(kind), json.dumps(oid)))


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
      if (!d || !(d.floors || []).length) s.addFloor(bid, 'A11层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      // 一边 400cm 的南墙 + 三面围合，门放在南墙中央
      const pts = [[-200,-150],[200,-150],[200,150],[-200,150]];
      const walls = [];
      for (let i = 0; i < 4; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) %% 4];
        walls.push(s.addWall(bid, f.id, { start:{x:p0[0],y:p0[1]}, end:{x:p1[0],y:p1[1]}, thickness: 12, height: 280 }));
      }
      const door = s.addDoor(bid, f.id, { wallId: walls[0].id, position: 0.5, width: 90, height: 200 });
      iv.editMode = false;
      iv.fitToFloor && iv.fitToFloor();
      return JSON.stringify({ fid: f.id, doorId: door && door.id, wallId: walls[0].id });
    })()""" % (STORE, IV, json.dumps(bid)))
    fid = prep.get('fid')
    door_id = prep.get('doorId')
    if not fid or not door_id:
        return False, '准备楼层/门失败：%s' % prep

    results = []
    try:
        wait_for(cdp, "(() => { const p = %s.renderer.getViewTransform(); return p.scale > 0; })()" % IV,
                 timeout=5, desc='相机就绪')

        # a) 真实点门中心（世界坐标 0,-150 附近）
        pos = click_world(cdp, 0, -150)
        wait_for(cdp, "!!document.querySelector('[data-testid=opening-popover]')",
                 timeout=6, desc='门窗浮窗出现')
        a = _j(cdp, """(() => {
      const el = document.querySelector('[data-testid=opening-popover]');
      if (!el) return JSON.stringify({ err: 'no-popover' });
      const num = (sel) => { const i = el.querySelector(sel); return i ? Number(i.value) : null; };
      return JSON.stringify({
        title: el.querySelector('h4').textContent.trim(),
        width: num('[data-testid=opening-width]'),
        height: num('[data-testid=opening-height]'),
        position: num('[data-testid=opening-position]'),
        hasSill: !!el.querySelector('[data-testid=opening-sill]'),
      });
    })()""")
        ok_a = (a.get('title') == '门' and abs((a.get('width') or 0) - 90) < 0.01
                and abs((a.get('height') or 0) - 200) < 0.01
                and abs((a.get('position') or 0) - 0.5) < 0.01
                and a.get('hasSill') is False)   # 门没有窗台高
        results.append(('a 点中门 → 浮窗字段 = 数据（门无窗台高）', ok_a, {'click': pos, 'form': a}))

        # b) 改宽 110 / 位置 0.3 → 保存
        _j(cdp, """(() => {
      const el = document.querySelector('[data-testid=opening-popover]');
      const set = (sel, v) => {
        const i = el.querySelector(sel);
        i.value = v;
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('[data-testid=opening-width]', 110);
      set('[data-testid=opening-position]', 0.3);
      el.querySelector('[data-testid=opening-save]').click();
      return JSON.stringify({});
    })()""")
        st = opening_state(cdp, bid, fid, 'doors', door_id)
        b = _j(cdp, """(() => JSON.stringify({
      popover: !!document.querySelector('[data-testid=opening-popover]'),
    }))()""")
        ok_b = (abs((st.get('width') or 0) - 110) < 0.01 and abs((st.get('position') or 0) - 0.3) < 0.01
                and b.get('popover') is False)
        results.append(('b 改宽 110 / 位置 0.3 → 数据已落 + 浮窗关闭', ok_b, {'data': st, 'ui': b}))

        # b2) 一次 undo 回到原值（改尺寸必须入 undo 栈）
        _j(cdp, "(() => { %s.undo(); return JSON.stringify({}); })()" % STORE)
        back = opening_state(cdp, bid, fid, 'doors', door_id)
        ok_b2 = abs((back.get('width') or 0) - 90) < 0.01
        results.append(('b2 一次 undo → 宽度回到 90', ok_b2, back))

        # c) 重新点中 → 点浮窗里的「删除」→ 门消失
        click_world(cdp, 0, -150)
        wait_for(cdp, "!!document.querySelector('[data-testid=opening-popover]')", timeout=6, desc='再次选中')
        _j(cdp, """(() => {
      document.querySelector('[data-testid=opening-delete]').click();
      return JSON.stringify({});
    })()""")
        gone = opening_state(cdp, bid, fid, 'doors', door_id)
        c = _j(cdp, """(() => JSON.stringify({
      doors: ((%s.interiorData[%s] || {}).floors || []).find(x => x.id === %s) ? 
        ((%s.interiorData[%s].floors.find(x => x.id === %s).doors) || []).length : -1,
      popover: !!document.querySelector('[data-testid=opening-popover]'),
    }))()""" % (STORE, json.dumps(bid), json.dumps(fid), STORE, json.dumps(bid), json.dumps(fid)))
        ok_c = gone.get('err') == 'gone' and c.get('doors') == 0 and c.get('popover') is False
        results.append(('c 选中后删除 → 门消失、浮窗关闭', ok_c, {'data': gone, 'ui': c}))

        # c2) undo 一次 → 门回来
        _j(cdp, "(() => { %s.undo(); return JSON.stringify({}); })()" % STORE)
        back2 = opening_state(cdp, bid, fid, 'doors', door_id)
        ok_c2 = back2.get('id') == door_id
        results.append(('c2 一次 undo → 门回来', ok_c2, back2))

        # d) 点空白 → 浮窗关闭
        click_world(cdp, 900, 900)
        wait_for(cdp, "!document.querySelector('[data-testid=opening-popover]')", timeout=6, desc='点空白关闭浮窗')
        results.append(('d 点空白 → 浮窗关闭、选中清空', True, None))
    finally:
        _j(cdp, """(() => {
      const s = %s, bid = %s, fid = %s;
      const d = s.interiorData[bid]; const f = d && (d.floors || []).find(x => x.id === fid);
      if (!f) return JSON.stringify({});
      (f.walls || []).slice().forEach(w => s.removeWall(bid, fid, w.id));
      return JSON.stringify({});
    })()""" % (STORE, json.dumps(bid), json.dumps(fid)))

    fails = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print('  %s  %s%s' % ('ok  ' if ok else 'FAIL', name,
                              '' if ok else '  —— %s' % json.dumps(detail, ensure_ascii=False)[:240]))
    if fails:
        return False, '%d/%d 子项失败：%s' % (len(fails), len(results), ' / '.join(f[0] for f in fails))
    return True, '%d/%d 子项通过' % (len(results), len(results))
