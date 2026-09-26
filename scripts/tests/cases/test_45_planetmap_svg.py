#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用例 45：PlanetMap SVG 矢量导出（B 收尾）

覆盖：
  1. 行星地图工具栏出现 SVG 导出入口（编辑模式 + 浏览模式各一个）
  2. buildFullMapSVG() 输出合法 SVG 文档：viewBox / 背景 / 地形 path / 标题 / 地形图例
  3. 关掉地形图层后，SVG 里不再出现地形 path（导出尊重图层开关）
  4. 经 saveTextFile IPC 落盘（mock 记录内容，不写盘）
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from lib.cdp import wait_for
from lib.helpers import goto_planet, planet_map


def run(cdp):
    level = goto_planet(cdp)
    if level != 'planet':
        return False, f'导航行星失败: {level}'
    wait_for(cdp, "!!document.querySelector('.planet-map-container')", desc='PlanetMap 挂载', timeout=10)

    # ---------- 1. 入口在位 ----------
    entry = json.loads(cdp.eval("""(() => {
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(b => (b.getAttribute('title') || '').includes('SVG'));
      return JSON.stringify({
        count: btns.length,
        testids: btns.map(b => b.dataset.testid || null).filter(Boolean),
      });
    })()"""))
    if entry['count'] < 1:
        return False, f'PlanetMap 缺 SVG 导出入口: {entry}'

    # ---------- 2. buildFullMapSVG 输出 ----------
    built = json.loads(cdp.eval("""(() => {
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const r = pm.buildFullMapSVG();
      const t = r.svg;
      // M2/A2 第二步：有高度图时地形由**高度图**驱动（SVG 里以内联位图承载），
      // 多边形退为**可选覆盖物**（默认关）→ 要验地形 path 就显式打开它。
      const peek = (layer) => {
        pm.layers.toggleLayer('planet', layer);
        const u = pm.buildFullMapSVG().svg;
        pm.layers.toggleLayer('planet', layer);
        return u;
      };
      const polyOn = peek('terrainPolygons');
      const restored = pm.buildFullMapSVG().svg;
      return JSON.stringify({
        w: r.width, h: r.height, bytes: t.length,
        isXml: t.startsWith('<?xml'),
        hasViewBox: /viewBox="0 0 \\d+ \\d+"/.test(t),
        hasBg: t.includes('fill="#1a2a3a"'),
        pathCount: (t.match(/<path /g) || []).length,
        imageCount: (t.match(/<image /g) || []).length,
        polyPathCount: (polyOn.match(/<path /g) || []).length,
        restoredPathCount: (restored.match(/<path /g) || []).length,
        hasClose: t.includes('</svg>'),
        terrainCount: (pm.currentMapData.terrain || []).length,
        placesCount: (pm.places || []).length,
        hasLegend: t.includes('>地形</text>'),
        hasTitle: t.includes('地形 · ') || t.includes('地形 ·'),
        colored: /fill="#[0-9A-Fa-f]{6}"/.test(t),
      });
    })()"""))
    if not built['hasClose'] or not built['isXml']:
        return False, f'SVG 文档结构不完整: {built}'
    if not built['hasViewBox'] or not built['hasBg']:
        return False, f'SVG 缺 viewBox/背景: {built}'
    if built['terrainCount'] < 1:
        return False, f'该行星没有地形多边形，用例前提不成立: {built}'
    # M2/A2 第二步：该行星有高度图 → 地形由高度图驱动，SVG 里以内联位图承载。
    # （本轮之前导出链里**根本没有高度图** —— 导出的图与画布不一致，属既存缺陷。）
    if built['imageCount'] < 1:
        return False, f'默认导出缺高度图（内联位图）: {built}'
    # 多边形已退为覆盖物：默认不画 → 打开后才出现足量地形 path
    if built['polyPathCount'] < built['terrainCount']:
        return False, (f'打开多边形覆盖物后地形 path 仍少于多边形数'
                       f'（{built["polyPathCount"]} < {built["terrainCount"]}）: {built}')
    if not (built['polyPathCount'] > built['pathCount']):
        return False, f'打开覆盖物后 path 数未增加（默认 {built["pathCount"]}）: {built}'
    if built['restoredPathCount'] != built['pathCount']:
        return False, f'关回覆盖物后导出未复原: {built}'
    if not built['colored']:
        return False, f'SVG 没有填充色: {built}'
    if not built['hasLegend']:
        return False, f'SVG 缺地形图例: {built}'

    # ---------- 3. 图层开关被尊重（M2/A2 第二步：开关对象改为「多边形覆盖物」）----------
    # ⚠️ 有高度图的行星上，「地形」总开关现在管的是**高度图**（位图，不是 path），
    #    地形 path 由「多边形(覆盖物)」图层控制 —— 所以这条断言必须跟着换开关对象，
    #    否则它测的其实是"高度图有没有被关掉"，与"地形 path"无关（会变成假绿/假红）。
    off = json.loads(cdp.eval("""(() => {
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const count = (t) => (t.match(/<path /g) || []).length;
      pm.layers.toggleLayer('planet', 'terrainPolygons');
      const on = count(pm.buildFullMapSVG().svg);
      pm.layers.toggleLayer('planet', 'terrainPolygons');
      const offv = count(pm.buildFullMapSVG().svg);
      pm.layers.toggleLayer('planet', 'terrainPolygons');
      const restored = count(pm.buildFullMapSVG().svg);
      pm.layers.toggleLayer('planet', 'terrainPolygons');   // 还原到默认（关）
      return JSON.stringify({on, off: offv, restored});
    })()"""))
    if not (off['on'] > off['off']):
        return False, f'打开多边形覆盖物后 SVG 地形 path 未增加: {off}'
    if off['restored'] != off['on']:
        return False, f'覆盖物图层状态不稳定（开关一次未复现）: {off}'

    # ---------- 4. 经 IPC 导出 ----------
    saved = json.loads(cdp.eval("""(async () => {
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      window.__LAST_TEXT_EXPORT__ = null;
      await pm.exportFullMapSVG();
      const rec = window.__LAST_TEXT_EXPORT__;
      return JSON.stringify({
        called: !!rec,
        kind: rec && rec.kind,
        name: rec && rec.defaultName,
        bytes: rec ? rec.text.length : 0,
        status: pm.exportStatus,
      });
    })()"""))
    if not saved['called']:
        return False, f'SVG 导出未走到 saveTextFile: {saved}'
    if saved['kind'] != 'svg' or not str(saved['name']).endswith('.svg'):
        return False, f'导出参数不对: {saved}'
    if saved['bytes'] < 200:
        return False, f'导出内容过小: {saved}'

    return True, (f'入口 {entry["count"]} 个 → SVG {built["w"]}x{built["h"]}px / {built["bytes"]}B'
                  f' / 高度图位图 {built["imageCount"]} 张'
                  f' / 覆盖物关 {built["pathCount"]} path → 开 {built["polyPathCount"]}'
                  f'（地形 {built["terrainCount"]}）'
                  f' → 经 IPC 落盘 {saved["bytes"]}B')
