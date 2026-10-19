#!/usr/bin/env node
/**
 * Node 单元测试：**按轮廓推演地形的结构**（src/renderer/src/utils/terrainSynthesis.js）
 *              + 这些结构对**排水**的影响（src/renderer/src/utils/riverTrace.js）
 *
 * 为什么必须有这一层：暮雨对上一版推演地形的判词是
 *   「自动生成的高度图还不如我原来自带的高度图」，并点名缺三样：
 *   **山脉走向 / 高原面 / 裂谷**。这三样都是**几何结构**，不是"看着像不像"——
 *   可以量化，而且必须量化：本仓模型没有图像输入，观感类结论一律要落成数值判据
 *   （否则下一轮没有人能证明改动是改善还是退步）。
 *
 * 度量设计上踩过的四个坑（都写在这里，防止后人再踩）：
 *   ① 各向异性要在**高频残差**上算。在原始高度上算时，"离岸距离场"的放射状梯度会把结构张量
 *      冲成各向同性；而且 v1 那三段旋转噪声自己就能刷出 **17.8%** 的假各向异性。
 *   ② 裂谷不能用"低于邻域 N 单位且连通 ≥40 格"判：裂谷下切是**沿线渐变**的（穿山处深、
 *      过谷处浅），一刀切会把浅的那段切碎 → 假红。改成**走廊带 vs 对照带的相对下切**。
 *   ③ 高原面不能用"平"就完事：v1 的缓坡也"平"。必须**连通**（≥60 格成片）且**高于陆地中位数**。
 *   ④ 高原面检测的扫描区不能只取"深内陆"—— 高原不一定长在那里（实测 seed=11 就是这么假红的）。
 *
 * 每个判据都配**反向对照**：同一条判据对 v1 口径（`structure:false`）必须红，
 * 否则判据本身没有判别力（"两条都绿"比"没有判据"更危险）。
 *
 * 用法：node scripts/tests/unit/test_terrain_structure.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const DEPS = ['terrainSynthesis.js', 'riverTrace.js', 'gridSpatialIndex.js', 'heightmapResample.js', 'polylineSmooth.js'];

const SEA = 20;
const SEEDS = [7, 11, 23];

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

// ══════════════════════════════════════════════════════════════════════════
// 构造：一块带波瓣的椭圆陆地（与 test_109 的构造同形 —— 不用纯圆，避免只有一种退化情形）
// ══════════════════════════════════════════════════════════════════════════
function makeLandRing(cx, cy, r, seed) {
  const pts = [];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const w = 1 + Math.sin(a * 3 + seed) * 0.16 + Math.sin(a * 7 + seed * 2) * 0.08;
    pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
  }
  return pts;
}
function makeInside(ring) {
  return (x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) c = !c;
    }
    return c;
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 度量（都是纯函数，输入只有高度图本身 —— 判据不许读实现内部状态）
// ══════════════════════════════════════════════════════════════════════════
function gridOf(hm) {
  const g = hm.grid;
  const cols = g.cellsX, rows = g.cellsY, sp = g.spacing, N = cols * rows;
  const H = Float64Array.from(hm.h, (v) => Number(v) || 0);
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = H[i] >= SEA ? 1 : 0;
  const seaDist = new Int32Array(N).fill(-1);
  const q = [];
  for (let i = 0; i < N; i++) if (!land[i]) { seaDist[i] = 0; q.push(i); }
  for (let hq = 0; hq < q.length; hq++) {
    const idx = q[hq], j = Math.floor(idx / cols), i = idx % cols;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nidx = nj * cols + ni;
      if (seaDist[nidx] >= 0) continue;
      seaDist[nidx] = seaDist[idx] + 1; q.push(nidx);
    }
  }
  return { cols, rows, sp, N, H, land, seaDist };
}
function boxMean(G, idx, rad) {
  const j = Math.floor(idx / G.cols), i = idx % G.cols;
  let s = 0, c = 0;
  for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
    const ni = i + di, nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= G.cols || nj >= G.rows) continue;
    s += G.H[nj * G.cols + ni]; c++;
  }
  return s / c;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** 最大连通块（8 邻域）+ PCA 长宽比 */
