// 闸门扫描：同一张 256 格底图上，把 minFlux 从 120 拉到 4800，看“中位格数 / 短河占比 / 河数”怎么变。
// 目的：验证“密度闸门必须随分辨率重新标定”这条结论（P1 审计的补充）。
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const R = await import(pathToFileURL(path.join(UTILS, 'fmg', 'rivers.js')).href);
const TS = await import(pathToFileURL(path.join(UTILS, 'terrainSynthesis.js')).href);
const C = await import(pathToFileURL(path.join(UTILS, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync('<用户目录>/Documents/SiTianProjects/示例项目.sitian', 'utf8'));
const terrain = j.scenarios.baseMaps.desite.terrain.filter((t) => t && t.kind !== 'sea' && Array.isArray(t.points));
const mask = C.buildLandMask(terrain);
const hm = TS.synthesizeHeightmapFromTerrain(terrain, { cellsAcross: 256, seed: 7, isLand: mask.lookup });
console.log(`256 格：${hm.grid.cellsX}×${hm.grid.cellsY} / 陆 ${hm.landCells} 格`);

for (const mf of [120, 240, 480, 960, 1920, 3840]) {
  const t0 = Date.now();
  const out = R.buildRiverNetwork(hm, { minFlux: mf });
  const lens = out.rivers.map((r) => r.cells.length).sort((a, b) => a - b);
  const q = (p) => (lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] : 0);
  const short = out.rivers.filter((r) => r.cells.length <= 4).length;
  const L = out.rivers.map((r) => r.length).sort((a, b) => a - b);
  console.log(`minFlux ${String(mf).padStart(4)} → 河 ${String(out.rivers.length).padStart(4)} 条 / 中位 ${q(0.5)} 格 / p90 ${q(0.9)} / ≤4格 ${(short / Math.max(1, out.rivers.length) * 100).toFixed(0)}% / 长度中位 ${Math.round(L[Math.floor(L.length / 2)] || 0)} / 最高 ${out.stats.maxOrder} 级 / ${Date.now() - t0}ms`);
}
