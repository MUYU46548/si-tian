// _probe_map_provinces.mjs —— 「真实底图中间那个神秘大三角」是什么（量，不猜）
//
// 用法：node scripts/tests/tools/_probe_map_provinces.mjs [--map <路径>]
// 读 docs/mockups/desite.map → 走产品自己的解析器（azgaar-parser）→ 逐省报告
//   点数 / 包围盒 / 面积占整图比，并对「几何可疑」的省点名：
//     · 点数 < 5（画出来必然是三角形/细条）
//     · 包围盒占整图 > 20%（一条跨全图的线也能画出巨大三角）
//     · 面积 > 整图 25%（一个省吃掉四分之一张图）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
const args = process.argv.slice(2);
const mapArg = args.indexOf('--map');
const MAP = mapArg >= 0 ? args[mapArg + 1] : path.join(ROOT, 'docs', 'mockups', 'desite.map');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitian-prov-'));
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'utils', 'azgaar-parser.js'), 'utf8');
fs.writeFileSync(path.join(tmp, 'azgaar-parser.mjs'), src);
const AP = await import(pathToFileURL(path.join(tmp, 'azgaar-parser.mjs')).href);

const text = fs.readFileSync(MAP, 'utf8');
const parsed = AP.parseMapFile(text);
const name = '德斯特';
const json = AP.buildScenariosJson(parsed, name, '当前');
const bm = json.baseMaps[name];
const provs = bm.terrain || [];

const bbox = (prov) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const r of (prov.extraRings ? [prov.points, ...prov.extraRings.map((x) => (Array.isArray(x) ? x : x.points))] : [prov.points])) {
    for (const p of (r || [])) {
      const x = p.x === undefined ? p[0] : p.x;
      const y = p.y === undefined ? p[1] : p.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n += 1;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return n ? { n, minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } : { n: 0 };
};

console.log('地图：', path.relative(ROOT, MAP), '| 省份数', provs.length);
const boxes = provs.map((p, i) => ({ i, id: p && p.id, name: p && p.name, ...bbox(p || {}) }));
const valid = boxes.filter((b) => b.n > 0);
const gx = Math.min(...valid.map((b) => b.minX)), gX = Math.max(...valid.map((b) => b.maxX));
const gy = Math.min(...valid.map((b) => b.minY)), gY = Math.max(...valid.map((b) => b.maxY));
const W = gX - gx, H = gY - gy;
const mapArea = W * H;
console.log('整图世界包围盒：', [Math.round(gx), Math.round(gy), Math.round(W), Math.round(H)].join(' / '));

const byArea = valid.map((b) => ({ ...b, share: (b.w * b.h) / mapArea })).sort((a, b) => b.share - a.share);
console.log('\n包围盒占整图最大的 8 个省：');
for (const b of byArea.slice(0, 8)) {
  console.log(`  #${b.i} ${b.id} ${b.name || ''} 点数 ${b.n} 包围盒 ${Math.round(b.w)}×${Math.round(b.h)} = ${(b.share * 100).toFixed(1)}%`);
}

const few = boxes.filter((b) => b.n > 0 && b.n < 5);
console.log('\n点数 < 5 的省：', few.length, few.slice(0, 8).map((b) => `#${b.i}(${b.n}点)`).join(' '));
const empty = boxes.filter((b) => b.n === 0);
console.log('完全没点的省：', empty.length, empty.slice(0, 8).map((b) => `#${b.i}`).join(' '));

// 三角形嫌疑：点数少 + 包围盒大
const suspects = valid.filter((b) => b.n < 8 && (b.w * b.h) / mapArea > 0.05);
console.log('\n「巨大三角」嫌疑（点数<8 且包围盒 >5% 整图）：', suspects.length);
for (const b of suspects) {
  console.log(`  #${b.i} ${b.id} ${b.name || ''} 点数 ${b.n} 包围盒 ${Math.round(b.w)}×${Math.round(b.h)} = ${((b.w * b.h) / mapArea * 100).toFixed(1)}%`);
}

const p0 = provs[0];
console.log('\n第一个省的原始形状（前 6 点）：', JSON.stringify(p0 && (p0.points || []).slice(0, 6)));
console.log('第一个省字段：', p0 ? Object.keys(p0).join(',') : '(无)');
