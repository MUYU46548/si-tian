// 关键尝试：**先把粗地形合成成细地形，再在细地形上追水**。
//
// 前面的死路：一直在 133×75 上改"怎么走"（最陡 / 填洼 / 最小代价 / 平局打破）——
// 上限就是 2876 个陆格切出来的几十格流域，**怎么走都长不了**。
//
// 真正该做的是**降尺度合成**（terrain downscaling，地形生成的常规做法）：
//   ① 把 133×75 双线性放大 + 轻微平滑（去掉方块感）；
//   ② 叠**分形噪声**补出粗网格没有的地形细节 —— 但**幅度必须按局部起伏缩放**，
//      否则噪声本身会造出假水系、把真实谷地冲掉（这是我上一轮"直接放大+平滑"失败的原因）；
//   ③ 在合成后的细地形上：填洼 → 最小代价出流 → 汇流累积 → 取河。
// 于是河道**沿着合成出来的真实谷地**延伸，长度不再受"一格 14.4 单位"限制。
//
// 用法：node scripts/tests/tools/_proto_downscale.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ds-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap, g0 = hm.grid;
const C0 = g0.cellsX | 0, R0 = g0.cellsY | 0, SP0 = g0.spacing || 14.4;
const p0 = g0.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const H0 = Float64Array.from(hm.h, (v) => Number(v) || 0);
const mask = C.buildLandMask(bm.terrain);

// 裁到陆地包围盒（省内存：只合成有陆地的区域）
let c0 = C0, c1 = 0, r0 = R0, r1 = 0;
for (let r = 0; r < R0; r++) for (let c = 0; c < C0; c++) {
  const i = r * C0 + c;
  if (H0[i] >= SEA && mask.lookup(X0 + c * SP0, Y0 + r * SP0)) {
    if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
}
const pad = 2;
c0 = Math.max(0, c0 - pad); c1 = Math.min(C0 - 1, c1 + pad);
r0 = Math.max(0, r0 - pad); r1 = Math.min(R0 - 1, r1 + pad);
const subC = c1 - c0 + 1, subR = r1 - r0 + 1;
console.log(`陆地包围盒 ${subC}×${subR} 格 (col ${c0}..${c1}, row ${r0}..${r1})`);

// ── ① 双线性放大 F 倍 ──
const F = 6;
const NC = subC * F, NR = subR * F, NSP = SP0 / F;
const src = new Float64Array(subC * subR);
for (let r = 0; r < subR; r++) for (let c = 0; c < subC; c++) src[r * subC + c] = H0[(r0 + r) * C0 + (c0 + c)];
function bilerp(fx, fy) {
  const x = Math.min(subC - 1 - 1e-9, Math.max(0, fx)), y = Math.min(subR - 1 - 1e-9, Math.max(0, fy));
  const x0i = Math.floor(x), y0i = Math.floor(y), tx = x - x0i, ty = y - y0i;
  const x1i = Math.min(subC - 1, x0i + 1), y1i = Math.min(subR - 1, y0i + 1);
  const a = src[y0i * subC + x0i], b = src[y0i * subC + x1i], c = src[y1i * subC + x0i], d = src[y1i * subC + x1i];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
let fine = new Float64Array(NC * NR);
for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) fine[r * NC + c] = bilerp(c / F, r / F);

// ── ② 轻微平滑（去方块感）──
function boxBlur(a, NC, NR, rad) {
  let tmpA = new Float64Array(a.length), out = new Float64Array(a.length);
  const win = rad * 2 + 1;
  for (let r = 0; r < NR; r++) {
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += a[r * NC + Math.min(NC - 1, Math.max(0, k))];
    for (let c = 0; c < NC; c++) {
      tmpA[r * NC + c] = sum / win;
      sum -= a[r * NC + Math.min(NC - 1, Math.max(0, c - rad))];
      sum += a[r * NC + Math.min(NC - 1, Math.max(0, c + rad + 1))];
    }
  }
  for (let c = 0; c < NC; c++) {
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += tmpA[Math.min(NR - 1, Math.max(0, k)) * NC + c];
    for (let r = 0; r < NR; r++) {
      out[r * NC + c] = sum / win;
      sum -= tmpA[Math.min(NR - 1, Math.max(0, r - rad)) * NC + c];
      sum += tmpA[Math.min(NR - 1, Math.max(0, r + rad + 1)) * NC + c];
    }
  }
  return out;
}
fine = boxBlur(fine, NC, NR, Math.max(1, Math.round(F / 3)));

// ── ③ 分形噪声（确定性 value noise，多倍频）──
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
function fbm(x, y, oct) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { v += amp * valueNoise(x * f, y * f); norm += amp; amp *= 0.5; f *= 2; }
  return v / norm;   // 0..1
}
// 幅度按**局部起伏**缩放：先估算细网格上的局部梯度量级
const localAmp = new Float64Array(NC * NR);
for (let r = 1; r < NR - 1; r++) for (let c = 1; c < NC - 1; c++) {
  const i = r * NC + c;
  const gx = Math.abs(fine[i + 1] - fine[i - 1]) * 0.5;
  const gy = Math.abs(fine[i + NC] - fine[i - NC]) * 0.5;
  localAmp[i] = gx + gy;
}
const meanGrad = localAmp.reduce((a, b) => a + b, 0) / localAmp.length;
console.log(`细网格 ${NC}×${NR}，格距 ${NSP.toFixed(2)}，平均梯度 ${meanGrad.toFixed(3)}`);

