#!/usr/bin/env node
/**
 * Node 单元测试：行星视图的 `.map` 导入映射（src/renderer/src/utils/planetMapBundle.js）
 *
 * 背景（2026-10-17）：`.map` 导入此前只装进**剧本底图**（`baseMaps[key]`），而行星图看的是
 * `mapData[planetId]` —— 另一个容器，此前没有任何导入路径。补上之后，映射写错不会报错：
 *   · 河流写成 `points`（行星侧 `drawRivers` 读 `nodes`）→ 「导入了但画不出来」；
 *   · 高度图只给 `h`（缺 temp/prec/biome）→ 行星侧会判成派生层损坏，把文件里的
 *     **温度/降水静默换成估值**（看起来一切正常）；
 *   · 退化环（<3 点）不跳过 → 画布上不可见，却占一个省份条目。
 * 这些都在纯函数层，用真实断言钉住。
 *
 * 用法：node scripts/tests/unit/test_planet_map_bundle.js
 * 退出码：0 = 全通过，1 = 有失败
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

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

/** 一份"像真的解析产物"（形状对齐 azgaar-parser.parseMapFile 的返回） */
function fakeParsed() {
  const grid = { points: [[0, 0], [10, 0], [0, 10], [10, 10]], spacing: 10, cellsX: 2, cellsY: 2, count: 4 };
  return {
    terrain: [
      {
        id: 'province_1', name: '甲省', type: 'polygon',
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
        stateId: 3, cultureId: 2, religionId: 5, color: '#a0b0c0',
      },
      {
        id: 'province_2', name: '乙省', type: 'polygon',
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],      // 退化环：2 点
        stateId: 3, cultureId: 0, religionId: 0,
      },
    ],
    rivers: [
      { id: 7, name: '长河', width: 0.4, discharge: 12, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
      { id: 8, name: '坏河', points: [{ x: 1, y: 2 }] },
    ],
    routes: [{ id: 9, name: '官道', points: [{ x: 5, y: 5 }, { x: 6, y: 6 }] }],
    heightmap: {
      grid,
      h: [10, 30, 50, 70],
      // 故意给一个"不像估值"的温度，用来验证「文件里的值被保留」
      temp: [11, 22, 33, 44],
      prec: [66, 55, 44, 33],
    },
    states: [{ i: 3, name: '甲国', color: '#ff0000' }],
    cultures: [{ i: 2, name: '甲文化', color: '#00ff00' }],
    religions: [{ i: 5, name: '甲教', color: '#0000ff' }],
    stats: { provinces: 2, rivers: 2, routes: 1, cells: 4, burgs: 3 },
    warnings: ['示例警告'],
  };
}

