// 量尺：自动河网里**每条段的水到底能不能到海**。
//
// 假说（来自叠图的视觉：短棍几乎都贴着海岸、内陆几乎没有长干流）：
//   绝大多数段是**内流死水**（水从高格流到某个洼地就停住），
//   而它们有汇流量（上游格数），所以 `flowWidthScale` 给了它们真实粗细 → 画出来就是"毛刺"。
//   叠图上"内陆没有长干流"正是因为**出得去的格子只是少数**。
//
// 判据：从每个段的终点沿 `receiver` 往下走，看能不能走到**海格**（h<seaLevel）。
// 用法：node scripts/tests/tools/_probe_river_reachability.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-re-'));
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
const mask = C.buildLandMask(bm.terrain);
const t = R.traceRivers(hm, { isLand: mask.lookup });

// 段自带 receiver？（先看字段，别假设）
const segs = t.segments || [];
console.log('== traceRivers 回执字段 ==');
console.log(Object.keys(t).join(', '));
console.log('segment[0] keys:', Object.keys(segs[0] || {}).join(', '));
console.log('segment[0]:', JSON.stringify(segs[0]));

// grid 定位
const g = hm.grid;
const cols = g.cellsX | 0, rows = g.cellsY | 0, sp = g.spacing || 14.4;
const p0 = g.points[0];
const x0 = Array.isArray(p0) ? p0[0] : p0.x, y0 = Array.isArray(p0) ? p0[1] : p0.y;
const idxOf = (x, y) => {
  const ci = Math.round((x - x0) / sp), cj = Math.round((y - y0) / sp);
  if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return -1;
  return cj * cols + ci;
};
const H = hm.h;
const isSea = (i) => !(Number(H[i]) >= SEA);

// 用"段终点的格"沿汇流关系往下走。段的 x1,y1 是 receiver 端（traceRivers 注释如此）
// → 先确认：x1,y1 那格的高度是否 ≤ x0,y0 那格（真下坡）
let downOk = 0, downBad = 0;
for (const s of segs) {
  const a = idxOf(s.x0, s.y0), b = idxOf(s.x1, s.y1);
  if (a < 0 || b < 0) continue;
  if (Number(H[b]) <= Number(H[a])) downOk++; else downBad++;
}
console.log(`\n段方向检查：x1 端更低 ${downOk} / 反而更高 ${downBad}`);

// 从每个段的终点格出发，能走到海吗？（用 traceRivers 的同样邻域规则重算下一步，
// 因为 segments 本身不带 receiver 索引）
const spacing = sp, factor = 1.5, R2 = (spacing * factor) ** 2;
const neighborsCache = new Map();
function nextOf(i) {
  if (neighborsCache.has(i)) return neighborsCache.get(i);
  const ci = i % cols, cj = (i / cols) | 0;
  const x = x0 + ci * sp, y = y0 + cj * sp;
  let best = -1, bestH = Number(H[i]);
  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni;
      if (!mask.lookup(x0 + ni * sp, y0 + nj * sp)) continue;   // 只走陆地
      const dx = di * sp, dy = dj * sp;
      if (dx * dx + dy * dy > R2 + 1e-6) continue;
      const h = Number(H[j2]);
      if (h < bestH) { bestH = h; best = j2; }
    }
  }
  neighborsCache.set(i, best);
  return best;
}

function reachesSea(start) {
  let cur = start, steps = 0;
  const seen = new Set();
  while (cur >= 0 && steps < 5000) {
    if (isSea(cur)) return { ok: true, steps };
    if (seen.has(cur)) return { ok: false, steps, why: 'cycle' };
    seen.add(cur);
    const nx = nextOf(cur);
    if (nx < 0) return { ok: false, steps, why: 'sink' };   // 没有更低的陆地邻居 = 洼地
    cur = nx; steps++;
  }
  return { ok: false, steps, why: 'too-long' };
}

let reach = 0, noReach = 0;
const why = {};
const reachLen = [], deadLen = [];
for (const s of segs) {
  const b = idxOf(s.x1, s.y1);
  if (b < 0) continue;
  const r = reachesSea(b);
  if (r.ok) { reach++; reachLen.push(r.steps); }
  else { noReach++; why[r.why] = (why[r.why] || 0) + 1; deadLen.push(r.steps); }
}
console.log(`\n== 段终点能不能到海 ==`);
console.log(`能到海 ${reach} / ${segs.length} = ${(reach / segs.length * 100).toFixed(1)}%`);
console.log(`🔴 到不了海 ${noReach} / ${segs.length} = ${(noReach / segs.length * 100).toFixed(1)}%  原因: ${JSON.stringify(why)}`);

// 段按 flow 分层看
const bins = [[1, 1], [2, 2], [3, 5], [6, 22]];
console.log(`\n== 按汇流量分层：到不了海的占比 ==`);
for (const [lo, hi] of bins) {
  const sub = segs.filter((s) => s.flow >= lo && s.flow <= hi);
  if (!sub.length) continue;
  let bad = 0;
  for (const s of sub) { const b = idxOf(s.x1, s.y1); if (b >= 0 && !reachesSea(b).ok) bad++; }
  console.log(`  flow ${lo}~${hi}: ${sub.length} 段，到不了海的 ${bad} (${(bad / sub.length * 100).toFixed(0)}%)`);
}
