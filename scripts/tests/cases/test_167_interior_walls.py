#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 167：建筑内部「墙 → 房间自动围合」（2026-11-13 建筑内部第 1/2/3 刀）

之前 `InteriorView` 只有家具：`floors[]` 里没有 walls / rooms，所以"房间模板"只能摆一片家具，
程序里根本没有"房间"这个概念。本次加了墙、门窗、房间三层，房间**不手画**，由墙围合自动得到。

本用例守五件事：
  a) 画 4 面墙 → 自动出一间，面积 12 ㎡（400×300cm）
  b) 加一道隔墙 → 变成两间（各 6 ㎡）—— 守 T 型交点打断
  c) 删掉隔墙 → 回到一间，且房间挂在被删墙上的不残留
  d) 一条 undo 撤掉"画墙"这一步（写口必须入栈，不能只改内存）
  e) 房间改名后再检测，名字不能被冲掉（mergeDetectedRooms 的继承）
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


def _floor_state(cdp, bid, fid):
    return _j(cdp, """(() => {
      const s = %s;
      const d = s.interiorData[%s] || {};
      const f = (d.floors || []).find(x => x.id === %s);
      if (!f) return JSON.stringify({ err: 'no-floor' });
      return JSON.stringify({
        walls: (f.walls || []).length,
        rooms: (f.rooms || []).length,
        names: (f.rooms || []).map(r => r.name || ''),
        doors: (f.doors || []).length,
        windows: (f.windows || []).length,
      });
    })()""" % (STORE, json.dumps(bid), json.dumps(fid)))


def _room_area(cdp, bid, fid):
    """用同一份纯函数还原房间多边形并算面积（不读缓存，避免自证）"""
    return _j(cdp, """(() => {
      const s = %s;
      const d = s.interiorData[%s] || {};
      const f = (d.floors || []).find(x => x.id === %s);
      if (!f) return JSON.stringify({ areas: [] });
      const walls = f.walls || [];
      const out = [];
      for (const r of (f.rooms || [])) {
        const ids = (r.walls || []);
        const rw = ids.map(id => walls.find(w => w.id === id)).filter(Boolean);
        if (rw.length < 3) { out.push(0); continue; }
        // 按墙序拼多边形（与 getRoomPolygon 同口径，这里独立实现一遍做交叉核对）
        const pts = [];
        const used = new Set();
        let cur = rw[0]; pts.push(cur.start); used.add(cur.id); let tip = cur.end;
        const eq = (a, b) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
        for (let i = 0; i < rw.length - 1; i++) {
          pts.push(tip);
          const nx = rw.find(w => !used.has(w.id) && (eq(w.start, tip) || eq(w.end, tip)));
          if (!nx) break;
          used.add(nx.id); tip = eq(nx.start, tip) ? nx.end : nx.start; cur = nx;
        }
        let sum = 0;
        for (let i = 0; i < pts.length; i++) {
          const j = (i + 1) %% pts.length;
          sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        out.push(Math.round(Math.abs(sum / 2)));
      }
      return JSON.stringify({ areas: out });
    })()""" % (STORE, json.dumps(bid), json.dumps(fid)))