async function main() {
  // ⚠️ 本模块有**相对 import**（./terrainRepresentation / ./heightMath）——
  //    data:URL 载入法解析不了相对路径（ERR_UNSUPPORTED_RESOLVE_REQUEST）。
  //    所以把整个 utils 目录复制到临时目录，再从 file:// 导入（相对路径按目录结构自然解析）。
  const os = require('os');
  const fsp = require('fs').promises;
  const { pathToFileURL } = require('url');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sitian-pmb-'));
  const tmpUtils = path.join(tmp, 'utils');
  await fsp.cp(UTILS, tmpUtils, { recursive: true });
  // Vite 允许省略扩展名，Node 的 ESM **不允许** → 复制后给相对 import 补 `.js`
  for (const f of await fsp.readdir(tmpUtils)) {
    if (!f.endsWith('.js')) continue;
    const p = path.join(tmpUtils, f);
    const src = await fsp.readFile(p, 'utf8');
    const fixed = src.replace(/(from\s+|import\s+)'(\.[^']*)'/g, (m, head, spec) =>
      (/\.(js|json|mjs)$/.test(spec) ? m : `${head}'${spec}.js'`));
    if (fixed !== src) await fsp.writeFile(p, fixed, 'utf8');
  }
  const load = async (p) => import(pathToFileURL(p).href);
  const mod = await load(path.join(tmpUtils, 'planetMapBundle.js'));
  const {
    buildPlanetMapBundle, buildPlanetHeightmap, buildAzgaarReferenceLayers,
    planetMapContentCounts, describePlanetImportReceipt,
    PLANET_IMPORT_KEYS, PLANET_IMPORT_TERRAIN_TYPE,
  } = mod;
  const { SEA_LEVEL } = await load(path.join(tmpUtils, 'heightMath.js'));

  const parsed = fakeParsed();
  const bundle = buildPlanetMapBundle(parsed);

  // ══ a. 省份 ═══════════════════════════════════════════════════════════════
  check('a1 退化环（<3 点）被跳过，且计入 skippedProvinces', () => {
    eq(bundle.terrain.length, 1, '省份数');
    eq(bundle.stats.skippedProvinces, 1, 'skippedProvinces');
    eq(bundle.terrain[0].name, '甲省', '名字');
  });

  check('a2 省份 id 带 imp_ 前缀（与用户在行星上手画的 id 不同源，撤销/清点不混）', () => {
    eq(bundle.terrain[0].id, 'imp_province_1', 'id');
    assert(bundle.terrain[0].id.indexOf('imp_') === 0, '缺前缀');
  });

  check('a3 省份地形类型取合法值（行星画布按 terrainTypes 上色）', () => {
    eq(bundle.terrain[0].type, PLANET_IMPORT_TERRAIN_TYPE, 'type');
    eq(PLANET_IMPORT_TERRAIN_TYPE, 'land', '常量（useProvinceEditor.TERRAIN_TYPES 里必须存在）');
  });

  check('a4 参考图层需要的三个 id 原样带过来', () => {
    const p = bundle.terrain[0];
    eq(p.stateId, 3, 'stateId');
    eq(p.cultureId, 2, 'cultureId');
    eq(p.religionId, 5, 'religionId');
  });

  // ══ b. 河流 / 道路（字段名对不上 = 画不出来）════════════════════════════════
  check('b1 🔴 河流落在 `nodes`（行星侧 drawRivers 读的是 nodes）', () => {
    eq(bundle.rivers.length, 1, '河流数（1 点的坏河被跳过）');
    assert(Array.isArray(bundle.rivers[0].nodes), '缺 nodes');
    eq(bundle.rivers[0].nodes.length, 2, 'nodes 长度');
    assert(bundle.rivers[0].points === undefined, '不该同时留 points（两份字段会漂移）');
  });

  check('b2 道路落在 `points`（行星侧 drawRoutes 读的是 points）', () => {
    eq(bundle.routes.length, 1, '道路数');
    eq(bundle.routes[0].points.length, 2, 'points 长度');
    assert(bundle.routes[0].nodes === undefined, '道路不该有 nodes');
    eq(bundle.routes[0].dashed, false, 'dashed');
  });

  // ══ c. 高度图四通道 ═══════════════════════════════════════════════════════
  check('c1 🔴 四个通道齐全且长度 = 网格点数（缺 biome 会让 temp/prec 被重算成估值）', () => {
    const hm = bundle.heightmap;
    eq(hm.grid.points.length, 4, '网格点数');
    for (const k of ['h', 'temp', 'prec', 'biome']) {
      assert(hm[k] && hm[k].length === 4, `通道 ${k} 缺失或长度不对（${hm[k] && hm[k].length}）`);
    }
    return Object.keys(hm).join(',');
  });

  check('c2 文件里的温度/降水被保留（不是按高度估算）', () => {
    eq(Number(bundle.heightmap.temp[0]), 11, 'temp[0]');
    eq(Number(bundle.heightmap.prec[0]), 66, 'prec[0]');
  });

  check('c3 群系由 (高度, 温度, 降水) 推出：水下格 = ocean(0)', () => {
    // h[0]=10 < SEA_LEVEL(20) → 0
    eq(Number(bundle.heightmap.biome[0]), 0, 'biome[0]');
    assert(Number(bundle.heightmap.biome[1]) !== 0, '陆格不该是 ocean');
    return `SEA_LEVEL=${SEA_LEVEL}, biome=[${Array.from(bundle.heightmap.biome).join(',')}]`;
  });

  check('c4 没有高度图（有 grid 无 h）→ null，不造空壳', () => {
    const hm = buildPlanetHeightmap({ grid: { points: [[0, 0]] }, h: [] });
    eq(hm, null, '返回值');
    eq(buildPlanetHeightmap(null), null, 'null 入参');
  });

  check('c5 源里没有 temp/prec → 用同一套估算补齐（不是留空数组）', () => {
    const hm = buildPlanetHeightmap({ grid: { points: [[0, 0], [10, 0]], spacing: 10, cellsX: 2, cellsY: 1 }, h: [10, 90] });
    assert(hm && hm.temp.length === 2 && hm.prec.length === 2, '缺通道');
    assert(Number.isFinite(Number(hm.temp[1])), 'temp[1] 不是数字');
    return `temp=[${Array.from(hm.temp).join(',')}]`;
  });

  // ══ d. 参考图层（与剧本侧 importPlanetLayerData 共用同一映射）══════════════
  check('d1 政治/文化/宗教映射到 azgaar*，id 口径统一', () => {
    // ⚠️ 入参键名是 `provinces`（剧本侧 importPlanetLayerData 传的形状）；
    //    解析器产物里叫 `terrain` —— 两条来源都必须在 buildPlanetMapBundle 里被照顾到
    const layers = buildAzgaarReferenceLayers({ ...parsed, provinces: parsed.terrain });
    eq(layers.azgaarStates[0].id, 3, 'state id');
    eq(layers.azgaarCultures[0].name, '甲文化', 'culture name');
    eq(layers.azgaarReligions[0].color, '#0000ff', 'religion color');
    eq(layers.azgaarProvinces[0].stateId, 3, 'province.stateId');
    return Object.keys(layers).join(',');
  });

  check('d1b 🔴 解析器的 `terrain` 也要能产出参考图层（键名错 = 图层点了没反应）', () => {
    const b = buildPlanetMapBundle(parsed);
    assert(Array.isArray(b.azgaarProvinces) && b.azgaarProvinces.length === 2,
      `azgaarProvinces 缺失或数量不对（${b.azgaarProvinces && b.azgaarProvinces.length}）`);
    eq(b.azgaarStates.length, 1, 'azgaarStates');
  });

  check('d2 缺字段时不产出空图层（避免「图层开关亮了但什么都没有」）', () => {
    const layers = buildAzgaarReferenceLayers({});
    eq(Object.keys(layers).length, 0, '键数');
  });

  // ══ e. 覆盖判断 / 回执 ═════════════════════════════════════════════════════
  check('e1 planetMapContentCounts 数得清"会被覆盖的内容"', () => {
    const c = planetMapContentCounts({
      terrain: [{}, {}], rivers: [{}], routes: [],
      heightmap: { grid: { points: [[0, 0]] }, h: [1] },
    });
    eq(c.provinces, 2, 'provinces');
    eq(c.rivers, 1, 'rivers');
    eq(c.routes, 0, 'routes');
    eq(c.hasHeightmap, true, 'hasHeightmap');
  });

  check('e2 空地图 → 全 0 / false（空态判断不会被误触发）', () => {
    const c = planetMapContentCounts(null);
    eq(c.provinces + c.rivers + c.routes, 0, '计数');
    eq(c.hasHeightmap, false, 'hasHeightmap');
  });

  check('e3 回执说清"导入了什么"并点名城镇未导入', () => {
    const s = describePlanetImportReceipt('desite', bundle);
    assert(s.indexOf('省份 1 块') >= 0, `缺省份数：${s}`);
    assert(s.indexOf('河流 1 条') >= 0, `缺河流数：${s}`);
    assert(s.indexOf('城镇') >= 0, `城镇未导入必须点名：${s}`);
    assert(s.indexOf('高度图 有') >= 0, `缺高度图状态：${s}`);
    return s;
  });

  check('e4 源里没有高度图时回执明说（不是"缺开关"）', () => {
    const noHm = buildPlanetMapBundle({ ...fakeParsed(), heightmap: { grid: { points: [[0, 0]] }, h: [] } });
    eq(noHm.heightmap, null, 'heightmap');
    const s = describePlanetImportReceipt('desite', noHm);
    assert(s.indexOf('这份 .map 里就没有') >= 0, `回执没说清：${s}`);
    assert(noHm.warnings.some(w => w.indexOf('高度图') >= 0), 'warnings 没提高度图');
    return s;
  });

  check('e5 导入清单 = 8 个键（其余字段一律不动，靠它守）', () => {
    eq(PLANET_IMPORT_KEYS.length, 8, '键数');
    for (const k of ['terrain', 'rivers', 'routes', 'heightmap']) {
      assert(PLANET_IMPORT_KEYS.indexOf(k) >= 0, `缺 ${k}`);
    }
    assert(PLANET_IMPORT_KEYS.indexOf('markers') < 0, 'markers 不在导入清单里（覆盖它会删掉用户标记）');
    assert(PLANET_IMPORT_KEYS.indexOf('regions') < 0, 'regions 不在导入清单里');
    return PLANET_IMPORT_KEYS.join(',');
  });

  const failed = results.filter(r => !r.ok);
  console.log('=== 行星 .map 导入映射单元测试（Node）===');
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return failed.length ? 1 : 0;
}

main().then(code => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
