// 量尺：两套河各自**跟不跟地形谷底**。
//
// 上一支量尺证明了「自动河与自带河不是同一条河」（中位差 18.78 世界单位 ≈ 1.3 格）。
// 但"不一样"不等于"我错"——也可能是 FMG 的河本来就没严格走这片高度图的谷。
// 判据取两条，**两套河同一把尺子**：
//   ① 低估度：把河上每个点换成它所在格的**格心高度**，看它相对邻域有多低
//      （`h邻域均值 - h格心`，越大越"在谷底"）；
//   ② 坡降：河里相邻点的高度差是否 ≤ 0（水不往上流）。
// ⚠️ 这条尺子是**产品自己的地形**，不是我的口算。
//
// 用法：node scripts/tests/tools/_probe_river_valley.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-vl-'));
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
const gx = (p) => (Array.isArray(p) ? p[0] : p.x);
const gy = (p) => (Array.isArray(p) ? p[1] : p.y);
const x0 = gx(g.points[0]), y0 = gy(g.points[0]);
const H = hm.h;
const idxOf = (x, y) => {
  const ci = Math.round((x - x0) / sp), cj = Math.round((y - y0) / sp);
  if (ci < 1 || ci >= cols - 1 || cj < 1 || cj >= rows - 1) return -1;   // 要 3×3 邻域
  return cj * cols + ci;
};
/** 谷底度：邻域(3×3)均值 − 本格。正数 = 本格比周围低（在谷里） */
function valleyScore(i) {
  const ci = i % cols, cj = (i / cols) | 0;
  let sum = 0, n = 0;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    if (!a && !b) continue;
    sum += Number(H[(cj + b) * cols + (ci + a)]) || 0; n++;
  }
  return sum / n - (Number(H[i]) || 0);
}

function report(name, polylines) {
  const scores = [], drops = [], rises = [];
  let ptsInGrid = 0, ptsTotal = 0;
  for (const line of polylines) {
    let prevH = null;
    for (const [x, y] of line) {
      ptsTotal++;
      const i = idxOf(x, y);
      if (i < 0) { prevH = null; continue; }
      ptsInGrid++;
      scores.push(valleyScore(i));
      const h = Number(H[i]) || 0;
      if (prevH != null) { if (h < prevH) drops.push(prevH - h); else if (h > prevH) rises.push(h - prevH); }
      prevH = h;
    }
  }
  scores.sort((a, b) => a - b);
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.round((arr.length - 1) * p))] : NaN);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  console.log(`\n== ${name} ==`);
  console.log(`点在格内 ${ptsInGrid}/${ptsTotal}（${(ptsInGrid / ptsTotal * 100).toFixed(1)}%）`);
  console.log(`谷底度（邻域均值 − 本格，正=在谷里）: mean=${mean.toFixed(2)} p25=${q(scores, 0.25).toFixed(2)} p50=${q(scores, 0.5).toFixed(2)} p75=${q(scores, 0.75).toFixed(2)}`);
  console.log(`  在谷里（score>0）的点: ${scores.filter((s) => s > 0).length}/${scores.length} = ${(scores.filter((s) => s > 0).length / (scores.length || 1) * 100).toFixed(1)}%`);
  console.log(`相邻点：下降 ${drops.length} 次（均值 ${(drops.reduce((a, b) => a + b, 0) / (drops.length || 1)).toFixed(2)}） / **上升 ${rises.length} 次**（均值 ${(rises.reduce((a, b) => a + b, 0) / (rises.length || 1)).toFixed(2)}）`);
  console.log(`  上升占比 ${(rises.length / (drops.length + rises.length || 1) * 100).toFixed(1)}%`);
  return { mean, posShare: scores.filter((s) => s > 0).length / (scores.length || 1), riseShare: rises.length / (drops.length + rises.length || 1) };
}

// 自带河（FMG）：注意它的点**不在格心上**，是插值出来的几何 → 用 idxOf 取最近格心
const imported = (bm.rivers || []).filter((r) => (r.points || []).length >= 2)
  .map((r) => r.points.map((p) => [p.x, p.y]));
const a = report('地图自带河流（FMG 导入，160 条）', imported);

// 自动河网段：每段的两个端点各自当一条"线段"
const traced = R.traceRivers(hm, { isLand: C.buildLandMask(bm.terrain).lookup });
const segs = traced.segments || [];
const autoLines = segs.map((s) => [[s.x0, s.y0], [s.x1, s.y1]]);
const b = report('自动河网（段，' + segs.length + ' 段）', autoLines);

console.log('\n== 判读 ==');
console.log(`谷底度均值：自带 ${a.mean.toFixed(2)} vs 自动 ${b.mean.toFixed(2)} → ${b.mean >= a.mean ? '自动**更贴谷底**' : '自带更贴谷底'}`);
console.log(`在谷里比例：自带 ${(a.posShare * 100).toFixed(1)}% vs 自动 ${(b.posShare * 100).toFixed(1)}%`);
console.log(`往上流比例：自带 ${(a.riseShare * 100).toFixed(1)}% vs 自动 ${(b.riseShare * 100).toFixed(1)}%（自动河的设计不变量是"严格更低"）`);
