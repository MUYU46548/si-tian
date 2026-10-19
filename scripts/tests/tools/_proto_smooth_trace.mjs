// 原型：追踪前**平滑高度图**（产品已有 `smoothHeightmapGrid`）会不会消掉"毛刺"、长出主干。
//
// 依据：`riverTrace.js` 自己的注释说"只按原始高度 → **微洼地全部变成终点**"
//   （实测最长河道只有 10 格 / 144 世界单位）。133×75 的格子上微洼地极多，
//   水流一格就掉进小坑 → 画面上就是短棍毛刺。
//   平滑能压掉这些微洼地，让流向顺着大谷走。
// 用法：node scripts/tests/tools/_proto_smooth_trace.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-sm-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);
const RES = await import(pathToFileURL(path.join(tmp, 'heightmapResample.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap;
const mask = C.buildLandMask(bm.terrain);
const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });
const provPaths = (bm.terrain || []).map((tt) => {
  const pts = tt.points || []; if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');

function pathLens(trace) {
  return (trace.rivers || []).map((r) => {
    let L = 0; const p = r.points || [];
    for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
    return L;
  }).sort((a, b) => a - b);
}
function renderSvg(trace, title, file) {
  const segs = trace.segments || [];
  const mf = trace.segMaxFlow || 1;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">${title}</text>`;
  for (const sg of segs) {
    const t = Math.max(0, Math.min(1, (sg.flow - 1) / Math.max(1, mf - 1)));
    const d = 36 + (613 - 36) * Math.sqrt(t);
    const px = Math.max(0.7, Math.min(4, 0.2 * 6 * Math.max(Math.sqrt(Math.max(d, 1)) / 14, 0.6)));
    s += `<line x1="${sg.x0.toFixed(1)}" y1="${sg.y0.toFixed(1)}" x2="${sg.x1.toFixed(1)}" y2="${sg.y1.toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
  }
  s += '</svg>';
  fs.writeFileSync(path.join(outDir, file), s);
}
/** 只对 h 做多次盒滤波（用产品自己的实现），返回可被 traceRivers 吃的高度图 */
function smoothed(radius, passes) {
  const r = RES.smoothHeightmapGrid(hm, { radius, passes });
  return r.heightmap || r;
}

const rows = [];
function report(name, trace, file) {
  const L = pathLens(trace);
  const longest = L.length ? L[L.length - 1] : 0;
  const segs = (trace.segments || []).length;
  rows.push({ name, rivers: (trace.rivers || []).length, segs, longest, med: L.length ? L[Math.floor(L.length / 2)] : 0 });
  renderSvg(trace, `${name} — rivers ${(trace.rivers || []).length}, longest ${longest.toFixed(0)}`, file);
}

report('现状 (no smooth)', R.traceRivers(hm, { isLand: mask.lookup }), 'sm_none.svg');
for (const [rad, pass] of [[2, 1], [2, 2], [3, 3]]) {
  const s = smoothed(rad, pass);
  const tr = R.traceRivers(s, { isLand: mask.lookup });
  report(`smooth r=${rad} p=${pass}`, tr, `sm_${rad}_${pass}.svg`);
}

console.log('名称'.padEnd(22), '代表路径'.padStart(8), '段'.padStart(8), '最长'.padStart(8), '中位'.padStart(8));
for (const r of rows) {
  console.log(r.name.padEnd(22), String(r.rivers).padStart(8), String(r.segs).padStart(8), r.longest.toFixed(0).padStart(8), r.med.toFixed(0).padStart(8));
}
console.log('\n写出到', outDir);
