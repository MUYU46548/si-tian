// 一次性诊断：把自动河流的**逐点汇流量**打出来（找"线宽不渐变"的根因）
// 用法：node scripts/tests/tools/dump_river_flows.mjs <grid.json> [maxRivers]
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

const [, , gridJson, maxArg] = process.argv;
const maxRivers = Number(maxArg) || 3;

// 把纯函数层拷到临时 ESM 目录（与单测同一套做法）
const SRC = path.resolve('src/renderer/src/utils');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-flows-'));
for (const f of ['riverTrace.js', 'heightmapResample.js', 'coastline.js', 'gridSpatialIndex.js']) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8')
    .replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, f), code);
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const g = JSON.parse(fs.readFileSync(gridJson, 'utf8'));
const hm = { h: g.h, grid: g.grid };
const mask = (g.landFeatures && g.landFeatures.length) ? C.buildLandMask(g.landFeatures) : null;
const t = R.traceRivers(hm, mask ? { isLand: mask.lookup } : {});

console.log(`河 ${t.rivers.length} 条 / 闸门 源头高度 >${t.sourceHeight} / 贴岸挡掉 ${t.coastSources} / ${Math.round(t.elapsedMs)} ms`);
const allFlows = [];
for (const r of t.rivers) for (const f of r.flows) allFlows.push(f);
allFlows.sort((a, b) => a - b);
const pct = (p) => allFlows[Math.min(allFlows.length - 1, Math.round((allFlows.length - 1) * p))];
console.log(`逐点汇流量：min=${allFlows[0]} p10=${pct(0.1)} p50=${pct(0.5)} p90=${pct(0.9)} max=${allFlows[allFlows.length - 1]}`);

// 逐条打印：每个点的 flow 与"按当前口径"算出来的世界单位宽度
for (const r of t.rivers.slice(0, maxRivers)) {
  const ws = Array.from(r.flows).map((f) => Math.max(0.7, Math.min(5.0, 0.55 + Math.cbrt(f) * 0.75)));
  console.log(`\n条 len=${r.len} flow(出口)=${r.flow} order=${Array.from(r.order).join('')}`);
  console.log('  flows :', Array.from(r.flows).join(' '));
  console.log('  widthW:', ws.map((w) => w.toFixed(2)).join(' '));
  console.log('  宽比值:', (ws[ws.length - 1] / ws[0]).toFixed(2) + '×');
}
// 全长（世界单位）与时长的关系
const wl = t.rivers.map((rr) => {
  let s = 0;
  for (let i = 0; i + 1 < rr.points.length; i++) s += Math.hypot(rr.points[i + 1].x - rr.points[i].x, rr.points[i + 1].y - rr.points[i].y);
  return s;
}).sort((a, b) => b - a);
console.log(`\n最长几条的世界长度：${wl.slice(0, 6).map((v) => Math.round(v)).join(', ')}`);
