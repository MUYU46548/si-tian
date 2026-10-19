// 诊断：那些「到不了海」的终点格，**邻域到底长什么样**。
//
// 上一次原型（填洼）失败了：只抬高 194 格、死水反而从 42.8% 升到 45.3%。
// → 说明"没有出口的洼地"不是主因。这次直接看现场：把若干个 sink 格的 5×5 邻域
//   高度打出来，看它为什么找不到更低的陆地邻居。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-sk-'));
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
const p0 = g.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const H = hm.h;
const mask = C.buildLandMask(bm.terrain);
const X = (i) => X0 + (i % cols) * sp;
const Y = (i) => Y0 + ((i / cols) | 0) * sp;
const isLand = (i) => mask.lookup(X(i), Y(i)) && (Number(H[i]) || 0) >= SEA;

const t = R.traceRivers(hm, { isLand: mask.lookup });
const segs = t.segments || [];

// 重现 nextOf 的口径（与 riverTrace 同规则：半径 spacing*1.5、只走陆地、严格更低）
const R2 = (sp * 1.5) ** 2;
function nextOf(i) {
  const ci = i % cols, cj = (i / cols) | 0;
  let best = -1, bestH = Number(H[i]);
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    if (!di && !dj) continue;
    const ni = ci + di, nj = cj + dj;
    if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
    const j2 = nj * cols + ni;
    if (!isLand(j2)) continue;
    if (di * di * sp * sp + dj * dj * sp * sp > R2 + 1e-6) continue;
    const h = Number(H[j2]);
    if (h < bestH) { bestH = h; best = j2; }
  }
  return best;
}
function terminalOf(start) {
  let cur = start, steps = 0; const seen = new Set();
  while (cur >= 0 && steps < 8000) {
    if (!isLand(cur)) return { kind: 'sea', cur, steps };
    if (seen.has(cur)) return { kind: 'cycle', cur, steps };
    seen.add(cur);
    const nx = nextOf(cur);
    if (nx < 0) return { kind: 'sink', cur, steps };
    cur = nx; steps++;
  }
  return { kind: 'long', cur, steps };
}

// 收集 sink 终点（去重）
const sinks = new Map();
for (const s of segs) {
  const ci = Math.round((s.x1 - X0) / sp), cj = Math.round((s.y1 - Y0) / sp);
  if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) continue;
  const r = terminalOf(cj * cols + ci);
  if (r.kind === 'sink') sinks.set(r.cur, (sinks.get(r.cur) || 0) + 1);
}
console.log(`不同的 sink 格 ${sinks.size} 个（共 ${[...sinks.values()].reduce((a, b) => a + b, 0)} 段落在 sink 上）`);

// 按"被多少段踩中"排序，看最典型的现场
const top = [...sinks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
for (const [i, n] of top) {
  const ci = i % cols, cj = (i / cols) | 0;
  console.log(`\n=== sink 格 #${i} (col ${ci}, row ${cj}) 被 ${n} 段踩中，自身 h=${H[i]} ===`);
  for (let dj = -2; dj <= 2; dj++) {
    let line = '';
    for (let di = -2; di <= 2; di++) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) { line += '  ----  '; continue; }
      const j2 = nj * cols + ni;
      const sea = !isLand(j2);
      const mark = (di === 0 && dj === 0) ? '*' : ' ';
      line += `${mark}${sea ? 'SEA' : String(H[j2]).padStart(4)}${sea ? ' ' : ' '}`;
    }
    console.log('  ' + line);
  }
  // 半径内到底有没有更低的陆地格 / 有没有海
  const ci0 = ci, cj0 = cj;
  let lowerLand = 0, seaInRadius = 0, lowerAny = 0;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    if (!di && !dj) continue;
    const ni = ci0 + di, nj = cj0 + dj;
    if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
    if (di * di * sp * sp + dj * dj * sp * sp > R2 + 1e-6) continue;
    const j2 = nj * cols + ni;
    if (!isLand(j2)) seaInRadius++;
    else if (Number(H[j2]) < Number(H[i])) lowerLand++;
    if (Number(H[j2]) < Number(H[i])) lowerAny++;
  }
  console.log(`  → 半径内: 更低的陆地格 ${lowerLand} 个, 海格 ${seaInRadius} 个, 更低的任意格 ${lowerAny} 个`);
}

// 全局统计：sink 格离最近的海有多远
let distHist = { '0': 0, '1': 0, '2': 0, '3-5': 0, '6-10': 0, '>10': 0 };
for (const i of sinks.keys()) {
  const ci = i % cols, cj = (i / cols) | 0;
  let best = Infinity;
  for (let dj = -12; dj <= 12; dj++) for (let di = -12; di <= 12; di++) {
    const ni = ci + di, nj = cj + dj;
    if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
    if (!isLand(nj * cols + ni)) { const d = Math.round(Math.hypot(di, dj)); if (d < best) best = d; }
  }
  const k = best === 0 ? '0' : best === 1 ? '1' : best === 2 ? '2' : best <= 5 ? '3-5' : best <= 10 ? '6-10' : '>10';
  distHist[k] = (distHist[k] || 0) + 1;
}
console.log(`\n== sink 格到最近海格的"格距"分布 ==`);
for (const k of ['0', '1', '2', '3-5', '6-10', '>10']) console.log(`  ${k.padStart(5)}: ${distHist[k] || 0}`);
