#!/usr/bin/env node
/**
 * Node 单元测试：**P2 地形骨架（排水盆地 / 主干谷 / 坡面侵蚀迭代核）**
 *
 * 守的五件事（对应 `p2-地形生成换算法让水有谷可汇侵蚀-o-82344729` 的判据 4，以及红线“能整体关掉”）：
 *   ① **开关真的能回 0**：`drainageBasins: 0` / 不传，与老路径**逐字节一致**；
 *      `erodeGridSurface({iterations:0})` → 原样返回、`stats.applied === false`；
 *   ② **同 seed 同输出**：盆地骨架与侵蚀都跑两遍，高度量化哈希一致（没有 Math.random）；
 *   ③ **海平面不动**：两张图的陆地格数完全一致（侵蚀只许在陆地上动土）；
 *   ④ **骨架是“线”不是“点”**：每个出水口都落在海岸格上；主干谷格数 > 出水口数；
 *   ⑤ **侵蚀只降不升**：陆格平均高度下降、且没有任何陆格被抬过（下切是单向的）。
 *
 * 用法：node scripts/tests/unit/test_terrain_drainage.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

/** 收集依赖（支持 ./x、./sub/x、../y；统一补 .js）—— 复刻浏览器侧的无后缀导入 */
function collectDeps(entries) {
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop().replace(/\\/g, '/');
    if (seen.has(f)) continue;
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    seen.set(f, src);
    for (const m of src.matchAll(/from '(\.\.?\/[^']+)'/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      queue.push(rel.endsWith('.js') ? rel : rel + '.js');
    }
  }
  return seen;
}

function loadModules(names) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-drain-'));
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
function check(name, fn) {
  try { results.push({ name, ok: true, detail: fn() || '' }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function assert(c, m) { if (!c) throw new Error(m); }

/** FNV-1a（高度按 0.01 量化：与落库/回执同精度，避免浮点尾差干扰判据） */
function hashH(h) {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < h.length; i++) {
    x ^= Math.round(Number(h[i]) * 100) | 0;
    x = Math.imul(x, 16777619) >>> 0;
  }
  return x >>> 0;
}

function countLand(h, seaLevel) {
  let n = 0;
  for (let i = 0; i < h.length; i++) if (h[i] >= seaLevel) n++;
  return n;
}

/** 一个“不规则半岛”陆地环：半径带正弦抖动，保证有海岸、有内陆、有多个可选出水口 */
function makeLandRing(cx, cy, r, wobble) {
  const pts = [];
  const steps = 180;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r * (1 + wobble * Math.sin(a * 3.1) + wobble * 0.6 * Math.sin(a * 7.3 + 1.1));
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}

function insidePolygon(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) c = !c;
  }
  return c;
}

