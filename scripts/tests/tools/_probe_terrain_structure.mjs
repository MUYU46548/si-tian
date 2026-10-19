// 探针：v1（坡面+噪声）vs v2（山脉走向/高原面/裂谷）—— 结构度量 + 河网度量（2026-10-18 第九修）
//
// 为什么要这份探针：本仓模型没有图像输入，"地形更像真地形"只能落成**数值判据**。
// 度量设计上踩过的两个坑（都留在这里当记录，正式用例照修好的口径写）：
//   ① 各向异性在**原始高度**上算 → "离岸距离场"的放射状梯度把结构张量冲成各向同性，
//      且 v1 自己那三段旋转噪声也能刷出 23~32% 的假各向异性。改在**高频残差**（h − 5×5 均值）上算。
//   ② 裂谷长宽比不设"最少格数"→ 两格的连通块能算出 22360 的长宽比（假绿）。
// 用法：node scripts/tests/tools/_probe_terrain_structure.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ts-'));
for (const f of ['terrainSynthesis.js', 'riverTrace.js', 'riverChains.js', 'coastline.js',
  'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js', 'polylineSmooth.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const TS = await import(pathToFileURL(path.join(tmp, 'terrainSynthesis.js')).href);
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);

const SEA = 20;
function makeLand(cx, cy, r, seed) {
  const pts = [];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const w = 1 + Math.sin(a * 3 + seed) * 0.16 + Math.sin(a * 7 + seed * 2) * 0.08;
    pts.push({ x: cx + Math.cos(a) * r * w, y: cy + Math.sin(a) * r * w * 0.72 });
  }
  return pts;
}
const ring = makeLand(0, 0, 900, 1.2);
const inside = (x, y) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) c = !c;
  }
  return c;
};

/** 盒均值（半径可给）：hp 用 2（5×5），裂谷参考必须用更大的半径 ——
 *  裂谷本身有 ~10 格宽，用 5×5 做参考的话均值还在裂谷里 → 检测不到（实测 0 格）。 */
function boxMean(H, cols, rows, idx, rad) {
  const j = Math.floor(idx / cols), i = idx % cols;
  let s = 0, c = 0;
  for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
    const ni = i + di, nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
    s += H[nj * cols + ni]; c++;
  }
  return s / c;
}
const boxMean5 = (H, cols, rows, idx) => boxMean(H, cols, rows, idx, 2);