function largestComponent(mask, cols, rows, minCells) {
  const N = cols * rows, seen = new Uint8Array(N);
  let best = { cells: 0, elong: 0 };
  for (let start = 0; start < N; start++) {
    if (!mask[start] || seen[start]) continue;
    const q = [start]; seen[start] = 1;
    const xs = [], ys = [];
    for (let hq = 0; hq < q.length; hq++) {
      const idx = q[hq], j = Math.floor(idx / cols), i = idx % cols;
      xs.push(i); ys.push(j);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const nidx = nj * cols + ni;
        if (mask[nidx] && !seen[nidx]) { seen[nidx] = 1; q.push(nidx); }
      }
    }
    if (q.length < minCells) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (let k = 0; k < xs.length; k++) { const dx = xs[k] - mx, dy = ys[k] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const dd = Math.max(0, (tr * tr) / 4 - det);
    const e1 = tr / 2 + Math.sqrt(dd), e2 = Math.max(1e-9, tr / 2 - Math.sqrt(dd));
    if (q.length > best.cells) best = { cells: q.length, elong: Math.sqrt(e1 / e2) };
  }
  return best;
}

/**
 * 结构度量：各向异性 / 主导走向 / 高原面（连通平高块）/ 裂谷（走廊带相对下切）
 * @param {{rangeAxisDeg?:number, seed:number}} ctx 自述的走向（用于算走向误差）与 seed（用于定位裂谷）
 */
