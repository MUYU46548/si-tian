// 验证：**最小代价出流路由**（Dijkstra from outlets）能不能给出又长又连的河 —— 且不带人造梯度。
//
// 前面否掉了：
//   · 现状（只按最陡）            最大累积 22~28，最长连续河道 **9 格**
//   · 平局→原高度更低 / 海距更近   一样 27~28（**说明不是平局打破的问题**）
//   · 加上 `i%997*0.001` 人造梯度  76 —— 但那是**与地形无关的系统性倾斜**，不干净，不能用
//
// 正解（水文学标准，ArcGIS/Whitebox 的 D8 也这么做）：**先算"到出水口的代价"**，
// 再让每个格朝**代价更小**的邻居走。代价 = 沿路径的累积抬升（`max(0, filled[j]-filled[i])`）。
// 这样整片等高/微洼区会**一致地朝同一个出海口排水**，而不是在局部乱撞。
//
// 用法：node scripts/tests/tools/_probe_least_cost.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-lc-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap, g = hm.grid;
const cols = g.cellsX | 0, rows = g.cellsY | 0, sp = g.spacing || 14.4, n = cols * rows;
const H = Float64Array.from(hm.h, (v) => Number(v) || 0);
const mask = C.buildLandMask(bm.terrain);
const p0 = g.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const XY = (i) => [X0 + (i % cols) * sp, Y0 + ((i / cols) | 0) * sp];
const isLand = (i) => H[i] >= SEA && !!mask.lookup(XY(i)[0], XY(i)[1]);
let landN = 0; for (let i = 0; i < n; i++) if (isLand(i)) landN++;

// ① 填洼
const filled = new Float64Array(n), done = new Uint8Array(n);
{
  const hI = [], hK = [];
  const push = (i, k) => { hI.push(i); hK.push(k); let a = hI.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (hK[p] <= hK[a]) break; [hI[p], hI[a]] = [hI[a], hI[p]]; [hK[p], hK[a]] = [hK[a], hK[p]]; a = p; } };
  const pop = () => { const i = hI[0], k = hK[0]; const li = hI.pop(), lk = hK.pop(); if (hI.length) { hI[0] = li; hK[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < hK.length && hK[l] < hK[m]) m = l; if (r < hK.length && hK[r] < hK[m]) m = r; if (m === a) break; [hI[m], hI[a]] = [hI[a], hI[m]]; [hK[m], hK[a]] = [hK[a], hK[m]]; a = m; } } return [i, k]; };
  for (let i = 0; i < n; i++) if (!isLand(i)) { filled[i] = H[i]; done[i] = 1; push(i, H[i]); }
  while (hI.length) {
    const [i, k] = pop(); const ci = i % cols, cj = (i / cols) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni; if (done[j2]) continue; done[j2] = 1;
      filled[j2] = Math.max(H[j2], k); push(j2, filled[j2]);
    }
  }
}
const NB = (i) => {
  const out = []; const ci = i % cols, cj = (i / cols) | 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
    if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
    out.push({ j: nj * cols + ni, dist: Math.hypot(di, dj) * sp });
  }
  return out;
};

