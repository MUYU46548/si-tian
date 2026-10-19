// 一次性诊断：**裁完之后还有多少个陆端落在陆地掩膜之外**（用户报的"伸进海里"）
// 用法：node scripts/tests/tools/dump_river_clip.mjs <grid.json>
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

const [, , gridJson] = process.argv;
const SRC = path.resolve('src/renderer/src/utils');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-clip-'));
for (const f of ['riverTrace.js', 'heightmapResample.js', 'coastline.js', 'gridSpatialIndex.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(SRC, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const g = JSON.parse(fs.readFileSync(gridJson, 'utf8'));
const mask = (g.landFeatures && g.landFeatures.length) ? C.buildLandMask(g.landFeatures) : null;
if (!mask) { console.log('这个 grid.json 里没有 landFeatures，无法判海岸线'); process.exit(0); }
const t = R.traceRivers({ h: g.h, grid: g.grid }, { isLand: mask.lookup });

// 与画布侧 `makeRiverLandCheck` **同一口径**：掩膜 ∪ 高度（h ≥ 20 算陆）
const H = g.h, gg = g.grid;
// ⚠️ 网格点可能是 `[x,y]` **也可能是 `{x,y}`**（`extract_map_grid.mjs` 抽出来的是对象形态）
//    —— 第一版写成 `points[0][0]` 直接得到 undefined → 全部 NaN → `heightIsLand` 恒 false，
//    于是"并集口径"退化成纯掩膜，读数与掩膜一模一样（差点把结论带偏）。两种形态都要认。
const p0 = gg.points[0];
const gx0 = Array.isArray(p0) ? p0[0] : p0.x;
const gy0 = Array.isArray(p0) ? p0[1] : p0.y;
const gsp = gg.spacing || 14.4;
const gcols = gg.cellsX | 0, grows = gg.cellsY | 0;
const heightIsLand = (x, y) => {
  const ci = Math.round((x - gx0) / gsp), cj = Math.round((y - gy0) / gsp);
  if (ci < 0 || ci >= gcols || cj < 0 || cj >= grows) return false;
  return (Number(H[cj * gcols + ci]) || 0) >= 20;
};
const isLandUnion = (x, y) => mask.lookup(x, y) || heightIsLand(x, y);

// 未裁之前：有多少陆端在海里
const countOutside = (segs, pred) => {
  let bad = 0, checked = 0;
  for (const s of segs) {
    const pts = s.endInSea ? [[s.x0, s.y0]] : [[s.x0, s.y0], [s.x1, s.y1]];
    for (const [x, y] of pts) { checked++; if (!pred(x, y)) bad++; }
  }
  return { bad, checked };
};
const before = countOutside(t.segments, mask.lookup);

// 裁（与画布侧 getAutoRiverNetwork 同一套调用）
const kept = [];
let dropped = 0, trimmed = 0;
for (const s of t.segments) {
  if (!s.endInSea) { kept.push(s); continue; }
  const c = C.clipSegmentToLand(s, isLandUnion);
  if (!c) { dropped++; continue; }
  trimmed++;
  kept.push(c);
}
const after = countOutside(kept, mask.lookup);
const afterUnion = countOutside(kept, isLandUnion);

console.log(`段 ${t.segments.length} → ${kept.length}（裁掉 ${trimmed} 条入海段的越界部分，整段丢 ${dropped}）`);
console.log(`陆端在**掩膜**外：裁之前 ${before.bad}/${before.checked} → 裁之后 ${after.bad}/${after.checked}`);
console.log(`陆端在**并集口径**外：裁之后 ${afterUnion.bad}/${afterUnion.checked}（这才是画布实际用的判据）`);
console.log(`入海段的末端是否"咬"到岸线上（应当贴岸、不深入海里）：`);
let deepest = 0;
for (const s of kept) {
  if (!s.endInSea) continue;
  // 末端离最近"陆地内部"的距离没法直接算，这里用"末端在水里、但它的**前一个陆端**在陆地内"
  // 来近似验证：前一个端点必须在陆地内（否则裁剪没生效）
  if (!isLandUnion(s.x0, s.y0)) deepest++;
}
console.log(`  入海段里"陆端也不在陆地内"的条数：${deepest}（应当 ≤1，即只有误差级）`);

// 抽查：把"并集口径也判水"的点打印出来，看它到底落在哪（不然只能猜）
const samples = [];
for (const s of kept) {
  const pts = s.endInSea ? [[s.x0, s.y0, 'land']] : [[s.x0, s.y0, 'a'], [s.x1, s.y1, 'b']];
  for (const [x, y, tag] of pts) {
    if (!isLandUnion(x, y)) samples.push({ x, y, tag, endInSea: !!s.endInSea, flow: s.flow });
  }
}
console.log(`抽查 ${Math.min(6, samples.length)} 个"并集也判水"的点：`);
for (const p of samples.slice(0, 6)) {
  const ci = Math.round((p.x - gx0) / gsp), cj = Math.round((p.y - gy0) / gsp);
  const idx = cj * gcols + ci;
  console.log(`  (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) tag=${p.tag} endInSea=${p.endInSea} `
    + `cell=(${ci},${cj}) idx=${idx} h=${idx >= 0 && idx < H.length ? H[idx] : 'OOB'} `
    + `mask=${mask.lookup(p.x, p.y)}`);
}
