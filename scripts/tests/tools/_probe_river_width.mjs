// 量尺：真实 desite 底图 160 条自带河的**屏幕线宽分布**（共用一个公式的实现来量）
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..');
const UTILS = path.join(ROOT, 'src', 'renderer', 'src', 'utils');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-rw-'));
for (const f of ['riverRender.js', 'rivers.js']) {
  fs.writeFileSync(path.join(tmp, f),
    fs.readFileSync(path.join(UTILS, f), 'utf8').replace(/from '\.\/([A-Za-z0-9_-]+)'/g, "from './$1.js'"));
}
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const RR = await import(pathToFileURL(path.join(tmp, 'riverRender.js')).href);

const j = JSON.parse(fs.readFileSync('C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian', 'utf8'));
const rivers = j.scenarios.baseMaps.desite.rivers;
const px = rivers.map((r) => RR.basemapRiverWidthPx(r));
const sorted = px.slice().sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))];
const clamped = px.filter((v) => v === 0.7).length;
console.log('自带河屏幕线宽（px）:');
console.log(`  n=${px.length} min=${q(0).toFixed(2)} p25=${q(0.25).toFixed(2)} p50=${q(0.5).toFixed(2)} p75=${q(0.75).toFixed(2)} p90=${q(0.9).toFixed(2)} max=${q(1).toFixed(2)}`);
console.log(`  被夹到 0.7 下界的: ${clamped}/${px.length} (${(clamped / px.length * 100).toFixed(0)}%)`);
console.log(`  区分度 max/min = ${(q(1) / q(0)).toFixed(2)}×`);
const thinnest = rivers[px.indexOf(q(0))];
const widest = rivers[px.indexOf(q(1))];
console.log(`  最细: width=${thinnest.width} discharge=${thinnest.discharge} → ${q(0).toFixed(2)}px`);
console.log(`  最粗: width=${widest.width} discharge=${widest.discharge} → ${q(1).toFixed(2)}px`);

// 自动河侧：把 flow 折算成 discharge 后会落在哪里
const segMax = 22;
const auto = [1, 2, 3, 5, 8, 13, 22].map((f) => {
  const d = RR.flowToDischargeEquivalent(f, segMax);
  return { flow: f, discharge: +d.toFixed(0), px: +RR.basemapRiverWidthPx({ width: 0.2, discharge: d }).toFixed(2) };
});
console.log('\n自动河段（width=0.2 + flow 折算）:');
console.log('  ' + auto.map((a) => `flow${a.flow}→d${a.discharge}=${a.px}px`).join('  '));
console.log(`  区分度 = ${(auto[auto.length - 1].px / auto[0].px).toFixed(2)}×`);
