// 出图（纯 Node，无依赖）：v1（坡面+噪声）与 v2（山脉走向/高原面/裂谷）的**地形与水系**对照
// —— 给暮雨看的观感存档。本仓模型没有图像输入，所以判据在 `test_terrain_structure.js`，
//    这份 SVG 只负责"让人能一眼看到结构确实出来了"。
//
// 产物：docs/assets/terrain-structure-20261018/{v1,v2}-terrain.svg、{v1,v2}-rivers.svg
// 用法：node scripts/tests/tools/_render_terrain_structure.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const OUT = path.join(ROOT, 'docs', 'assets', 'terrain-structure-20261018');
const DEPS = ['terrainSynthesis.js', 'riverTrace.js', 'gridSpatialIndex.js', 'heightmapResample.js', 'polylineSmooth.js'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-tstruct-'));
for (const f of DEPS) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(SRC, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
const TS = await import(pathToFileURL(path.join(tmp, 'terrainSynthesis.js')).href);
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);

const SEA = 20, SCALE = 0.5;
const ring = [];
for (let i = 0; i < 120; i++) {
  const a = (i / 120) * Math.PI * 2;
  const w = 1 + Math.sin(a * 3 + 1.2) * 0.16 + Math.sin(a * 7 + 2.4) * 0.08;
  ring.push({ x: Math.cos(a) * 900 * w, y: Math.sin(a) * 900 * w * 0.72 });
}
const inside = (x, y) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) c = !c;
  }
  return c;
};

/** 分层设色（与产品 `heightmapRaster` 的 HYPSO 色带同一思路，这里够用即可） */
function hyps(h) {
  if (h < SEA) return '#16324f';
  const t = Math.max(0, Math.min(1, (h - SEA) / (100 - SEA)));
  const stops = [[0, [86, 132, 86]], [0.35, [150, 160, 96]], [0.6, [176, 148, 100]], [0.8, [150, 120, 96]], [1, [236, 236, 236]]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const u = (t - a) / (b - a);
      const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * u));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return '#ececec';
}

const seed = 7;
fs.mkdirSync(OUT, { recursive: true });
const notes = [];
for (const struct of [false, true]) {
  const tag = struct ? 'v2' : 'v1';
  const hm = TS.synthesizeHeightmapFromTerrain([{ rings: [ring] }], { isLand: inside, seed, structure: struct });
  const g = hm.grid, sp = g.spacing;
  let minX = Infinity, minY = Infinity;
  for (const p of g.points) { const x = Array.isArray(p) ? p[0] : p.x, y = Array.isArray(p) ? p[1] : p.y; if (x < minX) minX = x; if (y < minY) minY = y; }
  const W = Math.round(g.cellsX * sp * SCALE), H = Math.round(g.cellsY * sp * SCALE);
  const cell = sp * SCALE;
  const X = (x) => ((x - minX) * SCALE).toFixed(1);
  const Y = (y) => ((y - minY) * SCALE).toFixed(1);

  // 地形
  const rects = [];
  for (let j = 0; j < g.cellsY; j++) {
    for (let i = 0; i < g.cellsX; i++) {
      const idx = j * g.cellsX + i;
      rects.push(`<rect x="${(i * cell).toFixed(1)}" y="${(j * cell).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="${hyps(hm.h[idx])}"/>`);
    }
  }
  fs.writeFileSync(path.join(OUT, `${tag}-terrain.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="#0d1b2a"/>${rects.join('')}</svg>`);

  // 水系（按汇流量给线宽）
  const tr = R.traceRivers(hm, { isLand: inside });
  const maxF = Math.max(1, tr.segMaxFlow || 1);
  const paths = [];
  for (const s of tr.segments || []) {
    const w = (0.6 + 3.4 * Math.min(1, Math.log(1 + (s.flow || 1)) / Math.log(1 + maxF))).toFixed(2);
    paths.push(`<line x1="${X(s.x0)}" y1="${Y(s.y0)}" x2="${X(s.x1)}" y2="${Y(s.y1)}" stroke="#4aa3ff" stroke-width="${w}" stroke-linecap="round"/>`);
  }
  fs.writeFileSync(path.join(OUT, `${tag}-rivers.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="#0d1b2a"/>${paths.join('')}</svg>`);

  notes.push(`${tag}: 格 ${g.cellsX}×${g.cellsY} / 格距 ${sp.toFixed(2)} / 段 ${(tr.segments || []).length}`
    + ` / 汇流上界 ${Math.round(tr.segMaxFlow || 0)} / 源头 ${tr.sources}`
    + (hm.structure ? ` / 走向 ${hm.structure.rangeAxisDeg}° / 裂谷 ${hm.structure.rifts} 条` : ' / （对照：无结构）'));
}
fs.writeFileSync(path.join(OUT, 'README.md'),
  `# 推演地形结构对照（2026-10-18 第九修）\n\n`
  + `同一块陆地轮廓、同一个 seed=7，两种推演口径的**地形**与**水系**各出一张 SVG：\n\n`
  + `- \`v1-terrain.svg\` / \`v1-rivers.svg\`：旧口径（离岸坡面 + 三段旋转噪声）\n`
  + `- \`v2-terrain.svg\` / \`v2-rivers.svg\`：新口径（+ 山脉走向 / 高原面 / 裂谷）\n\n`
  + notes.map((n) => `- ${n}`).join('\n') + '\n\n'
  + `看图要点（与 \`scripts/tests/unit/test_terrain_structure.js\` 的数值判据对应）：\n`
  + `① 地形图：v2 应有**同一方向的骨状脊线**、一块**大面积同高的面**、以及 1~2 条**切穿它的窄沟**；\n`
  + `② 水系图：v2 的干流应明显更长、支流并进来的位置更靠上（最长主河实测 737u → 1645u）。\n\n`
  + `⚠️ 本仓模型没有图像输入：观感结论必须落成数值判据（那份 Node 单测），这几张图只供人看。\n`);
console.log('已出图：' + OUT);
for (const n of notes) console.log('  ' + n);
