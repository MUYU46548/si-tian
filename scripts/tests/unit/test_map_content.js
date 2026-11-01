#!/usr/bin/env node
/**
 * Node 单测：「这张行星地图有没有东西」的判定（`src/renderer/src/utils/mapContent.js`）
 *
 * 触发（用户 2026-11-01 原话）：「行星地图有一堆早期测试遗留笔刷产物，
 * 却每次都告诉我『这张行星地图还是空的』，令人忍俊不禁。」
 *
 * 修前口径：`useAutoRegions.js#fogMode` = `!(terrain.length || regions.length)` ——
 * 只认两个数组，于是**笔刷涂出来的图**（terrainGrid / heightmap 通道 / 河流 / 道路 / 标记 /
 * 文字 / .map 省份）一律被判空：既盖雾、又弹「还是空的」提示。
 *
 * 判据：
 *   a1 空对象 / null / 无字段 → 空
 *   a2 terrain / regions 多边形 → 有内容
 *   a3 **terrainGrid 涂了一格**（笔刷产物，用户报障的主因） → 有内容；全 0 → 空
 *   a4 heightmap.h 有非零值 → 有内容；全 0 → 空
 *   a5 通道笔刷：h 全 0 但 culture / religion 涂过 → 有内容
 *   a6 河流 / 道路 / 湖泊 / azgaarProvinces / azgaarStates → 有内容；a6b 纯标注 → 仍算空
 *   a7 **反向口径**：只有参看图（referenceImages）→ 仍算空（参看图不是司天自己的数据）
 *   a8 源码闸门：`useAutoRegions.js` 必须 import 它，且不许再留旧的两数组判定
 *
 * 用法：node scripts/tests/unit/test_map_content.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const SRC_COMPOSABLES = path.join(ROOT, 'src', 'renderer', 'src', 'composables');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-mapcontent-'));
  fs.copyFileSync(path.join(SRC_UTILS, 'mapContent.js'), path.join(tmp, 'mapContent.js'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const { mapHasContent, hasAnyValue } = await import(pathToFileURL(path.join(tmp, 'mapContent.js')).href);

  check('a1 空对象 / null / undefined 都判空', () => {
    eq(mapHasContent(null), false, 'null');
    eq(mapHasContent(undefined), false, 'undefined');
    eq(mapHasContent({}), false, '空对象');
    eq(mapHasContent({ planetId: 'p1', version: 1, terrain: [], regions: [], markers: [] }), false, '默认空壳');
  });

  check('a2 多边形：terrain / regions 任一非空即有内容', () => {
    eq(mapHasContent({ terrain: [{ id: 't1', points: [{ x: 0, y: 0 }] }] }), true, 'terrain');
    eq(mapHasContent({ regions: [{ id: 'r1', points: [] }] }), true, 'regions');
  });

  check('a3 地形涂格（笔刷产物）涂了一格 → 有内容，全 0 → 空', () => {
    const g = new Uint8Array(64);
    eq(mapHasContent({ terrainGrid: g }), false, '全 0 的 terrainGrid');
    g[17] = 3;
    eq(mapHasContent({ terrainGrid: g }), true, '涂过一格的 terrainGrid');
    eq(mapHasContent({ terrainGrid: { grid: Array.from(g), cols: 8, rows: 8 } }), true, '保存后的对象形态');
    eq(mapHasContent({ terrainGrid: Array.from(new Uint8Array(4)) }), false, '普通数组全 0');
  });

  check('a4 高度图 h：有非零值 → 有内容；全 0 / 全 20(海面) 之外的 0 → 空判定按"值"', () => {
    const zero = new Uint8Array(16);
    eq(mapHasContent({ heightmap: { h: zero } }), false, '全 0 高度图');
    const hm = new Uint8Array(16);
    hm[5] = 42;
    eq(mapHasContent({ heightmap: { h: hm } }), true, '有陆地高度');
  });

  check('a5 通道笔刷：h 全 0 但文化/宗教涂过 → 有内容', () => {
    const zero = new Uint8Array(9);
    const culture = new Uint8Array(9);
    culture[4] = 1;
    eq(mapHasContent({ heightmap: { h: zero, culture } }), true, 'culture 通道');
    const religion = [0, 0, 2, 0];
    eq(mapHasContent({ heightmap: { religion } }), true, 'religion 通道');
  });

  check('a6 河流 / 道路 / 湖泊 / 导入省份 → 有内容', () => {
    const cases = {
      rivers: [{ id: 'rv1', nodes: [] }],
      routes: [{ id: 'rt1', points: [] }],
      azgaarProvinces: [{ i: 1 }],
      azgaarStates: [{ i: 1 }],
      lakes: [{ id: 'lk1', points: [] }],
    };
    for (const [k, v] of Object.entries(cases)) {
      eq(mapHasContent({ [k]: v }), true, k);
    }
  });

  check('a6b 反向口径：**纯标注**（标记/文字/聚簇）不算底图有内容', () => {
    // 空态卡给的是「导入 .map 底图 / 开始绘制」—— 只有标注时底图仍然是空的，卡片该在。
    // （test_115 正是靠这条：它先塞标记/聚簇，再点空态里的导入按钮。）
    eq(mapHasContent({ markers: [{ id: 'm1', x: 1, y: 2 }] }), false, '只有标记');
    eq(mapHasContent({ textLabels: [{ id: 'l1', text: '甲' }] }), false, '只有文字');
    eq(mapHasContent({ clusters: [{ id: 'c1', memberIds: [] }] }), false, '只有聚簇');
    eq(mapHasContent({ markers: [{ id: 'm1' }], clusters: [{ id: 'c1' }] }), false, '标记+聚簇');
  });

  check('a7 反向口径：只有参看图 → 仍算空（参看图不是数据）', () => {
    eq(mapHasContent({ referenceImages: [{ id: 'ref1', src: 'x.png' }] }), false, '只有参看图');
  });

  check('a8 源码闸门：useAutoRegions 走唯一实现，不许再留两数组判定', () => {
    const src = fs.readFileSync(path.join(SRC_COMPOSABLES, 'useAutoRegions.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert(/from '\.\.\/utils\/mapContent'/.test(code), 'useAutoRegions 没有 import mapContent');
    assert(/mapHasContent\(/.test(code), 'useAutoRegions 没有调用 mapHasContent');
    assert(!/terrain\?\.length > 0\) \|\| \(currentMapData\.value\.regions\?\.length/.test(code),
      'useAutoRegions 还留着「只认 terrain/regions」的旧判定');
    const util = fs.readFileSync(path.join(SRC_UTILS, 'mapContent.js'), 'utf8');
    assert(/export function mapHasContent/.test(util), 'mapContent.js 缺 mapHasContent');
    assert(/export function hasAnyValue/.test(util), 'mapContent.js 缺 hasAnyValue');
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