// 多档噪声强度都试：太强会造出假水系，太弱补不出细节
function buildSurface(noiseScale) {
  const out = new Float64Array(NC * NR);
  const baseFreq = 1 / 14;        // 特征波长约 14 细格 ≈ 2.3 世界单位
  for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
    const i = r * NC + c;
    const n = fbm(c * baseFreq, r * baseFreq, 4) - 0.5;      // -0.5..0.5
    out[i] = fine[i] + n * noiseScale * Math.max(meanGrad, localAmp[i]) * 2;
  }
  return out;
}

// ── ④ 填洼 + 最小代价出流 + 汇流累积（细网格上）──
function analyze(surface, name) {
  const n = NC * NR;
  const isSeaCell = (i) => surface[i] < SEA;
  const filled = new Float64Array(n), done = new Uint8Array(n);
  const hI = [], hK = [];
  const push = (i, k) => { hI.push(i); hK.push(k); let a = hI.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (hK[p] <= hK[a]) break; [hI[p], hI[a]] = [hI[a], hI[p]]; [hK[p], hK[a]] = [hK[a], hK[p]]; a = p; } };
  const pop = () => { const i = hI[0], k = hK[0]; const li = hI.pop(), lk = hK.pop(); if (hI.length) { hI[0] = li; hK[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < hK.length && hK[l] < hK[m]) m = l; if (r < hK.length && hK[r] < hK[m]) m = r; if (m === a) break; [hI[m], hI[a]] = [hI[a], hI[m]]; [hK[m], hK[a]] = [hK[a], hK[m]]; a = m; } } return [i, k]; };
  for (let i = 0; i < n; i++) if (isSeaCell(i)) { filled[i] = surface[i]; done[i] = 1; push(i, surface[i]); }
  while (hI.length) {
    const [i, k] = pop(); const ci = i % NC, cj = (i / NC) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= NC || nj < 0 || nj >= NR) continue;
      const j2 = nj * NC + ni; if (done[j2]) continue; done[j2] = 1;
      filled[j2] = Math.max(surface[j2], k); push(j2, filled[j2]);
    }
  }
  // 最小代价出流（Dijkstra）
  const cost = new Float64Array(n).fill(Infinity);
  const sI = [], sK = [];
  const push2 = (i, k) => { sI.push(i); sK.push(k); let a = sI.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (sK[p] <= sK[a]) break; [sI[p], sI[a]] = [sI[a], sI[p]]; [sK[p], sK[a]] = [sK[a], sK[p]]; a = p; } };
  const pop2 = () => { const i = sI[0], k = sK[0]; const li = sI.pop(), lk = sK.pop(); if (sI.length) { sI[0] = li; sK[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < sK.length && sK[l] < sK[m]) m = l; if (r < sK.length && sK[r] < sK[m]) m = r; if (m === a) break; [sI[m], sI[a]] = [sI[a], sI[m]]; [sK[m], sK[a]] = [sK[a], sK[m]]; a = m; } } return [i, k]; };
  for (let i = 0; i < n; i++) if (isSeaCell(i)) { cost[i] = 0; push2(i, 0); }
  const settled = new Uint8Array(n);
  while (sI.length) {
    const [i, c2] = pop2(); if (settled[i]) continue; settled[i] = 1;
    const ci = i % NC, cj = (i / NC) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= NC || nj < 0 || nj >= NR) continue;
      const j2 = nj * NC + ni;
      if (settled[j2] || !(surface[j2] >= SEA)) continue;
      const rise = Math.max(0, filled[i] - filled[j2]);
      const nc = c2 + rise + 1e-6 * Math.hypot(di, dj) * NSP;
      if (nc < cost[j2]) { cost[j2] = nc; push2(j2, nc); }
    }
  }
  const recv = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!(surface[i] >= SEA)) continue;
    const ci = i % NC, cj = (i / NC) | 0;
    let best = -1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= NC || nj < 0 || nj >= NR) continue;
      const j2 = nj * NC + ni;
      if (!(cost[j2] < cost[i] - 1e-12)) continue;
      if (best < 0 || cost[j2] < cost[best] - 1e-12) best = j2;
    }
    recv[i] = best;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (cost[b] - cost[a]) || (a - b));
  const acc = new Float64Array(n).fill(1);
  for (const i of order) { if (!(surface[i] >= SEA)) continue; const j2 = recv[i]; if (j2 >= 0) acc[j2] += acc[i]; }
  let mx = 0, o5 = 0, o10 = 0, o20 = 0;
  for (let i = 0; i < n; i++) { if (!(surface[i] >= SEA)) continue; if (acc[i] > mx) mx = acc[i]; if (acc[i] > 5) o5++; if (acc[i] > 10) o10++; if (acc[i] > 20) o20++; }
  // 最长连续河道（世界单位）
  let longest = 0;
  for (let i = 0; i < n; i++) {
    if (!(surface[i] >= SEA)) continue;
    let cur = i, L = 0, guard = 0; const seen = new Set();
    while (cur >= 0 && guard++ < 20000) { if (seen.has(cur)) break; seen.add(cur); const nx = recv[cur]; if (nx < 0) break; L += NSP; cur = nx; }
    if (L > longest) longest = L;
  }
  console.log(`  ${name.padEnd(22)} 最大累积 ${String(mx.toFixed(0)).padStart(5)}  acc>5 ${String(o5).padStart(5)}  >10 ${String(o10).padStart(5)}  >20 ${String(o20).padStart(4)}  最长河 ${longest.toFixed(0).padStart(5)} 世界单位`);
  return { surface, recv, acc, mx, longest, NC, NR, NSP, X0: X0 + c0 * SP0, Y0: Y0 + r0 * SP0 };
}