def run(cdp):
    ensure_data_ready(cdp)
    # 页面错误收集：渲染层报错会被 canvas 循环吞掉，不装这个"墙没画出来"会看起来像数据问题
    cdp.eval("window.__ivErrs = []; window.addEventListener('error', e => window.__ivErrs.push(String(e.message || e))); 1")
    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, '建筑 fixture 失败：%s' % str(binfo)[:200]
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图挂载')

    # 准备一层 + 清掉上次残留的墙
    prep = _j(cdp, """(() => {
      const s = %s; const iv = %s;
      const bid = %s;
      let d = s.interiorData[bid];
      if (!d || !(d.floors || []).length) s.addFloor(bid, '用例层');
      d = s.interiorData[bid];
      const f = d.floors[0];
      iv.editMode = true; iv.selectFloor(f.id);
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      return JSON.stringify({ fid: f.id, walls: (f.walls || []).length });
    })()""" % (STORE, IV, json.dumps(bid)))
    if prep.get('err') or not prep.get('fid'):
        return False, '准备楼层失败：%s' % prep
    fid = prep['fid']

    results = []
    try:
        # a) 4 面墙成 1 间 / 12 ㎡
        a = _j(cdp, """(() => {
          const s = %s, bid = %s, fid = %s;
          const pts = [[-200,-150],[200,-150],[200,150],[-200,150]];
          for (let i = 0; i < 4; i++) {
            const p0 = pts[i], p1 = pts[(i + 1) %% 4];
            s.addWall(bid, fid, { start: {x:p0[0],y:p0[1]}, end: {x:p1[0],y:p1[1]}, thickness: 12 });
          }
          %s.recalcRooms();
          return JSON.stringify({});
        })()""" % (STORE, json.dumps(bid), json.dumps(fid), IV))
        st = _floor_state(cdp, bid, fid)
        areas = _room_area(cdp, bid, fid).get('areas') or []
        ok_a = st.get('walls') == 4 and st.get('rooms') == 1 and abs((areas[0] if areas else 0) - 120000) <= 2000
        results.append(('a 四面墙 → 一间 12㎡', ok_a, st, areas))

        # b) 加一道隔墙 → 两间（面积精确值由纯函数单测 t3 守，这里只判链路）
        _j(cdp, """(() => {
          const s = %s, bid = %s, fid = %s;
          s.addWall(bid, fid, { start: {x:0,y:-150}, end: {x:0,y:150}, thickness: 12 });
          %s.recalcRooms();
          return JSON.stringify({});
        })()""" % (STORE, json.dumps(bid), json.dumps(fid), IV))
        st_b = _floor_state(cdp, bid, fid)
        areas_b = sorted(_room_area(cdp, bid, fid).get('areas') or [])
        ok_b = st_b.get('walls') == 5 and st_b.get('rooms') == 2
        results.append(('b 加隔墙 → 两间', ok_b, st_b, areas_b))

        # e) 改名后再检测，名字不能丢（先改名，再触发一次重算）
        _j(cdp, """(() => {
          const s = %s, bid = %s, fid = %s;
          const d = s.interiorData[bid]; const f = d.floors.find(x => x.id === fid);
          if (f.rooms && f.rooms[0]) f.rooms[0].name = '书房';
          %s.recalcRooms();
          return JSON.stringify({});
        })()""" % (STORE, json.dumps(bid), json.dumps(fid), IV))
        st_e = _floor_state(cdp, bid, fid)
        ok_e = '书房' in (st_e.get('names') or [])
        results.append(('e 房间改名不被重算冲掉', ok_e, st_e, None))

        # c) 删隔墙 → 回到一间
        mid = _j(cdp, """(() => {
          const s = %s, bid = %s, fid = %s;
          const d = s.interiorData[bid]; const f = d.floors.find(x => x.id === fid);
          const w = (f.walls || []).find(x => Math.abs(x.start.x) < 2 && Math.abs(x.end.x) < 2);
          if (!w) return JSON.stringify({ err: 'no-mid-wall' });
          s.removeWall(bid, fid, w.id);
          %s.recalcRooms();
          return JSON.stringify({ removed: w.id });
        })()""" % (STORE, json.dumps(bid), json.dumps(fid), IV))
        st_c = _floor_state(cdp, bid, fid)
        ok_c = st_c.get('walls') == 4 and st_c.get('rooms') == 1
        results.append(('c 删隔墙 → 回到一间', ok_c, st_c, mid))

        # d) 一条 undo 撤掉"删墙"—— 房间是派生数据，不单独入栈，所以按一次就该回去
        _j(cdp, "(() => { %s.undo(); return JSON.stringify({}); })()" % STORE)
        st_d = _floor_state(cdp, bid, fid)
        ok_d = st_d.get('walls') == 5 and st_d.get('rooms') == 2
        results.append(('d 撤销一次 → 隔墙回来（不是撤销"重算房间"）', ok_d, st_d, None))

        # f) 拖墙端点改形状（走组件自己的 handleDragStart/Move/End，等价于鼠标拖拽）
        drag = _j(cdp, """(() => {
          const iv = %s;
          const f = iv.currentFloor;
          const w = (f.walls || [])[0];
          if (!w) return JSON.stringify({ err: 'no-wall' });
          const before = JSON.parse(JSON.stringify(w.start));
          const savedSnap = iv.gridSnapEnabled;
          iv.gridSnapEnabled = false;
          const info = iv.handleDragStart(before.x, before.y, 0, false, false, false);
          const target = { x: before.x + 60, y: before.y + 60 };
          iv.handleDragMove(target.x, target.y, info);
          iv.handleDragEnd(target.x, target.y, info);
          iv.gridSnapEnabled = savedSnap;
          const w2 = (iv.currentFloor.walls || []).find(x => x.id === w.id);
          return JSON.stringify({ mode: info && info.mode, before, after: w2 && w2.start });
        })()""" % IV)
        ok_f = (drag.get('mode') == 'wall-end'
                and drag.get('after') and drag['after'] != drag.get('before'))
        results.append(('f 拖墙端点改形状', ok_f, drag, None))

        # g) 撤销一次 → 端点回原位
        _j(cdp, "(() => { %s.undo(); return JSON.stringify({}); })()" % STORE)
        back = _j(cdp, """(() => {
          const iv = %s;
          const f = iv.currentFloor;
          const w = (f.walls || [])[0];
          return JSON.stringify({ start: w && JSON.parse(JSON.stringify(w.start)) });
        })()""" % IV)
        ok_g = back.get('start') == drag.get('before')
        results.append(('g 撤销一次 → 端点回原位', ok_g, back, None))

        # h) 在墙上放一扇门（门窗只能挂在墙上）
        door = _j(cdp, """(() => {
          const iv = %s;
          const f = iv.currentFloor;
          const w = (f.walls || []).find(x => Math.abs(x.start.y - 150) < 2 && Math.abs(x.end.y - 150) < 2);
          if (!w) return JSON.stringify({ err: 'no-bottom-wall' });
          // 取底边上离中点 100cm 处 —— 中点正好是隔墙端点，会被隔墙抢走
          const mid = { x: (w.start.x + w.end.x) / 2 - 100, y: (w.start.y + w.end.y) / 2 };
          iv.placeOpening('door', mid.x, mid.y);
          const f2 = iv.currentFloor;
          const d = (f2.doors || [])[0];
          return JSON.stringify({ doors: (f2.doors || []).length,
            wallId: d && d.wallId, pos: d && d.position, hitSame: d && d.wallId === w.id });
        })()""" % IV)
        ok_h = door.get('doors') == 1 and door.get('hitSame') is True
        results.append(('h 墙上放门（挂对了墙）', ok_h, door, None))

        # 出图留证（不是判据，人工复核用）：此刻画布上应有 5 面墙 + 2 间房
        try:
            root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__)))))
            out_dir = os.path.join(root, 'build', 'interior-walls')
            os.makedirs(out_dir, exist_ok=True)
            cdp.eval("""new Promise(r => {
              try { %s.renderer.requestRender(); } catch (e) {}
              requestAnimationFrame(() => requestAnimationFrame(() => r(1)));
            })""" % IV)
            data_url = cdp.eval("document.querySelector('.interior-container canvas').toDataURL('image/png')")
            if isinstance(data_url, str) and data_url.startswith('data:image'):
                import base64
                with open(os.path.join(out_dir, 'test-167.png'), 'wb') as fh:
                    fh.write(base64.b64decode(data_url.split(',', 1)[1]))
        except Exception:
            pass
    except Exception as e:      # noqa: BLE001
        return False, '异常：%s' % e
    finally:
        # 清场：删掉本用例加的所有墙（不碰家具）
        try:
            _j(cdp, """(() => {
              const s = %s, bid = %s, fid = %s;
              const d = s.interiorData[bid]; const f = d.floors.find(x => x.id === fid);
              (f.walls || []).slice().forEach(w => s.removeWall(bid, fid, w.id));
              %s.recalcRooms();
              return JSON.stringify({});
            })()""" % (STORE, json.dumps(bid), json.dumps(fid), IV))
        except Exception:
            pass

    failed = [r for r in results if not r[1]]
    errs = _j(cdp, "JSON.stringify(window.__ivErrs || [])")
    detail = '；'.join('%s %s %s' % ('✅' if r[1] else '❌', r[0], json.dumps(r[2], ensure_ascii=False)[:120])
                      for r in results)
    if errs:
        detail += ' ｜ 页面错误：%s' % json.dumps(errs, ensure_ascii=False)[:300]
    return len(failed) == 0, detail
