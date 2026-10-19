// 用**正确的高阈值**把细网格上的主干画出来（上一版画成一片蓝 = 阈值太低，不是几何错）。
//
// 已知：放大 6× 后最大汇流累积 **5191**（现状 22）、acc>20 的格有 10490 个。
// 要把"一片蓝"变成"一张河网"，阈值必须落在累积分布的**高端**（现实河网图也是只画主干+主要支流）。
// 本脚本扫几个阈值各渲一张，并给出每档的"像不像河网"指标（段数 / 长度分布 / 覆盖率）。
// 用法：node scripts/tests/tools/_proto_downscale_threshold.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-dt-'));
for (const f of ['coastline.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap, g0 = hm.grid;
const C0 = g0.cellsX | 0, R0 = g0.cellsY | 0, SP0 = g0.spacing || 14.4;
const p0 = g0.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const H0 = Float64Array.from(hm.h, (v) => Number(v) || 0);
const mask = C.buildLandMask(bm.terrain);

let c0 = C0, c1 = 0, r0 = R0, r1 = 0;
for (let r = 0; r < R0; r++) for (let c = 0; c < C0; c++) {
  const i = r * C0 + c;
  if (H0[i] >= SEA && mask.lookup(X0 + c * SP0, Y0 + r * SP0)) {
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
}
const pad = 3;
c0 = Math.max(0, c0 - pad); c1 = Math.min(C0 - 1, c1 + pad);
r0 = Math.max(0, r0 - pad); r1 = Math.min(R0 - 1, r1 + pad);
const subC = c1 - c0 + 1, subR = r1 - r0 + 1;

const F = 6;
const NC = subC * F, NR = subR * F, NSP = SP0 / F;
const src = new Float64Array(subC * subR);
for (let r = 0; r < subR; r++) for (let c = 0; c < subC; c++) src[r * subC + c] = H0[(r0 + r) * C0 + (c0 + c)];
function bilerp(fx, fy) {
  const x = Math.min(subC - 1 - 1e-9, Math.max(0, fx)), y = Math.min(subR - 1 - 1e-9, Math.max(0, fy));
  const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
  const x2 = Math.min(subC - 1, xi + 1), y2 = Math.min(subR - 1, yi + 1);
  const a = src[yi * subC + xi], b = src[yi * subC + x2], c = src[y2 * subC + xi], d = src[y2 * subC + x2];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
let fine = new Float64Array(NC * NR);
for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) fine[r * NC + c] = bilerp(c / F, r / F);
function boxBlur(a, rad) {
  const t = new Float64Array(a.length), o = new Float64Array(a.length), win = rad * 2 + 1;
  for (let r = 0; r < NR; r++) {
    let s = 0; for (let k = -rad; k <= rad; k++) s += a[r * NC + Math.min(NC - 1, Math.max(0, k))];
    for (let c = 0; c < NC; c++) { t[r * NC + c] = s / win; s -= a[r * NC + Math.min(NC - 1, Math.max(0, c - rad))]; s += a[r * NC + Math.min(NC - 1, Math.max(0, c + rad + 1))]; }
  }
  for (let c = 0; c < NC; c++) {
    let s = 0; for (let k = -rad; k <= rad; k++) s += t[Math.min(NR - 1, Math.max(0, k)) * NC + c];
    for (let r = 0; r < NR; r++) { o[r * NC + c] = s / win; s -= t[Math.min(NR - 1, Math.max(0, r - rad)) * NC + c]; s += t[Math.min(NR - 1, Math.max(0, r + rad + 1)) * NC + c]; }
  }
  return o;
}
fine = boxBlur(fine, Math.round(F / 3));

// 无噪声（实测噪声对结果几乎无影响，去掉更少人工痕迹）
const surface = fine;
const n = NC * NR;
const isL = (i) => surface[i] >= SEA;

// 填洼
const filled = new Float64Array(n), done = new Uint8Array(n);
{
  const hI = [], hK = [];
  const push = (i, k) => { hI.push(i); hK.push(k); let a = hI.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (hK[p] <= hK[a]) break; [hI[p], hI[a]] = [hI[a], hI[p]]; [hK[p], hK[a]] = [hK[a], hK[p]]; a = p; } };
  const pop = () => { const i = hI[0], k = hK[0]; const li = hI.pop(), lk = hK.pop(); if (hI.length) { hI[0] = li; hK[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < hK.length && hK[l] < hK[m]) m = l; if (r < hK.length && hK[r] < hK[m]) m = r; if (m === a) break; [hI[m], hI[a]] = [hI[a], hI[m]]; [hK[m], hK[a]] = [hK[a], hK[m]]; a = m; } } return [i, k]; };
  for (let i = 0; i < n; i++) if (!isL(i)) { filled[i] = surface[i]; done[i] = 1; push(i, surface[i]); }
  while (hI.length) {
    const [i, k] = pop(); const ci = i % NC, cj = (i / NC) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= NC || nj < 0 || nj >= NR) continue;
      const j2 = nj * NC + ni; if (done[j2]) continue; done[j2] = 1;
      filled[j2] = Math.max(surface[j2], k); push(j2, filled[j2]);
    }
  }
}
// 最小代价出流
const cost = new Float64Array(n).fill(Infinity);
{
  const sI = [], sK = [];
  const push = (i, k) => { sI.push(i); sK.push(k); let a = sI.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (sK[p] <= sK[a]) break; [sI[p], sI[a]] = [sI[a], sI[p]]; [sK[p], sK[a]] = [sK[a], sK[p]]; a = p; } };
  const pop = () => { const i = sI[0], k = sK[0]; const li = sI.pop(), lk = sK.pop(); if (sI.length) { sI[0] = li; sK[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < sK.length && sK[l] < sK[m]) m = l; if (r < sK.length && sK[r] < sK[m]) m = r; if (m === a) break; [sI[m], sI[a]] = [sI[a], sI[m]]; [sK[m], sK[a]] = [sK[a], sK[m]]; a = m; } } return [i, k]; };
  for (let i = 0; i < n; i++) if (!isL(i)) { cost[i] = 0; push(i, 0); }
  const settled = new Uint8Array(n);
  while (sI.length) {
    const [i, c2] = pop(); if (settled[i]) continue; settled[i] = 1;
    const ci = i % NC, cj = (i / NC) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= NC || nj < 0 || nj >= NR) continue;
      const j2 = nj * NC + ni;
      if (settled[j2] || !isL(j2)) continue;
      const nc = c2 + Math.max(0, filled[i] - filled[j2]) + 1e-6 * Math.hypot(di, dj) * NSP;
      if (nc < cost[j2]) { cost[j2] = nc; push(j2, nc); }
    }
  }
}
const recv = new Int32Array(n).fill(-1);
// 🔴 择路口径（本脚本末尾会同时跑两种，看哪种不"编织"）：
//   'd8'   = 最陡下降（D8）：单一流向，河道应当干净
//   'cost' = 最小代价出流：保证出得去，但相邻格可能选到**方向不一致**的邻居 → 画出平行细线
function buildRecv(mode) {
  const r2 = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!isL(i)) continue;
    const ci = i % NC, cj = (i / NC) | 0;
    let best = -1, bestVal = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= NC || nj < 0 || nj >= NR) continue;
      const j2 = nj * NC + ni;
      if (mode === 'd8') {
        // 最陡下降：下降率最大（用填洼后的水位，保证一定出得去）
        const d = (filled[i] - filled[j2]) / Math.hypot(di, dj);
        if (d > bestVal + 1e-12) { bestVal = d; best = j2; }
      } else {
        if (!(cost[j2] < cost[i] - 1e-12)) continue;
        if (best < 0 || cost[j2] < cost[best] - 1e-12) best = j2;
      }
    }
    r2[i] = best;
  }
  return r2;
}

