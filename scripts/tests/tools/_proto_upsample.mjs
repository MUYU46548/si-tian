// 原型：**追踪前放大高度图**（riverTrace 自带的 `opts.upsample`）会不会让河真正变好看。
//
// 背景（本轮读代码 + 渲染实测得出）：
//   `riverTrace.js` 的注释自己写着两个"假象"方向：
//     · 只按原始高度 → 微洼地成终点，最长河道只有 10 格 / 144 世界单位；
//     · 只按水位   → 每格朝离海最近方向走 → **一片放射状短支沟**。
//   而 `keyLess` 主键是**水位**（保证出得去）→ 贴着海的格子水位最低，
//   于是内陆的水优先朝"最近的缺口"走，而不是朝最深的谷走。
//   在 133×75 的粗网格上（格距 14.4，岛宽 1700），这必然给出**短、直、放射状**的河 —— 正是用户说的"恐怖感"。
//
// 验证：把高度图先放大 N 倍再追踪，河网会不会长出主干。
// 用法：node scripts/tests/tools/_proto_upsample.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-up-'));
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
const outDir = path.join(os.tmpdir(), 'sitian-river-compare');
fs.mkdirSync(outDir, { recursive: true });
const provPaths = (bm.terrain || []).map((tt) => {
  const pts = tt.points || []; if (pts.length < 3) return '';
  return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
}).join(' ');

function renderSvg(trace, title, file, big = 1) {
  const segs = trace.segments || [];
  const mf = trace.segMaxFlow || 1;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="100%" height="100%" fill="#d9c49a"/>
<path d="${provPaths}" fill="none" stroke="#00000022" stroke-width="1"/>
<text x="12" y="24" font-size="20" fill="#000" font-family="sans-serif">${title}</text>`;
  for (const sg of segs) {
    const t = Math.max(0, Math.min(1, (sg.flow - 1) / Math.max(1, mf - 1)));
    const d = 36 + (613 - 36) * Math.sqrt(t);
    const px = Math.max(0.7, Math.min(4, 0.2 * 6 * Math.max(Math.sqrt(Math.max(d, 1)) / 14, 0.6))) * big;
    s += `<line x1="${sg.x0.toFixed(1)}" y1="${sg.y0.toFixed(1)}" x2="${sg.x1.toFixed(1)}" y2="${sg.y1.toFixed(1)}" stroke="#5d97bb" stroke-width="${px.toFixed(2)}" stroke-linecap="round"/>`;
  }
  s += '</svg>';
  fs.writeFileSync(path.join(outDir, file), s);
}

function pathLens(trace) {
  return (trace.rivers || []).map((r) => {
    let L = 0; const p = r.points || [];
    for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
    return L;
  }).sort((a, b) => a - b);
}
const med = (a) => a.length ? a[Math.floor(a.length / 2)] : 0;

console.log('== 不带 upsample（现状）==');
const base = R.traceRivers(hm, { isLand: mask.lookup });
let L = pathLens(base);
console.log(`  代表路径 ${(base.rivers || []).length} 条 / 段 ${(base.segments || []).length} / 最长河 ${L.length ? L[L.length - 1].toFixed(0) : 0} 世界单位 / 中位 ${med(L).toFixed(0)}`);
renderSvg(base, `upsample OFF — ${(base.rivers || []).length} rivers, longest ${L.length ? L[L.length - 1].toFixed(0) : 0}`, 'up_off.svg');

for (const f of [2, 3]) {
  console.log(`\n== upsample ×${f} ==`);
  const t0 = Date.now();
  const tr = R.traceRivers(hm, { isLand: mask.lookup, upsample: f });
  const dt = Date.now() - t0;
  if (tr.upsampleNote) console.log('  note:', tr.upsampleNote);
  console.log('  实际放大:', tr.upsample, ' 格数:', tr.cells, ' 耗时:', dt, 'ms');
  L = pathLens(tr);
  console.log(`  代表路径 ${(tr.rivers || []).length} 条 / 段 ${(tr.segments || []).length} / 最长河 ${L.length ? L[L.length - 1].toFixed(0) : 0} 世界单位 / 中位 ${med(L).toFixed(0)}`);
  renderSvg(tr, `upsample x${f} — ${(tr.rivers || []).length} rivers, longest ${L.length ? L[L.length - 1].toFixed(0) : 0}`, `up_${f}.svg`);
}
console.log('\n写出到', outDir);