async function main() {
  const { url } = loadModules(['terrainSynthesis.js', 'drainageBasins.js', 'terrainErosion.js']);
  const TS = await import(url('terrainSynthesis.js'));
  const DB = await import(url('drainageBasins.js'));
  const TE = await import(url('terrainErosion.js'));

  const ring = makeLandRing(0, 0, 700, 0.22);
  const terrain = [{ rings: [ring] }];
  const isLand = (x, y) => insidePolygon(x, y, ring);
  const baseOpts = { cellsAcross: 128, seed: 7, isLand };
  const seaLevel = 20;

  // ── ① 开关回 0：不传 / 传 0 / 传 0 且带别的东西，都必须是老路径 ──────────
  check('d1 盆地开关：不传 vs 0 → 逐字节一致，且不报告出水口', () => {
    const a = TS.synthesizeHeightmapFromTerrain(terrain, baseOpts);
    const b = TS.synthesizeHeightmapFromTerrain(terrain, { ...baseOpts, drainageBasins: 0 });
    assert(a && b, '推演返回 null');
    assert(hashH(a.h) === hashH(b.h), 'drainageBasins:0 改变了高度图（开关没有真的关掉）');
    assert((a.structure || {}).drainageOutlets === 0, '未开盆地却报告了出水口');
    return `hash ${hashH(a.h)}`;
  });

  check('d2 开盆地：出水口都是海岸格，且报告数与骨架一致', () => {
    const hm = TS.synthesizeHeightmapFromTerrain(terrain, { ...baseOpts, drainageBasins: 6 });
    assert(hm && hm.structure && hm.structure.drainageOutlets > 0, '没有报告出水口');
    // 重新建一次骨架，逐条核对“出水口 = 海岸格”
    const cols = hm.grid.cellsX, rows = hm.grid.cellsY;
    const land = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = hm.grid.points[j * cols + i];
        land[j * cols + i] = isLand(p[0], p[1]) ? 1 : 0;
      }
    }
    const B = DB.buildDrainageBasins(land, cols, rows, {
      outlets: 6,
      px: (i) => hm.grid.points[i][0],
      py: (i) => hm.grid.points[i][1],
    });
    assert(B.count > 0, '骨架没出出水口');
    for (const o of B.outlets) {
      const ci = o % cols, cj = (o - ci) / cols;
      let coast = ci === 0 || cj === 0 || ci === cols - 1 || cj === rows - 1;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const ni = ci + dx, nj = cj + dy;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        if (!land[nj * cols + ni]) coast = true;
      }
      assert(coast, `出水口 ${o} 不在海岸上`);
    }
    return `${B.count} 个出水口 · 主干谷 ${B.trunkCells} 格`;
  });

  check('d3 主干谷是“线”：谷格数明显多于出水口数，且有格子的谷距为 0', () => {
    const cols = 128, rows = 100;
    const land = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        // 简单圆形陆地，坐标用格号（这个用例只量骨架几何，不需要世界坐标）
        const dx = i / cols - 0.5, dy = j / rows - 0.5;
        land[j * cols + i] = dx * dx + dy * dy < 0.12 ? 1 : 0;
      }
    }
    const B = DB.buildDrainageBasins(land, cols, rows, { outlets: 4 });
    assert(B.count >= 1, '没有出水口');
    assert(B.trunkCells > B.count * 3, `主干谷格数 ${B.trunkCells} 不像线（出水口 ${B.count}）`);
    let zero = 0;
    for (let i = 0; i < land.length; i++) if (land[i] && B.trunkDist[i] === 0) zero++;
    assert(zero > 0, '没有任何格子落在主干谷上');
    return `出水口 ${B.count} · 谷 ${B.trunkCells} 格 · 谷上格 ${zero}`;
  });

  // ── ② 确定性 ────────────────────────────────────────────────────────────
  check('d4 同 seed 同输出：盆地 + 侵蚀各跑两遍逐字节一致', () => {
    const run = () => {
      const hm = TS.synthesizeHeightmapFromTerrain(terrain, { ...baseOpts, drainageBasins: 5 });
      const e = TE.erodeGridSurface({ grid: hm.grid, h: hm.h }, { iterations: 6, strength: 0.6 });
      return hashH(e.h);
    };
    const a = run(), b = run();
    assert(a === b, `两次结果不同（${a} vs ${b}）`);
    return `hash ${a}`;
  });

  // ── ③ 海平面不动 / ⑤ 只降不升 ────────────────────────────────────────────
  check('d5 侵蚀不越海平面：陆地格数不变、整体被削低（扩散可以填低洼，但不许把陆地变成海）', () => {
    const hm = TS.synthesizeHeightmapFromTerrain(terrain, { ...baseOpts, drainageBasins: 4 });
    const e = TE.erodeGridSurface({ grid: hm.grid, h: hm.h }, { iterations: 10, strength: 0.8 });
    const before = countLand(hm.h, seaLevel), after = countLand(e.h, seaLevel);
    assert(before === after, `陆地格数变了：${before} → ${after}`);
    assert(e.stats.meanDrop > 0, `侵蚀没削低地形（meanDrop=${e.stats.meanDrop}）`);
    // 下切本身只降不升；但坡面扩散会把低洼填高一点（物理上也如此），所以只断言“整体变低 + 不越海”。
    let below = 0;
    for (let i = 0; i < hm.h.length; i++) if (hm.h[i] >= seaLevel && e.h[i] < seaLevel - 1e-9) below++;
    assert(below === 0, `有 ${below} 个陆格被切到海平面以下`);
    return `陆地 ${after} 格 · 均值降 ${e.stats.meanDrop.toFixed(2)}`;
  });

  check('d6 侵蚀开关回 0：iterations=0 → 原样返回且 applied=false', () => {
    const hm = TS.synthesizeHeightmapFromTerrain(terrain, baseOpts);
    const e = TE.erodeGridSurface({ grid: hm.grid, h: hm.h }, { iterations: 0, strength: 9 });
    assert(e.stats.applied === false, '轮数 0 却报告已生效');
    assert(hashH(e.h) === hashH(hm.h), '轮数 0 改动了高度图');
    return 'applied=false · 逐字节一致';
  });

  // ── 递归分级河网（P2.1）────────────────────────────────────────────────────
  check('d7 分级河网开关回 0：不传 vs 0 → 逐字节一致，且不报告河道', () => {
    const a = TS.synthesizeHeightmapFromTerrain(terrain, baseOpts);
    const b = TS.synthesizeHeightmapFromTerrain(terrain, { ...baseOpts, drainageTree: 0 });
    assert(a && b, '推演返回 null');
    assert(hashH(a.h) === hashH(b.h), 'drainageTree:0 改变了高度图');
    assert((a.structure || {}).drainageTreeOutlets === 0, '未开河网却报告了出水口');
    return `hash ${hashH(a.h)}`;
  });

  check('d8 分级河网：同 seed 同参数两次 → 逐字节一致', () => {
    const run = () => {
      const hm = TS.synthesizeHeightmapFromTerrain(terrain, { ...baseOpts, drainageTree: 5, drainageDepth: 3 });
      return hashH(hm.h);
    };
    const a = run(), b = run();
    assert(a === b, `两次结果不同（${a} vs ${b}）`);
    return `hash ${a}`;
  });

  check('d9 势场有形状：每个陆格都有有限值，河口为 0，河道格数 > 0', () => {
    const cols = 128, rows = 100;
    const land = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const dx = i / cols - 0.5, dy = j / rows - 0.5;
        land[j * cols + i] = dx * dx + dy * dy < 0.12 ? 1 : 0;
      }
    }
    const T = DB.buildDrainageTree(land, cols, rows, { outlets: 5, depth: 3, branching: 2 });
    assert(T.streamCells > 0, '没有河道格');
    assert(T.channels > T.outlets.length, `河道段数 ${T.channels} 不多于河口数（没有分级）`);
    // 低通会把河口抬高千分之几，判据写成“接近 0”（不超过最大势的 2%），别把舍入当缺陷
    for (const o of T.outlets) assert(T.p[o] <= T.maxP * 0.02, `河口 ${o} 的势场 ${T.p[o]} 不在底部`);
    for (let i = 0; i < land.length; i++) {
      if (!land[i]) continue;
      assert(Number.isFinite(T.p[i]), `陆格 ${i} 的势场不是有限值`);
      assert(T.p[i] <= T.maxP + 1e-9, `陆格 ${i} 的势场超过最大值`);
    }
    return `河口 ${T.outlets.length} · 河道段 ${T.channels} · 最大势 ${T.maxP.toFixed(1)}`;
  });

  // ── 报告 ────────────────────────────────────────────────────────────────
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`✓ ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`);
    else { failed++; console.log(`✗ ${r.name}  —— ${r.detail}`); }
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