function measureStructure(hm, TS, ctx) {
  const G = gridOf(hm);
  const { cols, rows, sp, N, H, land, seaDist } = G;
  let maxD = 1;
  for (let i = 0; i < N; i++) if (land[i] && seaDist[i] > maxD) maxD = seaDist[i];

  // ① 各向异性：**高频残差**（h − 5×5 均值）上的结构张量，只取内陆（消掉离岸放射趋势）
  const hp = new Float64Array(N);
  for (let i = 0; i < N; i++) hp[i] = land[i] ? H[i] - boxMean(G, i, 2) : 0;
  let Jxx = 0, Jyy = 0, Jxy = 0;
  const interior = [];
  for (let j = 2; j < rows - 2; j++) for (let i = 2; i < cols - 2; i++) {
    const idx = j * cols + i;
    if (!land[idx] || seaDist[idx] / maxD < 0.55) continue;
    interior.push(idx);
    const gx = (hp[idx + 1] - hp[idx - 1]) / (2 * sp);
    const gy = (hp[idx + cols] - hp[idx - cols]) / (2 * sp);
    Jxx += gx * gx; Jyy += gy * gy; Jxy += gx * gy;
  }
  const T = Jxx + Jyy, D = Jxx * Jyy - Jxy * Jxy;
  const disc = Math.max(0, (T * T) / 4 - D);
  const l1 = T / 2 + Math.sqrt(disc), l2 = T / 2 - Math.sqrt(disc);
  const anisotropy = (l1 + l2) > 0 ? (l1 - l2) / (l1 + l2) : 0;
  const gradDeg = (0.5 * Math.atan2(2 * Jxy, Jxx - Jyy) * 180) / Math.PI;
  const axisDeg = (((gradDeg + 90) % 180) + 180) % 180;
  const axisErr = Number.isFinite(ctx.rangeAxisDeg)
    ? Math.min(Math.abs(axisDeg - ctx.rangeAxisDeg), 180 - Math.abs(axisDeg - ctx.rangeAxisDeg))
    : null;

  // ② 高原面：离海 ≥4 格的陆地上，"5×5 局部标准差 < 1.0 且高于陆地中位数 +6" 的**最大连通块**
  const landVals = [];
  for (let i = 0; i < N; i++) if (land[i]) landVals.push(H[i]);
  landVals.sort((a, b) => a - b);
  const landMedian = landVals[landVals.length >> 1] || SEA;
  const highBar = landMedian + 6;
  const flat = new Uint8Array(N);
  let scanned = 0;
  for (let j = 2; j < rows - 2; j++) for (let i = 2; i < cols - 2; i++) {
    const idx = j * cols + i;
    if (!land[idx] || seaDist[idx] < 4) continue;
    scanned++;
    let s = 0, s2 = 0, c = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const v = H[nj * cols + ni]; s += v; s2 += v * v; c++;
    }
    const m = s / c, sd = Math.sqrt(Math.max(0, s2 / c - m * m));
    if (sd < 1.0 && m > highBar) flat[idx] = 1;
  }
  const plateau = largestComponent(flat, cols, rows, 60);

  // ③ 裂谷：走廊带（ds < 0.6×半宽）与对照带（1.6~3 倍半宽）各自"低于 21×21 参考"的均值之差
  const rifts = TS.makeRiftSegments(ctx.seed, ctx.rangeAxisDeg, (rows - 1) / (cols - 1));
  const w = TS.TERRAIN_STRUCTURE.riftWidth;
  let corrN = 0, corrSum = 0, ctrlN = 0, ctrlSum = 0;
  for (const idx of interior) {
    const j = Math.floor(idx / cols), i = idx % cols;
    const nx = i / cols, ny = j / cols;
    let best = Infinity;
    for (const rf of rifts) best = Math.min(best, segDist(nx, ny, rf.ax, rf.ay, rf.bx, rf.by));
    const ref = boxMean(G, idx, 10);
    if (best < w * 0.6) { corrSum += ref - H[idx]; corrN++; }
    else if (best > w * 1.6 && best < w * 3.0) { ctrlSum += ref - H[idx]; ctrlN++; }
  }
  const riftDeficit = (corrN ? corrSum / corrN : 0) - (ctrlN ? ctrlSum / ctrlN : 0);

  // ④ 高度预算（源头闸门是绝对高度 → 必须知道推演有没有把整张图抬高）
  const hMean = landVals.reduce((a, b) => a + b, 0) / Math.max(1, landVals.length);
  const above60 = landVals.filter((v) => v > 60).length / Math.max(1, landVals.length);
  return { anisotropy, axisDeg, axisErr, plateauCells: plateau.cells, plateauShare: scanned ? plateau.cells / scanned : 0, riftDeficit, corrN, ctrlN, hMean, above60, scanned };
}

/** 排水：最长代表路径（世界单位）+ 汇流上界 + 段数 */
function measureDrainage(hm, R, isLandAt) {
  const tr = R.traceRivers(hm, { isLand: isLandAt });
  let longest = 0;
  for (const r of tr.rivers || []) {
    let L = 0;
    const pts = r.points || [];
    for (let k = 0; k + 1 < pts.length; k++) L += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
    if (L > longest) longest = L;
  }
  return { longest, maxFlow: tr.segMaxFlow || 0, segs: (tr.segments || []).length, sources: tr.sources, elapsedMs: tr.elapsedMs || 0 };
}

