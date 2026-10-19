// 临时诊断：看真实项目 / 知识库缓存里的剧本与底图结构（用完即删）
import fs from 'fs';

const P = 'C:/Users/muyu/Documents/SiTianProjects/绒花计划.sitian';
const CACHE = 'E:/图书馆/ROSA/.sitian/';

function shape(v, label, depth = 1, max = 22) {
  if (Array.isArray(v)) {
    const item = v.length && v[0] && typeof v[0] === 'object' ? Object.keys(v[0]).join(',') : '';
    console.log(`${label} [array ${v.length}] ${item}`);
    return;
  }
  if (v && typeof v === 'object') {
    console.log(`${label} {${Object.keys(v).length}} ${Object.keys(v).slice(0, max).join(',')}`);
    return;
  }
  console.log(`${label} = ${String(v).slice(0, 80)}`);
}

function walk(v, path, depth, maxDepth) {
  if (depth > maxDepth || !v || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    shape(v, path);
    if (v.length && v[0] && typeof v[0] === 'object') walk(v[0], path + '[0]', depth + 1, maxDepth);
    return;
  }
  shape(v, path);
  for (const k of Object.keys(v)) walk(v[k], path + '.' + k, depth + 1, maxDepth);
}

const j = JSON.parse(fs.readFileSync(P, 'utf8'));
console.log('=== project.scenarios ===');
walk(j.scenarios, 'scenarios', 0, 3);

for (const f of ['scenarios.json', 'scenarios_desite_history.json']) {
  const p = CACHE + f;
  if (!fs.existsSync(p)) { console.log('\n== MISSING', f); continue; }
  console.log('\n== ' + f + ' ==');
  walk(JSON.parse(fs.readFileSync(p, 'utf8')), 'root', 0, 2);
}
