// 用**产品自己的** `endInSea` 标志清点死水段（不靠我重新推导路径）
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = 'E:/CODE/CangKu/SiTian';
const UTILS = ROOT + '/src/renderer/src/utils';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sit-x-'));
const fix = (src) => src.replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'");
for (const f of ['riverTrace.js', 'coastline.js', 'gridSpatialIndex.js', 'heightmapAccess.js', 'heightmapResample.js']) {
  fs.writeFileSync(path.join(tmp, f), fix(fs.readFileSync(path.join(UTILS, f), 'utf8')));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const R = await import(pathToFileURL(path.join(tmp, 'riverTrace.js')).href);
const C = await import(pathToFileURL(path.join(tmp, 'coastline.js')).href);

const j = JSON.parse(fs.readFileSync('C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian', 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const hm = bm.heightmap;
const mask = C.buildLandMask(bm.terrain);
const t = R.traceRivers(hm, { isLand: mask.lookup });
const segs = t.segments || [];
const inSea = segs.filter((s) => s.endInSea).length;
console.log('段总数', segs.length);
console.log('endInSea=true（水到得了海）', inSea, '=', (inSea / segs.length * 100).toFixed(1) + '%');
console.log('🔴 endInSea=false（死水）', segs.length - inSea, '=', ((segs.length - inSea) / segs.length * 100).toFixed(1) + '%');
console.log('回执 reaching =', t.reaching, ' sources =', t.sources, ' endorheicCells =', t.endorheicCells);
const dead = segs.filter((s) => !s.endInSea).map((s) => s.flow).sort((a, b) => a - b);
const alive = segs.filter((s) => s.endInSea).map((s) => s.flow).sort((a, b) => a - b);
const st = (a) => (a.length ? `n=${a.length} p50=${a[Math.floor(a.length / 2)]} max=${a[a.length - 1]}` : 'n/a');
console.log('死水段 flow:', st(dead));
console.log('活水段 flow:', st(alive));
// 死水段按 flow 分档
for (const [lo, hi] of [[1, 1], [2, 2], [3, 5], [6, 22]]) {
  const all = segs.filter((s) => s.flow >= lo && s.flow <= hi);
  const d = all.filter((s) => !s.endInSea).length;
  if (all.length) console.log(`  flow ${lo}~${hi}: ${all.length} 段，死水 ${d} (${(d / all.length * 100).toFixed(0)}%)`);
}
