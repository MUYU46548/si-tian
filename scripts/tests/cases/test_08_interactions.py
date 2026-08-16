#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 08：PlanetMap 交互专项（P0-1，为 P0-2 交互拆分护航）

覆盖真实鼠标事件链路（mousedown → mousemove×N → mouseup / dblclick）：
  1. place 拖拽（单节点移动 + undo 恢复）
  2. 自由绘制省份（拖拽折线 → terrain +1 + undo）
  3. 点击描点（3 次单击 + 双击收尾 → terrain +1 + undo）
  4. 框选（Shift+拖拽空白 → 多地点选中）
  5. 顶点拖拽（选中省份拖顶点 → points 变化 + undo 恢复）
  6. 笔刷（brushMode 拖拽 → terrain +1 + undo）
"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import (goto_planet, enter_edit, confirm_yes, terrain_count,
                         fit_world, set_pm_state, click_canvas_at_world,
                         drag_canvas_polyline, dblclick_canvas_at_world)

NEAR = 1e-6  # 坐标比较容差（place 坐标为浮点）


def _eq(a, b, tol=8):
    return abs(a - b) <= tol


def _last_terrain_points(cdp):
    """最后一个地形的顶点数（防\"空多边形假通过\"——count+1 但 points 为空）"""
    v = set_pm_state(cdp, "const t = pm.currentMapData.terrain[pm.currentMapData.terrain.length - 1]; return t ? t.points.length : 0;")
    return int(v or 0)


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.5)
    enter_edit(cdp)
    time.sleep(1.0)
    confirm_yes(cdp)          # 重叠检测 confirm 一律通过
    fit_world(cdp)            # 适屏整个世界，保证世界坐标可见
    time.sleep(0.5)

    # ============ 1. place 拖拽 ============
    info = set_pm_state(cdp, """
      const p = pm.places.find(x => x.coordinate && x.coordinate.x !== null && !x.locked);
      if (!p) return 'no-place';
      window.__t_place = p.id;
      window.__t_orig = { x: p.coordinate.x, y: p.coordinate.y };
      // 注意：pan 模式走 panTry 分支（仅顶点试探，place 拖拽不执行）；
      // draw 模式 + drawMode=true 时点 place 会被绘制分支拦截——
      // place 拖拽的语义入口是 move 模式（移动工具，浏览模式安全设计）
      pm.setInteractionMode('move');
      return 'ok';
    """)
    if info != 'ok':
        return False, f'place 拖拽准备失败: {info}'
    orig = json.loads(cdp.eval("JSON.stringify(window.__t_orig)"))
    dx, dy = 120, 80
    drag_canvas_polyline(cdp, [(orig['x'], orig['y']), (orig['x'] + dx, orig['y'] + dy)])
    time.sleep(0.4)
    moved = json.loads(set_pm_state(cdp, """
      const p = pm.places.find(x => x.id === window.__t_place);
      return JSON.stringify({ x: p.coordinate.x, y: p.coordinate.y });
    """) or 'null')
    if not moved or not (_eq(moved['x'], orig['x'] + dx) and _eq(moved['y'], orig['y'] + dy)):
        return False, f'place 拖拽坐标未变化 ({orig} → {moved})'
    set_pm_state(cdp, "pm.undo(); return 'ok';")
    time.sleep(0.3)
    back = json.loads(set_pm_state(cdp, """
      const p = pm.places.find(x => x.id === window.__t_place);
      return JSON.stringify({ x: p.coordinate.x, y: p.coordinate.y });
    """) or 'null')
    if not back or not (_eq(back['x'], orig['x']) and _eq(back['y'], orig['y'])):
        return False, f'place 拖拽 undo 未恢复 ({moved} → {back})'

    # ============ 2. 自由绘制省份 ============
    c0 = terrain_count(cdp)
    set_pm_state(cdp, "pm.setInteractionMode('draw'); pm.gridSnapEnabled = false; return 'ok';")
    # 折线多边形（远离已有地形 -175~75 / -75~125）
    drag_canvas_polyline(cdp, [(400, 350), (700, 380), (650, 600), (380, 620), (400, 350)])
    time.sleep(0.5)
    c1 = terrain_count(cdp)
    if c1 != c0 + 1:
        return False, f'自由绘制失败 ({c0} → {c1})'
    if _last_terrain_points(cdp) < 3:
        return False, '自由绘制创建了空多边形'
    set_pm_state(cdp, "pm.undo(); return 'ok';")
    time.sleep(0.3)
    if terrain_count(cdp) != c0:
        return False, '自由绘制 undo 失败'

    # ============ 3. 点击描点 ============
    c0 = terrain_count(cdp)
    set_pm_state(cdp, "pm.setInteractionMode('draw'); pm.drawMode = false; pm.gridSnapEnabled = false; return 'ok';")
    for p in [(500, 300), (800, 400), (750, 560)]:
        click_canvas_at_world(cdp, p[0], p[1])
        time.sleep(0.25)
    dblclick_canvas_at_world(cdp, 750, 560)
    time.sleep(0.5)
    c1 = terrain_count(cdp)
    if c1 != c0 + 1:
        return False, f'点击描点失败 ({c0} → {c1})'
    if _last_terrain_points(cdp) < 3:
        return False, '点击描点创建了空多边形'
    set_pm_state(cdp, "pm.undo(); return 'ok';")
    time.sleep(0.3)
    if terrain_count(cdp) != c0:
        return False, '点击描点 undo 失败'

    # ============ 4. 框选 ============
    set_pm_state(cdp, "pm.setInteractionMode('pan'); pm.editMode = true; pm.selectedPlaceIds = new Set(); return 'ok';")
    box = set_pm_state(cdp, """
      const ps = pm.places.filter(p => p.coordinate && p.coordinate.x !== null).slice(0, 3);
      if (ps.length < 3) return 'no-places';
      const xs = ps.map(p => p.coordinate.x), ys = ps.map(p => p.coordinate.y);
      const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      // 沿左下对角线找空白起点（避开 province/place 命中——乐园星 13 个地形面）
      let start = null;
      for (let i = 0; i < 50; i++) {
        const x = box.minX - 80 - i * 100;
        const y = box.minY - 80 - i * 100;
        if (!pm.hitTestModule.hitTest(x, y)) { start = { x, y }; break; }
      }
      if (!start) return 'no-blank';
      window.__t_box = { sx: start.x, sy: start.y, ex: box.maxX + 80, ey: box.maxY + 80 };
      return 'ok';
    """)
    if box != 'ok':
        return False, f'框选准备失败: {box}'
    bx = json.loads(cdp.eval("JSON.stringify(window.__t_box)"))
    drag_canvas_polyline(cdp, [(bx['sx'], bx['sy']), (bx['ex'], bx['ey'])], shift=True)
    time.sleep(0.4)
    sel = set_pm_state(cdp, "return JSON.stringify([...pm.selectedPlaceIds]);")
    sel_list = json.loads(sel or '[]')
    if len(sel_list) < 2:
        return False, f'框选未选中多地点 ({sel})'
    # 清理选中，避免影响后续子测试
    set_pm_state(cdp, "pm.selectedPlaceIds = new Set(); return 'ok';")

    # ============ 5. 顶点拖拽 ============
    set_pm_state(cdp, "pm.setInteractionMode('pan'); pm.gridSnapEnabled = false; return 'ok';")
    vinfo = json.loads(set_pm_state(cdp, """
      const t = pm.currentMapData.terrain[0];
      if (!t || t.points.length < 3) return 'no-terrain';
      pm.selectedProvince = t;
      return JSON.stringify({ id: t.id, x: t.points[0].x, y: t.points[0].y });
    """) or 'null')
    if not vinfo:
        return False, '顶点拖拽准备失败: 无地形'
    v0 = (vinfo['x'], vinfo['y'])
    drag_canvas_polyline(cdp, [(v0[0], v0[1]), (v0[0] + 120, v0[1] + 80)])
    time.sleep(0.4)
    vcur = json.loads(set_pm_state(cdp, """
      const t = pm.currentMapData.terrain[0];
      return JSON.stringify({ x: t.points[0].x, y: t.points[0].y });
    """) or 'null')
    if not vcur or not (_eq(vcur['x'], v0[0] + 120) and _eq(vcur['y'], v0[1] + 80)):
        return False, f'顶点拖拽未生效 ({v0} → {vcur})'
    # undo 直到恢复原始顶点（上限 20 次，覆盖拖拽多步产生的多条 update 命令）
    restored = False
    for _ in range(20):
        set_pm_state(cdp, "pm.undo(); return 'ok';")
        time.sleep(0.15)
        vcheck = json.loads(set_pm_state(cdp, """
          const t = pm.currentMapData.terrain[0];
          return JSON.stringify({ x: t.points[0].x, y: t.points[0].y });
        """) or 'null')
        if vcheck and _eq(vcheck['x'], v0[0]) and _eq(vcheck['y'], v0[1]):
            restored = True
            break
    if not restored:
        return False, f'顶点拖拽 undo 未恢复 ({vcur} → {vcheck})'

    # ============ 6. 笔刷 ============
    c0 = terrain_count(cdp)
    set_pm_state(cdp, "pm.setInteractionMode('draw'); pm.brushMode = true; return 'ok';")
    drag_canvas_polyline(cdp, [(300, 700), (360, 720), (430, 745), (500, 780)])
    time.sleep(0.5)
    c1 = terrain_count(cdp)
    if c1 != c0 + 1:
        return False, f'笔刷失败 ({c0} → {c1})'
    if _last_terrain_points(cdp) < 3:
        return False, '笔刷创建了空多边形'
    set_pm_state(cdp, "pm.undo(); return 'ok';")
    time.sleep(0.3)
    if terrain_count(cdp) != c0:
        return False, '笔刷 undo 失败'

    return True, '交互专项 6 项全通过（place 拖拽/自由绘制/点击描点/框选/顶点拖拽/笔刷）'
