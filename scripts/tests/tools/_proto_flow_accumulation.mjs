// 原型：**标准水文管线**（填洼 → D8 最陡下降 → 汇流累积 → 按累积量取河）在真实底图上的效果。
//
// 为什么换算法：`traceRivers` 的接收者取 `keyLess` 里**水位最小**的邻居
// （注释自己写着"只按水位 → 每格朝离海最近的方向走 → **一片放射状短支沟**"）。
// 实测真实底图：**12.4% 的陆格没有更低的陆地邻居**（水一格就停）→ 短刺；
// 而"先平滑"只是把起伏压平（高度差 8.91 → 3.20），治不了"放射状"。
//
// 正确做法（开源地形生成器的通例）：
//   ① **填洼**：让每个陆格都存在一条非上升的通路到海；
//   ② **D8 最陡下降**：下一格 = 下降率最大的邻居（含海格 → 到海即终点）；
//   ③ **汇流累积**：上游格数沿流向累加；
//   ④ **按累积量取河**：只把累积量超过阈值的格画成河 —— 于是河**必然**是从源头连到海的长线，
//      且**越下游越粗**，而不是"每格一根刺"。
//
// ⚠️ 本脚本**只做原型与对照**，不改产品代码。产物：PNG 对照 + 指标表。
// 用法：node scripts/tests/tools/_proto_flow_accumulation.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-fa-'));
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
const p0 = g.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const H = Float64Array.from(hm.h, (v) => Number(v) || 0);
const n = cols * rows;
const mask = C.buildLandMask(bm.terrain);
const XY = (i) => [X0 + (i % cols) * sp, Y0 + ((i / cols) | 0) * sp];
/** 与产品同口径的"陆地"：高度≥20 且在多边形内 */
const isLandCell = (i) => {
  if (H[i] < SEA) return false;
  const [x, y] = XY(i);
  return !!mask.lookup(x, y);
};

// ── ① 填洼（Priority-Flood：从海格出发，水位只能不降）──
const filled = new Float64Array(n);
const done = new Uint8Array(n);
const heapI = [], heapK = [];
function hpush(i, k) {
  heapI.push(i); heapK.push(k);
  let a = heapI.length - 1;
  while (a > 0) { const p = (a - 1) >> 1; if (heapK[p] <= heapK[a]) break; [heapI[p], heapI[a]] = [heapI[a], heapI[p]]; [heapK[p], heapK[a]] = [heapK[a], heapK[p]]; a = p; }
}
function hpop() {
  const i = heapI[0], k = heapK[0];
  const li = heapI.pop(), lk = heapK.pop();
  if (heapI.length) {
    heapI[0] = li; heapK[0] = lk;
    let a = 0;
    for (;;) {
      const l = 2 * a + 1, r = l + 1; let m = a;
      if (l < heapK.length && heapK[l] < heapK[m]) m = l;
      if (r < heapK.length && heapK[r] < heapK[m]) m = r;
      if (m === a) break;
      [heapI[m], heapI[a]] = [heapI[a], heapI[m]]; [heapK[m], heapK[a]] = [heapK[a], heapK[m]]; a = m;
    }
  }
  return [i, k];
}
for (let i = 0; i < n; i++) if (!isLandCell(i)) { filled[i] = H[i]; done[i] = 1; hpush(i, H[i]); }
while (heapI.length) {
  const [i, k] = hpop();
  const ci = i % cols, cj = (i / cols) | 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj) continue;
    const ni = ci + di, nj = cj + dj;
    if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
    const j2 = nj * cols + ni;
    if (done[j2]) continue;
    done[j2] = 1;
    filled[j2] = Math.max(H[j2], k);
    hpush(j2, filled[j2]);
  }
}
let raised = 0;
for (let i = 0; i < n; i++) if (filled[i] > H[i] + 1e-9) raised++;

// ── ② D8 最陡下降（用填洼后的水位算坡降；平局用原始高度）──
//    接收者可以是海格（到海即终点）—— 这条是"水能入海"的关键。
const recv = new Int32Array(n).fill(-1);
for (let cj = 0; cj < rows; cj++) for (let ci = 0; ci < cols; ci++) {
  const i = cj * cols + ci;
  if (!isLandCell(i)) continue;
  let best = -1, bestDrop = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj) continue;
    const ni = ci + di, nj = cj + dj;
    if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
    const j2 = nj * cols + ni;
    const dist = Math.hypot(di, dj) * sp;
    const drop = (filled[i] - filled[j2]) / dist;      // 下降率（水位口径）
    if (drop <= 1e-12) continue;
    if (drop > bestDrop + 1e-12) { bestDrop = drop; best = j2; }
    else if (Math.abs(drop - bestDrop) <= 1e-12 && best >= 0 && H[j2] < H[best]) best = j2;
  }
  recv[i] = best;
}

