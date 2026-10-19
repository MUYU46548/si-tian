// 快速核对：traceRivers({smoothRadius}) 是否真的走了平滑（原型是手工调 smoothHeightmapGrid 的）
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = 'E:/CODE/CangKu/SiTian';
const UTILS = ROOT + '/src/renderer/src/utils';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sit-s-'));
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

const longest = (t) => {
  let m = 0;
  for (const rv of (t.rivers || [])) {
    let L = 0; const p = rv.points || [];
    for (let i = 0; i + 1 < p.length; i++) L += Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
    if (L > m) m = L;
  }
  return m;
};
for (const opts of [{}, { smoothRadius: 2, smoothPasses: 1 }, { smoothRadius: 2, smoothPasses: 1, sourceHeight: 40 }]) {
  const t = R.traceRivers(hm, { isLand: mask.lookup, ...opts });
  console.log(JSON.stringify(opts).padEnd(58),
    'smoothed=', t.smoothed, ' note=', JSON.stringify(t.smoothNote || ''),
    ' rivers=', (t.rivers || []).length, ' longest=', longest(t).toFixed(0), ' sources=', t.sources);
}
