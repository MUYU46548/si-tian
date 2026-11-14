#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 171：墙的联动 —— 拖一个墙角，共用的邻墙跟着走（2026-11-14，台账 A13）

以前墙与墙只靠"端点坐标恰好相等"来隐含连接：拖走一面墙的角，另一面墙留在原地，
房间当场破口（用户："拖走一面墙，另一面不会跟着走"）。

本用例守：
  a) 拖 w0 的 end → 共用这个端点的 w1 的 start 跟着走到同一坐标
  b) w1 的另一端**不动**（只动共用那一端，不许整面墙平移）
  c) 一次 undo → 两面墙同时回到原位（拖一次 = 一条 undo，不是两条）
  d) 房间仍是一间（联动后墙还是闭合的，不许把房间拖散）
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for                                    # noqa: E402
from lib.helpers import ensure_data_ready, ensure_test_building  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def walls_state(cdp, bid, fid):
    return _j(cdp, """(() => {
      const s = %s;
      const d = s.interiorData[%s] || {};
      const f = (d.floors || []).find(x => x.id === %s);
      if (!f) return JSON.stringify({ err: 'no-floor' });
      return JSON.stringify({
        walls: (f.walls || []).map(w => ({
          id: w.id,
          start: { x: w.start.x, y: w.start.y },
          end: { x: w.end.x, y: w.end.y },
        })),
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
      if (!d || !(d.floors || []).length) s.addFloor(bid, 'A13层');
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
      iv.recalcRooms();
      iv.editMode = true;
      iv.gridSnapEnabled = false;      // 拖拽用例必须关吸附，否则手算坐标对不上
      return JSON.stringify({ fid: f.id, ids });
    })()""" % (STORE, IV, json.dumps(bid)))
    fid = prep.get('fid')
    ids = prep.get('ids') or []
    if not fid or len(ids) != 4:
        return False, '准备楼层/墙失败：%s' % prep

    results = []
    try:
        before = walls_state(cdp, bid, fid)
        w0 = next(w for w in before['walls'] if w['id'] == ids[0])
        w1 = next(w for w in before['walls'] if w['id'] == ids[1])

        # a) 拖 w0 的 end（角点 200,-150）→ 260,-150
        drag = _j(cdp, """(() => {
      const iv = %s;
      const before = JSON.parse(JSON.stringify(iv.currentFloor.walls));
      let err = null;
      const info = iv.handleDragStart(200, -150, 0, false, false, false);
      try {
        iv.handleDragMove(260, -150, info);
        iv.handleDragEnd(260, -150, info);
      } catch (e) { err = String(e && (e.stack || e.message || e)); }
      const after = iv.currentFloor.walls;
      const pick = (id) => after.find(w => w.id === id);
      return JSON.stringify({
        err,
        mode: info && info.mode,
        w0end: pick(%s) && pick(%s).end,
        w1start: pick(%s) && pick(%s).start,
        w1end: pick(%s) && pick(%s).end,
      });
    })()""" % (IV, json.dumps(ids[0]), json.dumps(ids[0]), json.dumps(ids[1]), json.dumps(ids[1]),
               json.dumps(ids[1]), json.dumps(ids[1])))
        ok_a = (drag.get('mode') == 'wall-end'
                and abs((drag.get('w0end') or {}).get('x', 0) - 260) < 0.01
                and abs((drag.get('w1start') or {}).get('x', 0) - 260) < 0.01)
        if not ok_a:
            print('    [debug] drag = %s' % json.dumps(drag, ensure_ascii=False))
            print('    [debug] before w0=%s w1=%s' % (json.dumps(w0, ensure_ascii=False), json.dumps(w1, ensure_ascii=False)))
        results.append(('a 拖 w0 端点 → 邻墙 w1 同端跟着走', ok_a, {'after': drag}))

        # b) w1 的另一端不许动
        ok_b = (abs((drag.get('w1end') or {}).get('x', 0) - 200) < 0.01
                and abs((drag.get('w1end') or {}).get('y', 0) - 150) < 0.01)
        results.append(('b w1 的另一端不动（不是整面墙平移）', ok_b, drag.get('w1end')))

        # d) 房间还在
        after_state = walls_state(cdp, bid, fid)
        ok_d = after_state.get('rooms') == 1
        results.append(('d 联动后房间仍是一间（墙没被拖散）', ok_d, {'rooms': after_state.get('rooms')}))

        # c) 一次 undo → 两面墙都回原位
        _j(cdp, "(() => { %s.undo(); return JSON.stringify({}); })()" % STORE)
        undo_state = walls_state(cdp, bid, fid)
        u0 = next(w for w in undo_state['walls'] if w['id'] == ids[0])
        u1 = next(w for w in undo_state['walls'] if w['id'] == ids[1])
        ok_c = (abs(u0['end']['x'] - 200) < 0.01 and abs(u0['end']['y'] + 150) < 0.01
                and abs(u1['start']['x'] - 200) < 0.01 and abs(u1['start']['y'] + 150) < 0.01)
        results.append(('c 一次 undo → 两面墙同时回原位', ok_c, {'w0end': u0['end'], 'w1start': u1['start']}))
    finally:
        _j(cdp, """(() => {
      const s = %s, bid = %s, fid = %s;
      const d = s.interiorData[bid]; const f = d && (d.floors || []).find(x => x.id === fid);
      if (f) (f.walls || []).slice().forEach(w => s.removeWall(bid, fid, w.id));
      const iv = %s;
      if (iv) { iv.editMode = false; iv.gridSnapEnabled = true; }
      return JSON.stringify({});
    })()""" % (STORE, json.dumps(bid), json.dumps(fid), IV))

    fails = [r for r in results if not r[1]]
    for name, ok, detail in results:
        print('  %s  %s%s' % ('ok  ' if ok else 'FAIL', name,
                              '' if ok else '  —— %s' % json.dumps(detail, ensure_ascii=False)[:240]))
    if fails:
        return False, '%d/%d 子项失败：%s' % (len(fails), len(results), ' / '.join(f[0] for f in fails))
    return True, '%d/%d 子项通过' % (len(results), len(results))
