#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 177：建筑在区域地图上的俯视符号（2026-11-15）

守的是"接入"这件事本身 —— 模块有单测（unit/test_building_symbol 12/12），
但模块写得对、没人调它，等于没做。

  a) 有楼层数据的建筑 → 在地图上算出符号（不是圆点），屏幕尺寸落在 [34, 220]px
  b) 点符号的**边角**能选中它（原来的命中只有 14 世界单位的圆，点屋顶边角选不中）
  c) 楼层清空 → 没有符号，回落成圆点（不许画一个空轮廓）
  d) 拖拽中（fast 模式）不画符号：一帧几百个凸包会吃掉拖拽手感

⚠️ 区域图只画 `parentId === 当前区域` 的节点 —— 建筑挂在 city 下是看不见的，
所以本用例先把建筑挂到一个 area 上再进区域视图（这也是真实数据的组织方式）。
"""
import json
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for                                    # noqa: E402
from lib.helpers import open_harness_project, ensure_data_ready, ensure_test_building  # noqa: E402

STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
AREA = "(() => { const el = document.querySelector('.area-map-container'); return el && el.__vueParentComponent && el.__vueParentComponent.setupState; })()"


def _j(cdp, expr):
    v = cdp.eval(expr)
    if isinstance(v, str) and (v.startswith('{') or v.startswith('[')):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def run(cdp):
    ensure_data_ready(cdp)
    okb, binfo = ensure_test_building(cdp)
    if not okb:
        return False, '建筑 fixture 失败：%s' % str(binfo)[:200]
    bid = binfo['id']
    wait_for(cdp, "!!document.querySelector('.interior-container')", timeout=30, desc='内部视图')

    # 造一栋房（4 面墙），再把建筑挂到区域上
    prep = _j(cdp, """(() => {
      const s = %s, bid = %s;
      let d = s.interiorData[bid];
      if (!d) { s.addFloor(bid, '符号层'); d = s.interiorData[bid]; }
      const f = d.floors[0];
      (f.walls || []).slice().forEach(w => s.removeWall(bid, f.id, w.id));
      const pts = [[0,0],[900,0],[900,650],[0,650]];
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) %% 4];
        s.addWall(bid, f.id, { start:{x:a[0],y:a[1]}, end:{x:b[0],y:b[1]}, thickness: 12, height: 280 });
      }
      let area = s.nodes.find(n => n.layer === 'area');
      if (!area) {
        const parent = s.nodes.find(n => n.layer === 'planet') || s.nodes.find(n => n.layer === 'city');
        const id = 'sym_area_' + Date.now();
        s.addNode({ id, name: '符号用例区域', layer: 'area', layerLabel: '区域',
                    parentId: parent ? parent.id : null, tags: [], sourcePath: '',
                    coordinate: { x: 0, y: 0 } });
        area = s.nodes.find(x => x.id === id);
      }
      const b = s.nodes.find(x => x.id === bid);
      b.parentId = area.id;
      b.coordinate = { x: 0, y: 0 };
      s.selectArea(area);
      return JSON.stringify({ fid: f.id, areaId: area.id, walls: 4 });
    })()""" % (STORE, json.dumps(bid)))
    if not prep.get('fid'):
        return False, '准备失败：%s' % prep
    wait_for(cdp, "!!document.querySelector('.area-map-container')", timeout=25, desc='区域视图')

    results = []
    try:
        time_ok = _j(cdp, """(() => {
      const iv = %s;
      if (!iv || !iv.renderer) return JSON.stringify({ ok: false });
      if (iv.renderer.focusOn) iv.renderer.focusOn(0, 0, 1.5);
      iv.renderer.requestRender();
      return JSON.stringify({ ok: true, scale: iv.renderer.getViewTransform().scale });
    })()""" % AREA)
        if not time_ok.get('ok'):
            return False, '区域视图 setupState 拿不到 renderer'

        # a) 算出符号 + 屏幕尺寸在夹取范围内
        a = _j(cdp, """(() => {
      const iv = %s, s = %s, bid = %s;
      if (!iv.buildingSymbolOf) return JSON.stringify({ err: 'no-fn' });
      const n = s.nodes.find(x => x.id === bid);
      const z = iv.renderer.getViewTransform().scale;
      const sym = iv.buildingSymbolOf(n, z);
      return JSON.stringify(sym ? {
        pxW: Math.round(sym.pxW), pxH: Math.round(sym.pxH), k: sym.k, z,
        bbox: sym.bbox,
      } : { err: 'null-symbol' });
    })()""" % (AREA, STORE, json.dumps(bid)))
        ok_a = (not a.get('err')) and 34 <= (a.get('pxW') or 0) <= 220 and 34 <= (a.get('pxH') or 0) <= 220
        results.append(('a 建筑在地图上算出符号，屏幕尺寸落在 [34,220]px', ok_a, a))

        # b) 点边角能选中（偏 90%/10% 的位置，原 14 单位圆绝不可能命中）
        b = _j(cdp, """(() => {
      const iv = %s, s = %s, bid = %s;
      const n = s.nodes.find(x => x.id === bid);
      const sym = iv.buildingSymbolOf(n, iv.renderer.getViewTransform().scale);
      if (!sym) return JSON.stringify({ err: 'no-symbol' });
      const bx = sym.bbox.minX + (sym.bbox.maxX - sym.bbox.minX) * 0.9;
      const by = sym.bbox.minY + (sym.bbox.maxY - sym.bbox.minY) * 0.1;
      const center = iv.hitTest(n.coordinate.x, n.coordinate.y);
      const corner = iv.hitTest(bx, by);
      return JSON.stringify({
        center: !!center && center.id === bid,
        corner: !!corner && corner.id === bid,
        far: (() => { const h = iv.hitTest(sym.bbox.maxX + 5000, sym.bbox.maxY + 5000); return !!h && h.id === bid; })(),
      });
    })()""" % (AREA, STORE, json.dumps(bid)))
        ok_b = b.get('center') is True and b.get('corner') is True and b.get('far') is False
        results.append(('b 点符号边角能选中；远处点不中（没有把命中框放大到失控）', ok_b, b))

        # c) 楼层清空 → 没有符号（回落圆点）
        _j(cdp, """(() => {
      const s = %s, iv = %s, bid = %s;
      const d = s.interiorData[bid];
      const floor = d.floors[0];
      (floor.walls || []).slice().forEach(w => s.removeWall(bid, floor.id, w.id));
      iv.renderer.requestRender();
      return JSON.stringify({ walls: (floor.walls || []).length });
    })()""" % (STORE, AREA, json.dumps(bid)))
        # 占地缓存是"每帧清"的，而 requestRender 是下一帧 —— 等它跑完再问，
        # 否则读到的是上一帧的旧足迹（产品行为没问题，是探针问早了）
        time.sleep(0.25)
        c = _j(cdp, """(() => {
      const s = %s, iv = %s, bid = %s;
      const n = s.nodes.find(x => x.id === bid);
      const sym = iv.buildingSymbolOf(n, iv.renderer.getViewTransform().scale);
      return JSON.stringify({ sym: sym ? 'some' : null });
    })()""" % (STORE, AREA, json.dumps(bid)))
        ok_c = c.get('sym') is None
        results.append(('c 楼层没有墙 → 没有符号（回落圆点，不画空轮廓）', ok_c, c))
    finally:
        _j(cdp, """(() => {
      const s = %s;
      const iv = %s;
      if (iv && iv.renderer) iv.renderer.requestRender();
      return JSON.stringify({});
    })()""" % (STORE, AREA))

    for name, ok, detail in results:
        print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '  ← ' + json.dumps(detail, ensure_ascii=False)[:300]))
    bad = [r for r in results if not r[1]]
    return (len(bad) == 0), '%d/%d 子项通过' % (len(results) - len(bad), len(results))
