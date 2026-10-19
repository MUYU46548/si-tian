#!/usr/bin/env node
/**
 * Node 单元测试：卡片墙「开局态势」的纯函数层（src/renderer/src/utils/scenarioCards.js）
 *
 * 来历（2026-10-17 第三轮）：缩略图成品缓存上线后，实测「第二次进卡片墙」仍要 **1020ms**
 * （探针 `scripts/tests/tools/_probe_picker_perf.js`，缓存 hits=10 / misses=10 未变）。
 * 逐段计时找出真凶：400 省 × 10 剧本，`openingSituation` 合计 **597.7ms**，
 * 其中 `provinceNetArea` 全量 **60.6ms** —— 同一份面积被**算了 10 遍**（每条剧本一遍）。
 *
 * 修法 = 调用方先 `provinceAreaIndex(terrain)` 算一次，逐条剧本复用（`{ areaOf }`）。
 * 本文件守三件（都不靠计时，计时在 CI 上会抖）：
 *   ① 索引口径 = 逐省 `provinceNetArea`（含带洞省份的净面积）；
 *   ② 给了索引与不给索引**结果逐字段一致**（优化不许悄悄改语义）；
 *   ③ 「每省只读一次几何」的**计数判据**（用计数 getter 数 `points` 被读了几次）——
 *      这条是"真的省下了重复计算"的硬证据，光看耗时快了多少说明不了问题。
 *
 * 用法：node scripts/tests/unit/test_scenario_cards.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 *
 * ⚠️ 被测模块是 ESM 且有相对 import → 复制到临时目录 + 补 `.js`（同其它 unit 用例）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['scenarioCards.js', 'scenarioTimeline.js', 'scenarioDates.js',
              'provinceShape.js', 'geometry.js', 'gridOutline.js', 'polylineSmooth.js'];

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

function pickTmpRoot() {
  const cands = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : '',
    os.tmpdir(), process.env.TEMP, process.env.TMP, os.homedir(),
  ];
  for (const c of cands) {
    if (!c || !path.isAbsolute(c)) continue;
    if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch (_) { /* 换下一个 */ }
  }
  return null;
}

/** 轴对齐矩形省（边长已知 → 面积可解析核对） */
const rect = (id, x0, y0, x1, y1, extra) => ({
  id, name: id, kind: 'land',
  points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  ...(extra || {}),
});

/** 一条剧本（buildTimeline 的输入形状） */
const scenario = (id, ownerKey, order, startYear, ownership, polities) => ({
  id, ownerKey, name: id, order,
  era: { roman: 'Ⅰ', label: id, startYear: String(startYear), endYear: String(startYear + 100) },
  polities: polities || [{ id: 'P1', name: '甲国', color: '#c23b3b' }],
  ownership: ownership || {},
});