console.log(`\n== 降尺度合成 + 细网格追水（F=${F}，细格距 ${NSP.toFixed(2)}）==`);
const results = {};
for (const [nm, scale] of [['噪声 0（纯放大）', 0], ['噪声 0.5×', 0.5], ['噪声 1.0×', 1.0], ['噪声 1.5×', 1.5]]) {
  results[nm] = analyze(buildSurface(scale), nm);
}
const base = R.traceRivers(hm, { isLand: mask.lookup });
let baseLongest = 0;
for (const rv of (base.rivers || [])) {
  let L = 0; const p = rv.points || [];
  for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
  if (L > baseLongest) baseLongest = L;
}
// 自带河最长（对照上限）
let fmgLongest = 0;
for (const rv of (bm.rivers || [])) {
  let L = 0; const p = rv.points || [];
  for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
  if (L > fmgLongest) fmgLongest = L;
}
console.log(`\n对照：现状 traceRivers segMaxFlow=${base.segMaxFlow}、最长代表路径 ${baseLongest.toFixed(0)}；**自带 FMG 河最长 ${fmgLongest.toFixed(0)} 世界单位**`);

// ── 渲染最佳那档 ──
const bestNm = Object.keys(results).reduce((a, b) => (results[a].mx >= results[b].mx ? a : b));
const best = results[bestNm];
const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });
const provPaths = (bm.terrain || []).map((tt) => {
  const pts = tt.points || []; if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');
const mf = best.mx;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">DOWNSCALE+FBM (${bestNm}) — maxAcc ${best.mx.toFixed(0)}, longest ${best.longest.toFixed(0)}</text>`;
for (let i = 0; i < best.surface.length; i++) {
  if (!(best.surface[i] >= SEA)) continue;
  const j2 = best.recv[i];
  if (j2 < 0 || best.acc[i] < 3) continue;        // 只画 acc≥3（滤掉毛刺）
  const ci = i % best.NC, cj = (i / best.NC) | 0;
  const cj2 = (j2 / best.NC) | 0, ci2 = j2 % best.NC;
  const ax = best.X0 + ci * best.NSP, ay = best.Y0 + cj * best.NSP;
  const bx = best.X0 + ci2 * best.NSP, by = best.Y0 + cj2 * best.NSP;
  const t = Math.max(0, Math.min(1, (Math.log(best.acc[i]) - Math.log(3)) / Math.max(0.001, Math.log(mf) - Math.log(3))));
  const px = 0.7 + 3.6 * Math.sqrt(t);
  svg += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
}
fs.writeFileSync(path.join(outDir, 'ds_best.svg'), svg + '</svg>');
console.log(`\n写出 ${path.join(outDir, 'ds_best.svg')}（最佳档 = ${bestNm}，只画 acc≥3）`);
