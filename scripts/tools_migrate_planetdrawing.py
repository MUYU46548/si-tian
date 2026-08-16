#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批次 2a 搬移脚本：从 PlanetMap.vue 提取绘制函数区 → composables/planetDrawing.js"""
import re

SRC = 'src/renderer/src/components/PlanetMap.vue'
OUT = 'src/renderer/src/composables/planetDrawing.js'

# 绘制函数区（1-indexed）：1836 drawReferenceImage ~ 2859 getContrastColor
START, END = 1836, 2859

refs = ['activeClusterId', 'activeRefIndex', 'autoRegions', 'boxSelectEnd', 'boxSelectStart',
        'brushMode', 'brushSize', 'brushStrokePoints', 'clusterBoxEnd', 'clusterBoxStart',
        'currentMapData', 'currentPath', 'drawingPolygon', 'edgeSnapPreview', 'editMode',
        'gridSize', 'highlightedPlaceId', 'hoveredNode', 'hoveredVertex', 'hoverMemberId',
        'interactionMode', 'isBoxSelecting', 'isBrushing', 'isDrawing', 'lodRef',
        'mirrorAxis', 'mirrorAxisOffset', 'mirrorMode', 'placeRegionMap', 'places',
        'refDragMode', 'referenceImages', 'routeColor', 'routeDashed', 'routeDraftPoints',
        'selectedMarker', 'selectedPlaceIds', 'selectedProvince', 'selectedRegion',
        'selectedRoute', 'selectedTerrain', 'selectedTextLabel', 'splitPoints', 'splitSelectMode']

lines = open(SRC, encoding='utf-8').read().split('\n')
func_lines = lines[START - 1:END]  # 0-indexed slice

body = '\n'.join(func_lines)

# 状态访问替换：NAME.value → s.NAME
for ref in refs:
    body = re.sub(rf'\b{ref}\.value\b', f's.{ref}', body)

# 常量/对象替换：terrainTypes / refImageObjs → s.xxx
body = body.replace('terrainTypes', 's.terrainTypes')
body = body.replace('refImageObjs', 's.refImageObjs')

# 保留的函数内局部变量检查：drawFog 的 fillText 文本含「编辑地图」无影响

header = '''/**
 * composables/planetDrawing.js — 行星地图 Canvas 绘制函数（批次 2a：从 PlanetMap.vue 拆分）
 *
 * 纯绘制函数集合：不持有状态，通过 createPlanetDrawing(getState) 工厂注入状态访问器。
 * getState() 每次渲染时调用，返回解包后的最新状态对象（ref 已在组件侧 .value 解包）。
 * 拆分原则：绘制只读状态 + 渲染，交互/修改留在组件。
 */
import { getTexturePattern } from '../utils/textures';

export function createPlanetDrawing(getState) {
  const s = getState(); // 仅用于捕获外层引用；函数体内每次渲染取最新

'''

footer = '''
  return {
    drawReferenceImage,
    drawFog,
    drawBackground,
    drawTerrain,
    drawRegions,
    drawPlaces,
    drawMarkers,
    drawRoutes,
    drawRoutePolyline,
    drawTextOnPath,
    drawClusters,
    drawTextLabels,
    drawEditHelpers,
    drawSelectedHighlight,
    getPolygonCenter,
    darkenColor,
    getContrastColor,
  };
}
'''

content = header + body + '\n' + footer
open(OUT, 'w', encoding='utf-8').write(content)
print(f'已生成 {OUT}（{len(func_lines)} 行函数体）')

# 验证：残留 .value 访问（应为 0 或极少数非 ref 属性）
leftover = re.findall(r'\b\w+\.value\b', body)
print('残留 .value 访问:', leftover if leftover else '无')