async function main() {
  const root = pickTmpRoot();
  if (!root) throw new Error('找不到可写的临时目录');
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-cards-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

  const cards = await import(pathToFileURL(path.join(tmp, 'scenarioCards.js')).href);
  const tlMod = await import(pathToFileURL(path.join(tmp, 'scenarioTimeline.js')).href);
  const PShape = await import(pathToFileURL(path.join(tmp, 'provinceShape.js')).href);
  const { openingSituation, provinceAreaIndex } = cards;
  const { buildTimeline } = tlMod;

  // 一份带洞的省（净面积 ≠ 毛面积）+ 两个方省
  const holed = {
    id: 'holed', name: '带洞省', kind: 'land',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    extraRings: [[{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }]],
  };
  const terrain = [holed, rect('a', 200, 0, 300, 100), rect('b', 300, 0, 400, 100),
                   { id: 'sea1', kind: 'sea', points: [{ x: 900, y: 900 }, { x: 950, y: 900 }, { x: 950, y: 950 }] }];
  const mkTl = () => buildTimeline([
    scenario('s1', 'k', 1, 1000, { holed: 'P1', a: 'P1' }),
    scenario('s2', 'k', 2, 1100, { holed: 'P1', a: 'P1', b: 'P1' }),
  ]);

  // ---------- 1. 索引口径 ----------
  check('t1 面积索引 = 逐省 provinceNetArea（带洞省走**净**面积）', () => {
    const idx = provinceAreaIndex(terrain);
    eq(idx.get('a'), 10000, 'a 省净面积');
    eq(idx.get('holed'), PShape.provinceNetArea(holed), '带洞省面积应与逐省口径一致');
    assert(Math.abs(idx.get('holed') - 9600) < 1e-6,
      `带洞省净面积应为 100×100 − 20×20 = 9600（实际 ${idx.get('holed')}）`);
    eq(idx.has('sea1'), true, '海域也进索引（统计时才排除，口径不在这里分叉）');
    return `a=10000 / holed=${idx.get('holed')}`;
  });

  // ---------- 2. 语义等价（优化不许改结果） ----------
  check('t2 带 areaOf 与不带 areaOf 的输出**逐字段一致**', () => {
    const tl = mkTl();
    const idx = provinceAreaIndex(terrain);
    for (let k = 0; k < tl.scenarios.length; k++) {
      const a = openingSituation(tl, k, terrain);
      const b = openingSituation(tl, k, terrain, { areaOf: idx });
      eq(JSON.stringify(b), JSON.stringify(a), `第 ${k} 条剧本的态势`);
    }
    const a0 = openingSituation(mkTl(), 0, terrain);
    assert(a0.total === 3, `total 应只数陆地省（实际 ${a0.total}）`);
    assert(a0.top && a0.top.owner === 'P1', '开局最大势力');
    return `total=${a0.total}，top=${a0.top.name} ${Math.round(a0.top.pct * 100)}%`;
  });

  // ---------- 3. 「不再读几何」的硬判据 ----------
  check('t3 给了索引就**一次几何都不读**（计数 getter 数出来，不是"看着快"）', () => {
    // ⚠️ 不能用"getter 一读就抛"来判：`openingSituation` 的现算分支本就 `try/catch` 兜底
    //    （脏数据不许把卡片墙炸掉），异常会被吞掉 → 那种判据是**空转通过**。
    //    计数才是硬判据：读了几次是一个数。
    let reads = 0;
    const boom = { id: 'boom', name: '计数省', kind: 'land' };
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    Object.defineProperty(boom, 'points', {
      enumerable: true, configurable: true,
      get() { reads += 1; return pts; },
    });
    const tl = mkTl();
    const idx = new Map([['boom', 100]]);
    reads = 0;
    openingSituation(tl, 1, [boom], { areaOf: idx });
    eq(reads, 0, '带索引时不该读省份几何');
    // 反证：不给索引时这条读数必须 > 0（否则上一条判据是空转通过）
    openingSituation(tl, 1, [boom]);
    assert(reads > 0, '不给索引时本应读几何（陷阱没生效 = 上一条是假绿）');
    return `带索引读 ${0} 次；不带索引读 ${reads} 次`;
  });

  // ---------- 4. 计数判据：每省只读一次几何 ----------
  check('t4 面积只算一次：10 条剧本共享索引 = 全省读一遍，逐条现算 = 10 遍', () => {
    const N = 20;
    let reads = 0;
    const mkTerrain = () => Array.from({ length: N }, (_, i) => {
      const p = { id: 't' + i, name: 't' + i, kind: 'land' };
      const pts = [{ x: i, y: 0 }, { x: i + 10, y: 0 }, { x: i + 10, y: 10 }, { x: i, y: 10 }];
      Object.defineProperty(p, 'points', {
        enumerable: true, configurable: true,
        get() { reads += 1; return pts; },
      });
      return p;
    });
    const terr = mkTerrain();
    const scs = Array.from({ length: 10 }, (_, i) =>
      scenario('p' + i, 'k', i + 1, 1000 + i * 10, Object.fromEntries(terr.map((p) => [p.id, 'P1']))));
    const tl = buildTimeline(scs);

    reads = 0;
    const idx = provinceAreaIndex(terr);
    const readsIndex = reads;
    assert(readsIndex >= N, `建索引应至少每省读一次（实际 ${readsIndex}）`);

    reads = 0;
    for (let k = 0; k < tl.scenarios.length; k++) openingSituation(tl, k, terr, { areaOf: idx });
    const readsShared = reads;
    eq(readsShared, 0, '共享索引时态势计算本身**一次几何都不该读**');

    reads = 0;
    for (let k = 0; k < tl.scenarios.length; k++) openingSituation(tl, k, terr);
    const readsRepeat = reads;
    assert(readsRepeat >= readsIndex * 5,
      `逐条现算应远多于建一次索引（索引 ${readsIndex} vs 现算 ${readsRepeat}）`);
    return `省读次数：建索引 ${readsIndex} / 共享索引 +10 剧本 ${readsShared} / 逐条现算 ${readsRepeat}`;
  });

  // ---------- 5. 脏数据不炸 ----------
  check('t5 缺 id / 空点列 / null 省不炸（卡片墙面对的是用户数据）', () => {
    const idx = provinceAreaIndex([null, { name: '没有 id 的省', points: [] }, rect('ok', 0, 0, 10, 10)]);
    eq(idx.size, 1, '只有带 id 的省进索引');
    const tl = mkTl();
    const r = openingSituation(tl, 0, [null, undefined, { id: 'x', kind: 'land', points: [] }], { areaOf: idx });
    assert(r.total === 1, `只数得出的陆地省（实际 ${r.total}）`);
    assert(r.byPolity.length === 0, '无归属 → 不画态势条');
    eq(r.empty, true, 'empty 标记');
    return `总省数 ${r.total}，empty=${r.empty}`;
  });

  // ---------- 6. 海域不进统计（既有口径回归） ----------
  check('t6 海域不参与总省数（口径不在索引层分叉）', () => {
    const tl = mkTl();
    const withSea = openingSituation(tl, 1, terrain, { areaOf: provinceAreaIndex(terrain) });
    const noSea = openingSituation(tl, 1, terrain.filter((p) => p.kind !== 'sea'),
      { areaOf: provinceAreaIndex(terrain) });
    eq(withSea.total, noSea.total, '带不带海域，total 应一样');
    eq(withSea.byPolity.length, 1, '只有一个势力');
    return `total=${withSea.total}（海域未计入）`;
  });

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败：');
    for (const f of failed) console.log(`  · ${f.name}: ${f.detail}`);
  }
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('用例异常：', e); process.exit(1); });