const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (cost[b] - cost[a]) || (a - b));
const acc = new Float64Array(n).fill(1);
for (const i of order) { if (!isL(i)) continue; const j2 = recv[i]; if (j2 >= 0) acc[j2] += acc[i]; }

// 累积分布（只看陆格）
const vals = []; for (let i = 0; i < n; i++) if (isL(i)) vals.push(acc[i]);
vals.sort((a, b) => a - b);
const maxAcc = vals[vals.length - 1];
const q = (p) => vals[Math.min(vals.length - 1, Math.round((vals.length - 1) * p))];
console.log(`陆格 ${vals.length}，最大累积 ${maxAcc.toFixed(0)}`);
console.log(`累积分位: p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} p99=${q(0.99)} p99.9=${q(0.999)}`);

const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });
const provPaths = (bm.terrain || []).map((tt) => {
  const pts = tt.points || []; if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');
const OX = X0 + c0 * SP0, OY = Y0 + r0 * SP0;

function renderAt(th, tag) {
  const segs = [];
  for (let i = 0; i < n; i++) {
    if (!isL(i) || acc[i] < th) continue;
    const j2 = recv[i]; if (j2 < 0) continue;
    segs.push([i, j2, acc[i]]);
  }
  // 最长连续（沿 recv 连成的折线长度，不重复走）
  let longest = 0;
  const visited = new Uint8Array(n);
  const order2 = segs.map((s) => s[0]).sort((a, b) => acc[b] - acc[a]);
  for (const start of order2) {
    let cur = start, L = 0, guard = 0;
    while (cur >= 0 && guard++ < 50000) { if (visited[cur]) break; if (acc[cur] < th) break; visited[cur] = 1; const nx = recv[cur]; if (nx < 0) break; L += NSP; cur = nx; }
    if (L > longest) longest = L;
  }
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">acc&gt;=${th} — ${segs.length} segs, longest ${longest.toFixed(0)} world units</text>`;
  for (const [i, j2, a] of segs) {
    const ci = i % NC, cj = (i / NC) | 0, ci2 = j2 % NC, cj2 = (j2 / NC) | 0;
    const t = Math.max(0, Math.min(1, (Math.log(a) - Math.log(th)) / Math.max(0.001, Math.log(maxAcc) - Math.log(th))));
    const px = 0.7 + 3.6 * Math.sqrt(t);
    svg += `<line x1="${(OX + ci * NSP).toFixed(1)}" y1="${(OY + cj * NSP).toFixed(1)}" x2="${(OX + ci2 * NSP).toFixed(1)}" y2="${(OY + cj2 * NSP).toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
  }
  fs.writeFileSync(path.join(outDir, `dt_${tag}.svg`), svg + '</svg>');
  console.log(`  阈值 ${String(th).padStart(5)}: 段 ${String(segs.length).padStart(6)}  最长连续河 ${longest.toFixed(0).padStart(5)} 世界单位  → dt_${tag}.svg`);
  return { th, segs: segs.length, longest };
}

console.log('\n== 两种择路口径 × 阈值扫描 ==');
for (const mode of ['d8', 'cost']) {
  const recvM = buildRecv(mode);
  // 汇流累积
  const accM = new Float64Array(n).fill(1);
  const orderM = Array.from({ length: n }, (_, i) => i).sort((a, b) => (cost[b] - cost[a]) || (a - b));
  for (const i of orderM) { if (!isL(i)) continue; const j2 = recvM[i]; if (j2 >= 0) accM[j2] += accM[i]; }
  const valsM = []; for (let i = 0; i < n; i++) if (isL(i)) valsM.push(accM[i]);
  valsM.sort((a, b) => a - b);
  const maxM = valsM[valsM.length - 1];
  console.log(`\n--- 择路口径 ${mode}（最大累积 ${maxM.toFixed(0)}）---`);
  for (const th of [30, 60, 120, 300]) {
    const segs = [];
    for (let i = 0; i < n; i++) { if (!isL(i) || accM[i] < th) continue; const j2 = recvM[i]; if (j2 < 0) continue; segs.push([i, j2, accM[i]]); }
    // 最长连续河道（沿 recv 只走一次，用 per-start 的本地 seen，不用全局 visited）
    let longest = 0;
    for (const [start] of segs) {
      let cur = start, L = 0, guard = 0; const seen = new Set();
      while (cur >= 0 && guard++ < 50000) {
        if (seen.has(cur)) break; seen.add(cur);
        if (!isL(cur) || accM[cur] < th) break;
        const nx = recvM[cur]; if (nx < 0) break;
        L += NSP; cur = nx;
      }
      if (L > longest) longest = L;
    }
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">${mode} acc&gt;=${th} — ${segs.length} segs, longest ${longest.toFixed(0)}</text>`;
    for (const [i, j2, a] of segs) {
      const ci = i % NC, cj = (i / NC) | 0, ci2 = j2 % NC, cj2 = (j2 / NC) | 0;
      const t = Math.max(0, Math.min(1, (Math.log(a) - Math.log(th)) / Math.max(0.001, Math.log(maxM) - Math.log(th))));
      const px = 0.7 + 3.6 * Math.sqrt(t);
      svg += `<line x1="${(OX + ci * NSP).toFixed(1)}" y1="${(OY + cj * NSP).toFixed(1)}" x2="${(OX + ci2 * NSP).toFixed(1)}" y2="${(OY + cj2 * NSP).toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
    }
    fs.writeFileSync(path.join(outDir, `dt_${mode}_${th}.svg`), svg + '</svg>');
    console.log(`  ${mode} 阈值 ${String(th).padStart(4)}: 段 ${String(segs.length).padStart(6)}  最长连续河 ${longest.toFixed(0).padStart(5)} 世界单位`);
  }
}
console.log(`\n（对照：现状 1710 段 / 最长 140；自带 FMG 河最长 563 世界单位）`);
console.log('写出目录 ' + outDir);
