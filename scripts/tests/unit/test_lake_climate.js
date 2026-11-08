#!/usr/bin/env node
/**
 * Node 单元测试：气候判湖（`src/renderer/src/utils/lakes.js#classifyLakesByClimate`）
 *
 * 为什么要有这一层（卡「干旱盆地（playa/盐湖）：判湖要读降水，别只看几何」）：
 *   `detectBasinLakes` 只看**几何**（被填平的面积 ≥ 门槛、深度 ≥ 门槛），与气候无关 —— 于是
 *   「雨林里一个浅坑成湖、沙漠里一个更深的盆地反而不成湖」。真实地图里干旱区的洼地应该是
 *   **盐湖 / playa / 干盐湖**：水是有，但很少，撑不起一湖满水。
 *
 * 本用例守四件事（都不需要浏览器）：
 *   ① **只降级、不新建**：干旱区不许凭空多出湖，条数只减不增；
 *   ② **淡水湖一个不动**：`prec ≥ minPrec` 的湖连 `saline` 字段都不加（老载荷逐字节不变）；
 *   ③ 干旱区的面积门槛**随干旱程度**放大（越干越要大面积才算湖）；
 *   ④ 真实链路：同一份地形把降水乘 0.2 → 湖数明显下降；乘 5 → 不爆炸（不是"越湿越多"）。
 *
 * 用法：node scripts/tests/unit/test_lake_climate.js
 * 退出码：0 = 全通过，1 = 有失败（run_tests.py 作为前置步骤计入）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

/** 收集 `./x` / `./sub/x` / `../y` 依赖并拷到临时目录（相对导入补 .js，同 test_terrain_erosion.js） */
function collectDeps(entries) {
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop().replace(/\\/g, '/');
    if (seen.has(f)) continue;
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    seen.set(f, src);
    for (const m of src.matchAll(/from '(..?\/[^']+)'/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      queue.push(rel.endsWith('.js') ? rel : rel + '.js');
    }
  }
  return seen;
}

function loadModules(names) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-lakes-'));
  for (const [f, src] of collectDeps(names)) {
    const fixed = src.replace(/from '(\.\.?\/[^']+)'/g, (all, spec) => (spec.endsWith('.js') ? all : `from '${spec}.js'`));
    const dest = path.join(tmp, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fixed);
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  return { tmp, url: (f) => pathToFileURL(path.join(tmp, f)).href };
}

