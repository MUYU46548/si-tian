// 🔴 关键对照：`traceRivers` 的汇流累积（segMaxFlow=22）是不是**漏量**了？
//
// 疑点：真实底图有 2950 个陆地格，但 `segMaxFlow` 只有 **22**；
//       而我自己的理想圆锥岛（2025 个陆格）能到 **171**。
//       大得多的岛反而累积得更少 → 可疑。要么是数据（量化+噪声）的锅，要么是追踪器**把量丢了**。
//
// 判据：在同一份真实高度场上，用**三种独立口径**各算一遍汇流累积，看最大值：
//   A. traceRivers（现状）        → 就是那个 22
//   B. 我手写的 D8 最陡下降 + 填洼 → 标准水文学口径
//   C. B + 等高点加微倾斜（epsilon）→ 消除"等高无法择路"造成的断流
// 如果 B/C 远大于 A → **追踪器有问题**（有救）；如果三者都≈22 → 数据上限（没救）。
// 用法：node scripts/tests/tools/_probe_accumulation_compare.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-acc-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap;
const g = hm.grid;
const cols = g.cellsX | 0, rows = g.cellsY | 0, sp = g.spacing || 14.4;
const n = cols * rows;
const H0 = Float64Array.from(hm.h, (v) => Number(v) || 0);
const mask = C.buildLandMask(bm.terrain);
const p0 = g.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const XY = (i) => [X0 + (i % cols) * sp, Y0 + ((i / cols) | 0) * sp];
const isLand = (i) => H0[i] >= SEA && !!mask.lookup(XY(i)[0], XY(i)[1]);
let landN = 0;
for (let i = 0; i < n; i++) if (isLand(i)) landN++;
console.log(`陆格 ${landN} / 总格 ${n}`);

// ── A. traceRivers 现状 ──
const cur = R.traceRivers(hm, { isLand: mask.lookup });
console.log(`\nA. traceRivers      : segMaxFlow = ${cur.segMaxFlow}  maxFlow = ${cur.maxFlow}  段 ${(cur.segments || []).length}  源头 ${cur.sources}`);

// ── 共用：填洼（Priority-Flood）──
function fillDepressions(H, isSeaCell) {
  const filled = new Float64Array(n);
  const done = new Uint8Array(n);
  const hi = [], hk = [];
  const push = (i, k) => {
    hi.push(i); hk.push(k); let a = hi.length - 1;
    while (a > 0) { const p = (a - 1) >> 1; if (hk[p] <= hk[a]) break; [hi[p], hi[a]] = [hi[a], hi[p]]; [hk[p], hk[a]] = [hk[a], hk[p]]; a = p; }
  };
  const pop = () => {
    const i = hi[0], k = hk[0]; const li = hi.pop(), lk = hk.pop();
    if (hi.length) {
      hi[0] = li; hk[0] = lk; let a = 0;
      for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < hk.length && hk[l] < hk[m]) m = l; if (r < hk.length && hk[r] < hk[m]) m = r; if (m === a) break; [hi[m], hi[a]] = [hi[a], hi[m]]; [hk[m], hk[a]] = [hk[a], hk[m]]; a = m; }
    }
    return [i, k];
  };
  for (let i = 0; i < n; i++) if (isSeaCell(i)) { filled[i] = H[i]; done[i] = 1; push(i, H[i]); }
  while (hi.length) {
    const [i, k] = pop();
    const ci = i % cols, cj = (i / cols) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni;
      if (done[j2]) continue;
      done[j2] = 1;
      filled[j2] = Math.max(H[j2], k);
      push(j2, filled[j2]);
    }
  }
  return filled;
}

/** 通用：给定"用于择路的高度"，返回汇流累积与最大上游链长 */
function accumulate(Hroute, eps) {
  const Hr = Float64Array.from(Hroute);
  if (eps) for (let i = 0; i < n; i++) Hr[i] += (i % 997) * eps;   // 确定性微倾斜（打破等高平局）
  const recv = new Int32Array(n).fill(-1);
  for (let cj = 0; cj < rows; cj++) for (let ci = 0; ci < cols; ci++) {
    const i = cj * cols + ci;
    if (!isLand(i)) continue;
    let best = -1, bestDrop = 1e-12;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni;
      const dist = Math.hypot(di, dj) * sp;
      const drop = (Hr[i] - Hr[j2]) / dist;
      if (drop > bestDrop) { bestDrop = drop; best = j2; }
    }
    recv[i] = best;
  }
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (Hr[b] - Hr[a]) || (H0[b] - H0[a]) || (a - b));
  const acc = new Float64Array(n).fill(1);
  for (const i of order) { if (!isLand(i)) continue; const j2 = recv[i]; if (j2 >= 0) acc[j2] += acc[i]; }
  let mx = 0, over2 = 0, over5 = 0, over10 = 0;
  for (let i = 0; i < n; i++) {
    if (!isLand(i)) continue;
    if (acc[i] > mx) mx = acc[i];
    if (acc[i] > 2) over2++;
    if (acc[i] > 5) over5++;
    if (acc[i] > 10) over10++;
  }
  return { acc, recv, mx, over2, over5, over10 };
}

const seaCell = (i) => !isLand(i);
const filled = fillDepressions(H0, seaCell);
console.log(`\n填洼：抬高 ${(() => { let c = 0; for (let i = 0; i < n; i++) if (filled[i] > H0[i] + 1e-9) c++; return c; })()} 格`);

const B = accumulate(filled, 0);
console.log(`B. D8 填洼 + 最陡下降 : 最大累积 = ${B.mx.toFixed(0)}  acc>2 的格 ${B.over2}  >5 ${B.over5}  >10 ${B.over10}`);
const Cc = accumulate(filled, 0.001);
console.log(`C. B + 等高微倾斜     : 最大累积 = ${Cc.mx.toFixed(0)}  acc>2 的格 ${Cc.over2}  >5 ${Cc.over5}  >10 ${Cc.over10}`);

// 汇流累积的分布（C 口径）
const vals = [];
for (let i = 0; i < n; i++) if (isLand(i)) vals.push(Cc.acc[i]);
vals.sort((a, b) => a - b);
const q = (p) => vals[Math.min(vals.length - 1, Math.round((vals.length - 1) * p))];
console.log(`\nC 口径 acc 分位: p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} p99=${q(0.99)} max=${q(1)}`);

console.log(`\n== 判定 ==`);
console.log(`  A(traceRivers)=${cur.segMaxFlow}   B(标准 D8)=${B.mx.toFixed(0)}   C(加微倾斜)=${Cc.mx.toFixed(0)}`);
if (Cc.mx > cur.segMaxFlow * 3) {
  console.log('  🔴 **标准口径显著更大 → `traceRivers` 在漏量（这是可修的 bug，不是数据上限）**');
} else {
  console.log('  ⚪ 三种口径量级一致 → 是这份数据的上限（量化 + 噪声把流域切碎了）');
}
