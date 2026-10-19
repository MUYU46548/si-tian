// 路线 A 原型：**以 FMG 自带河为骨架，只补它没画到的地方**（排斥带），看结果好不好看。
//
// 前提核实（本脚本顺带做，修掉上一版端点心判的错）：
//   · FMG 的河**哪一端是河口**要按"离海最近的一端"判，不能假设 points 顺序。
//   · 判"能不能挂支流"要看折线的**悬挂端**（不接任何东西的那端）离别的河有多近。
//
// 产物：三张 PNG 对照（自带河 / 现状自动河 / A 方案：骨架+补支流）
// 用法：node scripts/tests/tools/_proto_backbone_graft.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-bg-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap, g = hm.grid;
const cols = g.cellsX, rows = g.cellsY, sp = g.spacing;
const p0 = g.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const H = hm.h;
const mask = C.buildLandMask(bm.terrain);
const isSeaPt = (x, y) => {
  const ci = Math.round((x - X0) / sp), cj = Math.round((y - Y0) / sp);
  if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return true;
  return (Number(H[cj * cols + ci]) || 0) < SEA;
};
const rivers = (bm.rivers || []).filter((r) => (r.points || []).length >= 2);

// ── ① 正确判"哪端是河口"：两端里离海更近的那端 ──
function seaDistOf(x, y) {
  // 用 BFS 海距场（格步）
  return seaDistField[Math.round((y - Y0) / sp) * cols + Math.round((x - X0) / sp)] ?? 999;
}
const seaDistField = new Int32Array(cols * rows).fill(-1);
{
  const q = [];
  for (let i = 0; i < cols * rows; i++) {
    const ci = i % cols, cj = (i / cols) | 0;
    if ((Number(H[i]) || 0) < SEA) { seaDistField[i] = 0; q.push(i); }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], ci = i % cols, cj = (i / cols) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni;
      if (seaDistField[j2] >= 0) continue;
      seaDistField[j2] = seaDistField[i] + 1; q.push(j2);
    }
  }
}
let mouthOk = 0;
const mouths = [];
for (const r of rivers) {
  const A = r.points[0], B = r.points[r.points.length - 1];
  const dA = seaDistField[Math.round((A.y - Y0) / sp) * cols + Math.round((A.x - X0) / sp)] ?? 999;
  const dB = seaDistField[Math.round((B.y - Y0) / sp) * cols + Math.round((B.x - X0) / sp)] ?? 999;
  const mouth = dA <= dB ? A : B;
  if (Math.min(dA, dB) <= 1) mouthOk++;
  mouths.push(mouth);
}
console.log(`FMG 河 ${rivers.length} 条：河口在贴海 1 格内的 ${mouthOk}（${(mouthOk / rivers.length * 100).toFixed(0)}%）`);

// ── ② 现状自动河网 ──
const traced = R.traceRivers(hm, { isLand: mask.lookup });
const autoSegs = traced.segments || [];
console.log(`现状自动河网 ${autoSegs.length} 段，segMaxFlow=${traced.segMaxFlow}`);

// ── ③ 排斥带：离 FMG 河太近的自动段**丢掉**（那些位置自带河已经画了）──
const CELL = 24;
const bgrid = new Map();
const put = (x, y) => {
  const k = Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
  let b = bgrid.get(k); if (!b) { b = []; bgrid.set(k, b); }
  b.push([x, y]);
};
for (const r of rivers) for (const p of r.points) put(p.x, p.y);
function distToBackbone(x, y) {
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
  let best = Infinity;
  for (let ring = 0; ring <= 3; ring++) {
    for (let a = ci - ring; a <= ci + ring; a++) for (let b = cj - ring; b <= cj + ring; b++) {
      if (ring > 0 && Math.abs(a - ci) !== ring && Math.abs(b - cj) !== ring) continue;
      const bucket = bgrid.get(a + ',' + b);
      if (!bucket) continue;
      for (const q of bucket) { const d = Math.hypot(q[0] - x, q[1] - y); if (d < best) best = d; }
    }
    if (best <= ring * CELL) break;
  }
  return best;
}
const band = 18;   // 排斥带宽度（世界单位）
const grafted = [];
for (const s of autoSegs) {
  const mx = (s.x0 + s.x1) / 2, my = (s.y0 + s.y1) / 2;
  if (distToBackbone(mx, my) <= band) continue;   // 自带河已经画了 → 不要重复
  grafted.push(s);
}
console.log(`排斥带 ${band} 单位：留下 ${grafted.length}/${autoSegs.length} 段（丢掉 ${autoSegs.length - grafted.length} 段与自带河重叠的）`);

// ── ④ 渲染三张对照 ──
const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });
const provPaths = (bm.terrain || []).map((tt) => {
  const pts = tt.points || []; if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');
const head = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">${t}</text>`;
const wOf = (r) => {
  const d = Number.isFinite(r.discharge) ? r.discharge : 1;
  const s = Math.max(Math.sqrt(Math.max(d, 1)) / 14, 0.6);
  return Math.max(0.7, Math.min(4, (r.width || 0.2) * 6 * s));
};
const segPx = (flow, mf) => {
  const t = Math.max(0, Math.min(1, (flow - 1) / Math.max(1, mf - 1)));
  const d = 36 + (613 - 36) * Math.sqrt(t);
  return Math.max(0.7, Math.min(4, 0.2 * 6 * Math.max(Math.sqrt(Math.max(d, 1)) / 14, 0.6)));
};
// ① 自带河
let a = head(`imported FMG (${rivers.length})`);
for (const r of rivers) a += `<polyline points="${r.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#5d97bb" stroke-width="${wOf(r).toFixed(2)}" stroke-linecap="round"/>`;
fs.writeFileSync(path.join(outDir, 'bk_imported.svg'), a + '</svg>');
// ② 现状自动河
let b = head(`CURRENT auto (${autoSegs.length} segs, maxFlow ${traced.segMaxFlow})`);
for (const s of autoSegs) b += `<line x1="${s.x0.toFixed(1)}" y1="${s.y0.toFixed(1)}" x2="${s.x1.toFixed(1)}" y2="${s.y1.toFixed(1)}" stroke="#5d97bb" stroke-width="${segPx(s.flow, traced.segMaxFlow).toFixed(2)}" stroke-linecap="round"/>`;
fs.writeFileSync(path.join(outDir, 'bk_current.svg'), b + '</svg>');
// ③ A 方案：骨架（粗、深）+ 补的支流（细、浅）
let c = head('ROUTE A: FMG backbone (thick) + grafted tributaries (thin)');
for (const r of rivers) c += `<polyline points="${r.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#3d7f9e" stroke-width="${(wOf(r) * 1.25).toFixed(2)}" stroke-linecap="round"/>`;
for (const s of grafted) c += `<line x1="${s.x0.toFixed(1)}" y1="${s.y0.toFixed(1)}" x2="${s.x1.toFixed(1)}" y2="${s.y1.toFixed(1)}" stroke="#5d97bb" stroke-width="${Math.max(0.55, segPx(s.flow, traced.segMaxFlow) * 0.8).toFixed(2)}" stroke-linecap="round"/>`;
fs.writeFileSync(path.join(outDir, 'bk_routeA.svg'), c + '</svg>');
console.log('\n写出：bk_imported.svg / bk_current.svg / bk_routeA.svg → ' + outDir);
