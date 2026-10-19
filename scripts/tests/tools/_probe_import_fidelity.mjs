// 对照：**原始 desite.map** 的网格 vs **项目里现存的高度图** —— 导入链路有没有降采样。
import fs from 'fs';

const MAP = 'E:/CODE/CangKu/SiTian/docs/mockups/desite.map';
const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';

const raw = fs.readFileSync(MAP, 'utf8');
const lines = raw.split(/\r?\n/);

// 按 azgaar-parser 的锚点找 grid JSON 行
function findGridLineIndex(ls) {
  for (let i = 0; i < ls.length; i++) {
    const s = ls[i];
    if (!s || s[0] !== '{') continue;
    if (s.indexOf('"cellsX"') === -1 || s.indexOf('"points"') === -1) continue;
    try { const v = JSON.parse(s); if (v.points && v.cellsX && v.grid !== undefined) return i; } catch (_) { }
  }
  // 宽松回退
  for (let i = 0; i < ls.length; i++) if (ls[i] && ls[i].indexOf('"cellsX"') !== -1) return i;
  return -1;
}
const gi = findGridLineIndex(lines);
console.log(`== 原始 .map（${(raw.length / 1024 / 1024).toFixed(2)} MB，${lines.length} 行）==`);
console.log(`grid 行号 = ${gi}（0 基）`);
if (gi < 0) { console.log('找不到 grid 行'); process.exit(1); }
const gridRaw = JSON.parse(lines[gi]);
console.log(`  cellsX=${gridRaw.cellsX}  cellsY=${gridRaw.cellsY}`);
console.log(`  points.length=${gridRaw.points.length}   spacing=${gridRaw.spacing}`);
if (Array.isArray(gridRaw.points[0])) {
  console.log(`  points[0]=[${gridRaw.points[0]}]  points[1]=[${gridRaw.points[1]}]`);
} else {
  console.log(`  points 是**扁平数组**（[x0,y0,x1,y1,…]），前 6 个数 = ${gridRaw.points.slice(0, 6).join(',')}`);
  console.log(`  → 格数 = ${gridRaw.points.length / 2}`);
}
console.log(`  grid JSON 自身字段: ${Object.keys(gridRaw).join(', ')}`);

// 高度数组（cells.h）—— 按 parser 的 data[7] 规则（gridLine + 7 - 6 = gi+1）
const hLine = lines[gi + 1];
const hArr = hLine ? hLine.split(',').map((v) => Number(v)) : [];
console.log(`\n== cells.h（原始）==`);
console.log(`  行号 ${gi + 1}，长度 = ${hArr.length}`);
console.log(`  前 12 个值: ${hArr.slice(0, 12).join(',')}`);
const finite = hArr.filter((v) => Number.isFinite(v));
console.log(`  有限值 ${finite.length} / ${hArr.length}，min=${Math.min(...finite)} max=${Math.max(...finite)}`);

// 项目里的高度图
const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
const g = bm.heightmap.grid;
console.log(`\n== 项目里现存的高度图 ==`);
console.log(`  cellsX=${g.cellsX}  cellsY=${g.cellsY}  count=${g.count}  points.length=${g.points.length}  spacing=${g.spacing}`);
console.log(`  h.length=${bm.heightmap.h.length}`);

console.log(`\n== 判定 ==`);
const rawCells = Array.isArray(gridRaw.points[0]) ? gridRaw.points.length : gridRaw.points.length / 2;
console.log(`  原始格数 ${rawCells}  vs  现存格数 ${g.points.length}`);
if (rawCells === g.points.length) console.log('  ✅ **格数一致 → 导入链路没有降采样**');
else console.log(`  🔴 格数不一致：原始 ${rawCells} → 现存 ${g.points.length}（丢了 ${(100 - g.points.length / rawCells * 100).toFixed(1)}%）`);
console.log(`  原始 cellsX×cellsY = ${gridRaw.cellsX * gridRaw.cellsY}  vs  points ${rawCells}`);
console.log(`  原始 h 长度 ${hArr.length}  vs  现存 h 长度 ${bm.heightmap.h.length}`);
