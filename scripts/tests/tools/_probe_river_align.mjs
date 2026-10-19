// 量尺：自动河网 vs 地图自带河流（FMG 导入）的**几何重合度**。
//
// 为什么必须量这一条：用户第四条反馈是「依旧和底图自带河流**各画各的**」。
// 上一轮我只统一了**画法**（色/线宽），没有量**几何**。要决定"能不能只画一套"，
// 必须先知道两套河到底是不是同一条河：
//   · 若自动河大部分落在自带河的**笔画覆盖范围内**（自带河线宽 p50 仅 0.70px，
//     但 FMG 的河本身是一条贴着地形走的折线）→ 两者是同一条河 → 可以只画一套；
//   · 若大量自动段离自带河很远 → 它们是**不同的水系**（自动河在自带河没画的山谷里），
//     那就**不能**悄悄隐藏自带河（会丢掉用户原来的河）。
//
// 用法：node scripts/tests/tools/_probe_river_align.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-al-'));
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
const r = R.traceRivers(hm, { isLand: mask.lookup });
const segs = r.segments || [];
const imported = (bm.rivers || []).filter((x) => x && (x.points || []).length >= 2);

// ── 自带河的点集 + 均匀网格加速（世界单位 ≈ 屏幕像素 @zoom=1；地图约 1920×1080）──
const PTS = [];
for (const rv of imported) for (const p of rv.points) PTS.push([p.x, p.y]);
const CELL = 20;   // 网格边长（世界单位）
const grid = new Map();
for (let i = 0; i < PTS.length; i++) {
  const k = Math.floor(PTS[i][0] / CELL) + ',' + Math.floor(PTS[i][1] / CELL);
  let b = grid.get(k); if (!b) { b = []; grid.set(k, b); }
  b.push(i);
}
/** 点到最近自带河**顶点**的距离（顶点间距约 1 格 ≈ 3~4 世界单位，够用） */
function nearestImported(x, y) {
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
  let best = Infinity;
  for (let ring = 1; ring <= 6; ring++) {          // 逐环扩大；找到就够（ring*CELL 已 > 容差）
    for (let a = ci - ring; a <= ci + ring; a++) {
      for (let b = cj - ring; b <= cj + ring; b++) {
        if (ring > 1 && Math.abs(a - ci) !== ring && Math.abs(b - cj) !== ring) continue;  // 只扫边框
        const bucket = grid.get(a + ',' + b);
        if (!bucket) continue;
        for (const idx of bucket) {
          const d = Math.hypot(PTS[idx][0] - x, PTS[idx][1] - y);
          if (d < best) best = d;
        }
      }
    }
    if (best <= ring * CELL) break;                // 已不可能更近
  }
  return best;
}

// ── 自动段的中点到自带河的距离分布 ──
const dists = [];
for (const s of segs) {
  const mx = (s.x0 + s.x1) / 2, my = (s.y0 + s.y1) / 2;
  dists.push(nearestImported(mx, my));
}
dists.sort((a, b) => a - b);
const q = (p) => dists[Math.min(dists.length - 1, Math.round((dists.length - 1) * p))];
const within = (t) => dists.filter((d) => d <= t).length;

console.log('== 自动河网段到「自带河」的最近距离（世界单位 ≈ 屏幕像素 @zoom=1）==');
console.log(`段数 ${segs.length}，自带河 ${imported.length} 条 / ${PTS.length} 个顶点`);
console.log(`距离分位: min=${q(0).toFixed(2)} p25=${q(0.25).toFixed(2)} p50=${q(0.5).toFixed(2)} p75=${q(0.75).toFixed(2)} p90=${q(0.9).toFixed(2)} max=${q(1).toFixed(2)}`);
console.log(`平均 ${(dists.reduce((a, b) => a + b, 0) / dists.length).toFixed(2)}`);
for (const t of [1, 2, 3, 5, 8, 12, 20]) {
  const n = within(t);
  console.log(`  距自带河 ≤ ${String(t).padStart(2)} : ${String(n).padStart(5)} 段 = ${(n / segs.length * 100).toFixed(1)}%`);
}

// ── 反向：自带河顶点离最近的自动段多远（自动河有没有覆盖自带河）──
const segGrid = new Map();
const put = (k, v) => { let b = segGrid.get(k); if (!b) { b = []; segGrid.set(k, b); } b.push(v); };
for (let i = 0; i < segs.length; i++) {
  const s = segs[i];
  put(Math.floor(s.x0 / CELL) + ',' + Math.floor(s.y0 / CELL), i);
  put(Math.floor(s.x1 / CELL) + ',' + Math.floor(s.y1 / CELL), i);
}
function distPtSeg(px, py, s) {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - s.x0) * dx + (py - s.y0) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.x0 + t * dx), py - (s.y0 + t * dy));
}
function nearestAuto(x, y) {
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
  let best = Infinity;
  for (let ring = 0; ring <= 4; ring++) {
    for (let a = ci - ring; a <= ci + ring; a++) {
      for (let b = cj - ring; b <= cj + ring; b++) {
        if (ring > 0 && Math.abs(a - ci) !== ring && Math.abs(b - cj) !== ring) continue;
        const bucket = segGrid.get(a + ',' + b);
        if (!bucket) continue;
        for (const i of bucket) { const d = distPtSeg(x, y, segs[i]); if (d < best) best = d; }
      }
    }
    if (best <= ring * CELL) break;
  }
  return best;
}
const inv = PTS.map(([x, y]) => nearestAuto(x, y)).sort((a, b) => a - b);
const qi = (p) => inv[Math.min(inv.length - 1, Math.round((inv.length - 1) * p))];
console.log('\n== 自带河顶点到最近「自动河段」的距离 ==');
console.log(`距离分位: p50=${qi(0.5).toFixed(2)} p75=${qi(0.75).toFixed(2)} p90=${qi(0.9).toFixed(2)} max=${qi(1).toFixed(2)}`);
for (const t of [2, 3, 5, 8]) {
  const n = inv.filter((d) => d <= t).length;
  console.log(`  距自动河 ≤ ${t} : ${n}/${inv.length} = ${(n / inv.length * 100).toFixed(1)}% 的自带河顶点附近有自动河`);
}
console.log('\n判读口径：若「≤3」的比例很高（双侧都高）→ 两套河在走同一条水系 → 可只画一套；');
console.log('          若一侧低 → 自动河在自带河没画的山谷里跑 → 不能悄悄隐藏自带河。');
