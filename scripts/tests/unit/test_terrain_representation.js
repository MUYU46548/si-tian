#!/usr/bin/env node
/**
 * Node 单元测试：地形表示判定（src/renderer/src/utils/terrainRepresentation.js）
 *
 * 背景（`docs/A1_DATA_MODEL_DECISION.md` §十 · M2/A2 第二步）：
 * PlanetMap 的地形此前以 `terrain[]` 多边形为**主表示**（不透明实色），高度图只是个默认关闭的
 * 叠加层 —— 这是「手绘几何编辑器」观感的根因。本步把地形改为**高度图驱动**，多边形退为可选覆盖物。
 *
 * 这条规则判错的后果是**静默**的：
 *   · 判成「有多边形就画多边形」→ 高度图又被挡住，回到原点；
 *   · 判成「旧地图也走高度图」→ **旧地图打开后地形整片消失**（没有高度图可画），用户只会看到空地图；
 *   · 多边形覆盖物不透明 → 覆盖物把高度图遮死，等于没打开。
 * 该模块无 DOM / 无 store 依赖，正好放 Node 层跑真实断言。
 *
 * 用法：node scripts/tests/unit/test_terrain_representation.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import（与其它 unit 用例一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const SRC = path.join(UTILS, 'terrainRepresentation.js');
const SRC_ACCESS = path.join(UTILS, 'heightmapAccess.js');

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
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 一份"有内容"的高度图（网格 2x2 + 4 个值） */
function hm() {
  return { grid: { points: [[0, 0], [1, 0], [0, 1], [1, 1]], spacing: 10, cellsX: 2, cellsY: 2 }, h: [1, 2, 3, 4] };
}

