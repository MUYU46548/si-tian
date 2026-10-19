// 验证：**干净地平局打破**能不能同样把汇流累积从 22 提上去（不带人造梯度）。
//
// 上一步发现：`traceRivers` 最大累积 22，标准 D8 填洼 28，**加"等高微倾斜"后 76**。
// 说明瓶颈是**等高平局**（高度量化到 0~100 → 大片等高）导致的择路乱走 / 漏量。
// 但"人造梯度"（i%997 * eps）不干净（会引入与地形无关的走向）。这里验三个**可落地**的替代：
//   C1  平局时**优先朝"已填洼水位更低"的邻居**（排水方向），再看原始高度（产品其实已有类似思路，
//       但 `keyLess` 只在候选里挑最小，没保证"整片等高区朝同一方向排"）
//   C2  平局时优先朝**离海更近**的格（BFS 海距，产品已算 `seaDist`）—— 物理上"最短出流路径"
//   C3  平局时朝**填入值更低 + 原高度更低 + 海距更小**的复合键（三者依次比较）
// 判据：最大累积、acc>5 / >10 的格数，以及**最长连续河道**。
// 用法：node scripts/tests/tools/_probe_tiebreak.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-tb-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
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

// 填洼
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
// 海距（BFS，格步）
const seaDist = new Int32Array(n).fill(-1);
{
  const q = []; for (let i = 0; i < n; i++) if (!isLand(i)) { seaDist[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h]; const ci = i % cols, cj = (i / cols) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni; if (seaDist[j2] >= 0) continue;
      seaDist[j2] = seaDist[i] + 1; q.push(j2);
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

function run(name, pick) {
  const recv = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!isLand(i)) continue;
    recv[i] = pick(i, NB(i));
  }
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (filled[b] - filled[a]) || (H[b] - H[a]) || (a - b));
  const acc = new Float64Array(n).fill(1);
  for (const i of order) { if (!isLand(i)) continue; const j2 = recv[i]; if (j2 >= 0) acc[j2] += acc[i]; }
  let mx = 0, o5 = 0, o10 = 0;
  for (let i = 0; i < n; i++) { if (!isLand(i)) continue; if (acc[i] > mx) mx = acc[i]; if (acc[i] > 5) o5++; if (acc[i] > 10) o10++; }
  // 最长连续河道（沿 recv 追，格数）
  let longest = 0;
  for (let i = 0; i < n; i++) {
    if (!isLand(i)) continue;
    let cur = i, len = 0; const seen = new Set();
    while (cur >= 0 && len < 5000) { if (seen.has(cur)) break; seen.add(cur); cur = recv[cur]; len++; }
    if (len > longest) longest = len;
  }
  console.log(`${name.padEnd(30)} 最大累积 ${String(mx.toFixed(0)).padStart(4)}  acc>5 ${String(o5).padStart(4)}  acc>10 ${String(o10).padStart(4)}  最长连续河道 ${longest} 格`);
  return { mx, o5, o10, longest, acc, recv };
}

/** 下降率（水位口径），>0 才可走 */
const drop = (i, nb) => (filled[i] - filled[nb.j]) / nb.dist;

console.log('== 四种择路口径对照（真实 desite 底图）==');
run('D0 现状口径（仅最陡）', (i, nbs) => {
  let best = -1, bd = 1e-12;
  for (const nb of nbs) { const d = drop(i, nb); if (d > bd) { bd = d; best = nb.j; } }
  return best;
});
run('D1 平局→原高度更低', (i, nbs) => {
  let best = -1, bd = 1e-12, bh = Infinity;
  for (const nb of nbs) {
    const d = drop(i, nb); if (d <= 1e-12) continue;
    if (d > bd + 1e-9 || (Math.abs(d - bd) <= 1e-9 && H[nb.j] < bh)) { bd = Math.max(bd, d); bh = H[nb.j]; best = nb.j; }
  }
  return best;
});
run('D2 平局→海距更近', (i, nbs) => {
  let best = -1, bd = 1e-12, bs = Infinity;
  for (const nb of nbs) {
    const d = drop(i, nb); if (d <= 1e-12) continue;
    if (d > bd + 1e-9 || (Math.abs(d - bd) <= 1e-9 && seaDist[nb.j] < bs)) { bd = Math.max(bd, d); bs = seaDist[nb.j]; best = nb.j; }
  }
  return best;
});
run('D3 平局→海距→原高度', (i, nbs) => {
  let best = -1, bd = 1e-12, bs = Infinity, bh = Infinity;
  for (const nb of nbs) {
    const d = drop(i, nb); if (d <= 1e-12) continue;
    const better = d > bd + 1e-9
      || (Math.abs(d - bd) <= 1e-9 && (seaDist[nb.j] < bs || (seaDist[nb.j] === bs && H[nb.j] < bh)));
    if (better) { bd = Math.max(bd, d); bs = seaDist[nb.j]; bh = H[nb.j]; best = nb.j; }
  }
  return best;
});
console.log('\n判读：D2/D3 若把"最大累积"提到几十以上，而**不带任何人造梯度**，');
console.log('      那就是可落地的干净修法（海距是产品已经算过的东西）。');