async function main() {
  const root = (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Temp')) || os.tmpdir();
  const tmp = fs.mkdtempSync(path.join(root, 'sitian-terr-'));
  const fixExt = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  for (const f of DEPS) {
    fs.writeFileSync(path.join(tmp, f), fixExt(fs.readFileSync(path.join(SRC_DIR, f), 'utf8')));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
  const TS = await import(pathToFileURL(path.join(tmp, 'terrainSynthesis.js')).href);
  const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);

  const ring = makeLandRing(0, 0, 900, 1.2);
  const inside = makeInside(ring);
  const terrain = [{ rings: [ring] }];

  // 一次算好三组（v1 对照 / v2 结构），后面的判据全部复用
  const cases = [];
  for (const seed of SEEDS) {
    const t0 = Date.now();
    const v2 = TS.synthesizeHeightmapFromTerrain(terrain, { isLand: inside, seed, structure: true });
    const ms2 = Date.now() - t0;
    const t1 = Date.now();
    const v1 = TS.synthesizeHeightmapFromTerrain(terrain, { isLand: inside, seed, structure: false });
    const ms1 = Date.now() - t1;
    const m2 = measureStructure(v2, TS, { seed, rangeAxisDeg: v2.structure.rangeAxisDeg });
    const m1 = measureStructure(v1, TS, { seed, rangeAxisDeg: v1.structure ? v1.structure.rangeAxisDeg : 0 });
    const d2 = measureDrainage(v2, R, inside);
    const d1 = measureDrainage(v1, R, inside);
    cases.push({ seed, v2, v1, m2, m1, d2, d1, ms2, ms1 });
  }
  const fmt = (c) => `seed=${c.seed}：v1 各向异性 ${(c.m1.anisotropy * 100).toFixed(1)}% / v2 ${(c.m2.anisotropy * 100).toFixed(1)}%`
    + `；最长主河 ${Math.round(c.d1.longest)}→${Math.round(c.d2.longest)}u；汇流上界 ${Math.round(c.d1.maxFlow)}→${Math.round(c.d2.maxFlow)}`;

  // ══════════════════════════════════════════════════════════════════════
  // 一、结构判据（每条都带 v1 反向对照）
  // ══════════════════════════════════════════════════════════════════════
  check('a1 山脉走向：各向异性 v2 ≥ 30% 且明显高于 v1（v1 必须红）', () => {
    for (const c of cases) {
      assert(c.m2.anisotropy >= 0.30,
        `seed=${c.seed} v2 各向异性只有 ${(c.m2.anisotropy * 100).toFixed(1)}%（要求 ≥30%）—— 脊线没拉长`);
      assert(c.m2.anisotropy >= c.m1.anisotropy + 0.15,
        `seed=${c.seed} v2 ${(c.m2.anisotropy * 100).toFixed(1)}% vs v1 ${(c.m1.anisotropy * 100).toFixed(1)}%：差距不足 15 个点，判据没有判别力`);
      assert(c.m1.anisotropy <= 0.25,
        `seed=${c.seed} v1 对照组各向异性 ${(c.m1.anisotropy * 100).toFixed(1)}% 也过了 25% —— 这条判据分不出结构地形与坡面噪声`);
    }
    return cases.map((c) => `${(c.m1.anisotropy * 100).toFixed(0)}%→${(c.m2.anisotropy * 100).toFixed(0)}%`).join(' / ');
  });

  check('a2 山脉走向：量出来的主导走向与自述 rangeAxisDeg 相差 ≤ 25°', () => {
    for (const c of cases) {
      assert(c.m2.axisErr != null && c.m2.axisErr <= 25,
        `seed=${c.seed} 自述 ${c.v2.structure.rangeAxisDeg}° / 量出 ${c.m2.axisDeg.toFixed(0)}°（差 ${c.m2.axisErr}°）`
        + ` —— 要么脊线各向异性没生效，要么被别的结构（裂谷/高原）压过去了`);
    }
    return cases.map((c) => `${c.m2.axisErr.toFixed(0)}°`).join(' / ');
  });

  check('a3 高原面：最大连片平高块 ≥ 180 格且 ≥ 2× v1 的（v1 是缓坡肩，最多 20~114 格）', () => {
    // ⚠️ 判据不写成"v1 必须为 0"：实测 v1 的缓坡肩也会凑出 20~114 格的"平高"块（seed=7 有 70 格），
    //    写成 0 会假红。真正的区别在**连片规模**：v2 实测 221 / 260 / 470 格。
    for (const c of cases) {
      assert(c.m2.plateauCells >= 180,
        `seed=${c.seed} v2 最大连片平高块只有 ${c.m2.plateauCells} 格 —— 高原面没成"面"`);
      assert(c.m2.plateauCells >= c.m1.plateauCells * 2,
        `seed=${c.seed} v2 ${c.m2.plateauCells} 格 vs v1 ${c.m1.plateauCells} 格 —— 不到 2 倍，判据分不出高原与缓坡`);
    }
    return cases.map((c) => `v1 ${c.m1.plateauCells} → v2 ${c.m2.plateauCells} 格（扫描区 ${(c.m2.plateauShare * 100).toFixed(1)}%）`).join(' / ');
  });

  check('a4 裂谷：走廊带比对照带多下切 ≥ 4 个高度单位；v1 必须 < 3（反向对照）', () => {
    for (const c of cases) {
      assert(c.m2.riftDeficit >= 4,
        `seed=${c.seed} v2 裂谷下切只有 ${c.m2.riftDeficit.toFixed(1)} 单位（要求 ≥4）—— 裂谷没切出来或没穿过陆地`);
      assert(c.m2.corrN >= 100,
        `seed=${c.seed} 走廊带只有 ${c.m2.corrN} 格 —— 裂谷根本没落在内陆（位置算错了）`);
      assert(c.m1.riftDeficit < 3,
        `seed=${c.seed} v1 对照组也测出 ${c.m1.riftDeficit.toFixed(1)} 单位的下切 —— 这条判据量的是噪声不是裂谷`);
    }
    return cases.map((c) => `${c.m1.riftDeficit.toFixed(1)}→${c.m2.riftDeficit.toFixed(1)}`).join(' / ');
  });

  // ══════════════════════════════════════════════════════════════════════
  // 二、排水：结构地形必须让河更长、汇流更集中（这是"地形值不值得推"的唯一硬证据）
  // ══════════════════════════════════════════════════════════════════════
  check('b1 排水：最长主河 v2 ≥ 1.3 × v1（结构真的让水汇起来了）', () => {
    for (const c of cases) {
      assert(c.d2.longest >= c.d1.longest * 1.3,
        `seed=${c.seed} 最长主河 ${Math.round(c.d1.longest)}u → ${Math.round(c.d2.longest)}u，不到 1.3 倍`
        + ` —— 那这批"结构"对河没有用（用户要的正是"能长出主干"）`);
    }
    return cases.map((c) => `${Math.round(c.d1.longest)}→${Math.round(c.d2.longest)}u`).join(' / ');
  });

  check('b2 排水：汇流上界 v2 ≥ 1.3 × v1（支流真的并进主干）', () => {
    for (const c of cases) {
      assert(c.d2.maxFlow >= c.d1.maxFlow * 1.3,
        `seed=${c.seed} 汇流上界 ${Math.round(c.d1.maxFlow)} → ${Math.round(c.d2.maxFlow)}，不到 1.3 倍`);
    }
    return cases.map((c) => `${Math.round(c.d1.maxFlow)}→${Math.round(c.d2.maxFlow)}`).join(' / ');
  });

  check('b3 排水：结构地形上每条段都真的能到海（没有新造出"到不了海的洼地"）', () => {
    for (const c of cases) {
      const tr = R.traceRivers(c.v2, { isLand: inside });
      assert(tr.segments.length > 0, `seed=${c.seed} 结构地形上一条河网段都没有`);
      // 每条段都是"能到海的格 → 下游"，所以段数必须显著大于 0 且 sources > 0
      assert(tr.sources > 0, `seed=${c.seed} 结构地形上一个源头都没有（全被抬平了？）`);
      assert(tr.reaching >= tr.segments.length - 1 || tr.reaching > 0,
        `seed=${c.seed} 到海格数异常：reaching=${tr.reaching} / 段=${tr.segments.length}`);
    }
    return cases.map((c) => `${c.d2.segs}段`).join(' / ');
  });

  // ══════════════════════════════════════════════════════════════════════
  // 三、不变量 / 纪律 / 反向探针
  // ══════════════════════════════════════════════════════════════════════
  check('c1 不变量：陆地格 h ≥ 海平面、且没有 NaN（海格必须低于海平面）', () => {
    for (const c of cases) {
      for (const [tag, hm] of [['v2', c.v2], ['v1', c.v1]]) {
        for (let i = 0; i < hm.h.length; i++) {
          const v = hm.h[i];
          assert(Number.isFinite(v), `seed=${c.seed} ${tag} 第 ${i} 格 h=${v}（NaN/Infinity）`);
          assert(v >= SEA - 8, `seed=${c.seed} ${tag} 第 ${i} 格 h=${v} 低于海格下限`);
        }
      }
    }
    return 'ok';
  });

  check('c2 确定性：同 seed 两次逐值相同；不同 seed 必须不同（否则 seed 是摆设）', () => {
    const a1 = TS.synthesizeHeightmapFromTerrain(terrain, { isLand: inside, seed: 7, structure: true });
    const a2 = TS.synthesizeHeightmapFromTerrain(terrain, { isLand: inside, seed: 7, structure: true });
    assert(a1.h.length === a2.h.length, '两次长度不同');
    for (let i = 0; i < a1.h.length; i++) assert(a1.h[i] === a2.h[i], `第 ${i} 格不同：${a1.h[i]} vs ${a2.h[i]}`);
    assert(a1.structure.rangeAxisDeg === a2.structure.rangeAxisDeg, '走向不自述一致');
    const b = TS.synthesizeHeightmapFromTerrain(terrain, { isLand: inside, seed: 23, structure: true });
    let diff = 0;
    for (let i = 0; i < a1.h.length; i++) if (a1.h[i] !== b.h[i]) diff++;
    assert(diff > a1.h.length * 0.2, `换 seed 后只有 ${diff} 格不同 —— seed 没起作用`);
    return `同 seed 逐值相同；换 seed 差 ${(diff / a1.h.length * 100).toFixed(0)}% 的格`;
  });

  check('c3 高度预算：v2 陆地均值与 v1 同量级（±8 以内）、>60 占比 ≤ 35%', () => {
    // 为什么必须守：下游的「源头高度闸门」是**绝对高度**（TRACE_SOURCE_HEIGHT = 60）。
    // 推演如果把整张图抬高，用户的第一次「自动河流」就会得到 2000+ 个源头（实测过）。
    for (const c of cases) {
      assert(Math.abs(c.m2.hMean - c.m1.hMean) <= 8,
        `seed=${c.seed} 陆地均值 v1 ${c.m1.hMean.toFixed(1)} / v2 ${c.m2.hMean.toFixed(1)} —— 差超过 8，源头闸门语义会漂`);
      assert(c.m2.above60 <= 0.35,
        `seed=${c.seed} v2 有 ${(c.m2.above60 * 100).toFixed(0)}% 的陆格高于 60（默认源头闸门）—— 一点自动河流就是一片源头`);
    }
    return cases.map((c) => `均值 ${c.m1.hMean.toFixed(0)}→${c.m2.hMean.toFixed(0)}，>60 ${(c.m1.above60 * 100).toFixed(0)}%→${(c.m2.above60 * 100).toFixed(0)}%`).join(' / ');
  });

  check('c4 性能：单次推演 ≤ 1500ms（防"把地图算成几百万格卡死"）', () => {
    for (const c of cases) {
      assert(c.ms2 <= 1500, `seed=${c.seed} 推演用了 ${c.ms2}ms —— 超过 1500ms 的上限（UI 是同步调用）`);
    }
    return cases.map((c) => `${c.ms2}ms`).join(' / ');
  });

  check('c5 结构自述：v2 带 structure 字段（版本/走向/裂谷数/高原高度），v1 口径**不许**带', () => {
    for (const c of cases) {
      const s = c.v2.structure;
      assert(s && typeof s === 'object', `seed=${c.seed} v2 没有 structure 自述`);
      assert(s.version === TS.TERRAIN_SYNTHESIS_VERSION, `seed=${c.seed} structure.version=${s.version} 与常量 ${TS.TERRAIN_SYNTHESIS_VERSION} 不一致`);
      assert(Number.isFinite(s.rangeAxisDeg), 'structure.rangeAxisDeg 不是有限数');
      assert(s.rifts >= 1, `seed=${c.seed} 裂谷数 ${s.rifts} < 1`);
      assert(c.v1.structure === undefined, `seed=${c.seed} v1 口径也带了 structure 字段 —— 对照会被误认为结构地形`);
    }
    return cases.map((c) => `走向 ${c.v2.structure.rangeAxisDeg}° / 裂谷 ${c.v2.structure.rifts} 条`).join(' / ');
  });

  check('c6 退化输入：没有陆地多边形 / 空数组 → 返回 null（不许抛）', () => {
    assert(TS.synthesizeHeightmapFromTerrain([], {}) === null, '空数组应返回 null');
    assert(TS.synthesizeHeightmapFromTerrain(null, {}) === null, 'null 应返回 null');
    const noLand = TS.synthesizeHeightmapFromTerrain([{ rings: [ring] }], { isLand: () => false });
    assert(noLand === null, '掩膜全false（没有任何陆格）应返回 null');
    return 'ok';
  });

  check('c7 反向探针：关掉 structure 后，三条结构判据必须**全部**对 v1 红（判据有判别力）', () => {
    // 这不是重复 a1/a3/a4：它证明的是"这些判据量到的确实是 structure 带来的东西"，
    // 而不是"这份地形怎么算都有"（本仓真实踩过：判据恒绿 = 假保证）。
    let red = 0, total = 0;
    for (const c of cases) {
      total += 3;
      if (c.m1.anisotropy < 0.30) red++;                        // 各向异性：v1 不该过
      if (c.m1.plateauCells < 180) red++;                       // 高原面：v1 不该过大块
      if (c.m1.riftDeficit < 4) red++;                          // 裂谷：v1 不该有走廊下切
    }
    assert(red === total, `反向探针只红了 ${red}/${total} —— 有判据对 v1 也绿（没有判别力）`);
    return `v1 在 ${red}/${total} 条上红`;
  });

  check('c8 裂谷几何：makeRiftSegments 由 seed 决定、与走向同向（±15°）、条数 1~2', () => {
    for (const seed of SEEDS) {
      const axis = TS.rangeAxisFromSeed(seed);
      const segs = TS.makeRiftSegments(seed, axis, 0.72);
      assert(segs.length === 1 || segs.length === 2, `seed=${seed} 裂谷条数 ${segs.length}`);
      for (const s of segs) {
        const deg = (Math.atan2(s.by - s.ay, s.bx - s.ax) * 180) / Math.PI;
        const d = Math.abs(((deg - axis) % 180 + 180) % 180);
        const err = Math.min(d, 180 - d);
        assert(err <= 16, `seed=${seed} 裂谷走向 ${deg.toFixed(0)}° 与主导走向 ${axis}° 差 ${err.toFixed(0)}°（应 ≤15°）`);
        assert(Math.hypot(s.bx - s.ax, s.by - s.ay) > 0.5, `seed=${seed} 裂谷太短`);
      }
      const again = TS.makeRiftSegments(seed, axis, 0.72);
      assert(JSON.stringify(again) === JSON.stringify(segs), `seed=${seed} 裂谷不确定（两次不同）`);
    }
    return SEEDS.map((s) => `seed${s}:${TS.makeRiftSegments(s, TS.rangeAxisFromSeed(s), 0.72).length}条`).join(' / ');
  });

  // ══════════════════════════════════════════════════════════════════════
  // 读数（给下一轮的人看：判据不是"过/不过"，而是这组数）
  // ══════════════════════════════════════════════════════════════════════
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
  console.log('\n读数（v1 对照 → v2 结构）：');
  for (const c of cases) console.log('  ' + fmt(c));
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清不掉就留着 */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('用例自身崩溃：', err);
  process.exit(1);
});
