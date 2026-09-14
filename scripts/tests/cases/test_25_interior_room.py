#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 25：R5-1 建筑内部「房间模板」—— 一键铺好整间，一次操作 = 一条 undo
覆盖：
  a) 选中模板后点击画布 → 整间家具按模板相对偏移落位（数量/名称/包围盒）
  b) 落位遵守网格吸附（开启时）
  c) 整组是**一条** undo：撤销一次全消失、重做一次全回来（不是 N 条）
  d) 放完自动选中整间（视觉反馈）
"""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for

IV = "document.querySelector('.interior-container').__vueParentComponent.setupState"
STORE = "document.querySelector('#app').__vue_app__._instance.setupState.store"
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
    return cdp.eval(f"""(() => {{
      const iv = {IV};
      const c = {CANVAS};
      if (!iv || !c) return 'no-canvas';
      const r = c.getBoundingClientRect();
      const vt = iv.renderer.viewTransform;
      const sx = wx * vt.scale + vt.x + c.clientWidth / 2;
      const sy = wy * vt.scale + vt.y + c.clientHeight / 2;
      if (sx < 0 || sx > c.clientWidth || sy < 0 || sy > c.clientHeight) return 'out-of-view';
      const mk = (t) => new MouseEvent(t, {{ clientX: Math.trunc(r.left + sx), clientY: Math.trunc(r.top + sy),
        bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk('mousedown'));
      c.dispatchEvent(mk('mouseup'));
      return 'ok';
    }})()""")


def furniture_of_floor(cdp, building_id, floor_id):
    return _j(cdp, f"""(() => {{
      const s = {STORE};
      const data = s.interiorData[{json.dumps(building_id)}];
      const fl = data && (data.floors || []).find(f => f.id === {json.dumps(floor_id)});
      const items = (fl && fl.furniture) || [];
      return JSON.stringify({{ n: items.length, items: items.map(i => ({{ name: i.name, type: i.type, x: i.x, y: i.y }})) }});
    }})()""")


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')

    # 进入建筑内部（真实数据里有 1 个 building 节点「测试建筑」）
    setup = _j(cdp, f"""(() => {{
      const s = {STORE};
      const b = s.nodes.find(n => n.layer === 'building');
      if (!b) return JSON.stringify({{ err: 'no-building' }});
      s.selectBuilding(b);
      return JSON.stringify({{ id: b.id, name: b.name, level: s.viewLevel }});
    }})()""")
    if not isinstance(setup, dict) or 'id' not in setup:
        return False, f'未找到建筑节点 {setup}'
    if setup['level'] != 'interior':
        return False, f'未进入建筑内部视图 {setup}'
    wait_for(cdp, f"!!{CANVAS}", desc='内部画布挂载')
    time.sleep(0.5)

    bid = setup['id']

    # 准备 → 真实点击 → 计数，全部在同一个 eval 内完成：
    # 多段 eval 之间页面可能重渲染/重挂载，局部交互态不保证跨调用存续（实测过 prep 后点击落空）
    placed = _j(cdp, f"""(async () => {{
      const s = {STORE};
      const el = document.querySelector('.interior-container');
      const iv = el.__vueParentComponent.setupState;
      const data = s.interiorData[{json.dumps(bid)}] || {{}};
      let fl = (data.floors || [])[0];
      if (!fl) fl = s.addFloor({json.dumps(bid)}, '一层');
      const before = (fl.furniture || []).length;

      iv.editMode = true;
      iv.interactionMode = 'add_room';
      iv.selectedRoomTemplate = 'hall';
      iv.gridSnapEnabled = true;
      iv.currentFloorId = fl.id;
      await new Promise(r => setTimeout(r, 60));

      const tpl = iv.ROOM_TEMPLATES.find(t => t.id === 'hall');
      const c = el.querySelector('.canvas-wrapper canvas');
      const r = c.getBoundingClientRect();
      const vt = iv.renderer.viewTransform;
      const wx = 200, wy = 160;
      const sx = wx * vt.scale + vt.x + c.clientWidth / 2;
      const sy = wy * vt.scale + vt.y + c.clientHeight / 2;
      const mk = (t) => new MouseEvent(t, {{ clientX: Math.trunc(r.left + sx), clientY: Math.trunc(r.top + sy),
        bubbles: true, cancelable: true, button: 0 }});
      c.dispatchEvent(mk('mousedown'));
      c.dispatchEvent(mk('mouseup'));
      await new Promise(r2 => setTimeout(r2, 120));

      const data2 = s.interiorData[{json.dumps(bid)}] || {{}};
      const fl2 = (data2.floors || []).find(f => f.id === fl.id);
      const items = (fl2 && fl2.furniture) || [];
      const newOnes = items.slice(before);
      return JSON.stringify({{
        floorId: fl.id, expect: tpl.items.length, before,
        after: items.length,
        placed: newOnes.map(i => ({{ name: i.name, type: i.type, x: i.x, y: i.y }})),
        selectedCount: Array.from(iv.selectedFurnitureIds || []).length,
        mode: iv.interactionMode,
      }});
    }})()""")
    if not isinstance(placed, dict) or 'after' not in placed:
        return False, f'房间模板链路异常 {placed}'
    fid = placed['floorId']
    expect = placed['expect']
    before_n = placed['before']
    if placed['after'] != before_n + expect:
        return False, f'房间模板未整间落位（{before_n} → {placed["after"]}，期望 +{expect}，mode={placed.get("mode")}）'
    items_placed = placed['placed']
    names = [p['name'] for p in items_placed]
    for need in ('长桌', '椅·左', '椅·右', '装饰·左'):
        if need not in names:
            return False, f'模板缺件「{need}」 {names}'
    xs = [p['x'] for p in items_placed]
    ys = [p['y'] for p in items_placed]
    if max(xs) - min(xs) > 500 or max(ys) - min(ys) > 500:
        return False, f'整间包围盒异常（落位散乱） x:{min(xs)}~{max(xs)} y:{min(ys)}~{max(ys)}'
    # 网格吸附：所有坐标应为网格步长(20)的整数倍
    bad = [p for p in items_placed if p['x'] % 20 or p['y'] % 20]
    if bad:
        return False, f'未按网格吸附落位 {bad}'
    if placed.get('selectedCount') != expect:
        return False, f'放置后未选中整间（选中数 {placed.get("selectedCount")}，期望 {expect}）'

    # 一条 undo 撤掉整间
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.4)
    undone = furniture_of_floor(cdp, bid, fid)
    if undone['n'] != before_n:
        return False, (f'一次撤销未撤掉整间（{placed["after"]} → {undone["n"]}，期望 {before_n}）'
                       f'—— undo 是否被拆成 {expect} 条？')
    _j(cdp, f"(() => {{ {STORE}.redo(); return 'ok'; }})()")
    time.sleep(0.4)
    redone = furniture_of_floor(cdp, bid, fid)
    if redone['n'] != before_n + expect:
        return False, f'重做未恢复整间（{redone["n"]}）'

    # 清场
    _j(cdp, f"(() => {{ {STORE}.undo(); return 'ok'; }})()")
    time.sleep(0.3)
    return True, (f'房间模板通过：模板「大厅」{expect} 件整间落位（含长桌/四椅/双装饰）、'
                  f'网格吸附正常、一次 undo 全撤 + 重做全回、放置后整间选中')