/** 点到线段距离（归一化坐标） */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function analyze(hm, label, axisDeclared, seed) {
  const g = hm.grid, cols = g.cellsX, rows = g.cellsY, sp = g.spacing, N = cols * rows;
  const H = Float64Array.from(hm.h, (v) => Number(v) || 0);
  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = H[i] >= SEA ? 1 : 0;
  const span = 100 - SEA;

  // 离海距离（BFS 格步）
  const seaDist = new Int32Array(N).fill(-1);
  {
    const qq = [];
    for (let i = 0; i < N; i++) if (!land[i]) { seaDist[i] = 0; qq.push(i); }
    for (let hq = 0; hq < qq.length; hq++) {
      const idx = qq[hq], j = Math.floor(idx / cols), i = idx % cols;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const nidx = nj * cols + ni;
        if (seaDist[nidx] >= 0) continue;
        seaDist[nidx] = seaDist[idx] + 1; qq.push(nidx);
      }
    }
  }
  let maxD = 1;
  for (let i = 0; i < N; i++) if (land[i] && seaDist[i] > maxD) maxD = seaDist[i];

  // ── ① 各向异性：**高频残差**上算（去掉离岸坡面这个大趋势），只取内陆
  const hp = new Float64Array(N);
  for (let i = 0; i < N; i++) hp[i] = land[i] ? H[i] - boxMean5(H, cols, rows, i) : 0;
  let Jxx = 0, Jyy = 0, Jxy = 0, used = 0, interiorN = 0;
  const interior = [];
  for (let j = 2; j < rows - 2; j++) for (let i = 2; i < cols - 2; i++) {
    const idx = j * cols + i;
    if (!land[idx]) continue;
    if (seaDist[idx] / maxD < 0.55) continue;
    interior.push(idx); interiorN++;
    const gx = (hp[idx + 1] - hp[idx - 1]) / (2 * sp);
    const gy = (hp[idx + cols] - hp[idx - cols]) / (2 * sp);
    Jxx += gx * gx; Jyy += gy * gy; Jxy += gx * gy; used++;
  }
  const T = Jxx + Jyy, D = Jxx * Jyy - Jxy * Jxy;
  const disc = Math.max(0, (T * T) / 4 - D);
  const l1 = T / 2 + Math.sqrt(disc), l2 = T / 2 - Math.sqrt(disc);
  const aniso = (l1 + l2) > 0 ? (l1 - l2) / (l1 + l2) : 0;
  const gradDeg = (0.5 * Math.atan2(2 * Jxy, Jxx - Jyy) * 180) / Math.PI;
  const axisDeg = (((gradDeg + 90) % 180) + 180) % 180;
  const axisErr = axisDeclared == null ? null
    : Math.min(Math.abs(axisDeg - axisDeclared), 180 - Math.abs(axisDeg - axisDeclared));

  // ── ② 高原面：5×5 局部标准差 < 0.8 且**明显高于陆地中位数**（相对判据：高原的定义是
  //     "连片的高平地"，不是"高于某个绝对高度" —— 绝对阈值会随高度预算漂移）
  const landVals = [];
  for (let i = 0; i < N; i++) if (land[i]) landVals.push(H[i]);
  landVals.sort((a, b) => a - b);
  const landMedian = landVals[landVals.length >> 1] || SEA;
  const highBar = landMedian + 6;
  const flat = new Uint8Array(N);
  const flatScan = [];
  for (let j = 2; j < rows - 2; j++) for (let i = 2; i < cols - 2; i++) {
    const idx = j * cols + i;
    if (!land[idx] || seaDist[idx] < 4) continue;   // 只在"离海 ≥4 格"的陆地上找（避开海岸带）
    flatScan.push(idx);
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
  const plateauShare = flatScan.length ? plateau.cells / flatScan.length : 0;
  // 诊断：平集到底为什么碎片化（阈值/高度/边沿）
  let flatAny = 0, flatHigh = 0;
  const sdHist = [];
  for (const idx of flatScan) {
    const j = Math.floor(idx / cols), i = idx % cols;
    let s = 0, s2 = 0, c = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const v = H[nj * cols + ni]; s += v; s2 += v * v; c++;
    }
    const m = s / c, sd = Math.sqrt(Math.max(0, s2 / c - m * m));
    sdHist.push(sd);
    if (sd < 1.0) { flatAny++; if (m > highBar) flatHigh++; }
  }
  sdHist.sort((a, b) => a - b);
  const sdq = (p) => sdHist[Math.min(sdHist.length - 1, Math.round((sdHist.length - 1) * p))] || 0;
  console.log(`      [诊断] 内陆 ${interiorN} 格：std<0.8 共 ${flatAny}，其中高于中位+6 的 ${flatHigh}；`
    + ` 5×5 std 分位 p10=${sdq(0.1).toFixed(2)} p50=${sdq(0.5).toFixed(2)} p90=${sdq(0.9).toFixed(2)}；`
    + ` 陆地中位 ${landMedian.toFixed(1)} 高度门槛 ${highBar.toFixed(1)}`);

  // ── ③ 裂谷：**因果判据** —— 走廊带（ds < 半宽）相对 21×21 参考的下切，
  //     必须显著大于对照带（1~3 倍半宽处）。为什么不用"低于参考 8 单位且连通 ≥40 格"：
  //     裂谷下切是**沿线渐变**的（穿山处深、过谷处浅），一刀切阈值会把浅的那段切碎 → 假红。
  let corrN = 0, corrSum = 0, ctrlN = 0, ctrlSum = 0;
  {
    const rifts = TS.makeRiftSegments(seed ?? 7, axisDeclared ?? 0, (rows - 1) / (cols - 1));
    const w = 0.055;
    for (const idx of interior) {
      const j = Math.floor(idx / cols), i = idx % cols;
      const nx = i / cols, ny = j / cols;
      let best = Infinity;
      for (const rf of rifts) best = Math.min(best, segDist(nx, ny, rf.ax, rf.ay, rf.bx, rf.by));
      const ref = boxMean(H, cols, rows, idx, 10);
      if (best < w * 0.6) { corrSum += ref - H[idx]; corrN++; }
      else if (best > w * 1.6 && best < w * 3.0) { ctrlSum += ref - H[idx]; ctrlN++; }
    }
  }
  const corrDef = corrN ? corrSum / corrN : 0;
  const ctrlDef = ctrlN ? ctrlSum / ctrlN : 0;
  const riftDeficit = corrDef - ctrlDef;

  // ── 高度分布（源头闸门是"高度"阈值 → 必须知道 v2 有没有把整张图抬高）
  const landH = [];
  for (let i = 0; i < N; i++) if (land[i]) landH.push(H[i]);
  landH.sort((a, b) => a - b);
  const qh = (p) => landH[Math.min(landH.length - 1, Math.round((landH.length - 1) * p))];
  const hMean = landH.reduce((a, b) => a + b, 0) / Math.max(1, landH.length);
  const hAbove60 = landH.filter((v) => v > 60).length / Math.max(1, landH.length);

  // ── ④ 排水
  const tr = R.traceRivers(hm, { isLand: inside });
  const segs = tr.segments || [];
  const qk = (v) => Math.round(v * 100);
  const indeg = new Map();
  for (const s of segs) { const k = `${qk(s.x1)},${qk(s.y1)}`; indeg.set(k, (indeg.get(k) || 0) + 1); }
  const segByStart = new Map();
  for (const s of segs) segByStart.set(`${qk(s.x0)},${qk(s.y0)}`, s);
  const links = [];
  for (const s of segs) {
    let cur = s, len = 0, guard = 0;
    while (cur && guard++ < 5000) {
      len += Math.hypot(cur.x1 - cur.x0, cur.y1 - cur.y0);
      const k = `${qk(cur.x1)},${qk(cur.y1)}`;
      if ((indeg.get(k) || 0) >= 2 || cur.endInSea) break;
      cur = segByStart.get(k);
    }
    links.push(len);
  }
  links.sort((a, b) => a - b);
  const ql = (p) => (links.length ? links[Math.min(links.length - 1, Math.round((links.length - 1) * p))] : 0);
  // 最长代表路径（世界单位）
  let longest = 0;
  for (const r of tr.rivers || []) {
    let L = 0;
    const pts = r.points || [];
    for (let k = 0; k + 1 < pts.length; k++) L += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
    if (L > longest) longest = L;
  }
  console.log(`${label.padEnd(14)} 各向异性 ${(aniso * 100).toFixed(1).padStart(5)}% 走向 ${axisDeg.toFixed(0).padStart(3)}°`
    + (axisErr == null ? '' : `(差 ${axisErr.toFixed(0).padStart(3)}°)`)
    + ` 高原面 ${(plateauShare * 100).toFixed(1).padStart(4)}%(${plateau.cells}格)`
    + ` 裂谷下切 ${riftDeficit.toFixed(1).padStart(5)}单位(走廊${corrN}格/对照${ctrlN}格)`
    + ` | 链节 p50 ${String(Math.round(ql(0.5))).padStart(4)}u p90 ${String(Math.round(ql(0.9))).padStart(4)}u`
    + ` 最长主河 ${String(Math.round(longest)).padStart(5)}u 汇流上界 ${String(Math.round(tr.segMaxFlow || 0)).padStart(5)}`
    + ` 源头 ${String(tr.sources).padStart(4)}`
    + ` | 高度 均值 ${hMean.toFixed(1)} >60 占 ${(hAbove60 * 100).toFixed(0).padStart(3)}% p90 ${qh(0.9).toFixed(0)}`
    + ` ${Math.round(tr.elapsedMs || 0)}ms`);
  return { aniso, axisDeg, axisErr, plateauShare, plateauCells: plateau.cells, riftDeficit, corrN, ctrlN, p50: ql(0.5), p90: ql(0.9), longest, maxFlow: tr.segMaxFlow, sources: tr.sources, hMean, hAbove60 };
}

