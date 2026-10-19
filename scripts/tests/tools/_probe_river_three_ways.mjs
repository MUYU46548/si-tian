// 量尺：真实底图 desite 上「自动河网段」在三套陆地判据下的入海量对比 + 线宽/配色对照。
// 用法：node scripts/tests/tools/_probe_river_three_ways.mjs
//
// 为什么要它：用户三次报「自动河流依然过度延伸进海洋」。上一轮我用的是**并集**口径
// （掩膜 ∪ 高度），并据此报了「9/2785 越界」。本工具把三种口径放在**同一份数据**上对照，
// 看并集到底放进来了什么。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;   // 与 heightMath.SEA_LEVEL / riverTrace.TRACE_SEA_LEVEL / SEA_LEVEL_FOR_RIVER 同口径

// 纯函数层带无扩展名 import → 拷到临时 ESM 目录（与 Node 单测同一套做法）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-river3-'));
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  const src = path.join(UTILS, f);
  if (!fs.existsSync(src)) continue;
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(src, 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');

const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap;
const grid = hm.grid;
const pts = grid.points;
const gx = (p) => (Array.isArray(p) ? p[0] : p.x);
const gy = (p) => (Array.isArray(p) ? p[1] : p.y);
const cols = grid.cellsX | 0, rows = grid.cellsY | 0, sp = grid.spacing || 14.4;
const x0 = gx(pts[0]), y0 = gy(pts[0]);

// 省份掩膜（与产品同源：buildLandMask）
const mask = C.buildLandMask(bm.terrain);
const maskLookup = mask.lookup;
const heightIsLand = (x, y) => {
  const ci = Math.round((x - x0) / sp), cj = Math.round((y - y0) / sp);
  if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return false;
  return (Number(hm.h[cj * cols + ci]) || 0) >= SEA;
};

// 口径 A：纯高度（旧旧版）；B：并集（上一轮 = 现状）；C：掩膜 ∧ 高度（本轮拟改）
const isLandA = (x, y) => heightIsLand(x, y);
const isLandB = (x, y) => maskLookup(x, y) || heightIsLand(x, y);
const isLandC = (x, y) => maskLookup(x, y) && heightIsLand(x, y);

// 追踪（把掩膜注入，源头离海 ≥2 格 —— 与产品 generateRivers 同口径）
const r = R.traceRivers(hm, { isLand: maskLookup });
const segs = r.segments || [];
console.log('== 追踪结果（真实 desite 底图）==');
console.log(`格点 ${pts.length}（${cols}×${rows}）  源头 ${(r.rivers || []).length} 条  代表路径点位数 ${(r.rivers || []).reduce((a, x) => a + (x.points || []).length, 0)}`);
console.log(`河网段 ${segs.length} 段   segMaxFlow=${r.segMaxFlow}  basins=${r.basins}  endorheicCells=${r.endorheicCells}`);

const len = (s) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
console.log('\n== 三套陆地判据下、段的分类 ==');
for (const [name, f] of [['A 纯高度  ', isLandA], ['B 并集(=现状)', isLandB], ['C 掩膜∧高度  ', isLandC]]) {
  let both = 0, oneSea = 0, bothSea = 0, keepLen = 0, totalLen = 0, dropLen = 0;
  for (const s of segs) {
    totalLen += len(s);
    const a = f(s.x0, s.y0), b = f(s.x1, s.y1);
    if (a && b) { both++; keepLen += len(s); }
    else if (!a && !b) { bothSea++; dropLen += len(s); }
    else {
      oneSea++;
      // 裁剪后保留陆地那一截（近似：按比例；真实实现用二分求交）
      const clipped = C.clipSegmentToLand(s, f);
      if (clipped) keepLen += len(clipped); else dropLen += len(s);
    }
  }
  console.log(`${name}: 全陆 ${both}  一端入海 ${oneSea}  全海 ${bothSea}  |  保留长度 ${keepLen.toFixed(0)} / 全长 ${totalLen.toFixed(0)} (${(keepLen / totalLen * 100).toFixed(1)}% 的笔画长度还在)`);
}

// 段端点里，有多少落在"高度说陆、掩膜说非陆"的那批格上（= 上一轮并集放进来的东西）
let segTouchPhantom = 0, phantomCells = new Set();
for (const s of segs) {
  for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) {
    if (heightIsLand(x, y) && !maskLookup(x, y)) {
      segTouchPhantom++;
      const ci = Math.round((x - x0) / sp), cj = Math.round((y - y0) / sp);
      phantomCells.add(cj * cols + ci);
      break;
    }
  }
}
console.log(`\n🔴 端点踩在"高度说陆/掩膜说海"的幻影格上的段: ${segTouchPhantom} / ${segs.length} (${(segTouchPhantom / segs.length * 100).toFixed(1)}%)`);
console.log(`   涉及幻影格 ${phantomCells.size} 个`);

// ── 线宽/配色对照（产品公式） ───────────────────────────────────────────────
console.log('\n== 线宽对照（屏幕像素，zoom=1） ==');
const widths = (bm.rivers || []).map((x) => x.width).filter(Number.isFinite);
const disch = (bm.rivers || []).map((x) => x.discharge).filter(Number.isFinite);
const stat = (a) => (a.length ? `min=${Math.min(...a)} p50=${a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)]} max=${Math.max(...a)}` : 'n/a');
console.log(`自带河 width: ${stat(widths)}   discharge: ${stat(disch)}`);
const baseW = (rr) => Math.max(0.7, Math.min(4, (rr.width || 0.2) * 6 * Math.max(Math.sqrt(Math.max(rr.discharge || 1, 1)) / 14, 0.6)));
const bw = (bm.rivers || []).map(baseW);
console.log(`自带河 屏幕线宽: min=${Math.min(...bw).toFixed(2)} p50=${bw.slice().sort((p, q) => p - q)[Math.floor(bw.length / 2)].toFixed(2)} max=${Math.max(...bw).toFixed(2)} px  （画法：单遍 #5d97bb）`);

// 自动河：flowWidthScale(flow, segMaxFlow) → 世界单位 ×2.4 光晕 ×px(zoom)
const maxFlow = r.segMaxFlow || 20;
const WMIN = 0.8, WMAX = 5.0;
const flowW = (fl) => {
  const f = fl > 0 ? fl : 1;
  const m = Number.isFinite(maxFlow) && maxFlow > 1 ? maxFlow : Math.max(2, f);
  const t = Math.max(0, Math.min(1, (f - 1) / (m - 1)));
  return Math.max(WMIN, Math.min(WMAX, WMIN + (WMAX - WMIN) * Math.sqrt(t)));
};
const aw = segs.map((s) => flowW(s.flow));
const sortw = aw.slice().sort((p, q) => p - q);
console.log(`自动河 世界宽度: min=${Math.min(...aw).toFixed(2)} p50=${sortw[Math.floor(sortw.length / 2)].toFixed(2)} max=${Math.max(...aw).toFixed(2)} （zoom=1 时 = 同值 px）`);
console.log(`  光晕遍 ×2.4: p50=${(sortw[Math.floor(sortw.length / 2)] * 2.4).toFixed(2)} max=${(Math.max(...aw) * 2.4).toFixed(2)} px`);
console.log(`  配色: 外层 #3B82F6 @alpha0.35 + 内层亮芯 #93c5fd   对比 自带河 #5d97bb`);
