// 路线 A 可行性核实：160 条 FMG 河**是不是一棵能挂支流的树**（端点在不在海里 / 彼此接不接得上）。
import fs from 'fs';

const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const rivers = (bm.rivers || []).filter((r) => (r.points || []).length >= 2);
const hm = bm.heightmap;
const g = hm.grid;
const cols = g.cellsX, rows = g.cellsY, sp = g.spacing;
const p0 = g.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const H = hm.h;
const idxOf = (x, y) => {
  const ci = Math.round((x - X0) / sp), cj = Math.round((y - Y0) / sp);
  if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return -1;
  return cj * cols + ci;
};
const isSea = (x, y) => { const i = idxOf(x, y); return i < 0 ? true : (Number(H[i]) || 0) < 20; };

console.log(`FMG 河 ${rivers.length} 条，总顶点 ${rivers.reduce((a, r) => a + r.points.length, 0)}`);
console.log(`discharge 分位: min=${Math.min(...rivers.map(r => r.discharge || 0))} max=${Math.max(...rivers.map(r => r.discharge || 0))}`);

// ① 端点在海里的河有多少（河口）
let mouthInSea = 0, headInSea = 0;
const mouthPts = [], headPts = [];
for (const r of rivers) {
  const pts = r.points;
  const A = pts[0], B = pts[pts.length - 1];
  // FMG 的 points 顺序：通常是「上游→下游」，但两种都认
  const aSea = isSea(A.x, A.y), bSea = isSea(B.x, B.y);
  if (aSea || bSea) mouthInSea++;
  if (aSea) mouthPts.push({ x: A.x, y: A.y });
  if (bSea) mouthPts.push({ x: B.x, y: B.y });
  const head = aSea ? B : A;
  headPts.push({ x: head.x, y: head.y });
}
console.log(`\n== 河口 / 源头 ==`);
console.log(`  至少一端在海里的河: ${mouthInSea}/${rivers.length}（${(mouthInSea / rivers.length * 100).toFixed(0)}%）`);

// ② 源头端能不能接到**另一条河**上（= 是不是树的一级支流）
const CELL = 20;
const grid = new Map();
rivers.forEach((r, ri) => {
  for (const p of r.points) {
    const k = Math.floor(p.x / CELL) + ',' + Math.floor(p.y / CELL);
    let b = grid.get(k); if (!b) { b = []; grid.set(k, b); }
    b.push({ ri, x: p.x, y: p.y });
  }
});
function nearestOther(x, y, selfRi) {
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
  let best = Infinity, other = -1;
  for (let ring = 1; ring <= 4; ring++) {
    for (let a = ci - ring; a <= ci + ring; a++) for (let b = cj - ring; b <= cj + ring; b++) {
      if (ring > 1 && Math.abs(a - ci) !== ring && Math.abs(b - cj) !== ring) continue;
      const bucket = grid.get(a + ',' + b);
      if (!bucket) continue;
      for (const q of bucket) {
        if (q.ri === selfRi) continue;
        const d = Math.hypot(q.x - x, q.y - y);
        if (d < best) { best = d; other = q.ri; }
      }
    }
    if (best <= ring * CELL) break;
  }
  return { d: best, ri: other };
}
let headNearOther = 0, headNearSea = 0;
const dists = [];
for (let ri = 0; ri < rivers.length; ri++) {
  const h = headPts[ri];
  const near = nearestOther(h.x, h.y, ri);
  dists.push(near.d);
  if (near.d <= CELL) headNearOther++;
  if (isSea(h.x, h.y)) headNearSea++;
}
dists.sort((a, b) => a - b);
const q = (p) => dists[Math.min(dists.length - 1, Math.round((dists.length - 1) * p))];
console.log(`\n== 源头端到"另一条河"的距离（世界单位）==`);
console.log(`  p25=${q(0.25).toFixed(1)} p50=${q(0.5).toFixed(1)} p75=${q(0.75).toFixed(1)} max=${q(1).toFixed(1)}`);
console.log(`  源头端落在离另一条河 ${CELL} 单位内的: ${headNearOther}/${rivers.length}`);
console.log(`  源头端本身就在海里的（异常）: ${headNearSea}`);

// ③ 结论性判断
console.log(`\n== 判读 ==`);
if (mouthInSea / rivers.length > 0.8 && headNearOther / rivers.length > 0.5) {
  console.log(`  ✅ **大部分河有入海口、且源头端接得上别的河 → 是一棵可以挂支流的树**：路线 A（骨架加密）可行。`);
} else if (mouthInSea / rivers.length > 0.8) {
  console.log(`  🟡 大部分河有入海口，但源头端彼此较远（像"各自独立的扇"）→ 仍可挂支流，但树形较弱。`);
} else {
  console.log(`  🔴 大量河没有入海口 → 自带河本身是断片，路线 A 的前提不成立，需要换思路。`);
}
