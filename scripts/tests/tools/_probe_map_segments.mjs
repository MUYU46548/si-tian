// ① 原始 .map 的各段数组分别是什么（有没有第二份更高精度的高程）
// ② 司天在**导入 / 取用**高度图时有没有"降级/截断"（用户将来换高分图会不会白换）
import fs from 'fs';
import path from 'path';

const MAP = process.argv[2] || 'E:/CODE/CangKu/SiTian/backups/repair-basemap-20261011-220317/desite.map';
console.log(`检查文件：${MAP}`);
const lines = fs.readFileSync(MAP, 'utf8').split(/\r?\n/);

function findGridLineIndex(ls) {
  // 宽松：只要该行是 JSON 且同时含 cellsX 与 points
  for (let i = 0; i < ls.length; i++) {
    const s = ls[i];
    if (!s || s[0] !== '{') continue;
    if (s.indexOf('"cellsX"') === -1 || s.indexOf('"points"') === -1) continue;
    return i;
  }
  return -1;
}
const gi = findGridLineIndex(lines);
console.log(`grid 行号 ${gi}，共 ${lines.length} 行`);
console.log('\n== grid 锚点前后的"数据段"逐行体检 ==');
for (let k = gi - 2; k <= gi + 12 && k < lines.length; k++) {
  const s = lines[k] || '';
  const head = s.slice(0, 60).replace(/\s+/g, ' ');
  // CSV 数值段的统计
  let info = '';
  if (k !== gi && s && /^[-\d.,\s]+$/.test(s.slice(0, 200))) {
    const arr = s.split(',').map(Number);
    const fin = arr.filter(Number.isFinite);
    if (fin.length) {
      const isInt = fin.every((v) => Number.isInteger(v));
      info = `  【CSV】n=${fin.length} min=${Math.min(...fin)} max=${Math.max(...fin)} `
        + (isInt ? '**全整数**' : `**含小数**（小数个数 ${fin.filter((v) => !Number.isInteger(v)).length}）`);
    }
  } else if (k === gi) info = '  【grid JSON】';
  else if (s && (s[0] === '[' || s[0] === '{')) info = `  【JSON ${s[0]}】len=${s.length}`;
  console.log(`  data[${k - gi}]  行 ${k}  ${info}`);
  console.log(`      ${head}`);
}
