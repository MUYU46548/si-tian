// 一次性诊断：**河网形状**（树枝状？还是独立折线？）+ 各条河覆盖了哪些格子
// 用法：node scripts/tests/tools/dump_river_network.mjs <grid.json>
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

const [, , gridJson] = process.argv;
const SRC = path.resolve('src/renderer/src/utils');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-net-'));
for (const f of ['riverTrace.js', 'heightmapResample.js', 'coastline.js', 'gridSpatialIndex.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(SRC, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const g = JSON.parse(fs.readFileSync(gridJson, 'utf8'));
const hm = { h: g.h, grid: g.grid };
const H = g.h;
const mask = (g.landFeatures && g.landFeatures.length) ? C.buildLandMask(g.landFeatures) : null;

for (const sh of [60, 50, 40]) {
  const t = R.traceRivers(hm, mask ? { isLand: mask.lookup, sourceHeight: sh } : { sourceHeight: sh });  const cells = new Set();
  let pts = 0;
  for (const r of t.rivers) { pts += r.points.length; for (const p of r.points) cells.add(Math.round(p.x) + ',' + Math.round(p.y)); }
  const lenHist = {};
  for (const r of t.rivers) { const b = r.len <= 2 ? '2' : r.len <= 4 ? '3-4' : r.len <= 8 ? '5-8' : r.len <= 16 ? '9-16' : '17+'; lenHist[b] = (lenHist[b] || 0) + 1; }
  console.log(`源头高度 >${sh}: 河 ${t.rivers.length} 条 / 总点 ${pts} / 去重后覆盖 ${cells.size} 格 / 贴岸挡 ${t.coastSources}`);
  console.log(`   长度分布 ${JSON.stringify(lenHist)}`);
  // 关系：有多少条河的**路径**与别的河重叠（= 树枝状汇聚的证据）
  const seen = new Map();
  let overlapRivers = 0;
  for (const r of t.rivers) {
    let hit = 0;
    for (const p of r.points) { const k = Math.round(p.x) + ',' + Math.round(p.y); if (seen.has(k)) hit++; }
    if (hit > 0) overlapRivers++;
    for (const p of r.points) seen.set(Math.round(p.x) + ',' + Math.round(p.y), 1);
  }
  console.log(`   与其他河路径重叠的条数：${overlapRivers} / ${t.rivers.length}`);
  console.log(`   河网段（树枝状几何本体）：${t.segments.length} 段 / segMaxFlow=${t.segMaxFlow}`);
  // 🔴 内流盆地（到不了海的洼地）—— 用户问的「内流河」到底有没有数据基础
  const big = t.basins.filter((b) => b.cells >= 5);
  const land = H.filter((v) => v >= 20).length;
  console.log(`   内流：**${t.endorheicCells} 格**陆地水出不去`
    + `（占陆地 ${(100 * t.endorheicCells / Math.max(1, land)).toFixed(0)}%）；`
    + `盆地 ${t.basins.length} 个 / 面积和 ${t.basinCells} 格；`
    + `≥5 格的 ${big.length} 个`
    + (big.length ? `，最大三个 ${big.slice(0, 3).map((b) => `${b.cells}格(h${b.lowest})`).join(', ')}` : '（都是 1~4 格的微洼地）'));
}