const results = [];
function check(name, fn) { return Promise.resolve().then(fn).then((d) => {
  results.push({ name, ok: true, detail: d || '' });
}).catch((err) => { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }); }
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, label) { if (a !== b) throw new Error(`${label}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

/** 点是否在多边形内（射线法；只用于夹具轮廓） */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** 圆形大陆夹具（同 test_terrain_erosion：确定性正弦起伏，不随机） */
function makeTerrain() {
  const R = 380;
  const ring = [];
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const r = R * (1 + 0.08 * Math.sin(a * 3 + 0.7) + 0.05 * Math.sin(a * 7 - 1.1));
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return { ring, isLand: (x, y) => pointInRing(x, y, ring) };
}

/** 造一批"湖"：cells 是连续格下标，prec 里给这些格填同一个值 */
function makeLakes(specs, cols) {
  const lakes = [];
  const prec = new Float32Array(4000);
  let cursor = 0;
  for (const spec of specs) {
    const cells = [];
    for (let k = 0; k < spec.area; k++) cells.push(cursor + k * cols);
    cursor += 4;
    for (const i of cells) prec[i] = spec.prec;
    lakes.push({ level: 30, cells });
  }
  return { lakes, prec };
}

async function main() {
  const { url } = loadModules(['lakes.js', 'terrainPipeline.js', 'heightMath.js', 'heightmapRaster.js']);
  const L = await import(url('lakes.js'));
  const P = await import(url('terrainPipeline.js'));
  const HM = await import(url('heightMath.js'));
  const { classifyLakesByClimate, lakeMeanPrecipitation, LAKE_CLIMATE } = L;

  // ══════════════════════════════════════════════════════════════
  // A. 纯函数口径
  // ══════════════════════════════════════════════════════════════
  await check('a1 淡水湖一个不动：连 saline 字段都不加（同一个对象引用）', () => {
    const { lakes, prec } = makeLakes([{ area: 20, prec: 80 }, { area: 30, prec: 65 }], 10);
    const out = classifyLakesByClimate(lakes, prec);
    eq(out.lakes.length, 2, '湿润区不许丢湖');
    assert(out.lakes[0] === lakes[0] && out.lakes[1] === lakes[1], '淡水湖必须原样返回（新对象会让载荷 diff 出来）');
    assert(!('saline' in out.lakes[0]), '淡水湖不许带 saline 字段');
    eq(out.saline, 0, 'saline 计数');
    eq(out.fresh, 2, 'fresh 计数');
    return '2 条淡水湖原样';
  });

  await check('a2 干旱区：面积够 → 标 saline + 记平均降水', () => {
    const { lakes, prec } = makeLakes([{ area: 60, prec: 6 }], 10);
    const out = classifyLakesByClimate(lakes, prec);
    eq(out.lakes.length, 1, '够大就必须留下（现实里的盐湖就是这么来的）');
    eq(out.lakes[0].saline, true, '必须标成盐湖');
    eq(out.lakes[0].meanPrec, 6, '平均降水要记下来（排障要能说出为什么）');
    eq(out.saline, 1, 'saline 计数');
    assert(out.lakes[0].cells === lakes[0].cells, 'cells 不许被复制一份（湖格是几万级的下标表）');
    return `1 条盐湖（${out.lakes[0].cells.length} 格 / prec 6）`;
  });

  await check('a3 干旱区：面积不够 → 丢掉，且计数自洽（只减不增）', () => {
    const { lakes, prec } = makeLakes([{ area: 9, prec: 4 }, { area: 80, prec: 4 }], 10);
    const out = classifyLakesByClimate(lakes, prec);
    eq(out.lakes.length, 1, '小且干的必须丢');
    eq(out.dropped, 1, 'dropped 计数');
    eq(out.lakes.length + out.dropped, lakes.length, '留下的 + 丢掉的必须等于输入（不许新建湖）');
    return '1 留 1 丢';
  });

  await check('a4 不给降水 → 原样返回（反向探针：老项目必须一个字节都不变）', () => {
    const { lakes } = makeLakes([{ area: 9, prec: 4 }], 10);
    const out = classifyLakesByClimate(lakes, null);
    assert(out.lakes === lakes, '没有 prec 时必须返回**同一个数组**');
    eq(out.dropped, 0, 'dropped');
    const out2 = classifyLakesByClimate(lakes, new Float32Array(0));
    assert(out2.lakes === lakes, '空 prec 也必须原样返回');
    return 'null / 空数组都原样';
  });

  await check('a5 面积门槛随干旱程度放大（越干越要大面积）', () => {
    // 一条 14 格的湖：降水 20（接近 minPrec）时该留，降水 0（最干）时该丢
    const near = makeLakes([{ area: 14, prec: LAKE_CLIMATE.minPrec - 1 }], 10);
    const outNear = classifyLakesByClimate(near.lakes, near.prec);
    eq(outNear.lakes.length, 1, `接近 minPrec 时 14 格该算湖（minArea=${LAKE_CLIMATE.minArea || 8}）`);
    const dry = makeLakes([{ area: 14, prec: 0 }], 10);
    const outDry = classifyLakesByClimate(dry.lakes, dry.prec);
    eq(outDry.lakes.length, 0, '最干的 14 格不该算湖（门槛要放大到 minArea×factor）');
    // 反向：同样最干，但够大 → 留
    const bigDry = makeLakes([{ area: 40, prec: 0 }], 10);
    eq(classifyLakesByClimate(bigDry.lakes, bigDry.prec).lakes.length, 1, '最干但 40 格 → 盐湖');
    return '14 格：湿留 / 干丢 / 干且 40 格留';
  });

  await check('a6 平均降水按湖格算（不是看第一格）', () => {
    const lakes = [{ level: 30, cells: [0, 10, 20, 30] }];
    const prec = new Float32Array(100);
    prec[0] = 0; prec[10] = 0; prec[20] = 100; prec[30] = 100;
    eq(lakeMeanPrecipitation(lakes[0], prec), 50, '均值');
    const half = classifyLakesByClimate(lakes, prec, { minPrec: 50 });
    eq(half.lakes.length, 1, '均值刚好等于门槛 → 算淡水（>= 就算）');
    return '混合格取均值';
  });

  await check('a7 确定性：同输入两次调用结果一致', () => {
    const { lakes, prec } = makeLakes([{ area: 9, prec: 4 }, { area: 60, prec: 8 }, { area: 20, prec: 90 }], 10);
    const a = JSON.stringify(classifyLakesByClimate(lakes, prec).lakes);
    const b = JSON.stringify(classifyLakesByClimate(lakes, prec).lakes);
    eq(a, b, '两次结果必须一致（判据不许带随机）');
    return '两次一致';
  });

  await check('a8 冷区豁免：又冷又“降水低”的湖必须仍是淡水（真机教训）', () => {
    // 本项目的降水口径：温度 ≤0 → basePrecip 只有 20。只按降水判会把整片高原湖删光/判成盐湖。
    const lakes = [{ level: 40, cells: [0, 10, 20] }];
    const prec = new Float32Array(100);
    prec[0] = 10; prec[10] = 12; prec[20] = 8;          // 干
    const temp = new Float32Array(100);
    temp[0] = -12; temp[10] = -8; temp[20] = -15;        // 更冷
    const cold = classifyLakesByClimate(lakes, prec, { temp });
    eq(cold.lakes.length, 1, '高寒湖必须留下');
    assert(cold.lakes[0] === lakes[0], '高寒湖必须原样返回（不许标 saline）');
    eq(cold.coldKept, 1, 'coldKept 计数');
    assert(!('saline' in cold.lakes[0]), '高寒湖不许被标成盐湖');
    // 反向：同样干、但暖和 → 3 格的小湖必须丢（这就是 playa 该消失的情形）
    const warm = new Float32Array(100).fill(25);
    const hot = classifyLakesByClimate(lakes, prec, { temp: warm });
    eq(hot.lakes.length, 0, '又热又干的 3 格小湖必须丢');
    eq(hot.dropped, 1, 'dropped 计数');
    return '冷 → 留 / 热且干 → 丢';
  });

  await check('a9 平均温度按湖格算（lakeMeanTemperature 与湖格对齐）', () => {
    const lake = { level: 30, cells: [0, 10] };
    const temp = new Float32Array(100);
    temp[0] = -10; temp[10] = 0;
    eq(L.lakeMeanTemperature(lake, temp), -5, '均值');
    eq(L.lakeMeanTemperature(lake, null), null, '不给温度 → null');
    return '-5℃';
  });

  // ══════════════════════════════════════════════════════════════
  // B. 真实链路：生成 → 气候 → 判湖
  // ══════════════════════════════════════════════════════════════
  const t = makeTerrain();
  const hm = P.synthesizeTerrain([{ rings: [t.ring] }], {
    cellsAcross: 90, seed: 4242, isLand: t.isLand, hills: 260,
  });
  const climate = HM.buildClimateInputs(hm.h, hm.grid);
  const derived = HM.deriveLayers(hm.h, hm.grid.points,
    climate.lat ? (_p, i) => climate.lat[i] : null,
    climate.ocean ? (_p, i) => climate.ocean[i] : null);
  const baseLakes = Array.isArray(hm.lakes) ? hm.lakes : [];
  const scaled = (k) => {
    const p = new Float32Array(derived.precipitation.length);
    for (let i = 0; i < p.length; i++) p[i] = derived.precipitation[i] * k;
    return p;
  };

  await check('b1 夹具真的长出了湖（否则后面三条判据是空转）', () => {
    assert(baseLakes.length > 0, '这份地形一个湖都没有 —— 判据会空转，先换夹具');
    const cells = baseLakes.reduce((n, l) => n + l.cells.length, 0);
    const precs = baseLakes.map((l) => lakeMeanPrecipitation(l, derived.precipitation));
    return `${baseLakes.length} 条 / ${cells} 格 · 湖区平均降水 ${precs.map((v) => (v === null ? '?' : v.toFixed(0))).join('/')}`;
  });

  await check('b2 真实地形干旱化（降水 ×0.2）→ 淡水湖清零，剩下的全是盐湖（冷区除外）', () => {
    const dry = classifyLakesByClimate(baseLakes, scaled(0.2), { temp: derived.temperature });
    // 允许冷区豁免：干旱化后仍是淡水的，必须每一条都在冷区（温度 ≤ minTemp）
    for (const lake of dry.lakes) {
      if (lake.saline === true) continue;
      const t = L.lakeMeanTemperature(lake, derived.temperature);
      assert(t !== null && t <= LAKE_CLIMATE.minTemp,
        `干旱化后还留着淡水湖，但它在 ${t === null ? '?' : t.toFixed(1)}℃（不是冷区豁免）`);
    }
    const warmFresh = dry.fresh - dry.coldKept;
    eq(warmFresh, 0, `干旱化后仍有 ${warmFresh} 条“暖区淡水湖”（说明判据没生效）`);
    for (const lake of dry.lakes) {
      if (lake.saline !== true) continue;
      assert(lake.cells.length >= LAKE_CLIMATE.minArea, `盐湖只有 ${lake.cells.length} 格，连 minArea 都没过`);
    }
    return `${baseLakes.length} → ${dry.lakes.length} 条（盐湖 ${dry.saline} / 冷区豁免 ${dry.coldKept} / 丢 ${dry.dropped}）`;
  });

  await check('b2b 混合尺寸夹具：干旱化后湖数下降 ≥50%（卡上的原判据）', () => {
    // 12 条湖，面积 8…100、降水都是 60（正常温带）→ 干燥后变 12
    const specs = [8, 10, 12, 14, 16, 18, 20, 30, 45, 60, 80, 100].map((area) => ({ area, prec: 60 }));
    const { lakes, prec } = makeLakes(specs, 10);
    const base = classifyLakesByClimate(lakes, prec);
    eq(base.lakes.length, 12, '基准（降水 60）应该全是淡水湖');
    const dried = new Float32Array(prec.length);
    for (let i = 0; i < prec.length; i++) dried[i] = prec[i] * 0.2;
    const dry = classifyLakesByClimate(lakes, dried);
    const ratio = dry.lakes.length / base.lakes.length;
    assert(ratio <= 0.5, `干旱化后还剩 ${dry.lakes.length}/12（${(ratio * 100).toFixed(0)}%），要求 ≤50%`);
    // 留下的一定是“大盆”（面积越大的越该活下来）
    const keptAreas = dry.lakes.map((l) => l.cells.length).sort((a, b) => a - b);
    assert(keptAreas[0] >= 20, `留下了一条只有 ${keptAreas[0]} 格的湖（干旱区门槛应是 minArea×factor）`);
    return `12 → ${dry.lakes.length}（丢 ${dry.dropped} / 盐湖 ${dry.saline}）· 留下的最小 ${keptAreas[0]} 格`;
  });

  await check('b3 湿润化（降水 ×5）→ 不爆炸（≤2×），且全是淡水湖', () => {
    const wet = classifyLakesByClimate(baseLakes, scaled(5));
    assert(wet.lakes.length <= baseLakes.length * 2, `湿润化后 ${wet.lakes.length} 条，超过 2×（${baseLakes.length}）`);
    eq(wet.saline, 0, '湿润化后不该有盐湖');
    eq(wet.dropped, 0, '湿润化不该丢湖');
    return `${baseLakes.length} → ${wet.lakes.length} 条`;
  });

  await check('b4 陆地格守恒：湖格必须是陆地格（湖是"抬起来的盆地"，不是海）', () => {
    let bad = 0;
    for (const lake of baseLakes) for (const i of lake.cells) if (!(hm.h[i] >= 20)) bad += 1;
    eq(bad, 0, `有 ${bad} 个"湖格"其实在海平面以下`);
    return `${baseLakes.reduce((n, l) => n + l.cells.length, 0)} 格全部在陆地`;
  });

  await check('b5 同 seed 同参数两次生成 → 湖集合一致（确定性）', () => {
    const again = P.synthesizeTerrain([{ rings: [t.ring] }], {
      cellsAcross: 90, seed: 4242, isLand: t.isLand, hills: 260,
    });
    eq(JSON.stringify((again.lakes || []).map((l) => l.cells.length)),
      JSON.stringify(baseLakes.map((l) => l.cells.length)), '两次生成的湖（按面积序列）必须一致');
    return `${baseLakes.length} 条一致`;
  });

  // ══════════════════════════════════════════════════════════════
  // C. 渲染分档：咸水色真的被用上（否则“盐湖”只活在数据里）
  // ══════════════════════════════════════════════════════════════
  const R = await import(url('heightmapRaster.js'));

  await check('c1 buildSalineLakeCellSet 只收 saline === true 的湖格', () => {
    const hm = { lakes: [{ level: 30, cells: [1, 2, 3] }, { level: 30, cells: [10, 11], saline: true }] };
    const set = R.buildSalineLakeCellSet(hm);
    eq([...set].sort((a, b) => a - b).join(','), '10,11', '只收标了 saline 的那条');
    eq(R.buildSalineLakeCellSet({}).size, 0, '没有湖 → 空集合');
    eq(R.buildSalineLakeCellSet(null).size, 0, 'null 不抛');
    return '2 格（淡水湖的 3 格不算）';
  });

  await check('c2 cellColor：同一批湖格里，saline 用咸水色、其它的仍是湖水色', () => {
    const hm = { h: new Array(20).fill(40), temp: new Array(20).fill(10), prec: new Array(20).fill(60) };
    const lakes = new Map([[4, 30], [5, 30]]);
    const ctxFresh = { lakes, salineLakes: new Set() };
    const ctxSalt = { lakes, salineLakes: new Set([5]) };
    const fresh = R.cellColor('height', 4, hm, null, ctxFresh);
    const salt = R.cellColor('height', 5, hm, null, ctxSalt);
    eq(fresh.join(','), R.oceanDepthColor(0.30).join(','), '淡水湖格必须还是原来的湖水色');
    eq(salt.join(','), R.SALT_LAKE_COLOR.join(','), '盐湖格必须走咸水色');
    assert(fresh.join(',') !== salt.join(','), '两种色不能一样（否则分档等于没做）');
    // 反向探针：不在 saline 集合里的湖格，即使同一张图也保持湖水色
    eq(R.cellColor('height', 4, hm, null, ctxSalt).join(','), fresh.join(','), '淡水湖不许被连坐');
    return `湖水 rgb(${fresh.map((v) => Math.round(v)).join(',')}) / 咸水 rgb(${salt.join(',')})`;
  });

  // ── 输出 ──────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n=== 气候判湖 ${results.length - failed.length}/${results.length} 通过 ===`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ 单测自身异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