// ── ③ 汇流累积（按水位降序：高处先交）──
const order = new Int32Array(n);
for (let i = 0; i < n; i++) order[i] = i;
const ordArr = Array.from(order).sort((a, b) => (filled[b] - filled[a]) || (H[b] - H[a]) || (a - b));
const acc = new Float64Array(n).fill(1);
for (const i of ordArr) {
  if (!isLandCell(i)) continue;
  const j2 = recv[i];
  if (j2 >= 0) acc[j2] += acc[i];
}

// ── ④ 按累积量取河：累积 ≥ 阈值的格才画，画成"本格 → 接收者"的段 ──
function buildSegments(threshold) {
  const segs = [];
  for (let i = 0; i < n; i++) {
    if (!isLandCell(i)) continue;
    if (acc[i] < threshold) continue;
    const j2 = recv[i];
    if (j2 < 0) continue;
    const [ax, ay] = XY(i), [bx, by] = XY(j2);
    segs.push({ x0: ax, y0: ay, x1: bx, y1: by, flow: acc[i], endInSea: !isLandCell(j2) });
  }
  return segs;
}

/** 把段拼成一条条连续折线（下游追踪），用于量"最长河" —— 这才是用户说的"长河" */
function longestChain(segs) {
  const next = new Map();      // 上游 → 下游（按格号索引）
  const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
  const outMap = new Map();
  for (const s of segs) outMap.set(key(s.x0, s.y0), s);
  let best = 0;
  for (const s of segs) {
    // 只从"没有上游"的段起走（近似：起点在段里只出现一次的上游端）
    let L = 0, cur = s, guard = 0;
    const seen = new Set();
    while (cur && guard++ < 5000) {
      const k = key(cur.x0, cur.y0);
      if (seen.has(k)) break;
      seen.add(k);
      L += Math.hypot(cur.x1 - cur.x0, cur.y1 - cur.y0);
      cur = outMap.get(key(cur.x1, cur.y1));
    }
    if (L > best) best = L;
  }
  return best;
}

const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });
const provPaths = (bm.terrain || []).map((tt) => {
  const pts = tt.points || []; if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');
function render(segs, title, file) {
  const mf = segs.reduce((m, s) => Math.max(m, s.flow), 1);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">${title}</text>`;
  for (const sg of segs) {
    const t = Math.max(0, Math.min(1, (Math.log(sg.flow) - Math.log(2)) / Math.max(0.001, Math.log(mf) - Math.log(2))));
    const px = 0.7 + 3.8 * Math.sqrt(t);
    s += `<line x1="${sg.x0.toFixed(1)}" y1="${sg.y0.toFixed(1)}" x2="${sg.x1.toFixed(1)}" y2="${sg.y1.toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
  }
  s += '</svg>';
  fs.writeFileSync(path.join(outDir, file), s);
}

console.log(`填洼：抬高 ${raised}/${n} 格（${(raised / n * 100).toFixed(1)}%）`);
console.log(`\n== 汇流累积口径（真实 desite 底图）==`);
for (const th of [2, 3, 5, 10, 20, 40]) {
  const segs = buildSegments(th);
  const maxAcc = Math.max(...segs.map((s) => s.flow), 0);
  console.log(`  阈值 acc>=${String(th).padStart(2)}: 段 ${String(segs.length).padStart(5)} `
    + `最长连续河 ${longestChain(segs).toFixed(0).padStart(5)} 世界单位  最大累积 ${maxAcc}`);
}
// 现状对照
const cur = R.traceRivers(hm, { isLand: mask.lookup });
const curSegs = (cur.segments || []).map((s) => ({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, flow: s.flow }));
console.log(`  ${'（现状 traceRivers）'.padEnd(18)} 段 ${String(curSegs.length).padStart(5)} `
  + `最长连续河 ${longestChain(curSegs).toFixed(0).padStart(5)} 世界单位`);
render(buildSegments(3), 'flow-accumulation acc>=3 (PROTOTYPE)', 'fa_3.svg');
render(buildSegments(8), 'flow-accumulation acc>=8 (PROTOTYPE)', 'fa_8.svg');
render(curSegs, 'CURRENT traceRivers (for comparison)', 'fa_current.svg');
console.log('\n写出：fa_3.svg / fa_8.svg / fa_current.svg → ' + outDir);
