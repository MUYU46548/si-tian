#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 172：房间双击改名 + 尺寸标注（2026-11-14，台账 A28 / A25）

房间是派生数据（墙一改就重算），但**名字是人给的** —— 以前只能改数据文件。
尺寸标注以前完全没有：图上只有面积，没有"这面墙多长"。

本用例守：
  a) 双击房间 → 弹输入框 → 改名落到数据
  b) 一次 undo → 名字回到原值（改名必须入撤销栈）
  c) 取消输入 → 名字不变（不许把取消当成"改成空"）
  d) 双击房间外面 → 什么都不发生（不报错、不改名）
  e) 「标注」开关可切，切换后重绘不崩
  f) 门窗浮窗里的「距墙端」算得对（400cm 墙、门 90 宽居中 → 155 / 155）
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


def dblclick_world(cdp, wx, wy):
    """在房间内某世界坐标处派发真实 dblclick（走 renderer 的坐标换算）。"""
    return _j(cdp, """(() => {
      const iv = %s;
      const vt = iv.renderer.getViewTransform();
      const c = %s;
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2 + ((%s) * vt.scale + vt.x);
      const cy = r.top + r.height / 2 + ((%s) * vt.scale + vt.y);
      c.dispatchEvent(new MouseEvent('dblclick', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true,
      }));
      return JSON.stringify({ cx, cy });
    })()""" % (IV, CANVAS, wx, wy))


def room_names(cdp, bid, fid):
    return _j(cdp, """(() => {
      const s = %s;
      const d = s.interiorData[%s] || {};
      const f = (d.floors || []).find(x => x.id === %s);
      if (!f) return JSON.stringify({ err: 'no-floor' });
      return JSON.stringify({
        names: (f.rooms || []).map(r => r.name || ''),
        rooms: (f.rooms || []).length,
      });
    })()""" % (STORE, json.dumps(bid), json.dumps(fid)))


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
      if (!d || !(d.floors || []).length) s.addFloor(bid, 'A28层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      const pts = [[-200,-150],[200,-150],[200,150],[-200,150]];
      const ids = [];
      for (let i = 0; i < 4; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) %% 4];
        const w = s.addWall(bid, f.id, { start:{x:p0[0],y:p0[1]}, end:{x:p1[0],y:p1[1]}, thickness: 12, height: 280 });
        ids.push(w.id);
      }
      const door = s.addDoor(bid, f.id, { wallId: ids[0].id, position: 0.5, width: 90, height: 200 });
      iv.recalcRooms();
      // 房间先清空名字，断言"改名前是空的"更有意义
      (f.rooms || []).forEach(r => { r.name = ''; });
      iv.editMode = true;
      iv.fitToFloor && iv.fitToFloor();
      return JSON.stringify({ fid: f.id, wallId: ids[0].id, doorId: door && door.id, rooms: (f.rooms || []).length });
    })()""" % (STORE, IV, json.dumps(bid)))
    fid = prep.get('fid')
    if not fid or not prep.get('rooms'):
        return False, '准备楼层/房间失败：%s' % prep

    results = []
    try:
        wait_for(cdp, "(() => %s.renderer.getViewTransform().scale > 0)()" % IV, timeout=5, desc='相机就绪')

        # a) 双击房间中心 → prompt 返回"书房"
        _j(cdp, "(() => { window.prompt = () => '书房'; return JSON.stringify({}); })()")
        dblclick_world(cdp, 0, 0)
        wait_for(cdp, """(() => {
          const f = %s.currentFloor;
          return !!(f && (f.rooms || []).some(r => r.name === '书房'));
        })()""" % IV, timeout=6, desc='房间改名生效')
        a = room_names(cdp, bid, fid)
        ok_a = '书房' in (a.get('names') or [])
        results.append(('a 双击房间 → 改名落到数据', ok_a, a))

        # b) 一次 undo → 名字回空
        _j(cdp, "(() => { %s.undo(); return JSON.stringify({}); })()" % STORE)
        b = room_names(cdp, bid, fid)
        ok_b = '书房' not in (b.get('names') or [])
        results.append(('b 一次 undo → 名字回原值', ok_b, b))

        # c) 取消（prompt 返回 null）→ 名字不变
        _j(cdp, "(() => { window.prompt = () => null; return JSON.stringify({}); })()")
        dblclick_world(cdp, 0, 0)
        c = room_names(cdp, bid, fid)
        ok_c = (c.get('names') == b.get('names'))
        results.append(('c 取消输入 → 名字不变', ok_c, c))

        # d) 双击房间外（远处）→ 不变、不报错
        _j(cdp, "(() => { window.prompt = () => '不该出现'; return JSON.stringify({}); })()")
        dblclick_world(cdp, 3000, 3000)
        d = room_names(cdp, bid, fid)
        ok_d = '不该出现' not in (d.get('names') or [])
        results.append(('d 双击房间外 → 什么都不发生', ok_d, d))

        # e) 标注开关
        e = _j(cdp, """(() => {
      const iv = %s;
      const before = iv.showDimensions;
      iv.showDimensions = false;
      iv.renderer.requestRender();
      const mid = iv.showDimensions;
      iv.showDimensions = true;
      iv.renderer.requestRender();
      return JSON.stringify({ before, mid, after: iv.showDimensions });
    })()""" % IV)
        ok_e = e.get('before') is True and e.get('mid') is False and e.get('after') is True
        results.append(('e 「标注」开关可切且不崩', ok_e, e))

        # f) 门窗浮窗「距墙端」：400cm 墙、90 宽居中 → 155 / 155
        door = _j(cdp, """(() => {
      const s = %s, iv = %s;
      const f = iv.currentFloor;
      let door = (f.doors || [])[0];
      if (!door) {
        // 前置门可能被前一步的清场连带删掉 → 现造一个（挂第一面墙，居中 90 宽）
        const w = (f.walls || [])[0];
        if (!w) return JSON.stringify({ err: 'no-wall' });
        door = s.addDoor(%s, f.id, { wallId: w.id, position: 0.5, width: 90, height: 200 });
      }
      if (!door) return JSON.stringify({ err: 'no-door', walls: (f.walls || []).length, doors: (f.doors || []).length });
      iv.startOpeningEdit({ kind: 'doors', id: door.id, wallId: door.wallId, opening: door });
      const ends = iv.openingEnds;
      iv.cancelOpeningEdit();
      return JSON.stringify({ ends, doors: (f.doors || []).length });
    })()""" % (STORE, IV, json.dumps(bid)))
        ok_f = (door.get('ends') == '1.55 m / 1.55 m')
        results.append(('f 「距墙端」= 1.55 m / 1.55 m（400 墙 / 90 门居中）', ok_f, door))
    finally:
        _j(cdp, """(() => {
      const s = %s, bid = %s, fid = %s;
      const d = s.interiorData[bid]; const f = d && (d.floors || []).find(x => x.id === fid);
      if (f) (f.walls || []).slice().forEach(w => s.removeWall(bid, fid, w.id));
      const iv = %s;
      if (iv) { iv.editMode = false; }
      window.prompt = undefined;
      return JSON.stringify({});
    })()""" % (STORE, json.dumps(bid), json.dumps(fid), IV))

    fails = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print('  %s  %s%s' % ('ok  ' if ok else 'FAIL', name,
                              '' if ok else '  —— %s' % json.dumps(detail, ensure_ascii=False)[:240]))
    if fails:
        return False, '%d/%d 子项失败：%s' % (len(fails), len(results), ' / '.join(f[0] for f in fails))
    return True, '%d/%d 子项通过' % (len(results), len(results))
