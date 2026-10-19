// 原型验证：**填洼（depression filling）**之后，自动河网会不会真的好看。
//
// 诊断依据（`_probe_river_reachability.mjs`）：当前 1710 段里 **732 段（42.8%）到不了海**
// （`sink` = 走到一个没有更低陆地邻居的洼地就停），而且按汇流量分层后
// **最粗的那一档也有 50% 是死水** → 满图都是"看着像河、其实哪儿也不去"的线。
//
// 填洼是水文学的标准第一步：把没有出口的洼地抬到"能翻过最矮的分水岭"的高度，
// 于是**每个陆地格都能单调下降到海**，河网自然连成一条主干。
//
// ⚠️ 这里**只做原型与对照**（不改产品代码）：产物是两张可肉眼比对的 PNG。
// 用法：node scripts/tests/tools/_proto_fill_depressions.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-fd-'));
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
const mask = C.buildLandMask(bm.terrain);
const isLandAt = (i) => { const ci = i % cols, cj = (i / cols) | 0; return !!mask.lookup(g.points[i] ? (Array.isArray(g.points[i]) ? g.points[i][0] : g.points[i].x) : 0, 0); };

/**
 * 优先队列填洼（简化 Priority-Flood）：
 *  ① 所有"海格"与"掩膜外"的格入队，水位 = 它自己的高度；
 *  ② 反复取**水位最低**的格，把它的每个未访问陆地邻居的水位抬到 max(它自己的 h, 当前水位)；
 *  ③ 结束条件：所有可达陆地格都有一个不高于自身的"出海通道"。
 * 结果 `filled[i]` = 该格在"保证能流出去"前提下的高度（≥ 原高度）。
 */
function fillDepressions(H, cols, rows, isSeaOrOut) {
  const n = cols * rows;
  const filled = new Float64Array(n);
  const done = new Uint8Array(n);
  // 极简二叉堆
  const heapI = [], heapK = [];
  const push = (i, k) => {
    let a = heapI.length; heapI.push(i); heapK.push(k);
    while (a > 0) { const p = (a - 1) >> 1; if (heapK[p] <= heapK[a]) break; [heapI[p], heapI[a]] = [heapI[a], heapI[p]]; [heapK[p], heapK[a]] = [heapK[a], heapK[p]]; a = p; }
  };
  const pop = () => {
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
  };
  for (let i = 0; i < n; i++) {
    if (isSeaOrOut(i)) { filled[i] = Number(H[i]) || 0; done[i] = 1; push(i, filled[i]); }
  }
  let visited = 0;
  while (heapI.length) {
    const [i, k] = pop();
    visited++;
    const ci = i % cols, cj = (i / cols) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni;
      if (done[j2]) continue;
      done[j2] = 1;
      filled[j2] = Math.max(Number(H[j2]) || 0, k);
      push(j2, filled[j2]);
    }
  }
  return filled;
}

const isSeaOrOut = (i) => {
  const h = Number(hm.h[i]) || 0;
  if (h < SEA) return true;
  // 掩膜外的格（多边形之外）也当出口
  if (!mask.lookup(gridX(i), gridY(i))) return true;
  return false;
};
const p0 = g.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
function gridX(i) { return X0 + (i % cols) * sp; }
function gridY(i) { return Y0 + ((i / cols) | 0) * sp; }

console.log('填洼中…（' + (cols * rows) + ' 格）');
const t0 = Date.now();
const filled = fillDepressions(hm.h, cols, rows, isSeaOrOut);
console.log(`填洼完成 ${Date.now() - t0} ms`);
let raised = 0, maxRaise = 0;
for (let i = 0; i < filled.length; i++) {
  const d = filled[i] - (Number(hm.h[i]) || 0);
  if (d > 1e-9) { raised++; if (d > maxRaise) maxRaise = d; }
}
console.log(`被抬高的格 ${raised} / ${filled.length}（${(raised / filled.length * 100).toFixed(1)}%），最大抬升 ${maxRaise.toFixed(1)}`);

