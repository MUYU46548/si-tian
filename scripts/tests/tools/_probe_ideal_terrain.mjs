// 对照实验：在一张**理想地形**上追水，看算法本身是不是"放射状"的。
//
// 为什么要这个实验：用户在真实底图上勾了平滑，仍然说"比支气管还恐怖、生理不适"，
// 而我上一轮只量到"最长河 140→270"（≈2 倍）就以为方向对了 —— 说明我**没有先验证算法本身**。
// 理想地形上正确答案是已知的：
//   · 圆锥岛（高度随离岛心距离单调下降）→ 水应当**径向汇入最外圈**，
//     但**每一条流路本身应当是一条长而连续的线**，且**越靠下游流量越大**（树枝状汇合）。
//   · 若出来的是"一堆等长的短刺、主干不长"，那就是**接收者选取口径**的问题，不是地形的锅。
//
// 用法：node scripts/tests/tools/_probe_ideal_terrain.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ideal-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);

/** 造格网：hFn(c,r) 返回高度 */
function makeGrid(cols, rows, spacing, hFn) {
  const points = new Array(cols * rows), h = new Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    points[i] = [c * spacing, r * spacing];
    h[i] = hFn(c, r);
  }
  return { h, grid: { points, spacing, cellsX: cols, cellsY: rows } };
}

const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });

function render(trace, title, file, W, H, spacing) {
  const segs = trace.segments || [];
  const mf = trace.segMaxFlow || 1;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#dfd0a8"/>`;
  for (const sg of segs) {
    const t = Math.max(0, Math.min(1, (sg.flow - 1) / Math.max(1, mf - 1)));
    const px = 0.8 + 3.4 * Math.sqrt(t);
    s += `<line x1="${sg.x0.toFixed(1)}" y1="${sg.y0.toFixed(1)}" x2="${sg.x1.toFixed(1)}" y2="${sg.y1.toFixed(1)}" stroke="#3b82f6" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
  }
  s += `<text x="10" y="20" font-size="15" font-family="sans-serif">${title}</text></svg>`;
  fs.writeFileSync(path.join(outDir, file), s);
}

function stats(name, trace) {
  const segs = trace.segments || [];
  const rivers = trace.rivers || [];
  const lens = rivers.map((r) => {
    let L = 0; const p = r.points || [];
    for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
    return L;
  }).sort((a, b) => a - b);
  const fl = segs.map((s) => s.flow).sort((a, b) => a - b);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.round((a.length - 1) * p))] : 0);
  console.log(`\n== ${name} ==`);
  console.log(`  段 ${segs.length} / 代表路径 ${rivers.length} / 源头 ${trace.sources}`);
  console.log(`  代表路径长度: p50=${q(lens, 0.5).toFixed(0)} max=${q(lens, 1).toFixed(0)}（世界单位）`);
  console.log(`  段汇流量 flow: p50=${q(fl, 0.5)} p90=${q(fl, 0.9)} max=${q(fl, 1)}`);
  console.log(`  → flow>2 的段占比 ${(segs.filter((s) => s.flow > 2).length / Math.max(1, segs.length) * 100).toFixed(1)}%`
    + `（树枝状汇合的证据：主干段应当少而粗，支流多而细）`);
  return { segs: segs.length, rivers: rivers.length, maxLen: q(lens, 1) };
}

// ── ① 圆锥岛：高度随离岛心距离单调下降，最外圈是海 ──
const N = 80, SP = 14.4;
const R0 = 32;                     // 岛半径（格）
const cone = makeGrid(N, N, SP, (c, r) => {
  const d = Math.hypot(c - N / 2, r - N / 2);
  if (d > R0) return 0;            // 海
  return (R0 - d) * 3;             // 单调下降的锥
});
const coneT = R.traceRivers(cone);
const cs = stats('① 圆锥岛（正确答案：径向汇入最外圈，主流程长且越下游越粗）', coneT);
render(coneT, `cone island ${N}x${N} — segs ${cs.segs}, longest path ${cs.maxLen.toFixed(0)}`, 'ideal_cone.svg', N * SP, N * SP, SP);

// ── ② 半个圆锥 + 一条"谷"：谷里应当形成一条明显的主干 ──
const valley = makeGrid(N, N, SP, (c, r) => {
  const d = Math.hypot(c - N / 2, r - N / 2);
  if (d > R0) return 0;
  const cone0 = (R0 - d) * 3;
  const trench = Math.exp(-((r - N / 2) ** 2) / (2 * 6 ** 2)) * 18;   // 东西向的谷
  return Math.max(0, cone0 - trench);
});
const valleyT = R.traceRivers(valley);
const vs = stats('② 圆锥 + 东西向谷（正确答案：谷底应当长出一条明显主干）', valleyT);
render(valleyT, `cone + trench — segs ${vs.segs}, longest path ${vs.maxLen.toFixed(0)}`, 'ideal_trench.svg', N * SP, N * SP, SP);

console.log('\n写出：');
for (const f of ['ideal_cone.svg', 'ideal_trench.svg']) console.log('  ' + path.join(outDir, f));
console.log('\n判读：若圆锥岛的"代表路径"普遍很短（远小于 R0*SP=460）、且 flow>2 的段极少，');
console.log('      说明**接收者口径让水一格就找到最近的出海口**，而不是沿谷逐级汇流 → 算法本身的偏置。');
