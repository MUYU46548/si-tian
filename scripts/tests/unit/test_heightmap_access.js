#!/usr/bin/env node
/**
 * Node 单元测试：高度图归属判定（src/renderer/src/utils/heightmapAccess.js）
 *
 * 为什么要有这一层：A1（docs/A1_DATA_MODEL_DECISION.md）决定「以行星的高度图为单一真源，
 * 剧本底图按 planetId 绑定代理过去」。这条规则一旦判错，后果不是报错而是**静默分裂**：
 * 在剧本里涂的山行星看不见（双源),或者绑定后悄悄回落到旧的一份、让用户以为绑定生效了。
 * 该模块无 DOM / 无 store 依赖，正好放 Node 层跑真实断言。
 *
 * 用法：node scripts/tests/unit/test_heightmap_access.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测试模块是 ESM（Vite 源码），本文件是 CJS → 用 data: URL 动态 import（与其它 unit 用例一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'heightmapAccess.js');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    if (detail && detail.then) {
      throw new Error('check() 不支持异步回调，请用同步断言');
    }
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

function hm(seed) {
  return { grid: { points: [[0, 0], [1, 0], [0, 1], [1, 1]], spacing: 10, cellsX: 2, cellsY: 2 }, h: [seed, 1, 2, 3], tag: seed };
}

async function main() {
  const src = fs.readFileSync(SRC, 'utf8');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
  const { boundPlanetId, resolveHeightmap, hasGrid, planBindBaseMapToPlanet, planUnbindBaseMap, buildGridFromTerrain } = mod;

  // ── 1. boundPlanetId ──────────────────────────────────────────────────────
  check('boundPlanetId：无绑定 / 合法 / 空串与非字符串都返回 null', () => {
    eq(boundPlanetId({}), null, '无字段');
    eq(boundPlanetId({ planetId: '' }), null, '空串');
    eq(boundPlanetId({ planetId: 123 }), null, '非字符串');
    eq(boundPlanetId(null), null, 'null 底图');
    eq(boundPlanetId({ planetId: 'p1' }), 'p1', '合法绑定');
  });

  // ── 2. resolveHeightmap：未绑定 = 用自己那份（向后兼容） ──────────────────
  check('未绑定：owner=self 且返回底图自己那份（同一引用）', () => {
    const own = hm('self');
    const r = resolveHeightmap({ heightmap: own }, { p1: { heightmap: hm('planet') } });
    eq(r.owner, 'self', 'owner');
    eq(r.planetId, null, 'planetId');
    eq(r.heightmap, own, '应是底图自己那份（同一引用）');
  });

  // ── 3. resolveHeightmap：绑定 = 用行星那份（★ M1 的核心验收） ─────────────
  check('已绑定：owner=planet，且返回的就是行星那份对象（=== 同一引用）', () => {
    const planetHm = hm('planet');
    const mapData = { p1: { heightmap: planetHm } };
    const r = resolveHeightmap({ planetId: 'p1', heightmap: hm('self') }, mapData);
    eq(r.owner, 'planet', 'owner');
    eq(r.planetId, 'p1', 'planetId');
    assert(r.heightmap === planetHm, '返回的必须是行星那份**同一个对象**（不是副本 —— 复制即双源）');
    assert(r.heightmap !== mapData.p1.heightmap || true, '');
  });

  // ── 4. 绑定即只认行星：行星还没有高度图 → null（绝不回落到自己那份） ──────
  check('已绑定但行星没有高度图 → 返回 null（禁止悄悄回落，那正是双源漂移起点）', () => {
    const r = resolveHeightmap({ planetId: 'p1', heightmap: hm('self') }, { p1: {} });
    eq(r.owner, 'planet', 'owner');
    eq(r.heightmap, null, '必须 null，不能回落到底图自己那份');
  });

  check('★ 悬空绑定（行星已不存在）→ 回落自身 + dangling=true（绝不静默丢数据）', () => {
    const own = hm('self');
    const r = resolveHeightmap({ planetId: 'ghost', heightmap: own }, {});
    eq(r.dangling, true, '应标记 dangling（调用方据此提示并引导解绑/重绑）');
    eq(r.owner, 'self', '应回落到自身');
    eq(r.heightmap, own, '应把底图自己那份还回来 —— 行星没了不等于底图的高度图也该消失');
  });

  check('★ 与悬空严格区分：行星存在但还没高度图 → owner=planet / null / dangling=false', () => {
    const r = resolveHeightmap({ planetId: 'p1', heightmap: hm('self') }, { p1: {} });
    eq(r.dangling, false, '不是悬空（是正常的"还没创建"）');
    eq(r.owner, 'planet', 'owner 必须是 planet');
    eq(r.heightmap, null, '必须 null —— 此时回落 self 才是双源漂移的起点');
  });

  // ── 5. hasGrid ────────────────────────────────────────────────────────────
  check('hasGrid：正常 / 空点 / 缺 grid / null', () => {
    eq(hasGrid(hm('x')), true, '正常');
    eq(hasGrid({ grid: { points: [] } }), false, '空点');
    eq(hasGrid({ h: [1] }), false, '缺 grid');
    eq(hasGrid(null), false, 'null');
    eq(hasGrid({ grid: { points: 'no' } }), false, 'points 非数组');
  });

  // ── 6. planBindBaseMapToPlanet：冲突必须拒绝（不静默丢一边） ──────────────
  check('两边都有高度图 → 拒绝并回报冲突（绝不静默选一边）', () => {
    const r = planBindBaseMapToPlanet({ heightmap: hm('self') }, 'p1', { p1: { heightmap: hm('planet') } });
    eq(r.ok, false, '应拒绝');
    eq(r.conflict, true, '应标记 conflict');
    assert(r.selfHeightmap && r.planetHeightmap, '应把两份都回报给调用方');
    assert(/都已有高度图/.test(r.error), `错误信息应说清冲突：${r.error}`);
  });

  // ── 6b. ★ R2 一星一图（2026-09-25）：同一行星不能被两张底图绑定 ────────────
  check('★ 一星一图：目标行星已被另一张底图绑定 → 拒绝并报出占用者', () => {
    const self = { id: 'kB' };
    const all = { kA: { id: 'kA', name: '时期甲', planetId: 'p1' }, kB: self };
    const r = planBindBaseMapToPlanet(self, 'p1', { p1: {} }, all);
    eq(r.ok, false, '应拒绝');
    eq(r.conflict, true, '应标记 conflict');
    eq(r.conflictKind, 'planet-taken', '冲突类型');
    assert(/已被底图/.test(r.error), `错误信息应说清谁占用了：${r.error}`);
    eq(r.holderKey, 'kA', '回报占用者 key');
    eq(r.holderName, '时期甲', '回报占用者名称');
  });

  check('一星一图：重绑自身（幂等）不算冲突；不传 allBaseMaps 时跳过检查（向后兼容）', () => {
    const self = { id: 'kB', planetId: 'p1' };
    eq(planBindBaseMapToPlanet(self, 'p1', { p1: {} }, { kB: self }).ok, true, '自身不算占用者');
    eq(planBindBaseMapToPlanet({ id: 'kB' }, 'p1', { p1: {} }).ok, true, '不传 allBaseMaps 时不检查');
  });

  check('一星一图：占用者绑的是**别的**行星时不影响本行星', () => {
    eq(planBindBaseMapToPlanet({ id: 'kB' }, 'p1', { p1: {} }, { kA: { planetId: 'p2' } }).ok, true,
       '不同行星互不影响');
  });

  // ── 7. planBindBaseMapToPlanet：只有底图有 → 迁移到行星 ───────────────────
  check('只有底图有高度图 → migrate 到行星，且底图对象上不再留 heightmap', () => {
    const own = hm('self');
    const r = planBindBaseMapToPlanet({ id: 'k', heightmap: own }, 'p1', { p1: {} });
    eq(r.ok, true, '应成功');
    eq(r.nextBaseMap.planetId, 'p1', '应写入绑定');
    eq(r.nextBaseMap.heightmap, undefined, '底图侧不应再保留 heightmap（避免第二份）');
    assert(r.migrate && r.migrate.heightmap === own, 'migrate 应携带**原对象**');
    eq(r.migrate.planetId, 'p1', 'migrate 目标');
  });

  // ── 8. planBindBaseMapToPlanet：只有行星有 / 都没有 → 直接绑定 ────────────
  check('只有行星有 → 直接绑定（无 migrate）；都没有 → 直接绑定', () => {
    const a = planBindBaseMapToPlanet({ id: 'k' }, 'p1', { p1: { heightmap: hm('planet') } });
    eq(a.ok, true, '只有行星有应成功');
    eq(a.migrate, undefined, '不应有迁移');
    eq(a.nextBaseMap.planetId, 'p1', '应写入绑定');
    const b = planBindBaseMapToPlanet({ id: 'k' }, 'p1', { p1: {} });
    eq(b.ok, true, '都没有应成功');
    eq(b.migrate, undefined, '不应有迁移');
  });

  // ── 9. 入参不被改写（纯函数） ─────────────────────────────────────────────
  check('planBindBaseMapToPlanet 不修改入参对象', () => {
    const base = { id: 'k', heightmap: hm('self'), other: 1 };
    const copy = JSON.parse(JSON.stringify(base));
    planBindBaseMapToPlanet(base, 'p1', { p1: {} });
    eq(JSON.stringify(base), JSON.stringify(copy), '入参被改写了');
  });

  check('planBindBaseMapToPlanet：缺 planetId / 行星不存在 → 明确报错', () => {
    eq(planBindBaseMapToPlanet({ id: 'k' }, '', { p1: {} }).ok, false, '缺 planetId 应失败');
    eq(planBindBaseMapToPlanet({ id: 'k' }, 'ghost', {}).ok, false, '行星不存在应失败');
    eq(planBindBaseMapToPlanet(null, 'p1', { p1: {} }).ok, false, '底图不存在应失败');
  });

  // ── 10. 解绑 ──────────────────────────────────────────────────────────────
  check('planUnbindBaseMap：只摘绑定字段，其余原样', () => {
    const r = planUnbindBaseMap({ id: 'k', planetId: 'p1', terrain: [1] });
    eq(r.ok, true, 'ok');
    eq(r.nextBaseMap.planetId, undefined, '应摘掉绑定');
    eq(r.nextBaseMap.id, 'k', '其余字段保留');
    eq(r.nextBaseMap.terrain.length, 1, '其余字段保留');
  });

  // ── 11. buildGridFromTerrain（未绑定底图的「从零开始」） ──────────────────
  check('buildGridFromTerrain：空底图给默认方框，行列与点数自洽', () => {
    const g = buildGridFromTerrain([], 100, 1);
    eq(g.spacing, 100, 'spacing');
    assert(g.cellsX >= 2 && g.cellsY >= 2, '至少 2×2');
    eq(g.points.length, g.cellsX * g.cellsY, '点数 = 行×列');
    eq(g.count, g.points.length, 'count 与点数一致');
    assert(Array.isArray(g.points[0]) && g.points[0].length === 2, '点是 [x,y] 形式');
  });

  check('buildGridFromTerrain：按地形包围盒外扩（margin 以格为单位）', () => {
    const terrain = [{ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] }];
    const g = buildGridFromTerrain(terrain, 50, 1);
    eq(g.cellsX, 5, '列数（-50..150 / 50 + 1）');
    eq(g.cellsY, 4, '行数（-50..100 / 50 + 1）');
    eq(g.points[0][0], -50, '原点 x 外扩 1 格');
    eq(g.points[0][1], -50, '原点 y 外扩 1 格');
    eq(g.points[g.points.length - 1][0], 150, '末列 x');
  });

  const failed = results.filter(r => !r.ok);
  console.log('=== 高度图归属判定（Node）===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then(code => process.exit(code)).catch((err) => {
  console.error('单元测试运行器异常:', err);
  process.exit(1);
});