// 用填洼后的高度图重新追踪
const filledHm = { ...hm, h: Array.from(filled) };
const before = R.traceRivers(hm, { isLand: mask.lookup });
const after = R.traceRivers(filledHm, { isLand: mask.lookup });
console.log(`\n追踪对照：`);
const stat = (x) => `段 ${(x.segments || []).length} / 代表路径 ${(x.rivers || []).length} / 源头 ${x.sources} / endorheic ${x.endorheicCells}`;
console.log(`  原高度图  : ${stat(before)}`);
console.log(`  填洼后    : ${stat(after)}`);

// 再量一次"到不了海"的比例（同一套判据）
function reachStats(trace, H, useFilled) {
  const segs = trace.segments || [];
  const spacing = sp, R2 = (spacing * 1.5) ** 2;
  const cache = new Map();
  const Hh = H;
  const nextOf = (i) => {
    if (cache.has(i)) return cache.get(i);
    const ci = i % cols, cj = (i / cols) | 0;
    let best = -1, bestH = Number(Hh[i]);
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni;
      if (!mask.lookup(gridX(j2), gridY(j2))) continue;
      if (di * di * sp * sp + dj * dj * sp * sp > R2 + 1e-6) continue;
      const h = Number(Hh[j2]);
      if (h < bestH) { bestH = h; best = j2; }
    }
    cache.set(i, best);
    return best;
  };
  let ok = 0, bad = 0;
  for (const s of segs) {
    const ci = Math.round((s.x1 - X0) / sp), cj = Math.round((s.y1 - Y0) / sp);
    if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) continue;
    let cur = cj * cols + ci, steps = 0; const seen = new Set(); let good = false;
    while (cur >= 0 && steps < 8000) {
      if ((Number(Hh[cur]) || 0) < SEA) { good = true; break; }
      if (seen.has(cur)) break;
      seen.add(cur);
      const nx = nextOf(cur);
      if (nx < 0) break;
      cur = nx; steps++;
    }
    if (good) ok++; else bad++;
  }
  return { ok, bad, total: ok + bad };
}
const rb = reachStats(before, hm.h, false);
const ra = reachStats(after, filled, true);
console.log(`\n== 到不了海的段 ==`);
console.log(`  原高度图: ${rb.bad}/${rb.total} = ${(rb.bad / rb.total * 100).toFixed(1)}%`);
console.log(`  填洼后  : ${ra.bad}/${ra.total} = ${(ra.bad / ra.total * 100).toFixed(1)}%`);

// 渲染对照 SVG
const provPaths = (bm.terrain || []).map((tt) => {
  const pts = tt.points || []; if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');
const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });
function renderSvg(trace, title, file) {
  const segs = trace.segments || [];
  const mf = trace.segMaxFlow || 1;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">${title}</text>`;
  for (const sg of segs) {
    const t = Math.max(0, Math.min(1, (sg.flow - 1) / Math.max(1, mf - 1)));
    const d = 36 + (613 - 36) * Math.sqrt(t);
    const px = Math.max(0.7, Math.min(4, 0.2 * 6 * Math.max(Math.sqrt(Math.max(d, 1)) / 14, 0.6)));
    s += `<line x1="${sg.x0.toFixed(1)}" y1="${sg.y0.toFixed(1)}" x2="${sg.x1.toFixed(1)}" y2="${sg.y1.toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
  }
  s += '</svg>';
  fs.writeFileSync(path.join(outDir, file), s);
  return path.join(outDir, file);
}
console.log('\n渲染：');
console.log('  ' + renderSvg(before, `BEFORE fill — ${(before.segments || []).length} segs, ${rb.bad}/${rb.total} dead-end`, 'fill_before.svg'));
console.log('  ' + renderSvg(after, `AFTER fill — ${(after.segments || []).length} segs, ${ra.bad}/${ra.total} dead-end`, 'fill_after.svg'));
