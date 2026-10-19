// 诊断：真实底图的高度场"地形质量"怎么样，以及为什么它追不出长河。
//
// 对照实验（`_probe_ideal_terrain.mjs`）证明**算法本身没问题**：
//   理想圆锥岛上代表路径中位 265 单位（岛半径 460）、80.6% 的段 flow>2（真树枝状汇流）。
// 所以问题在**这份高度场**。这里量三个指标：
//   ① 微洼地密度：有多少陆格的"没有更低邻居"（= 水一格就停）
//   ② 局部起伏：邻域高度差有多大（起伏太小 → 流向是噪声决定的）
//   ③ 与**放大后**的网格对比（`upsample=2` 的格距只有 7.2，会不会反而更好）
// 用法：node scripts/tests/tools/_probe_terrain_quality.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-tq-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);
const RES = await import(pathToFileURL(path.join(tmp, 'heightmapResample.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap;
const mask = C.buildLandMask(bm.terrain);

/** 对一张高度图量"地形质量" */
function terrainQuality(name, H, grid, isLandAt) {
  const cols = grid.cellsX | 0, rows = grid.cellsY | 0, sp = grid.spacing || 14.4;
  const n = cols * rows;
  const isLand = (i) => (Number(H[i]) || 0) >= 20;
  // ① 没有更低邻居的陆地格（半径 = 1 格，即 4/8 邻域）
  let land = 0, pit = 0, flat = 0;
  let riseSum = 0, riseN = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (!isLand(i)) continue;
    land++;
    let lower = 0, same = 0, hi = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = c + di, nj = r + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni;
      if (!isLand(j2)) continue;                      // 只看陆地邻居（与 riverTrace 同口径）
      const d = (Number(H[j2]) || 0) - (Number(H[i]) || 0);
      if (d < -1e-9) lower++;
      else if (Math.abs(d) <= 1e-9) same++;
      if (d > 0) { riseSum += d; riseN++; }
    }
    if (lower === 0) pit++;
    if (lower === 0 && same > 0) flat++;
  }
  // ② 邻域起伏（梯度）
  let gradSum = 0, gradN = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    const i = r * cols + c, j2 = i + 1;
    if (!isLand(i) || !isLand(j2)) continue;
    gradSum += Math.abs((Number(H[j2]) || 0) - (Number(H[i]) || 0)); gradN++;
  }
  console.log(`\n== ${name} ==`);
  console.log(`  格 ${cols}×${rows}，格距 ${sp}，陆地格 ${land}`);
  console.log(`  🔴 没有更低陆地邻居的格（水一格就停）：${pit} = ${(pit / Math.max(1, land) * 100).toFixed(1)}%`);
  console.log(`     其中还有"等高邻居"（平地）：${flat}`);
  console.log(`  水平相邻格的高度差均值：${(gradSum / Math.max(1, gradN)).toFixed(2)}`);
  console.log(`  邻居高度差（正=上坡）均值：${(riseSum / Math.max(1, riseN)).toFixed(2)}`);
}

terrainQuality('原始高度图（现状）', hm.h, hm.grid, null);
const sm = RES.smoothHeightmapGrid(hm, { radius: 2, passes: 1 });
terrainQuality('平滑 r=2 p=1 后', sm.heightmap.h, hm.grid, null);
const up2 = RES.resampleHeightmap(hm, 2);
if (up2.ok) terrainQuality('放大 ×2 后（格距 7.2）', up2.heightmap.h, up2.heightmap.grid, null);
const up2sm = RES.smoothHeightmapGrid(up2.heightmap, { radius: 2, passes: 1 });
terrainQuality('放大 ×2 + 平滑 r=2', up2sm.heightmap.h, up2.heightmap.grid, null);

// 追踪对照：真实读数
function longest(t) {
  let m = 0;
  for (const rv of (t.rivers || [])) {
    let L = 0; const p = rv.points || [];
    for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
    if (L > m) m = L;
  }
  return m;
}
console.log('\n== 追踪对照（真实底图）==');
for (const [label, opts] of [
  ['现状', {}],
  ['平滑 r=2 p=1', { smoothRadius: 2, smoothPasses: 1 }],
  ['放大 ×2', { upsample: 2 }],
  ['放大 ×2 + 平滑 r=2 p=2', { upsample: 2, smoothRadius: 2, smoothPasses: 2 }],
  ['放大 ×3 + 平滑 r=2 p=2', { upsample: 3, smoothRadius: 2, smoothPasses: 2 }],
]) {
  const t = R.traceRivers(hm, { isLand: mask.lookup, ...opts });
  const fl = (t.segments || []).map((s) => s.flow).sort((a, b) => a - b);
  const q = (p) => (fl.length ? fl[Math.min(fl.length - 1, Math.round((fl.length - 1) * p))] : 0);
  console.log(`  ${label.padEnd(24)} 段 ${String((t.segments || []).length).padStart(6)} `
    + `最长 ${longest(t).toFixed(0).padStart(5)} 代表路径 ${String((t.rivers || []).length).padStart(4)} `
    + `flow>2 占比 ${(fl.filter((f) => f > 2).length / Math.max(1, fl.length) * 100).toFixed(1).padStart(5)}%`);
}
