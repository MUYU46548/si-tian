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
      return JSON.stringify({
        w: r.width, h: r.height, bytes: t.length,
        isXml: t.startsWith('<?xml'),
        hasViewBox: /viewBox="0 0 \\d+ \\d+"/.test(t),
        hasBg: t.includes('fill="#1a2a3a"'),
        pathCount: (t.match(/<path /g) || []).length,
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
    if built['pathCount'] < built['terrainCount']:
        return False, f'地形 path 数少于多边形数（{built["pathCount"]} < {built["terrainCount"]}）: {built}'
    if not built['colored']:
        return False, f'SVG 没有填充色: {built}'
    if not built['hasLegend']:
        return False, f'SVG 缺地形图例: {built}'

    # ---------- 3. 图层开关被尊重 ----------
    off = json.loads(cdp.eval("""(() => {
      const pm = document.querySelector('.planet-map-container').__vueParentComponent.setupState;
      const before = (pm.buildFullMapSVG().svg.match(/<path /g) || []).length;
      pm.layers.toggleLayer('planet', 'terrain');
      const after = (pm.buildFullMapSVG().svg.match(/<path /g) || []).length;
      pm.layers.toggleLayer('planet', 'terrain');   // 还原
      const restored = (pm.buildFullMapSVG().svg.match(/<path /g) || []).length;
      return JSON.stringify({before, after, restored});
    })()"""))
    if not (off['after'] < off['before']):
        return False, f'关掉地形图层后 SVG 仍输出地形 path: {off}'
    if off['restored'] != off['before']:
        return False, f'还原图层后未恢复: {off}'

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
                  f' / {built["pathCount"]} path（地形 {built["terrainCount"]}）'
                  f' → 图层开关生效({off["before"]}→{off["after"]}→{off["restored"]})'
                  f' → 经 IPC 落盘 {saved["bytes"]}B')