// ② 最小代价出流：Dijkstra，源 = 所有非陆格（出水口），代价 = 沿路上升量 + 极小距离项打破平局
const cost = new Float64Array(n).fill(Infinity);
{
  const hI = [], hK = [];
  const push = (i, k) => { hI.push(i); hK.push(k); let a = hI.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (hK[p] <= hK[a]) break; [hI[p], hI[a]] = [hI[a], hI[p]]; [hK[p], hK[a]] = [hK[a], hK[p]]; a = p; } };
  const pop = () => { const i = hI[0], k = hK[0]; const li = hI.pop(), lk = hK.pop(); if (hI.length) { hI[0] = li; hK[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < hK.length && hK[l] < hK[m]) m = l; if (r < hK.length && hK[r] < hK[m]) m = r; if (m === a) break; [hI[m], hI[a]] = [hI[a], hI[m]]; [hK[m], hK[a]] = [hK[a], hK[m]]; a = m; } } return [i, k]; };
  for (let i = 0; i < n; i++) if (!isLand(i)) { cost[i] = 0; push(i, 0); }
  const settled = new Uint8Array(n);
  while (hI.length) {
    const [i, ci2] = pop();
    if (settled[i]) continue; settled[i] = 1;
    for (const nb of NB(i)) {
      if (settled[nb.j]) continue;
      if (!isLand(nb.j)) continue;
      const rise = Math.max(0, filled[i] - filled[nb.j]);   // 从 nb 走到 i 需要抬升多少
      const nc = ci2 + rise + 1e-6 * nb.dist;               // 距离项只用于打破平局，量级极小
      if (nc < cost[nb.j]) { cost[nb.j] = nc; push(nb.j, nc); }
    }
  }
}

// ③ 择路：朝"代价更小"的邻居（平局用原高度、再平局用海距/编号，保证确定性）
const recv = new Int32Array(n).fill(-1);
for (let i = 0; i < n; i++) {
  if (!isLand(i)) continue;
  let best = -1;
  for (const nb of NB(i)) {
    if (!(cost[nb.j] < cost[i] - 1e-12)) continue;
    if (best < 0) { best = nb.j; continue; }
    if (cost[nb.j] < cost[best] - 1e-12) { best = nb.j; continue; }
    if (Math.abs(cost[nb.j] - cost[best]) <= 1e-12) {
      const hb = H[nb.j], hbest = H[best];
      if (hb < hbest || (hb === hbest && nb.j < best)) best = nb.j;
    }
  }
  recv[i] = best;
}

// ④ 汇流累积
const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (cost[b] - cost[a]) || (a - b));
const acc = new Float64Array(n).fill(1);
for (const i of order) { if (!isLand(i)) continue; const j2 = recv[i]; if (j2 >= 0) acc[j2] += acc[i]; }
let mx = 0, o2 = 0, o5 = 0, o10 = 0;
for (let i = 0; i < n; i++) { if (!isLand(i)) continue; if (acc[i] > mx) mx = acc[i]; if (acc[i] > 2) o2++; if (acc[i] > 5) o5++; if (acc[i] > 10) o10++; }
let longest = 0, reach = 0;
for (let i = 0; i < n; i++) {
  if (!isLand(i)) continue;
  let cur = i, len = 0; const seen = new Set();
  while (cur >= 0 && len < 8000) { if (seen.has(cur)) break; seen.add(cur); cur = recv[cur]; len++; }
  if (len > longest) longest = len;
  if (len > 1) reach++;
}
console.log(`陆格 ${landN}`);
console.log(`\n== 最小代价出流路由（不带人造梯度）==`);
console.log(`  最大累积 = ${mx.toFixed(0)}   acc>2 ${o2}  >5 ${o5}  >10 ${o10}   最长连续河道 ${longest} 格`);
const vals = []; for (let i = 0; i < n; i++) if (isLand(i)) vals.push(acc[i]);
vals.sort((a, b) => a - b);
const q = (p) => vals[Math.min(vals.length - 1, Math.round((vals.length - 1) * p))];
console.log(`  acc 分位: p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} p99=${q(0.99)} max=${q(1)}`);

const cur = R.traceRivers(hm, { isLand: mask.lookup });
console.log(`\n== 对照：现状 traceRivers ==`);
console.log(`  segMaxFlow = ${cur.segMaxFlow}  段 ${(cur.segments || []).length}  源头 ${cur.sources}`);
console.log(`\n判读：若"最大累积"与"最长连续河道"都显著超过现状，且**不含人造梯度**，`);
console.log(`      这就是可落地的正解（填洼 + 最小代价出流 + 汇流累积，全是标准做法）。`);
