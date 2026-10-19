// `.map` 里那几条 9975 长的数组（data[1..5]）分别是什么，以及**有没有比 cells.h 更好的择路面**。
//
// 已确认：**没有任何一条是浮点** —— 全是整数、全是 9975 格。所以"更高精度的高程"在这份文件里不存在。
// 但 data[5]（值域 -40~19）形态可疑，像是"相对深度/到水面的高度差"，可能比 cells.h 更细。
// 本脚本：① 打印每条数组的分布与"不同值个数"（量化程度）；② 把候选当**择路面**跑汇流，看上限。
// 用法：node scripts/tests/tools/_probe_alt_surface.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const MAP = 'E:/CODE/CangKu/SiTian/backups/repair-basemap-20261011-220317/desite.map';
const SEA = 20;

// ── 读 .map 的 data[1..5] ──
const lines = fs.readFileSync(MAP, 'utf8').split(/\r?\n/);
let gi = -1;
for (let i = 0; i < lines.length; i++) {
  const s = lines[i];
  if (s && s[0] === '{' && s.indexOf('"cellsX"') !== -1 && s.indexOf('"points"') !== -1) { gi = i; break; }
}
const gridRaw = JSON.parse(lines[gi]);
const data = {};
for (let k = 1; k <= 5; k++) data[k] = lines[gi + k].split(',').map(Number);
console.log(`grid 行号 ${gi}；cellsX=${gridRaw.cellsX} cellsY=${gridRaw.cellsY} spacing=${gridRaw.spacing}`);
console.log(`\n== data[1..5] 的分布（n=${data[1].length}）==`);
const uniqAll = new Set();
for (const k of [1, 2, 3, 4, 5]) {
  const a = data[k];
  const s = new Set(a);
  for (const v of s) uniqAll.add(v);
  const sorted = [...s].sort((x, y) => x - y);
  console.log(`  data[${k}]: min=${Math.min(...a)} max=${Math.max(...a)} 不同值 ${s.size} 个`
    + `  前 8 个不同值 [${sorted.slice(0, 8).join(', ')}]`);
}
console.log(`  五条数组合起来共用 ${uniqAll.size} 个不同整数（说明它们可能共享同一套"高度档位"）`);

// ── 用候选面做择路，看汇流上限 ──
const j = JSON.parse(fs.readFileSync('C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian', 'utf8'));
const mask = (await import(pathToFileURL(path.join(ROOT, 'src/renderer/src/utils/coastline.js')).href)).buildLandMask(j.scenarios.baseMaps.desite.terrain);
const cols = gridRaw.cellsX, rows = gridRaw.cellsY, n = cols * rows, sp = gridRaw.spacing;

function stats(surface, name, landOf) {
  // 填洼（该面自身口径）
  const filled = new Float64Array(n), done = new Uint8Array(n);
  const hI = [], hK = [];
  const push = (i, k) => { hI.push(i); hK.push(k); let a = hI.length - 1; while (a > 0) { const p = (a - 1) >> 1; if (hK[p] <= hK[a]) break; [hI[p], hI[a]] = [hI[a], hI[p]]; [hK[p], hK[a]] = [hK[a], hK[p]]; a = p; } };
  const pop = () => { const i = hI[0], k = hK[0]; const li = hI.pop(), lk = hK.pop(); if (hI.length) { hI[0] = li; hK[0] = lk; let a = 0; for (;;) { const l = 2 * a + 1, r = l + 1; let m = a; if (l < hK.length && hK[l] < hK[m]) m = l; if (r < hK.length && hK[r] < hK[m]) m = r; if (m === a) break; [hI[m], hI[a]] = [hI[a], hI[m]]; [hK[m], hK[a]] = [hK[a], hK[m]]; a = m; } } return [i, k]; };
  for (let i = 0; i < n; i++) if (!landOf(i)) { filled[i] = surface[i]; done[i] = 1; push(i, surface[i]); }
  while (hI.length) {
    const [i, k] = pop(); const ci = i % cols, cj = (i / cols) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ni = ci + di, nj = cj + dj;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const j2 = nj * cols + ni; if (done[j2]) continue; done[j2] = 1;
      filled[j2] = Math.max(surface[j2], k); push(j2, filled[j2]);
    }
  }
  const NB = (i) => { const out = []; const ci = i % cols, cj = (i / cols) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; const ni = ci + di, nj = cj + dj; if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue; out.push({ j: nj * cols + ni, dist: Math.hypot(di, dj) * sp }); } return out; };
  const recv = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!landOf(i)) continue;
    let best = -1, bd = 1e-12;
    for (const nb of NB(i)) { const d = (filled[i] - filled[nb.j]) / nb.dist; if (d > bd) { bd = d; best = nb.j; } }
    recv[i] = best;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (filled[b] - filled[a]) || (surface[b] - surface[a]) || (a - b));
  const acc = new Float64Array(n).fill(1);
  for (const i of order) { if (!landOf(i)) continue; const j2 = recv[i]; if (j2 >= 0) acc[j2] += acc[i]; }
  let mx = 0, o5 = 0, o10 = 0;
  for (let i = 0; i < n; i++) { if (!landOf(i)) continue; if (acc[i] > mx) mx = acc[i]; if (acc[i] > 5) o5++; if (acc[i] > 10) o10++; }
  let longest = 0;
  for (let i = 0; i < n; i++) { if (!landOf(i)) continue; let cur = i, len = 0; const seen = new Set();
    while (cur >= 0 && len < 8000) { if (seen.has(cur)) break; seen.add(cur); cur = recv[cur]; len++; } if (len > longest) longest = len; }
  console.log(`  ${name.padEnd(26)} 最大累积 ${String(mx.toFixed(0)).padStart(4)}  acc>5 ${String(o5).padStart(4)}  acc>10 ${String(o10).padStart(4)}  最长链 ${longest} 格`);
}

const p0 = gridRaw.points[0];
const X0 = Array.isArray(p0) ? p0[0] : p0.x, Y0 = Array.isArray(p0) ? p0[1] : p0.y;
const XY = (i) => [X0 + (i % cols) * sp, Y0 + ((i / cols) | 0) * sp];
const landH = (i) => data[1][i] >= SEA && !!mask.lookup(XY(i)[0], XY(i)[1]);
console.log('\n== 用不同"择路面"跑汇流（陆地仍按 cells.h≥20 定义）==');
stats(Float64Array.from(data[1]), 'cells.h (现状)', landH);
for (const k of [4, 5]) stats(Float64Array.from(data[k]), `data[${k}]`, landH);
