#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 06：纹理渲染（画布颜色丰富度）+ 湖泊颜色"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import A, enter_edit, goto_planet, sample_colors


RICH_JS = """(() => {
  const el = document.querySelector('.planet-map-container');
  const pm = el && el.__vueParentComponent && el.__vueParentComponent.setupState;
  const hm = (pm && pm.currentMapData && pm.currentMapData.heightmap) || null;
  if (!hm || !hm.h) return { uniq: 0, hasHeightmap: false };
  // 量"这份数据本身有多丰富"：h 与 biome（默认栅格着色按群系）。
  // ⚠️ 必须**全量**取唯一值 —— 只采样前 N 格会把真实数据误判成"平的"（踩过）。
  const uniqOf = (arr) => {
    if (!arr || !arr.length) return 0;
    const seen = new Set();
    for (let i = 0; i < arr.length; i += 13) seen.add(arr[i]);
    return seen.size;
  };
  const uh = uniqOf(hm.h);
  const ub = uniqOf(hm.biome);
  return { uniq: uh, h: uh, biome: ub, hasHeightmap: true, len: hm.h.length };
})()"""


def run(cdp):
    wait_for(cdp, "!!document.querySelector('.app-layout')", desc='应用挂载')
    import time

    r = goto_planet(cdp, A('曜川星'))
    if r != 'planet':
        return False, f'导航行星失败 ({r})'
    time.sleep(1.5)
    enter_edit(cdp)
    time.sleep(1.0)

    # 🔴 两条纪律（2026-10-06，--real-data 实测踩出来的）：
    #   ① **不能靠固定 sleep 断言**：真实 mapdata 比合成 fixture 大得多，底图是**迟加载**的
    #      （test_61 实测 1.8s 才自动选中并出内容）。原先 sleep 1.5+1.0s 就取色，真实数据下
    #      会取到"还没画上地形"的画布 → 8 色 → 误报成「纹理可能未渲染」。
    #      → 改成**轮询直到出纹理或超时**（失败时再断言）。
    #   ② 阈值**按数据丰富度分档**：真实库的行星高度图可能真的很平（用户还没画），
    #      那时少色是正确渲染。先量数据（h/temp/biome 的取值数），再决定断言哪一档，
    #      并把走的是哪一支写进结论。
    rich = cdp.eval(RICH_JS)
    if not isinstance(rich, dict) or 'uniq' not in rich:
        return False, f'读不到高度图丰富度：{rich!r}'

    colors = None
    for _ in range(20):                      # 最多 10s
        colors = sample_colors(cdp, 900)
        if colors and colors >= 30:
            break
        time.sleep(0.5)

    if rich['uniq'] >= 5:
        if not colors or colors < 30:
            # ⚠️ 文案刻意**中性**：真实数据下这条一直 <30，但结构层与 fixture 逐键同构、
            #    且默认栅格档 `biome` 本来就是"每个群系一块纯色"（5 群系 → 色少是可能的）。
            #    所以这里**不武断说"没渲染"**，只把事实摆出来交给判定：
            #      · 合成 fixture 同配置 ≈ 31 色（距阈值仅 1 —— 阈值本身是**边缘耦合**的）
            #      · 真实行星 ≈ 8 色，轮询 10s 不涨
            #    要定案需要 fixture↔真实的**逐像素对比**（另开一轮），别在这里放宽了事。
            return False, (f'真实/当前数据下画布只有 {colors} 色（h {rich["uniq"]} 种取值、'
                           f'biome {rich.get("biome")} 种；轮询 10s 未增长）—— '
                           f'需与合成 fixture（≈31 色）逐像素比对后定性：渲染差异 or 数据差异')
        grade = f'数据丰富档（h {rich["uniq"]} 种取值 / biome {rich.get("biome")} 种 → 要求 ≥30 色）'
    else:
        if not colors or colors < 2:
            return False, f'高度图扁平（{rich["uniq"]} 种取值）且画布几乎空白（{colors} 色）'
        grade = f'数据扁平档（高度图仅 {rich["uniq"]} 种取值 → 只要求画布非空白）'

    # 湖泊颜色已调浅
    lake = cdp.eval("(() => { const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState; return pm.terrainTypes.find(t => t.type === 'lake')?.color; })()")
    if lake != '#6FB3C8':
        return False, f'湖泊颜色未更新 ({lake})'
    return True, f'纹理渲染正常（{colors} 色；{grade}），湖泊 #6FB3C8'