/** 最大连通块 + PCA 长宽比（不足 minCells 视为不存在） */
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
    const tr2 = sxx + syy, det = sxx * syy - sxy * sxy;
    const dd = Math.max(0, (tr2 * tr2) / 4 - det);
    const e1 = tr2 / 2 + Math.sqrt(dd), e2 = Math.max(1e-9, tr2 / 2 - Math.sqrt(dd));
    const elong = Math.sqrt(e1 / e2);
    if (q.length > best.cells) best = { cells: q.length, elong };
  }
  return best;
}

for (const seed of [7, 11, 23]) {
  console.log(`-- seed=${seed} --`);
  const a = TS.synthesizeHeightmapFromTerrain([{ rings: [ring] }], { isLand: inside, seed, structure: false });
  const b = TS.synthesizeHeightmapFromTerrain([{ rings: [ring] }], { isLand: inside, seed, structure: true });
  console.log(`   （v2 自述：走向 ${b.structure.rangeAxisDeg}° / 裂谷 ${b.structure.rifts} 条 / 高原格 ${b.structure.plateauCells}）`);
  analyze(a, 'v1 坡面+噪声', null, seed);
  analyze(b, 'v2 结构地形', b.structure.rangeAxisDeg, seed);
}
console.log('\n判读：v2 各向异性应明显高于 v1、走向误差 ≤ 35°、高原面/裂谷连通块够大；');
console.log('      排水侧：最长主河与汇流上界不许比 v1 差。');