async function main() {
  const load = async (p) => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(p, 'utf8'), 'utf8').toString('base64'));
  const mod = await load(SRC);
  const { hasHeightmapContent, resolveTerrainRepresentation, POLYGON_OVERLAY_ALPHA, HEIGHTMAP_OVERLAY_ALPHA } = mod;

  // ---------- 1. hasHeightmapContent ----------
  check('h0 空值 / 无网格 / 空点集 / 空值数组 → 都没有内容可画', () => {
    assert(hasHeightmapContent(null) === false, 'null 应为 false');
    assert(hasHeightmapContent(undefined) === false, 'undefined 应为 false');
    assert(hasHeightmapContent({}) === false, '空对象应为 false');
    assert(hasHeightmapContent({ h: [1, 2] }) === false, '无 grid 应为 false');
    assert(hasHeightmapContent({ grid: { points: [] }, h: [1] }) === false, '空 points 应为 false');
    assert(hasHeightmapContent({ grid: { points: [[0, 0]] }, h: [] }) === false, '空 h 应为 false');
    assert(hasHeightmapContent({ grid: { points: [[0, 0]] }, h: [0] }) === true, '平坦但非空也算内容');
    return '6 种空形态 + 1 种"全 0 但非空"';
  });

  // ---------- 2. 有高度图：地形由高度图驱动，多边形退为覆盖物 ----------
  check('h1 有高度图 + 地形开关开 → 高度图是主表示，多边形**默认不画**', () => {
    const r = resolveTerrainRepresentation({ heightmap: hm(), terrainVisible: true, polygonsVisible: false, editing: false });
    eq(r.hasHeightmap, true, 'hasHeightmap');
    eq(r.source, 'heightmap', 'source');
    eq(r.drawHeightmap, true, 'drawHeightmap');
    eq(r.drawPolygons, false, 'drawPolygons（覆盖物默认关）');
    // ★ 主表示必须**不透明**：半透明会透出画布背景 → 地形看起来"脏"
    eq(r.heightmapAlpha, 1, 'heightmapAlpha（主表示不透明）');
    return `source=${r.source} polygons=${r.drawPolygons}`;
  });

  check('h2 开覆盖物 → 两者同显：高度图半透明 + 多边形半透明（都要看得见）', () => {
    const r = resolveTerrainRepresentation({ heightmap: hm(), terrainVisible: true, polygonsVisible: true, editing: false });
    eq(r.drawHeightmap, true, 'drawHeightmap');
    eq(r.drawPolygons, true, 'drawPolygons');
    eq(r.heightmapAlpha, HEIGHTMAP_OVERLAY_ALPHA, 'heightmapAlpha（叠加）');
    eq(r.polygonAlpha, POLYGON_OVERLAY_ALPHA, 'polygonAlpha（覆盖物）');
    // ★ 覆盖物必须半透明，否则它把高度图遮死 = 打开覆盖物等于回到旧观感
    assert(r.polygonAlpha < 1, '覆盖物不该是不透明的');
    return `hmAlpha=${r.heightmapAlpha} polyAlpha=${r.polygonAlpha}`;
  });

  check('h3 关掉地形总开关、只开覆盖物 → 多边形成为唯一显示，**实色**', () => {
    const r = resolveTerrainRepresentation({ heightmap: hm(), terrainVisible: false, polygonsVisible: true, editing: false });
    eq(r.drawHeightmap, false, 'drawHeightmap');
    eq(r.drawPolygons, true, 'drawPolygons');
    eq(r.source, 'polygon', 'source');
    eq(r.polygonAlpha, 1, 'polygonAlpha（此时它是唯一地形 → 实色）');
  });

  check('h4 两个开关都关、也没在编辑 → 什么都不画（source=none）', () => {
    const r = resolveTerrainRepresentation({ heightmap: hm(), terrainVisible: false, polygonsVisible: false, editing: false });
    eq(r.source, 'none', 'source');
    eq(r.drawHeightmap, false, 'drawHeightmap');
    eq(r.drawPolygons, false, 'drawPolygons');
  });

  check('h5 正在编辑多边形 → 强制显示（否则「看不见也点不到」）', () => {
    const r = resolveTerrainRepresentation({ heightmap: hm(), terrainVisible: false, polygonsVisible: false, editing: true });
    eq(r.drawPolygons, true, 'drawPolygons');
    eq(r.polygonAlpha, 1, '编辑时实色，便于看清轮廓与顶点');
  });

  check('h6 高度笔刷进行中 → 强制显示高度图（涂了必须看得见）', () => {
    const r = resolveTerrainRepresentation({ heightmap: hm(), terrainVisible: false, polygonsVisible: false, editing: false, forceHeightmap: true });
    eq(r.drawHeightmap, true, 'drawHeightmap');
    eq(r.source, 'heightmap', 'source');
  });

  // ---------- 3. 无高度图（旧多边形地图）：**零行为变更** ----------
  check('h7 ★ 无高度图 + 地形开关开 → 多边形照旧是主表示、**照旧不透明**（兼容性底线）', () => {
    const r = resolveTerrainRepresentation({ heightmap: null, terrainVisible: true, polygonsVisible: false, editing: false });
    eq(r.hasHeightmap, false, 'hasHeightmap');
    eq(r.drawHeightmap, false, 'drawHeightmap（没有高度图可画）');
    eq(r.drawPolygons, true, 'drawPolygons（旧地图的主表示）');
    eq(r.polygonAlpha, 1, '★ polygonAlpha 必须是 1：旧地图的观感不能因为这次改动而变');
    eq(r.source, 'polygon', 'source');
    return '旧地图打开即照旧';
  });

  check('h8 无高度图 + 地形开关关 → 不画多边形（与从前一致）', () => {
    const r = resolveTerrainRepresentation({ heightmap: null, terrainVisible: false, polygonsVisible: false, editing: false });
    eq(r.drawPolygons, false, 'drawPolygons');
    eq(r.source, 'none', 'source');
  });

  check('h9 无高度图 + 覆盖物开关开 → 也能显示多边形（新增入口，不是唯一路径）', () => {
    const r = resolveTerrainRepresentation({ heightmap: null, terrainVisible: false, polygonsVisible: true, editing: false });
    eq(r.drawPolygons, true, 'drawPolygons');
    eq(r.polygonAlpha, 1, 'polygonAlpha');
  });

  check('h10 高度图**损坏**（有对象但无网格）→ 按"没有高度图"处理，回落多边形', () => {
    const broken = { h: [1, 2, 3] };   // 缺 grid
    const r = resolveTerrainRepresentation({ heightmap: broken, terrainVisible: true, polygonsVisible: false, editing: false });
    eq(r.hasHeightmap, false, 'hasHeightmap');
    eq(r.drawPolygons, true, 'drawPolygons（回落到多边形，而不是画一片空白）');
    eq(r.polygonAlpha, 1, 'polygonAlpha');
    return '数据损坏时不至于让地图变空';
  });

  check('h11 不传任何参数 → 安全默认（不抛错、不画东西）', () => {
    const r = resolveTerrainRepresentation();
    eq(r.source, 'none', 'source');
    eq(r.drawHeightmap, false, 'drawHeightmap');
    eq(r.drawPolygons, false, 'drawPolygons');
  });

  // ---------- 4. 跨模块口径一致性（两条判定不能各说各话）----------
  const access = await load(SRC_ACCESS);
  // ⚠️ 两个函数**目的不同**，不能要求答案相同（第一版断言就写错成"逐例相等"，被用例自己抓出来）：
  //    · `hasGrid`            = 能否开始编辑高度（网格在即可，值数组可以还没生成）
  //    · `hasHeightmapContent` = 有没有东西**可画**（还要有值数组）
  //    正确关系是**蕴含**：可画 ⇒ 有网格。反向不成立。
  check('h0b 与 heightmapAccess.hasGrid 的口径关系正确（可画 ⇒ 有网格，且网格判据同源）', () => {
    const cases = [
      null,
      undefined,
      {},
      { grid: { points: [] }, h: [1] },
      { grid: { points: [[0, 0]] } },
      { grid: { points: [[0, 0]] }, h: [0] },
      { grid: { points: 'not-an-array' }, h: [1] },
      hm(),
    ];
    for (let i = 0; i < cases.length; i++) {
      const drawable = hasHeightmapContent(cases[i]);
      const editable = access.hasGrid(cases[i]);
      if (drawable && !editable) {
        throw new Error(`第 ${i} 例违反蕴含：可画=${drawable} 但 hasGrid=${editable}`);
      }
    }
    // 至少要有一例证明蕴含是**真**的（否则这批输入全 false，断言空转）
    const nonTrivial = cases.some((c) => hasHeightmapContent(c));
    assert(nonTrivial, '样例里必须存在"可画"的一例，否则蕴含断言是空转');
    return `${cases.length} 例满足"可画 ⇒ 有网格"，其中可画 ${cases.filter((c) => hasHeightmapContent(c)).length} 例`;
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.error('\n失败：');
    for (const f of failed) console.error(`  · ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('用例异常：', e); process.exit(1); });
