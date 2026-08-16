#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 05：地形 CRUD（拆分 → undo → redo → 合并 → undo）"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet, enter_edit, terrain_count, terrain_names


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    r = goto_planet(cdp, '乐园星')
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.5)
    enter_edit(cdp)
    time.sleep(1.0)

    # 找一个可拆分的省份（首名含"陆地"或任何）
    names = json.loads(terrain_names(cdp) or '[]')
    if len(names) < 1:
        return False, '无地形数据'
    target = next((n for n in names if '陆地' in n), names[0])
    count0 = terrain_count(cdp)

    # 拆分：直接调用 performSplit（构造穿过目标的切割线）
    split_result = cdp.eval(f"""(() => {{
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const poly = pm.currentMapData.terrain.find(t => t.name === '{target}');
      if (!poly) return 'no-poly';
      pm.selectedProvince = poly;
      const minX = Math.min(...poly.points.map(p => p.x));
      const maxX = Math.max(...poly.points.map(p => p.x));
      const cy = poly.points.reduce((s, p) => s + p.y, 0) / poly.points.length;
      pm.performSplit({{ x: minX - 10, y: cy }}, {{ x: maxX + 10, y: cy }});
      return pm.currentMapData.terrain.length;
    }})()""")
    if split_result != count0 + 1:
        return False, f'拆分失败 ({count0} → {split_result})'
    time.sleep(0.5)

    # undo
    cdp.eval("(() => { const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState; pm.undo(); return 'u'; })()")
    time.sleep(0.5)
    if terrain_count(cdp) != count0:
        return False, 'undo 拆分失败'

    # redo
    cdp.eval("(() => { const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState; pm.redo(); return 'r'; })()")
    time.sleep(0.5)
    if terrain_count(cdp) != count0 + 1:
        return False, 'redo 拆分失败'

    # 合并（拆出的两个"target 1/2"）
    merge_result = cdp.eval(f"""(() => {{
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const list = pm.currentMapData.terrain;
      const a = list.find(t => t.name === '{target} 1');
      const b = list.find(t => t.name === '{target} 2');
      if (!a || !b) return 'no-pair';
      pm.selectedProvince = a;
      const merged = pm.mergePolygons ? true : false;
      // 直接用 performMerge（原子操作 + undo）
      pm.performMerge(a.id, b.id);
      return pm.currentMapData.terrain.length;
    }})()""")
    if merge_result != count0:
        return False, f'合并失败 ({merge_result})'
    time.sleep(0.5)

    # undo 合并 → 恢复拆分状态
    cdp.eval("(() => { const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState; pm.undo(); return 'u'; })()")
    time.sleep(0.5)
    if terrain_count(cdp) != count0 + 1:
        return False, 'undo 合并失败'

    # 清空 undo 栈污染：连续 undo 到初始（拆分前）
    for _ in range(6):
        cdp.eval("(() => { const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState; pm.undo(); return 'u'; })()")
        time.sleep(0.2)
    return True, f'地形 CRUD 全链路 ({target}: 拆分/undo/redo/合并/undo)'
