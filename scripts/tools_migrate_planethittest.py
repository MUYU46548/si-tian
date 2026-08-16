#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批次 2c 搬移脚本：从 PlanetMap.vue 提取命中检测函数 → composables/planetHitTest.js"""
import re

SRC = 'src/renderer/src/components/PlanetMap.vue'
OUT = 'src/renderer/src/composables/planetHitTest.js'

# 命中检测函数区（1-indexed）：
# hitTest 1390-1441, hitTestRoute 1444-1470, hitTestTextLabel 1473-1487,
# hitTestVertex 1490-1519, hitTestEdge 1522-1543, hitTestMarker 1577-1588
sections = [(1390, 1441), (1444, 1470), (1473, 1487), (1490, 1519), (1522, 1543), (1577, 1588)]

refs = ['currentMapData', 'places', 'selectedProvince', 'selectedRegion', 'selectedRoute', 'editMode']

lines = open(SRC, encoding='utf-8').read().split('\n')
parts = []
for start, end in sections:
    parts.append('\n'.join(lines[start - 1:end]))
body = '\n'.join(parts)

for ref in refs:
    body = re.sub(rf'\b{ref}\.value\b', f's.{ref}', body)

# 依赖替换：layers / getNodeRadius → s.xxx
body = body.replace('layers.isEditable', 's.layers.isEditable')
body = body.replace('getNodeRadius(', 's.getNodeRadius(')
# pointInPolygon → 从 geometry import（删本地定义，此处调用保持函数名）
# perpendicularDistance → 从 geometry import（调用保持）

header = '''/**
 * composables/planetHitTest.js — 行星地图命中检测（批次 2c：从 PlanetMap.vue 拆分）
 *
 * 只读命中检测：createPlanetHitTest(getState) 工厂，每次命中测试取最新解包状态。
 * 依赖 geometry 的 pointInPolygon / perpendicularDistance（纯函数）。
 */
import { pointInPolygon, perpendicularDistance } from '../utils/geometry';

export function createPlanetHitTest(getState) {

'''

footer = '''
  return {
    hitTest,
    hitTestRoute,
    hitTestTextLabel,
    hitTestVertex,
    hitTestEdge,
    hitTestMarker,
  };
}
'''

content = header + body + '\n' + footer
open(OUT, 'w', encoding='utf-8').write(content)
print(f'已生成 {OUT}（{len(body.splitlines())} 行函数体）')
leftover = re.findall(r'\b\w+\.value\b', body)
print('残留 .value:', leftover if leftover else '无')
