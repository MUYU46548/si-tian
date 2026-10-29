// probe_landmass_frames.mjs — **一次性探针**（2026-10-29，A5）：造陆连跑几次，量两件事
//   ① 图幅会不会缩（修前：每次 ≈9.5%；修后：`heightmap.genBBox` 让重跑逐格同网格）；
//   ② 手绘按「图幅相对位置」搬的命中率（`transferHandEdits`）。
// 不进回归（跑几分钟，结论已固化成 unit/test_hand_edits h7–h10 与 test_152 g 段）。
// 用法：node scripts/tests/tools/probe_landmass_frames.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');

function collectDeps(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(UTILS, f), 'utf8');
    for (const m of src.matchAll(/from '\.\/([A-Za-z0-9_.-]+)'/g)) {
      const dep = m[1].endsWith('.js') ? m[1] : m[1] + '.js';
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen];
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-a5-'));
const fix = (src) => src.replace(/from '\.\/([A-Za-z0-9_.-]+)'/g, (m) => (m.includes(".js'") ? m : m.slice(0, -1) + ".js'"));
for (const f of collectDeps(['landmass.js', 'terrainParams.js', 'handEdits.js'])) {
  fs.writeFileSync(path.join(tmp, f), fix(fs.readFileSync(path.join(UTILS, f), 'utf8')));
}
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
const url = (f) => pathToFileURL(path.join(tmp, f)).href;
const L = await import(url('landmass.js'));
const P = await import(url('terrainParams.js'));
const H = await import(url('handEdits.js'));

const bboxOf = (pts) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = Array.isArray(p) ? p[0] : p.x;
    const y = Array.isArray(p) ? p[1] : p.y;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
};
const expand = (b, k = 0.04) => {
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  return { minX: b.minX - w * k / 2, minY: b.minY - h * k / 2, maxX: b.maxX + w * k / 2, maxY: b.maxY + h * k / 2 };
};
const union = (a, b) => (!a ? b : !b ? a : {
  minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
});

const base = { ...P.DEFAULT_LAND_PARAMS };
let bbox = { minX: -900, minY: -500, maxX: 900, maxY: 500 };
let recorded = null;   // 高度图上的 genBBox
const runs = [];
for (let run = 1; run <= 4; run++) {
  const gen = L.generateLandmass({ ...base }, bbox);
  const pts = gen.terrain.grid.points;
  runs.push({ bbox, gen, ringPts: gen.rings.flatMap((r) => r.points), gridPts: pts });
  console.log(`run${run}: 图幅 ${(bbox.maxX - bbox.minX).toFixed(1)}x${(bbox.maxY - bbox.minY).toFixed(1)}`
    + ` | 网格 ${gen.terrain.grid.points.length} 格 / 格距 ${gen.terrain.grid.spacing.toFixed(3)}`
    + ` | 环 ${gen.rings.length}`);
  // 模拟 store：本次记下图幅；下一次 = 上次图幅 ∪ 省份包围盒外扩 4%（用环 bbox 当省份上界）
  recorded = { ...bbox };
  bbox = union(recorded, expand(bboxOf(gen.rings.flatMap((r) => r.points))));
}

// 同种子、图幅稳定 → 网格应逐格相同（手绘逐点命中）
const g1 = runs[0].gen.terrain, g2 = runs[1].gen.terrain;
const samePts = g1.grid.points.length === g2.grid.points.length
  && g1.grid.points.every((p, i) => p[0] === g2.grid.points[i][0] && p[1] === g2.grid.points[i][1]);
console.log(`\n相邻两次网格逐点相同：${samePts}（${g1.grid.points.length} vs ${g2.grid.points.length}）`);

const edits = [];
for (let k = 1; k <= 40; k++) {
  const i = Math.floor(g1.grid.points.length * k / 41);
  if (!(g1.h[i] >= 20)) continue;
  edits.push({ x: g1.grid.points[i][0], y: g1.grid.points[i][1], h: 77 });
}
const next = L.generateLandmass({ ...base }, union(recorded, expand(bboxOf(runs[1].ringPts)))).terrain;
const tr = H.transferHandEdits(next, g1, edits, { seaLevel: 20 });
const rp = H.reapplyHandEdits(L.generateLandmass({ ...base }, bbox).terrain, edits);
console.log(`手绘 ${edits.length} 格 → transfer 保留 ${tr.applied} / 吸附 ${tr.snapped} / 丢 ${tr.dropped} / 最大偏移 ${(tr.worst || 0).toFixed(3)} 世界单位`);
console.log(`同网格 reapply 精确命中：${rp.applied}`);
fs.rmSync(tmp, { recursive: true, force: true });
