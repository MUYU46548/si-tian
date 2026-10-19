// 量尺：**幻影格**（高度说陆 / 省份掩膜说海）—— 自动河流越界入海的机制本体。
//
// 🔴 为什么必须用产品自己的 `buildLandMask` 来量：
//   我第一版量尺（`_probe_desite_land.mjs`）自己手写了一个射线法 `inAnyRing`，读数 **101 格**；
//   而产品真正用的 `coastline.buildLandMask` 读出 **203 格**。差异来自我那份手写实现的
//   环/洞/重叠处理与产品不一致 —— **量尺自己信不过，读数就是假的**。
//   本项目已经在"诊断工具自己踩坑"上吃过一次（`dump_river_clip.mjs` 把点读成 NaN）。
//   纪律：量任何"产品口径"的东西，一律 import 产品的实现，不要另写一份。
//
// 用法：node scripts/tests/tools/_probe_phantom.mjs
// 数据源：真实项目文件（下方 P 常量）
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const SEA = 20;   // 与 heightMath.SEA_LEVEL / riverTrace.TRACE_SEA_LEVEL / SEA_LEVEL_FOR_RIVER 同口径

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-ph-'));
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
const gx = (p) => (Array.isArray(p) ? p[0] : p.x);
const gy = (p) => (Array.isArray(p) ? p[1] : p.y);
const cols = g.cellsX | 0, rows = g.cellsY | 0, sp = g.spacing || 14.4;
const x0 = gx(g.points[0]), y0 = gy(g.points[0]);
const cellIdxOf = (x, y) => {
  const ci = Math.round((x - x0) / sp), cj = Math.round((y - y0) / sp);
  if (ci < 0 || ci >= cols || cj < 0 || cj >= rows) return -1;
  return cj * cols + ci;
};
// ⚠️ 掩膜走**产品实现**（不是手写射线法）
const mask = C.buildLandMask(bm.terrain);
const heightIsLand = (x, y) => {
  const i = cellIdxOf(x, y);
  return i >= 0 ? (Number(hm.h[i]) || 0) >= SEA : false;
};

let hLand = 0, mLand = 0, both = 0, phantom = 0, maskOnly = 0;
const phantomIdx = new Set(), maskOnlyIdx = new Set();
for (let i = 0; i < g.points.length; i++) {
  const x = gx(g.points[i]), y = gy(g.points[i]);
  const H = heightIsLand(x, y), M = !!mask.lookup(x, y);
  if (H) hLand++;
  if (M) mLand++;
  if (H && M) both++;
  else if (H && !M) { phantom++; phantomIdx.add(i); }
  else if (!H && M) { maskOnly++; maskOnlyIdx.add(i); }
}
console.log('== 逐格清点（掩膜用 products 的 buildLandMask）==');
console.log(`总格 ${g.points.length}（${cols}×${rows}）`);
console.log(`高度判陆 ${hLand}   掩膜判陆 ${mLand}   两者都陆 ${both}`);
console.log(`🔴 幻影格（高度陆 / 掩膜海）: ${phantom}  = ${(phantom / g.points.length * 100).toFixed(2)}% 的格`);
console.log(`   掩膜陆 / 高度海          : ${maskOnly}`);

const r = R.traceRivers(hm, { isLand: mask.lookup });
const segs = r.segments || [];
let touchPhantom = 0, touchMaskOnly = 0, skipUnion = 0, skipMask = 0;
const touchedPhantom = new Set();
for (const s of segs) {
  let ph = false, mo = false;
  for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) {
    const i = cellIdxOf(x, y);
    if (i < 0) continue;
    if (phantomIdx.has(i)) { ph = true; touchedPhantom.add(i); }
    if (maskOnlyIdx.has(i)) mo = true;
  }
  if (ph) touchPhantom++;
  if (mo) touchMaskOnly++;
  const u = (x, y) => mask.lookup(x, y) || heightIsLand(x, y);   // 上一轮的并集
  if (u(s.x0, s.y0) && u(s.x1, s.y1)) skipUnion++;
  if (mask.lookup(s.x0, s.y0) && mask.lookup(s.x1, s.y1)) skipMask++;
}
console.log(`\n== 段清点（共 ${segs.length} 段）==`);
console.log(`🔴 至少一端在幻影格上的段: ${touchPhantom} (${(touchPhantom / segs.length * 100).toFixed(1)}%)  涉及幻影格 ${touchedPhantom.size}/${phantom}`);
console.log(`   至少一端在"掩膜陆/高度海"格上的段: ${touchMaskOnly} (${(touchMaskOnly / segs.length * 100).toFixed(1)}%)`);
console.log(`\n== 「两端都判陆 → clipSegmentToLand 整段跳过裁剪」 ==`);
console.log(`  并集口径（上一轮 = 现状的历史）: ${skipUnion}`);
console.log(`  掩膜口径（本轮修法）          : ${skipMask}`);
console.log(`  → **${skipUnion - skipMask} 段**在并集下"不用裁"，其中相当一部分正是画进海里的那些`);
