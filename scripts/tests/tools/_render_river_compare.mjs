// 把两套河各自**单独渲成 SVG**（纯 Node，无依赖），用来肉眼比对"我到底画成了什么"。
//
// 为什么要有它：用户发截图说"很丑、有恐怖感"，而我在此之前只能**猜**哪里丑。
// 把几何直接渲出来看，比读代码猜快得多，也不会再犯"我量的是我以为是的东西"。
//
// 用法：node scripts/tests/tools/_render_river_compare.mjs
// 产物：%TEMP%/sitian-river-compare/{auto.svg,imported.svg,overlay.svg}
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-rc-'));
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
const traced = R.traceRivers(hm, { isLand: mask.lookup });
const segs = traced.segments || [];
const maxFlow = traced.segMaxFlow || 1;

// 屏幕 = 世界（地图约 1920×1080），SVG 直接按世界坐标画，加个 4 倍放大便于看细节
const W = 1920, H = 1080;
const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });

// 省份轮廓（浅色底，给点地理参照）
const provPaths = (bm.terrain || []).map((t) => {
  const pts = t.points || [];
  if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');

const head = (title) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">${title}</text>`;

// ── A. 自带河（FMG 导入）：按它的 width/discharge 画 ──
const wOf = (r) => {
  const d = Number.isFinite(r.discharge) ? r.discharge : 1;
  const s = Math.max(Math.sqrt(Math.max(d, 1)) / 14, 0.6);
  return Math.max(0.7, Math.min(4, (r.width || 0.2) * 6 * s));
};
let a = head(`imported FMG rivers (${(bm.rivers || []).length}) — the basemap's own`);
for (const r of (bm.rivers || [])) {
  const pts = r.points || [];
  if (pts.length < 2) continue;
  a += `<polyline points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#5d97bb" stroke-width="${wOf(r).toFixed(2)}" stroke-linecap="round"/>`;
}
a += '</svg>';
fs.writeFileSync(path.join(outDir, 'imported.svg'), a);

// ── B. 自动河网：**当前渲染口径**（逐段、屏幕像素宽、单遍）──
let b = head(`auto network (${segs.length} segments, maxFlow=${maxFlow}) — CURRENT render`);
for (const s of segs) {
  const t = Math.max(0, Math.min(1, (s.flow - 1) / Math.max(1, maxFlow - 1)));
  const d = 36 + (613 - 36) * Math.sqrt(t);
  const px = Math.max(0.7, Math.min(4, 0.2 * 6 * Math.max(Math.sqrt(Math.max(d, 1)) / 14, 0.6)));
  b += `<line x1="${s.x0.toFixed(1)}" y1="${s.y0.toFixed(1)}" x2="${s.x1.toFixed(1)}" y2="${s.y1.toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
}
b += '</svg>';
fs.writeFileSync(path.join(outDir, 'auto.svg'), b);

// ── C. 叠加：自带河（深色细线）+ 自动河（半透明粗线），看两套是不是同一水系 ──
let c = head('OVERLAY — imported (dark, thin) + auto (light, thick)');
for (const r of (bm.rivers || [])) {
  const pts = r.points || [];
  if (pts.length < 2) continue;
  c += `<polyline points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="#0b3a52" stroke-width="1.2"/>`;
}
for (const s of segs) {
  c += `<line x1="${s.x0.toFixed(1)}" y1="${s.y0.toFixed(1)}" x2="${s.x1.toFixed(1)}" y2="${s.y1.toFixed(1)}" stroke="#e5484d" stroke-opacity="0.5" stroke-width="2"/>`;
}
c += '</svg>';
fs.writeFileSync(path.join(outDir, 'overlay.svg'), c);

console.log('写出：');
for (const f of ['imported.svg', 'auto.svg', 'overlay.svg']) console.log('  ' + path.join(outDir, f));

// ── 顺带量几个"为什么丑"的结构指标 ──
const byFlow = segs.map((s) => s.flow).sort((x, y) => x - y);
const q = (p) => byFlow[Math.min(byFlow.length - 1, Math.round((byFlow.length - 1) * p))];
console.log(`\nflow 分位: p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${q(1)}`);
// 每条"河"（代表路径）的长度分布
const lens = (traced.rivers || []).map((r) => {
  let L = 0; const p = r.points || [];
  for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
  return L;
}).sort((x, y) => x - y);
console.log(`代表路径 ${lens.length} 条，长度分位: p25=${lens[Math.floor(lens.length * 0.25)]?.toFixed(0)} p50=${lens[Math.floor(lens.length / 2)]?.toFixed(0)} max=${lens[lens.length - 1]?.toFixed(0)}`);
// 有多少段是"1 格长"（= 极短的小棍 → 视觉上就是刺）
const sl = segs.map((s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0));
console.log(`段长：p50=${(sl.slice().sort((x, y) => x - y)[Math.floor(sl.length / 2)]).toFixed(1)} 格距=${(hm.grid.spacing || 14.4)}`);
