// 查：desite 底图的**来源**是什么、原始 .map 还在不在、原始网格多大。
import fs from 'fs';
import path from 'path';

const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const bm = j.scenarios.baseMaps.desite;
console.log('== source 字段 ==');
console.log(JSON.stringify(bm.source, null, 2));
console.log('\n== 现存高度图网格 ==');
const g = bm.heightmap.grid;
console.log(`cellsX=${g.cellsX} cellsY=${g.cellsY} count=${g.count} points=${g.points.length} spacing=${g.spacing}`);
console.log(`h.length=${bm.heightmap.h.length}`);
console.log(`cellsX*cellsY=${g.cellsX * g.cellsY}`);

console.log('\n== 项目备份目录里有没有原始 .map ==');
const projDir = path.dirname(P);
const backups = path.join(projDir, '绒花计划.sitian.backups');
for (const dir of [projDir, backups, path.join(projDir, 'basemap-source'), path.join(backups, 'basemap-source')]) {
  if (!fs.existsSync(dir)) { console.log(`  (不存在) ${dir}`); continue; }
  console.log(`  --- ${dir} ---`);
  for (const f of fs.readdirSync(dir).slice(0, 40)) {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    console.log(`    ${(st.size / 1024 / 1024).toFixed(2)} MB  ${f}`);
  }
}
